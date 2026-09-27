import type {
  ContextStatus,
  JobSnapshot,
  JobState,
  JobSummary,
  Metric,
  OperationalOutcome,
  OutputState,
  StreamRecord,
  WorldSample,
} from "./contracts.ts";

// What the mind perceives each tick (sensor profile `baseline-sensors-v4`,
// body profile `shell-body-v5`, output truncation `head-v1`). The exact text
// is part of the experimental conditions: change it by adding a profile
// version, not by editing this one. Every section has a computable upper
// bound on its size, so configurations can be checked against the context
// budget before anything runs.

/** Harness and engine detail strings are clipped to this many bytes. */
export const DETAIL_BYTES = 512;
/** Space reserved for the context-usage sensor in every observation where it is exposed. */
export const CONTEXT_APPENDIX_BYTES = 768;
/** Job IDs are action IDs; this bounds their length for size calculations. */
const JOB_ID_BYTES = 64;

/** Truncates to at most `limit` UTF-8 bytes without splitting a character, marking the cut. */
export function clip(text: string, limit = DETAIL_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const marker = "…";
  let out = "";
  let bytes = Buffer.byteLength(marker, "utf8");
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > limit) break;
    out += char;
    bytes += size;
  }
  return out + marker;
}

/**
 * What the mind perceives of a stream under `head-v1`: the first bytes,
 * decoded. Invalid UTF-8 becomes U+FFFD (up to three bytes per byte shown);
 * records keep the raw bytes.
 */
export function perceiveHead(stream: StreamRecord, perceivedOutputBytes: number): { readonly text: string; readonly shownBytes: number; readonly truncated: boolean } {
  const share = Math.floor(perceivedOutputBytes / 2);
  const shown = stream.retained.subarray(0, share);
  return {
    text: new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(shown),
    shownBytes: shown.length,
    truncated: stream.totalBytes > shown.length,
  };
}

// ---------------------------------------------------------------------------
// Observation

export interface ObservationInput {
  readonly tick: number;
  readonly elapsedMs: number;
  /** Null on the first tick of a run. */
  readonly previous: OperationalOutcome | null;
  readonly sample: WorldSample;
  /**
   * The first tick after a clean resume (`resume-discontinuity-v1`): the
   * previous outcome belongs to the stopped process epoch, so the restart is
   * disclosed instead of presenting that outcome as current.
   */
  readonly resumed?: boolean;
}

/** The disclosure `resume-discontinuity-v1` puts in place of the previous outcome on the first tick after a resume. */
export const RESUME_DISCLOSURE =
  "Execution resumed: the run was stopped, every process in the world ended, and the world was restarted as a new " +
  "process epoch. Jobs from before the stop no longer exist; earlier exchanges describe the world as it was before the stop.\n";

function seconds(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 1000))} s`;
}

function exitPhrase(state: JobState, exitCode: number | null): string {
  switch (state) {
    case "exited":
      return exitCode === null ? "exited (status unknown)" : `exited with status ${exitCode}`;
    case "running":
      return "running";
    case "unconfirmed":
      return "not yet confirmed started by the engine";
    case "uncertain":
      return "state unknown (the engine no longer knows it)";
    case "ended_with_world":
      return "ended when the world stopped";
  }
}

export function renderOutcome(outcome: OperationalOutcome | null): string {
  if (outcome === null) return "none; this is the first tick of this run";
  switch (outcome.kind) {
    case "shell":
      switch (outcome.state) {
        case "exited":
          return `your shell command ${exitPhrase(outcome.state, outcome.exitCode)}`;
        case "running":
          return `your shell command was still running as job ${outcome.jobId} when the wait ended; it was not stopped`;
        case "unconfirmed":
          return `your shell command was dispatched as job ${outcome.jobId}, but the engine had not confirmed that it started when the wait ended`;
        case "uncertain":
        case "ended_with_world":
          return `your shell command was dispatched as job ${outcome.jobId}; its state could not be established`;
      }
      break;
    case "not_dispatched":
      return `your shell command was not run: ${clip(outcome.detail)}`;
    case "wait":
      return "no action (wait)";
    case "no_action":
      return outcome.reason === "text"
        ? "no action (a reply without a tool call)"
        : outcome.reason === "refusal"
          ? "no action (a refusal)"
          : "no action (an empty reply)";
    case "invalid":
      return `nothing was executed: ${clip(outcome.detail)}`;
    case "model_failed":
      return `the model request failed (${outcome.failure}); nothing was executed`;
    case "request_not_sent":
      return `no model request was sent (${outcome.reason}); nothing was executed`;
  }
}

function metricLine<T>(label: string, metric: Metric<T>, render: (value: T) => string): string {
  return `  ${label}: ${metric.available ? render(metric.value) : `unavailable (${clip(metric.reason)})`}\n`;
}

function outputPhrase(output: OutputState): string {
  switch (output) {
    case "open":
      return "being collected";
    case "complete":
      return "complete";
    case "closed_after_exit":
      return "closed after exit, later output not collected";
    case "failed":
      return "collection failed";
  }
}

/** Says when a state could not be refreshed, so a stale state is never presented as current. */
function staleness(job: { readonly observedAt: string; readonly inspectionFailure: string | null }): string {
  return job.inspectionFailure === null ? "" : ` as of ${job.observedAt} (the latest inspection failed: ${clip(job.inspectionFailure, 256)})`;
}

export function renderJobLine(job: JobSummary): string {
  const process = job.rootPid === null ? "process unknown" : `process ${job.rootPid}`;
  return (
    `  ${job.jobId}: ${exitPhrase(job.state, job.exitCode)}${staleness(job)}, ${process}; ` +
    `output ${outputPhrase(job.output)}: stdout ${job.stdoutBytes} bytes, stderr ${job.stderrBytes} bytes\n`
  );
}

function renderWorld(sample: WorldSample): string {
  return (
    "World:\n" +
    metricLine("/world storage", sample.storage, (s) => `${s.availableBytes} of ${s.totalBytes} bytes available, ${s.availableInodes} of ${s.totalInodes} inodes available`) +
    metricLine("memory", sample.memory, (m) => `${m.usageBytes} of ${m.limitBytes} bytes in use`) +
    metricLine("processes", sample.processes, (p) => `${p.count} of ${p.limit}`)
  );
}

function renderJobs(jobs: readonly JobSummary[]): string {
  if (jobs.length === 0) return "Jobs: none tracked\n";
  return `Jobs (${jobs.length} tracked, oldest first):\n${jobs.map(renderJobLine).join("")}`;
}

/**
 * The observation without the context-usage sensor, which the context policy
 * appends. There is no directory listing: the agent inspects the filesystem
 * with its own actions (operator decision, Phase 3).
 */
export function renderObservation(input: ObservationInput): string {
  return (
    `Tick ${input.tick}. This run has been running for ${seconds(input.elapsedMs)}.\n` +
    (input.resumed === true ? RESUME_DISCLOSURE : `Previous outcome: ${renderOutcome(input.previous)}.\n`) +
    renderWorld(input.sample) +
    renderJobs(input.sample.jobs)
  );
}

export interface PreviousUsage {
  /** No previous request in this run, or its usage was not reported. */
  readonly inputTokens: number | null;
  readonly first: boolean;
}

function range(ticks: readonly number[]): string {
  return ticks.length === 1 ? `tick ${ticks[0]}` : `ticks ${ticks[0]}–${ticks.at(-1)}`;
}

/**
 * The context-usage sensor. It distinguishes the estimated upper bound for
 * this request from the provider's count for the previous one, and says which
 * exchanges are no longer included.
 */
export function renderContextUsage(status: ContextStatus, previous: PreviousUsage, evictedBefore: number): string {
  const usage = previous.first
    ? "There was no previous request in this run."
    : previous.inputTokens === null
      ? "The previous request's usage was not reported."
      : `The previous request used ${previous.inputTokens} input tokens as reported.`;
  const retained = status.retainedTicks.length === 0 ? "none of your earlier exchanges" : `your exchanges from ${range(status.retainedTicks)}`;
  const dropped = evictedBefore + status.evictedTicks.length;
  const eviction =
    dropped === 0
      ? ""
      : ` ${dropped} earlier exchange${dropped === 1 ? " is" : "s are"} no longer included` +
        (status.evictedTicks.length === 0 ? "." : `; ${range(status.evictedTicks)} ${status.evictedTicks.length === 1 ? "was" : "were"} dropped for this request.`);
  return (
    `Context: this request is estimated at no more than ${status.estimatedInputTokens} input tokens (${status.estimator}, an overestimate); ` +
    `the budget is ${status.budgetTokens} tokens including ${status.maximumOutputTokens} for your reply. ${usage}\n` +
    `This request includes ${retained}.${eviction}\n`
  );
}

// ---------------------------------------------------------------------------
// Tool results

export function renderNotExecuted(detail: string): string {
  return `Not executed: ${clip(detail)}\n`;
}

export const WAIT_RESULT = "No action was taken.\n";

function streamSection(name: string, stream: StreamRecord, perceivedOutputBytes: number, open: boolean): string {
  const head = perceiveHead(stream, perceivedOutputBytes);
  const sofar = open ? " so far" : "";
  if (stream.totalBytes === 0) return `${name}${sofar}: 0 bytes\n`;
  const shown = head.truncated ? `; the first ${head.shownBytes} are shown` : "";
  return `${name}${sofar}: ${stream.totalBytes} bytes${shown}\n${head.text}${head.text.endsWith("\n") ? "" : "\n"}`;
}

/** The result of a dispatched shell action, as returned for its call. */
export function renderActionResult(job: JobSnapshot, waitedMs: number, perceivedOutputBytes: number): string {
  const state =
    job.state === "running"
      ? `still running after ${seconds(waitedMs)} of waiting; it was not stopped, and later observations report its status`
      : exitPhrase(job.state, job.exitCode);
  const detail = job.detail === null ? "" : `detail: ${clip(job.detail)}\n`;
  const process = job.rootPid === null ? "unknown" : `${job.rootPid} (also its process group)`;
  const open = job.output === "open";
  return (
    `job: ${job.jobId}\n` +
    `state: ${state}${staleness(job)}\n` +
    `process: ${process}\n` +
    detail +
    `output: ${outputPhrase(job.output)}\n` +
    streamSection("stdout", job.stdout, perceivedOutputBytes, open) +
    streamSection("stderr", job.stderr, perceivedOutputBytes, open)
  );
}

// ---------------------------------------------------------------------------
// Size bounds, computed by rendering each section at its largest

export interface ObservationLimits {
  /** Jobs the harness may track at once: concurrent plus retained finished. */
  readonly trackedJobs: number;
  readonly exposeContextUsage: boolean;
}

const LONG_DETAIL = "x".repeat(DETAIL_BYTES * 2);
/** Timestamps are ISO 8601 UTC, at most this long (six-digit years). */
const TIMESTAMP = "+275760-09-13T00:00:00.000Z";
const BIG = 10 ** 15;

function worstJobLine(): number {
  const states: JobState[] = ["unconfirmed", "running", "exited", "uncertain", "ended_with_world"];
  const outputs: OutputState[] = ["open", "complete", "closed_after_exit", "failed"];
  let worst = 0;
  for (const state of states) {
    for (const output of outputs) {
      const line = renderJobLine({
        jobId: "j".repeat(JOB_ID_BYTES),
        state,
        exitCode: -BIG,
        rootPid: BIG,
        stdoutBytes: BIG,
        stderrBytes: BIG,
        output,
        observedAt: TIMESTAMP,
        inspectionFailure: LONG_DETAIL,
      });
      worst = Math.max(worst, Buffer.byteLength(line, "utf8"));
    }
  }
  return worst;
}

/** Upper bound on the bytes of any observation, including the context-usage sensor when exposed. */
export function observationBound(limits: ObservationLimits): number {
  const unavailable: Metric<never> = { available: false, reason: LONG_DETAIL };
  const header = renderObservation({
    tick: BIG,
    elapsedMs: BIG * 1000,
    previous: { kind: "wait" },
    sample: { sampledAt: "", sensorProfile: "", durationMs: 0, storage: unavailable, memory: unavailable, processes: unavailable, jobs: [], listing: null },
  });
  const jobId = "j".repeat(JOB_ID_BYTES);
  const outcomes: (OperationalOutcome | null)[] = [
    null,
    ...(["unconfirmed", "running", "exited", "uncertain", "ended_with_world"] as const).map(
      (state): OperationalOutcome => ({ kind: "shell", jobId, state, exitCode: -BIG }),
    ),
    { kind: "not_dispatched", detail: LONG_DETAIL },
    { kind: "invalid", reason: "invalid_arguments", detail: LONG_DETAIL },
    { kind: "model_failed", failure: "invalid_response" },
    { kind: "request_not_sent", reason: "request_invalid" },
  ];
  const outcomeSlack = Math.max(...outcomes.map((outcome) => Buffer.byteLength(renderOutcome(outcome), "utf8")), Buffer.byteLength(RESUME_DISCLOSURE, "utf8"));
  return (
    Buffer.byteLength(header, "utf8") +
    outcomeSlack +
    limits.trackedJobs * worstJobLine() +
    (limits.exposeContextUsage ? CONTEXT_APPENDIX_BYTES : 0)
  );
}

/** Upper bound on the bytes of one tool result. */
export function actionResultBound(perceivedOutputBytes: number): number {
  const share = Math.floor(perceivedOutputBytes / 2);
  // Each invalid byte shown decodes to U+FFFD, three bytes.
  const stream: StreamRecord = { retained: new Uint8Array(share).fill(0xff), totalBytes: BIG, truncated: true };
  const result = renderActionResult(
    {
      jobId: "j".repeat(JOB_ID_BYTES),
      execId: "",
      state: "running",
      exitCode: null,
      rootPid: BIG,
      startedAt: "",
      exitObservedAt: null,
      stdout: stream,
      stderr: stream,
      output: "closed_after_exit",
      detail: LONG_DETAIL,
      inspectionFailure: LONG_DETAIL,
      observedAt: TIMESTAMP,
    },
    BIG * 1000,
    perceivedOutputBytes,
  );
  return Math.max(Buffer.byteLength(result, "utf8"), Buffer.byteLength(renderNotExecuted(LONG_DETAIL), "utf8"));
}
