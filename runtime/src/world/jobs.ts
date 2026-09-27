import { createHash } from "node:crypto";

import type { Clock } from "../core/clock.ts";
import type {
  ActionRequest,
  DispatchHooks,
  JobSignal,
  JobSnapshot,
  JobState,
  JobSummary,
  OutputState,
  SignalResult,
} from "../core/contracts.ts";
import { DispatchRefusedError, JobAdmissionError, UncertainJobsError } from "../core/dispatch.ts";
import type { ExecutionSafety, UncertaintyCause } from "../core/execution-safety.ts";
import { EngineResponseError, type RawStream } from "./engine.ts";
import { ControlNotStartedError, ExecGoneError, type ControlResult, type ExecTransport } from "./exec.ts";
import { FrameDemuxer, HeadRetainer, LaunchMarkerFilter } from "./output.ts";

// Continuing jobs, job policy `continuing-jobs-v4` (plan §8.3, Phase 2 jobs
// spike). A shell action becomes one engine execution that is started at most
// once. The harness waits a bounded time for it and then returns whatever is
// known: waiting is not an execution deadline and never terminates anything.
// One collector per job keeps draining output across ticks. Later status
// comes from inspecting the same execution, never from running it again.
//
// Uncertainty is not a job state to be re-checked later: it is latched in the
// epoch's `ExecutionSafety`, shared with the world controller, the moment it
// is established and before anything is recorded. Every agent effect is
// admitted against that latch at its commitment point, `transport.start`,
// with nothing awaited between the final check and the start request.

/** After the root exits, a stream still held open by descendants is closed this much later. */
export const OUTPUT_CLOSE_AFTER_EXIT_MS = 5_000;
/** Unsettled jobs are inspected this often, so exits are seen without depending on when the next tick comes. */
export const EXIT_POLL_INTERVAL_MS = 1_000;
const POLL_INTERVAL_MS = 100;
const SIGNAL_TIMEOUT_MS = 10_000;

export { DispatchRefusedError, JobAdmissionError, UncertainJobsError };

/**
 * Runs the command as `/bin/sh -c`, after first reporting the root PID (also
 * its process group and session: every execution is a session leader) and its
 * start time on stderr. `exec` keeps the same process, so the PID is the
 * command shell's. Nothing from the launcher survives into the command's
 * environment.
 */
export const LAUNCHER_SCRIPT = `set -f
c=$1
t=0
if read -r s < /proc/self/stat; then set -- \${s##*) }; if [ "$#" -ge 20 ]; then shift 19; t=$1; fi; fi
printf 'alife-job %s %s\\n' "$$" "$t" >&2
exec /bin/sh -c "$c"
`;

export function launchCommand(command: string): readonly string[] {
  return ["/bin/sh", "-c", LAUNCHER_SCRIPT, "alife-job", command];
}

/**
 * Checks the root's start time before signalling its process group, so a
 * reused PID is not signalled. A narrow race remains if the root exits and its
 * PID is reused between the check and the signal.
 */
export const SIGNAL_SCRIPT = `import json, os, signal, sys
pid, start, name = int(sys.argv[1]), sys.argv[2], sys.argv[3]
try:
    fd = os.pidfd_open(pid)
except ProcessLookupError:
    print(json.dumps({"result": "root_gone"})); sys.exit(0)
try:
    with open("/proc/%d/stat" % pid) as f:
        fields = f.read().rsplit(")", 1)[1].split()
    if fields[19] != start:
        print(json.dumps({"result": "identity_mismatch"})); sys.exit(0)
    if os.getpgid(pid) != pid:
        print(json.dumps({"result": "not_group_leader"})); sys.exit(0)
    os.killpg(pid, getattr(signal, "SIG" + name))
    print(json.dumps({"result": "sent"}))
except ProcessLookupError:
    print(json.dumps({"result": "root_gone"}))
finally:
    os.close(fd)
`;

export type JobEventType =
  | "job.prepared"
  | "job.start_refused"
  | "job.state"
  | "job.output"
  | "job.evicted"
  | "job.signal_requested"
  | "job.signalled";

export type JobRecorder = (type: JobEventType, data: Readonly<Record<string, unknown>>, durable: boolean) => Promise<void>;

export interface JobTableOptions {
  readonly transport: ExecTransport;
  readonly clock: Clock;
  readonly actionWaitMs: number;
  readonly maximumConcurrentJobs: number;
  readonly retainedFinishedJobs: number;
  readonly capturedOutputBytes: number;
  readonly record: JobRecorder;
  /**
   * Runs a fixed harness command in the world, e.g. for signals. `admit`, when
   * given, is checked after the execution is created and immediately before it starts.
   */
  readonly control: (cmd: readonly string[], timeoutMs: number, admit?: () => Error | null) => Promise<ControlResult>;
  /** The epoch's safety condition, owned by the world controller. This table never keeps a second one. */
  readonly safety: ExecutionSafety;
  /** Only for tests; the policy fixes this at `OUTPUT_CLOSE_AFTER_EXIT_MS`. */
  readonly outputCloseAfterExitMs?: number;
  /** Only for tests; the policy fixes this at `EXIT_POLL_INTERVAL_MS`. */
  readonly exitPollIntervalMs?: number;
  /**
   * Job IDs this world has already prepared, from its durable records. They
   * are refused like any ID dispatched by this table, so eviction or a new
   * controller never makes an ID dispatchable again.
   */
  readonly previouslyPrepared?: Iterable<string>;
}

export class UnknownJobError extends Error {
  constructor(jobId: string) {
    super(`no tracked job ${JSON.stringify(jobId)}; finished jobs beyond the retention bound are no longer tracked`);
    this.name = "UnknownJobError";
  }
}

class TrackedJob {
  readonly jobId: string;
  readonly execId: string;
  readonly sequence: number;
  readonly startedAt: string;
  state: JobState = "unconfirmed";
  exitCode: number | null = null;
  exitObservedAt: string | null = null;
  observedAt: string;
  output: OutputState = "open";
  detail: string | null = null;
  inspectionFailure: string | null = null;
  /** The mind responded to an observation reporting this job finished; only then may retention drop it. */
  reportedFinished = false;
  readonly stdout: HeadRetainer;
  readonly stderr: HeadRetainer;
  readonly marker: LaunchMarkerFilter;
  readonly demuxer: FrameDemuxer;
  stream: RawStream | null = null;
  closeTimer: NodeJS.Timeout | null = null;
  closedByHarness = false;
  refreshing: Promise<void> | null = null;
  readonly ended: Promise<void>;
  resolveEnded!: () => void;

  constructor(jobId: string, execId: string, sequence: number, now: string, capturedOutputBytes: number) {
    this.jobId = jobId;
    this.execId = execId;
    this.sequence = sequence;
    this.startedAt = now;
    this.observedAt = now;
    this.stdout = new HeadRetainer(capturedOutputBytes);
    this.stderr = new HeadRetainer(capturedOutputBytes);
    this.marker = new LaunchMarkerFilter((bytes) => this.stderr.add(bytes));
    this.demuxer = new FrameDemuxer((stream, bytes) => {
      if (stream === "stdout") this.stdout.add(bytes);
      else this.marker.push(Buffer.from(bytes));
    });
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
  }

  get rootPid(): number | null {
    return this.marker.identity?.pid ?? null;
  }

  /** No further inspection can change the state. */
  get settled(): boolean {
    return this.state === "exited" || this.state === "uncertain" || this.state === "ended_with_world";
  }

  /** Its root may be running (including when that is uncertain) or its collector is open. */
  get active(): boolean {
    return this.state === "unconfirmed" || this.state === "running" || this.state === "uncertain" || this.output === "open";
  }

  /**
   * Occupies an admission slot while active, and after finishing until an
   * observation reporting it finished has been answered by the mind. So every completion
   * is reported before retention can drop it, whatever the calling order.
   */
  get holdsSlot(): boolean {
    return this.active || !this.reportedFinished;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class JobTable {
  readonly #options: JobTableOptions;
  readonly #jobs = new Map<string, TrackedJob>();
  #sequence = 0;
  #closed = false;
  /**
   * Set when a pre-dispatch record fails. The evidence store can no longer be
   * trusted, so every later submission is refused: this bounds the spent-ID
   * memory and unstarted executions on that path to one.
   */
  #recordFailure: string | null = null;
  /** Set before the world is stopped: exits seen from then on are caused by the stop. */
  #stopping = false;
  /** Counts stops begun; an inspection that started before a stop began is discarded. */
  #stopEpoch = 0;
  /**
   * Every job ID ever prepared in this world, never evicted. Bounded by the
   * world log's size limit, from which it is loaded.
   */
  readonly #prepared: Set<string>;
  /** The controller released the collectors; nothing more is observed. */
  #shutdown = false;
  /** Submissions run one at a time, so the duplicate and admission checks cannot interleave. */
  #submissions: Promise<unknown> = Promise.resolve();
  readonly #poller: NodeJS.Timeout;
  readonly #safety: ExecutionSafety;
  /** Signal operations admitted and not yet settled, each distinct (a job ID is not an operation ID). */
  readonly #operations = new Set<Promise<void>>();
  #signalSequence = 0;
  /** Background inspections and records still running; shutdown settles them before sealing. */
  readonly #pending = new Set<Promise<unknown>>();

  constructor(options: JobTableOptions) {
    this.#options = options;
    this.#safety = options.safety;
    this.#prepared = new Set(options.previouslyPrepared ?? []);
    this.#poller = setInterval(() => {
      if (this.#stopping || this.#shutdown) return;
      // Failures are not lost: records mark the safety condition, and uncertainty is latched before recording.
      for (const job of this.#jobs.values()) this.#track(this.#refresh(job));
    }, options.exitPollIntervalMs ?? EXIT_POLL_INTERVAL_MS);
    this.#poller.unref();
  }

  #now(): string {
    return this.#options.clock.now().toISOString();
  }

  /** Runs `work` in the background, keeping it settleable before shutdown is sealed. */
  #track(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined).finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  /** Waits for every background inspection and record started so far, including ones they start. */
  async settleEvidence(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  /** A world record; a failure marks the epoch's evidence incomplete, which also closes admission. */
  async #record(type: JobEventType, data: Readonly<Record<string, unknown>>, durable: boolean): Promise<void> {
    try {
      await this.#options.record(type, data, durable);
    } catch (error) {
      if (!this.#safety.sealed) this.#safety.markRequiredEvidenceFailure();
      throw error;
    }
  }

  /** Latches the job's uncertainty synchronously, before any record of it is attempted. */
  #latch(job: TrackedJob, cause: UncertaintyCause, detail: string): void {
    this.#safety.latchUncertainty({ actionId: job.jobId, jobId: job.jobId, execId: job.execId, cause, firstObservedAt: this.#now(), detail });
  }

  /**
   * Why a new agent effect may not be admitted now, or null. Synchronous: it
   * reads only in-memory state, so it can sit directly before a start request.
   */
  #denial(callerAllows: boolean): DispatchRefusedError | null {
    const safety = this.#safety.snapshot();
    if (safety.reviewRequired) return new UncertainJobsError(safety.uncertainEffects, safety.requiredEvidenceFailed, safety.reviewCauses);
    if (this.#closed || safety.admission === "closed") {
      return new DispatchRefusedError("the world began stopping or being released before the start; it was not started");
    }
    if (!callerAllows) return new DispatchRefusedError("the caller withdrew the dispatch before the start; it was not started");
    return null;
  }

  /**
   * The world container is gone while jobs of this epoch were expected alive:
   * the absence does not account for their outcomes, so each is latched.
   */
  latchUnaccounted(detail: string): void {
    for (const job of this.#jobs.values()) {
      if (job.state === "running" || job.state === "unconfirmed") this.#latch(job, "execution_lost", detail);
    }
  }

  /** Refreshes every tracked job, so any uncertainty the engine now shows is latched. */
  async refreshSafety(): Promise<void> {
    await this.#refreshAll();
  }

  /** Closes admission synchronously (the first step of a stop or release). */
  closeAdmission(): void {
    this.#closed = true;
  }

  /** Jobs holding an admission slot: active, or finished but not yet reported. */
  get activeCount(): number {
    let count = 0;
    for (const job of this.#jobs.values()) if (job.holdsSlot) count += 1;
    return count;
  }

  /**
   * Dispatches `request.command` at most once. Admission is checked before
   * anything is created; the hook records the execution durably before it can
   * start; the result is known state after at most `actionWaitMs` of waiting.
   */
  submit(request: ActionRequest, hooks: DispatchHooks): Promise<JobSnapshot> {
    const result = this.#submissions.then(() => this.#submit(request, hooks));
    this.#submissions = result.catch(() => undefined);
    return result;
  }

  async #submit(request: ActionRequest, hooks: DispatchHooks): Promise<JobSnapshot> {
    const closed = () => new DispatchRefusedError("the world is stopping or being released; nothing was dispatched");
    if (this.#recordFailure !== null) {
      throw new DispatchRefusedError(`an earlier pre-dispatch record failed (${this.#recordFailure}); no job is dispatched until the world is reviewed`);
    }
    if (this.#closed) throw closed();
    if (this.#prepared.has(request.actionId)) {
      throw new DispatchRefusedError(`job ${request.actionId} was already prepared in this world; a job is never dispatched twice`);
    }
    await this.#refreshAll();
    // Early check: avoids creating an execution that could not be started anyway.
    const early = this.#denial(true);
    if (early !== null) throw early;
    const active = this.activeCount;
    if (active >= this.#options.maximumConcurrentJobs) throw new JobAdmissionError(active, this.#options.maximumConcurrentJobs);

    const { transport } = this.#options;
    const execId = await transport.create(launchCommand(request.command), "/world");
    const job = new TrackedJob(request.actionId, execId, ++this.#sequence, this.#now(), this.#options.capturedOutputBytes);
    const identity = { jobId: job.jobId, execId, containerId: transport.containerId };
    // The ID is spent from here on, whatever happens next.
    this.#prepared.add(job.jobId);
    // Both records are durable before the execution can start. If either
    // fails, the created execution is simply never started.
    try {
      await hooks.prepared(identity);
      await this.#record("job.prepared", identity, true);
    } catch (error) {
      this.#recordFailure = `${job.jobId}: ${(error as Error).message}`;
      if (!this.#safety.sealed) this.#safety.markRequiredEvidenceFailure();
      throw new DispatchRefusedError(
        `recording ${job.jobId} before dispatch failed, so it was not started, and no further job will be: ${(error as Error).message}`,
      );
    }

    // Final admission guard, after every awaited preparation step. The caller's
    // synchronous hook runs first, then the safety condition is read, and nothing
    // awaits between that read and the start request (the commitment point).
    const callerAllows = hooks.proceed?.() !== false;
    const denial = this.#denial(callerAllows);
    if (denial !== null) {
      const uncertain = denial instanceof UncertainJobsError ? denial : null;
      // The refusal is recorded if possible; a failure marks evidence incomplete but never starts the command.
      await this.#record(
        "job.start_refused",
        {
          ...identity,
          status: null,
          reason: uncertain !== null ? "uncertain_jobs" : callerAllows ? "closed" : "withdrawn",
          uncertainJobs: uncertain?.jobIds ?? [],
          message: denial.message,
        },
        true,
      ).catch(() => undefined);
      throw denial;
    }
    this.#jobs.set(job.jobId, job);
    this.#safety.noteCommitted();
    const starting = transport.start(execId);
    const waitStarted = this.#options.clock.monotonicMs();
    if (hooks.committed !== undefined) {
      // Handled below; observed here so a slow hook cannot leave the rejection unhandled.
      starting.catch(() => undefined);
      await hooks.committed();
    }
    try {
      job.stream = await starting;
    } catch (error) {
      if (error instanceof EngineResponseError) {
        // The engine answered with a refusal: the command did not start.
        this.#jobs.delete(job.jobId);
        await this.#record("job.start_refused", { ...identity, status: error.status, reason: "engine", message: error.message }, true);
        throw new DispatchRefusedError(`the engine refused to start ${job.jobId}: ${error.message}`);
      }
      // No answer: it may or may not have started. It is never started again,
      // but stays tracked, counted, and inspected in case the engine did start it.
      job.output = "failed";
      job.detail = `start request failed, so the engine may or may not have started it; no output is collected: ${(error as Error).message}`;
      job.resolveEnded();
      await this.#refresh(job);
      this.#latchIfUnconfirmed(job);
      await this.#recordOutput(job);
      return this.#snapshot(job);
    }
    this.#collect(job, job.stream);
    await this.#waitFor(job, waitStarted + this.#options.actionWaitMs);
    this.#latchIfUnconfirmed(job);
    return this.#snapshot(job);
  }

  /** After the bounded wait, a start still unconfirmed is an effect whose outcome is unknown. */
  #latchIfUnconfirmed(job: TrackedJob): void {
    if (job.state === "unconfirmed") {
      this.#latch(job, "start_outcome_unknown", job.detail ?? "the engine had not confirmed the start when the wait ended");
    }
  }

  #collect(job: TrackedJob, stream: RawStream): void {
    let problem: string | null = null;
    stream.onData((chunk) => {
      try {
        job.demuxer.push(chunk);
      } catch (error) {
        problem = (error as Error).message;
        stream.destroy();
      }
    });
    stream.onEnd((reason, error) => {
      job.marker.flush();
      if (job.closeTimer !== null) clearTimeout(job.closeTimer);
      job.closeTimer = null;
      if (this.#shutdown) {
        job.output = "failed";
        job.detail ??= "collection stopped when the controller released the world";
        job.resolveEnded();
        return;
      }
      // Only end-of-file proves nothing more was coming; a stream closed early lost what it held.
      if (job.closedByHarness) job.output = "closed_after_exit";
      else if (problem !== null || reason !== "eof" || job.demuxer.midFrame) {
        job.output = "failed";
        job.detail ??= `output stream failed: ${
          problem ?? error?.message ?? (reason === "closed" ? "closed without end-of-file" : "ended inside a frame")
        }`;
      } else job.output = "complete";
      job.resolveEnded();
      // Stream end often means the root exited: look now rather than at the next poll.
      this.#track(this.#refresh(job).then(() => this.#recordOutput(job)));
    });
  }

  /** Sleeps up to `ms`, returning early if the job's still-open output ends meanwhile. */
  async #pause(job: TrackedJob, ms: number): Promise<void> {
    const cancel = new AbortController();
    const sleep = this.#options.clock.sleep(ms, cancel.signal).catch(() => undefined);
    await (job.output === "open" ? Promise.race([job.ended, sleep]) : sleep);
    cancel.abort();
  }

  async #waitFor(job: TrackedJob, deadline: number): Promise<void> {
    const { clock } = this.#options;
    // A stop or release ends the wait early; the job's known state is returned.
    for (;;) {
      await this.#refresh(job);
      const remaining = deadline - clock.monotonicMs();
      if (job.settled || remaining <= 0 || this.#closed) break;
      await this.#pause(job, Math.min(remaining, POLL_INTERVAL_MS));
    }
    // Output may still be in flight after exit; use what is left of the wait for it.
    const remaining = deadline - clock.monotonicMs();
    if (job.settled && job.output === "open" && remaining > 0 && !this.#closed) await this.#pause(job, remaining);
  }

  /** Establishes a job's state from the engine; concurrent calls share one inspection. */
  #refresh(job: TrackedJob): Promise<void> {
    if (job.settled || this.#shutdown) return Promise.resolve();
    job.refreshing ??= this.#inspect(job).finally(() => {
      job.refreshing = null;
    });
    return job.refreshing;
  }

  async #inspect(job: TrackedJob): Promise<void> {
    if (this.#stopping) return;
    const epoch = this.#stopEpoch;
    // An answer that arrives after a stop began may describe the stop's doing, not the job's.
    const crossedStop = () => this.#stopping || this.#stopEpoch !== epoch || this.#shutdown;
    let state;
    try {
      state = await this.#options.transport.inspect(job.execId);
    } catch (error) {
      if (crossedStop()) return;
      if (error instanceof ExecGoneError) {
        // Latched before the transition is recorded: a held or failing record cannot delay or undo it.
        this.#latch(job, "execution_lost", "the engine no longer knows this execution");
        await this.#transition(job, "uncertain", "the engine no longer knows this execution");
        return;
      }
      // Engine unavailable: keep the last established state and say so until an inspection succeeds.
      job.inspectionFailure = (error as Error).message;
      return;
    }
    if (crossedStop()) return;
    job.inspectionFailure = null;
    job.observedAt = this.#now();
    if (!state.running && state.exitCode !== null) {
      job.exitCode = state.exitCode;
      job.exitObservedAt = job.observedAt;
      await this.#transition(job, "exited", null);
      this.#scheduleClose(job);
    } else if (state.running && job.state === "unconfirmed") {
      await this.#transition(job, "running", null);
    }
  }

  async #transition(job: TrackedJob, to: JobState, detail: string | null): Promise<void> {
    const from = job.state;
    if (from === to) return;
    job.state = to;
    if (detail !== null) job.detail = detail;
    await this.#record(
      "job.state",
      { jobId: job.jobId, execId: job.execId, from, to, exitCode: job.exitCode, rootPid: job.rootPid, detail },
      false,
    );
  }

  #scheduleClose(job: TrackedJob): void {
    if (job.output !== "open" || job.closeTimer !== null || job.stream === null) return;
    job.closeTimer = setTimeout(() => {
      job.closeTimer = null;
      if (job.output === "open") {
        job.closedByHarness = true;
        job.stream?.destroy();
      }
    }, this.#options.outputCloseAfterExitMs ?? OUTPUT_CLOSE_AFTER_EXIT_MS);
    job.closeTimer.unref();
  }

  async #recordOutput(job: TrackedJob): Promise<void> {
    const stdout = job.stdout.snapshot();
    const stderr = job.stderr.snapshot();
    await this.#record(
      "job.output",
      {
        jobId: job.jobId,
        output: job.output,
        rootPid: job.rootPid,
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        stdoutRetainedSha256: sha256(stdout.retained),
        stderrRetainedSha256: sha256(stderr.retained),
      },
      false,
    );
  }

  async #refreshAll(): Promise<void> {
    await Promise.all([...this.#jobs.values()].map((job) => this.#refresh(job)));
    await this.#evict();
  }

  /**
   * Drops the oldest finished jobs beyond the retention bound. Only jobs
   * already reported finished can be dropped; unreported ones hold admission
   * slots, so at most `maximumConcurrentJobs + retainedFinishedJobs` jobs are
   * ever tracked.
   */
  async #evict(): Promise<void> {
    const reported = [...this.#jobs.values()].filter((job) => !job.holdsSlot).sort((a, b) => a.sequence - b.sequence);
    for (const job of reported.slice(0, Math.max(0, reported.length - this.#options.retainedFinishedJobs))) {
      this.#jobs.delete(job.jobId);
      await this.#record("job.evicted", { jobId: job.jobId }, false);
    }
  }

  #snapshot(job: TrackedJob): JobSnapshot {
    return {
      jobId: job.jobId,
      execId: job.execId,
      state: job.state,
      exitCode: job.exitCode,
      rootPid: job.rootPid,
      startedAt: job.startedAt,
      exitObservedAt: job.exitObservedAt,
      observedAt: job.observedAt,
      stdout: job.stdout.snapshot(),
      stderr: job.stderr.snapshot(),
      output: job.output,
      detail: job.detail,
      inspectionFailure: job.inspectionFailure,
    };
  }

  async inspect(jobId: string): Promise<JobSnapshot> {
    const job = this.#jobs.get(jobId);
    if (job === undefined) throw new UnknownJobError(jobId);
    await this.#refresh(job);
    return this.#snapshot(job);
  }

  /** Every tracked job, oldest first, after refreshing and applying retention. */
  async list(): Promise<readonly JobSnapshot[]> {
    await this.#refreshAll();
    return [...this.#jobs.values()].sort((a, b) => a.sequence - b.sequence).map((job) => this.#snapshot(job));
  }

  /**
   * Records that the mind has responded to an observation reporting these
   * jobs finished. Only then does a finished job release its slot and
   * become subject to retention. IDs that are unknown or not finished are ignored.
   */
  acknowledge(jobIds: readonly string[]): void {
    for (const id of jobIds) {
      const job = this.#jobs.get(id);
      if (job !== undefined && !job.active) job.reportedFinished = true;
    }
  }

  /** What an observation reports: every tracked job, oldest first. Reporting alone acknowledges nothing. */
  async summaries(): Promise<readonly JobSummary[]> {
    await this.#refreshAll();
    const jobs = [...this.#jobs.values()].sort((a, b) => a.sequence - b.sequence);
    return jobs.map((job) => ({
      jobId: job.jobId,
      state: job.state,
      exitCode: job.exitCode,
      rootPid: job.rootPid,
      stdoutBytes: job.stdout.totalBytes,
      stderrBytes: job.stderr.totalBytes,
      output: job.output,
      observedAt: job.observedAt,
      inspectionFailure: job.inspectionFailure,
    }));
  }

  /**
   * Sends `signal` to a running job's process group. Reports exactly what
   * happened; descendants that left the group are never covered.
   *
   * Each invocation is one operation, registered synchronously before its
   * first await and owned by the table until it settles, so a stop can wait
   * for its required evidence. Shutdown closes new signals of either origin; a
   * review-required epoch closes agent signals only (an operator's explicit
   * intervention stays available and attributed). Every admitted request ends
   * with one `job.signalled` outcome: delivered, known not delivered (withdrawn,
   * refused by the engine, or found unnecessary), or unknown, in which case
   * the epoch requires review before the outcome is recorded.
   */
  signal(jobId: string, signal: JobSignal, requestedBy: "agent" | "operator"): Promise<SignalResult> {
    const operation = this.#signalOperation(jobId, signal, requestedBy, `signal-${++this.#signalSequence}`);
    const owned: Promise<void> = operation.then(
      () => undefined,
      () => undefined,
    ).finally(() => this.#operations.delete(owned));
    this.#operations.add(owned);
    return operation;
  }

  /** Waits for every admitted signal operation, including ones admitted while waiting. */
  async settleOperations(): Promise<void> {
    while (this.#operations.size > 0) await Promise.allSettled([...this.#operations]);
  }

  /** Shutdown closes both origins; prior uncertainty closes only the agent's. */
  #signalAdmission(requestedBy: "agent" | "operator"): () => DispatchRefusedError | null {
    if (requestedBy === "agent") return () => this.#denial(true);
    return () => (this.#closed || this.#stopping || this.#shutdown ? new DispatchRefusedError("the world is stopping or being released") : null);
  }

  async #signalOperation(jobId: string, signal: JobSignal, requestedBy: "agent" | "operator", operationId: string): Promise<SignalResult> {
    const job = this.#jobs.get(jobId);
    if (job === undefined) throw new UnknownJobError(jobId);
    const result = (delivered: boolean, detail: string): SignalResult => ({ jobId, signal, delivered, scope: "process_group", detail });
    const admit = this.#signalAdmission(requestedBy);
    const refused = admit();
    if (refused !== null) return result(false, `nothing was signalled: ${refused.message}`);
    await this.#refresh(job);
    // The start-time check keeps this safe even when the engine cannot confirm the root is running.
    if (job.state === "exited" || job.state === "ended_with_world") return result(false, `job is ${job.state}; nothing was signalled`);
    const identity = job.marker.identity;
    if (identity === null) return result(false, "the job's process identity is unknown; nothing was signalled");

    // Required before any effect. If it cannot be written, nothing is started (the failure is kept as incomplete evidence).
    const requested = await this.#record("job.signal_requested", { jobId, signal, requestedBy, rootPid: identity.pid, operationId }, true).then(
      () => true,
      () => false,
    );
    const outcome = requested
      ? await this.#deliverSignal(identity, signal, admit)
      : { delivered: false, known: true, detail: "nothing was signalled: the request could not be recorded" };
    if (!outcome.known) {
      // Latched before the outcome is recorded: a recorded "unknown" is not a known no-op.
      this.#safety.latchReview({ operationId, kind: "signal_delivery_unknown", jobId, requestedBy, firstObservedAt: this.#now(), detail: outcome.detail });
    }
    const final = result(outcome.delivered, outcome.detail);
    // A failed outcome record is kept as incomplete evidence; the truthful result is still returned.
    await this.#record("job.signalled", { ...final, requestedBy, operationId, known: outcome.known }, true).catch(() => undefined);
    await this.#refresh(job).catch(() => undefined);
    return final;
  }

  /** Delivers one signal through the control helper and classifies what is known about it. */
  async #deliverSignal(
    identity: { readonly pid: number; readonly startTime: string },
    signal: JobSignal,
    admit: () => DispatchRefusedError | null,
  ): Promise<{ readonly delivered: boolean; readonly known: boolean; readonly detail: string }> {
    let control: ControlResult;
    try {
      control = await this.#options.control(["python3", "-I", "-c", SIGNAL_SCRIPT, String(identity.pid), identity.startTime, signal], SIGNAL_TIMEOUT_MS, admit);
    } catch (error) {
      // Withdrawn at admission, or proven not started: known non-effects.
      if (error instanceof DispatchRefusedError) return { delivered: false, known: true, detail: `nothing was signalled: ${error.message}` };
      if (error instanceof ControlNotStartedError) return { delivered: false, known: true, detail: `nothing was signalled: ${error.message}` };
      // The helper's start was requested and its answer was lost: delivery is unknown.
      return { delivered: false, known: false, detail: `the signal helper's outcome is unknown: ${(error as Error).message}` };
    }
    if (control.timedOut || control.exitCode !== 0 || control.overflow) {
      const why = control.timedOut ? "timed out" : control.exitCode !== 0 ? `exited ${control.exitCode}` : "gave an incomplete reading";
      return { delivered: false, known: false, detail: `the signal helper ${why}; delivery is unknown` };
    }
    let reported: unknown;
    try {
      reported = (JSON.parse(control.stdout.toString("utf8")) as { result?: unknown }).result;
    } catch {
      reported = null;
    }
    switch (reported) {
      case "sent":
        return { delivered: true, known: true, detail: `sent SIG${signal} to process group ${identity.pid}` };
      case "root_gone":
        return { delivered: false, known: true, detail: "the root process had already exited; nothing was signalled" };
      case "identity_mismatch":
        return { delivered: false, known: true, detail: "the PID now belongs to another process; nothing was signalled" };
      case "not_group_leader":
        return { delivered: false, known: true, detail: "the root is no longer its process group's leader; nothing was signalled" };
      default:
        return { delivered: false, known: false, detail: "the signal helper gave no readable result; delivery is unknown" };
    }
  }

  /**
   * Called before the world is stopped. Refuses new jobs and stops
   * interpreting engine state, since exits from here on are the stop's doing.
   */
  beginWorldStop(): void {
    this.#closed = true;
    this.#stopping = true;
    this.#stopEpoch += 1;
    clearInterval(this.#poller);
  }

  /**
   * Refuses new submissions and waits for any in progress to finish: each
   * either never starts or is tracked before this resolves. Stopping or
   * releasing the world must await this first.
   */
  async quiesce(): Promise<void> {
    this.#closed = true;
    await this.#submissions;
  }

  /**
   * The stop could not be verified, so the world may still be running: job
   * states are inspected again, but no new jobs are admitted.
   */
  stopNotVerified(): void {
    this.#stopping = false;
  }

  /**
   * After the world has stopped: every job still running or unconfirmed ended
   * with it, whatever the engine reports afterwards. An exit status the engine
   * still reports is kept as data, not as evidence of a normal exit. A job
   * whose outcome was already uncertain stays uncertain: the stop ends its
   * processes, not the uncertainty (which the safety latch keeps regardless).
   */
  async endWithWorld(): Promise<void> {
    this.beginWorldStop();
    for (const job of this.#jobs.values()) {
      if (!job.settled) {
        try {
          const state = await this.#options.transport.inspect(job.execId);
          if (!state.running && state.exitCode !== null) job.exitCode = state.exitCode;
        } catch {
          // The execution record may be gone with the container; the state below is still true.
        }
        job.observedAt = this.#now();
        // Failure-collecting: a record that fails marks evidence incomplete, and shutdown continues.
        await this.#transition(job, "ended_with_world", "the world stopped before the root was seen to exit").catch(() => undefined);
      }
      if (job.output === "open") {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([job.ended, new Promise<void>((resolve) => (timer = setTimeout(resolve, 2_000)))]);
        clearTimeout(timer);
        if (job.output === "open") {
          job.closedByHarness = true;
          job.stream?.destroy();
          await job.ended;
        }
      }
    }
  }

  /** Releases collectors without changing any job's recorded state (controller shutdown). */
  async close(): Promise<void> {
    await this.quiesce();
    this.#shutdown = true;
    clearInterval(this.#poller);
    for (const job of this.#jobs.values()) {
      if (job.closeTimer !== null) clearTimeout(job.closeTimer);
      job.stream?.destroy();
    }
  }
}
