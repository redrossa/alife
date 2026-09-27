import { createHash, type Hash } from "node:crypto";

// Minimal tar support. The writer produces deterministic ustar archives of
// directories and regular files for seeding. The reader indexes archives
// captured from a world, which are untrusted: it only parses headers and
// hashes contents, never extracts, follows links, or creates files.

const BLOCK = 512;

// ---------------------------------------------------------------------------
// Writer

export interface TarInput {
  /** Relative path without a leading `./` or trailing `/`. */
  readonly path: string;
  readonly type: "directory" | "file";
  readonly mode: number;
  readonly content?: Uint8Array;
}

function writeString(header: Buffer, value: string, offset: number, length: number, what: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new RangeError(`${what} ${JSON.stringify(value)} is longer than ${length} bytes`);
  bytes.copy(header, offset);
}

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
  const digits = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || digits.length > length - 1) {
    throw new RangeError(`value ${value} does not fit a ${length}-byte tar field`);
  }
  header.write(`${digits.padStart(length - 1, "0")}\0`, offset, length, "latin1");
}

/**
 * Deterministic ustar archive: fixed owner 0:0, fixed modification time, and
 * the given order. Owners are assigned by whoever extracts it.
 */
export function writeTar(entries: readonly TarInput[], mtimeSeconds: number): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    if (entry.path.length === 0 || entry.path.startsWith("/") || entry.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new RangeError(`invalid archive path ${JSON.stringify(entry.path)}`);
    }
    const content = entry.type === "file" ? (entry.content ?? new Uint8Array()) : new Uint8Array();
    const header = Buffer.alloc(BLOCK);
    writeString(header, entry.type === "directory" ? `${entry.path}/` : entry.path, 0, 100, "path");
    writeOctal(header, entry.mode, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, content.length, 124, 12);
    writeOctal(header, mtimeSeconds, 136, 12);
    header.fill(0x20, 148, 156);
    header.write(entry.type === "directory" ? "5" : "0", 156, 1, "latin1");
    header.write("ustar\0", 257, 6, "latin1");
    header.write("00", 263, 2, "latin1");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
    blocks.push(header);
    if (content.length > 0) {
      blocks.push(Buffer.from(content));
      const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
      if (pad > 0) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}

// ---------------------------------------------------------------------------
// Reader

export type TarEntryType = "file" | "hardlink" | "symlink" | "character" | "block" | "directory" | "fifo" | "other";

export interface TarEntry {
  /** Raw path bytes as archived. */
  readonly path: Buffer;
  readonly type: TarEntryType;
  readonly typeFlag: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly mtime: number;
  readonly linkTarget: Buffer | null;
  /** SHA-256 of the contents, for regular files. */
  readonly sha256: string | null;
}

export interface TarReaderLimits {
  readonly maximumEntries: number;
  readonly maximumNameBytes: number;
}

export class TarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarFormatError";
  }
}

const TYPES: Readonly<Record<string, TarEntryType>> = {
  "0": "file",
  "\0": "file",
  "7": "file",
  "1": "hardlink",
  "2": "symlink",
  "3": "character",
  "4": "block",
  "5": "directory",
  "6": "fifo",
};

function field(header: Buffer, offset: number, length: number): Buffer {
  const slice = header.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end));
}

/**
 * Octal or GNU base-256 numeric field. Only `signed` fields (modification
 * times, which can precede 1970) may be negative; sizes, modes, and owners
 * may not.
 */
function numeric(header: Buffer, offset: number, length: number, what: string, signed = false): number {
  const slice = header.subarray(offset, offset + length);
  if ((slice[0]! & 0x80) !== 0) {
    // GNU base-256: the flag bit, then a big-endian two's complement number in the remaining bits.
    let value = BigInt(slice[0]! & 0x7f);
    for (const byte of slice.subarray(1)) value = (value << 8n) | BigInt(byte);
    const bits = BigInt(7 + 8 * (length - 1));
    if ((slice[0]! & 0x40) !== 0) {
      if (!signed) throw new TarFormatError(`negative ${what}`);
      value -= 1n << bits;
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new TarFormatError(`${what} out of range`);
    }
    return Number(value);
  }
  const text = slice.toString("latin1").replace(/[\0 ]+$/u, "").replace(/^ +/u, "");
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarFormatError(`invalid ${what} field ${JSON.stringify(text)}`);
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new TarFormatError(`${what} too large`);
  return value;
}

function checksumOk(header: Buffer): boolean {
  let unsigned = 0;
  for (let index = 0; index < BLOCK; index++) unsigned += index >= 148 && index < 156 ? 0x20 : header[index]!;
  const stored = header.subarray(148, 156).toString("latin1").replace(/[\0 ]+$/u, "").replace(/^ +/u, "");
  return /^[0-7]+$/.test(stored) && parseInt(stored, 8) === unsigned;
}

function parsePax(data: Buffer): Map<string, Buffer> {
  const records = new Map<string, Buffer>();
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    if (space === -1) throw new TarFormatError("malformed pax record");
    const length = Number(data.subarray(position, space).toString("latin1"));
    if (!Number.isSafeInteger(length) || length <= space - position || position + length > data.length) {
      throw new TarFormatError("malformed pax record length");
    }
    const recordBytes = data.subarray(space + 1, position + length);
    if (recordBytes[recordBytes.length - 1] !== 0x0a) throw new TarFormatError("pax record without newline");
    const equals = recordBytes.indexOf(0x3d);
    if (equals === -1) throw new TarFormatError("pax record without key");
    records.set(recordBytes.subarray(0, equals).toString("utf8"), Buffer.from(recordBytes.subarray(equals + 1, recordBytes.length - 1)));
    position += length;
  }
  return records;
}

type Pending = { readonly kind: "long_name" | "long_link" | "pax"; readonly size: number; readonly chunks: Buffer[]; received: number };

/**
 * Streaming tar index. Feed chunks with `push`, then call `end`. Holds at
 * most one header, one bounded long name or pax header, and a hash state.
 */
export class TarReader {
  readonly entries: TarEntry[] = [];
  /** For each entry, in the same order, the archive offset where its contents begin. */
  readonly dataOffsets: number[] = [];
  readonly #limits: TarReaderLimits;
  /** Archive offset of the start of the chunk being pushed. */
  #offset = 0;
  #dataStart = 0;
  #buffer: Buffer = Buffer.alloc(0);
  #remaining = 0;
  #padding = 0;
  #hash: Hash | null = null;
  #current: Omit<TarEntry, "sha256"> | null = null;
  #pending: Pending | null = null;
  #longName: Buffer | null = null;
  #longLink: Buffer | null = null;
  #pax: Map<string, Buffer> | null = null;
  #zeroBlocks = 0;
  #finished = false;

  constructor(limits: TarReaderLimits) {
    this.#limits = limits;
  }

  /** True once the end-of-archive marker was read. */
  get finished(): boolean {
    return this.#finished;
  }

  push(chunk: Buffer): void {
    try {
      this.#push(chunk);
    } finally {
      this.#offset += chunk.length;
    }
  }

  #push(chunk: Buffer): void {
    let position = 0;
    while (position < chunk.length) {
      if (this.#remaining > 0) {
        const count = Math.min(this.#remaining, chunk.length - position);
        this.#consumeData(chunk.subarray(position, position + count));
        this.#remaining -= count;
        position += count;
        if (this.#remaining === 0) this.#completeData();
        continue;
      }
      if (this.#padding > 0) {
        const count = Math.min(this.#padding, chunk.length - position);
        this.#padding -= count;
        position += count;
        continue;
      }
      const need = BLOCK - this.#buffer.length;
      const count = Math.min(need, chunk.length - position);
      this.#buffer = Buffer.concat([this.#buffer, chunk.subarray(position, position + count)]);
      position += count;
      if (this.#buffer.length === BLOCK) {
        const header = this.#buffer;
        this.#buffer = Buffer.alloc(0);
        this.#dataStart = this.#offset + position;
        this.#header(header);
      }
    }
  }

  /** Throws if the archive stopped partway through an entry or before its end marker. */
  end(): void {
    if (this.#remaining > 0 || this.#buffer.length > 0 || this.#pending !== null) {
      throw new TarFormatError("archive ends inside an entry");
    }
    if (!this.#finished) throw new TarFormatError("archive has no end-of-archive marker");
  }

  #header(header: Buffer): void {
    if (header.every((byte) => byte === 0)) {
      this.#zeroBlocks += 1;
      if (this.#zeroBlocks >= 2) this.#finished = true;
      return;
    }
    if (this.#finished || this.#zeroBlocks > 0) throw new TarFormatError("data after the end-of-archive marker");
    if (!checksumOk(header)) throw new TarFormatError("header checksum mismatch");

    const flag = String.fromCharCode(header[156]!);
    const size = numeric(header, 124, 12, "size");
    if (flag === "L" || flag === "K" || flag === "x") {
      const limit = flag === "x" ? 64 << 10 : this.#limits.maximumNameBytes + 1;
      if (size > limit) throw new TarFormatError(`extended header of ${size} bytes exceeds ${limit}`);
      this.#pending = { kind: flag === "L" ? "long_name" : flag === "K" ? "long_link" : "pax", size, chunks: [], received: 0 };
      this.#startData(size);
      return;
    }
    if (flag === "g") {
      // Global pax headers carry no entry; skip their data.
      this.#startData(size);
      return;
    }

    if (this.entries.length >= this.#limits.maximumEntries) {
      throw new TarFormatError(`archive has more than ${this.#limits.maximumEntries} entries`);
    }
    const magic = header.subarray(257, 263).toString("latin1");
    let path = this.#longName ?? field(header, 0, 100);
    if (this.#longName === null && magic === "ustar\0") {
      const prefix = field(header, 345, 155);
      if (prefix.length > 0) path = Buffer.concat([prefix, Buffer.from("/"), path]);
    }
    const paxPath = this.#pax?.get("path");
    if (paxPath !== undefined) path = paxPath;
    let link: Buffer | null = this.#longLink ?? field(header, 157, 100);
    const paxLink = this.#pax?.get("linkpath");
    if (paxLink !== undefined) link = paxLink;
    const paxSize = this.#pax?.get("size");
    const effectiveSize = paxSize === undefined ? size : Number(paxSize.toString("latin1"));
    if (!Number.isSafeInteger(effectiveSize) || effectiveSize < 0) throw new TarFormatError("invalid pax size");
    this.#longName = null;
    this.#longLink = null;
    this.#pax = null;
    if (path.length === 0 || path.length > this.#limits.maximumNameBytes) {
      throw new TarFormatError(`entry path of ${path.length} bytes is empty or exceeds ${this.#limits.maximumNameBytes}`);
    }

    const type = TYPES[flag] ?? "other";
    const hasData = type === "file" || type === "other";
    this.#current = {
      path,
      type,
      typeFlag: flag === "\0" ? "0" : flag,
      mode: numeric(header, 100, 8, "mode"),
      uid: numeric(header, 108, 8, "uid"),
      gid: numeric(header, 116, 8, "gid"),
      size: hasData ? effectiveSize : 0,
      mtime: numeric(header, 136, 12, "mtime", true),
      linkTarget: type === "symlink" || type === "hardlink" ? link : null,
    };
    this.#hash = type === "file" ? createHash("sha256") : null;
    if (hasData && effectiveSize > 0) {
      this.#startData(effectiveSize);
    } else {
      this.#completeEntry();
    }
  }

  #startData(size: number): void {
    this.#remaining = size;
    this.#padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (size === 0) this.#completeData();
  }

  #consumeData(bytes: Buffer): void {
    if (this.#pending !== null) {
      this.#pending.chunks.push(Buffer.from(bytes));
      this.#pending.received += bytes.length;
    } else {
      this.#hash?.update(bytes);
    }
  }

  #completeData(): void {
    const pending = this.#pending;
    if (pending === null) {
      if (this.#current !== null) this.#completeEntry();
      return;
    }
    this.#pending = null;
    const data = Buffer.concat(pending.chunks);
    if (pending.kind === "pax") {
      this.#pax = parsePax(data);
    } else {
      // GNU long names are NUL-terminated.
      const end = data.indexOf(0);
      const value = end === -1 ? data : data.subarray(0, end);
      if (pending.kind === "long_name") this.#longName = value;
      else this.#longLink = value;
    }
  }

  #completeEntry(): void {
    const current = this.#current!;
    this.entries.push({ ...current, sha256: this.#hash === null ? null : this.#hash.digest("hex") });
    this.dataOffsets.push(this.#dataStart);
    this.#current = null;
    this.#hash = null;
  }
}
