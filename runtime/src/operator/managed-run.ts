import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { z } from "zod";

import type { Clock } from "../core/clock.ts";
import type { ArchiveResult, WorldStopResult } from "../core/contracts.ts";
import { messageOf } from "../core/errors.ts";
import { isArchiveId, parseRunId, type RunId, type WorldId } from "../core/ids.ts";
import { RecordCapacityError } from "../records/events.ts";
import { syncDirectory } from "../records/files.ts";
import { runPaths, type RunPaths, type RunRecorder } from "../records/run-store.ts";
import { CAPTURE_TIMEOUT_MS, type CaptureLimits } from "../world/archive.ts";
import type { DockerContext } from "../world/engine.ts";
import { worldPaths } from "../world/metadata.ts";
import { inspectOwnership } from "./locks.ts";
import {
  resumeEpisode,
  startEpisode,
  type BoundaryName,
  type EpisodeSupervision,
  type ResumeRunOptions,
  type RunnableWorld,
  type RunResult,
  type StartRunOptions,
  type SupervisionContext,
} from "./run.ts";
import type { StateLayout } from "./state-dir.ts";
import { startWatchdog, WATCHDOG_SUPERVISION, type LaunchOptions, type WatchdogBinding, type WatchdogHandle, type WatchdogResult } from "./watchdog.ts";

// Managed episodes (plan §5): the lifecycle of run.ts under independent
// supervision. Before the world's container starts, a watchdog process is
// armed for exactly that container; every model call, command, and agent
// signal is then admitted only while the controller's own lease is live; a
// run-local control endpoint takes authenticated stop requests; and the
// stopped world is captured before and after each execution epoch. Losing
// supervision never recovers within a run: it ends for review.

/** Journal bytes one epoch's watchdog may add; reserved from the run's record limit before it starts. */
export const WATCHDOG_JOURNAL_ALLOWANCE = 64 << 10;
/** Lease, descriptors, and their temporary copies. */
const SUPERVISION_FILE_ALLOWANCE = 16 << 10;
/** Below this, a capture could not hold even a small world and is not attempted. */
const MINIMUM_CAPTURE_BYTES = 64 << 10;
const CONTROL_REQUEST_BYTES = 4096;
const CONTROL_TIMEOUT_MS = 10_000;

export type LaunchWatchdog = (options: LaunchOptions) => Promise<WatchdogHandle>;

export interface ManagedRunOptions extends StartRunOptions {
  /** How the watchdog process is launched; the production launcher by default. */
  readonly launchWatchdog?: LaunchWatchdog;
  /** Awaited at declared lifecycle points (crash-test instrumentation); nothing by default. */
  readonly onBoundary?: (name: BoundaryName, identity: { readonly runId: RunId; readonly worldId: WorldId }) => Promise<void>;
}

export interface ManagedResumeOptions extends ResumeRunOptions {
  readonly launchWatchdog?: LaunchWatchdog;
  readonly onBoundary?: ManagedRunOptions["onBoundary"];
}

/** What supervision needs from a world beyond running it: its engine's context and stopped-world capture. */
interface SupervisableWorld extends RunnableWorld {
  readonly dockerContext: DockerContext;
  captureArtifacts(label: string, limits?: CaptureLimits): Promise<ArchiveResult>;
}

function supervisable(world: RunnableWorld): world is SupervisableWorld {
  const candidate = world as Partial<SupervisableWorld>;
  return typeof candidate.captureArtifacts === "function" && typeof candidate.dockerContext === "object" && candidate.dockerContext !== null;
}

/** Runs one episode under watchdog supervision. The CLI's `run start`. */
export function startManagedRun(options: ManagedRunOptions): Promise<RunResult> {
  return startEpisode(options, new ManagedSession(options));
}

/** Resumes a cleanly stopped run under watchdog supervision. The CLI's `run resume`. */
export function resumeManagedRun(options: ManagedResumeOptions): Promise<RunResult> {
  return resumeEpisode(options, new ManagedSession(options));
}

const controlDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string(),
  epochId: z.string().min(1).max(128),
  controllerToken: z.string().regex(/^[a-f0-9]{32}$/),
  socketPath: z.string(),
});

const controlRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  command: z.literal("stop"),
  runId: z.string(),
  epochId: z.string(),
  controllerToken: z.string(),
});

const controlReplySchema = z.strictObject({ accepted: z.boolean(), reason: z.string().max(1024) });

/** Replaces a private operational file atomically; durably when it must outlive a host crash. */
async function writePrivate(file: string, content: string, options: { readonly durable: boolean }): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(content);
    if (options.durable) await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  if (options.durable) await syncDirectory(path.dirname(file));
}

/** Longest Unix socket path the platform accepts (`sockaddr_un`: 104 bytes on macOS, 108 on Linux, with the terminator). */
const SOCKET_PATH_BYTES = 103;

/**
 * Runs `use` with the socket addressed by a path it can bind or connect to.
 * A run-local socket whose absolute path is too long for the platform is
 * addressed relative to its directory; the working directory is changed and
 * restored synchronously around the call, which binds or starts connecting
 * before returning, so nothing else runs in between.
 */
export function viaSocketPath<T>(file: string, use: (address: string) => T): T {
  if (Buffer.byteLength(file) <= SOCKET_PATH_BYTES) return use(file);
  const home = process.cwd();
  process.chdir(path.dirname(file));
  try {
    return use(`./${path.basename(file)}`);
  } finally {
    process.chdir(home);
  }
}

async function removeIfPresent(file: string): Promise<void> {
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

class ManagedSession implements EpisodeSupervision {
  readonly declaration = WATCHDOG_SUPERVISION;
  readonly reservedBytes = WATCHDOG_JOURNAL_ALLOWANCE + SUPERVISION_FILE_ALLOWANCE;
  readonly #stop = new AbortController();
  readonly #options: ManagedRunOptions | ManagedResumeOptions;
  /** The control endpoint's session: requests must name it. */
  readonly #session = randomUUID();
  #context: (SupervisionContext & { readonly world: SupervisableWorld }) | null = null;
  #handle: WatchdogHandle | null = null;
  /** Why supervision was lost; lasting once set. */
  #lost: string | null = null;
  /** The lease's local expiry in this process's monotonic time. */
  #expiry = Number.NEGATIVE_INFINITY;
  #leaseMs = 0;
  #heartbeat: NodeJS.Timeout | null = null;
  #beating = false;
  #releasing = false;
  #released: WatchdogResult | null = null;
  #server: net.Server | null = null;
  #controlWritten = false;

  constructor(options: ManagedRunOptions | ManagedResumeOptions) {
    this.#options = options;
  }

  get signal(): AbortSignal {
    return this.#stop.signal;
  }

  #requireContext(): SupervisionContext & { readonly world: SupervisableWorld } {
    if (this.#context === null) throw new Error("supervision has not begun");
    return this.#context;
  }

  async begin(context: SupervisionContext): Promise<string | null> {
    const { world } = context;
    if (!supervisable(world)) return "this world cannot be supervised: it has no engine context or stopped-world capture";
    this.#context = { ...context, world };
    this.#leaseMs = context.config.operator.watchdogLeaseSeconds * 1000;
    try {
      await this.#openControl(context.paths, context);
    } catch (error) {
      return `the run's control endpoint could not be created: ${messageOf(error)}`;
    }
    const initial = await this.#capture("initial");
    if (initial === null) return "the initial capture of the stopped world failed; nothing was started";
    if (!initial.complete) return `the initial capture of the stopped world is incomplete (${initial.omissions.join("; ")}); nothing was started`;
    return null;
  }

  readonly startHooks = {
    beforeContainerStart: (containerId: string, epochId: string) => this.#arm(containerId, epochId),
    admit: (): string | null => {
      const denied = this.denial();
      if (denied !== null) return denied;
      if (this.#handle === null) return "the watchdog is not armed";
      if (this.#stop.signal.aborted || this.#options.signal.aborted) return "a stop was requested";
      const context = this.#requireContext();
      if (context.clock.now().getTime() >= context.deadline.getTime()) return `the run's deadline ${context.deadline.toISOString()} passed`;
      return null;
    },
  };

  async #arm(containerId: string, epochId: string): Promise<void> {
    const context = this.#requireContext();
    const { paths, world, clock, config } = context;
    if (this.#handle !== null) throw new Error("the watchdog is already armed for this session");
    const binding: WatchdogBinding = {
      schemaVersion: 1,
      runId: context.runId,
      worldId: context.worldId,
      epochId,
      controllerToken: context.runOwnership.record.token,
      engineId: world.identity.engineId,
      containerId,
      deadline: context.deadline.toISOString(),
      leaseMs: this.#leaseMs,
    };
    const journal = await lstat(paths.watchdogJournal).then((info) => info.size, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
    const launch: LaunchOptions = {
      leaseFile: paths.lease,
      journalFile: paths.watchdogJournal,
      binding,
      context: world.dockerContext,
      pollIntervalMs: Math.min(1000, Math.max(50, Math.floor(this.#leaseMs / 20))),
      maximumJournalBytes: journal + WATCHDOG_JOURNAL_ALLOWANCE,
    };
    // The lease counts from before the launcher writes it, so the controller's view never outlasts the watchdog's.
    this.#expiry = clock.monotonicMs() + this.#leaseMs;
    const handle = await (this.#options.launchWatchdog ?? startWatchdog)(launch);
    this.#handle = handle;
    void handle.completed.then((result) => {
      if (!this.#releasing) this.#latch(`the watchdog ended unexpectedly (${result.outcome}: ${result.reason})`);
    });
    const heartbeatIntervalMs = config.operator.heartbeatIntervalSeconds * 1000;
    // Durable: after a crash, it says which process guards which container.
    await writePrivate(
      paths.watchdogDescriptor,
      `${JSON.stringify({ schemaVersion: 1, pid: handle.pid, binding, leaseFile: launch.leaseFile, journalFile: launch.journalFile, heartbeatIntervalMs }, null, 2)}\n`,
      { durable: true },
    );
    // Made durable with the run's next lifecycle record; the watchdog's own journal and the descriptor
    // above already hold the arming durably before the container starts.
    await context.records.append("supervision.armed", {
      supervision: WATCHDOG_SUPERVISION,
      epochId,
      containerId,
      engineId: binding.engineId,
      watchdogPid: handle.pid,
      leaseMs: this.#leaseMs,
      deadline: binding.deadline,
      heartbeatIntervalMs,
    });
    this.#heartbeat = setInterval(() => void this.#beat(), heartbeatIntervalMs);
  }

  /** Renews the lease; a failure, or a renewal that finds the lease already expired, loses supervision. */
  async #beat(): Promise<void> {
    const handle = this.#handle;
    if (handle === null || this.#beating || this.#lost !== null || this.#releasing) return;
    this.#beating = true;
    try {
      const { clock } = this.#requireContext();
      const started = clock.monotonicMs();
      if (started >= this.#expiry) {
        this.#latch("the controller's lease expired before it was renewed");
        return;
      }
      try {
        await handle.heartbeat();
      } catch (error) {
        this.#latch(`a lease renewal failed: ${messageOf(error)}`);
        return;
      }
      // A renewal that completes after the lease expired cannot revive it.
      if (clock.monotonicMs() >= this.#expiry) {
        this.#latch("the controller's lease expired while it was being renewed");
        return;
      }
      this.#expiry = started + this.#leaseMs;
    } finally {
      this.#beating = false;
    }
  }

  #latch(reason: string): void {
    if (this.#lost !== null) return;
    this.#lost = reason;
    this.#stopHeartbeat();
    const records = this.#context?.records;
    void records?.append("supervision.lost", { reason }, { durable: true }).catch(() => undefined);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  denial(): string | null {
    if (this.#lost !== null) return this.#lost;
    if (this.#handle !== null && this.#context !== null && this.#context.clock.monotonicMs() >= this.#expiry) {
      this.#latch("the controller's lease expired");
    }
    return this.#lost;
  }

  async boundary(name: BoundaryName): Promise<void> {
    const context = this.#requireContext();
    const observe = this.#options.onBoundary;
    if (observe === undefined) return;
    // A host that observes a boundary sees every record made before it durable.
    await context.records.sync();
    await observe(name, { runId: context.runId, worldId: context.worldId });
  }

  async afterStop(stop: WorldStopResult | null, options: { readonly capture: boolean }): Promise<{ readonly eligible: boolean; readonly detail: string }> {
    this.#stopHeartbeat();
    const context = this.#context;
    const handle = this.#handle;
    // A start refused before its watchdog was armed started nothing it would have had to guard.
    if (context === null || handle === null) return { eligible: !options.capture, detail: "no watchdog was armed" };
    if (stop === null || !stop.verified) {
      // Protection stays: the watchdog expires and stops the exact container itself.
      return { eligible: false, detail: "the world stop was not verified; the watchdog keeps protecting the world" };
    }
    let result: WatchdogResult;
    if (this.#released !== null) result = this.#released;
    else {
      this.#releasing = true;
      try {
        result = await handle.release();
      } catch (error) {
        result = { outcome: "unknown", verified: false, reason: `the release failed: ${messageOf(error)}`, containerId: null };
      }
      this.#released = result;
      // Made durable with the records that end the run.
      await context.records
        .append("supervision.released", { outcome: result.outcome, verified: result.verified, reason: result.reason, containerId: result.containerId })
        .catch(() => undefined);
    }
    if (options.capture) await this.#capture("final");
    if (this.#lost !== null) return { eligible: false, detail: `supervision was lost during the run: ${this.#lost}` };
    if (result.outcome !== "released" || !result.verified) return { eligible: false, detail: `the watchdog did not confirm a verified release (${result.outcome}: ${result.reason})` };
    return { eligible: true, detail: result.reason };
  }

  async end(): Promise<void> {
    this.#stopHeartbeat();
    const server = this.#server;
    this.#server = null;
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    const context = this.#context;
    if (context !== null && this.#controlWritten) {
      await removeIfPresent(context.paths.control).catch(() => undefined);
      await removeIfPresent(context.paths.controlSocket).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Control endpoint

  async #openControl(paths: RunPaths, context: SupervisionContext): Promise<void> {
    // A socket left by an earlier controller of this run is ours to replace: the run lock is held.
    const stale = await lstat(paths.controlSocket).catch(() => null);
    if (stale !== null) {
      if (!stale.isSocket()) throw new Error(`${paths.controlSocket} exists and is not a socket`);
      await unlink(paths.controlSocket);
    }
    const server = net.createServer((socket) => this.#serve(socket, context));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      viaSocketPath(paths.controlSocket, (address) =>
        server.listen(address, () => {
          server.off("error", reject);
          resolve();
        }),
      );
    });
    server.on("error", () => undefined);
    this.#server = server;
    this.#controlWritten = true;
    const descriptor = { schemaVersion: 1, runId: context.runId, epochId: this.#session, controllerToken: context.runOwnership.record.token, socketPath: paths.controlSocket };
    // Meaningful only while this process lives, so it need not survive a host crash.
    await writePrivate(paths.control, `${JSON.stringify(descriptor, null, 2)}\n`, { durable: false });
  }

  #serve(socket: net.Socket, context: SupervisionContext): void {
    socket.setTimeout(CONTROL_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => undefined);
    let input = "";
    let answered = false;
    socket.on("data", (chunk: Buffer) => {
      if (answered) return;
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > CONTROL_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const end = input.indexOf("\n");
      if (end === -1) return;
      answered = true;
      void this.#answer(input.slice(0, end), context).then((reply) => socket.end(`${JSON.stringify(reply)}\n`));
    });
  }

  async #answer(line: string, context: SupervisionContext): Promise<{ accepted: boolean; reason: string }> {
    let request: z.infer<typeof controlRequestSchema>;
    try {
      const parsed = controlRequestSchema.safeParse(JSON.parse(line));
      if (!parsed.success) return { accepted: false, reason: "invalid request" };
      request = parsed.data;
    } catch {
      return { accepted: false, reason: "invalid request" };
    }
    if (request.runId !== context.runId || request.epochId !== this.#session || request.controllerToken !== context.runOwnership.record.token) {
      return { accepted: false, reason: "the request does not match this run's controller" };
    }
    if (this.#stop.signal.aborted) return { accepted: true, reason: "a stop was already requested" };
    this.#stop.abort("the operator requested a stop through the run's control endpoint");
    await context.records
      .append("operator.intervention", { action: "stop", via: "control endpoint", when: "requested", reason: "authenticated stop request" }, { durable: true })
      .catch(() => undefined);
    return { accepted: true, reason: "stop requested; the run ends its current step and then stops the world" };
  }

  // -------------------------------------------------------------------------
  // Captures

  /** Captures the stopped world before or after the epoch; null when nothing usable was captured. */
  async #capture(phase: "initial" | "final"): Promise<ArchiveResult | null> {
    const context = this.#requireContext();
    // The initial capture leaves room for the ticks and an equal final capture; the final one for ending the run.
    const available = context.records.remainingBytes() - context.tickReserveBytes;
    const captured = await captureIntoRun({
      world: context.world,
      records: context.records,
      layout: context.layout,
      worldId: context.worldId,
      paths: context.paths,
      phase,
      label: phase,
      budget: phase === "initial" ? Math.floor(available / 2) : available,
    });
    return captured.result;
  }
}

/**
 * Captures a stopped world for a run: the world's own capture, bounded so the
 * copy fits the run's record budget, then a verified copy into the run's
 * records and a durable association (`archive.created`), or an explicit
 * `archive.failed`. Never stops a world to capture it.
 */
export async function captureIntoRun(options: {
  readonly world: { captureArtifacts(label: string, limits?: CaptureLimits): Promise<ArchiveResult> };
  readonly records: RunRecorder;
  readonly layout: StateLayout;
  readonly worldId: WorldId;
  readonly paths: RunPaths;
  readonly phase: "initial" | "final" | "manual";
  readonly label: string;
  /** Record bytes the archive and its manifest may take. */
  readonly budget: number;
}): Promise<{ readonly result: ArchiveResult | null; readonly reason: string | null }> {
  const { records, phase, budget } = options;
  const failed = async (archiveId: string | null, reason: string) => {
    await records.append("archive.failed", { phase, archiveId, label: options.label, reason }, { durable: true });
    return { result: null, reason };
  };
  if (budget < MINIMUM_CAPTURE_BYTES) return failed(null, `only ${Math.max(0, budget)} bytes of record capacity are left for the capture`);
  // An archive's manifest can outgrow the archive (one index entry per 512 bytes); a third leaves room for both.
  const maximumBytes = Math.floor(budget / 3);
  const limits: CaptureLimits = { maximumBytes, maximumEntries: Math.max(1, Math.floor(maximumBytes / 512)), timeoutMs: CAPTURE_TIMEOUT_MS };
  let result: ArchiveResult;
  try {
    result = await options.world.captureArtifacts(options.label, limits);
  } catch (error) {
    return failed(null, `the capture failed: ${messageOf(error)}`);
  }
  if (!isArchiveId(result.archiveId)) return failed(null, "the capture returned an invalid archive ID");
  const source = path.join(worldPaths(options.layout, options.worldId).archives, result.archiveId);
  const target = path.join(options.paths.archives, result.archiveId);
  let copied: { readonly sha256: string };
  try {
    copied = await copyArchive(source, target, records, budget);
  } catch (error) {
    return failed(result.archiveId, error instanceof RecordCapacityError ? `the archive does not fit the run's record limit: ${error.message}` : `copying the archive failed: ${messageOf(error)}`);
  }
  await records.append(
    "archive.created",
    { phase, archiveId: result.archiveId, label: options.label, complete: result.complete, entries: result.entries, bytes: result.bytes, omissions: result.omissions, sha256: copied.sha256 },
    { durable: true },
  );
  return { result, reason: null };
}

/** Copies a captured archive's manifest and tar into the run's records, verifying the tar's hash. */
async function copyArchive(source: string, target: string, records: RunRecorder, budget: number): Promise<{ readonly sha256: string }> {
  const manifestFile = path.join(source, "manifest.json");
  const tarFile = path.join(source, "archive.tar");
  const [manifestInfo, tarInfo] = await Promise.all([lstat(manifestFile), lstat(tarFile)]);
  if (!manifestInfo.isFile() || !tarInfo.isFile()) throw new Error("the captured archive's files are not regular files");
  const total = manifestInfo.size + tarInfo.size;
  if (total > budget) throw new RecordCapacityError(budget);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { archive?: { sha256?: unknown; bytes?: unknown } };
  records.claim(total);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  const hash = createHash("sha256");
  await copyFile(tarFile, path.join(target, "archive.tar"), tarInfo.size, (chunk) => hash.update(chunk));
  const sha256 = hash.digest("hex");
  if (manifest.archive?.sha256 !== sha256 || manifest.archive.bytes !== tarInfo.size) throw new Error("the archive does not match its manifest");
  await copyFile(manifestFile, path.join(target, "manifest.json"), manifestInfo.size, () => undefined);
  await syncDirectory(target);
  return { sha256 };
}

async function copyFile(source: string, target: string, bytes: number, observe: (chunk: Buffer) => void): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      const chunk = Buffer.alloc(Math.min(1 << 20, Math.max(bytes, 1)));
      let copied = 0;
      while (copied < bytes) {
        const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, bytes - copied), copied);
        if (bytesRead === 0) throw new Error(`${source} changed while it was copied`);
        const part = chunk.subarray(0, bytesRead);
        observe(part);
        let written = 0;
        while (written < part.length) written += (await output.write(part, written, part.length - written)).bytesWritten;
        copied += bytesRead;
      }
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

// ---------------------------------------------------------------------------
// Stop requests from another process

/**
 * Asks a run's live controller to stop, through the run's authenticated local
 * control endpoint: one request, at most once. Refuses without contacting
 * anything when the descriptor is missing, malformed, outside the run, or does
 * not match the run's current owner. Never signals a process. A request whose
 * acknowledgement is lost is reported as unknown and not retried.
 */
export async function requestRunStop(options: { readonly layout: StateLayout; readonly runId: RunId; readonly clock: Clock }): Promise<{ readonly accepted: boolean; readonly reason: string }> {
  const runId = parseRunId(options.runId);
  const paths = runPaths(options.layout, runId);
  const refuse = (reason: string) => ({ accepted: false, reason });
  let text: string;
  try {
    const info = await lstat(paths.control);
    if (!info.isFile()) return refuse("the run's control descriptor is not a regular file");
    if (info.size > CONTROL_REQUEST_BYTES) return refuse("the run's control descriptor is too large");
    text = await readFile(paths.control, "utf8");
  } catch (error) {
    return refuse(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `run ${runId} has no control endpoint: no managed controller is running it`
        : `the run's control descriptor is unreadable: ${messageOf(error)}`,
    );
  }
  let descriptor: z.infer<typeof controlDescriptorSchema>;
  try {
    const parsed = controlDescriptorSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return refuse("the run's control descriptor is malformed");
    descriptor = parsed.data;
  } catch {
    return refuse("the run's control descriptor is not valid JSON");
  }
  if (descriptor.runId !== runId) return refuse("the control descriptor belongs to another run");
  if (path.resolve(descriptor.socketPath) !== paths.controlSocket) return refuse("the control descriptor names a socket outside this run's records");
  const owner = await inspectOwnership(options.layout.locks, "run", runId);
  if (owner === null || owner.holder === null) return refuse(`run ${runId} has no live owner`);
  if (owner.holder.token !== descriptor.controllerToken) return refuse("the control descriptor does not match the run's current owner");
  if (owner.appearsAlive === false) return refuse(`run ${runId}'s owner is no longer running`);
  const socketInfo = await lstat(paths.controlSocket).catch(() => null);
  if (socketInfo === null || !socketInfo.isSocket()) return refuse("the run's control socket is missing");

  const request = { schemaVersion: 1, command: "stop", runId, epochId: descriptor.epochId, controllerToken: descriptor.controllerToken };
  return new Promise((resolve) => {
    let reply = "";
    let settled = false;
    const finish = (value: { accepted: boolean; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const unknown = (why: string) =>
      finish(refuse(`the stop request was sent, but ${why}; its outcome is unknown, and it was not retried (check run status)`));
    const socket = viaSocketPath(paths.controlSocket, (address) => net.connect(address));
    const timer = setTimeout(() => unknown("no acknowledgement arrived"), CONTROL_TIMEOUT_MS);
    let sent = false;
    socket.once("connect", () => {
      sent = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString("utf8");
      if (Buffer.byteLength(reply) > CONTROL_REQUEST_BYTES) unknown("the acknowledgement was malformed");
    });
    socket.once("error", (error) => {
      if (sent) unknown(`the connection failed (${messageOf(error)})`);
      else finish(refuse(`the control endpoint is not accepting connections: ${messageOf(error)}`));
    });
    socket.once("close", () => {
      const line = reply.split("\n")[0] ?? "";
      try {
        const parsed = controlReplySchema.safeParse(JSON.parse(line));
        if (parsed.success) {
          finish(parsed.data);
          return;
        }
      } catch {
        // Handled below.
      }
      if (sent) unknown("the acknowledgement was lost");
      else finish(refuse("the control endpoint closed the connection"));
    });
  });
}
