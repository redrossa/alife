import { randomBytes } from "node:crypto";

import type { WorldId } from "../core/ids.ts";
import {
  bool,
  type DockerEngine,
  EngineUnavailableError,
  isNotFound,
  num,
  optionalNum,
  type RawStream,
  record,
  str,
} from "./engine.ts";
import { FrameDemuxer, HeadRetainer } from "./output.ts";

// Docker resources owned by a world. Every resource carries the world's ID
// and its role as labels, and is found by an exact name derived from the
// world ID. Nothing is removed unless its name, ID, and labels all match
// (plan §12): no prune, no pattern-based cleanup, no unrelated containers.

export const WORLD_LABEL = "sh.alife.world";
export const ROLE_LABEL = "sh.alife.role";
export const PURPOSE_LABEL = "sh.alife.purpose";

export type ResourceRole = "world" | "backing" | "device" | "readonly" | "helper";

export interface WorldResourceNames {
  readonly container: string;
  /** Holds the backing ext4 image file. */
  readonly backingVolume: string;
  /** Mounts the attached loop device read-write for the world. */
  readonly deviceVolume: string;
  /** Mounts the attached loop device read-only, for identity checks and capture of a stopped world. */
  readonly readonlyVolume: string;
}

export function resourceNames(worldId: WorldId): WorldResourceNames {
  return {
    container: `alife-${worldId}`,
    backingVolume: `alife-${worldId}-backing`,
    deviceVolume: `alife-${worldId}-world`,
    readonlyVolume: `alife-${worldId}-ro`,
  };
}

export function labels(worldId: WorldId, role: ResourceRole, purpose?: string): Record<string, string> {
  return { [WORLD_LABEL]: worldId, [ROLE_LABEL]: role, ...(purpose === undefined ? {} : { [PURPOSE_LABEL]: purpose }) };
}

export class ResourceIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceIdentityError";
  }
}

function labelsOf(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};
  const raw = record(value, "labels");
  const out: Record<string, string> = {};
  for (const key of Object.keys(raw)) out[key] = str(raw[key], `label ${key}`);
  return out;
}

function expectLabels(kind: string, name: string, actual: Record<string, string>, worldId: WorldId, role: ResourceRole): void {
  if (actual[WORLD_LABEL] !== worldId || actual[ROLE_LABEL] !== role) {
    throw new ResourceIdentityError(
      `${kind} ${name} exists but is not labelled as this world's ${role} resource; it was left untouched`,
    );
  }
}

// ---------------------------------------------------------------------------
// Containers

export interface ContainerState {
  readonly running: boolean;
  readonly status: string;
  readonly exitCode: number | null;
  readonly oomKilled: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface ContainerInfo {
  readonly id: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly state: ContainerState;
  readonly image: string;
  /** Raw engine view, for effective-configuration verification. */
  readonly hostConfig: Readonly<Record<string, unknown>>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly mounts: readonly Readonly<Record<string, unknown>>[];
}

const CONTAINER_ID = /^[a-f0-9]{64}$/;

export function parseContainer(value: unknown): ContainerInfo {
  const info = record(value, "container");
  const state = record(info.State, "container state");
  const id = str(info.Id, "container ID");
  if (!CONTAINER_ID.test(id)) throw new TypeError(`container ID ${JSON.stringify(id)} has an unexpected format`);
  const config = record(info.Config, "container config");
  const mounts = Array.isArray(info.Mounts) ? info.Mounts.map((mount) => record(mount, "mount")) : [];
  return {
    id,
    name: str(info.Name, "container name").replace(/^\//, ""),
    labels: labelsOf(config.Labels),
    state: {
      running: bool(state.Running, "State.Running"),
      status: str(state.Status, "State.Status"),
      exitCode: optionalNum(state.ExitCode, "State.ExitCode"),
      oomKilled: bool(state.OOMKilled, "State.OOMKilled"),
      startedAt: str(state.StartedAt, "State.StartedAt"),
      finishedAt: str(state.FinishedAt, "State.FinishedAt"),
    },
    image: str(info.Image, "container image"),
    hostConfig: record(info.HostConfig, "HostConfig"),
    config,
    mounts,
  };
}

export async function inspectContainer(engine: DockerEngine, nameOrId: string): Promise<ContainerInfo | null> {
  try {
    return parseContainer(await engine.get(`/containers/${encodeURIComponent(nameOrId)}/json`));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** A container that exists must be this world's resource with the expected role. */
export function expectContainer(info: ContainerInfo, name: string, worldId: WorldId, role: ResourceRole): void {
  if (info.name !== name) throw new ResourceIdentityError(`container ${info.id} is named ${info.name}, not ${name}`);
  expectLabels("container", name, info.labels, worldId, role);
}

/**
 * Removes exactly the container with this ID after rechecking its name and
 * labels, then confirms it is gone. `force` also kills it if running.
 */
export async function removeContainer(
  engine: DockerEngine,
  expected: { readonly id: string; readonly name: string; readonly worldId: WorldId; readonly role: ResourceRole },
  options: { readonly force: boolean },
): Promise<void> {
  const info = await inspectContainer(engine, expected.id);
  if (info === null) return;
  if (info.id !== expected.id) throw new ResourceIdentityError(`container ${expected.id} resolved to ${info.id}`);
  expectContainer(info, expected.name, expected.worldId, expected.role);
  try {
    await engine.delete(`/containers/${info.id}`, { query: { force: options.force ? "true" : "false", v: "false" } });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if ((await inspectContainer(engine, info.id)) !== null) {
    throw new ResourceIdentityError(`container ${info.name} (${info.id}) still exists after removal`);
  }
}

/** IDs of every container, running or not, that references a volume. */
export async function containersUsingVolume(engine: DockerEngine, volume: string): Promise<string[]> {
  const list = await engine.get("/containers/json", {
    query: { all: "true", filters: JSON.stringify({ volume: [volume] }) },
  });
  if (!Array.isArray(list)) throw new TypeError("container list: expected an array from the engine");
  return list.map((item) => str(record(item, "container summary").Id, "container ID"));
}

// ---------------------------------------------------------------------------
// Volumes

export interface VolumeInfo {
  readonly name: string;
  readonly driver: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly options: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

function parseVolume(value: unknown): VolumeInfo {
  const info = record(value, "volume");
  return {
    name: str(info.Name, "volume name"),
    driver: str(info.Driver, "volume driver"),
    labels: labelsOf(info.Labels),
    options: labelsOf(info.Options),
    createdAt: typeof info.CreatedAt === "string" ? info.CreatedAt : "",
  };
}

export async function inspectVolume(engine: DockerEngine, name: string): Promise<VolumeInfo | null> {
  try {
    return parseVolume(await engine.get(`/volumes/${encodeURIComponent(name)}`));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export function expectVolume(info: VolumeInfo, worldId: WorldId, role: ResourceRole): void {
  expectLabels("volume", info.name, info.labels, worldId, role);
  if (info.driver !== "local") throw new ResourceIdentityError(`volume ${info.name} uses driver ${info.driver}, not local`);
}

/**
 * Creates a volume that must not already exist. The engine returns an
 * existing volume of the same name instead of failing, so absence is checked
 * first and the result's labels are checked after.
 */
export async function createVolume(
  engine: DockerEngine,
  name: string,
  worldId: WorldId,
  role: ResourceRole,
  driverOptions: Readonly<Record<string, string>> = {},
): Promise<VolumeInfo> {
  if ((await inspectVolume(engine, name)) !== null) {
    throw new ResourceIdentityError(`volume ${name} already exists; it was left untouched`);
  }
  const created = parseVolume(
    await engine.post("/volumes/create", {
      body: { Name: name, Driver: "local", DriverOpts: driverOptions, Labels: labels(worldId, role) },
    }),
  );
  if (created.name !== name) throw new ResourceIdentityError(`volume create returned ${created.name}, not ${name}`);
  expectVolume(created, worldId, role);
  return created;
}

/** Removes a volume only if it is this world's, has the expected role, and no container references it. */
export async function removeVolume(engine: DockerEngine, name: string, worldId: WorldId, role: ResourceRole): Promise<void> {
  const info = await inspectVolume(engine, name);
  if (info === null) return;
  expectVolume(info, worldId, role);
  const users = await containersUsingVolume(engine, name);
  if (users.length > 0) {
    throw new ResourceIdentityError(`volume ${name} is still referenced by container(s) ${users.join(", ")}; it was left in place`);
  }
  try {
    await engine.delete(`/volumes/${encodeURIComponent(name)}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if ((await inspectVolume(engine, name)) !== null) throw new ResourceIdentityError(`volume ${name} still exists after removal`);
}

// ---------------------------------------------------------------------------
// Images

export interface ImageInfo {
  readonly id: string;
  readonly architecture: string;
  readonly os: string;
}

/** Local image by pinned reference; never pulled. */
export async function inspectImage(engine: DockerEngine, reference: string): Promise<ImageInfo | null> {
  try {
    const info = record(await engine.get(`/images/${encodeURIComponent(reference)}/json`), "image");
    return {
      id: str(info.Id, "image ID"),
      architecture: str(info.Architecture, "image architecture"),
      os: str(info.Os, "image OS"),
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Helper containers

export interface HelperMount {
  readonly volume: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface HelperSpec {
  readonly worldId: WorldId;
  /** Short identifier recorded in labels and names, such as `provision` or `attach`. */
  readonly purpose: string;
  readonly image: string;
  /** Explicitly authorized privileged execution; otherwise every capability is dropped except `capAdd`. */
  readonly privileged: boolean;
  readonly capAdd: readonly string[];
  readonly user: string;
  readonly mounts: readonly HelperMount[];
  readonly tmpfs?: Readonly<Record<string, string>>;
  readonly cmd: readonly string[];
  readonly stdin?: Uint8Array;
  /** Receives stdout instead of retaining it; returning false stops the helper early. */
  readonly stdoutSink?: (chunk: Buffer) => boolean;
  readonly stdoutLimit: number;
  readonly stderrLimit: number;
  readonly timeoutMs: number;
  readonly memoryBytes: number;
  readonly pids: number;
  /** Only for tests; otherwise output may take `DRAIN_AFTER_EXIT_MS` to finish arriving after exit. */
  readonly drainAfterExitMs?: number;
  /** Awaited after the container exists and before it starts, e.g. to record the invocation durably. */
  readonly beforeStart?: (container: { readonly id: string; readonly name: string }) => Promise<void>;
}

export interface HelperResult {
  readonly containerId: string;
  readonly name: string;
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stdoutBytes: number;
  readonly stderr: Buffer;
  readonly stderrBytes: number;
  readonly timedOut: boolean;
  /** The stdout sink asked to stop. */
  readonly stopped: boolean;
  /** The stream ended inside a frame or with a transport error. */
  readonly streamProblem: string | null;
}

export class HelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelperError";
  }
}

const DRAIN_AFTER_EXIT_MS = 5_000;

/**
 * Runs one fixed helper command in a fresh, labelled, network-less container
 * with a read-only root, bounded memory, PIDs, output, and time, then removes
 * exactly that container and confirms it is gone. Killing the client alone is
 * never taken as proof that the container stopped.
 */
export async function runHelper(engine: DockerEngine, spec: HelperSpec): Promise<HelperResult> {
  const name = `alife-${spec.worldId}-helper-${spec.purpose}-${randomBytes(4).toString("hex")}`;
  const hostConfig: Record<string, unknown> = {
    NetworkMode: "none",
    ReadonlyRootfs: true,
    LogConfig: { Type: "none", Config: {} },
    RestartPolicy: { Name: "no" },
    AutoRemove: false,
    Memory: spec.memoryBytes,
    MemorySwap: spec.memoryBytes,
    PidsLimit: spec.pids,
    Mounts: spec.mounts.map((mount) => ({
      Type: "volume",
      Source: mount.volume,
      Target: mount.target,
      ReadOnly: mount.readOnly,
      VolumeOptions: { NoCopy: true },
    })),
    Tmpfs: spec.tmpfs ?? {},
  };
  if (spec.privileged) {
    hostConfig.Privileged = true;
  } else {
    hostConfig.CapDrop = ["ALL"];
    hostConfig.CapAdd = [...spec.capAdd];
    hostConfig.SecurityOpt = ["no-new-privileges"];
  }
  const withStdin = spec.stdin !== undefined;

  let id: string;
  try {
    const created = record(
      await engine.post("/containers/create", {
        query: { name },
        body: {
          Image: spec.image,
          Cmd: spec.cmd,
          Entrypoint: [],
          User: spec.user,
          Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
          Labels: labels(spec.worldId, "helper", spec.purpose),
          AttachStdin: withStdin,
          OpenStdin: withStdin,
          StdinOnce: withStdin,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          NetworkDisabled: true,
          HostConfig: hostConfig,
        },
      }),
      "container create",
    );
    id = str(created.Id, "container ID");
  } catch (error) {
    // A lost answer may still have created the container: remove it by exact name and labels.
    if (error instanceof EngineUnavailableError) await removeHelperByName(engine, spec.worldId, name);
    throw error;
  }

  const cleanup = () => removeContainer(engine, { id, name, worldId: spec.worldId, role: "helper" }, { force: true });
  try {
    const info = await inspectContainer(engine, id);
    if (info === null || info.id !== id) throw new HelperError(`helper ${name} vanished after creation`);
    expectContainer(info, name, spec.worldId, "helper");
    await spec.beforeStart?.({ id, name });
    return await attachAndRun(engine, spec, id, name, withStdin);
  } finally {
    await cleanup();
  }
}

async function removeHelperByName(engine: DockerEngine, worldId: WorldId, name: string): Promise<void> {
  const info = await inspectContainer(engine, name).catch(() => null);
  if (info === null) return;
  await removeContainer(engine, { id: info.id, name, worldId, role: "helper" }, { force: true });
}

async function attachAndRun(
  engine: DockerEngine,
  spec: HelperSpec,
  id: string,
  name: string,
  withStdin: boolean,
): Promise<HelperResult> {
  const stdout = new HeadRetainer(spec.stdoutSink ? 0 : spec.stdoutLimit);
  const stderr = new HeadRetainer(spec.stderrLimit);
  let stdoutBytes = 0;
  let stopped = false;
  let streamProblem: string | null = null;
  let stream: RawStream | null = null;

  let resolveEnded!: () => void;
  let drained = false;
  const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
  let resolveStopped!: (value: "stopped") => void;
  const stoppedEarly = new Promise<"stopped">((resolve) => (resolveStopped = resolve));
  const demuxer = new FrameDemuxer((which, bytes) => {
    if (which === "stderr") {
      stderr.add(bytes);
      return;
    }
    stdoutBytes += bytes.length;
    if (spec.stdoutSink) {
      if (!stopped && !spec.stdoutSink(Buffer.from(bytes))) {
        stopped = true;
        stream?.destroy();
        resolveStopped("stopped");
      }
    } else {
      stdout.add(bytes);
    }
  });

  const query: Record<string, string> = { stream: "1", stdout: "1", stderr: "1" };
  if (withStdin) query.stdin = "1";
  stream = await engine.hijack(`/containers/${id}/attach`, undefined, { query, writable: withStdin, timeoutMs: 15_000 });
  stream.onData((chunk) => {
    try {
      demuxer.push(chunk);
    } catch (error) {
      streamProblem = (error as Error).message;
      stream?.destroy();
    }
  });
  stream.onEnd((reason, error) => {
    // Only end-of-file is a completed drain; an early close may have abandoned output, stderr included.
    if (reason === "error" && streamProblem === null && !stopped) streamProblem = error?.message ?? "stream error";
    if (reason === "closed" && streamProblem === null && !stopped) streamProblem = "the output stream closed without end-of-file";
    drained = reason === "eof";
    resolveEnded();
  });

  await engine.post(`/containers/${id}/start`);
  if (withStdin) {
    // A helper that fails before reading its input closes the stream; its exit status and stderr say why.
    await stream.write(Buffer.from(spec.stdin!)).catch((error: Error) => {
      streamProblem ??= `input not fully delivered: ${error.message}`;
    });
    stream.end();
  }

  const deadline = Date.now() + spec.timeoutMs;
  let exitCode: number | null;
  let timedOut = false;
  const waitFor = async (ms: number): Promise<number | null> => {
    try {
      const reply = record(
        await engine.post(`/containers/${id}/wait`, { query: { condition: "not-running" }, timeoutMs: Math.max(ms, 1) }),
        "wait",
      );
      return num(reply.StatusCode, "StatusCode");
    } catch (error) {
      if (error instanceof EngineUnavailableError) return null;
      throw error;
    }
  };

  // A stopped sink ends the helper early; otherwise wait for its own exit.
  const outcome = await Promise.race([waitFor(deadline - Date.now()), stoppedEarly]);
  if (outcome === "stopped" || outcome === null) {
    // No answer before the deadline is a timeout; an earlier failure means the engine was unreachable.
    timedOut = outcome === null && Date.now() >= deadline - 1_000;
    if (outcome === null && !timedOut) streamProblem ??= "the engine did not answer while waiting for the helper";
    await engine.post(`/containers/${id}/kill`).catch(() => undefined);
    exitCode = await waitFor(10_000);
    if (exitCode === null) throw new HelperError(`helper ${name} did not stop after being killed; it is removed by ID next`);
  } else {
    exitCode = outcome;
  }

  // Output can still be in flight after exit; wait a bounded time for the stream to end.
  let timer: NodeJS.Timeout | undefined;
  const drainMs = spec.drainAfterExitMs ?? DRAIN_AFTER_EXIT_MS;
  await Promise.race([ended, new Promise<void>((resolve) => (timer = setTimeout(resolve, drainMs)))]);
  clearTimeout(timer);
  // Destroying a stream that never ended abandons whatever it still held, stderr included.
  if (!drained && !stopped) streamProblem ??= `the output stream did not end within ${drainMs} ms after the helper exited; remaining output was abandoned`;
  if (demuxer.midFrame && streamProblem === null && !stopped) streamProblem = "stream ended inside a frame";
  stream.destroy();

  return {
    containerId: id,
    name,
    exitCode,
    stdout: Buffer.from(stdout.snapshot().retained),
    stdoutBytes,
    stderr: Buffer.from(stderr.snapshot().retained),
    stderrBytes: stderr.totalBytes,
    timedOut,
    stopped,
    streamProblem,
  };
}
