import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { isWorldId, type WorldId } from "../core/ids.ts";
import type { StateLayout } from "../operator/state-dir.ts";
import { syncDirectory, writeNewFile } from "../records/files.ts";

export { writeNewFile };

// World metadata (plan §13.1): the validated identity of a world's storage
// lineage, written once before any Docker resource exists and never edited.
// It names resources by exact ID-derived names; it grants no path authority.
// Everything that happens afterwards is appended to the world's event log.

export const WORLD_METADATA_VERSION = 1;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const worldMetadataSchema = z.strictObject({
  schemaVersion: z.literal(WORLD_METADATA_VERSION),
  worldId: z.string().refine(isWorldId, "not a world ID"),
  createdAt: z.iso.datetime(),
  docker: z.strictObject({
    context: z.string().min(1),
    engineId: z.string().min(1),
    engineVersion: z.string(),
    architecture: z.string(),
  }),
  images: z.strictObject({
    /** Image IDs (config digests), resolved from the configured pinned references. */
    world: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    helper: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    architecture: z.string(),
  }),
  storage: z.strictObject({
    profile: z.string(),
    capture: z.string(),
    uuid: z.uuid(),
    label: z.string().max(16),
    capacityMiB: z.int().min(1),
    inodes: z.int().min(1),
  }),
  seed: z.strictObject({ id: z.string(), status: z.string(), sha256 }),
  user: z.strictObject({ uid: z.int().min(1), gid: z.int().min(1) }),
  resources: z.strictObject({
    container: z.string(),
    backingVolume: z.string(),
    deviceVolume: z.string(),
    readonlyVolume: z.string(),
  }),
  /** Canonical hash of the configuration that created this world. */
  configSha256: sha256,
});

export type WorldMetadata = z.infer<typeof worldMetadataSchema>;

export interface WorldPaths {
  readonly directory: string;
  readonly metadata: string;
  readonly events: string;
  readonly archives: string;
}

export function worldPaths(layout: StateLayout, worldId: WorldId): WorldPaths {
  const directory = path.join(layout.worlds, worldId);
  return {
    directory,
    metadata: path.join(directory, "metadata.json"),
    events: path.join(directory, "events.jsonl"),
    archives: path.join(directory, "archives"),
  };
}

/** Creates the world's private directory; fails if it already exists. */
export async function createWorldDirectory(paths: WorldPaths): Promise<void> {
  await mkdir(paths.directory, { mode: 0o700 });
  await mkdir(paths.archives, { mode: 0o700 });
  await syncDirectory(path.dirname(paths.directory));
}

export async function writeWorldMetadata(paths: WorldPaths, metadata: WorldMetadata): Promise<void> {
  const checked = worldMetadataSchema.parse(metadata);
  await writeNewFile(paths.metadata, `${JSON.stringify(checked, null, 2)}\n`);
}

export class WorldMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldMetadataError";
  }
}

export async function readWorldMetadata(paths: WorldPaths, worldId: WorldId): Promise<WorldMetadata> {
  let text: string;
  try {
    text = await readFile(paths.metadata, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorldMetadataError(`world ${worldId} has no metadata`);
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorldMetadataError(`world ${worldId} metadata is not valid JSON`);
  }
  const parsed = worldMetadataSchema.safeParse(value);
  if (!parsed.success) throw new WorldMetadataError(`world ${worldId} metadata is invalid: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  if (parsed.data.worldId !== worldId) throw new WorldMetadataError(`metadata in ${paths.directory} belongs to ${parsed.data.worldId}`);
  return parsed.data;
}
