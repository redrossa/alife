import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { entryRecord, MAXIMUM_NAME_BYTES, type ArchiveEntryRecord } from "../world/archive.ts";
import { TarReader, type TarEntryType } from "../world/tar.ts";

// Read-only inspection of a captured archive (plan §7.2). Nothing is
// extracted, followed, or executed: entry names are data, addressed by their
// exact bytes. Before anything is listed or read, the manifest, the archive's
// size and hash, the tar structure, and the recorded index must all agree,
// so a fabricated index cannot stand in for inconsistent bytes.

export interface InspectionLimits {
  readonly maximumArchiveBytes: number;
  readonly maximumEntries: number;
  readonly maximumReadBytes: number;
}

export class ArchiveInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveInspectionError";
  }
}

const MANIFEST_BYTES_PER_ENTRY = 16 << 10;
const MANIFEST_BASE_BYTES = 256 << 10;
const CHUNK_BYTES = 1 << 20;

const count = z.int().min(0);
const entryTypes = ["file", "hardlink", "symlink", "character", "block", "directory", "fifo", "other"] as const satisfies readonly TarEntryType[];

const entrySchema = z.strictObject({
  pathBase64: z.base64(),
  path: z.string().nullable(),
  type: z.enum(entryTypes),
  typeFlag: z.string(),
  mode: z.string(),
  uid: count,
  gid: count,
  size: count,
  mtime: z.int(),
  linkTargetBase64: z.base64().nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});

const sourceState = z.strictObject({ state: z.string(), mountCount: count, lastWriteTime: z.string() });

/** The manifest `tar-capture-v1` writes next to each archive. */
export const archiveManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  archiveId: z.string(),
  worldId: z.string(),
  label: z.string(),
  capture: z.string(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  complete: z.boolean(),
  omissions: z.array(z.string()),
  coverage: z.string(),
  limits: z.strictObject({ maximumBytes: count, maximumEntries: count, timeoutMs: count }),
  archive: z.strictObject({ file: z.string(), bytes: count, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  source: z.strictObject({
    uuid: z.string(),
    device: z.string().nullable(),
    before: sourceState,
    after: sourceState.nullable(),
    unchanged: z.boolean().nullable(),
  }),
  helper: z.strictObject({ exitCode: z.int().nullable(), timedOut: z.boolean(), stopped: z.boolean(), stderr: z.string() }).nullable(),
  entryCount: count,
  entries: z.array(entrySchema),
});

export type ArchiveManifest = z.infer<typeof archiveManifestSchema>;

const limitsSchema = z.strictObject({
  maximumArchiveBytes: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  maximumEntries: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  maximumReadBytes: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
});

function checkLimits(limits: InspectionLimits): InspectionLimits {
  const parsed = limitsSchema.safeParse(limits);
  if (!parsed.success) throw new RangeError(`invalid inspection limits: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

/** Opens a regular file that is not a symbolic link, without following one. */
async function openRegular(file: string, what: string): Promise<FileHandle> {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    throw new ArchiveInspectionError(`${what} is unreadable: ${error.code ?? error.message}`);
  });
  if (!info.isFile()) throw new ArchiveInspectionError(`${what} is not a regular file`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const opened = await handle.stat();
  if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) {
    await handle.close();
    throw new ArchiveInspectionError(`${what} changed while it was opened`);
  }
  return handle;
}

async function readAll(handle: FileHandle, limit: number, what: string): Promise<Buffer> {
  const { size } = await handle.stat();
  if (size > limit) throw new ArchiveInspectionError(`${what} is ${size} bytes; the bound is ${limit}`);
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) throw new ArchiveInspectionError(`${what} changed while it was read`);
  return buffer;
}

function sameEntry(a: ArchiveEntryRecord, b: ArchiveEntryRecord): boolean {
  return (
    a.pathBase64 === b.pathBase64 &&
    a.path === b.path &&
    a.type === b.type &&
    a.typeFlag === b.typeFlag &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.linkTargetBase64 === b.linkTargetBase64 &&
    a.sha256 === b.sha256
  );
}

interface VerifiedArchive {
  readonly manifest: ArchiveManifest;
  readonly handle: FileHandle;
  readonly dataOffsets: readonly number[];
}

/** Verifies the manifest against the archive's actual bytes; the caller closes the handle. */
async function verified(directory: string, limits: InspectionLimits): Promise<VerifiedArchive> {
  const info = await lstat(directory).catch(() => null);
  if (info === null || !info.isDirectory()) throw new ArchiveInspectionError("the archive directory does not exist or is not a directory");

  const manifestHandle = await openRegular(path.join(directory, "manifest.json"), "the archive manifest");
  let manifest: ArchiveManifest;
  try {
    const bytes = await readAll(manifestHandle, MANIFEST_BASE_BYTES + limits.maximumEntries * MANIFEST_BYTES_PER_ENTRY, "the archive manifest");
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ArchiveInspectionError("the archive manifest is not valid JSON");
    }
    const parsed = archiveManifestSchema.safeParse(value);
    if (!parsed.success) throw new ArchiveInspectionError(`the archive manifest is invalid: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    manifest = parsed.data;
  } finally {
    await manifestHandle.close();
  }

  const file = manifest.archive.file;
  if (file !== path.basename(file) || file === "." || file === ".." || file === "manifest.json" || !/^[A-Za-z0-9._-]+$/.test(file)) {
    throw new ArchiveInspectionError(`the manifest names archive file ${JSON.stringify(file)}, which is not a plain name in its directory`);
  }
  if (manifest.entryCount !== manifest.entries.length) {
    throw new ArchiveInspectionError(`the manifest counts ${manifest.entryCount} entries but lists ${manifest.entries.length}`);
  }
  if (manifest.entries.length > limits.maximumEntries) {
    throw new ArchiveInspectionError(`the archive has ${manifest.entries.length} entries; the bound is ${limits.maximumEntries}`);
  }
  if (manifest.archive.bytes > limits.maximumArchiveBytes) {
    throw new ArchiveInspectionError(`the archive is ${manifest.archive.bytes} bytes; the bound is ${limits.maximumArchiveBytes}`);
  }

  const handle = await openRegular(path.join(directory, file), "the archive");
  try {
    const { size } = await handle.stat();
    if (size !== manifest.archive.bytes) throw new ArchiveInspectionError(`the archive is ${size} bytes; its manifest records ${manifest.archive.bytes}`);
    const hash = createHash("sha256");
    const reader = new TarReader({ maximumEntries: limits.maximumEntries, maximumNameBytes: MAXIMUM_NAME_BYTES });
    let structure: string | null = null;
    const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(size, 1)));
    for (let offset = 0; offset < size; ) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (bytesRead === 0) throw new ArchiveInspectionError("the archive changed while it was read");
      const part = chunk.subarray(0, bytesRead);
      hash.update(part);
      if (structure === null) {
        try {
          reader.push(part);
        } catch (error) {
          structure = (error as Error).message;
        }
      }
      offset += bytesRead;
    }
    if (hash.digest("hex") !== manifest.archive.sha256) throw new ArchiveInspectionError("the archive's bytes do not match the hash in its manifest");
    if (structure === null) {
      try {
        reader.end();
      } catch (error) {
        structure = (error as Error).message;
      }
    }
    // A complete capture must be a whole, well-formed archive; an incomplete one is indexed as far as it goes.
    if (manifest.complete && structure !== null) throw new ArchiveInspectionError(`the archive's tar structure is invalid: ${structure}`);
    const indexed = reader.entries.map(entryRecord);
    if (indexed.length !== manifest.entries.length || indexed.some((entry, index) => !sameEntry(entry, manifest.entries[index]!))) {
      throw new ArchiveInspectionError(
        `the manifest's index does not match the archive's contents${structure === null ? "" : ` (the archive's structure: ${structure})`}`,
      );
    }
    return { manifest, handle, dataOffsets: reader.dataOffsets };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Lists a captured archive's index after verifying it against the archive. */
export async function listArchive(options: {
  readonly directory: string;
  readonly limits: InspectionLimits;
}): Promise<{ readonly entries: readonly ArchiveEntryRecord[]; readonly complete: boolean; readonly omissions: readonly string[] }> {
  const limits = checkLimits(options.limits);
  const archive = await verified(options.directory, limits);
  await archive.handle.close();
  return { entries: archive.manifest.entries, complete: archive.manifest.complete, omissions: archive.manifest.omissions };
}

function decodePath(pathBase64: string): Buffer {
  if (typeof pathBase64 !== "string" || pathBase64.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(pathBase64)) {
    throw new RangeError("the path is not canonical base64");
  }
  const bytes = Buffer.from(pathBase64, "base64");
  if (bytes.toString("base64") !== pathBase64 || bytes.length === 0) throw new RangeError("the path is not canonical base64");
  return bytes;
}

function checkRange(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${what} must be a non-negative safe integer`);
  return value;
}

/**
 * Reads a bounded byte range of one regular file in a captured archive,
 * addressed by its exact path bytes. Ambiguous names, links, and special
 * entries are refused. `truncated` describes the requested window;
 * `complete` describes the capture.
 */
export async function readArchiveFile(options: {
  readonly directory: string;
  readonly pathBase64: string;
  readonly offset: number;
  readonly length: number;
  readonly limits: InspectionLimits;
}): Promise<{
  readonly data: Uint8Array;
  readonly totalBytes: number;
  readonly offset: number;
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly omissions: readonly string[];
}> {
  const limits = checkLimits(options.limits);
  const offset = checkRange(options.offset, "the offset");
  const length = checkRange(options.length, "the length");
  if (!Number.isSafeInteger(offset + length)) throw new RangeError("the requested range is too large");
  if (length > limits.maximumReadBytes) throw new RangeError(`the requested length ${length} exceeds the read bound ${limits.maximumReadBytes}`);
  const name = decodePath(options.pathBase64).toString("base64");

  const archive = await verified(options.directory, limits);
  try {
    const matches = archive.manifest.entries.flatMap((entry, index) => (entry.pathBase64 === name ? [index] : []));
    if (matches.length === 0) throw new ArchiveInspectionError("the archive has no entry with that path");
    if (matches.length > 1) throw new ArchiveInspectionError(`the archive has ${matches.length} entries with that path; none is chosen`);
    const index = matches[0]!;
    const entry = archive.manifest.entries[index]!;
    if (entry.type !== "file") throw new ArchiveInspectionError(`the entry is a ${entry.type}, not a regular file; it is never followed or read`);
    if (offset > entry.size) throw new RangeError(`the offset ${offset} is past the end of the ${entry.size}-byte file`);
    const count = Math.min(length, entry.size - offset);
    const data = Buffer.alloc(count);
    let read = 0;
    const base = archive.dataOffsets[index]! + offset;
    while (read < count) {
      const { bytesRead } = await archive.handle.read(data, read, count - read, base + read);
      if (bytesRead === 0) throw new ArchiveInspectionError("the archive ended inside the entry");
      read += bytesRead;
    }
    return {
      data: new Uint8Array(data.buffer, data.byteOffset, data.length),
      totalBytes: entry.size,
      offset,
      truncated: offset + count < entry.size,
      complete: archive.manifest.complete,
      omissions: archive.manifest.omissions,
    };
  } finally {
    await archive.handle.close();
  }
}
