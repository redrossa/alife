import type { StreamRecord } from "../core/contracts.ts";

export { perceiveHead } from "../core/observation.ts";

// Bounded output handling for attached executions. Docker multiplexes stdout
// and stderr into frames with an 8-byte header; frames can be arbitrarily
// large, so payloads are consumed as they arrive and never buffered whole.

export type StreamName = "stdout" | "stderr";

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

/** Incremental demultiplexer. Holds at most the 8 header bytes between chunks. */
export class FrameDemuxer {
  readonly #onPayload: (stream: StreamName, bytes: Buffer) => void;
  readonly #header = Buffer.alloc(8);
  #headerLength = 0;
  #remaining = 0;
  #stream: StreamName = "stdout";
  #failed = false;

  constructor(onPayload: (stream: StreamName, bytes: Buffer) => void) {
    this.#onPayload = onPayload;
  }

  /** True when the stream stopped inside a frame, so the last output is incomplete. */
  get midFrame(): boolean {
    return this.#headerLength > 0 || this.#remaining > 0;
  }

  push(chunk: Buffer): void {
    if (this.#failed) throw new FrameError("demultiplexer already failed");
    let position = 0;
    while (position < chunk.length) {
      if (this.#remaining === 0) {
        const count = Math.min(8 - this.#headerLength, chunk.length - position);
        chunk.copy(this.#header, this.#headerLength, position, position + count);
        this.#headerLength += count;
        position += count;
        if (this.#headerLength < 8) return;
        this.#headerLength = 0;
        const type = this.#header[0];
        if ((type !== 1 && type !== 2) || this.#header[1] !== 0 || this.#header[2] !== 0 || this.#header[3] !== 0) {
          this.#failed = true;
          throw new FrameError(`invalid stream frame header ${this.#header.toString("hex")}`);
        }
        this.#stream = type === 1 ? "stdout" : "stderr";
        this.#remaining = this.#header.readUInt32BE(4);
        continue;
      }
      const count = Math.min(this.#remaining, chunk.length - position);
      this.#onPayload(this.#stream, chunk.subarray(position, position + count));
      this.#remaining -= count;
      position += count;
    }
  }
}

/** Keeps the first `limit` bytes of a stream and counts the rest (`head-v1`). */
export class HeadRetainer {
  readonly #buffer: Buffer;
  #retained = 0;
  #total = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError(`invalid retention limit ${limit}`);
    this.#buffer = Buffer.alloc(limit);
  }

  add(bytes: Uint8Array): void {
    const room = this.#buffer.length - this.#retained;
    if (room > 0) {
      const count = Math.min(room, bytes.length);
      this.#buffer.set(bytes.subarray(0, count), this.#retained);
      this.#retained += count;
    }
    this.#total += bytes.length;
  }

  get totalBytes(): number {
    return this.#total;
  }

  snapshot(): StreamRecord {
    return {
      retained: Uint8Array.from(this.#buffer.subarray(0, this.#retained)),
      totalBytes: this.#total,
      truncated: this.#total > this.#retained,
    };
  }
}

/**
 * The job launcher writes one line, `alife-job <pid> <starttime>`, to stderr
 * before replacing itself with the command's shell, so it always precedes
 * command output. This filter removes that line from the stream and reports
 * it. Anything that does not match is passed through unchanged, and the
 * process identity is then unknown.
 */
export class LaunchMarkerFilter {
  static readonly MAXIMUM_BYTES = 64;
  static readonly PATTERN = /^alife-job ([1-9][0-9]{0,9}) ([0-9]{1,20})\n$/;

  readonly #forward: (bytes: Buffer) => void;
  #pending: Buffer = Buffer.alloc(0);
  #done = false;
  #identity: { readonly pid: number; readonly startTime: string } | null = null;

  constructor(forward: (bytes: Buffer) => void) {
    this.#forward = forward;
  }

  get identity(): { readonly pid: number; readonly startTime: string } | null {
    return this.#identity;
  }

  get settled(): boolean {
    return this.#done;
  }

  push(bytes: Buffer): void {
    if (this.#done) {
      this.#forward(bytes);
      return;
    }
    this.#pending = Buffer.concat([this.#pending, bytes]);
    const newline = this.#pending.indexOf(0x0a);
    if (newline === -1) {
      if (this.#pending.length >= LaunchMarkerFilter.MAXIMUM_BYTES) this.#giveUp();
      return;
    }
    const line = this.#pending.subarray(0, newline + 1);
    const match = LaunchMarkerFilter.PATTERN.exec(line.toString("latin1"));
    if (match === null || line.length > LaunchMarkerFilter.MAXIMUM_BYTES) {
      this.#giveUp();
      return;
    }
    const pid = Number(match[1]);
    this.#identity = Number.isSafeInteger(pid) ? { pid, startTime: match[2]! } : null;
    const rest = this.#pending.subarray(newline + 1);
    this.#pending = Buffer.alloc(0);
    this.#done = true;
    if (rest.length > 0) this.#forward(rest);
  }

  /** At stream end: anything held back was output, not a marker. */
  flush(): void {
    if (!this.#done) this.#giveUp();
  }

  #giveUp(): void {
    this.#done = true;
    const pending = this.#pending;
    this.#pending = Buffer.alloc(0);
    if (pending.length > 0) this.#forward(pending);
  }
}
