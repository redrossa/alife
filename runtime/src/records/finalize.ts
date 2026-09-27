import { readFile, stat } from "node:fs/promises";

import { z } from "zod";

import type { Clock } from "../core/clock.ts";
import type { RunId } from "../core/ids.ts";
import { RUN_STATES, STATE_EVENTS, type RunState } from "../core/state.ts";
import type { HolderStatus } from "../operator/locks.ts";
import { watchdogBindingSchema, WATCHDOG_SUPERVISION, type WatchdogBinding } from "../operator/watchdog.ts";
import { canonicalJson } from "../core/hash.ts";
import { readEventLog, WATCHDOG_EVENT_TYPES, type EventEnvelope, type EventLogContents, type LogIssue } from "./events.ts";
import { writeNewFile } from "./files.ts";
import { RunRecorder, type RunPaths } from "./run-store.ts";
import { messageOf } from "../core/errors.ts";

// Interrupted runs (plan §11.4): detected from the durable record, reviewed by
// the operator, and closed by an explicit finalization that lists every
// unknown outcome. Nothing here resumes, replays, or reconciles an execution;
// a prepared action without an outcome stays unknown, including whether it
// ever started.

const LIFECYCLE = new Map<string, RunState>(RUN_STATES.map((state) => [STATE_EVENTS[state], state]));
LIFECYCLE.set("run.resumed", "running");

export interface OutstandingRequest {
  readonly requestId: string;
  readonly tick: number | null;
}

export interface OutstandingAction {
  readonly actionId: string;
  readonly tick: number | null;
  readonly jobId: string | null;
  readonly execId: string | null;
}

export interface OutstandingReservation {
  readonly requestId: string;
  readonly microUsd: number;
}

export interface UncertainAction {
  readonly actionId: string;
  readonly state: string;
  readonly detail: string | null;
}

export interface RunAnalysis {
  readonly runId: string;
  readonly worldId: string | null;
  /** The last lifecycle state the log records; null if it records none. */
  readonly state: RunState | null;
  readonly stopReason: string | null;
  readonly completedTicks: number;
  /**
   * Model calls the record confirms: made (including failures), answered, and failed. `unresolved`
   * counts requests recorded before invocation with no recorded outcome: whether those calls were
   * made is unknown, so they are neither attempts nor non-attempts.
   */
  readonly calls: { readonly confirmedAttempted: number; readonly answered: number; readonly failed: number; readonly unresolved: number };
  readonly lastSequence: number;
  /** Problems in the log. Reported, never repaired. */
  readonly issues: readonly LogIssue[];
  readonly logMissing: boolean;
  readonly outstanding: {
    readonly requests: readonly OutstandingRequest[];
    readonly actions: readonly OutstandingAction[];
    readonly reservations: readonly OutstandingReservation[];
  };
  /** Actions whose recorded outcome is itself uncertain. */
  readonly uncertainActions: readonly UncertainAction[];
  readonly checkpointSha256: string | null;
  readonly finalization: Finalization | null;
  /** The supervision the run declared (`watchdog-v1`), or null for a run without an external watchdog. */
  readonly supervision: string | null;
  /** The watchdog's separate journal, judged against the controller's record; never rewritten. */
  readonly watchdog: WatchdogAnalysis;
}

export interface WatchdogAnalysis {
  /** The latest epoch's watchdog state: `absent` without a journal, `unknown` when nothing in it is usable. */
  readonly state: "absent" | "armed" | "released" | "expired" | "unknown";
  /** An intervention (expiry is lasting), missing or contradictory evidence, or an epoch still guarded. */
  readonly reviewRequired: boolean;
  readonly lastSequence: number;
  /** Whether the latest epoch's container was independently verified stopped; null with no claim either way. */
  readonly stopVerified: boolean | null;
  readonly issues: readonly string[];
}

/** What the controller's record says the watchdog evidence must match. */
interface WatchdogExpectations {
  readonly runId: string;
  readonly worldId: string | null;
  readonly engineId: string | null;
  /** Execution epochs the controller recorded; a binding for any other epoch is foreign. */
  readonly epochs: ReadonlySet<string>;
  /** Epochs the controller ran under watchdog supervision: each needs its own evidence. */
  readonly supervisedEpochs: ReadonlySet<string>;
  readonly required: boolean;
}

interface EpochEvidence {
  readonly binding: WatchdogBinding;
  armed: boolean;
  released: boolean;
  expired: boolean;
  stopVerified: boolean;
  unknown: boolean;
}

/**
 * Judges the watchdog journal. Each binding is one epoch's watchdog; an epoch
 * is clean only when its watchdog was armed and then released after verifying
 * the container stopped. An expiry stays review-required even if a stop or a
 * release follows. Absence is only acceptable for a run that never declared
 * supervision.
 */
export function analyzeWatchdog(journal: EventLogContents | null, expected: WatchdogExpectations): WatchdogAnalysis {
  if (journal === null) {
    return {
      state: "absent",
      reviewRequired: expected.required,
      lastSequence: 0,
      stopVerified: null,
      issues: expected.required ? ["the run declares watchdog supervision, but it has no watchdog journal"] : [],
    };
  }
  const issues = journal.issues.map((issue) => `watchdog journal: ${issue.detail}`);
  const known = new Set<string>(WATCHDOG_EVENT_TYPES);
  const epochs = new Map<string, EpochEvidence>();
  const order: EpochEvidence[] = [];
  for (const event of journal.events) {
    const where = `watchdog record ${event.seq}`;
    if (event.runId !== expected.runId) {
      issues.push(`${where} belongs to run ${event.runId}`);
      continue;
    }
    if (!known.has(event.type)) {
      issues.push(`${where} has unknown type ${event.type}`);
      continue;
    }
    const parsed = watchdogBindingSchema.safeParse(event.data.binding);
    if (!parsed.success) {
      issues.push(`${where} has no valid binding`);
      continue;
    }
    const binding = parsed.data;
    if (binding.runId !== expected.runId) issues.push(`${where} is bound to run ${binding.runId}`);
    if (expected.worldId !== null && binding.worldId !== expected.worldId) issues.push(`${where} is bound to world ${binding.worldId}`);
    if (expected.engineId !== null && binding.engineId !== expected.engineId) issues.push(`${where} is bound to engine ${binding.engineId}`);
    if (!expected.epochs.has(binding.epochId)) issues.push(`${where} is bound to epoch ${binding.epochId}, which the controller did not record`);
    let epoch = epochs.get(binding.epochId);
    if (epoch === undefined) {
      epoch = { binding, armed: false, released: false, expired: false, stopVerified: false, unknown: false };
      epochs.set(binding.epochId, epoch);
      order.push(epoch);
    } else if (canonicalJson(epoch.binding) !== canonicalJson(binding)) {
      issues.push(`${where} carries a different binding for epoch ${binding.epochId}`);
      continue;
    }
    const verified = event.data.verified === true;
    switch (event.type) {
      case "watchdog.armed":
        epoch.armed = true;
        break;
      case "watchdog.released":
        if (!verified) issues.push(`${where} releases epoch ${binding.epochId} without verifying its container stopped`);
        else epoch.released = true;
        break;
      case "watchdog.expired":
        epoch.expired = true;
        if (verified) epoch.stopVerified = true;
        break;
      case "watchdog.stop_verified":
        if (!verified) issues.push(`${where} claims a stop without verification`);
        else epoch.stopVerified = true;
        break;
      case "watchdog.refused":
      case "watchdog.interrupted":
        epoch.unknown = true;
        break;
    }
  }
  for (const epoch of order) {
    const id = epoch.binding.epochId;
    if (!epoch.armed) issues.push(`the watchdog for epoch ${id} has no arming record`);
    if (epoch.unknown) issues.push(`the watchdog for epoch ${id} ended without verifying its container stopped`);
    else if (!epoch.expired && !epoch.released) issues.push(`the watchdog for epoch ${id} has no release`);
    if (epoch.expired) issues.push(`the watchdog intervened in epoch ${id}${epoch.stopVerified ? "; it verified the container stopped" : "; the stop was not verified"}`);
  }
  for (const id of expected.supervisedEpochs) {
    if (!epochs.has(id)) issues.push(`supervised epoch ${id} has no watchdog evidence`);
  }
  if (expected.required && order.length === 0) issues.push("the run declares watchdog supervision, but its journal records no watchdog");
  const last = order.at(-1);
  const state: WatchdogAnalysis["state"] =
    last === undefined ? "unknown" : last.expired ? "expired" : last.unknown ? "unknown" : last.released ? "released" : last.armed ? "armed" : "unknown";
  const stopVerified = last === undefined ? null : last.expired || last.released ? last.stopVerified || last.released : last.unknown ? false : null;
  return { state, reviewRequired: issues.length > 0, lastSequence: journal.events.at(-1)?.seq ?? 0, stopVerified, issues };
}

/** What the controller's events say a watchdog journal must be consistent with. */
function watchdogExpectations(runId: string, events: readonly EventEnvelope[]): WatchdogExpectations & { readonly supervision: string | null } {
  let worldId: string | null = null;
  let engineId: string | null = null;
  let supervision: string | null = null;
  const epochs = new Set<string>();
  const supervisedEpochs = new Set<string>();
  const epochOf = (value: unknown): string | null =>
    typeof value === "object" && value !== null && typeof (value as { epochId?: unknown }).epochId === "string" ? (value as { epochId: string }).epochId : null;
  for (const event of events) {
    const data = event.data;
    switch (event.type) {
      case "run.created": {
        worldId = str(data.worldId);
        engineId = str((data.identity as { engineId?: unknown } | undefined)?.engineId);
        supervision = str(data.supervision);
        break;
      }
      case "run.started":
      case "run.resumed":
      case "supervision.armed": {
        const id = str(data.epochId);
        if (id !== null) {
          epochs.add(id);
          if (data.supervision === WATCHDOG_SUPERVISION || event.type === "supervision.armed") supervisedEpochs.add(id);
        }
        break;
      }
      case "world.stopped":
      case "run.recovery_required":
      case "run.completed": {
        const id = epochOf(data.safety) ?? epochOf((data.worldStop as { safety?: unknown } | undefined)?.safety);
        if (id !== null) epochs.add(id);
        break;
      }
    }
  }
  return { runId, worldId, engineId, epochs, supervisedEpochs, required: supervision === WATCHDOG_SUPERVISION, supervision };
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function analyzeEvents(
  runId: string,
  events: readonly EventEnvelope[],
  issues: readonly LogIssue[],
  logMissing: boolean,
  finalization: Finalization | null,
  journal: EventLogContents | null = null,
): RunAnalysis {
  let state: RunState | null = null;
  let stopReason: string | null = null;
  let worldId: string | null = null;
  let completedTicks = 0;
  const calls = { confirmedAttempted: 0, answered: 0, failed: 0 };
  let checkpointSha256: string | null = null;
  const requests = new Map<string, OutstandingRequest>();
  const actions = new Map<string, OutstandingAction>();
  const reservations = new Map<string, OutstandingReservation>();
  const uncertain: UncertainAction[] = [];

  for (const event of events) {
    const data = event.data;
    const lifecycle = LIFECYCLE.get(event.type);
    if (lifecycle !== undefined) {
      state = lifecycle;
      stopReason = str(data.reason) ?? (lifecycle === "running" ? null : stopReason);
    }
    switch (event.type) {
      case "run.created":
        worldId = str(data.worldId);
        break;
      case "model.requested":
        requests.set(String(data.requestId), { requestId: String(data.requestId), tick: event.tick ?? null });
        break;
      case "model.responded":
        calls.confirmedAttempted += 1;
        calls.answered += 1;
        requests.delete(String(data.requestId));
        break;
      case "model.failed":
        // A request refused or withdrawn before invocation was never an attempted call.
        if (data.sent === true) {
          calls.confirmedAttempted += 1;
          calls.failed += 1;
        }
        requests.delete(String(data.requestId));
        break;
      case "cost.reserved":
        reservations.set(String(data.requestId), { requestId: String(data.requestId), microUsd: typeof data.microUsd === "number" ? data.microUsd : 0 });
        break;
      case "cost.reconciled":
        reservations.delete(String(data.requestId));
        break;
      case "action.prepared":
        actions.set(String(data.actionId), { actionId: String(data.actionId), tick: event.tick ?? null, jobId: str(data.jobId), execId: str(data.execId) });
        break;
      case "action.completed":
      case "action.running":
      case "action.refused":
        actions.delete(String(data.actionId));
        break;
      case "action.uncertain":
        actions.delete(String(data.actionId));
        // Uncertainty is lasting and reported once per action, however often it was recorded;
        // later records of the world ending never make it known.
        if (!uncertain.some((item) => item.actionId === String(data.actionId))) {
          uncertain.push({ actionId: String(data.actionId), state: String(data.state), detail: str(data.detail) });
        }
        break;
      case "tick.completed":
        completedTicks = event.tick ?? completedTicks;
        break;
      case "checkpoint.written":
        checkpointSha256 = str(data.sha256);
        break;
    }
  }
  if (finalization !== null) state = "finalized";
  const expectations = watchdogExpectations(runId, events);
  return {
    runId,
    worldId,
    state,
    stopReason,
    completedTicks,
    calls: { ...calls, unresolved: requests.size },
    lastSequence: events.at(-1)?.seq ?? 0,
    issues,
    logMissing,
    outstanding: { requests: [...requests.values()], actions: [...actions.values()], reservations: [...reservations.values()] },
    uncertainActions: uncertain,
    checkpointSha256,
    finalization,
    supervision: expectations.supervision,
    watchdog: analyzeWatchdog(journal, expectations),
  };
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`there is no run ${runId} in this state directory`);
    this.name = "RunNotFoundError";
  }
}

export async function analyzeRun(paths: RunPaths, runId: RunId): Promise<RunAnalysis> {
  try {
    await stat(paths.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RunNotFoundError(runId);
    throw error;
  }
  let events: readonly EventEnvelope[] = [];
  let issues: readonly LogIssue[] = [];
  let missing = false;
  try {
    ({ events, issues } = await readEventLog(paths.events));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    missing = true;
  }
  const foreign = events.find((event) => event.runId !== runId);
  if (foreign !== undefined) throw new Error(`the event log in ${paths.directory} belongs to run ${foreign.runId}`);
  let journal: EventLogContents | null = null;
  try {
    journal = await readEventLog(paths.watchdogJournal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      journal = { events: [], issues: [{ line: 0, kind: "malformed", detail: `the watchdog journal is unreadable: ${messageOf(error)}` }] };
    }
  }
  return analyzeEvents(runId, events, issues, missing, await readFinalization(paths), journal);
}

/** States in which a run is active; without a live owner they mean it was interrupted. */
export function isActiveState(state: RunState | null): boolean {
  return state === null || state === "created" || state === "ready" || state === "running" || state === "stopping";
}

/** Interrupted: the record says active, but no process that appears alive owns the run. */
export function isInterrupted(analysis: RunAnalysis, owner: HolderStatus | null): boolean {
  if (analysis.finalization !== null) return false;
  if (!isActiveState(analysis.state)) return false;
  return owner === null || owner.appearsAlive === false;
}

// ---------------------------------------------------------------------------
// Finalization

const finalizationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string(),
  finalizedAt: z.iso.datetime(),
  /** The state the log recorded when finalization began. */
  priorState: z.enum(RUN_STATES).nullable(),
  /** Why an event could not be appended instead, when this record is a file. */
  logProblem: z.string().nullable(),
  logIssues: z.array(z.strictObject({ line: z.int(), kind: z.string(), detail: z.string() })),
  acknowledged: z.strictObject({
    requests: z.array(z.strictObject({ requestId: z.string(), tick: z.int().nullable() })),
    actions: z.array(z.strictObject({ actionId: z.string(), tick: z.int().nullable(), jobId: z.string().nullable(), execId: z.string().nullable() })),
    reservations: z.array(z.strictObject({ requestId: z.string(), microUsd: z.number() })),
    uncertainActions: z.array(z.strictObject({ actionId: z.string(), state: z.string(), detail: z.string().nullable() })),
    /** Absent only in records written before Phase 4. */
    watchdog: z
      .strictObject({
        state: z.enum(["absent", "armed", "released", "expired", "unknown"]),
        reviewRequired: z.boolean(),
        lastSequence: z.int().min(0),
        stopVerified: z.boolean().nullable(),
        issues: z.array(z.string()),
      })
      .optional(),
  }),
  world: z.strictObject({ container: z.enum(["absent", "stopped", "running", "unknown"]), detail: z.string() }),
});

export type Finalization = z.infer<typeof finalizationSchema>;

async function readFinalization(paths: RunPaths): Promise<Finalization | null> {
  let text: string;
  try {
    text = await readFile(paths.finalization, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return finalizationSchema.parse(JSON.parse(text));
}

export class FinalizeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinalizeRefusedError";
  }
}

export interface WorldStopCheck {
  readonly container: "absent" | "stopped" | "running" | "unknown";
  readonly detail: string;
}

/** What finalizing would acknowledge; also what `run status` shows. */
export function pendingAcknowledgement(analysis: RunAnalysis): Finalization["acknowledged"] {
  return {
    requests: [...analysis.outstanding.requests],
    actions: [...analysis.outstanding.actions],
    reservations: [...analysis.outstanding.reservations],
    uncertainActions: [...analysis.uncertainActions],
    watchdog: { ...analysis.watchdog, issues: [...analysis.watchdog.issues] },
  };
}

/** Whether the record, including the watchdog's, leaves anything for an operator to review and acknowledge. */
export function needsFinalization(analysis: RunAnalysis): boolean {
  if (analysis.finalization !== null || analysis.state === "finalized") return false;
  return analysis.state !== "stopped_clean" && analysis.state !== "completed" ? true : analysis.watchdog.reviewRequired;
}

/**
 * Closes an interrupted or recovery-required run. The caller holds the run's
 * lock and has checked the world. Refuses while the world is running; with an
 * unknown world state it proceeds only because the operator acknowledged it,
 * and records that. Appends to an intact log; otherwise writes
 * `finalization.json` and leaves the damaged log untouched.
 */
export async function finalizeRun(options: {
  readonly paths: RunPaths;
  readonly runId: RunId;
  readonly clock: Clock;
  readonly analysis: RunAnalysis;
  readonly world: WorldStopCheck;
  /** The run's record limit; null when the run's configuration cannot be read, so nothing is appended. */
  readonly limitBytes: number | null;
}): Promise<Finalization> {
  const { analysis, world } = options;
  if (analysis.finalization !== null || analysis.state === "finalized") throw new FinalizeRefusedError(`run ${options.runId} is already finalized`);
  if ((analysis.state === "stopped_clean" || analysis.state === "completed") && !analysis.watchdog.reviewRequired) {
    throw new FinalizeRefusedError(`run ${options.runId} ended ${analysis.state}; only interrupted or review-required runs are finalized`);
  }
  if (world.container === "running") {
    throw new FinalizeRefusedError(`the world container is still running; stop it explicitly (world stop) before finalizing: ${world.detail}`);
  }

  const record: Finalization = {
    schemaVersion: 1,
    runId: options.runId,
    finalizedAt: options.clock.now().toISOString(),
    priorState: analysis.state,
    logProblem: null,
    logIssues: analysis.issues.map((issue) => ({ ...issue })),
    acknowledged: pendingAcknowledgement(analysis),
    world: { ...world },
  };

  if (analysis.issues.length === 0 && !analysis.logMissing && options.limitBytes !== null) {
    let recorder: RunRecorder | null = null;
    try {
      recorder = await RunRecorder.open({ paths: options.paths, runId: options.runId, clock: options.clock, limitBytes: options.limitBytes });
      if (analysis.state !== "recovery_required") {
        const ended = analysis.state === "stopped_clean" || analysis.state === "completed";
        await recorder.append(
          "run.recovery_required",
          ended
            ? { reason: "watchdog_expired", detail: `the run ended ${analysis.state}, but its watchdog evidence requires review: ${analysis.watchdog.issues.join("; ")}` }
            : { reason: "controller_interrupted", detail: `the run was ${analysis.state ?? "never started"} when its controller stopped; detected at finalization` },
          { durable: true },
        );
      }
      await recorder.append(
        "run.finalized",
        { priorState: record.priorState, acknowledged: record.acknowledged, world: record.world, logIssues: record.logIssues },
        { durable: true },
      );
      return record;
    } catch (error) {
      // The log could not take the record; keep it as a file instead.
      record.logProblem = messageOf(error);
    } finally {
      await recorder?.close().catch(() => undefined);
    }
  } else {
    record.logProblem = analysis.logMissing
      ? "the run has no event log"
      : analysis.issues.length > 0
        ? `the event log is damaged: ${analysis.issues[0]!.detail}`
        : "the run's configuration, which sets its record limit, is unreadable";
  }
  await writeNewFile(options.paths.finalization, `${JSON.stringify(finalizationSchema.parse(record), null, 2)}\n`);
  return record;
}
