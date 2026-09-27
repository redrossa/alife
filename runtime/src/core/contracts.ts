// Interfaces between world, body, and mind (plan §8.1). These types are
// provider- and Docker-independent: adapters translate to and from them, and
// no SDK type may appear here.

import type { EventType } from "../records/events.ts";
import type { ExecutionSafetySnapshot, StopSafetyAssessment } from "./execution-safety.ts";
import type { RunState, StopReason } from "./state.ts";

// ---------------------------------------------------------------------------
// Intentions and decisions

/** The only effects a mind can request (body profile `shell-body-v5`). */
export type Intention = { readonly kind: "shell"; readonly command: string } | { readonly kind: "wait" };

export type NoActionReason = "text" | "refusal" | "empty";

export type InvalidReason =
  | "multiple_actions"
  | "unknown_tool"
  | "invalid_arguments"
  | "command_too_large"
  | "incomplete_response";

/**
 * The harness's reading of one model response. Invalid decisions execute
 * nothing and become a protocol observation on the next tick.
 */
export type Decision =
  | { readonly kind: "action"; readonly callId: string; readonly intention: Intention }
  | { readonly kind: "no_action"; readonly reason: NoActionReason }
  | { readonly kind: "invalid"; readonly reason: InvalidReason; readonly detail: string };

// ---------------------------------------------------------------------------
// Mind

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments object. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  /** Raw JSON text as returned; parsing is the harness's job, not the adapter's. */
  readonly arguments: string;
}

export interface ToolResult {
  readonly callId: string;
  readonly output: string;
}

/** Public model output. Private reasoning is never required or claimed. */
export interface MindReply {
  readonly text: string | null;
  readonly refusal: string | null;
  readonly toolCalls: readonly ToolCall[];
  /**
   * Provider state the reply carries back while its exchange is retained (a
   * named, versioned profile, such as `anthropic-thinking-v1`). Plain data:
   * the core sizes, records, and evicts it with the exchange but never reads it.
   */
  readonly continuation?: Continuation;
}

/** Continuation profiles (config/profiles.ts `CONTINUATION_PROFILES`); each names fixed provider state. */
export type ContinuationProfile = "anthropic-thinking-v1";

export interface Continuation {
  readonly profile: ContinuationProfile;
  /** Opaque serialized provider content, sent back unchanged. */
  readonly data: string;
  /** Upper bound on the input tokens the provider may count for state `data` restores (such as encrypted reasoning). */
  readonly inputTokenBound: number;
}

/** A change the provider reports having made to the submitted input (such as dropping invalidated reasoning). Observer evidence only. */
export interface InputTransformation {
  readonly type: string;
  readonly path: string;
  readonly reason: string;
}

/**
 * One complete prior tick as the mind saw it: the observation delivered, the
 * reply, and a result for every tool call in that reply. Context eviction
 * removes whole exchanges so calls and results are never orphaned.
 */
export interface Exchange {
  readonly tick: number;
  readonly observation: string;
  readonly reply: MindReply;
  readonly results: readonly ToolResult[];
}

/**
 * The complete bounded input for one invocation. Nothing else reaches the
 * provider: no server-side conversation, stored response, or retrieved memory.
 */
export interface MindRequest {
  readonly requestId: string;
  readonly tick: number;
  readonly instructions: string;
  readonly tools: readonly ToolDefinition[];
  /** Oldest first. */
  readonly history: readonly Exchange[];
  readonly observation: string;
  readonly maximumOutputTokens: number;
}

export type MindStatus = "completed" | "incomplete" | "refused";

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Every numeric usage field the provider reported, unmodified. */
  readonly reported: Readonly<Record<string, number>>;
}

export interface MindResponse {
  readonly providerRequestId: string | null;
  readonly status: MindStatus;
  readonly reply: MindReply;
  readonly usage: Usage | null;
  readonly latencyMs: number;
  /** What the provider reports having changed in the submitted input; recorded, never shown to the mind. */
  readonly inputTransformations?: readonly InputTransformation[];
}

export type MindFailureKind =
  | "connection"
  | "timeout"
  | "rate_limited"
  | "authentication"
  | "server"
  | "invalid_response"
  | "unavailable"
  /** The caller's signal ended the call (before sending: processed "no"; after: "unknown"). */
  | "aborted";

export interface MindFailure {
  readonly kind: MindFailureKind;
  /**
   * Whether the provider may have processed (and billed) the request. Only
   * the mind side is uncertain here; the world is untouched either way.
   */
  readonly processed: "no" | "unknown";
  readonly message: string;
}

export type MindOutcome =
  | { readonly outcome: "responded"; readonly response: MindResponse }
  | { readonly outcome: "failed"; readonly failure: MindFailure };

export interface MindCapabilities {
  readonly toolCalls: true;
  readonly reportsUsage: boolean;
  readonly maximumOutputTokens: number;
}

export interface MindAdapter {
  /** Versioned adapter identity recorded in the manifest, e.g. `fake-v1`. */
  readonly id: string;
  readonly capabilities: MindCapabilities;
  /** Throws if the request violates the adapter's invariants; sends nothing. */
  validate(request: MindRequest): void;
  /** Exactly one provider request, no retries, no follow-up turns. */
  invoke(request: MindRequest, signal: AbortSignal): Promise<MindOutcome>;
}

// ---------------------------------------------------------------------------
// World

export type Metric<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false; readonly reason: string };

export interface StorageMetrics {
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly totalInodes: number;
  readonly availableInodes: number;
}

export interface ListingEntry {
  /** Raw name bytes, base64: world file names need not be valid UTF-8. */
  readonly nameBase64: string;
  /** The name when it is valid UTF-8; still untrusted and must be escaped for terminals. */
  readonly name: string | null;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly sizeBytes: number | null;
}

/**
 * Lifecycle of one shell action under `continuing-jobs-v4` (plan §8.3).
 *
 * - `unconfirmed`: dispatched, but the engine has not yet reported the root process running or exited
 *   (including when the start request got no answer). Still inspected.
 * - `running`: the root process is running. Waiting expired; nothing was terminated.
 * - `exited`: the root process exited with `exitCode`. Descendants may still run.
 * - `uncertain`: the engine no longer knows the execution, so its state cannot be established.
 *   Never redispatched; it keeps its admission slot until the world stops.
 * - `ended_with_world`: the world stopped before the root was seen to exit.
 */
export type JobState = "unconfirmed" | "running" | "exited" | "uncertain" | "ended_with_world";

/**
 * Collection of a job's output. `complete` requires end-of-file; a stream that
 * closed early or failed is `failed`. `closed_after_exit` means descendants
 * held the stream after the root exited and later output was not collected.
 */
export type OutputState = "open" | "complete" | "closed_after_exit" | "failed";

export interface StreamRecord {
  /** Retained bytes under the output-truncation profile (for `head-v1`, the first bytes). */
  readonly retained: Uint8Array;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export interface JobSnapshot {
  /** Stable identity; equal to the action ID that created it. */
  readonly jobId: string;
  /** Engine execution identity, for inspection only; never used to rerun a command. */
  readonly execId: string;
  readonly state: JobState;
  /** Raw status; a signal death appears as 128 + n and is not distinguishable from exit(128 + n). */
  readonly exitCode: number | null;
  /** In-world PID of the root shell, which is also its process group and session ID. */
  readonly rootPid: number | null;
  readonly startedAt: string;
  /** When the harness first saw the root exited: an upper bound on the exit time. */
  readonly exitObservedAt: string | null;
  /** When this snapshot's state was last established. */
  readonly observedAt: string;
  readonly stdout: StreamRecord;
  readonly stderr: StreamRecord;
  readonly output: OutputState;
  readonly detail: string | null;
  /** Set while the latest inspection failed: `state` is then the last one established, at `observedAt`. */
  readonly inspectionFailure: string | null;
}

export interface JobSummary {
  readonly jobId: string;
  readonly state: JobState;
  readonly exitCode: number | null;
  readonly rootPid: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly output: OutputState;
  /** When `state` was last established. */
  readonly observedAt: string;
  readonly inspectionFailure: string | null;
}

export interface WorldSample {
  readonly sampledAt: string;
  readonly sensorProfile: string;
  /** Sensor overhead: how long this sample took. */
  readonly durationMs: number;
  readonly storage: Metric<StorageMetrics>;
  readonly memory: Metric<{ readonly usageBytes: number; readonly limitBytes: number }>;
  readonly processes: Metric<{ readonly count: number; readonly limit: number }>;
  /** Jobs the harness tracks, oldest first; finished jobs beyond the retention bound are gone. */
  readonly jobs: readonly JobSummary[];
  /** Only sampled at initial start and clean resume; never implied to be current. */
  readonly listing: Metric<{ readonly entries: readonly ListingEntry[]; readonly truncated: boolean }> | null;
}

/**
 * The harness's account of what one tick did, reported to the mind as the
 * previous operational outcome in the next observation. Error information,
 * not feedback on the quality of what was done.
 */
export type OperationalOutcome =
  | { readonly kind: "shell"; readonly jobId: string; readonly state: JobState; readonly exitCode: number | null }
  | { readonly kind: "not_dispatched"; readonly detail: string }
  | { readonly kind: "wait" }
  | { readonly kind: "no_action"; readonly reason: NoActionReason }
  | { readonly kind: "invalid"; readonly reason: InvalidReason; readonly detail: string }
  /** A model call was attempted and failed (an infrastructure failure, not the agent's choice). */
  | { readonly kind: "model_failed"; readonly failure: MindFailureKind | "aborted" | "adapter_error" }
  /** No model call was made: the request was refused or withdrawn before invocation. */
  | { readonly kind: "request_not_sent"; readonly reason: "operator_stop" | "spend_limit" | "request_invalid" | "context_overflow" | "review_required" };

export interface ActionRequest {
  readonly actionId: string;
  readonly command: string;
}

export interface DispatchIdentity {
  readonly jobId: string;
  readonly execId: string;
  readonly containerId: string;
}

export interface DispatchHooks {
  /**
   * Called after the execution is created and before it can start. It must
   * record the identity durably; if it throws, the command is never started.
   */
  prepared(identity: DispatchIdentity): Promise<void>;
  /**
   * Asked immediately before the start request, with nothing awaited in
   * between: false withdraws the dispatch, and the command is never started.
   */
  proceed?(): boolean;
  /**
   * Awaited once the start request has been issued (the commitment point),
   * before its outcome is known or recorded. Instrumentation only.
   */
  committed?(): Promise<void>;
}

/** How a controller takes part in starting a world's execution epoch. */
export interface StartHooks {
  /**
   * Awaited after the engine created the epoch's container, with its exact ID,
   * and before the container is started or anything runs in it. A rejection
   * refuses the start; the unstarted container is stopped and removed.
   */
  beforeContainerStart(containerId: string, epochId: string): Promise<void>;
  /**
   * Asked immediately before the container start request, with nothing awaited
   * in between: a reason refuses the start, null admits it.
   */
  admit(): string | null;
}

export type JobSignal = "TERM" | "KILL" | "INT" | "HUP";

export interface SignalResult {
  readonly jobId: string;
  readonly signal: JobSignal;
  /** True only when the signal was sent to the job's process group. */
  readonly delivered: boolean;
  /** Descendants that left the process group are never covered. */
  readonly scope: "process_group";
  readonly detail: string;
}

export interface WorldIdentity {
  readonly worldId: string;
  readonly dockerContext: string;
  readonly engineId: string;
  readonly storageProfile: string;
  /** Backend-specific storage identity, such as an ext4 filesystem UUID. */
  readonly storageIdentity: string;
  readonly image: string;
}

export interface WorldStatus {
  readonly identity: WorldIdentity;
  readonly container: "absent" | "running" | "stopped" | "unknown";
  /** Whether storage is attached with the recorded identity; null when that could not be established. */
  readonly storageAttached: boolean | null;
}

export interface WorldStopResult {
  /** The world's processes are verified to have ended. */
  readonly verified: boolean;
  /**
   * False when a record of the stop could not be written. A failed record never
   * prevents the stop itself, but the stop's evidence is then incomplete.
   */
  readonly recorded: boolean;
  readonly detail: string;
  /**
   * The execution epoch's safety assessment, required on every result: sealed
   * only after a verified stop and its processing. Physical shutdown can be
   * verified while execution outcomes remain uncertain; both facts are kept.
   */
  readonly safety: StopSafetyAssessment;
}

export interface ArchiveResult {
  readonly archiveId: string;
  readonly complete: boolean;
  readonly entries: number;
  readonly bytes: number;
  readonly omissions: readonly string[];
}

export interface WorldBackend {
  /** Confirms engine, storage, and profile match the recorded identity. Never repairs. */
  verify(): Promise<WorldIdentity>;
  /** Attaches existing storage; never creates, reformats, or reseeds it. */
  attach(): Promise<void>;
  start(hooks?: StartHooks): Promise<void>;
  sample(options: { readonly listing: boolean }): Promise<WorldSample>;
  /**
   * Dispatches one command at most once and waits at most the configured
   * action wait. Rejects before dispatch when the job admission bound is full.
   */
  submit(request: ActionRequest, hooks: DispatchHooks): Promise<JobSnapshot>;
  /**
   * Called once the mind has responded to an observation reporting these
   * jobs finished; only then do they release their admission slots.
   */
  acknowledgeJobs(jobIds: readonly string[]): void;
  /** The execution epoch's safety condition, synchronously and without I/O; null before any start. */
  safety(): ExecutionSafetySnapshot | null;
  /** Inspects tracked jobs so that uncertainty the engine now shows is latched. Detection only, never a certificate. */
  refreshJobSafety(): Promise<void>;
  /** Refreshes a tracked job from the engine; never reruns it. */
  inspectJob(jobId: string): Promise<JobSnapshot>;
  jobs(): Promise<readonly JobSnapshot[]>;
  signalJob(jobId: string, signal: JobSignal, requestedBy: "agent" | "operator"): Promise<SignalResult>;
  stop(reason: StopReason): Promise<WorldStopResult>;
  inspect(): Promise<WorldStatus>;
  /**
   * Requires a verified stopped world; never stops a live one implicitly.
   * `limits` can only tighten the capture profile's bounds.
   */
  captureArtifacts(label: string, limits?: { readonly maximumBytes: number; readonly maximumEntries: number; readonly timeoutMs: number }): Promise<ArchiveResult>;
}

// ---------------------------------------------------------------------------
// Context

/** What one assembly kept and dropped, for records and the context-usage sensor. */
export interface ContextStatus {
  readonly budgetTokens: number;
  readonly maximumOutputTokens: number;
  readonly marginTokens: number;
  readonly estimator: string;
  /**
   * Upper bound on the request's input tokens by the estimator, computed with
   * the appendix at its maximum size; the final request is at most this.
   */
  readonly estimatedInputTokens: number;
  /** Ticks of the prior exchanges included, oldest first. */
  readonly retainedTicks: readonly number[];
  /** Ticks of candidate exchanges this assembly dropped, oldest first. */
  readonly evictedTicks: readonly number[];
}

export interface ContextAppendix {
  /** Reserved before history is chosen, so what the appendix reports cannot change what fits. */
  readonly maximumBytes: number;
  render(status: ContextStatus): string;
}

export interface ContextInput {
  readonly requestId: string;
  readonly tick: number;
  readonly instructions: string;
  readonly tools: readonly ToolDefinition[];
  /** Candidate prior exchanges, oldest first. */
  readonly history: readonly Exchange[];
  readonly observation: string;
  /** Text appended to the observation that describes this assembly (the context-usage sensor), if exposed. */
  readonly appendix: ContextAppendix | null;
}

export interface ContextAssembly {
  readonly request: MindRequest;
  readonly status: ContextStatus;
  /** The estimator's count for the final request. */
  readonly estimatedInputTokens: number;
}

export interface ContextPolicy {
  /** Versioned identity recorded in the manifest, e.g. `recent-complete-exchanges-v2`. */
  readonly id: string;
  /** Deterministic; throws `ContextOverflowError` if even the request without history cannot fit. */
  assemble(input: ContextInput): ContextAssembly;
}

// ---------------------------------------------------------------------------
// Records and control

export interface AppendOptions {
  readonly tick?: number;
  /** Flush to stable storage before returning. Required before external effects. */
  readonly durable?: boolean;
}

/** Observer record. It is never read back into a mind's context. */
export interface EventStore {
  append(type: EventType, data: Readonly<Record<string, unknown>>, options?: AppendOptions): Promise<number>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface RunStatus {
  readonly runId: string;
  readonly state: RunState;
  readonly completedTicks: number;
  readonly stopReason: StopReason | null;
}

export interface RunController {
  run(signal: AbortSignal): Promise<RunStatus>;
  status(): RunStatus;
}
