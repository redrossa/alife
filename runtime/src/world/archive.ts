import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import path from "node:path";

import type { HelperResult } from "./resources.ts";
import { TarReader, type TarEntry } from "./tar.ts";

// Stopped-world artifact archives, capture profile `tar-capture-v1` (plan
// §13.2). The archive is written as received, under hard byte and time
// bounds, and indexed as it streams: paths, types, modes, owners, sizes, and
// content hashes. Nothing is extracted, followed, or executed. An archive
// that hit a bound or could not be indexed is kept and labelled incomplete.

export const CAPTURE_TIMEOUT_MS = 300_000;
export const MAXIMUM_NAME_BYTES = 4096;
/** GNU tar pads its output to 10 KiB records. */
const RECORD_BYTES = 10_240;

export const CAPTURE_COVERAGE =
  "GNU tar of the stopped filesystem: regular files with contents, directories, symbolic links (not followed), " +
  "hard links, FIFOs, and device nodes as headers; numeric owners, permission bits, and whole-second modification " +
  "times. Not covered: sockets (skipped by tar), extended attributes, ACLs, inode numbers, access and change " +
  "times, and sparse layout (holes are archived as zeros).";

export interface CaptureLimits {
  readonly maximumBytes: number;
  readonly maximumEntries: number;
  readonly timeoutMs: number;
}

/** The filesystem's capacity plus 1536 bytes per inode, and at most one entry per 512 archive bytes. */
export function captureLimits(capacityMiB: number, inodes: number): CaptureLimits {
  const maximumBytes = capacityMiB * (1 << 20) + inodes * 1536 + RECORD_BYTES;
  return { maximumBytes, maximumEntries: Math.floor(maximumBytes / 512), timeoutMs: CAPTURE_TIMEOUT_MS };
}

export interface ArchiveEntryRecord {
  readonly pathBase64: string;
  /** The path when it is valid UTF-8. Untrusted: escape before printing. */
  readonly path: string | null;
  readonly type: TarEntry["type"];
  readonly typeFlag: string;
  readonly mode: string;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly mtime: number;
  readonly linkTargetBase64: string | null;
  readonly sha256: string | null;
}

export interface CaptureOutcome {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly entries: readonly ArchiveEntryRecord[];
  readonly complete: boolean;
  readonly omissions: readonly string[];
  readonly helper: {
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly stopped: boolean;
    readonly stderr: string;
  } | null;
}

// ignoreBOM keeps a leading U+FEFF, which is part of a file name, not an encoding mark.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decode(bytes: Buffer): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** How an indexed tar entry is recorded in an archive manifest. */
export function entryRecord(entry: TarEntry): ArchiveEntryRecord {
  // GNU tar names everything relative to `.`: `./`, `./dir/`, `./dir/file`.
  let raw = entry.path;
  if (raw.length >= 2 && raw[0] === 0x2e && raw[1] === 0x2f) raw = raw.subarray(2);
  if (raw.length > 1 && raw[raw.length - 1] === 0x2f) raw = raw.subarray(0, raw.length - 1);
  if (raw.length === 0) raw = Buffer.from(".");
  return {
    pathBase64: raw.toString("base64"),
    path: decode(raw),
    type: entry.type,
    typeFlag: entry.typeFlag,
    mode: (entry.mode & 0o7777).toString(8).padStart(4, "0"),
    uid: entry.uid,
    gid: entry.gid,
    size: entry.size,
    mtime: entry.mtime,
    linkTargetBase64: entry.linkTarget === null ? null : entry.linkTarget.toString("base64"),
    sha256: entry.sha256,
  };
}

/**
 * Writes `archive.tar` in `directory` (which must be new and empty) from
 * `stream`, enforcing the byte bound and indexing entries as they arrive.
 */
export async function captureInto(
  directory: string,
  limits: CaptureLimits,
  stream: (sink: (chunk: Buffer) => boolean, timeoutMs: number) => Promise<HelperResult>,
): Promise<CaptureOutcome> {
  const file = path.join(directory, "archive.tar");
  const descriptor = openSync(file, "wx", 0o600);
  const hash = createHash("sha256");
  const reader = new TarReader({ maximumEntries: limits.maximumEntries, maximumNameBytes: MAXIMUM_NAME_BYTES });
  let bytes = 0;
  let limitReached = false;
  let indexProblem: string | null = null;

  const sink = (chunk: Buffer): boolean => {
    let part = chunk;
    if (bytes + part.length > limits.maximumBytes) {
      part = part.subarray(0, limits.maximumBytes - bytes);
      limitReached = true;
    }
    let offset = 0;
    while (offset < part.length) offset += writeSync(descriptor, part, offset, part.length - offset);
    hash.update(part);
    bytes += part.length;
    if (indexProblem === null) {
      try {
        reader.push(part);
      } catch (error) {
        indexProblem = (error as Error).message;
      }
    }
    return !limitReached;
  };

  let helper: HelperResult | null = null;
  let failure: string | null = null;
  try {
    helper = await stream(sink, limits.timeoutMs);
  } catch (error) {
    failure = (error as Error).message;
  } finally {
    fsyncSync(descriptor);
    closeSync(descriptor);
  }

  if (indexProblem === null && !limitReached && failure === null) {
    try {
      reader.end();
    } catch (error) {
      indexProblem = (error as Error).message;
    }
  }

  const omissions: string[] = [];
  const stderr = helper === null ? "" : new TextDecoder("utf-8", { fatal: false }).decode(helper.stderr);
  for (const line of stderr.split("\n")) if (line.trim().length > 0) omissions.push(`tar: ${line.trim()}`);
  if (failure !== null) omissions.push(`capture failed: ${failure}`);
  if (limitReached) omissions.push(`archive reached its ${limits.maximumBytes}-byte bound and was cut off`);
  if (helper?.timedOut === true) omissions.push(`capture did not finish within ${limits.timeoutMs} ms`);
  if (helper !== null && helper.exitCode !== 0 && !limitReached && !helper.timedOut) {
    omissions.push(`capture helper exited ${helper.exitCode}`);
  }
  if (helper?.streamProblem != null) omissions.push(`output stream: ${helper.streamProblem}`);
  if (indexProblem !== null) omissions.push(`index incomplete: ${indexProblem}`);

  const complete =
    failure === null &&
    helper !== null &&
    helper.exitCode === 0 &&
    !helper.timedOut &&
    !helper.stopped &&
    helper.streamProblem === null &&
    !limitReached &&
    indexProblem === null &&
    reader.finished;
  return {
    file,
    bytes,
    sha256: hash.digest("hex"),
    entries: reader.entries.map(entryRecord),
    complete,
    omissions,
    helper:
      helper === null
        ? null
        : { exitCode: helper.exitCode, timedOut: helper.timedOut, stopped: helper.stopped, stderr: stderr.slice(0, 16 << 10) },
  };
}
