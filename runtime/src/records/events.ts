import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { AppendOptions, EventStore } from "../core/contracts.ts";
import type { Clock } from "../core/clock.ts";
import { canonicalJson } from "../core/hash.ts";

// Append-only JSONL evidence (plan §11.3). One writer per log. Events are the
// observer's record; they are never read back into a mind's context.

export const EVENT_SCHEMA_VERSION = 1;

export const EVENT_TYPES = [
  "run.created",
  "run.ready",
  "run.started",
  "run.resumed",
  "run.stopping",
  "run.stopped_clean",
  "run.completed",
  "run.recovery_required",
  "run.finalized",
  "world.attached",
  "world.started",
  "world.stopped",
  "world.lost",
  "observation.sampled",
  "context.assembled",
  "context.evicted",
  "model.requested",
  "model.responded",
  "model.failed",
  "cost.reserved",
  "cost.reconciled",
  "intention.accepted",
  "intention.rejected",
  "action.prepared",
  "action.completed",
  "action.running",
  "action.uncertain",
  "action.refused",
  "tick.completed",
  "checkpoint.written",
  "operator.intervention",
  "archive.created",
  "archive.failed",
  "supervision.armed",
  "supervision.lost",
  "supervision.released",
] as const;

/**
 * Each world has its own log for its lifecycle, the storage helper's
 * invocations, jobs, and archives. It is written only by the world's current
 * owner, and its envelope's `runId` holds the world ID.
 */
export const WORLD_EVENT_TYPES = [
  "world.creating",
  "world.provisioned",
  "world.provisioning_failed",
  "world.helper_starting",
  "world.helper_finished",
  "world.attached",
  "world.stale_container",
  "world.container_created",
  "world.started",
  "world.verified",
  "world.verification_failed",
  "world.stopping",
  "world.stopped",
  "world.stop_unverified",
  "world.container_removed",
  "world.detached",
  "world.detach_incomplete",
  "world.destroying",
  "world.destroyed",
  "world.destroy_incomplete",
  "job.prepared",
  "job.start_refused",
  "job.state",
  "job.output",
  "job.evicted",
  "job.signal_requested",
  "job.signalled",
  "archive.refused",
  "archive.created",
  "archive.failed",
] as const;

export type WorldEventType = (typeof WORLD_EVENT_TYPES)[number];

/**
 * The watchdog writes its own log, with its own sequence, so it never races the
 * controller's. Every record carries the watchdog's binding. `armed` means the
 * exact container was verified and protection is ready; `expired` is a lasting
 * intervention (the lease, the deadline, or the watchdog's own evidence failed);
 * `stop_verified` and `released` are written only after an independent inspection.
 */
export const WATCHDOG_EVENT_TYPES = [
  "watchdog.armed",
  "watchdog.expired",
  "watchdog.stop_verified",
  "watchdog.released",
  "watchdog.refused",
  "watchdog.unavailable",
  "watchdog.interrupted",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type WatchdogEventType = (typeof WATCHDOG_EVENT_TYPES)[number];

/** Larger payloads belong in bounded blobs referenced by hash. */
export const MAX_EVENT_BYTES = 256 << 10;

/**
 * Validates event data without copying it. `z.record` rebuilds objects by
 * assignment, which turns an own `__proto__` key into a prototype change and
 * silently drops it; the parsed object is kept as written instead.
 */
const eventDataSchema = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null),
  { message: "event data must be a JSON object" },
);

export const eventEnvelopeSchema = z.strictObject({
  v: z.literal(EVENT_SCHEMA_VERSION),
  seq: z.int().min(1),
  runId: z.string().min(1),
  /** Controller process that wrote the event; monotonic times compare only within one session. */
  session: z.uuid(),
  type: z.string().min(1),
  time: z.iso.datetime(),
  monotonicMs: z.number().min(0),
  tick: z.int().min(1).optional(),
  data: eventDataSchema,
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** An event rejected before any bytes were written; the log remains usable. */
export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEventError";
  }
}

export class RecordCapacityError extends Error {
  constructor(limitBytes: number) {
    super(`event log would exceed its ${limitBytes}-byte record limit`);
    this.name = "RecordCapacityError";
  }
}

export interface EventLogOptions<T extends string> {
  readonly file: string;
  readonly runId: string;
  readonly clock: Clock;
  readonly limitBytes: number;
  /** Bytes other records (such as a run's blobs) already use against the same limit. */
  readonly sharedBytes?: () => number;
  /** Accepted event types; the controller log uses `EVENT_TYPES`. */
  readonly types: readonly T[];
}

/**
 * Single-writer JSONL log. Opening continues an existing log only if it reads
 * back cleanly; a damaged log is preserved for diagnosis, never appended to.
 */
export class JsonlEventLog<T extends string = EventType> {
  readonly #handle: FileHandle;
  readonly #options: EventLogOptions<T>;
  readonly #session = randomUUID();
  readonly #types: ReadonlySet<string>;
  #seq: number;
  #bytes: number;
  #closed = false;
  /** Bytes written since the last sync; a sync with nothing new to flush is skipped. */
  #unsynced = false;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(handle: FileHandle, options: EventLogOptions<T>, seq: number, bytes: number) {
    this.#handle = handle;
    this.#options = options;
    this.#types = new Set(options.types);
    this.#seq = seq;
    this.#bytes = bytes;
  }

  static async open<T extends string>(options: EventLogOptions<T>): Promise<JsonlEventLog<T>> {
    const existing = await readEventLog(options.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing !== null && existing.issues.length > 0) {
      throw new Error(`refusing to append to a damaged event log: ${existing.issues[0]!.detail}`);
    }
    if (existing?.events.some((event) => event.runId !== options.runId)) {
      throw new Error("event log belongs to a different run");
    }

    const handle = await open(options.file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    if (existing === null) {
      // Make the new directory entry itself durable.
      const directory = await open(path.dirname(options.file), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    const { size } = await handle.stat();
    return new JsonlEventLog(handle, options, existing?.events.at(-1)?.seq ?? 0, size);
  }

  get lastSequence(): number {
    return this.#seq;
  }

  /** Bytes in the log file, including what earlier sessions wrote. */
  get bytes(): number {
    return this.#bytes;
  }

  /** False once a write failed partway or the log was closed: nothing more can be recorded. */
  get writable(): boolean {
    return !this.#closed;
  }

  append(type: T, data: Readonly<Record<string, unknown>>, options: AppendOptions = {}): Promise<number> {
    const result = this.#queue.then(() => this.#append(type, data, options));
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #append(type: T, data: Readonly<Record<string, unknown>>, options: AppendOptions): Promise<number> {
    if (this.#closed) throw new Error("event log is closed");
    if (!this.#types.has(type)) throw new RangeError(`unknown event type ${JSON.stringify(type)}`);

    const seq = this.#seq + 1;
    const envelope = {
      v: EVENT_SCHEMA_VERSION,
      seq,
      runId: this.#options.runId,
      session: this.#session,
      type,
      time: this.#options.clock.now().toISOString(),
      monotonicMs: this.#options.clock.monotonicMs(),
      ...(options.tick === undefined ? {} : { tick: options.tick }),
      // Not copied: validation and serialization below run without yielding.
      data,
    };
    // Everything written must read back unchanged: validate the envelope as the
    // reader will, and serialize strictly rather than let JSON drop or coerce values.
    const checked = eventEnvelopeSchema.safeParse(envelope);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new InvalidEventError(`event ${type}: ${issue ? `${issue.path.join(".") || "(envelope)"}: ${issue.message}` : "invalid"}`);
    }
    let text: string;
    try {
      text = canonicalJson(envelope);
    } catch (error) {
      throw new InvalidEventError(`event ${type}: ${(error as Error).message}`);
    }
    const line = Buffer.from(`${text}\n`, "utf8");
    if (line.length > MAX_EVENT_BYTES) {
      throw new RangeError(`event ${type} is ${line.length} bytes; the limit is ${MAX_EVENT_BYTES}`);
    }
    const shared = this.#options.sharedBytes?.() ?? 0;
    if (this.#bytes + shared + line.length > this.#options.limitBytes) throw new RecordCapacityError(this.#options.limitBytes);

    // Once a write fails partway, the log's tail is unknown: stop writing.
    try {
      let offset = 0;
      while (offset < line.length) {
        const { bytesWritten } = await this.#handle.write(line, offset);
        offset += bytesWritten;
      }
      this.#unsynced = true;
      if (options.durable === true) {
        await this.#handle.datasync();
        this.#unsynced = false;
      }
    } catch (error) {
      this.#closed = true;
      throw error;
    }
    this.#seq = seq;
    this.#bytes += line.length;
    return seq;
  }

  async sync(): Promise<void> {
    await this.#queue;
    if (!this.#unsynced) return;
    await this.#handle.datasync();
    this.#unsynced = false;
  }

  async close(): Promise<void> {
    await this.#queue;
    if (!this.#closed) {
      this.#closed = true;
      if (this.#unsynced) await this.#handle.datasync();
    }
    await this.#handle.close();
  }
}

export type LogIssueKind = "partial_tail" | "encoding" | "malformed" | "schema" | "sequence" | "run_mismatch";

export interface LogIssue {
  readonly line: number;
  readonly kind: LogIssueKind;
  readonly detail: string;
}

export interface EventLogContents {
  readonly events: readonly EventEnvelope[];
  /** Problems are reported, never repaired or discarded silently. */
  readonly issues: readonly LogIssue[];
}

function splitLines(bytes: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let end = bytes.indexOf(0x0a); end !== -1; end = bytes.indexOf(0x0a, start)) {
    lines.push(bytes.subarray(start, end));
    start = end + 1;
  }
  lines.push(bytes.subarray(start));
  return lines;
}

export async function readEventLog(file: string): Promise<EventLogContents> {
  const bytes = await readFile(file);
  const events: EventEnvelope[] = [];
  const issues: LogIssue[] = [];
  const lines = splitLines(bytes);
  const tail = lines.pop();
  if (tail !== undefined && tail.length > 0) {
    issues.push({ line: lines.length + 1, kind: "partial_tail", detail: `line ${lines.length + 1} has no terminating newline` });
  }

  // Fatal decoding per line: replacement characters would silently alter evidence.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let expected = 1;
  lines.forEach((raw, index) => {
    const line = index + 1;
    let content: string;
    try {
      content = decoder.decode(raw);
    } catch {
      issues.push({ line, kind: "encoding", detail: `line ${line} is not valid UTF-8` });
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      issues.push({ line, kind: "malformed", detail: `line ${line} is not JSON` });
      return;
    }
    const parsed = eventEnvelopeSchema.safeParse(value);
    if (!parsed.success) {
      issues.push({ line, kind: "schema", detail: `line ${line}: ${parsed.error.issues[0]?.message ?? "invalid event"}` });
      return;
    }
    const event = parsed.data;
    if (event.seq !== expected) {
      issues.push({ line, kind: "sequence", detail: `line ${line} has sequence ${event.seq}; expected ${expected}` });
    }
    if (events.length > 0 && event.runId !== events[0]!.runId) {
      issues.push({ line, kind: "run_mismatch", detail: `line ${line} belongs to run ${event.runId}` });
    }
    expected = event.seq + 1;
    events.push(event);
  });

  return { events, issues };
}

/** Opens the controller's event log for a run. */
export function openRunEventLog(options: Omit<EventLogOptions<EventType>, "types">): Promise<EventStore> {
  return JsonlEventLog.open({ ...options, types: EVENT_TYPES });
}
