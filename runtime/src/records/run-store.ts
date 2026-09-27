import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { AppendOptions } from "../core/contracts.ts";
import type { Clock } from "../core/clock.ts";
import { canonicalJson } from "../core/hash.ts";
import type { RunId } from "../core/ids.ts";
import type { StateLayout } from "../operator/state-dir.ts";
import { EVENT_TYPES, JsonlEventLog, RecordCapacityError, type EventType } from "./events.ts";
import { syncDirectory, writeNewFile } from "./files.ts";

// A run's private record directory (plan §13.1). Events are the observer's
// record and are never read back into a mind's context. Payloads too large to
// keep inline are stored once as content-addressed blobs; events and blobs
// share the run's record limit, so nothing is ever written past it.

/** Text up to this size is kept inline in its event; larger text becomes a blob. */
export const INLINE_TEXT_BYTES = 16 << 10;

export interface RunPaths {
  readonly directory: string;
  readonly manifest: string;
  readonly config: string;
  readonly prompt: string;
  readonly tools: string;
  readonly fakeScript: string;
  readonly events: string;
  readonly blobs: string;
  readonly checkpoints: string;
  /** Written by finalization only when the event log is too damaged to append to. */
  readonly finalization: string;
  /** Run-owned copies of associated stopped-world archives, one directory per archive ID. */
  readonly archives: string;
  /** The watchdog's own journal (its sequence is separate from the controller's). */
  readonly watchdogJournal: string;
  /** Operational supervision files: private, never exported, never model input. */
  readonly watchdogDescriptor: string;
  readonly lease: string;
  readonly control: string;
  readonly controlSocket: string;
}

export function runPaths(layout: StateLayout, runId: RunId): RunPaths {
  const directory = path.join(layout.runs, runId);
  return {
    directory,
    manifest: path.join(directory, "manifest.json"),
    config: path.join(directory, "resolved-config.json"),
    prompt: path.join(directory, "prompt.txt"),
    tools: path.join(directory, "tools.json"),
    fakeScript: path.join(directory, "fake-script.json"),
    events: path.join(directory, "events.jsonl"),
    blobs: path.join(directory, "blobs"),
    checkpoints: path.join(directory, "checkpoints"),
    finalization: path.join(directory, "finalization.json"),
    archives: path.join(directory, "archives"),
    watchdogJournal: path.join(directory, "watchdog.jsonl"),
    watchdogDescriptor: path.join(directory, "watchdog.json"),
    lease: path.join(directory, "lease.json"),
    control: path.join(directory, "control.json"),
    controlSocket: path.join(directory, "control.sock"),
  };
}

/**
 * Creates the run's private directory; fails if it already exists. Its name
 * is made durable before this returns, unless `durable` is false: then the
 * caller syncs the parent directory itself (overlapping it with other writes).
 */
export async function createRunDirectory(paths: RunPaths, options: { readonly durable?: boolean } = {}): Promise<void> {
  await mkdir(paths.directory, { mode: 0o700 });
  await mkdir(paths.blobs, { mode: 0o700 });
  await mkdir(paths.checkpoints, { mode: 0o700 });
  if (options.durable !== false) await syncDirectory(path.dirname(paths.directory));
}

/**
 * A text payload in an event: always its hash and size, and the text itself
 * when small. Otherwise the text is in `blobs/<sha256>`.
 */
export interface TextRef {
  readonly sha256: string;
  readonly bytes: number;
  readonly text?: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class RunRecorder {
  readonly paths: RunPaths;
  /** The whole run's limit; `reservedBytes` of it are kept for writers other than the controller. */
  readonly limitBytes: number;
  readonly reservedBytes: number;
  readonly #log: JsonlEventLog<EventType>;
  /** Bytes in blobs, checkpoints, archive copies, and the run's other files, which share the event log's limit. */
  readonly #fileBytes: { value: number };

  private constructor(paths: RunPaths, limitBytes: number, reservedBytes: number, log: JsonlEventLog<EventType>, fileBytes: { value: number }) {
    this.paths = paths;
    this.limitBytes = limitBytes;
    this.reservedBytes = reservedBytes;
    this.#log = log;
    this.#fileBytes = fileBytes;
  }

  /**
   * Opens (or continues) a run's records. Everything already in the run's
   * directory counts against the limit; `reservedBytes` (the watchdog's
   * journal allowance and supervision files, written by other processes) are
   * kept out of what the controller may write.
   */
  static async open(options: {
    readonly paths: RunPaths;
    readonly runId: RunId;
    readonly clock: Clock;
    readonly limitBytes: number;
    readonly reservedBytes?: number;
  }): Promise<RunRecorder> {
    const reserved = options.reservedBytes ?? 0;
    const fileBytes = { value: 0 };
    for (const directory of [options.paths.blobs, options.paths.checkpoints]) {
      for (const name of await readdir(directory)) fileBytes.value += (await stat(path.join(directory, name))).size;
    }
    fileBytes.value += await treeBytes(options.paths.archives);
    // The run's initial files count too: the limit covers everything the run stores.
    fileBytes.value += await runFileBytes(options.paths);
    const log = await JsonlEventLog.open({
      file: options.paths.events,
      runId: options.runId,
      clock: options.clock,
      limitBytes: options.limitBytes - reserved,
      sharedBytes: () => fileBytes.value,
      types: EVENT_TYPES,
    });
    return new RunRecorder(options.paths, options.limitBytes, reserved, log, fileBytes);
  }

  get lastSequence(): number {
    return this.#log.lastSequence;
  }

  get writable(): boolean {
    return this.#log.writable;
  }

  get usedBytes(): number {
    return this.#log.bytes + this.#fileBytes.value;
  }

  remainingBytes(): number {
    return this.limitBytes - this.reservedBytes - this.usedBytes;
  }

  append(type: EventType, data: Readonly<Record<string, unknown>>, options: AppendOptions = {}): Promise<number> {
    return this.#log.append(type, data, options);
  }

  /** Stores `value` inline if small, otherwise as a durable blob, and returns its reference. */
  async text(value: string): Promise<TextRef> {
    const bytes = Buffer.from(value, "utf8");
    const hash = sha256(bytes);
    if (bytes.length <= INLINE_TEXT_BYTES) return { sha256: hash, bytes: bytes.length, text: value };
    await this.#blob(hash, bytes);
    return { sha256: hash, bytes: bytes.length };
  }

  /** Canonical JSON of `value`, stored like text. */
  json(value: unknown): Promise<TextRef> {
    return this.text(canonicalJson(value));
  }

  async #blob(hash: string, bytes: Buffer): Promise<void> {
    const file = path.join(this.paths.blobs, hash);
    try {
      const existing = await readFile(file);
      if (sha256(existing) !== hash) throw new Error(`blob ${hash} exists with different content`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.writeFile(file, bytes);
  }

  /** Writes a new record file (a blob or checkpoint) within the shared record limit. */
  async writeFile(file: string, bytes: Uint8Array): Promise<void> {
    this.claim(bytes.length);
    try {
      await writeNewFile(file, bytes);
    } catch (error) {
      this.#fileBytes.value -= bytes.length;
      throw error;
    }
  }

  /**
   * Counts `bytes` another record file will take (an archive copy written in
   * pieces) against the limit before anything is written; refuses if they do not fit.
   */
  claim(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError(`invalid record size ${bytes}`);
    if (this.usedBytes + bytes > this.limitBytes - this.reservedBytes) throw new RecordCapacityError(this.limitBytes - this.reservedBytes);
    this.#fileBytes.value += bytes;
  }

  /** Makes everything appended so far durable. */
  sync(): Promise<void> {
    return this.#log.sync();
  }

  close(): Promise<void> {
    return this.#log.close();
  }
}

/** Bytes of every file under `directory` (none if it does not exist). */
export async function treeBytes(directory: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const name of names) {
    const file = path.join(directory, name);
    const info = await stat(file);
    total += info.isDirectory() ? await treeBytes(file) : info.size;
  }
  return total;
}

/**
 * Bytes in the run's top-level files: the initial record files, finalization,
 * and the supervision files other processes write (the watchdog's journal,
 * lease, and descriptors).
 */
export async function runFileBytes(paths: RunPaths): Promise<number> {
  let total = 0;
  for (const file of [paths.manifest, paths.config, paths.prompt, paths.tools, paths.fakeScript, paths.finalization, paths.watchdogJournal, paths.watchdogDescriptor, paths.lease, paths.control]) {
    try {
      total += (await stat(file)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return total;
}

/** Reads a text payload back, verifying its size and hash whether it is inline or a blob. */
export async function readText(paths: RunPaths, ref: TextRef): Promise<string> {
  const bytes = ref.text !== undefined ? Buffer.from(ref.text, "utf8") : await readFile(path.join(paths.blobs, ref.sha256));
  if (bytes.length !== ref.bytes || sha256(bytes) !== ref.sha256) {
    throw new Error(`${ref.text !== undefined ? "inline text" : `blob ${ref.sha256}`} does not match its reference`);
  }
  return ref.text ?? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
