import type {
  ActionRequest,
  DispatchHooks,
  JobSnapshot,
  JobState,
  JobSummary,
  WorldIdentity,
  WorldSample,
  WorldStatus,
  WorldStopResult,
} from "../../src/core/contracts.ts";
import { DispatchRefusedError, JobAdmissionError, UncertainJobsError } from "../../src/core/dispatch.ts";
import { ExecutionSafety, noEpochAssessment, type ExecutionSafetySnapshot } from "../../src/core/execution-safety.ts";
import type { StopReason } from "../../src/core/state.ts";
import type { RunnableWorld } from "../../src/operator/run.ts";
import type { WorldFacts } from "../../src/world/backend.ts";

/** What a scripted command does: its state after the wait and its output. */
export interface CommandResult {
  readonly state?: JobState;
  readonly exitCode?: number | null;
  readonly stdout?: string | Uint8Array;
  readonly stderr?: string;
}

export const FAKE_IDENTITY: WorldIdentity = {
  worldId: "w-20260925T161449Z-00000000",
  dockerContext: "fake",
  engineId: "fake-engine",
  storageProfile: "loop-ext4-volume-v1",
  storageIdentity: "00000000-0000-4000-8000-000000000000",
  image: `sha256:${"0".repeat(64)}`,
};

const bytes = (value: string | Uint8Array | undefined) => (value === undefined ? new Uint8Array() : typeof value === "string" ? Buffer.from(value, "utf8") : value);

/**
 * An in-memory world. Commands are handled by `run`, which may keep its own
 * state (such as a map of files) to stand in for persistence. Every call is
 * logged so tests can check what the harness did and in what order.
 */
export class FakeWorld implements RunnableWorld {
  readonly identity = FAKE_IDENTITY;
  readonly calls: string[] = [];
  readonly dispatched: ActionRequest[] = [];
  readonly jobs: JobSnapshot[] = [];
  container: WorldStatus["container"] = "absent";
  /** Commands the harness submitted whose pre-dispatch hook threw: they must never run. */
  readonly withheld: ActionRequest[] = [];
  admissionLimit = Infinity;
  /** Thrown after the pre-dispatch record, as a dispatch whose outcome was lost. */
  failAfterPrepare: Error | null = null;
  attachError: Error | null = null;
  startError: Error | null = null;
  /** After a failed start, the container is left in this state. */
  containerAfterFailedStart: WorldStatus["container"] = "absent";
  /** How `stop` goes; its safety assessment comes from the epoch (sealed only when verified). */
  stopResult: Omit<WorldStopResult, "safety"> = { verified: true, recorded: true, detail: "stopped (exit 0)" };
  /** Called at the start of `stop`, after admission closed and before the stop is committed. */
  duringStop: (() => void) | null = null;
  /** Called when the loop refreshes job safety before a clean end. */
  beforeRefresh: (() => void) | null = null;
  #safety: ExecutionSafety | null = null;
  /** What a failed start reports about stopping the world itself. */
  startCleanup: WorldStopResult | null = null;
  /** Called before each sample; lets a test change the world between ticks. */
  beforeSample: ((tick: number) => void) | null = null;
  #samples = 0;
  readonly #run: (command: string) => CommandResult;

  constructor(run: (command: string) => CommandResult = () => ({ state: "exited", exitCode: 0 })) {
    this.#run = run;
  }

  facts(): Promise<WorldFacts> {
    this.calls.push("facts");
    return Promise.resolve({
      engine: {
        dockerContext: "fake",
        engineId: "fake-engine",
        version: "0",
        apiVersion: "1.44",
        os: "fake",
        architecture: "aarch64",
        kernel: "0",
        cgroupVersion: "2",
        securityOptions: [],
      },
      world: {
        image: FAKE_IDENTITY.image,
        imageArchitecture: "arm64",
        seed: "empty-v1",
        seedSha256: "0".repeat(64),
        requestedCapacityMiB: 128,
        effectiveCapacityBytes: 128 << 20,
        effectiveInodes: 4096,
      },
    });
  }

  attach(): Promise<void> {
    this.calls.push("attach");
    return this.attachError === null ? Promise.resolve() : Promise.reject(this.attachError);
  }

  start(): Promise<void> {
    this.calls.push("start");
    this.#safety = new ExecutionSafety({ epochId: `fake-epoch-${this.calls.length}`, maximumEffects: 8 });
    if (this.startError !== null) {
      this.container = this.containerAfterFailedStart;
      return Promise.reject(this.startError);
    }
    this.container = "running";
    return Promise.resolve();
  }

  stop(reason: StopReason): Promise<WorldStopResult> {
    this.calls.push(`stop:${reason}`);
    this.#safety?.closeAdmission();
    this.duringStop?.();
    if (this.stopResult.verified) this.container = "absent";
    const safety = this.#safety === null ? noEpochAssessment(false) : this.stopResult.verified ? this.#safety.seal() : this.#safety.provisional();
    return Promise.resolve({ ...this.stopResult, safety });
  }

  safety(): ExecutionSafetySnapshot | null {
    return this.#safety?.snapshot() ?? null;
  }

  refreshJobSafety(): Promise<void> {
    this.beforeRefresh?.();
    return Promise.resolve();
  }

  /** The engine forgets job `jobId`: its state becomes uncertain and the epoch latches it, as the job table does. */
  lose(jobId: string, detail = "the engine no longer knows this execution"): void {
    const index = this.jobs.findIndex((job) => job.jobId === jobId);
    const job = this.jobs[index]!;
    this.jobs[index] = { ...job, state: "uncertain" };
    this.#safety!.latchUncertainty({ actionId: jobId, jobId, execId: job.execId, cause: "execution_lost", firstObservedAt: "2026-09-25T16:14:49.000Z", detail });
  }

  /** Why a new effect may not be admitted now, mirroring the job table. */
  #denial(callerAllows: boolean): Error | null {
    const safety = this.#safety!.snapshot();
    if (safety.reviewRequired) return new UncertainJobsError(safety.uncertainEffects, safety.requiredEvidenceFailed, safety.reviewCauses);
    if (safety.admission === "closed") return new DispatchRefusedError("the world began stopping; it was not started");
    if (!callerAllows) return new DispatchRefusedError("the caller withdrew the dispatch before the start; it was not started");
    return null;
  }

  close(): Promise<void> {
    this.calls.push("close");
    return Promise.resolve();
  }

  inspect(): Promise<WorldStatus> {
    return Promise.resolve({ identity: this.identity, container: this.container, storageAttached: true });
  }

  sample(options: { readonly listing: boolean }): Promise<WorldSample> {
    this.#samples += 1;
    this.beforeSample?.(this.#samples);
    this.calls.push(`sample${options.listing ? "+listing" : ""}`);
    const jobs: JobSummary[] = this.jobs.map((job) => ({
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
    return Promise.resolve({
      sampledAt: "2026-09-25T16:14:49.000Z",
      sensorProfile: "baseline-sensors-v4",
      durationMs: 1,
      storage: { available: true, value: { totalBytes: 134217728, availableBytes: 130000000, totalInodes: 4096, availableInodes: 4000 } },
      memory: { available: true, value: { usageBytes: 1 << 20, limitBytes: 256 << 20 } },
      processes: { available: false, reason: "the engine reported no process statistics" },
      jobs,
      listing: options.listing
        ? { available: true, value: { entries: [{ nameBase64: Buffer.from("lost+found").toString("base64"), name: "lost+found", type: "directory", sizeBytes: null }], truncated: false } }
        : null,
    });
  }

  /** Job IDs acknowledged as delivered finished, per call. */
  readonly acknowledged: (readonly string[])[] = [];

  acknowledgeJobs(jobIds: readonly string[]): void {
    this.acknowledged.push([...jobIds]);
  }

  async submit(request: ActionRequest, hooks: DispatchHooks): Promise<JobSnapshot> {
    // Like the job table: an early check, then the decisive one after preparation.
    const early = this.#denial(true);
    if (early !== null) throw early;
    const active = this.jobs.filter((job) => job.state === "running" || job.state === "unconfirmed").length;
    if (active >= this.admissionLimit) throw new JobAdmissionError(active, this.admissionLimit);
    const identity = { jobId: request.actionId, execId: `exec-${this.dispatched.length + this.withheld.length + 1}`, containerId: "fake-container" };
    try {
      await hooks.prepared(identity);
    } catch (error) {
      this.withheld.push(request);
      throw error;
    }
    // Like the job table, the caller's hook and then the safety condition, at the last moment.
    const denial = this.#denial(hooks.proceed?.() !== false);
    if (denial !== null) {
      this.withheld.push(request);
      throw denial;
    }
    if (this.failAfterPrepare !== null) throw this.failAfterPrepare;
    this.#safety!.noteCommitted();
    this.dispatched.push(request);
    const result = this.#run(request.command);
    const stdout = bytes(result.stdout);
    const stderr = bytes(result.stderr);
    const state = result.state ?? "exited";
    const job: JobSnapshot = {
      jobId: request.actionId,
      execId: identity.execId,
      state,
      exitCode: state === "exited" ? (result.exitCode ?? 0) : null,
      rootPid: 100 + this.dispatched.length,
      startedAt: "2026-09-25T16:14:49.000Z",
      exitObservedAt: null,
      observedAt: "2026-09-25T16:14:49.000Z",
      stdout: { retained: stdout, totalBytes: stdout.length, truncated: false },
      stderr: { retained: stderr, totalBytes: stderr.length, truncated: false },
      output: state === "exited" ? "complete" : "open",
      detail: null,
      inspectionFailure: null,
    };
    this.jobs.push(job);
    if (state === "unconfirmed" || state === "uncertain") {
      this.#safety!.latchUncertainty({
        actionId: job.jobId,
        jobId: job.jobId,
        execId: job.execId,
        cause: state === "unconfirmed" ? "start_outcome_unknown" : "execution_lost",
        firstObservedAt: job.observedAt,
        detail: `the job was ${state} when the wait ended`,
      });
    }
    return job;
  }
}
