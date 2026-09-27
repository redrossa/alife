import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { systemClock, type Clock } from "../core/clock.ts";
import { messageOf } from "../core/errors.ts";
import { isRunId, isWorldId } from "../core/ids.ts";
import { JsonlEventLog, WATCHDOG_EVENT_TYPES, type WatchdogEventType } from "../records/events.ts";
import { EngineResponseError, type DockerContext, type DockerEngine } from "../world/engine.ts";
import { ROLE_LABEL, WORLD_LABEL } from "../world/resources.ts";

// The independent watchdog (plan §6, supervision `watchdog-v1`). One watchdog
// protects one execution epoch: the exact container created for it, on the
// exact engine, until the controller releases it after a verified stop, the
// controller's lease expires, or the run's original deadline passes. It runs
// as a separate process without model credentials or the controller's
// environment, and keeps its own journal so it never writes controller
// records. It never prunes, removes, or replays anything: its only mutation is
// a stop request for the bound container, issued only after the engine and the
// container's identity and labels are verified again, and a stop counts only
// once an independent inspection shows the container stopped or gone.

export const WATCHDOG_SUPERVISION = "watchdog-v1";

/** Clock disagreement beyond this between two polls is treated as a discontinuity (a suspended host, a clock step). */
const CLOCK_TOLERANCE_MS = 1000;
/** A heartbeat may not claim to be issued further in the future than this. */
const MAXIMUM_ISSUE_SKEW_MS = 250;
const ENGINE_TIMEOUT_MS = 10_000;
const STOP_GRACE_SECONDS = 5;
/** Diagnostic records per condition, so a long outage cannot fill the journal. */
const MAXIMUM_DIAGNOSTICS = 16;
const MAXIMUM_POLL_MS = 1000;

const hex = (bytes: number) => new RegExp(`^[a-f0-9]{${bytes * 2}}$`);

export const watchdogBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().refine(isRunId, "not a run ID"),
  worldId: z.string().refine(isWorldId, "not a world ID"),
  epochId: z.string().min(1).max(128),
  controllerToken: z.string().regex(hex(16)),
  engineId: z.string().min(1).max(512),
  containerId: z.string().regex(hex(32)),
  /** The run's original absolute deadline; no heartbeat moves it. */
  deadline: z.iso.datetime(),
  leaseMs: z.int().min(1).max(3_600_000),
});

export type WatchdogBinding = z.infer<typeof watchdogBindingSchema>;

export const leaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string(),
  worldId: z.string(),
  epochId: z.string(),
  controllerToken: z.string(),
  sequence: z.int().min(1),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  state: z.enum(["active", "released"]),
});

export type WatchdogLease = z.infer<typeof leaseSchema>;

export interface WatchdogResult {
  readonly outcome: "released" | "stopped" | "unknown" | "refused";
  /** True only when an independent inspection showed the bound container stopped or absent. */
  readonly verified: boolean;
  readonly reason: string;
  readonly containerId: string | null;
}

export interface WatchdogOptions {
  readonly leaseFile: string;
  readonly journalFile: string;
  readonly binding: WatchdogBinding;
  readonly clock: Clock;
  readonly engine: Pick<DockerEngine, "get" | "post">;
  /** Aborting ends the watch; the result is then unknown unless the stop was already verified. */
  readonly signal: AbortSignal;
  readonly pollIntervalMs: number;
  /** Bound on the journal file, including what earlier epochs wrote to it. */
  readonly maximumJournalBytes: number;
  /** Called once, after the arming record is durable. */
  readonly onReady?: () => void;
}

/** Atomically replaces the lease file. */
export async function writeLease(file: string, lease: WatchdogLease): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(lease)}\n`);
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

type Identity =
  | { readonly kind: "present"; readonly running: boolean }
  | { readonly kind: "absent" }
  | { readonly kind: "mismatch"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** The watchdog's journal. Failures are latched and reported, never allowed to prevent a stop. */
class Journal {
  #log: JsonlEventLog<WatchdogEventType> | null;
  problem: string | null;
  readonly #counts = new Map<string, number>();

  private constructor(log: JsonlEventLog<WatchdogEventType> | null, problem: string | null) {
    this.#log = log;
    this.problem = problem;
  }

  static async open(options: WatchdogOptions): Promise<Journal> {
    try {
      const log = await JsonlEventLog.open({
        file: options.journalFile,
        runId: options.binding.runId,
        clock: options.clock,
        limitBytes: options.maximumJournalBytes,
        types: WATCHDOG_EVENT_TYPES,
      });
      return new Journal(log, null);
    } catch (error) {
      return new Journal(null, `the journal could not be opened: ${messageOf(error)}`);
    }
  }

  /** Appends, durably unless it is a diagnostic; returns whether the record was written. */
  async append(type: WatchdogEventType, data: Readonly<Record<string, unknown>>, durable = true): Promise<boolean> {
    if (this.#log === null) return false;
    try {
      await this.#log.append(type, data, { durable });
      return true;
    } catch (error) {
      this.problem ??= `a journal record could not be written: ${messageOf(error)}`;
      return false;
    }
  }

  /** A diagnostic record, at most a bounded number of times per key. */
  async diagnostic(key: string, type: WatchdogEventType, data: Readonly<Record<string, unknown>>): Promise<void> {
    const count = this.#counts.get(key) ?? 0;
    if (count >= MAXIMUM_DIAGNOSTICS) return;
    this.#counts.set(key, count + 1);
    // Diagnostics become durable with the next lasting record (or when the journal closes).
    await this.append(type, data, false);
  }

  async close(): Promise<void> {
    const log = this.#log;
    this.#log = null;
    await log?.close().catch(() => undefined);
  }
}

class Interrupted extends Error {}

/**
 * The watchdog's state machine. It polls the lease file and its clocks; it
 * calls the engine only to verify identity (arming, release, and before and
 * after a stop). Returns once the bound container is independently verified
 * stopped or absent (after a release or an intervention), the binding is
 * refused, or the watch is aborted.
 */
export async function runWatchdog(options: WatchdogOptions): Promise<WatchdogResult> {
  const parsed = watchdogBindingSchema.safeParse(options.binding);
  if (!parsed.success) {
    return { outcome: "refused", verified: false, reason: `invalid binding: ${parsed.error.issues[0]?.message ?? "invalid"}`, containerId: null };
  }
  const binding = parsed.data;
  if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 1 || options.pollIntervalMs > MAXIMUM_POLL_MS) {
    return { outcome: "refused", verified: false, reason: `invalid poll interval ${options.pollIntervalMs}`, containerId: null };
  }
  const { clock, engine, signal } = options;
  const container = binding.containerId;
  const journal = await Journal.open(options);
  const result = (outcome: WatchdogResult["outcome"], verified: boolean, reason: string): WatchdogResult => ({ outcome, verified, reason, containerId: container });

  const identity = async (): Promise<Identity> => {
    try {
      const info = await engine.get("/info", { timeoutMs: ENGINE_TIMEOUT_MS });
      const engineId = field(info, "ID");
      if (engineId !== binding.engineId) return { kind: "mismatch", detail: `the engine is ${String(engineId)}, not the bound ${binding.engineId}` };
    } catch (error) {
      return { kind: "unavailable", detail: `engine identity: ${messageOf(error)}` };
    }
    let inspected: unknown;
    try {
      inspected = await engine.get(`/containers/${container}/json`, { timeoutMs: ENGINE_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof EngineResponseError && error.status === 404) return { kind: "absent" };
      return { kind: "unavailable", detail: `container inspection: ${messageOf(error)}` };
    }
    const labels = field(field(inspected, "Config"), "Labels");
    const running = field(field(inspected, "State"), "Running");
    if (field(inspected, "Id") !== container) return { kind: "mismatch", detail: `the engine answered for container ${String(field(inspected, "Id"))}` };
    if (field(labels, WORLD_LABEL) !== binding.worldId) return { kind: "mismatch", detail: "the container's world label differs" };
    if (field(labels, ROLE_LABEL) !== "world") return { kind: "mismatch", detail: "the container's role label differs" };
    if (typeof running !== "boolean") return { kind: "unavailable", detail: "the container's running state is unreadable" };
    return { kind: "present", running };
  };

  // Clocks: the lease and the deadline are held in this process's monotonic time; wall time is compared
  // against it at every poll, and a discontinuity in either direction ends the lease's authority.
  const start = { wall: clock.now().getTime(), mono: clock.monotonicMs() };
  const deadlineWall = Date.parse(binding.deadline);
  const deadlineMono = start.mono + (deadlineWall - start.wall);
  let previous = start;

  const watch: {
    accepted: { readonly raw: string; readonly lease: WatchdogLease; readonly expiresMono: number } | null;
    releaseRequested: boolean;
    stopRequested: boolean;
  } = { accepted: null, releaseRequested: false, stopRequested: false };
  /** Why the bound container must now be stopped; lasting once set. */
  let intervention: string | null = null;
  let armed = false;
  let expiryRecorded = false;

  const matches = (lease: WatchdogLease) =>
    lease.runId === binding.runId && lease.worldId === binding.worldId && lease.epochId === binding.epochId && lease.controllerToken === binding.controllerToken;

  /** Evaluates the lease file; returns an intervention reason, or null. */
  const evaluateLease = async (now: { wall: number; mono: number }): Promise<string | null> => {
    let raw: string;
    try {
      raw = await readFile(options.leaseFile, "utf8");
    } catch (error) {
      return `the lease file is unreadable: ${messageOf(error)}`;
    }
    if (watch.accepted !== null && raw === watch.accepted.raw) return null;
    let lease: WatchdogLease;
    try {
      const checked = leaseSchema.safeParse(JSON.parse(raw));
      if (!checked.success) return `the lease is malformed: ${checked.error.issues[0]?.message ?? "invalid"}`;
      lease = checked.data;
    } catch {
      return "the lease is not valid JSON";
    }
    if (!matches(lease)) return "the lease belongs to a different run, epoch, or controller";
    if (watch.accepted !== null && lease.sequence <= watch.accepted.lease.sequence) return `the lease sequence ${lease.sequence} does not advance ${watch.accepted.lease.sequence}`;
    const issued = Date.parse(lease.issuedAt);
    const expires = Date.parse(lease.expiresAt);
    if (issued > now.wall + MAXIMUM_ISSUE_SKEW_MS) return `the lease claims to be issued at ${lease.issuedAt}, in the future`;
    if (watch.accepted !== null && issued < Date.parse(watch.accepted.lease.issuedAt)) return "the lease was issued before the one it replaces";
    if (lease.state === "released") {
      watch.releaseRequested = true;
      watch.accepted = { raw, lease, expiresMono: watch.accepted?.expiresMono ?? now.mono };
      return null;
    }
    if (!(expires > issued) || expires - issued > binding.leaseMs) return `the lease's validity ${expires - issued} ms exceeds the bound ${binding.leaseMs} ms`;
    watch.accepted = { raw, lease, expiresMono: now.mono + (expires - now.wall) };
    return null;
  };

  /** One attempt to stop the exact container and verify it independently. */
  const stopOnce = async (): Promise<"verified" | "refused" | "unknown"> => {
    const before = await identity();
    if (before.kind === "mismatch") {
      await journal.append("watchdog.refused", { binding, reason: before.detail, verified: false });
      return "refused";
    }
    if (before.kind === "unavailable") {
      await journal.diagnostic("stop-unavailable", "watchdog.unavailable", { binding, detail: before.detail, retryMs: options.pollIntervalMs });
      return "unknown";
    }
    if (before.kind === "present" && before.running) {
      // A lost reply is resolved by inspection below, never by repeating the request blindly;
      // the request is repeated only after an inspection shows the container still running.
      try {
        watch.stopRequested = true;
        await engine.post(`/containers/${container}/stop`, { query: { t: String(STOP_GRACE_SECONDS) }, timeoutMs: (STOP_GRACE_SECONDS + 10) * 1000 });
      } catch (error) {
        if (!(error instanceof EngineResponseError && error.status === 304)) {
          await journal.diagnostic("stop-reply", "watchdog.unavailable", { binding, detail: `stop request: ${messageOf(error)}`, retryMs: options.pollIntervalMs });
        }
      }
      let after: unknown;
      try {
        after = await engine.get(`/containers/${container}/json`, { timeoutMs: ENGINE_TIMEOUT_MS });
      } catch (error) {
        if (error instanceof EngineResponseError && error.status === 404) return "verified";
        await journal.diagnostic("stop-inspect", "watchdog.unavailable", { binding, detail: `inspection after stop: ${messageOf(error)}`, retryMs: options.pollIntervalMs });
        return "unknown";
      }
      if (field(after, "Id") !== container) return "unknown";
      return field(field(after, "State"), "Running") === false ? "verified" : "unknown";
    }
    return "verified";
  };

  const sample = () => ({ wall: clock.now().getTime(), mono: clock.monotonicMs() });

  try {
    for (;;) {
      if (signal.aborted) throw new Interrupted();
      const now = sample();
      if (intervention === null) {
        const drift = now.wall - previous.wall - (now.mono - previous.mono);
        if (Math.abs(drift) > CLOCK_TOLERANCE_MS) {
          intervention = `the wall clock and the monotonic clock disagree by ${drift} ms (a suspended host or a clock step)`;
        } else if (now.wall >= deadlineWall || now.mono >= deadlineMono) {
          intervention = `the run's deadline ${binding.deadline} passed`;
        } else if (watch.accepted !== null && !watch.releaseRequested && now.mono >= watch.accepted.expiresMono) {
          intervention = "the controller's lease expired";
        } else if (!watch.releaseRequested) {
          intervention = await evaluateLease(now);
        }
        if (intervention === null && !armed && journal.problem !== null) intervention = journal.problem;
      }
      previous = now;

      if (intervention === null && !armed) {
        const found = await identity();
        if (found.kind === "mismatch") {
          await journal.append("watchdog.refused", { binding, reason: found.detail, verified: false });
          return result("refused", false, `refusing to arm: ${found.detail}`);
        }
        if (found.kind === "unavailable") {
          await journal.diagnostic("arm-unavailable", "watchdog.unavailable", { binding, detail: found.detail, retryMs: options.pollIntervalMs });
        } else if (await journal.append("watchdog.armed", { binding, watchdogPid: process.pid })) {
          armed = true;
          options.onReady?.();
        } else {
          intervention = journal.problem ?? "the arming record could not be written";
        }
      }

      if (intervention === null && watch.releaseRequested) {
        const found = await identity();
        if (found.kind === "mismatch") {
          await journal.append("watchdog.refused", { binding, reason: found.detail, verified: false });
          return result("refused", false, `the release could not be verified: ${found.detail}`);
        }
        if (found.kind === "absent" || (found.kind === "present" && !found.running)) {
          const reason = `released by the controller; the container is ${found.kind === "absent" ? "absent" : "stopped"}`;
          await journal.append("watchdog.released", { binding, verified: true, reason });
          return result("released", true, reason);
        }
        if (found.kind === "present") intervention = "the controller released a container that is still running";
        else await journal.diagnostic("release-unavailable", "watchdog.unavailable", { binding, detail: found.detail, retryMs: options.pollIntervalMs });
      }

      if (intervention !== null) {
        if (!expiryRecorded) {
          expiryRecorded = true;
          await journal.append("watchdog.expired", { binding, reason: intervention, verified: false });
        }
        const outcome = await stopOnce();
        if (outcome === "refused") return result("refused", false, `${intervention}; the stop was refused because the bound container's identity changed`);
        if (outcome === "verified") {
          const reason = `${intervention}; the bound container is independently verified ${watch.stopRequested ? "stopped" : "stopped or absent"}`;
          await journal.append("watchdog.stop_verified", { binding, verified: true, reason });
          return result("stopped", true, journal.problem === null ? reason : `${reason} (journal incomplete: ${journal.problem})`);
        }
      }

      try {
        await clock.sleep(options.pollIntervalMs, signal);
      } catch {
        throw new Interrupted();
      }
    }
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
    const reason = intervention === null ? "the watch was interrupted" : `the watch was interrupted before its stop was verified: ${intervention}`;
    await journal.append("watchdog.interrupted", { binding, reason, verified: false });
    return result("unknown", false, reason);
  } finally {
    await journal.close();
  }
}

// ---------------------------------------------------------------------------
// The watchdog process

export interface LaunchOptions {
  readonly leaseFile: string;
  readonly journalFile: string;
  readonly binding: WatchdogBinding;
  readonly context: DockerContext;
  readonly pollIntervalMs: number;
  readonly maximumJournalBytes: number;
}

export interface WatchdogHandle {
  /** The watchdog's own process ID, distinct from the controller's. */
  readonly pid: number;
  /** Renews the lease for another `leaseMs`; rejects once the lease was released or the watchdog ended. */
  heartbeat(): Promise<void>;
  /** Settles when the watchdog process reports its result or ends without one. */
  readonly completed: Promise<WatchdogResult>;
  /** Asks the watchdog to verify the stopped container and exit; resolves with its result. */
  release(): Promise<WatchdogResult>;
}

export const launchOptionsSchema = z.strictObject({
  leaseFile: z.string().refine((value) => path.isAbsolute(value), "must be absolute"),
  journalFile: z.string().refine((value) => path.isAbsolute(value), "must be absolute"),
  binding: watchdogBindingSchema,
  context: z.strictObject({ name: z.string().min(1), endpoint: z.string().startsWith("unix://"), socketPath: z.string().refine((value) => path.isAbsolute(value), "must be absolute") }),
  pollIntervalMs: z.int().min(10).max(MAXIMUM_POLL_MS),
  maximumJournalBytes: z.int().min(1024).max(1 << 30),
});

const READY_TIMEOUT_MS = 30_000;
const RELEASE_TIMEOUT_MS = 30_000;
const MAXIMUM_REPORT_BYTES = 16 << 10;

function childEntry(): string {
  // The same extension as this module: `.ts` when run from sources, `.js` when built.
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), `watchdog-child${path.extname(self)}`);
}

const resultSchema = z.strictObject({
  outcome: z.enum(["released", "stopped", "unknown", "refused"]),
  verified: z.boolean(),
  reason: z.string(),
  containerId: z.string().nullable(),
});

/**
 * Launches the watchdog as a separate process and resolves only after it has
 * durably recorded that it is armed. The lease is initialized here, before
 * the process starts; later renewals go through the handle. The process gets
 * no environment from the controller.
 */
export async function startWatchdog(options: LaunchOptions): Promise<WatchdogHandle> {
  const checked = launchOptionsSchema.parse(options);
  const { binding } = checked;
  let sequence = 1;
  const lease = (state: WatchdogLease["state"]): WatchdogLease => {
    const issued = systemClock.now();
    return {
      schemaVersion: 1,
      runId: binding.runId,
      worldId: binding.worldId,
      epochId: binding.epochId,
      controllerToken: binding.controllerToken,
      sequence,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + binding.leaseMs).toISOString(),
      state,
    };
  };
  await writeLease(checked.leaseFile, lease("active"));

  const child = spawn(process.execPath, [childEntry()], {
    cwd: "/",
    env: {},
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("the watchdog process could not be started");

  let buffer = "";
  let ready!: () => void;
  let failed!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  let settle!: (value: WatchdogResult) => void;
  const completed = new Promise<WatchdogResult>((resolve) => {
    settle = resolve;
  });
  let reported: WatchdogResult | null = null;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAXIMUM_REPORT_BYTES) {
      buffer = "";
      return;
    }
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line) as { type?: unknown; result?: unknown };
        if (message.type === "ready") ready();
        if (message.type === "result") {
          const parsed = resultSchema.safeParse(message.result);
          if (parsed.success) reported = parsed.data;
        }
      } catch {
        // Not a report; the process's own evidence is its journal.
      }
    }
  });
  child.once("error", (error) => failed(error));
  child.once("exit", (code, signal) => {
    failed(new Error(`the watchdog exited before it was armed (${signal ?? code})`));
    settle(reported ?? { outcome: "unknown", verified: false, reason: `the watchdog exited without a result (${signal ?? code})`, containerId: binding.containerId });
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(JSON.stringify(checked));

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      readiness,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the watchdog was not armed within ${READY_TIMEOUT_MS} ms`)), READY_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // Only this exact child, which this call started, is signalled; it has not reported readiness.
    child.kill("SIGTERM");
    throw error;
  } finally {
    clearTimeout(timer);
  }
  // The controller may exit while its watchdog keeps running; it waits for the process only to release it.
  const stdout = child.stdout as unknown as { ref(): void; unref(): void };
  child.unref();
  stdout.unref();

  let released = false;
  let writing: Promise<void> = Promise.resolve();
  const renew = (state: WatchdogLease["state"]): Promise<void> => {
    const next = writing.then(async () => {
      if (released) throw new Error("the lease was released");
      if (reported !== null || child.exitCode !== null || child.signalCode !== null) throw new Error("the watchdog is no longer running");
      sequence += 1;
      await writeLease(checked.leaseFile, lease(state));
      if (state === "released") released = true;
    });
    writing = next.catch(() => undefined);
    return next;
  };
  return {
    pid,
    heartbeat: () => renew("active"),
    completed,
    release: async () => {
      await renew("released");
      child.ref();
      stdout.ref();
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          completed,
          new Promise<WatchdogResult>((resolve) => {
            // The watchdog keeps protecting the container meanwhile; only this wait ends.
            timer = setTimeout(
              () => resolve({ outcome: "unknown", verified: false, reason: `the watchdog reported no result within ${RELEASE_TIMEOUT_MS} ms of the release`, containerId: binding.containerId }),
              RELEASE_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        child.unref();
        stdout.unref();
      }
    },
  };
}
