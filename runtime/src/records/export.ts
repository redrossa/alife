import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { systemClock } from "../core/clock.ts";
import { isArchiveId, parseRunId, type RunId } from "../core/ids.ts";
import { acquireOwnership, inspectOwnership, OwnershipConflictError, type Ownership } from "../operator/locks.ts";
import { REPOSITORY_ROOT, type StateLayout } from "../operator/state-dir.ts";
import { readEventLog, type EventEnvelope } from "./events.ts";
import { runPaths, type RunPaths } from "./run-store.ts";

// Private evidence export (plan §7.3): an exact copy of a run's allowlisted
// records and its associated archives, with a hashed inventory. Nothing is
// redacted, repaired, or replayed, and nothing that grants control (locks,
// leases, control descriptors) is copied. Damaged, missing, or bounded-out
// evidence makes the export explicitly incomplete. This is not a publication
// approval: recorded commands and content are copied as they are.

export interface ExportOptions {
  readonly layout: StateLayout;
  readonly runId: RunId;
  readonly outputDirectory: string;
  /** Bounds on everything written, including the export manifest. */
  readonly maximumBytes: number;
  readonly maximumFiles: number;
}

export interface InventoryFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ExportResult {
  readonly directory: string;
  readonly manifestFile: string;
  readonly files: readonly InventoryFile[];
  readonly complete: boolean;
  readonly omissions: readonly string[];
}

export class ExportRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportRefusedError";
  }
}

export const EXPORT_MANIFEST = "export-manifest.json";
/** The run's record files that are evidence. Operational files (locks, leases, control descriptors) are not. */
const RUN_FILES = ["events.jsonl", "manifest.json", "resolved-config.json", "prompt.txt", "tools.json", "fake-script.json", "finalization.json", "watchdog.jsonl"];
const HASH_NAME = /^[a-f0-9]{64}$/;
const CHECKPOINT_NAME = /^[a-f0-9]{64}\.json$/;
const ARCHIVE_FILES = ["manifest.json", "archive.tar"];
const CHUNK_BYTES = 1 << 20;

interface Planned {
  readonly source: string;
  readonly target: string;
  readonly bytes: number;
}

function checkBound(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${what} must be a positive safe integer`);
  return value;
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** A regular file that is not a symbolic link; null when absent. Anything else refuses the export. */
async function regular(file: string): Promise<number | null> {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new ExportRefusedError(`${file} is a symbolic link; the export never follows one`);
  if (!info.isFile()) throw new ExportRefusedError(`${file} is not a regular file`);
  return info.size;
}

async function directoryEntries(directory: string): Promise<string[] | null> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new ExportRefusedError(`${directory} is not a real directory`);
  return (await readdir(directory)).sort();
}

/** Blob references in event data: text payloads kept out of line are `{sha256, bytes}` with no `text`. */
function blobReferences(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) blobReferences(item, found);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 2 && typeof record.sha256 === "string" && HASH_NAME.test(record.sha256) && typeof record.bytes === "number") {
    found.add(record.sha256);
    return;
  }
  for (const key of keys) blobReferences(record[key], found);
}

async function sha256File(file: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Refuses destinations that exist, sit inside the state directory or repository, or resolve through a link into one. */
async function checkDestination(output: string, layout: StateLayout): Promise<string> {
  const absolute = path.resolve(output);
  try {
    await lstat(absolute);
    throw new ExportRefusedError(`${absolute} already exists; an export is only written to a new directory`);
  } catch (error) {
    if (error instanceof ExportRefusedError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let parent: string;
  try {
    parent = await realpath(path.dirname(absolute));
  } catch {
    throw new ExportRefusedError(`the parent of ${absolute} does not exist`);
  }
  const target = path.join(parent, path.basename(absolute));
  for (const [root, what] of [
    [layout.root, "the state directory"],
    [REPOSITORY_ROOT, "the repository"],
  ] as const) {
    const real = await realpath(root).catch(() => path.resolve(root));
    if (inside(target, real)) throw new ExportRefusedError(`${absolute} is inside ${what}; an export is written outside it`);
  }
  return absolute;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

/** Which archives the run's record associates with it, and what the record says about them. */
function associatedArchives(events: readonly EventEnvelope[]): { readonly ids: string[]; readonly failures: string[] } {
  const ids: string[] = [];
  const failures: string[] = [];
  for (const event of events) {
    const id = event.data.archiveId;
    if (event.type === "archive.created" && typeof id === "string" && isArchiveId(id) && !ids.includes(id)) ids.push(id);
    if (event.type === "archive.failed") failures.push(`the ${text(event.data.phase)} capture${typeof id === "string" ? ` ${id}` : ""} failed: ${text(event.data.reason)}`);
  }
  return { ids, failures };
}

async function plan(paths: RunPaths, omissions: string[]): Promise<Planned[]> {
  const files: Planned[] = [];
  const add = async (source: string, target: string) => {
    const bytes = await regular(source);
    if (bytes !== null) files.push({ source, target, bytes });
    return bytes !== null;
  };
  for (const name of RUN_FILES) await add(path.join(paths.directory, name), `run/${name}`);

  let events: readonly EventEnvelope[] = [];
  try {
    const log = await readEventLog(paths.events);
    events = log.events;
    for (const issue of log.issues) omissions.push(`the event log is damaged: ${issue.detail}`);
  } catch (error) {
    omissions.push(`the event log is unreadable: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  try {
    const journal = await readEventLog(paths.watchdogJournal);
    for (const issue of journal.issues) omissions.push(`the watchdog journal is damaged: ${issue.detail}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") omissions.push("the watchdog journal is unreadable");
  }

  for (const name of (await directoryEntries(paths.checkpoints)) ?? []) {
    if (CHECKPOINT_NAME.test(name)) await add(path.join(paths.checkpoints, name), `run/checkpoints/${name}`);
  }
  for (const event of events) {
    if (event.type !== "checkpoint.written" || typeof event.data.sha256 !== "string" || !HASH_NAME.test(event.data.sha256)) continue;
    const file = path.join(paths.checkpoints, `${event.data.sha256}.json`);
    if ((await sha256File(file)) !== event.data.sha256) omissions.push(`checkpoint ${event.data.sha256} is missing or does not match its hash`);
  }

  const blobs = new Set((await directoryEntries(paths.blobs)) ?? []);
  for (const name of blobs) if (HASH_NAME.test(name)) await add(path.join(paths.blobs, name), `run/blobs/${name}`);
  const referenced = new Set<string>();
  for (const event of events) blobReferences(event.data, referenced);
  for (const hash of referenced) {
    if (!blobs.has(hash)) omissions.push(`referenced blob ${hash} is missing`);
    else if ((await sha256File(path.join(paths.blobs, hash))) !== hash) omissions.push(`blob ${hash} does not match its hash`);
  }

  const archives = associatedArchives(events);
  omissions.push(...archives.failures);
  for (const id of archives.ids) {
    const directory = path.join(paths.archives, id);
    const present = await directoryEntries(directory);
    if (present === null) {
      omissions.push(`associated archive ${id} has no run-owned copy`);
      continue;
    }
    for (const name of ARCHIVE_FILES) {
      if (!(await add(path.join(directory, name), `archives/${id}/${name}`))) omissions.push(`associated archive ${id} has no ${name}`);
    }
    try {
      const manifest = JSON.parse((await readFileBounded(path.join(directory, "manifest.json"), 64 << 20)).toString("utf8")) as { complete?: unknown; omissions?: unknown };
      if (manifest.complete !== true) {
        const reasons = Array.isArray(manifest.omissions) ? manifest.omissions.map(String).slice(0, 8).join("; ") : "";
        omissions.push(`associated archive ${id} is an incomplete capture${reasons === "" ? "" : `: ${reasons}`}`);
      }
    } catch {
      omissions.push(`associated archive ${id} has no readable manifest`);
    }
  }
  return files;
}

async function readFileBounded(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await handle.stat();
    if (size > limit) throw new Error(`${file} exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function manifestText(runId: RunId, exportedAt: string, files: readonly InventoryFile[], complete: boolean, omissions: readonly string[]): string {
  return `${JSON.stringify({ schemaVersion: 1, runId, exportedAt, complete, omissions, files }, null, 2)}\n`;
}

/** Copies one file exactly, refusing a source that changed since it was planned. */
async function copy(item: Planned, destination: string): Promise<InventoryFile> {
  const source = await open(item.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size !== item.bytes) throw new ExportRefusedError(`${item.source} changed during the export`);
    const target = path.join(destination, ...item.target.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(item.bytes, 1)));
      let copied = 0;
      while (copied < item.bytes) {
        const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, item.bytes - copied), copied);
        if (bytesRead === 0) throw new ExportRefusedError(`${item.source} changed during the export`);
        const part = chunk.subarray(0, bytesRead);
        hash.update(part);
        let written = 0;
        while (written < part.length) written += (await output.write(part, written, part.length - written)).bytesWritten;
        copied += bytesRead;
      }
      await output.chmod(0o600);
      // A copy, not the evidence itself: the manifest, written last, is what marks a finished export.
      return { path: item.target, bytes: item.bytes, sha256: hash.digest("hex") };
    } finally {
      await output.close();
    }
  } finally {
    await source.close();
  }
}

/**
 * Exports a run that no live controller owns into a new private directory:
 * records under `run/`, associated archives under `archives/`, and
 * `export-manifest.json` with the complete emitted inventory. The bounds
 * cover every emitted byte and file; evidence left out by them is listed.
 */
export async function exportRun(options: ExportOptions): Promise<ExportResult> {
  const maximumBytes = checkBound(options.maximumBytes, "maximumBytes");
  const maximumFiles = checkBound(options.maximumFiles, "maximumFiles");
  const runId = parseRunId(options.runId);
  const paths = runPaths(options.layout, runId);
  const destination = await checkDestination(options.outputDirectory, options.layout);
  if ((await directoryEntries(paths.directory)) === null) throw new ExportRefusedError(`there is no run ${runId} in this state directory`);

  let ownership: Ownership | null = null;
  try {
    ownership = await acquireOwnership(options.layout.locks, "run", runId, systemClock);
  } catch (error) {
    if (!(error instanceof OwnershipConflictError)) throw error;
    // A lock left by a controller that is gone does not prevent reading its evidence; a live or unknown owner does.
    const status = await inspectOwnership(options.layout.locks, "run", runId);
    if (status !== null && status.appearsAlive !== false) throw new ExportRefusedError(`run ${runId} is owned by a live or unknown controller; export it once it has ended`);
  }
  try {
    const omissions: string[] = [];
    const planned = await plan(paths, omissions);
    const exportedAt = systemClock.now().toISOString();

    // Choose files within the bounds, leaving room for the manifest that lists them.
    let chosen: Planned[] = [];
    let skipped: Planned[] = [];
    let reserve = 0;
    for (let attempt = 0; attempt < 16; attempt++) {
      chosen = [];
      skipped = [];
      let bytes = reserve;
      for (const item of planned) {
        if (chosen.length + 2 <= maximumFiles && bytes + item.bytes <= maximumBytes) {
          chosen.push(item);
          bytes += item.bytes;
        } else skipped.push(item);
      }
      const draft = manifestText(
        runId,
        exportedAt,
        chosen.map((item) => ({ path: item.target, bytes: item.bytes, sha256: "0".repeat(64) })),
        false,
        [...omissions, ...summary(skipped)],
      );
      const needed = Buffer.byteLength(draft) + 64;
      if (needed <= reserve) break;
      reserve = needed;
    }
    const final = [...omissions, ...summary(skipped)];
    const complete = final.length === 0;
    const reserved = Buffer.byteLength(manifestText(runId, exportedAt, chosen.map((item) => ({ path: item.target, bytes: item.bytes, sha256: "0".repeat(64) })), complete, final));
    if (maximumFiles < 1 || reserved + chosen.reduce((sum, item) => sum + item.bytes, 0) > maximumBytes) {
      throw new ExportRefusedError(`the export's bounds (${maximumBytes} bytes, ${maximumFiles} files) cannot hold even its manifest`);
    }

    await mkdir(destination, { mode: 0o700 });
    const root = await open(destination, constants.O_RDONLY);
    try {
      await root.chmod(0o700);
    } finally {
      await root.close();
    }
    const files: InventoryFile[] = [];
    for (const item of chosen) files.push(await copy(item, destination));
    for (const directory of new Set(files.map((file) => path.dirname(path.join(destination, ...file.path.split("/")))))) {
      await chmodTree(destination, directory);
    }
    const manifestFile = path.join(destination, EXPORT_MANIFEST);
    const text = manifestText(runId, exportedAt, files, complete, final);
    const handle = await open(manifestFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(text);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { directory: options.outputDirectory, manifestFile: path.join(options.outputDirectory, EXPORT_MANIFEST), files, complete, omissions: final };
  } finally {
    await ownership?.release();
  }
}

function summary(skipped: readonly Planned[]): string[] {
  if (skipped.length === 0) return [];
  const bytes = skipped.reduce((sum, item) => sum + item.bytes, 0);
  const names = skipped.slice(0, 8).map((item) => item.target).join(", ");
  return [`${skipped.length} file(s) (${bytes} bytes) were left out by the export's bounds: ${names}${skipped.length > 8 ? ", …" : ""}`];
}

/** Makes every directory from `root` down to `directory` private, whatever the umask made of it. */
async function chmodTree(root: string, directory: string): Promise<void> {
  for (let current = directory; inside(current, root) && current !== root; current = path.dirname(current)) {
    const handle = await open(current, constants.O_RDONLY);
    try {
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }
}
