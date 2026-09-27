import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { SEEDS } from "../config/profiles.ts";
import { canonicalSha256 } from "../core/hash.ts";
import { writeTar } from "./tar.ts";

// Seeds are versioned initial /world contents (plan §10). Each seed directory
// holds `seed.json` and, for nonempty seeds, `files/`. Loading checks that the
// files on disk are exactly the manifest: same paths and types, sizes, and
// hashes, no links or special files, and nothing extra. Modes come from the
// manifest, since Git does not preserve them.

/** `runtime/world/seeds`, from `runtime/{src,dist}/world/`. */
export const SEEDS_ROOT = fileURLToPath(new URL("../../world/seeds/", import.meta.url));

/** Modification time given to every seeded file: 2026-01-01T00:00:00Z. */
export const SEED_MTIME_SECONDS = 1_767_225_600;

const MAXIMUM_SEED_BYTES = 16 << 20;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const entrySchema = z.discriminatedUnion("type", [
  z.strictObject({ path: z.string(), type: z.literal("directory"), mode: z.literal("0755") }),
  z.strictObject({
    path: z.string(),
    type: z.literal("file"),
    mode: z.literal("0644"),
    bytes: z.int().min(0).max(MAXIMUM_SEED_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);

const seedManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string(),
  status: z.enum(["draft", "fixed", "frozen"]),
  description: z.string().min(1),
  entries: z.array(entrySchema).max(4096),
});

export type SeedManifest = z.infer<typeof seedManifestSchema>;
export type SeedEntry = SeedManifest["entries"][number];

export interface Seed {
  readonly id: string;
  readonly status: SeedManifest["status"];
  /** Canonical hash of the seed's identity and entries (paths, types, modes, sizes, content hashes). */
  readonly sha256: string;
  readonly entries: readonly SeedEntry[];
  /** Deterministic ustar archive of the entries, owned 0:0; the provisioner assigns the world user. */
  readonly archive: Buffer;
  readonly bytes: number;
}

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

function checkPath(relative: string): void {
  const parts = relative.split("/");
  if (parts.length > 8 || !parts.every((part) => SEGMENT.test(part))) {
    throw new SeedError(`seed path ${JSON.stringify(relative)} is not a simple relative path`);
  }
}

async function walk(root: string, relative = ""): Promise<Map<string, "directory" | "file">> {
  const found = new Map<string, "directory" | "file">();
  const directory = path.join(root, relative);
  for (const name of (await readdir(directory)).sort()) {
    const child = relative === "" ? name : `${relative}/${name}`;
    const info = await lstat(path.join(root, child));
    if (info.isDirectory()) {
      found.set(child, "directory");
      for (const [key, value] of await walk(root, child)) found.set(key, value);
    } else if (info.isFile()) {
      found.set(child, "file");
    } else {
      throw new SeedError(`seed file ${JSON.stringify(child)} is not a regular file or directory`);
    }
  }
  return found;
}

/** Loads and verifies a seed from `root` (default: the runtime's seed directory). */
export async function loadSeed(id: string, root: string = SEEDS_ROOT): Promise<Seed> {
  if (!Object.hasOwn(SEEDS, id)) throw new SeedError(`unknown seed ${JSON.stringify(id)}`);
  const directory = path.join(root, id);
  const parsed = seedManifestSchema.safeParse(JSON.parse(await readFile(path.join(directory, "seed.json"), "utf8")));
  if (!parsed.success) throw new SeedError(`seed ${id}: invalid seed.json: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const manifest = parsed.data;
  if (manifest.id !== id) throw new SeedError(`seed ${id}: seed.json names ${JSON.stringify(manifest.id)}`);

  const declared = new Map<string, SeedEntry>();
  let total = 0;
  for (const entry of manifest.entries) {
    checkPath(entry.path);
    if (declared.has(entry.path)) throw new SeedError(`seed ${id}: duplicate entry ${entry.path}`);
    const parent = path.posix.dirname(entry.path);
    if (parent !== "." && declared.get(parent)?.type !== "directory") {
      throw new SeedError(`seed ${id}: ${entry.path} is listed before its directory`);
    }
    declared.set(entry.path, entry);
    if (entry.type === "file") total += entry.bytes;
  }
  if (total > MAXIMUM_SEED_BYTES) throw new SeedError(`seed ${id}: ${total} bytes exceeds ${MAXIMUM_SEED_BYTES}`);

  const filesRoot = path.join(directory, "files");
  let present = new Map<string, "directory" | "file">();
  try {
    present = await walk(filesRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const [relative, type] of present) {
    const entry = declared.get(relative);
    if (entry === undefined) throw new SeedError(`seed ${id}: ${relative} is on disk but not in seed.json`);
    if (entry.type !== type) throw new SeedError(`seed ${id}: ${relative} is a ${type}, not a ${entry.type}`);
  }

  const inputs = [];
  for (const entry of manifest.entries) {
    if (!present.has(entry.path)) throw new SeedError(`seed ${id}: ${entry.path} is in seed.json but missing on disk`);
    if (entry.type === "directory") {
      inputs.push({ path: entry.path, type: "directory" as const, mode: 0o755 });
      continue;
    }
    const content = await readFile(path.join(filesRoot, entry.path));
    const digest = createHash("sha256").update(content).digest("hex");
    if (content.length !== entry.bytes || digest !== entry.sha256) {
      throw new SeedError(`seed ${id}: ${entry.path} does not match its recorded size and hash`);
    }
    inputs.push({ path: entry.path, type: "file" as const, mode: 0o644, content });
  }

  return {
    id,
    status: manifest.status,
    sha256: canonicalSha256({ id, entries: manifest.entries }),
    entries: manifest.entries,
    archive: writeTar(inputs, SEED_MTIME_SECONDS),
    bytes: total,
  };
}
