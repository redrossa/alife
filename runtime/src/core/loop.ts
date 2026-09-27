import type { Clock } from "./clock.ts";
import { ContextOverflowError } from "./context.ts";
import type {
  ActionRequest,
  AppendOptions,
  ContextPolicy,
  DispatchHooks,
  Exchange,
  JobSnapshot,
  MindAdapter,
  MindOutcome,
  MindReply,
  OperationalOutcome,
  ToolDefinition,
  ToolResult,
  WorldSample,
  WorldStatus,
} from "./contracts.ts";
import { DispatchRefusedError, JobAdmissionError, UncertainJobsError } from "./dispatch.ts";
import { canonicalSha256 } from "./hash.ts";
import { actionId, requestId, type RunId } from "./ids.ts";
import { interpretResponse } from "./intentions.ts";
import {
  CONTEXT_APPENDIX_BYTES,
  renderActionResult,
  renderContextUsage,
  renderNotExecuted,
  renderObservation,
  WAIT_RESULT,
} from "./observation.ts";
import type { ExecutionSafetySnapshot } from "./execution-safety.ts";
import type { StopReason } from "./state.ts";
import type { CostLedger, Settlement } from "../records/accounting.ts";
import type { EventType } from "../records/events.ts";
import { RecordCapacityError } from "../records/events.ts";
import type { TextRef } from "../records/run-store.ts";
import { UncertaintyRecorder, type Discovery } from "../records/uncertainty.ts";
import { messageOf } from "./errors.ts";

// The tick loop (plan §11.1): one decision per tick, effects recorded durably
// before they happen, and nothing replayed. The loop keeps exactly one kind
// of memory, the bounded active history that the context policy retains; an
// exchange it evicts is dropped for good and never offered again.

/** The world as the loop uses it: observe, act, and check it is still there. */
export interface LoopWorld {
  /** The loop never requests the directory listing (`baseline-sensors-v4`). */
  sample(options: { readonly listing: boolean }): Promise<WorldSample>;
  submit(request: ActionRequest, hooks: DispatchHooks): Promise<JobSnapshot>;
  acknowledgeJobs(jobIds: readonly string[]): void;
  /** The execution epoch's safety condition, synchronously and without I/O. */
  safety(): ExecutionSafetySnapshot | null;
  /** Inspects tracked jobs so uncertainty the engine now shows is latched. */
  refreshJobSafety(): Promise<void>;
  inspect(): Promise<WorldStatus>;
}

export interface LoopRecords {
  append(type: EventType, data: Readonly<Record<string, unknown>>, options?: AppendOptions): Promise<number>;
  text(value: string): Promise<TextRef>;
  json(value: unknown): Promise<TextRef>;
  remainingBytes(): number;
  readonly writable: boolean;
}

export interface LoopSettings {
  readonly runId: RunId;
  readonly instructions: string;
  readonly tools: readonly ToolDefinition[];
  readonly maximumTicks: number;
  /** Absolute; preserved across clean stops. */
  readonly deadline: Date;
  readonly maximumConsecutiveProtocolErrors: number;
  readonly minimumTickIntervalMs: number;
  readonly requestTimeoutMs: number;
  readonly maximumOutputTokens: number;
  readonly maximumCommandBytes: number;
  readonly perceivedOutputBytes: number;
  readonly exposeContextUsage: boolean;
  /** A tick starts only if at least this much record capacity remains. */
  readonly tickRecordReserveBytes: number;
  /**
   * A tick starts only if at least this long remains before the deadline
   * (supervised runs: a bounded tick and the stop must finish before the
   * watchdog enforces the deadline). Zero checks only the deadline itself.
   */
  readonly deadlineMarginMs?: number;
  readonly minimumHostFreeMiB: number;
  readonly hostFreeMiB: () => Promise<number>;
}

/** Everything the loop carries between ticks; a clean checkpoint stores exactly this. */
export interface LoopState {
  /** Ticks finished, whether or not their model call was made; tick numbers and IDs are never reused. */
  readonly completedTicks: number;
  /** Model calls actually made, including failed ones; the tick limit counts these (operator decision 3). */
  readonly attemptedCalls: number;
  /** Model calls that received a response: the steps analysis compares behavior over. */
  readonly respondedCalls: number;
  /** Active time in earlier sessions of this run. */
  readonly elapsedMs: number;
  /** Retained exchanges, oldest first. */
  readonly history: readonly Exchange[];
  /** Exchanges evicted so far; their content is gone from the loop. */
  readonly evictedCount: number;
  readonly previousOutcome: OperationalOutcome | null;
  readonly previousInputTokens: number | null;
  readonly protocolErrorStreak: number;
}

export const INITIAL_LOOP_STATE: LoopState = {
  completedTicks: 0,
  attemptedCalls: 0,
  respondedCalls: 0,
  elapsedMs: 0,
  history: [],
  evictedCount: 0,
  previousOutcome: null,
  previousInputTokens: null,
  protocolErrorStreak: 0,
};

/**
 * How the loop ended. `clean` means nothing is outstanding: every request and
 * action has a recorded outcome. Otherwise the run needs review.
 */
export interface LoopEnd {
  readonly clean: boolean;
  readonly reason: StopReason;
  readonly detail: string;
}

export interface TickReport {
  readonly tick: number;
  readonly outcome: OperationalOutcome;
}

export interface TickLoopOptions {
  readonly world: LoopWorld;
  readonly mind: MindAdapter;
  readonly policy: ContextPolicy;
  readonly records: LoopRecords;
  readonly ledger: CostLedger;
  readonly clock: Clock;
  readonly settings: LoopSettings;
  readonly state?: LoopState;
  readonly onTick?: (report: TickReport) => void;
  /** The run's uncertainty writer, shared with finalization; the loop makes its own if absent. */
  readonly uncertainty?: UncertaintyRecorder;
  /**
   * Why no new model call or command may be admitted now (lost supervision), or
   * null. Asked synchronously at each commitment point; a reason ends the run
   * for review. It never recovers within a run.
   */
  readonly admission?: () => string | null;
  /** Awaited at declared lifecycle points, for instrumentation; nothing by default. */
  readonly boundary?: (name: LoopBoundary) => Promise<void>;
  /** The first tick of this session follows a clean resume (`resume-discontinuity-v1`). */
  readonly resumed?: boolean;
  /**
   * An authority beyond the run's own ledger that every model call must also
   * be admitted against (the shared spending campaign): it durably holds each
   * request's full maximum before the request is recorded or sent.
   */
  readonly spend?: SpendAuthority;
}

export type SpendSettlement = { readonly basis: "usage"; readonly chargedMicroUsd: number } | { readonly basis: "unknown" | "not_processed" };

export interface SpendAuthority {
  /** Durably holds `microUsd` for `requestId`; false (holding nothing) if it does not fit. */
  reserve(requestId: string, microUsd: number): Promise<boolean>;
  /** Settles a held request exactly once. */
  settle(requestId: string, settlement: SpendSettlement): Promise<void>;
  /** Recorded with each reservation, naming the authority. */
  readonly identity: Readonly<Record<string, unknown>>;
}

export type LoopBoundary = "after_model_requested" | "after_model_responded" | "after_action_prepared" | "after_action_commit";

type FailureKind = OperationalOutcome & { kind: "model_failed" };

/** A tick either continues the run or ends it. */
type TickEnd = LoopEnd | null;

/** A snapshot built from a refusal, for worlds that cannot report their own safety condition. */
function denialSnapshot(error: UncertainJobsError): ExecutionSafetySnapshot {
  return {
    epochId: "unknown",
    admission: "closed",
    reviewRequired: true,
    uncertainEffects: error.effects,
    reviewCauses: [],
    requiredEvidenceFailed: error.evidenceFailed,
    committedEffects: 0,
  };
}

/** Whether a tick made its model call, and whether that call received a response. */
interface CallAccounting {
  readonly attempted: boolean;
  readonly responded: boolean;
}

const NOT_ATTEMPTED: CallAccounting = { attempted: false, responded: false };
const FAILED_ATTEMPT: CallAccounting = { attempted: true, responded: false };
const RESPONDED: CallAccounting = { attempted: true, responded: true };

/** Jobs an observation reports as finished: their state can no longer change and their output is closed. */
function finishedJobs(sample: WorldSample): string[] {
  return sample.jobs.filter((job) => (job.state === "exited" || job.state === "ended_with_world") && job.output !== "open").map((job) => job.jobId);
}

/** Lost supervision ends a run for review; nothing more is admitted. */
const SUPERVISION_LOST: StopReason = "watchdog_expired";

class Unclean extends Error {
  readonly reason: StopReason;

  constructor(reason: StopReason, message: string) {
    super(message);
    this.name = "Unclean";
    this.reason = reason;
  }
}

export class TickLoop {
  readonly #options: TickLoopOptions;
  readonly #uncertainty: UncertaintyRecorder;
  #state: LoopState;
  #sessionStarted = 0;
  /** Set when `run` returns: time spent stopping the world is not run time. */
  #sessionEnded: number | null = null;
  /** Whether the next observation is the first after a resume. */
  #resumed: boolean;

  constructor(options: TickLoopOptions) {
    this.#options = options;
    this.#uncertainty = options.uncertainty ?? new UncertaintyRecorder((type, data, append) => options.records.append(type, data, append));
    this.#state = options.state ?? INITIAL_LOOP_STATE;
    this.#resumed = options.resumed === true;
  }

  #denied(): string | null {
    return this.#options.admission?.() ?? null;
  }

  async #boundary(name: LoopBoundary): Promise<void> {
    await this.#options.boundary?.(name);
  }

  /** The state after the last completed tick. */
  get state(): LoopState {
    return { ...this.#state, elapsedMs: this.#elapsed() };
  }

  #elapsed(): number {
    if (this.#sessionStarted === 0) return this.#state.elapsedMs;
    return this.#state.elapsedMs + (this.#sessionEnded ?? this.#options.clock.monotonicMs()) - this.#sessionStarted;
  }

  async run(signal: AbortSignal): Promise<LoopEnd> {
    try {
      const end = await this.#run(signal);
      return end.clean ? await this.#finalCheck(end) : end;
    } finally {
      this.#sessionEnded = this.#options.clock.monotonicMs();
    }
  }

  async #run(signal: AbortSignal): Promise<LoopEnd> {
    const { clock, settings } = this.#options;
    this.#sessionStarted = clock.monotonicMs();
    // The deadline in this process's monotonic time, so a wall-clock jump cannot extend the run.
    const monotonicDeadline = this.#sessionStarted + (settings.deadline.getTime() - clock.now().getTime());
    for (;;) {
      let end: TickEnd;
      try {
        end = await this.#limits(signal, monotonicDeadline);
        if (end !== null) return end;
        const tickStarted = clock.monotonicMs();
        end = await this.#tick(this.#state.completedTicks + 1, signal);
        if (end !== null) return end;
        const remaining = settings.minimumTickIntervalMs - (clock.monotonicMs() - tickStarted);
        if (remaining > 0) await clock.sleep(remaining, signal).catch(() => undefined);
      } catch (error) {
        return this.#unclean(error);
      }
    }
  }

  /**
   * Before a clean end, refresh the jobs so uncertainty the engine already
   * shows ends the run for review promptly. This is early detection only: it
   * is not what certifies the run. Uncertainty established after this check,
   * while stopping, is carried by the world's sealed stop assessment, which is
   * what run finalization and checkpoint eligibility use.
   */
  async #finalCheck(end: LoopEnd): Promise<LoopEnd> {
    try {
      await this.#options.world.refreshJobSafety();
      return (await this.#reviewRequired("before_stop", null)) ?? end;
    } catch (error) {
      return this.#unclean(error);
    }
  }

  /**
   * If the epoch requires review, records its uncertain effects and returns
   * the review end; otherwise null. Uses the synchronous safety snapshot.
   */
  async #reviewRequired(discovered: Discovery, tick: number | null): Promise<LoopEnd | null> {
    const safety = this.#options.world.safety();
    if (safety === null || !safety.reviewRequired) return null;
    return this.#endForReview(safety, discovered, tick);
  }

  async #endForReview(safety: ExecutionSafetySnapshot, discovered: Discovery, tick: number | null): Promise<LoopEnd> {
    await this.#uncertainty.record(safety.uncertainEffects, discovered, tick);
    const ids = safety.uncertainEffects.map((effect) => effect.jobId);
    if (ids.length > 0) return { clean: false, reason: "uncertain_action", detail: `the outcome of ${ids.join(", ")} is uncertain (found: ${discovered})` };
    if (safety.reviewCauses.length > 0) {
      const what = safety.reviewCauses.map((cause) => `a ${cause.requestedBy} signal to ${cause.jobId}`).join(", ");
      return { clean: false, reason: "uncertain_signal", detail: `the delivery of ${what} is unknown (found: ${discovered})` };
    }
    return { clean: false, reason: "record_failure", detail: `required world evidence could not be recorded (found: ${discovered})` };
  }

  #unclean(error: unknown): LoopEnd {
    if (error instanceof Unclean) return { clean: false, reason: error.reason, detail: error.message };
    if (error instanceof RecordCapacityError) return { clean: false, reason: "record_capacity", detail: error.message };
    if (!this.#options.records.writable) return { clean: false, reason: "record_failure", detail: messageOf(error) };
    return { clean: false, reason: "controller_interrupted", detail: `unexpected error during a tick: ${messageOf(error)}` };
  }

  async #operatorStop(signal: AbortSignal, when: string): Promise<LoopEnd> {
    // Durable with the stop's lifecycle record, which the run writes next, before the world is stopped.
    await this.#options.records.append("operator.intervention", { action: "stop", when, reason: messageOf(signal.reason ?? "stop requested") });
    return { clean: true, reason: "operator_stop", detail: `the operator requested a stop ${when}` };
  }

  /** Limits checked before a tick starts. Reaching one ends the run cleanly, before anything is sent. */
  async #limits(signal: AbortSignal, monotonicDeadline: number): Promise<TickEnd> {
    const { settings, clock, records, world } = this.#options;
    const stop = (reason: StopReason, detail: string): LoopEnd => ({ clean: true, reason, detail });
    const denied = this.#denied();
    if (denied !== null) throw new Unclean(SUPERVISION_LOST, denied);
    if (signal.aborted) return this.#operatorStop(signal, "between ticks");
    // The operational limit counts attempted model calls, failures included, so failures cannot bypass it.
    if (this.#state.attemptedCalls >= settings.maximumTicks) {
      return stop("tick_limit", `${settings.maximumTicks} model calls attempted`);
    }
    const margin = settings.deadlineMarginMs ?? 0;
    if (clock.now().getTime() + margin >= settings.deadline.getTime() || clock.monotonicMs() + margin >= monotonicDeadline) {
      return stop(
        "deadline",
        margin === 0
          ? `the run deadline ${settings.deadline.toISOString()} passed`
          : `the run deadline ${settings.deadline.toISOString()} leaves less than the ${margin} ms a tick and the stop may need`,
      );
    }
    if (records.remainingBytes() < settings.tickRecordReserveBytes) {
      return stop("record_capacity", `${records.remainingBytes()} bytes of record capacity remain; a tick may need ${settings.tickRecordReserveBytes}`);
    }
    const free = await settings.hostFreeMiB();
    if (free < settings.minimumHostFreeMiB) {
      return stop("host_capacity", `the state directory's filesystem has ${free} MiB free; ${settings.minimumHostFreeMiB} MiB are required`);
    }
    // Between ticks nothing is outstanding, but a world that stopped without
    // being asked to invalidates the run's assumptions: that needs review.
    const status = await world.inspect();
    if (status.container !== "running") {
      const reason = status.container === "unknown" ? "engine_lost" : "world_exit";
      throw new Unclean(reason, `the world container is ${status.container} although the run did not stop it`);
    }
    return null;
  }

  async #tick(tick: number, signal: AbortSignal): Promise<TickEnd> {
    const { world, mind, policy, records, ledger, settings } = this.#options;
    const state = this.#state;
    const request = requestId(settings.runId, tick);
    const on = { tick };
    const durable = { tick, durable: true };

    // 2. Observe and assemble the bounded request.
    const sample = await world.sample({ listing: false });
    // The epoch's safety condition, not the sampled job states, decides: once any effect's
    // outcome is uncertain, nothing more is sent or dispatched, and the run ends for review.
    const review = await this.#reviewRequired("observation", tick);
    if (review !== null) return review;
    const base = renderObservation({ tick, elapsedMs: this.#elapsed(), previous: state.previousOutcome, sample, resumed: this.#resumed });
    const appendix = settings.exposeContextUsage
      ? {
          maximumBytes: CONTEXT_APPENDIX_BYTES,
          render: (status: Parameters<typeof renderContextUsage>[0]) =>
            renderContextUsage(status, { first: state.completedTicks === 0, inputTokens: state.previousInputTokens }, state.evictedCount),
        }
      : null;
    let assembly;
    try {
      assembly = policy.assemble({ requestId: request, tick, instructions: settings.instructions, tools: settings.tools, history: state.history, observation: base, appendix });
    } catch (error) {
      if (!(error instanceof ContextOverflowError)) throw error;
      await records.append("observation.sampled", { requestId: request, sample: await records.json(sample), observation: await records.text(base) }, on);
      await records.append("context.assembled", { requestId: request, policy: policy.id, overflow: error.message }, durable);
      await this.#complete(tick, request, { kind: "request_not_sent", reason: "context_overflow" }, null, { observation: base, reply: null, results: [] }, NOT_ATTEMPTED);
      return { clean: true, reason: "context_overflow", detail: error.message };
    }
    const sent = assembly.request;
    const requestSha256 = canonicalSha256(sent);
    try {
      mind.validate(sent);
    } catch (error) {
      await records.append("model.failed", { requestId: request, sent: false, kind: "request_invalid", message: messageOf(error) }, durable);
      await this.#complete(tick, request, { kind: "request_not_sent", reason: "request_invalid" }, null, { observation: sent.observation, reply: null, results: [] }, NOT_ATTEMPTED);
      return { clean: true, reason: "request_invalid", detail: `the request was not sent: ${messageOf(error)}` };
    }
    // A stop requested while observing ends the run here: nothing is reserved, sent, or evicted.
    if (signal.aborted) return this.#operatorStop(signal, "before the model request was sent");

    await records.append("observation.sampled", { requestId: request, sample: await records.json(sample), observation: await records.text(sent.observation) }, on);
    await records.append(
      "context.assembled",
      { requestId: request, policy: policy.id, status: assembly.status, estimatedInputTokens: assembly.estimatedInputTokens, requestSha256 },
      on,
    );
    const evicted = assembly.status.evictedTicks;
    if (evicted.length > 0) await records.append("context.evicted", { requestId: request, ticks: evicted }, on);
    // Evicted exchanges are dropped for good: they are never offered to the mind again.
    this.#state = { ...state, history: state.history.slice(evicted.length), evictedCount: state.evictedCount + evicted.length };

    // 3. Reserve the maximum cost, then record the request, before transport.
    const reservation = ledger.reserve(request, assembly.estimatedInputTokens, settings.maximumOutputTokens);
    if (reservation === null) {
      const detail = `the request's maximum cost does not fit the ${ledger.remainingMicroUsd} micro-USD remaining; it was not sent`;
      await records.append("model.failed", { requestId: request, sent: false, kind: "spend_limit", message: detail }, durable);
      await this.#complete(tick, request, { kind: "request_not_sent", reason: "spend_limit" }, null, { observation: sent.observation, reply: null, results: [] }, NOT_ATTEMPTED);
      return { clean: true, reason: "spend_limit", detail };
    }
    // The shared authority holds the same maximum durably before anything about the request is recorded.
    const { spend } = this.#options;
    if (spend !== undefined) {
      let held: boolean;
      try {
        held = await spend.reserve(request, reservation.microUsd);
      } catch (error) {
        ledger.settle(request, { basis: "not_processed" });
        throw new Unclean("record_failure", `the shared spending reservation could not be made; nothing was sent: ${messageOf(error)}`);
      }
      if (!held) {
        ledger.settle(request, { basis: "not_processed" });
        const detail = `the request's maximum cost of ${reservation.microUsd} micro-USD does not fit what remains of the shared spending campaign; it was not sent`;
        await records.append("model.failed", { requestId: request, sent: false, kind: "spend_limit", message: detail }, durable);
        await this.#complete(tick, request, { kind: "request_not_sent", reason: "spend_limit" }, null, { observation: sent.observation, reply: null, results: [] }, NOT_ATTEMPTED);
        return { clean: true, reason: "spend_limit", detail };
      }
    }
    try {
      // Made durable together with the request record that follows it, before anything is sent.
      await records.append("cost.reserved", { ...reservation, rates: ledger.rates, ...(spend === undefined ? {} : { campaign: spend.identity }) }, on);
      await records.append(
        "model.requested",
        {
          requestId: request,
          adapter: mind.id,
          retainedTicks: assembly.status.retainedTicks,
          estimatedInputTokens: assembly.estimatedInputTokens,
          maximumOutputTokens: sent.maximumOutputTokens,
          requestSha256,
        },
        durable,
      );
      await this.#boundary("after_model_requested");
    } catch (error) {
      // Nothing was sent: this process knows it, so the shared hold is released; the run's own
      // reservation stays unreconciled in its records for review.
      await spend?.settle(request, { basis: "not_processed" }).catch(() => undefined);
      throw error;
    }

    // 4. Invoke once. The decisive checks come after every awaited preparation step and
    // immediately before the invocation, with nothing awaited in between: lost supervision, a
    // stop request, or uncertainty established while the request was recorded, means the call
    // is never made. A rejection is a failure whose processing is unknown.
    const timeout = AbortSignal.timeout(settings.requestTimeoutMs);
    let outcome: MindOutcome | null = null;
    let failure: { kind: FailureKind["failure"] | "review_required" | "supervision_lost"; processed: "no" | "unknown"; message: string; sent: boolean } | null = null;
    const lost = this.#denied();
    const blocked = lost !== null ? "supervision_lost" : signal.aborted ? "operator_stop" : world.safety()?.reviewRequired === true ? "review_required" : null;
    if (blocked === "supervision_lost") {
      failure = { kind: "supervision_lost", processed: "no", message: `the request was not sent: ${lost}`, sent: false };
    } else if (blocked === "operator_stop") {
      failure = { kind: "aborted", processed: "no", message: "the operator stopped the run before the request was sent", sent: false };
    } else if (blocked === "review_required") {
      failure = { kind: "review_required", processed: "no", message: "an earlier effect's outcome became uncertain; the request was not sent", sent: false };
    } else {
      try {
        outcome = await mind.invoke(sent, AbortSignal.any([signal, timeout]));
        if (outcome.outcome === "failed") failure = { ...outcome.failure, sent: true };
      } catch (error) {
        failure = { kind: signal.aborted ? "aborted" : timeout.aborted ? "timeout" : "adapter_error", processed: "unknown", message: messageOf(error), sent: true };
      }
    }
    // Counted at the invocation boundary, before any record or action can fail: a call that was
    // made, and a response that was received, stay counted however the tick ends.
    if (failure === null || failure.sent) this.#countCall(failure === null ? RESPONDED : FAILED_ATTEMPT);
    if (failure !== null || outcome === null || outcome.outcome === "failed") {
      failure ??= { kind: "adapter_error", processed: "unknown", message: "no outcome", sent: true };
      // Made durable, with the reconciliation, by the next durable record: the lifecycle record that
      // ends the run or the next request's, either of which precedes any further effect.
      await records.append(
        "model.failed",
        { requestId: request, sent: failure.sent, kind: failure.kind, processed: failure.processed, message: failure.message },
        on,
      );
      const settlement: Settlement = failure.processed === "no" ? { basis: "not_processed" } : { basis: "unknown" };
      await records.append("cost.reconciled", { requestId: request, basis: settlement.basis, chargedMicroUsd: ledger.settle(request, settlement) }, on);
      await this.#settleShared(request, settlement.basis === "not_processed" ? { basis: "not_processed" } : { basis: "unknown" });
      // A call withdrawn before invocation is not an attempt; one that was made and failed is.
      const outcome: OperationalOutcome =
        failure.kind === "review_required" || failure.kind === "supervision_lost"
          ? { kind: "request_not_sent", reason: "review_required" }
          : failure.sent
            ? { kind: "model_failed", failure: failure.kind }
            : { kind: "request_not_sent", reason: "operator_stop" };
      await this.#complete(tick, request, outcome, null, { observation: sent.observation, reply: null, results: [] }, failure.sent ? FAILED_ATTEMPT : NOT_ATTEMPTED);
      if (failure.kind === "supervision_lost") return { clean: false, reason: SUPERVISION_LOST, detail: failure.message };
      if (failure.kind === "review_required") return this.#endForReview(world.safety()!, "before_request", tick);
      return failure.kind === "aborted"
        ? this.#operatorStop(signal, failure.sent ? "during the model request" : "before the model request was sent")
        : { clean: true, reason: "provider_failure", detail: `the model request failed (${failure.kind}, processed: ${failure.processed}): ${failure.message}` };
    }
    const { response } = outcome;
    // The mind responded to the observation: jobs it reported finished release their slots before this
    // tick's dispatch. A failed or unsent request acknowledges nothing.
    world.acknowledgeJobs(finishedJobs(sample));
    await records.append(
      "model.responded",
      {
        requestId: request,
        providerRequestId: response.providerRequestId,
        status: response.status,
        reply: await records.json(response.reply),
        usage: response.usage,
        latencyMs: response.latencyMs,
        ...(response.inputTransformations === undefined ? {} : { inputTransformations: response.inputTransformations }),
      },
      // Made durable, with the reconciliation, by the next durable record, which precedes anything the
      // reply asks for: the pre-dispatch record of a command, or the next request.
      on,
    );
    const settlement: Settlement =
      response.usage === null ? { basis: "unknown" } : { basis: "usage", inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens };
    const charged = ledger.settle(request, settlement);
    await records.append("cost.reconciled", { requestId: request, basis: settlement.basis, chargedMicroUsd: charged }, on);
    await this.#settleShared(request, settlement.basis === "usage" ? { basis: "usage", chargedMicroUsd: charged } : { basis: "unknown" });
    await this.#boundary("after_model_responded");

    // 5. Zero or one intention.
    const decision = interpretResponse(response, { maximumCommandBytes: settings.maximumCommandBytes });
    const calls = response.reply.toolCalls;
    let result: OperationalOutcome;
    let results: ToolResult[];
    let uncertain: ExecutionSafetySnapshot | null = null;
    let lostDuringDispatch: string | null = null;
    if (decision.kind === "invalid") {
      await records.append("intention.rejected", { requestId: request, reason: decision.reason, detail: decision.detail, calls: calls.length }, on);
      result = { kind: "invalid", reason: decision.reason, detail: decision.detail };
      results = calls.map((call) => ({ callId: call.callId, output: renderNotExecuted(decision.detail) }));
    } else if (decision.kind === "no_action") {
      await records.append("intention.accepted", { requestId: request, decision: "no_action", reason: decision.reason }, on);
      result = { kind: "no_action", reason: decision.reason };
      // A refusal can arrive with calls; each still gets a result, so none is orphaned.
      results = calls.map((call) => ({ callId: call.callId, output: renderNotExecuted(`the reply was a ${decision.reason === "refusal" ? "refusal" : "reply without an accepted call"}`) }));
    } else if (decision.intention.kind === "wait") {
      await records.append("intention.accepted", { requestId: request, decision: "wait", callId: decision.callId }, on);
      result = { kind: "wait" };
      results = [{ callId: decision.callId, output: WAIT_RESULT }];
    } else {
      const { command } = decision.intention;
      await records.append("intention.accepted", { requestId: request, decision: "shell", callId: decision.callId, command: await records.text(command) }, on);
      // 6–7. Prepared durably before dispatch, then the bounded wait.
      const dispatched = await this.#dispatch(tick, decision.callId, command, signal);
      result = dispatched.outcome;
      results = [{ callId: decision.callId, output: dispatched.result }];
      uncertain = dispatched.uncertain ?? null;
      lostDuringDispatch = dispatched.lost ?? null;
    }

    // 8. The tick is complete; the exchange joins the active history.
    await this.#complete(tick, request, result, response.usage?.inputTokens ?? null, { observation: sent.observation, reply: response.reply, results }, RESPONDED);
    // Refused because the epoch requires review: the affected earlier jobs are recorded, not this command.
    if (uncertain !== null) return this.#endForReview(uncertain, "dispatch", tick);
    const lostNow = lostDuringDispatch ?? this.#denied();
    if (lostNow !== null) return { clean: false, reason: SUPERVISION_LOST, detail: lostNow };
    if (result.kind === "not_dispatched" && signal.aborted) return this.#operatorStop(signal, "before the action was dispatched");
    // Whether this command ran, or an earlier job's outcome, became unknown during the tick:
    // nothing more is scheduled, and the run needs review (plan §11.4).
    const afterDispatch = await this.#reviewRequired("dispatch", tick);
    if (afterDispatch !== null) return afterDispatch;
    const streak = this.#state.protocolErrorStreak;
    if (streak >= settings.maximumConsecutiveProtocolErrors) {
      return { clean: true, reason: "protocol_error_threshold", detail: `${streak} consecutive replies executed nothing because they were invalid` };
    }
    return null;
  }

  async #dispatch(
    tick: number,
    callId: string,
    command: string,
    signal: AbortSignal,
  ): Promise<{ result: string; outcome: OperationalOutcome; uncertain?: ExecutionSafetySnapshot; lost?: string }> {
    const { world, records, clock, settings } = this.#options;
    const action = actionId(settings.runId, tick);
    const on = { tick };
    const durable = { tick, durable: true };
    let prepared = false;
    let hookError: unknown = null;
    const hooks: DispatchHooks = {
      // Lost supervision or a stop requested while the records were written withdraws the dispatch at the last moment.
      proceed: () => this.#denied() === null && !signal.aborted,
      prepared: async (identity) => {
        try {
          await records.append("action.prepared", { actionId: action, callId, command: await records.text(command), ...identity }, durable);
          prepared = true;
        } catch (error) {
          hookError = error;
          throw error;
        }
        await this.#boundary("after_action_prepared");
      },
      ...(this.#options.boundary === undefined ? {} : { committed: () => this.#boundary("after_action_commit") }),
    };
    const refused = async (reason: string, detail: string) => {
      await records.append("action.refused", { actionId: action, reason, prepared, detail }, durable);
      return { result: renderNotExecuted(detail), outcome: { kind: "not_dispatched", detail } as const };
    };

    // Supervision lost or a stop requested while the reply was recorded: this new command is not started.
    const lost = this.#denied();
    if (lost !== null) return { ...(await refused("supervision_lost", `the command was not dispatched: ${lost}`)), lost };
    if (signal.aborted) return refused("operator_stop", "the operator stopped the run before this command was dispatched");

    const started = clock.monotonicMs();
    let job: JobSnapshot;
    try {
      job = await world.submit({ actionId: action, command }, hooks);
    } catch (error) {
      if (hookError !== null) {
        // The command was not started, but the record of that may be incomplete.
        throw hookError instanceof RecordCapacityError
          ? hookError
          : new Unclean("record_failure", `recording ${action} before dispatch failed: ${messageOf(hookError)}`);
      }
      if (error instanceof JobAdmissionError) return refused("admission", error.message);
      // Found uncertain while refreshing before this dispatch: this command never started, and the run ends for review.
      if (error instanceof UncertainJobsError) {
        return { ...(await refused("uncertain_jobs", error.message)), uncertain: world.safety() ?? denialSnapshot(error) };
      }
      if (error instanceof DispatchRefusedError) {
        const denied = this.#denied();
        if (denied !== null) return { ...(await refused("supervision_lost", `the command was not started: ${denied}`)), lost: denied };
        return signal.aborted
          ? refused("operator_stop", "the operator stopped the run before this command was started")
          : refused("refused", error.message);
      }
      // Before the pre-dispatch record nothing can have started; after it, the outcome is unknown.
      if (!prepared) return refused("error", `the world could not dispatch it: ${messageOf(error)}`);
      throw new Unclean("uncertain_action", `${action} was prepared, and then dispatch failed without an outcome: ${messageOf(error)}`);
    }

    const waitedMs = clock.monotonicMs() - started;
    const result = renderActionResult(job, waitedMs, settings.perceivedOutputBytes);
    const type = job.state === "exited" ? "action.completed" : job.state === "running" ? "action.running" : "action.uncertain";
    // Durable with the tick's completion record, which follows it before anything else happens.
    await records.append(
      type,
      {
        actionId: action,
        jobId: job.jobId,
        execId: job.execId,
        state: job.state,
        exitCode: job.exitCode,
        rootPid: job.rootPid,
        output: job.output,
        stdoutBytes: job.stdout.totalBytes,
        stderrBytes: job.stderr.totalBytes,
        detail: job.detail,
        waitedMs,
        result: await records.text(result),
      },
      on,
    );
    if (type === "action.uncertain") this.#uncertainty.markRecorded(action);
    return { result, outcome: { kind: "shell", jobId: job.jobId, state: job.state, exitCode: job.exitCode } };
  }

  /** Mirrors a settlement to the shared authority; if it cannot be recorded there, the run ends for review. */
  async #settleShared(request: string, settlement: SpendSettlement): Promise<void> {
    const { spend } = this.#options;
    if (spend === undefined) return;
    try {
      await spend.settle(request, settlement);
    } catch (error) {
      throw new Unclean("record_failure", `the shared spending settlement of ${request} could not be recorded: ${messageOf(error)}`);
    }
  }

  #countCall(call: CallAccounting): void {
    const state = this.#state;
    this.#state = {
      ...state,
      attemptedCalls: state.attemptedCalls + (call.attempted ? 1 : 0),
      respondedCalls: state.respondedCalls + (call.responded ? 1 : 0),
    };
  }

  async #complete(
    tick: number,
    request: string,
    outcome: OperationalOutcome,
    inputTokens: number | null,
    exchange: { observation: string; reply: MindReply | null; results: ToolResult[] },
    call: CallAccounting,
  ): Promise<void> {
    const state = this.#state;
    const streak = outcome.kind === "invalid" ? state.protocolErrorStreak + 1 : 0;
    // The counts already include this tick's call (see `#countCall`); `call` says what this tick did.
    const { attemptedCalls, respondedCalls } = state;
    // Made durable by the next tick's request record, or by the lifecycle record that ends the run,
    // before anything further happens in the world or at the provider.
    await this.#options.records.append(
      "tick.completed",
      { requestId: request, outcome, ...call, attemptedCalls, respondedCalls, protocolErrorStreak: streak },
      { tick },
    );
    // A failed request has no reply, so there is no exchange to remember.
    const history = exchange.reply === null ? state.history : [...state.history, { tick, observation: exchange.observation, reply: exchange.reply, results: exchange.results }];
    this.#state = {
      ...state,
      completedTicks: tick,
      history,
      previousOutcome: outcome,
      previousInputTokens: inputTokens,
      protocolErrorStreak: streak,
    };
    this.#resumed = false;
    this.#options.onTick?.({ tick, outcome });
  }
}
