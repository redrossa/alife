import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, statfs } from "node:fs/promises";
import path from "node:path";

import type { Config } from "../config/schema.ts";
import type { ResolvedConfig } from "../config/resolve.ts";
import type { Clock } from "../core/clock.ts";
import type {
  ActionRequest,
  ArchiveResult,
  DispatchHooks,
  JobSignal,
  JobSnapshot,
  Metric,
  SignalResult,
  StartHooks,
  WorldBackend,
  WorldIdentity,
  WorldSample,
  WorldStatus,
  WorldStopResult,
} from "../core/contracts.ts";
import { messageOf } from "../core/errors.ts";
import { certifiesClean, ExecutionSafety, noEpochAssessment, type ExecutionSafetySnapshot, type StopSafetyAssessment } from "../core/execution-safety.ts";
import { newArchiveId, type WorldId } from "../core/ids.ts";
import type { StopReason } from "../core/state.ts";
import type { Ownership } from "../operator/locks.ts";
import type { StateLayout } from "../operator/state-dir.ts";
import { JsonlEventLog, readEventLog, WORLD_EVENT_TYPES, type WorldEventType } from "../records/events.ts";
import { CAPTURE_COVERAGE, captureInto, captureLimits, type CaptureLimits } from "./archive.ts";
import { API_VERSION, DockerEngine, EngineResponseError, EngineUnavailableError, num, record, resolveDockerContext, str, type DockerContext } from "./engine.ts";
import { dockerExecTransport, runControl, type ExecTransport } from "./exec.ts";
import { JobTable } from "./jobs.ts";
import { createWorldDirectory, readWorldMetadata, worldPaths, writeNewFile, writeWorldMetadata, type WorldMetadata, type WorldPaths } from "./metadata.ts";
import { parseSensorReading, parseStartupFacts, SENSOR_SCRIPT, sensorArguments, STARTUP_SCRIPT, startupViolations } from "./probes.ts";
import {
  containersUsingVolume,
  expectContainer,
  inspectContainer,
  inspectImage,
  labels,
  parseContainer,
  removeContainer,
  resourceNames,
  type ContainerInfo,
} from "./resources.ts";
import { loadSeed } from "./seeds.ts";
import { isClean, LoopExt4Storage, PrivilegeRequiredError, type HelperRecorder, type Superblock } from "./storage.ts";

// The Docker world backend (plan §7, §8): one persistent world, one owner.
// Every operation runs under the world lock and records what it did in the
// world's own event log. Nothing is created implicitly, repaired, or retried;
// anything that cannot be verified stops the operation and says why.

const MiB = 1 << 20;
const WORLD_LOG_LIMIT_BYTES = 256 * MiB;
const STOP_GRACE_SECONDS = 5;
const PATH_ENV = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const READING_TIMEOUT_MS = 10_000;

export class WorldStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldStateError";
  }
}

export class WorldVerificationError extends Error {
  readonly violations: readonly string[];

  constructor(what: string, violations: readonly string[]) {
    super(`${what}: ${violations.join("; ")}`);
    this.name = "WorldVerificationError";
    this.violations = violations;
  }
}

export class CaptureRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureRefusedError";
  }
}

/** The configuration a started world needs: its world section and the job policy's bounds. */
export interface WorldRuntimeSettings {
  readonly world: Config["world"];
  readonly jobs: {
    readonly actionWaitMs: number;
    readonly maximumConcurrentJobs: number;
    readonly retainedFinishedJobs: number;
    readonly capturedOutputBytes: number;
  };
}

export function runtimeSettings(config: Config): WorldRuntimeSettings {
  const { body } = config;
  return {
    world: config.world,
    jobs: {
      actionWaitMs: body.actionWaitMs,
      maximumConcurrentJobs: body.maximumConcurrentJobs,
      retainedFinishedJobs: body.retainedFinishedJobs,
      capturedOutputBytes: body.capturedOutputBytes,
    },
  };
}

/** What a run manifest records about the engine and the world's storage. */
export interface WorldFacts {
  readonly engine: {
    readonly dockerContext: string;
    readonly engineId: string;
    readonly version: string;
    readonly apiVersion: string;
    readonly os: string;
    readonly architecture: string;
    readonly kernel: string;
    readonly cgroupVersion: string;
    readonly securityOptions: readonly string[];
  };
  readonly world: {
    readonly image: string;
    readonly imageArchitecture: string;
    readonly seed: string;
    readonly seedSha256: string;
    readonly requestedCapacityMiB: number;
    readonly effectiveCapacityBytes: number;
    readonly effectiveInodes: number;
  };
}

/** The storage operations a world uses; `LoopExt4Storage` is the implementation. */
export type WorldStorage = Pick<
  LoopExt4Storage,
  "ensureAttached" | "superblock" | "expectedFsid" | "streamArchive" | "removeDeviceVolumes" | "detach" | "removeBackingVolume"
>;

export interface WorldAccess {
  readonly layout: StateLayout;
  readonly worldId: WorldId;
  /** The world lock; every lifecycle operation requires it. */
  readonly ownership: Ownership;
  readonly clock: Clock;
  /** Explicit operator authorization for the privileged storage helper in this command. */
  readonly allowPrivilegedHelper: boolean;
}

interface EngineIdentity {
  readonly engineId: string;
  readonly version: string;
  readonly architecture: string;
  readonly imageArchitecture: string;
}

function checkOwnership(access: WorldAccess): void {
  const { record: owner } = access.ownership;
  if (owner.kind !== "world" || owner.id !== access.worldId) {
    throw new WorldStateError(`the lock held is for ${owner.kind} ${owner.id}, not world ${access.worldId}`);
  }
}

function apiVersion(value: string): number {
  const match = /^(\d+)\.(\d+)$/.exec(value);
  if (match === null) throw new TypeError(`unrecognized API version ${JSON.stringify(value)}`);
  return Number(match[1]) * 1000 + Number(match[2]);
}

async function engineIdentity(engine: DockerEngine): Promise<EngineIdentity> {
  const version = record(await engine.get("/version", { unversioned: true }), "version");
  const pinned = apiVersion(API_VERSION);
  if (apiVersion(str(version.ApiVersion, "ApiVersion")) < pinned || apiVersion(str(version.MinAPIVersion, "MinAPIVersion")) > pinned) {
    throw new WorldStateError(`engine API ${String(version.MinAPIVersion)}–${String(version.ApiVersion)} does not include ${API_VERSION}`);
  }
  const info = record(await engine.get("/info"), "info");
  if (info.OSType !== "linux") throw new WorldStateError(`engine runs ${String(info.OSType)} containers, not linux`);
  if (info.CgroupVersion !== "2") throw new WorldStateError(`engine uses cgroup v${String(info.CgroupVersion)}; v2 is required`);
  return {
    engineId: str(info.ID, "engine ID"),
    version: str(version.Version, "engine version"),
    architecture: str(info.Architecture, "engine architecture"),
    imageArchitecture: str(version.Arch, "engine image architecture"),
  };
}

async function resolveImage(engine: DockerEngine, reference: string, architecture: string, what: string): Promise<string> {
  const image = await inspectImage(engine, reference);
  if (image === null) throw new WorldStateError(`${what} image ${reference} is not present locally; it is never pulled implicitly`);
  if (image.os !== "linux" || image.architecture !== architecture) {
    throw new WorldStateError(`${what} image is ${image.os}/${image.architecture}; the engine runs linux/${architecture}`);
  }
  return image.id;
}

async function openLog(paths: WorldPaths, worldId: WorldId, clock: Clock): Promise<JsonlEventLog<WorldEventType>> {
  return JsonlEventLog.open({ file: paths.events, runId: worldId, clock, limitBytes: WORLD_LOG_LIMIT_BYTES, types: WORLD_EVENT_TYPES });
}

function storageFor(
  engine: DockerEngine,
  metadata: WorldMetadata,
  access: WorldAccess,
  log: JsonlEventLog<WorldEventType>,
): LoopExt4Storage {
  const recordHelper: HelperRecorder = async (phase, details, privileged) => {
    await log.append(phase === "starting" ? "world.helper_starting" : "world.helper_finished", { ...details, privileged }, { durable: phase === "starting" });
  };
  return new LoopExt4Storage(engine, {
    worldId: access.worldId,
    names: resourceNames(access.worldId),
    helperImage: metadata.images.helper,
    worldImage: metadata.images.world,
    uid: metadata.user.uid,
    gid: metadata.user.gid,
    uuid: metadata.storage.uuid,
    allowPrivilegedHelper: access.allowPrivilegedHelper,
    recordHelper,
  });
}

/**
 * Creates a new world: metadata first, then an unprivileged provisioning
 * helper creates and seeds its filesystem. The caller has generated the
 * world ID and holds its lock. A failure leaves the named resources for
 * explicit destruction; nothing is cleaned up by guesswork.
 */
export async function createWorld(
  access: WorldAccess,
  options: { readonly dockerContext: string; readonly resolved: ResolvedConfig; readonly minimumHostFreeMiB: number },
): Promise<DockerWorld> {
  checkOwnership(access);
  const { config } = options.resolved;
  const context = await resolveDockerContext(options.dockerContext);
  const engine = new DockerEngine(context);
  const identity = await engineIdentity(engine);
  const worldImage = await resolveImage(engine, config.world.image, identity.imageArchitecture, "world");
  const helperImage = await resolveImage(engine, config.world.storage.helperImage, identity.imageArchitecture, "helper");
  const seed = await loadSeed(config.world.seed);

  const free = await statfs(access.layout.root);
  const freeMiB = Math.floor((free.bavail * free.bsize) / MiB);
  if (freeMiB < options.minimumHostFreeMiB) {
    throw new WorldStateError(`the state directory's filesystem has ${freeMiB} MiB free; ${options.minimumHostFreeMiB} MiB are required`);
  }

  const paths = worldPaths(access.layout, access.worldId);
  await createWorldDirectory(paths);
  const names = resourceNames(access.worldId);
  const metadata: WorldMetadata = {
    schemaVersion: 1,
    worldId: access.worldId,
    createdAt: access.clock.now().toISOString(),
    docker: { context: context.name, engineId: identity.engineId, engineVersion: identity.version, architecture: identity.architecture },
    images: { world: worldImage, helper: helperImage, architecture: identity.imageArchitecture },
    storage: {
      profile: config.world.storage.profile,
      capture: config.world.storage.capture,
      uuid: randomUUID(),
      // ext4 labels hold 16 bytes; the world ID's random suffix keeps it recognizable.
      label: `alife-${access.worldId.slice(-8)}`,
      capacityMiB: config.world.storage.capacityMiB,
      inodes: config.world.storage.inodes,
    },
    seed: { id: seed.id, status: seed.status, sha256: seed.sha256 },
    user: { uid: config.world.uid, gid: config.world.gid },
    resources: names,
    configSha256: options.resolved.configSha256,
  };
  const log = await openLog(paths, access.worldId, access.clock);
  try {
    await log.append("world.creating", { metadata }, { durable: true });
    await writeWorldMetadata(paths, metadata);
    const storage = storageFor(engine, metadata, access, log);
    let superblock: Superblock;
    try {
      superblock = await storage.provision({
        capacityMiB: metadata.storage.capacityMiB,
        inodes: metadata.storage.inodes,
        label: metadata.storage.label,
        seed,
        // The world's full capacity plus the operator's reserve must fit on the volume filesystem.
        minimumFreeMiB: options.minimumHostFreeMiB,
      });
    } catch (error) {
      await log.append("world.provisioning_failed", { message: (error as Error).message, resources: names }, { durable: true });
      throw error;
    }
    await log.append(
      "world.provisioned",
      {
        superblock,
        requestedCapacityBytes: metadata.storage.capacityMiB * MiB,
        blockBytes: superblock.blockCount * superblock.blockSize,
        freeBytesAtCreation: superblock.freeBlocks * superblock.blockSize,
        freeInodesAtCreation: superblock.freeInodes,
        seed: { id: seed.id, sha256: seed.sha256, entries: seed.entries.length, bytes: seed.bytes },
      },
      { durable: true },
    );
    return new DockerWorld(access, engine, metadata, paths, log, null);
  } catch (error) {
    await log.close();
    throw error;
  }
}

export interface WorldHistory {
  readonly provisioned: boolean;
  readonly destroyed: boolean;
}

/** What the world's log says about its lifecycle. A damaged log is an error, never a guess. */
export async function worldHistory(paths: WorldPaths): Promise<WorldHistory> {
  const contents = await readEventLog(paths.events);
  if (contents.issues.length > 0) throw new WorldStateError(`world log is damaged: ${contents.issues[0]!.detail}`);
  return {
    provisioned: contents.events.some((event) => event.type === "world.provisioned"),
    destroyed: contents.events.some((event) => event.type === "world.destroyed"),
  };
}

/** Where a world's own log stood: its last sequence and the hash of its bytes to that point. */
export interface WorldFence {
  readonly sequence: number;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * World events that change neither the world's files nor its execution
 * history: attaching or detaching storage, captures, and stopping or removing
 * an already stopped container. Anything else after a fence is an intervening
 * execution or an unclassifiable change.
 */
const NONMUTATING_WORLD_EVENTS: ReadonlySet<string> = new Set<WorldEventType>([
  "world.attached",
  "world.helper_starting",
  "world.helper_finished",
  "world.stopping",
  "world.stopped",
  "world.stop_unverified",
  "world.container_removed",
  "world.detached",
  "world.detach_incomplete",
  "archive.refused",
  "archive.created",
  "archive.failed",
]);

async function readLog(paths: WorldPaths): Promise<Buffer | null> {
  try {
    return await readFile(paths.events);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The world's history fence now; null for a world without a log of its own (only test doubles). */
export async function worldFence(paths: WorldPaths): Promise<WorldFence | null> {
  const bytes = await readLog(paths);
  if (bytes === null) return null;
  const contents = await readEventLog(paths.events);
  if (contents.issues.length > 0) throw new WorldStateError(`world log is damaged: ${contents.issues[0]!.detail}`);
  return { sequence: contents.events.at(-1)?.seq ?? 0, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Why the world's history since `fence` rules out continuing from it, or
 * null. The history before the fence must be unchanged, and everything after
 * it must be provably nonmutating: another run's execution, any start, or
 * anything unclassifiable refuses. (A trusted operator editing the log or the
 * engine directly is outside what this can detect.)
 */
export async function fenceViolation(paths: WorldPaths, fence: WorldFence | null): Promise<string | null> {
  const bytes = await readLog(paths);
  if (fence === null) return bytes === null ? null : "the world has a history log it did not have at the checkpoint";
  if (bytes === null) return "the world's history log is missing";
  if (bytes.length < fence.bytes || createHash("sha256").update(bytes.subarray(0, fence.bytes)).digest("hex") !== fence.sha256) {
    return "the world's history before the checkpoint changed";
  }
  const contents = await readEventLog(paths.events);
  if (contents.issues.length > 0) return `the world's history log is damaged: ${contents.issues[0]!.detail}`;
  const later = contents.events.filter((event) => event.seq > fence.sequence);
  const intervening = later.find((event) => !NONMUTATING_WORLD_EVENTS.has(event.type));
  if (intervening !== undefined) {
    return (
      `the world was used after this run's checkpoint (${intervening.type} at world log sequence ${intervening.seq}): an intervening ` +
      "execution, possibly another run, may have changed it, so this run's state cannot be continued"
    );
  }
  return null;
}

/**
 * Opens an existing world for its lock holder. Verifies the recorded engine
 * and, when `settings` are given (to start it), that they describe this world.
 */
export async function openWorld(access: WorldAccess, settings: WorldRuntimeSettings | null = null): Promise<DockerWorld> {
  checkOwnership(access);
  const paths = worldPaths(access.layout, access.worldId);
  const metadata = await readWorldMetadata(paths, access.worldId);
  const history = await worldHistory(paths);
  if (history.destroyed) throw new WorldStateError(`world ${access.worldId} was destroyed`);

  const engine = new DockerEngine(await resolveDockerContext(metadata.docker.context));
  const identity = await engineIdentity(engine);
  if (identity.engineId !== metadata.docker.engineId) {
    throw new WorldStateError(
      `Docker context ${metadata.docker.context} now reaches engine ${identity.engineId}, not the recorded ${metadata.docker.engineId}`,
    );
  }
  if (settings !== null) {
    const { world } = settings;
    const mismatches: string[] = [];
    const same = (label: string, actual: unknown, recorded: unknown) => {
      if (actual !== recorded) mismatches.push(`${label} is ${String(actual)}, recorded ${String(recorded)}`);
    };
    same("world image", await resolveImage(engine, world.image, identity.imageArchitecture, "world"), metadata.images.world);
    same("helper image", await resolveImage(engine, world.storage.helperImage, identity.imageArchitecture, "helper"), metadata.images.helper);
    same("storage profile", world.storage.profile, metadata.storage.profile);
    same("capture profile", world.storage.capture, metadata.storage.capture);
    same("capacityMiB", world.storage.capacityMiB, metadata.storage.capacityMiB);
    same("inodes", world.storage.inodes, metadata.storage.inodes);
    same("uid", world.uid, metadata.user.uid);
    same("gid", world.gid, metadata.user.gid);
    same("seed", world.seed, metadata.seed.id);
    if (mismatches.length > 0) throw new WorldVerificationError("the configuration does not describe this world", mismatches);
  }
  const log = await openLog(paths, access.worldId, access.clock);
  if (!history.provisioned) {
    await log.close();
    throw new WorldStateError(`world ${access.worldId} was never fully provisioned; it can only be destroyed`);
  }
  return new DockerWorld(access, engine, metadata, paths, log, settings);
}

/** Opens a world only to destroy it, including one whose provisioning failed. */
export async function openWorldForDestruction(access: WorldAccess): Promise<DockerWorld> {
  checkOwnership(access);
  const paths = worldPaths(access.layout, access.worldId);
  const metadata = await readWorldMetadata(paths, access.worldId);
  if ((await worldHistory(paths)).destroyed) throw new WorldStateError(`world ${access.worldId} was already destroyed`);
  const engine = new DockerEngine(await resolveDockerContext(metadata.docker.context));
  const identity = await engineIdentity(engine);
  if (identity.engineId !== metadata.docker.engineId) {
    throw new WorldStateError(`Docker context ${metadata.docker.context} now reaches a different engine than recorded`);
  }
  return new DockerWorld(access, engine, metadata, paths, await openLog(paths, access.worldId, access.clock), null);
}

// ---------------------------------------------------------------------------

function containerBody(worldId: WorldId, metadata: WorldMetadata, settings: WorldRuntimeSettings): Record<string, unknown> {
  const { world } = settings;
  return {
    Image: metadata.images.world,
    Entrypoint: ["/usr/bin/tini", "--"],
    Cmd: ["sleep", "infinity"],
    User: `${world.uid}:${world.gid}`,
    WorkingDir: "/world",
    Env: ["HOME=/world", PATH_ENV],
    Hostname: "world",
    Labels: labels(worldId, "world"),
    NetworkDisabled: true,
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    OpenStdin: false,
    Tty: false,
    StopTimeout: STOP_GRACE_SECONDS,
    HostConfig: {
      NetworkMode: "none",
      IpcMode: "private",
      CgroupnsMode: "private",
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Mounts: [
        {
          Type: "volume",
          Source: metadata.resources.deviceVolume,
          Target: "/world",
          ReadOnly: false,
          VolumeOptions: { NoCopy: true },
        },
      ],
      Tmpfs: { "/tmp": `rw,nosuid,nodev,size=${world.tmpMiB}m,mode=1777` },
      ShmSize: world.shmMiB * MiB,
      Memory: world.memoryMiB * MiB,
      MemorySwap: (world.memoryMiB + world.swapMiB) * MiB,
      NanoCpus: Math.round(world.cpus * 1e9),
      PidsLimit: world.pids,
      Ulimits: [
        { Name: "nofile", Soft: world.fileDescriptors, Hard: world.fileDescriptors },
        { Name: "msgqueue", Soft: 0, Hard: 0 },
      ],
      LogConfig: { Type: "none", Config: {} },
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: false,
      PublishAllPorts: false,
      Init: false,
    },
  };
}

function emptyList(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

/** Every way the engine's effective container configuration differs from the declared profile. */
export function containerViolations(info: ContainerInfo, metadata: WorldMetadata, settings: WorldRuntimeSettings): string[] {
  const { world } = settings;
  const host = info.hostConfig;
  const problems: string[] = [];
  const expect = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  expect(info.image === metadata.images.world, `image is ${info.image}`);
  expect(host.Privileged === false, "container is privileged");
  expect(Array.isArray(host.CapDrop) && host.CapDrop.includes("ALL"), "capabilities are not all dropped");
  expect(emptyList(host.CapAdd), "capabilities are added");
  const security = Array.isArray(host.SecurityOpt) ? host.SecurityOpt.map(String) : [];
  expect(security.some((option) => /^no-new-privileges(?::true|=true)?$/.test(option)), "no-new-privileges is not set");
  // Any seccomp or AppArmor option would replace the engine's default profile.
  expect(!security.some((option) => /unconfined|label[:=]disable|^seccomp|^apparmor/.test(option)), `security options change confinement: ${security.join(",")}`);
  expect(host.ReadonlyRootfs === true, "root filesystem is writable");
  expect(host.NetworkMode === "none", `network mode is ${String(host.NetworkMode)}`);
  expect(host.IpcMode === "private", `IPC mode is ${String(host.IpcMode)}`);
  expect(host.PidMode === "" || host.PidMode === undefined, `PID mode is ${String(host.PidMode)}`);
  expect(host.UsernsMode === "" || host.UsernsMode === undefined, `user namespace mode is ${String(host.UsernsMode)}`);
  expect(emptyList(host.Binds), "host paths are bound");
  expect(emptyList(host.Devices), "devices are exposed");
  expect(host.PublishAllPorts === false && (host.PortBindings === null || Object.keys(record(host.PortBindings ?? {}, "ports")).length === 0), "ports are published");
  expect(host.Memory === world.memoryMiB * MiB, `memory limit is ${String(host.Memory)}`);
  expect(host.MemorySwap === (world.memoryMiB + world.swapMiB) * MiB, `memory+swap limit is ${String(host.MemorySwap)}`);
  expect(host.NanoCpus === Math.round(world.cpus * 1e9), `CPU limit is ${String(host.NanoCpus)}`);
  expect(host.PidsLimit === world.pids, `PID limit is ${String(host.PidsLimit)}`);
  expect(host.ShmSize === world.shmMiB * MiB, `shared memory size is ${String(host.ShmSize)}`);
  const ulimits = Array.isArray(host.Ulimits) ? host.Ulimits.map((item) => record(item, "ulimit")) : [];
  const ulimit = (name: string) => ulimits.find((item) => item.Name === name);
  expect(ulimit("nofile")?.Soft === world.fileDescriptors && ulimit("nofile")?.Hard === world.fileDescriptors, "open-file limit differs");
  expect(ulimit("msgqueue")?.Soft === 0 && ulimit("msgqueue")?.Hard === 0, "message queue limit is not zero");
  const logConfig = record(host.LogConfig, "LogConfig");
  expect(logConfig.Type === "none", `log driver is ${String(logConfig.Type)}`);
  const restart = record(host.RestartPolicy, "RestartPolicy");
  expect(restart.Name === "no" || restart.Name === "", `restart policy is ${String(restart.Name)}`);
  expect(host.AutoRemove === false, "container is removed automatically");
  const tmpfs = host.Tmpfs === null || host.Tmpfs === undefined ? {} : record(host.Tmpfs, "Tmpfs");
  expect(
    Object.keys(tmpfs).length === 1 && tmpfs["/tmp"] === `rw,nosuid,nodev,size=${world.tmpMiB}m,mode=1777`,
    `temporary mounts are ${JSON.stringify(tmpfs)}`,
  );
  const mounts = info.mounts;
  expect(
    mounts.length === 1 &&
      mounts[0]!.Type === "volume" &&
      mounts[0]!.Name === metadata.resources.deviceVolume &&
      mounts[0]!.Destination === "/world" &&
      mounts[0]!.RW === true,
    `mounts are ${JSON.stringify(mounts.map((mount) => [mount.Type, mount.Name, mount.Destination]))}`,
  );
  const env = Array.isArray(info.config.Env) ? info.config.Env.map(String).sort() : [];
  expect(env.join("\n") === ["HOME=/world", PATH_ENV].sort().join("\n"), `environment is ${env.map((item) => item.split("=")[0]).join(",")}`);
  expect(info.config.User === `${world.uid}:${world.gid}`, `user is ${String(info.config.User)}`);
  return problems;
}

export class DockerWorld implements WorldBackend {
  readonly metadata: WorldMetadata;
  readonly paths: WorldPaths;
  readonly #access: WorldAccess;
  readonly #engine: DockerEngine;
  readonly #log: JsonlEventLog<WorldEventType>;
  readonly #storage: WorldStorage;
  readonly #settings: WorldRuntimeSettings | null;
  #device: string | null = null;
  #container: ContainerInfo | null = null;
  #transport: ExecTransport | null = null;
  #jobs: JobTable | null = null;
  #startCleanup: WorldStopResult | null = null;
  /** Set during `stop`: records that could not be written while stopping. */
  #unrecordedStop: string[] | null = null;
  /**
   * The current execution epoch's safety condition, owned here independently
   * of the job table: disposing the table, removing the container, or finding
   * no container never clears it.
   */
  #safety: ExecutionSafety | null = null;
  /** The last completed stop of this controller, which gates starting a new epoch. */
  #lastStop: WorldStopResult | null = null;
  /** Concurrent stops of one epoch share one operation. */
  #stopping: Promise<WorldStopResult> | null = null;
  /** Whether the current epoch's startup finished its verification (not the same as having run a job). */
  #startup: "starting" | "started" | "refused" | null = null;

  constructor(
    access: WorldAccess,
    engine: DockerEngine,
    metadata: WorldMetadata,
    paths: WorldPaths,
    log: JsonlEventLog<WorldEventType>,
    settings: WorldRuntimeSettings | null,
    /** Replaces the loop-device storage, for tests of lifecycle mechanics without the storage helper. */
    options: { readonly storage?: WorldStorage } = {},
  ) {
    this.#access = access;
    this.#engine = engine;
    this.metadata = metadata;
    this.paths = paths;
    this.#log = log;
    this.#settings = settings;
    this.#storage = options.storage ?? storageFor(engine, metadata, access, log);
  }

  /** The Docker context this world's engine is reached through (for its watchdog). */
  get dockerContext(): DockerContext {
    return this.#engine.context;
  }

  get identity(): WorldIdentity {
    return {
      worldId: this.metadata.worldId,
      dockerContext: this.metadata.docker.context,
      engineId: this.metadata.docker.engineId,
      storageProfile: this.metadata.storage.profile,
      storageIdentity: this.metadata.storage.uuid,
      image: this.metadata.images.world,
    };
  }

  /**
   * Engine and storage facts for a run manifest: the engine as it reports
   * itself now, and the filesystem's effective size as recorded when it was
   * provisioned. Changes nothing.
   */
  async facts(): Promise<WorldFacts> {
    const version = record(await this.#engine.get("/version", { unversioned: true }), "version");
    const info = record(await this.#engine.get("/info"), "info");
    if (info.ID !== this.metadata.docker.engineId) throw new WorldStateError("the engine identity changed");
    const history = await readEventLog(this.paths.events);
    if (history.issues.length > 0) throw new WorldStateError(`world log is damaged: ${history.issues[0]!.detail}`);
    const provisioned = history.events.findLast((event) => event.type === "world.provisioned");
    const superblock = provisioned === undefined ? null : record(provisioned.data.superblock, "superblock");
    if (superblock === null) throw new WorldStateError("the world log has no provisioning record");
    const security = Array.isArray(info.SecurityOptions) ? info.SecurityOptions.map(String) : [];
    return {
      engine: {
        dockerContext: this.metadata.docker.context,
        engineId: this.metadata.docker.engineId,
        version: str(version.Version, "engine version"),
        apiVersion: API_VERSION,
        os: str(info.OperatingSystem, "operating system"),
        architecture: str(info.Architecture, "architecture"),
        kernel: str(info.KernelVersion, "kernel"),
        cgroupVersion: str(info.CgroupVersion, "cgroup version"),
        securityOptions: security,
      },
      world: {
        image: this.metadata.images.world,
        imageArchitecture: this.metadata.images.architecture,
        seed: this.metadata.seed.id,
        seedSha256: this.metadata.seed.sha256,
        requestedCapacityMiB: this.metadata.storage.capacityMiB,
        effectiveCapacityBytes: num(superblock.blockCount, "block count") * num(superblock.blockSize, "block size"),
        effectiveInodes: num(superblock.inodeCount, "inode count"),
      },
    };
  }

  async #record(type: WorldEventType, data: Readonly<Record<string, unknown>>, durable = false): Promise<void> {
    try {
      await this.#log.append(type, data, { durable });
    } catch (error) {
      // While stopping, a record that cannot be written must not prevent the stop: it is reported instead,
      // and the epoch's evidence is incomplete.
      if (this.#unrecordedStop === null) throw error;
      this.#unrecordedStop.push(`${type}: ${messageOf(error)}`);
      if (this.#safety !== null && !this.#safety.sealed) this.#safety.markRequiredEvidenceFailure();
    }
  }

  /** Checks the recorded engine, images, backing volume, and filesystem UUID. Never repairs. */
  async verify(): Promise<WorldIdentity> {
    const identity = await engineIdentity(this.#engine);
    if (identity.engineId !== this.metadata.docker.engineId) throw new WorldStateError("the engine identity changed");
    await resolveImage(this.#engine, this.metadata.images.world, identity.imageArchitecture, "world");
    await resolveImage(this.#engine, this.metadata.images.helper, identity.imageArchitecture, "helper");
    await this.#storage.superblock();
    return this.identity;
  }

  async #currentContainer(): Promise<ContainerInfo | null> {
    const info = await inspectContainer(this.#engine, this.metadata.resources.container);
    if (info !== null) expectContainer(info, this.metadata.resources.container, this.metadata.worldId, "world");
    return info;
  }

  async #requireStopped(action: string): Promise<void> {
    const container = await this.#currentContainer();
    if (container?.state.running === true) {
      throw new WorldStateError(`cannot ${action} while the world is running; stop it explicitly first`);
    }
  }

  /** Attaches and verifies storage while the world is stopped. */
  async attach(): Promise<void> {
    await this.#requireStopped("attach storage");
    const result = await this.#storage.ensureAttached();
    this.#device = result.device;
    await this.#record("world.attached", { device: result.device, newlyAttached: result.attached, fsid: result.check.fsid }, true);
  }

  /**
   * Starts a new execution epoch. The predecessor is validated before anything
   * changes: no new safety object, no cleared receipts, no engine request.
   */
  async start(hooks?: StartHooks): Promise<void> {
    const settings = this.#settings;
    if (settings === null) throw new WorldStateError("this world was opened without run settings and cannot be started");
    if (this.#container !== null) throw new WorldStateError("the world was already started by this controller");
    const denial = this.#restartDenial();
    if (denial !== null) throw new WorldStateError(denial);
    this.#safety = new ExecutionSafety({ epochId: randomUUID(), maximumEffects: settings.jobs.maximumConcurrentJobs + 1 });
    this.#startup = "starting";
    this.#lastStop = null;
    this.#startCleanup = null;
    try {
      await this.#startEpoch(settings, hooks);
      this.#startup = "started";
    } catch (error) {
      this.#startup = "refused";
      throw error;
    }
  }

  /**
   * Why the previous epoch forbids starting a new one on this controller, or
   * null. A successfully started epoch, whether or not any job ran, needs a
   * verified, fully recorded, sealed, review-free stop of that same epoch. A
   * refused startup, which admitted no agent execution, may retry only when
   * its cleanup is known adequate.
   */
  #restartDenial(): string | null {
    const previous = this.#safety;
    if (previous === null) return null;
    const review = "the previous execution epoch of this world requires review; it cannot be restarted by this controller";
    switch (this.#startup) {
      case "started": {
        const last = this.#lastStop;
        return last !== null && last.verified && last.recorded && certifiesClean(last.safety, previous.epochId) ? null : review;
      }
      case "refused": {
        const snapshot = previous.snapshot();
        const cleanup = this.#startCleanup;
        const adequate = cleanup === null || (cleanup.verified && cleanup.recorded && !cleanup.safety.reviewRequired);
        return snapshot.committedEffects === 0 && !snapshot.reviewRequired && adequate ? null : `${review} (its refused startup was not cleanly cleaned up)`;
      }
      default:
        return "a start of this world is already in progress";
    }
  }

  async #startEpoch(settings: WorldRuntimeSettings, hooks: StartHooks | undefined): Promise<void> {
    // Job IDs prepared in this world before, by any controller, stay spent. Read before anything starts.
    const history = await readEventLog(this.paths.events);
    if (history.issues.length > 0) throw new WorldStateError(`world log is damaged: ${history.issues[0]!.detail}`);
    const previouslyPrepared = history.events
      .filter((event) => event.type === "job.prepared" && typeof event.data.jobId === "string")
      .map((event) => event.data.jobId as string);

    const existing = await this.#currentContainer();
    if (existing !== null) {
      if (existing.state.running) {
        throw new WorldStateError(
          `container ${existing.name} is already running, possibly left by an interrupted controller; stop it explicitly`,
        );
      }
      await this.#record("world.stale_container", { id: existing.id, state: existing.state }, true);
      await removeContainer(this.#engine, { id: existing.id, name: existing.name, worldId: this.metadata.worldId, role: "world" }, { force: false });
    }
    await this.attach();
    const device = this.#device!;

    const created = record(
      await this.#engine.post("/containers/create", {
        query: { name: this.metadata.resources.container },
        body: containerBody(this.metadata.worldId, this.metadata, settings),
      }),
      "container create",
    );
    const info = await inspectContainer(this.#engine, str(created.Id, "container ID"));
    if (info === null) throw new WorldStateError("the new world container vanished");
    expectContainer(info, this.metadata.resources.container, this.metadata.worldId, "world");
    await this.#record("world.container_created", { id: info.id, device }, true);
    const configuration = containerViolations(info, this.metadata, settings);
    if (configuration.length > 0) {
      await removeContainer(this.#engine, { id: info.id, name: info.name, worldId: this.metadata.worldId, role: "world" }, { force: true });
      await this.#record("world.verification_failed", { stage: "configuration", violations: configuration }, true);
      throw new WorldVerificationError("the engine's container configuration differs from the profile", configuration);
    }

    try {
      if (hooks !== undefined) await hooks.beforeContainerStart(info.id, this.#safety!.epochId);
      // Final admission, with nothing awaited between it and the start request.
      const refusal = hooks?.admit() ?? (this.#safety!.snapshot().admission === "closed" ? "the world began stopping" : null);
      if (refusal !== null) throw new WorldStateError(`the container was not started: ${refusal}`);
      await this.#engine.post(`/containers/${info.id}/start`);
      this.#container = parseContainer(await this.#engine.get(`/containers/${info.id}/json`));
    } catch (error) {
      // Whether or not it started, the container is stopped and removed by its exact ID.
      this.#container = info;
      const stopped = await this.#cleanUpStart();
      throw new WorldStateError(`starting the world failed (${(error as Error).message}); ${stopped.detail}`);
    }
    try {
      await this.#verifyStarted(info, settings, device, previouslyPrepared);
    } catch (error) {
      // Any failure once the container runs, including a record that cannot be written, stops it.
      // Paths that already stopped it cleared the container; an unverified stop is tried once more.
      if (this.#container === null) throw error;
      const stopped = await this.#cleanUpStart();
      throw new WorldStateError(`starting the world failed after its container was running (${messageOf(error)}); ${stopped.detail}`);
    }
  }

  async #verifyStarted(info: ContainerInfo, settings: WorldRuntimeSettings, device: string, previouslyPrepared: readonly string[]): Promise<void> {
    await this.#record("world.started", { id: info.id, startedAt: this.#container!.state.startedAt }, true);
    const transport = dockerExecTransport(this.#engine, info.id, `${settings.world.uid}:${settings.world.gid}`);
    this.#transport = transport;

    // Verify the effective world from inside before any action can run.
    let reading;
    try {
      reading = await runControl(transport, this.#access.clock, ["python3", "-I", "-c", STARTUP_SCRIPT], {
        timeoutMs: 30_000,
        stdoutLimit: 256 << 10,
      });
    } catch (error) {
      const stopped = await this.#cleanUpStart();
      throw new WorldStateError(`the startup reading failed (${messageOf(error)}); ${stopped.detail}`);
    }
    let violations: string[];
    let facts: ReturnType<typeof parseStartupFacts> | null = null;
    if (reading.timedOut || reading.exitCode !== 0 || reading.overflow) {
      violations = [`the startup reading ${reading.timedOut ? "timed out" : `exited ${reading.exitCode}`}: ${reading.stderr.toString("utf8").slice(0, 512)}`];
    } else {
      try {
        facts = parseStartupFacts(reading.stdout.toString("utf8"));
        violations = startupViolations(facts, {
          uid: settings.world.uid,
          gid: settings.world.gid,
          device,
          fsid: this.#storage.expectedFsid,
          tmpMiB: settings.world.tmpMiB,
          shmMiB: settings.world.shmMiB,
          fileDescriptors: settings.world.fileDescriptors,
          memoryMiB: settings.world.memoryMiB,
          swapMiB: settings.world.swapMiB,
          cpus: settings.world.cpus,
          pids: settings.world.pids,
        });
      } catch (error) {
        violations = [`the startup reading could not be parsed: ${(error as Error).message}`];
      }
    }
    if (violations.length > 0) {
      await this.#record("world.verification_failed", { stage: "inside", violations }, true);
      await this.#cleanUpStart();
      throw new WorldVerificationError("the started world differs from the profile", violations);
    }
    await this.#record(
      "world.verified",
      {
        uid: facts!.uid,
        gid: facts!.gid,
        seccomp: facts!.seccomp,
        mqueueErrno: facts!.mqueue.errno,
        limits: facts!.limits.filter(([name]) => ["Max open files", "Max msgqueue size", "Max processes"].includes(name)),
        pid1: facts!.pid1,
      },
      true,
    );
    this.#jobs = new JobTable({
      previouslyPrepared,
      transport,
      clock: this.#access.clock,
      ...settings.jobs,
      record: (type, data, durable) => this.#record(type, data, durable),
      control: (cmd, timeoutMs, admit) =>
        runControl(transport, this.#access.clock, cmd, { timeoutMs, stdoutLimit: 16 << 10, ...(admit === undefined ? {} : { admit }) }),
      safety: this.#safety!,
    });
  }

  /**
   * How the world was stopped after the last failed start, or null if a start
   * never needed to stop it. A failed start reports it here so the caller can
   * tell a fully recorded cleanup from one whose records failed.
   */
  get startCleanup(): WorldStopResult | null {
    return this.#startCleanup;
  }

  /** Stops the world after a failed start, accumulating the result across attempts. */
  async #cleanUpStart(): Promise<WorldStopResult> {
    const result = await this.stop("world_exit");
    const earlier = this.#startCleanup;
    // Same epoch: the later assessment already includes every earlier issue.
    this.#startCleanup =
      earlier === null
        ? result
        : { verified: result.verified, recorded: earlier.recorded && result.recorded, detail: `${earlier.detail}; then ${result.detail}`, safety: result.safety };
    return result;
  }

  #requireJobs(): JobTable {
    if (this.#jobs === null) throw new WorldStateError("the world is not running under this controller");
    return this.#jobs;
  }

  async sample(options: { readonly listing: boolean }): Promise<WorldSample> {
    const jobs = this.#requireJobs();
    const clock = this.#access.clock;
    const started = clock.monotonicMs();
    const sampledAt = clock.now().toISOString();

    let memory: WorldSample["memory"];
    let processes: WorldSample["processes"];
    try {
      const stats = record(
        await this.#engine.get(`/containers/${this.#container!.id}/stats`, { query: { stream: "false", "one-shot": "true" }, timeoutMs: READING_TIMEOUT_MS }),
        "stats",
      );
      const memoryStats = record(stats.memory_stats ?? {}, "memory_stats");
      const pidStats = record(stats.pids_stats ?? {}, "pids_stats");
      memory =
        typeof memoryStats.usage === "number" && typeof memoryStats.limit === "number"
          ? { available: true, value: { usageBytes: memoryStats.usage, limitBytes: memoryStats.limit } }
          : { available: false, reason: "the engine reported no memory statistics" };
      processes =
        typeof pidStats.current === "number" && typeof pidStats.limit === "number"
          ? { available: true, value: { count: pidStats.current, limit: pidStats.limit } }
          : { available: false, reason: "the engine reported no process statistics" };
    } catch (error) {
      const reason = `engine statistics failed: ${(error as Error).message}`;
      memory = { available: false, reason };
      processes = { available: false, reason };
    }

    let storage: Metric<{ totalBytes: number; availableBytes: number; totalInodes: number; availableInodes: number }>;
    let listing: WorldSample["listing"] = null;
    try {
      const reading = await runControl(this.#transport!, clock, ["python3", "-I", "-c", SENSOR_SCRIPT, ...sensorArguments(options.listing)], {
        timeoutMs: READING_TIMEOUT_MS,
        stdoutLimit: 64 << 10,
      });
      if (reading.timedOut || reading.exitCode !== 0 || reading.overflow) {
        throw new Error(reading.timedOut ? "timed out" : `exited ${reading.exitCode}`);
      }
      const parsed = parseSensorReading(reading.stdout.toString("utf8"), options.listing);
      storage = parsed.storage;
      listing = parsed.listing;
    } catch (error) {
      const reason = `in-world reading failed: ${(error as Error).message}`;
      storage = { available: false, reason };
      if (options.listing) listing = { available: false, reason };
    }

    return {
      sampledAt,
      sensorProfile: "baseline-sensors-v4",
      durationMs: clock.monotonicMs() - started,
      storage,
      memory,
      processes,
      jobs: await jobs.summaries(),
      listing,
    };
  }

  submit(request: ActionRequest, hooks: DispatchHooks): Promise<JobSnapshot> {
    return this.#requireJobs().submit(request, hooks);
  }

  acknowledgeJobs(jobIds: readonly string[]): void {
    this.#jobs?.acknowledge(jobIds);
  }

  /** The current epoch's safety condition, synchronously; null before any start. */
  safety(): ExecutionSafetySnapshot | null {
    return this.#safety?.snapshot() ?? null;
  }

  /** Inspects every tracked job, so uncertainty the engine now shows is latched. */
  refreshJobSafety(): Promise<void> {
    return this.#jobs?.refreshSafety() ?? Promise.resolve();
  }

  inspectJob(jobId: string): Promise<JobSnapshot> {
    return this.#requireJobs().inspect(jobId);
  }

  jobs(): Promise<readonly JobSnapshot[]> {
    return this.#requireJobs().list();
  }

  signalJob(jobId: string, signal: JobSignal, requestedBy: "agent" | "operator"): Promise<SignalResult> {
    return this.#requireJobs().signal(jobId, signal, requestedBy);
  }

  /**
   * Stops the world container (every process in it ends), records its final
   * state, and removes it. Storage stays attached. An unverifiable stop is
   * reported, and nothing further is done to storage. Records are attempted
   * but never required: a full or failed world log cannot keep the world
   * running, and the result then says its evidence is incomplete.
   *
   * Admission of agent effects closes synchronously on entry. The result
   * carries the epoch's safety assessment, sealed only after a verified stop
   * and its processing; uncertainty established at any point of the epoch
   * survives into it.
   */
  stop(reason: StopReason): Promise<WorldStopResult> {
    this.#safety?.closeAdmission();
    this.#jobs?.closeAdmission();
    this.#stopping ??= this.#stopOnce(reason).finally(() => {
      this.#stopping = null;
    });
    return this.#stopping;
  }

  async #stopOnce(reason: StopReason): Promise<WorldStopResult> {
    const outer = this.#unrecordedStop;
    const unrecorded: string[] = outer ?? [];
    this.#unrecordedStop = unrecorded;
    try {
      const result = await this.#stop(reason);
      const safety = result.sealed ?? this.#safety?.provisional() ?? noEpochAssessment(unrecorded.length > 0);
      const stop: WorldStopResult = {
        verified: result.verified,
        recorded: unrecorded.length === 0,
        detail: unrecorded.length === 0 ? result.detail : `${result.detail}; not recorded: ${unrecorded.join("; ")}`,
        safety,
      };
      this.#lastStop = stop;
      return stop;
    } finally {
      this.#unrecordedStop = outer;
    }
  }

  async #stop(reason: StopReason): Promise<{ readonly verified: boolean; readonly detail: string; readonly sealed: StopSafetyAssessment | null }> {
    let container: ContainerInfo | null;
    try {
      container = this.#container ?? (await this.#currentContainer());
    } catch (error) {
      return { verified: false, detail: `the world container could not be inspected: ${messageOf(error)}`, sealed: null };
    }
    if (container === null) return this.#vanished("no world container exists");
    await this.#record("world.stopping", { reason, id: container.id }, true);
    // Drain: no submission can start anything any more, and each in progress settles. Inspection
    // stays active meanwhile, so uncertainty established now still belongs to this epoch.
    await this.#jobs?.quiesce();
    let state: ContainerInfo["state"];
    // Stop committed: the inspection epoch advances and the engine stop request is issued with no
    // await in between. Answers crossing this point are not read as the jobs' own doing.
    this.#jobs?.beginWorldStop();
    const stopping = this.#engine.post(`/containers/${container.id}/stop`, {
      query: { t: String(STOP_GRACE_SECONDS) },
      timeoutMs: (STOP_GRACE_SECONDS + 30) * 1000,
    });
    try {
      await stopping;
    } catch (error) {
      // The container is gone (404): nothing runs, but see #vanished for what that does not prove.
      if (error instanceof EngineResponseError && error.status === 404) {
        const now = await inspectContainer(this.#engine, container.id).catch(() => undefined);
        if (now === null) {
          await this.#record("world.stopped", { reason, id: container.id, state: null, detail: "the container vanished" }, true);
          return this.#vanished("the world container vanished before it was stopped");
        }
      }
      // An already stopped container answers 304, which is not an error here.
      if (!(error instanceof EngineResponseError && error.status === 304)) {
        const detail = `stop request failed: ${error instanceof EngineUnavailableError ? "engine unavailable: " : ""}${messageOf(error)}`;
        this.#jobs?.stopNotVerified();
        await this.#record("world.stop_unverified", { reason, id: container.id, detail }, true);
        return { verified: false, detail, sealed: null };
      }
    }
    try {
      const after = await inspectContainer(this.#engine, container.id);
      if (after === null) throw new Error("the container disappeared before its state was recorded");
      state = after.state;
      if (state.running) throw new Error(`the container is still running (${state.status})`);
    } catch (error) {
      const detail = `the stop could not be verified: ${messageOf(error)}`;
      this.#jobs?.stopNotVerified();
      await this.#record("world.stop_unverified", { reason, id: container.id, detail }, true);
      return { verified: false, detail, sealed: null };
    }
    // Verified. Shutdown processing collects failures rather than stopping at the first. Signal
    // operations admitted before the stop settle here: never ahead of the engine stop, always
    // before the assessment is sealed. (A failed stop returns earlier; they stay owned for the retry.)
    const jobs = this.#jobs;
    if (jobs !== null) {
      await jobs.settleOperations();
      await jobs.endWithWorld();
      await jobs.settleEvidence();
    }
    await this.#record("world.stopped", { reason, id: container.id, state }, true);
    let removed = true;
    try {
      await removeContainer(this.#engine, { id: container.id, name: container.name, worldId: this.metadata.worldId, role: "world" }, { force: false });
    } catch (error) {
      removed = false;
      this.#unrecordedStop?.push(`container removal: ${messageOf(error)}`);
      if (this.#safety !== null && !this.#safety.sealed) this.#safety.markRequiredEvidenceFailure();
    }
    if (removed) await this.#record("world.container_removed", { id: container.id }, true);
    this.#container = removed ? null : this.#container;
    this.#transport = null;
    this.#jobs = null;
    // Sealed only now: every observation and required world record of the epoch has settled.
    return {
      verified: true,
      detail: `stopped (exit ${state.exitCode ?? "unknown"}${state.oomKilled ? ", OOM killed" : ""})${removed ? "" : "; the container could not be removed"}`,
      sealed: this.#safety?.seal() ?? null,
    };
  }

  /**
   * No container exists: nothing of the epoch can still run. If executions
   * were expected alive, the absence does not account for their outcomes, so
   * each is latched as uncertain before the assessment is sealed.
   */
  async #vanished(detail: string): Promise<{ readonly verified: boolean; readonly detail: string; readonly sealed: StopSafetyAssessment | null }> {
    const jobs = this.#jobs;
    if (jobs !== null) {
      jobs.latchUnaccounted("the world container vanished while the execution was expected to be running");
      await jobs.settleOperations();
      await jobs.close();
      await jobs.settleEvidence();
    }
    this.#container = null;
    this.#jobs = null;
    this.#transport = null;
    return { verified: true, detail, sealed: this.#safety?.seal() ?? null };
  }

  async inspect(): Promise<WorldStatus> {
    let container: WorldStatus["container"];
    try {
      const info = await this.#currentContainer();
      container = info === null ? "absent" : info.state.running ? "running" : "stopped";
    } catch {
      container = "unknown";
    }
    return { identity: this.identity, container, storageAttached: this.#device === null ? null : true };
  }

  /**
   * Captures a stopped world's files (`tar-capture-v1`). Refuses a running
   * world or a filesystem that is not clean; never stops, repairs, or replays
   * anything to make capture possible.
   */
  async captureArtifacts(label: string, bounds?: CaptureLimits): Promise<ArchiveResult> {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)) throw new RangeError(`invalid archive label ${JSON.stringify(label)}`);
    for (const value of bounds === undefined ? [] : [bounds.maximumBytes, bounds.maximumEntries, bounds.timeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("capture bounds must be positive integers");
    }
    const refuse = async (why: string): Promise<never> => {
      await this.#record("archive.refused", { label, reason: why }, true);
      throw new CaptureRefusedError(why);
    };
    const container = await this.#currentContainer();
    if (container?.state.running === true) await refuse("the world is running; capture never stops it");
    const users = await containersUsingVolume(this.#engine, this.metadata.resources.deviceVolume);
    for (const id of users) {
      const user = await inspectContainer(this.#engine, id);
      if (user?.state.running === true) await refuse(`container ${id} is using the world's storage`);
    }
    const before = await this.#storage.superblock();
    if (!isClean(before)) {
      await refuse(`the filesystem is not clean (state ${before.state}); capturing it needs a separately reviewed recovery procedure`);
    }
    await this.attach();

    const archiveId = newArchiveId(this.#access.clock.now());
    const directory = path.join(this.paths.archives, archiveId);
    await mkdir(directory, { mode: 0o700 });
    const createdAt = this.#access.clock.now().toISOString();
    const profile = captureLimits(this.metadata.storage.capacityMiB, this.metadata.storage.inodes);
    // A caller (a run's record budget) can only tighten the profile's bounds.
    const limits: CaptureLimits =
      bounds === undefined
        ? profile
        : {
            maximumBytes: Math.min(profile.maximumBytes, bounds.maximumBytes),
            maximumEntries: Math.min(profile.maximumEntries, bounds.maximumEntries),
            timeoutMs: Math.min(profile.timeoutMs, bounds.timeoutMs),
          };
    const outcome = await captureInto(directory, limits, (sink, timeoutMs) => this.#storage.streamArchive(this.#device!, sink, timeoutMs));
    let after: Superblock | null = null;
    const omissions = [...outcome.omissions];
    try {
      after = await this.#storage.superblock();
    } catch (error) {
      omissions.push(`superblock after capture unreadable: ${(error as Error).message}`);
    }
    const unchanged = after === null ? null : after.mountCount === before.mountCount && after.lastWriteTime === before.lastWriteTime;
    if (unchanged === false) omissions.push("the filesystem's mount count or write time changed during capture");

    const manifest = {
      schemaVersion: 1,
      archiveId,
      worldId: this.metadata.worldId,
      label,
      capture: this.metadata.storage.capture,
      createdAt,
      completedAt: this.#access.clock.now().toISOString(),
      complete: outcome.complete && unchanged === true,
      omissions,
      coverage: CAPTURE_COVERAGE,
      limits,
      archive: { file: "archive.tar", bytes: outcome.bytes, sha256: outcome.sha256 },
      source: {
        uuid: this.metadata.storage.uuid,
        device: this.#device,
        before: { state: before.state, mountCount: before.mountCount, lastWriteTime: before.lastWriteTime },
        after: after === null ? null : { state: after.state, mountCount: after.mountCount, lastWriteTime: after.lastWriteTime },
        unchanged,
      },
      helper: outcome.helper,
      entryCount: outcome.entries.length,
      entries: outcome.entries,
    };
    await writeNewFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const result: ArchiveResult = {
      archiveId,
      complete: manifest.complete,
      entries: outcome.entries.length,
      bytes: outcome.bytes,
      omissions,
    };
    await this.#record(outcome.bytes > 0 || outcome.complete ? "archive.created" : "archive.failed", { ...result, label, sha256: outcome.sha256 }, true);
    return result;
  }

  /** Unbinds the loop device after removing the now-stale volumes. Needs the privileged helper. */
  async detach(): Promise<{ readonly verified: boolean; readonly remaining: readonly string[] }> {
    // Refuse before changing anything, rather than after removing the volumes.
    if (!this.#access.allowPrivilegedHelper) throw new PrivilegeRequiredError("detaching storage", "the operator has not authorized it for this command");
    await this.#requireStopped("detach storage");
    const container = await this.#currentContainer();
    if (container !== null) {
      await removeContainer(this.#engine, { id: container.id, name: container.name, worldId: this.metadata.worldId, role: "world" }, { force: false });
      await this.#record("world.container_removed", { id: container.id }, true);
    }
    await this.#storage.removeDeviceVolumes();
    const result = await this.#storage.detach();
    this.#device = null;
    const verified = result.remaining.length === 0;
    await this.#record(verified ? "world.detached" : "world.detach_incomplete", { ...result }, true);
    return { verified, remaining: result.remaining };
  }

  /**
   * Destroys the world's storage and resources after explicit confirmation by
   * the caller. The world must be stopped; records are kept. Stops at the
   * first step that cannot be verified, preserving the backing volume.
   */
  async destroy(): Promise<{ readonly verified: boolean; readonly detail: string }> {
    if (!this.#access.allowPrivilegedHelper) throw new PrivilegeRequiredError("destroying a world", "its loop device must be detached");
    await this.#requireStopped("destroy the world");
    await this.#record("world.destroying", { resources: this.metadata.resources }, true);
    try {
      const detached = await this.detach();
      if (!detached.verified) {
        const detail = `loop device(s) ${detached.remaining.join(", ")} are still bound; the backing volume was kept`;
        await this.#record("world.destroy_incomplete", { detail }, true);
        return { verified: false, detail };
      }
      await this.#storage.removeBackingVolume();
    } catch (error) {
      await this.#record("world.destroy_incomplete", { detail: (error as Error).message }, true);
      throw error;
    }
    await this.#record("world.destroyed", {}, true);
    return { verified: true, detail: "all Docker resources of this world were removed; its records were kept" };
  }

  /** Releases collectors and the log. Does not stop the world. */
  async close(): Promise<void> {
    // Pending submissions finish (started and tracked, or refused and recorded) before the log closes.
    await this.#jobs?.close();
    await this.#log.close();
  }
}
