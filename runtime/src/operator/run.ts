import { readFile, statfs } from "node:fs/promises";
import path from "node:path";

import { paidExecutionBlockers, loadStoredConfig, type ResolvedConfig } from "../config/resolve.ts";
import type { Clock, RandomBytes } from "../core/clock.ts";
import { recentCompleteExchanges, recentCompleteExchangesV3, RECENT_COMPLETE_EXCHANGES, RECENT_COMPLETE_EXCHANGES_V3 } from "../core/context.ts";
import type { MindAdapter, StartHooks, WorldIdentity, WorldStopResult } from "../core/contracts.ts";
import { canonicalSha256, sha256Hex } from "../core/hash.ts";
import { newRunId, parseRunId, type RunId, type WorldId } from "../core/ids.ts";
import { TickLoop, type LoopBoundary, type LoopEnd, type LoopState, type LoopWorld, type SpendAuthority, type TickReport } from "../core/loop.ts";
import { actionResultBound, observationBound } from "../core/observation.ts";
import { cleanEndState, STATE_EVENTS, transition, type RunState, type StopReason } from "../core/state.ts";
import { tokenEstimator } from "../core/tokens.ts";
import { trackedJobBound, type Config } from "../config/schema.ts";
import { ANTHROPIC_TRANSPORT } from "../mind/anthropic.ts";
import { createMind, responseBytesBound } from "../mind/create.ts";
import { openCampaign, SMOKE_CAMPAIGN_ID, type Campaign } from "../records/campaign.ts";
import { CostLedger, microUsd, type CostRates } from "../records/accounting.ts";
import { CHECKPOINT_SCHEMA_VERSION, readCheckpoint, writeCheckpoint, type Checkpoint } from "../records/checkpoint.ts";
import { readEventLog, type EventType } from "../records/events.ts";
import { analyzeRun } from "../records/finalize.ts";
import { UncertaintyRecorder } from "../records/uncertainty.ts";
import { certifiesClean, noEpochAssessment } from "../core/execution-safety.ts";
import { syncDirectory, writeNewFiles } from "../records/files.ts";
import { manifestSchema, MANIFEST_SCHEMA_VERSION, runtimeIdentity, sourceIdentity, type Manifest } from "../records/manifest.ts";
import { createRunDirectory, RunRecorder, runPaths, type RunPaths } from "../records/run-store.ts";
import { fenceViolation, openWorld, runtimeSettings, worldFence, type WorldAccess, type WorldFacts, type WorldRuntimeSettings } from "../world/backend.ts";
import { worldPaths } from "../world/metadata.ts";
import { acquireOwnership, acquireOwnerships, type Ownership } from "./locks.ts";
import { REPOSITORY_ROOT, type StateLayout } from "./state-dir.ts";
import { messageOf } from "../core/errors.ts";

// One episode (plan §11, §12): records first, then the world, then ticks,
// then a verified stop. Every lifecycle state is recorded when it is entered,
// and durably before any effect that state permits. A clean stop writes a checkpoint; anything unresolved or
// unverifiable leaves the run `recovery_required` for the operator to review
// and finalize. A clean stop can later be resumed explicitly (Phase 4): a new
// process and execution epoch continue the same run from its checkpoint,
// never replaying anything. Nothing is retried or resumed automatically.

const MiB = 1 << 20;

/** The first observation after a resume discloses the restart; recorded in `run.resumed`. */
export const RESUME_DISCONTINUITY = "resume-discontinuity-v1";

/** The world as a run needs it. `DockerWorld` is the implementation; tests supply fakes. */
export interface RunnableWorld extends LoopWorld {
  readonly identity: WorldIdentity;
  /** How a failed `start` stopped the world itself, if it did. */
  readonly startCleanup: WorldStopResult | null;
  facts(): Promise<WorldFacts>;
  attach(): Promise<void>;
  start(hooks?: StartHooks): Promise<void>;
  stop(reason: StopReason): Promise<WorldStopResult>;
  close(): Promise<void>;
}

export type WorldOpener = (access: WorldAccess, settings: WorldRuntimeSettings) => Promise<RunnableWorld>;

export class RunRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRefusedError";
  }
}

export interface StartRunOptions {
  readonly layout: StateLayout;
  readonly resolved: ResolvedConfig;
  readonly worldId: WorldId;
  readonly clock: Clock;
  /** Aborting it asks the run to stop cleanly after the current step. */
  readonly signal: AbortSignal;
  readonly allowPrivilegedHelper: boolean;
  readonly openWorld?: WorldOpener;
  readonly mind?: { readonly mind: MindAdapter; readonly rates: CostRates };
  readonly random?: RandomBytes;
  readonly hostFreeMiB?: () => Promise<number>;
  readonly onCreated?: (runId: RunId, paths: RunPaths) => void;
  readonly onTick?: (report: TickReport) => void;
}

/** A clean resume continues a run from its stored inputs and its checkpoint; nothing else is supplied. */
export type ResumeRunOptions = Omit<StartRunOptions, "resolved" | "worldId" | "onCreated"> & { readonly runId: RunId };

export interface RunResult {
  readonly runId: RunId;
  readonly state: RunState;
  readonly reason: StopReason;
  readonly detail: string;
  readonly completedTicks: number;
  /** Model calls made (including failures) and calls that received a response (operator decision 3). */
  readonly attemptedCalls: number;
  readonly respondedCalls: number;
  readonly checkpointSha256: string | null;
  readonly worldStop: WorldStopResult | null;
  /** False when the final state could not be written; the log then shows the run as interrupted. */
  readonly recorded: boolean;
}

/** Lifecycle points a supervising host can wait at (instrumentation for crash tests; none by default). */
export type BoundaryName = LoopBoundary | "after_world_stop" | "after_checkpoint_file" | "after_terminal_record";

/** What supervision of an episode knows about it once its records exist. */
export interface SupervisionContext {
  readonly runId: RunId;
  readonly worldId: WorldId;
  readonly layout: StateLayout;
  readonly paths: RunPaths;
  readonly records: RunRecorder;
  readonly world: RunnableWorld;
  /** The run's lock; its token authenticates the controller to its watchdog and control endpoint. */
  readonly runOwnership: Ownership;
  /** The run's original absolute deadline. */
  readonly deadline: Date;
  readonly clock: Clock;
  readonly config: Config;
  /** Record capacity the ticks and the end of the run need; captures must leave it free. */
  readonly tickReserveBytes: number;
  readonly resumed: boolean;
}

/**
 * Independent supervision of an episode (`watchdog-v1`, in managed-run.ts):
 * protection armed before the world starts, admission tied to a live lease,
 * a control endpoint, and captures around the execution epoch.
 */
export interface EpisodeSupervision {
  readonly declaration: string;
  /** Bytes of the run's record limit kept for files other processes write (the watchdog's journal, the lease). */
  readonly reservedBytes: number;
  /** Stop requests received through the run's control endpoint. */
  readonly signal: AbortSignal;
  /** After the run's records exist and before the world is touched. A reason refuses the start; nothing in the world changed. */
  begin(context: SupervisionContext): Promise<string | null>;
  readonly startHooks: StartHooks;
  /** Why no new effect may be admitted now, or null; synchronous. */
  denial(): string | null;
  boundary(name: BoundaryName): Promise<void>;
  /**
   * After the world stop (or a failed start's cleanup): releases protection
   * only when the stop was verified, then captures the stopped world if asked.
   * Says whether the supervision evidence permits a clean checkpoint.
   */
  afterStop(stop: WorldStopResult | null, options: { readonly capture: boolean }): Promise<{ readonly eligible: boolean; readonly detail: string }>;
  end(): Promise<void>;
}

/** What a paid run records about its mind's exact settings (never its credential). */
function describeMind(config: Config, rates: CostRates): Readonly<Record<string, unknown>> {
  const { mind, body } = config;
  if (mind.provider !== "anthropic") return { provider: mind.provider };
  return {
    provider: mind.provider,
    model: mind.model,
    transport: ANTHROPIC_TRANSPORT,
    reasoningEffort: mind.reasoningEffort,
    thinking: { type: "adaptive", blockBinding: "drop_block" },
    maximumOutputTokens: mind.maximumOutputTokens,
    contextBudgetTokens: body.contextBudgetTokens,
    contextPolicy: body.contextPolicy,
    tokenEstimator: body.tokenEstimator,
    cache: "none",
    serviceMode: "standard",
    retries: mind.retryProfile,
    credentialEnv: mind.credentialEnv,
    pricing: { ...rates },
  };
}

/**
 * Record capacity a tick may need: its observation and sample, the reply,
 * the command, one action result, and event framing, plus what ending the
 * run afterwards needs, so a run stopped for capacity can still record its
 * stop and checkpoint. A reply larger than 16 bytes per output token is not
 * covered; if it does not fit, the record failure ends the run for review
 * rather than going unrecorded.
 */
export function tickRecordReserveBytes(config: Config): number {
  const { body, mind } = config;
  const observation = observationBound({
    trackedJobs: trackedJobBound(body),
    exposeContextUsage: body.exposeContextUsage,
  });
  const framing = 256 << 10;
  // Ending the run: its stop events and a checkpoint whose history holds at most the budget's worth of
  // bytes (the estimator counts at least one token per byte), JSON-escaped at up to six bytes each;
  // plus one bounded uncertainty record per possibly affected job and the stop assessment that lists them.
  const uncertain = (body.maximumConcurrentJobs + 1) * (8 << 10);
  const ending = 6 * body.contextBudgetTokens + (64 << 10) + 2 * uncertain;
  // A live reply is bounded by its adapter's response bound (it is recorded once and later checkpointed).
  const reply = mind.provider === "fake" ? 16 * mind.maximumOutputTokens : 2 * responseBytesBound(mind.maximumOutputTokens);
  return 2 * observation + actionResultBound(body.perceivedOutputBytes) + reply + 2 * body.maximumCommandBytes + framing + ending;
}

/**
 * How long before its deadline a supervised run stops starting ticks: the
 * watchdog stops the world at the deadline itself, so the longest bounded
 * tick (a request, a command's wait, the readings around them) and a verified
 * stop and release must fit before it for the run to end cleanly.
 */
export function supervisedDeadlineMarginMs(config: Config): number {
  const readingsAndRecords = 30_000;
  const stopAndRelease = 30_000;
  return config.mind.requestTimeoutMs + config.body.actionWaitMs + readingsAndRecords + stopAndRelease;
}

async function readVerified(source: string, sha256: string, what: string): Promise<Buffer> {
  const bytes = await readFile(source);
  if (sha256Hex(bytes) !== sha256) throw new RunRefusedError(`${what} changed after the configuration was validated`);
  return bytes;
}

/**
 * The source revision of the checkout this process's code was loaded from,
 * read once per process: edits made on disk later do not change the code that
 * is running, so they must not change what its runs record either.
 */
let loadedSource: Promise<Manifest["source"]> | null = null;
function loadedSourceIdentity(): Promise<Manifest["source"]> {
  loadedSource ??= sourceIdentity(REPOSITORY_ROOT);
  return loadedSource;
}

async function defaultOpener(access: WorldAccess, settings: WorldRuntimeSettings): Promise<RunnableWorld> {
  return openWorld(access, settings);
}

function manifestFor(runId: RunId, worldId: WorldId, createdAt: string, resolved: ResolvedConfig, facts: WorldFacts, mind: MindAdapter, runtime: Manifest["runtime"], source: Manifest["source"]): Manifest {
  const { world, body, mind: mindConfig } = resolved.config;
  return manifestSchema.parse({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runId,
    worldId,
    createdAt,
    runtime,
    source,
    config: {
      sha256: resolved.configSha256,
      promptSha256: resolved.prompt.sha256,
      toolsSha256: resolved.toolsSha256,
      fakeScriptSha256: resolved.fakeScript?.sha256 ?? null,
    },
    profiles: {
      storage: world.storage.profile,
      container: world.container,
      capture: world.storage.capture,
      ipc: world.ipc,
      body: body.profile,
      sensors: body.sensors,
      jobPolicy: body.jobPolicy,
      outputTruncation: body.outputTruncation,
      contextPolicy: body.contextPolicy,
      tokenEstimator: body.tokenEstimator,
      retry: mindConfig.retryProfile,
      logging: world.logging,
      network: world.network,
    },
    world: { ...facts.world },
    engine: { ...facts.engine, securityOptions: [...facts.engine.securityOptions] },
    mind: {
      adapter: mind.id,
      provider: mindConfig.provider,
      model: mindConfig.provider === "fake" ? null : mindConfig.model,
      sdkVersion: mindConfig.provider === "anthropic" ? ANTHROPIC_TRANSPORT : null,
    },
    trial: null,
  });
}

function refuseUnrunnable(config: Config): void {
  const blockers = paidExecutionBlockers(config);
  if (blockers.length > 0) throw new RunRefusedError(`paid execution is blocked: ${blockers.join("; ")}`);
  if (config.body.contextPolicy !== RECENT_COMPLETE_EXCHANGES && config.body.contextPolicy !== RECENT_COMPLETE_EXCHANGES_V3) {
    throw new RunRefusedError(`context policy ${String(config.body.contextPolicy)} is not implemented`);
  }
}

/** The shared spending campaign a paid run is admitted against, opened exclusively; null for the fake mind. */
async function openRunCampaign(config: Config, rates: CostRates, binding: { readonly campaignId: string; readonly directory: string } | null): Promise<Campaign | null> {
  if (config.mind.provider === "fake") return null;
  const directory = config.operator.campaignDirectory;
  if (directory === undefined) throw new RunRefusedError("a paid provider needs operator.campaignDirectory");
  if (binding !== null && binding.directory !== directory) {
    throw new RunRefusedError(`the checkpoint's shared spending campaign is at ${binding.directory}, not the configured ${directory}`);
  }
  let campaign: Campaign;
  try {
    campaign = await openCampaign({ directory, campaignId: binding?.campaignId ?? SMOKE_CAMPAIGN_ID });
  } catch (error) {
    throw new RunRefusedError(`the shared spending campaign cannot be used; nothing was started: ${messageOf(error)}`);
  }
  try {
    const state = await campaign.snapshot();
    const smallest = microUsd(config.mind.maximumOutputTokens, rates.outputUsdPerMillionTokens);
    if (state.reviewRequired) throw new RunRefusedError(`the shared spending campaign ${state.campaignId} requires review; nothing more is admitted`);
    if (state.remainingMicroUsd < smallest) {
      throw new RunRefusedError(`the shared spending campaign ${state.campaignId} has ${state.remainingMicroUsd} micro-USD left; a request reserves at least ${smallest}; its budget is spent`);
    }
    return campaign;
  } catch (error) {
    await campaign.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Starts and runs one episode in `worldId` until a limit, a stop request, or
 * a condition that needs review ends it. Holds the run's and the world's
 * locks throughout. This is the lifecycle without external supervision; the
 * CLI runs episodes through `startManagedRun`.
 */
export async function startRun(options: StartRunOptions): Promise<RunResult> {
  return startEpisode(options, null);
}

/** `startRun` with optional supervision (managed-run.ts). */
export async function startEpisode(options: StartRunOptions, supervision: EpisodeSupervision | null): Promise<RunResult> {
  const { resolved, clock, layout, worldId } = options;
  const { config } = resolved;
  refuseUnrunnable(config);
  const { mind, rates } = options.mind ?? createMind(resolved);
  // A paid run holds the shared campaign for its whole life; it is never created or reset here.
  const campaign = await openRunCampaign(config, rates, null);

  const runId = newRunId(clock.now(), options.random);
  let runLock: Ownership;
  let worldLock: Ownership;
  try {
    // The new run's lock cannot be contended; both are taken together, and neither is kept if the other fails.
    [runLock, worldLock] = (await acquireOwnerships(layout.locks, [{ kind: "run", id: runId }, { kind: "world", id: worldId }], clock)) as [Ownership, Ownership];
  } catch (error) {
    await campaign?.close().catch(() => undefined);
    throw error;
  }
  let world: RunnableWorld | null = null;
  let records: RunRecorder | null = null;
  try {
    world = await (options.openWorld ?? defaultOpener)(
      { layout, worldId, ownership: worldLock, clock, allowPrivilegedHelper: options.allowPrivilegedHelper },
      runtimeSettings(config),
    );
    const facts = await world.facts();
    const status = await world.inspect();
    if (status.container === "running") {
      throw new RunRefusedError(`world ${worldId} is already running, possibly left by an interrupted controller; review that run and stop the world explicitly (world stop)`);
    }

    // Everything that can refuse the run is checked before its directory exists, so a
    // refused start leaves no record that would look like an interrupted run.
    const prompt = await readVerified(resolved.prompt.path, resolved.prompt.sha256, "the prompt file");
    const script = resolved.fakeScript === null ? null : await readVerified(resolved.fakeScript.path, resolved.fakeScript.sha256, "the fake script");
    const manifest = manifestFor(runId, worldId, clock.now().toISOString(), resolved, facts, mind, await runtimeIdentity(), await loadedSourceIdentity());
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    const toolsText = `${JSON.stringify(resolved.tools, null, 2)}\n`;
    // The initial files share the record limit with everything else, and the first tick must still fit.
    const limitBytes = config.operator.recordLimitMiB * MiB;
    const reserved = supervision?.reservedBytes ?? 0;
    const initialBytes = [manifestText, configText, toolsText].reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), prompt.length + (script?.length ?? 0));
    if (initialBytes + reserved + tickRecordReserveBytes(config) > limitBytes) {
      throw new RunRefusedError(
        `the run's initial records (${initialBytes} bytes)${reserved > 0 ? `, its supervision's reserve (${reserved} bytes),` : ""} and one tick's reserve ` +
          `(${tickRecordReserveBytes(config)} bytes) exceed operator.recordLimitMiB (${limitBytes} bytes)`,
      );
    }

    // Records exist before anything in the world changes.
    const paths = runPaths(layout, runId);
    await createRunDirectory(paths, { durable: false });
    options.onCreated?.(runId, paths);
    // The run directory's name and each file are durable before the run's first event; the (empty)
    // event log's name is made durable with them.
    await Promise.all([
      syncDirectory(layout.runs),
      writeNewFiles([
        [paths.config, configText],
        [paths.prompt, prompt],
        [paths.tools, toolsText],
        ...(script === null ? [] : [[paths.fakeScript, script] as const]),
        [paths.manifest, manifestText],
        [paths.events, ""],
      ]),
    ]);
    records = await RunRecorder.open({ paths, runId, clock, limitBytes, reservedBytes: reserved });
    return await episode({
      options,
      resolved,
      worldId,
      runId,
      paths,
      world,
      records,
      adapter: mind,
      rates,
      runOwnership: runLock,
      manifestSha256: sha256Hex(manifestText),
      supervision,
      campaign,
      resume: null,
    });
  } finally {
    await supervision?.end().catch(() => undefined);
    await world?.close().catch(() => undefined);
    await records?.close().catch(() => undefined);
    await campaign?.close().catch(() => undefined);
    await Promise.all([worldLock.release().catch(() => undefined), runLock.release().catch(() => undefined)]);
  }
}

// ---------------------------------------------------------------------------
// Resume

interface ResumePlan {
  readonly resolved: ResolvedConfig;
  readonly worldId: WorldId;
  readonly checkpoint: Checkpoint;
  readonly checkpointSha256: string;
}

/** Events a finished run may gain after its terminal record without changing what it is: explicit captures. */
const AFTER_TERMINAL = new Set(["archive.created", "archive.failed"]);

/**
 * Everything the run's own records must show before a resume may touch the
 * world: an intact log whose latest execution ended `stopped_clean`, a
 * checkpoint published by that execution's checkpoint and terminal records,
 * stored inputs that match their hashes, a plausible clock, and limits left.
 */
async function resumePlan(paths: RunPaths, runId: RunId, clock: Clock): Promise<ResumePlan> {
  const refuse = (why: string): never => {
    throw new RunRefusedError(`run ${runId} cannot be resumed: ${why}`);
  };
  const analysis = await analyzeRun(paths, runId);
  if (analysis.issues.length > 0) refuse(`its event log is damaged (${analysis.issues[0]!.detail}); it can only be reviewed and finalized`);
  if (analysis.logMissing) refuse("it has no event log");
  if (analysis.finalization !== null || analysis.state === "finalized") refuse("it was finalized");
  if (analysis.state !== "stopped_clean") refuse(`its latest execution is ${analysis.state ?? "unrecorded"}, not stopped cleanly (interrupted, recovery-required, and completed runs are never resumed)`);
  const { outstanding } = analysis;
  if (outstanding.requests.length + outstanding.actions.length + outstanding.reservations.length + analysis.uncertainActions.length > 0) {
    refuse("its record has outcomes that are unknown or uncertain");
  }
  if (analysis.watchdog.reviewRequired) refuse(`its watchdog evidence requires review: ${analysis.watchdog.issues.join("; ")}`);

  const { events } = await readEventLog(paths.events);
  const lifecycle = events.filter((event) => event.type.startsWith("run.") && event.type !== "run.created");
  const terminal = lifecycle.at(-1);
  if (terminal?.type !== "run.stopped_clean") return refuse("its latest lifecycle record is not a clean stop");
  const later = events.filter((event) => event.seq > terminal.seq);
  const unexpected = later.find((event) => !AFTER_TERMINAL.has(event.type));
  if (unexpected !== undefined) refuse(`its record continues after the clean stop (${unexpected.type})`);
  const hash = terminal.data.checkpointSha256;
  if (typeof hash !== "string") return refuse("its clean stop names no checkpoint");
  const began = lifecycle.findLast((event) => event.type === "run.started" || event.type === "run.resumed");
  const published = events.find((event) => event.type === "checkpoint.written" && event.data.sha256 === hash && event.seq < terminal.seq && event.seq > (began?.seq ?? 0));
  if (published === undefined) refuse("its clean stop's checkpoint was not published by that execution");

  let stored;
  try {
    stored = await readCheckpoint(paths, hash);
  } catch (error) {
    return refuse(`its checkpoint cannot be read: ${messageOf(error)}`);
  }
  if (stored.schemaVersion === 3) return refuse(`its checkpoint is schema ${stored.schemaVersion}, which records no world-history fence`);
  // A version 4 checkpoint resumes under the policies it was written with: no continuation, no campaign.
  const checkpoint: Checkpoint = stored.schemaVersion === 4 ? { ...stored, schemaVersion: CHECKPOINT_SCHEMA_VERSION, campaign: null } : stored;
  if (checkpoint.runId !== runId) refuse(`its checkpoint belongs to run ${checkpoint.runId}`);
  if (checkpoint.state !== "stopped_clean") refuse(`its checkpoint records a ${checkpoint.state} run`);
  if (checkpoint.worldId !== analysis.worldId) refuse("its checkpoint names a different world than its record");
  if (published !== undefined && checkpoint.lastEventSequence >= published.seq) refuse("its checkpoint does not precede its publication");

  const created = events.find((event) => event.type === "run.created");
  const manifestBytes = await readFile(paths.manifest).catch(() => null);
  if (manifestBytes === null || created === undefined || sha256Hex(manifestBytes) !== created.data.manifestSha256) refuse("its stored manifest does not match its record");
  const manifest = manifestSchema.safeParse(JSON.parse(manifestBytes!.toString("utf8")));
  if (!manifest.success) return refuse("its stored manifest is invalid");
  const loaded = await loadStoredConfig({ config: paths.config, prompt: paths.prompt, tools: paths.tools, fakeScript: paths.fakeScript });
  if (!loaded.ok) return refuse(`its stored inputs are unusable: ${loaded.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  const resolved = loaded.resolved;
  const expected = manifest.data.config;
  const mismatches = [
    resolved.configSha256 !== expected.sha256 || resolved.configSha256 !== checkpoint.configSha256 || resolved.configSha256 !== created!.data.configSha256 ? "configuration" : null,
    resolved.prompt.sha256 !== expected.promptSha256 ? "prompt" : null,
    canonicalSha256(resolved.tools) !== expected.toolsSha256 ? "tools" : null,
    (resolved.fakeScript?.sha256 ?? null) !== expected.fakeScriptSha256 ? "fake script" : null,
  ].filter((item) => item !== null);
  if (mismatches.length > 0) refuse(`its stored ${mismatches.join(", ")} no longer match the hashes recorded when it started`);

  // Clocks: this process's wall clock may not stand before the run's own records; the deadline is absolute.
  const now = clock.now().getTime();
  const latest = Math.max(Date.parse(checkpoint.writtenAt), ...events.map((event) => Date.parse(event.time)));
  if (now < latest) refuse(`the wall clock (${new Date(now).toISOString()}) is earlier than the run's records (${new Date(latest).toISOString()}); a clock that moved backward grants no time`);
  if (now >= Date.parse(checkpoint.deadline)) refuse(`its deadline ${checkpoint.deadline} has passed`);
  if (checkpoint.loop.attemptedCalls >= resolved.config.operator.maximumTicks) refuse(`it has made all ${resolved.config.operator.maximumTicks} model calls it may attempt`);
  return { resolved, worldId: checkpoint.worldId as WorldId, checkpoint, checkpointSha256: hash };
}

/**
 * Resumes a run that stopped cleanly: the same run ID, stored inputs,
 * history, accounting, deadline, and world, in a new process and execution
 * epoch. Every check runs before the world is attached or started; a refusal
 * changes nothing. Previous commands are never replayed and previous jobs
 * never restarted.
 */
export async function resumeRun(options: ResumeRunOptions): Promise<RunResult> {
  return resumeEpisode(options, null);
}

/** `resumeRun` with optional supervision (managed-run.ts). */
export async function resumeEpisode(options: ResumeRunOptions, supervision: EpisodeSupervision | null): Promise<RunResult> {
  const { clock, layout } = options;
  let runId: RunId;
  try {
    runId = parseRunId(options.runId);
  } catch (error) {
    throw new RunRefusedError(messageOf(error));
  }
  const paths = runPaths(layout, runId);
  // The run's own records are read only under its lock; the world's lock is taken once they name it.
  const runLock = await acquireOwnership(layout.locks, "run", runId, clock);
  let worldLock: Ownership | null = null;
  let world: RunnableWorld | null = null;
  let records: RunRecorder | null = null;
  let campaign: Campaign | null = null;
  try {
    const plan = await resumePlan(paths, runId, clock);
    const { resolved, worldId, checkpoint } = plan;
    const { config } = resolved;
    refuseUnrunnable(config);
    if (supervision !== null && clock.now().getTime() + supervisedDeadlineMarginMs(config) >= Date.parse(checkpoint.deadline)) {
      throw new RunRefusedError(`run ${runId} cannot be resumed: its deadline ${checkpoint.deadline} leaves no time for a supervised tick and its stop`);
    }
    const { mind, rates } = options.mind ?? createMind(resolved);
    if (config.mind.provider !== "fake" && checkpoint.campaign === null) {
      throw new RunRefusedError(`run ${runId} cannot be resumed: its checkpoint names no shared spending campaign`);
    }
    campaign = await openRunCampaign(config, rates, checkpoint.campaign);
    const ledger = new CostLedger(config.operator.maximumEstimatedCostUsd, rates, checkpoint.ledger);
    const smallest = microUsd(config.mind.maximumOutputTokens, rates.outputUsdPerMillionTokens);
    if (ledger.remainingMicroUsd < smallest || (ledger.remainingMicroUsd <= 0 && checkpoint.ledger.limitMicroUsd > 0)) {
      throw new RunRefusedError(`run ${runId} cannot be resumed: ${ledger.remainingMicroUsd} micro-USD of its spending limit remain; a request reserves at least ${smallest}`);
    }

    worldLock = await acquireOwnership(layout.locks, "world", worldId, clock);
    world = await (options.openWorld ?? defaultOpener)(
      { layout, worldId, ownership: worldLock, clock, allowPrivilegedHelper: options.allowPrivilegedHelper },
      runtimeSettings(config),
    );
    const identity = world.identity;
    const changed = [
      identity.engineId !== checkpoint.world.engineId ? "engine" : null,
      identity.storageIdentity !== checkpoint.world.storageUuid ? "storage" : null,
      identity.image !== checkpoint.world.image ? "image" : null,
    ].filter((item) => item !== null);
    if (changed.length > 0) throw new RunRefusedError(`run ${runId} cannot be resumed: the world's ${changed.join(", ")} identity differs from its checkpoint`);
    const violation = await fenceViolation(worldPaths(layout, worldId), checkpoint.worldFence);
    if (violation !== null) throw new RunRefusedError(`run ${runId} cannot be resumed: ${violation}`);
    const status = await world.inspect();
    if (status.container !== "absent" && status.container !== "stopped") {
      throw new RunRefusedError(`run ${runId} cannot be resumed: world ${worldId}'s container is ${status.container}`);
    }

    const limitBytes = config.operator.recordLimitMiB * MiB;
    records = await RunRecorder.open({ paths, runId, clock, limitBytes, reservedBytes: supervision?.reservedBytes ?? 0 });
    if (records.remainingBytes() < tickRecordReserveBytes(config)) {
      throw new RunRefusedError(`run ${runId} cannot be resumed: ${records.remainingBytes()} bytes of record capacity remain; a tick may need ${tickRecordReserveBytes(config)}`);
    }
    const free = await (options.hostFreeMiB ?? (() => hostFree(layout)))();
    if (free < config.operator.minimumHostFreeMiB) {
      throw new RunRefusedError(`run ${runId} cannot be resumed: the state directory's filesystem has ${free} MiB free; ${config.operator.minimumHostFreeMiB} MiB are required`);
    }
    return await episode({
      options,
      resolved,
      worldId,
      runId,
      paths,
      world,
      records,
      adapter: mind,
      rates,
      runOwnership: runLock,
      manifestSha256: null,
      supervision,
      campaign,
      resume: { checkpoint, checkpointSha256: plan.checkpointSha256 },
    });
  } finally {
    await supervision?.end().catch(() => undefined);
    await world?.close().catch(() => undefined);
    await records?.close().catch(() => undefined);
    await campaign?.close().catch(() => undefined);
    await Promise.all([worldLock?.release().catch(() => undefined), runLock.release().catch(() => undefined)]);
  }
}

async function hostFree(layout: StateLayout): Promise<number> {
  const free = await statfs(layout.root);
  return Math.floor((free.bavail * free.bsize) / MiB);
}

// ---------------------------------------------------------------------------

function counts(state: LoopState): Pick<RunResult, "completedTicks" | "attemptedCalls" | "respondedCalls"> {
  return { completedTicks: state.completedTicks, attemptedCalls: state.attemptedCalls, respondedCalls: state.respondedCalls };
}

/**
 * A stop that threw: its result says nothing was verified, and it keeps
 * whatever the world's safety condition shows, unsealed and requiring review.
 * An empty issue list here would wrongly suggest nothing was uncertain.
 */
function failedStop(world: RunnableWorld, error: unknown): WorldStopResult {
  const snapshot = world.safety();
  return {
    verified: false,
    recorded: false,
    detail: `the stop failed: ${messageOf(error)}`,
    safety: snapshot === null ? noEpochAssessment(true) : { ...snapshot, reviewRequired: true, sealed: false },
  };
}

/** Why a run that cannot be checkpointed ends for review, most specific cause first. */
function judge(end: LoopEnd, stopped: WorldStopResult, certified: boolean, uncertaintyRecorded: boolean, supervised: { readonly eligible: boolean; readonly detail: string }): { reason: StopReason; detail: string } {
  const uncertain = stopped.safety.uncertainEffects;
  if (uncertain.length > 0) {
    const ids = uncertain.map((effect) => effect.jobId).join(", ");
    return { reason: "uncertain_action", detail: `the outcome of ${ids} is uncertain; the run ${end.clean ? `would have ended for ${end.reason}` : `ended: ${end.detail}`}` };
  }
  if (stopped.safety.reviewCauses.length > 0) {
    const what = stopped.safety.reviewCauses.map((cause) => `a ${cause.requestedBy} signal to ${cause.jobId}`).join(", ");
    return { reason: "uncertain_signal", detail: `the delivery of ${what} is unknown` };
  }
  if (!end.clean) return { reason: end.reason, detail: end.detail };
  if (!stopped.verified) return { reason: end.reason, detail: `the world stop could not be verified: ${stopped.detail}` };
  if (!stopped.recorded || stopped.safety.requiredEvidenceFailed || !uncertaintyRecorded) {
    return { reason: "record_failure", detail: `the world stopped, but its stop was not fully recorded: ${stopped.detail}` };
  }
  if (!certified) return { reason: end.reason, detail: "the world stop produced no sealed, review-free assessment of this run's execution epoch" };
  if (!supervised.eligible) return { reason: "watchdog_expired", detail: `the world stopped, but its supervision evidence is incomplete: ${supervised.detail}` };
  return { reason: end.reason, detail: end.detail };
}

interface EpisodeSetup {
  readonly options: Omit<StartRunOptions, "resolved" | "worldId" | "onCreated">;
  readonly resolved: ResolvedConfig;
  readonly worldId: WorldId;
  readonly runId: RunId;
  readonly paths: RunPaths;
  readonly world: RunnableWorld;
  readonly records: RunRecorder;
  readonly adapter: MindAdapter;
  readonly rates: CostRates;
  readonly runOwnership: Ownership;
  /** For a new run; a resumed run was created by an earlier process. */
  readonly manifestSha256: string | null;
  readonly supervision: EpisodeSupervision | null;
  /** The shared spending campaign every model call is also admitted against; null for the fake mind. */
  readonly campaign: Campaign | null;
  readonly resume: { readonly checkpoint: Checkpoint; readonly checkpointSha256: string } | null;
}

async function episode(setup: EpisodeSetup): Promise<RunResult> {
  const { options, runId, paths, world, records, adapter: mind, resolved, supervision, resume, campaign } = setup;
  const campaignBinding = campaign === null ? null : { campaignId: campaign.campaignId, directory: campaign.directory };
  const spend: SpendAuthority | null =
    campaign === null || campaignBinding === null
      ? null
      : {
          identity: campaignBinding,
          reserve: async (requestId, microUsd) => (await campaign.reserve({ runId, requestId, maximumMicroUsd: microUsd })) !== null,
          settle: (requestId, settlement) => campaign.settle({ runId, requestId, ...settlement }),
        };
  const { clock } = options;
  const { config } = resolved;
  let state: RunState = resume === null ? "created" : "stopped_clean";
  // A state counts as entered only once its event is durable.
  const enter = async (next: RunState, data: Readonly<Record<string, unknown>>, event: EventType = STATE_EVENTS[next], durable = true): Promise<void> => {
    const checked = transition(state, next);
    await records.append(event, data, { durable });
    state = checked;
  };
  const initial = resume === null ? { completedTicks: 0, attemptedCalls: 0, respondedCalls: 0 } : counts(resume.checkpoint.loop);
  const finish = (reason: StopReason, detail: string, extra: Partial<RunResult> = {}): RunResult => ({
    runId,
    state,
    reason,
    detail,
    ...initial,
    checkpointSha256: null,
    worldStop: null,
    recorded: true,
    ...extra,
  });
  // The run's original absolute deadline: a resume keeps it.
  const deadline = resume === null ? new Date(clock.now().getTime() + config.operator.maximumRunSeconds * 1000) : new Date(resume.checkpoint.deadline);
  const supervised = supervision === null ? {} : { supervision: supervision.declaration };

  if (resume === null) {
    await records.append(
      "run.created",
      {
        worldId: setup.worldId,
        configSha256: resolved.configSha256,
        manifestSha256: setup.manifestSha256,
        identity: world.identity,
        ...supervised,
        ...(campaignBinding === null ? {} : { campaign: campaignBinding, mind: describeMind(config, setup.rates) }),
      },
      { durable: true },
    );
  }

  /**
   * Nothing was started. A new run ends here; a resume is refused, leaving the
   * run as it was (its clean checkpoint still the latest execution).
   */
  const notStarted = async (reason: StopReason, detail: string): Promise<RunResult> => {
    if (resume !== null) throw new RunRefusedError(`run ${runId} was not resumed: ${detail}`);
    await enter("completed", { reason, detail });
    return finish(reason, detail);
  };

  if (supervision !== null) {
    // A supervised start neither captures nor creates anything once a stop was requested.
    if (options.signal.aborted || supervision.signal.aborted) return notStarted("operator_stop", "the operator stopped the run before its world started");
    let refusal: string | null;
    try {
      refusal = await supervision.begin({
        runId,
        worldId: setup.worldId,
        layout: options.layout,
        paths,
        records,
        world,
        runOwnership: setup.runOwnership,
        deadline,
        clock,
        config,
        tickReserveBytes: tickRecordReserveBytes(config),
        resumed: resume !== null,
      });
    } catch (error) {
      refusal = `its supervision could not begin: ${messageOf(error)}`;
    }
    if (refusal !== null) return notStarted("world_start_failed", refusal);
  }

  try {
    await world.attach();
  } catch (error) {
    return notStarted("world_start_failed", `attaching the world failed; nothing was started: ${messageOf(error)}`);
  }
  if (resume === null) await enter("ready", { identity: world.identity });

  try {
    await world.start(supervision?.startHooks);
  } catch (error) {
    // A start can fail after the container is running (for example, when a record fails). The world
    // may have stopped itself: its cleanup is kept as evidence, since an absent container proves it
    // is not running, not that stopping it was fully recorded. Anything not known stopped is stopped here.
    const cleanup = world.startCleanup;
    const status = await world.inspect().catch(() => null);
    let stopped = status !== null && (status.container === "absent" || status.container === "stopped");
    let worldStop: WorldStopResult | null = null;
    if (!stopped) {
      worldStop = await world.stop("world_start_failed").catch((stopError: unknown) => failedStop(world, stopError));
      stopped = worldStop.verified;
    }
    const released = supervision === null ? { eligible: true, detail: "" } : await supervision.afterStop(worldStop ?? cleanup, { capture: false });
    const detail = `starting the world failed; no action ran: ${messageOf(error)}`;
    // A resumed run whose new epoch never created anything stays as it was.
    if (resume !== null && cleanup === null && worldStop === null && stopped) throw new RunRefusedError(`run ${runId} was not resumed: ${detail}`);
    // Every stop's own records must be complete, and no stop may report anything requiring review.
    // (A start that failed before admitting any execution has nothing uncertain to report.)
    const flagged = [cleanup, worldStop].some((result) => result !== null && (result.safety.uncertainEffects.length > 0 || result.safety.requiredEvidenceFailed));
    const recorded = (cleanup?.recorded ?? true) && (worldStop?.recorded ?? true) && !flagged && released.eligible;
    await enter(stopped && recorded ? "completed" : "recovery_required", {
      reason: "world_start_failed",
      detail,
      container: status?.container ?? "unknown",
      startCleanup: cleanup,
      worldStop,
      ...(supervision === null ? {} : { supervision: released.detail }),
    });
    return finish("world_start_failed", detail, { worldStop: worldStop ?? cleanup });
  }

  // From here the world is running: every path below stops it.
  let stop: WorldStopResult | null = null;
  const stopWorld = async (reason: StopReason): Promise<WorldStopResult> => {
    stop ??= await world.stop(reason).catch((error: unknown) => failedStop(world, error));
    return stop;
  };
  // The run's one writer of uncertainty evidence, shared by the loop and finalization.
  const uncertainty = new UncertaintyRecorder((type, data, append) => records.append(type, data, append));
  // The execution epoch this run started; only its sealed assessment can certify the run.
  const epochId = world.safety()?.epochId ?? null;
  let loop: TickLoop | null = null;
  let end: LoopEnd = { clean: false, reason: "controller_interrupted", detail: "the run ended before its loop started" };
  const signal = supervision === null ? options.signal : AbortSignal.any([options.signal, supervision.signal]);
  let released: { readonly eligible: boolean; readonly detail: string } | null = null;
  const afterStop = async (stopped: WorldStopResult) => {
    released ??= supervision === null ? { eligible: true, detail: "" } : await supervision.afterStop(stopped, { capture: true });
    return released;
  };
  try {
    // Entering `running` is made durable by the next durable record: the first request's, or the
    // lifecycle record that ends the run. Either precedes every effect the running state can have.
    if (resume === null) {
      await enter("running", { deadline: deadline.toISOString(), epochId, ...supervised }, STATE_EVENTS.running, false);
    } else {
      await enter(
        "running",
        {
          deadline: deadline.toISOString(),
          epochId,
          resumedFrom: resume.checkpointSha256,
          completedTicks: resume.checkpoint.loop.completedTicks,
          discontinuity: RESUME_DISCONTINUITY,
          ...supervised,
        },
        "run.resumed",
        false,
      );
    }
    const ledger = new CostLedger(config.operator.maximumEstimatedCostUsd, setup.rates, resume?.checkpoint.ledger ?? null);
    loop = new TickLoop({
      world,
      mind,
      policy: (config.body.contextPolicy === RECENT_COMPLETE_EXCHANGES_V3 ? recentCompleteExchangesV3 : recentCompleteExchanges)({
        budgetTokens: config.body.contextBudgetTokens,
        maximumOutputTokens: config.mind.maximumOutputTokens,
        marginTokens: config.body.contextMarginTokens,
        estimator: tokenEstimator(config.body.tokenEstimator),
      }),
      records,
      ledger,
      clock,
      settings: {
        runId,
        instructions: resolved.prompt.text,
        tools: resolved.tools,
        maximumTicks: config.operator.maximumTicks,
        deadline,
        maximumConsecutiveProtocolErrors: config.operator.maximumConsecutiveProtocolErrors,
        minimumTickIntervalMs: config.body.minimumTickIntervalMs,
        requestTimeoutMs: config.mind.requestTimeoutMs,
        maximumOutputTokens: config.mind.maximumOutputTokens,
        maximumCommandBytes: config.body.maximumCommandBytes,
        perceivedOutputBytes: config.body.perceivedOutputBytes,
        exposeContextUsage: config.body.exposeContextUsage,
        tickRecordReserveBytes: tickRecordReserveBytes(config),
        ...(supervision === null ? {} : { deadlineMarginMs: supervisedDeadlineMarginMs(config) }),
        minimumHostFreeMiB: config.operator.minimumHostFreeMiB,
        hostFreeMiB: options.hostFreeMiB ?? (() => hostFree(options.layout)),
      },
      ...(resume === null ? {} : { state: resume.checkpoint.loop, resumed: true }),
      ...(options.onTick === undefined ? {} : { onTick: options.onTick }),
      ...(supervision === null ? {} : { admission: () => supervision.denial(), boundary: (name: LoopBoundary) => supervision.boundary(name) }),
      ...(spend === null ? {} : { spend }),
      uncertainty,
    });

    end = await loop.run(signal);
    if (end.clean) {
      try {
        await enter("stopping", { reason: end.reason, detail: end.detail });
      } catch (error) {
        end = { clean: false, reason: "record_failure", detail: `recording the stop failed: ${messageOf(error)}` };
      }
    }
    // However the loop ended, the world is stopped: an unclean end needs review, not a live world.
    // The loop's clean end is provisional; the stop's actual assessment decides.
    const stopped = await stopWorld(end.reason);
    if (stopped.verified) await supervision?.boundary("after_world_stop");
    const loopState = loop.state;
    // Uncertainty the stop assessment reports (for example, established while stopping) is recorded
    // as evidence for the affected actions; earlier reports are deduplicated.
    await uncertainty.record(stopped.safety.uncertainEffects, "stop", null);
    const certified = epochId !== null && certifiesClean(stopped.safety, epochId);
    // Protection is released only after a verified stop; the stopped world is then captured.
    const evidence = await afterStop(stopped);
    // A checkpoint needs a clean end, a verified and fully recorded stop, a sealed review-free
    // assessment of this run's epoch, complete run-level uncertainty evidence, and, when
    // supervised, a verified release of the watchdog.
    if (end.clean && stopped.verified && stopped.recorded && certified && uncertainty.complete && evidence.eligible) {
      // Durable with the checkpoint's publication; until then the checkpoint file is an orphan nothing trusts.
      await records.append("world.stopped", { reason: end.reason, detail: stopped.detail, safety: stopped.safety });
      const identity = world.identity;
      const checkpoint = await writeCheckpoint(paths, {
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        runId,
        worldId: setup.worldId,
        writtenAt: clock.now().toISOString(),
        state: cleanEndState(end.reason),
        stopReason: end.reason,
        configSha256: resolved.configSha256,
        world: { engineId: identity.engineId, storageUuid: identity.storageIdentity, image: identity.image },
        deadline: deadline.toISOString(),
        lastEventSequence: records.lastSequence,
        loop: loopState,
        ledger: ledger.snapshot(),
        worldStop: { verified: true, recorded: true, detail: stopped.detail },
        safety: stopped.safety,
        worldFence: await worldFence(worldPaths(options.layout, setup.worldId)),
        campaign: campaignBinding,
      }, (file, bytes) => records.writeFile(file, bytes));
      await supervision?.boundary("after_checkpoint_file");
      // Durable with the terminal record that follows it: a checkpoint counts only once both are.
      await records.append(
        "checkpoint.written",
        { sha256: checkpoint.sha256, bytes: checkpoint.bytes, file: path.relative(paths.directory, checkpoint.file), completedTicks: loopState.completedTicks },
      );
      await enter(cleanEndState(end.reason), { reason: end.reason, detail: end.detail, checkpointSha256: checkpoint.sha256 });
      await supervision?.boundary("after_terminal_record");
      return finish(end.reason, end.detail, { ...counts(loopState), checkpointSha256: checkpoint.sha256, worldStop: stopped });
    }
    const judged = judge(end, stopped, certified, uncertainty.complete, evidence);
    return await review(judged.reason, judged.detail, stopped, counts(loopState), end.reason);
  } catch (error) {
    // Something failed while starting the loop, stopping, or checkpointing: the run needs review.
    const stopped = await stopWorld(end.reason);
    await uncertainty.record(stopped.safety.uncertainEffects, "stop", null);
    await afterStop(stopped).catch(() => undefined);
    const reason: StopReason = stopped.safety.uncertainEffects.length > 0 ? "uncertain_action" : end.reason;
    return await review(reason, `ending the run failed: ${messageOf(error)}`, stopped, loop === null ? {} : counts(loop.state), end.reason);
  }

  async function review(reason: StopReason, detail: string, worldStop: WorldStopResult, tallies: Partial<RunResult>, requestedReason: StopReason): Promise<RunResult> {
    let recorded = true;
    try {
      await enter("recovery_required", { reason, requestedReason, detail, worldStop, uncertaintyRecorded: uncertainty.complete });
    } catch {
      // The log cannot take it; the log's last state then shows the run as interrupted.
      recorded = false;
    }
    return finish(reason, detail, { state: "recovery_required", ...tallies, worldStop, recorded });
  }
}
