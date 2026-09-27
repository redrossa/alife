import { hostname } from "node:os";
import path from "node:path";

import { loadConfig } from "../../src/config/resolve.ts";
import type { Clock } from "../../src/core/clock.ts";
import { parseWorldId, type WorldId } from "../../src/core/ids.ts";
import { Ownership } from "../../src/operator/locks.ts";
import type { StateLayout } from "../../src/operator/state-dir.ts";
import { JsonlEventLog, WORLD_EVENT_TYPES, type WorldEventType } from "../../src/records/events.ts";
import { DockerWorld, runtimeSettings, type WorldStorage } from "../../src/world/backend.ts";
import { DockerEngine, EngineResponseError, type RawStream, type RequestOptions } from "../../src/world/engine.ts";
import { LAUNCHER_SCRIPT, SIGNAL_SCRIPT } from "../../src/world/jobs.ts";
import { createWorldDirectory, worldPaths, type WorldMetadata } from "../../src/world/metadata.ts";
import { SENSOR_SCRIPT, STARTUP_SCRIPT } from "../../src/world/probes.ts";
import { FIXTURES } from "./config.ts";
import { FakeStream, frame } from "./fake-exec.ts";
import { goodFacts } from "./startup-facts.ts";

// A real `DockerWorld` over an in-memory engine: container create/start/stop/
// remove, exec create/start/inspect, statistics, and the in-world readings
// (the startup facts match the fixture profile). Only storage attachment is
// replaced, since it needs the privileged helper; every verification, job,
// safety, and stop path in the backend runs as in production.

export const OFFLINE_WORLD = parseWorldId("w-20260925T161449Z-0ff11e00");
const IMAGE = `sha256:${"0".repeat(64)}`;
const FSID = "88d84c444c440090";

export interface OfflineExec {
  readonly id: string;
  readonly cmd: readonly string[];
  readonly kind: "startup" | "sensor" | "signal" | "job" | "other";
  readonly pid: number;
  starts: number;
  running: boolean;
  exitCode: number | null;
  /** The engine no longer knows this execution: inspection answers 404. */
  gone: boolean;
  stream: FakeStream | null;
}

interface Body {
  Image: string;
  Env: string[];
  User: string;
  Labels: Record<string, string>;
  HostConfig: Record<string, unknown> & { Mounts: { Source: string; Target: string; ReadOnly: boolean }[] };
}

function kindOf(cmd: readonly string[]): OfflineExec["kind"] {
  if (cmd[3] === STARTUP_SCRIPT) return "startup";
  if (cmd[3] === SENSOR_SCRIPT) return "sensor";
  if (cmd[3] === SIGNAL_SCRIPT) return "signal";
  if (cmd[2] === LAUNCHER_SCRIPT) return "job";
  return "other";
}

export class OfflineEngine extends DockerEngine {
  readonly calls: string[] = [];
  container: { id: string; name: string; body: Body; running: boolean } | null = null;
  readonly execs = new Map<string, OfflineExec>();
  /** While set, exec inspections wait for it (an answer that crosses a stop). */
  inspectGate: Promise<void> | null = null;
  /** While set, exec inspections fail as if the engine were unreachable (not as if the exec were gone). */
  unavailable = false;
  /** When set, the container stop request fails with this error. */
  stopError: Error | null = null;
  /** Called when the container stop request is issued (the stop's commitment point). */
  onStop: (() => void) | null = null;
  #next = 0;

  constructor() {
    super({ name: "offline", endpoint: "unix:///nonexistent", socketPath: "/nonexistent" });
  }

  /** Agent jobs in creation order. */
  jobs(): OfflineExec[] {
    return [...this.execs.values()].filter((exec) => exec.kind === "job");
  }

  /** The engine forgets agent job `n` (1-based): its inspection now answers 404. */
  forget(n: number): void {
    this.jobs()[n - 1]!.gone = true;
  }

  finishJob(n: number, exitCode: number): void {
    const exec = this.jobs()[n - 1]!;
    exec.running = false;
    exec.exitCode = exitCode;
    exec.stream?.finish("eof");
  }

  #container() {
    return {
      Id: this.container!.id,
      Name: `/${this.container!.name}`,
      Image: this.container!.body.Image,
      Config: { Labels: this.container!.body.Labels, Env: this.container!.body.Env, User: this.container!.body.User },
      State: {
        Running: this.container!.running,
        Status: this.container!.running ? "running" : "exited",
        ExitCode: this.container!.running ? 0 : 137,
        OOMKilled: false,
        StartedAt: "2026-09-25T16:14:49Z",
        FinishedAt: "",
      },
      HostConfig: this.container!.body.HostConfig,
      Mounts: this.container!.body.HostConfig.Mounts.map((mount) => ({ Type: "volume", Name: mount.Source, Destination: mount.Target, RW: !mount.ReadOnly })),
    };
  }

  override async get(route: string): Promise<unknown> {
    this.calls.push(`GET ${route}`);
    if (route === "/version") return { Version: "0", ApiVersion: "1.44", MinAPIVersion: "1.24", Arch: "arm64" };
    if (route === "/info") {
      return { ID: "offline-engine", OSType: "linux", CgroupVersion: "2", OperatingSystem: "offline", Architecture: "aarch64", KernelVersion: "0", SecurityOptions: [] };
    }
    const exec = /^\/exec\/([a-f0-9]{64})\/json$/.exec(route);
    if (exec !== null) {
      const gate = this.inspectGate;
      if (gate !== null) await gate;
      const found = this.execs.get(exec[1]!);
      if (this.unavailable) throw new Error("engine unavailable (offline test)");
      if (found === undefined || found.gone) throw new EngineResponseError(404, `${route}: no such exec`);
      return { Running: found.running, ExitCode: found.exitCode };
    }
    if (/\/stats$/.test(route)) return { memory_stats: { usage: 1 << 20, limit: 256 << 20 }, pids_stats: { current: 3, limit: 64 } };
    const key = decodeURIComponent(/^\/containers\/([^/]+)\/json$/.exec(route)?.[1] ?? "");
    if (this.container === null || (key !== this.container.id && key !== this.container.name)) throw new EngineResponseError(404, "no such container");
    return this.#container();
  }

  override post(route: string, options: RequestOptions = {}): Promise<unknown> {
    this.calls.push(`POST ${route}`);
    if (route === "/containers/create") {
      this.container = { id: "c".repeat(64), name: options.query!.name!, body: options.body as Body, running: false };
      return Promise.resolve({ Id: this.container.id });
    }
    if (route.endsWith("/exec")) {
      const id = (++this.#next).toString(16).padStart(64, "e");
      const cmd = (options.body as { Cmd: string[] }).Cmd;
      this.execs.set(id, { id, cmd, kind: kindOf(cmd), pid: 100 + this.#next, starts: 0, running: false, exitCode: null, gone: false, stream: null });
      return Promise.resolve({ Id: id });
    }
    if (route.startsWith("/containers/") && this.container === null) return Promise.reject(new EngineResponseError(404, `${route}: no such container`));
    if (route.endsWith("/start")) this.container!.running = true;
    if (route.endsWith("/stop")) {
      this.onStop?.();
      if (this.stopError !== null) return Promise.reject(this.stopError);
      this.container!.running = false;
      // Every process ends; streams end with end-of-file.
      for (const exec of this.execs.values()) {
        if (exec.running) {
          exec.running = false;
          exec.exitCode = 137;
          exec.stream?.finish("eof");
        }
      }
    }
    return Promise.resolve(null);
  }

  override delete(route: string): Promise<unknown> {
    this.calls.push(`DELETE ${route}`);
    this.container = null;
    return Promise.resolve(null);
  }

  override hijack(route: string): Promise<RawStream> {
    this.calls.push(`HIJACK ${route}`);
    const exec = this.execs.get(/^\/exec\/([a-f0-9]{64})\/start$/.exec(route)![1]!)!;
    exec.starts += 1;
    const stream = new FakeStream();
    exec.stream = stream;
    exec.running = true;
    const reply = (text: string) => {
      stream.emit(frame("stdout", text));
      exec.running = false;
      exec.exitCode = 0;
      stream.finish("eof");
    };
    switch (exec.kind) {
      case "startup":
        reply(JSON.stringify(goodFacts()));
        break;
      case "sensor":
        reply(JSON.stringify({ storage: [4096, 32768, 30000, 4096, 4000], storageError: null, listing: null, listingError: null }));
        break;
      case "signal":
        reply(JSON.stringify({ result: "sent" }));
        break;
      case "job":
        stream.emit(frame("stderr", `alife-job ${exec.pid} 123456\n`));
        break;
      default:
        reply("");
    }
    return Promise.resolve(stream);
  }
}

/** Storage that is already attached to /dev/loop0 with the fixture's filesystem ID. */
const attachedStorage = {
  expectedFsid: FSID,
  ensureAttached: () => Promise.resolve({ device: "/dev/loop0", attached: false, check: { ok: true, device: "/dev/loop0", reason: null, fsid: FSID, mount: null } }),
  superblock: () => Promise.reject(new Error("not available offline")),
  streamArchive: () => Promise.reject(new Error("not available offline")),
  removeDeviceVolumes: () => Promise.reject(new Error("not available offline")),
  detach: () => Promise.reject(new Error("not available offline")),
  removeBackingVolume: () => Promise.reject(new Error("not available offline")),
} as unknown as WorldStorage;

export interface OfflineWorld {
  readonly world: DockerWorld;
  readonly engine: OfflineEngine;
  readonly worldId: WorldId;
  readonly log: JsonlEventLog<WorldEventType>;
}

/**
 * A provisioned offline world in `layout`, not yet started. `wrapLog` can hold
 * or fail world records. The world lock is not taken: `startRun` takes it.
 */
export async function offlineWorld(
  layout: StateLayout,
  clock: Clock,
  options: { readonly wrapLog?: (log: JsonlEventLog<WorldEventType>) => void } = {},
): Promise<OfflineWorld> {
  const loaded = await loadConfig(path.join(FIXTURES, "fake.config.json"));
  if (!loaded.ok) throw new Error("fixture invalid");
  const settings = runtimeSettings(loaded.resolved.config);
  const paths = worldPaths(layout, OFFLINE_WORLD);
  await createWorldDirectory(paths);
  const metadata: WorldMetadata = {
    schemaVersion: 1,
    worldId: OFFLINE_WORLD,
    createdAt: clock.now().toISOString(),
    docker: { context: "offline", engineId: "offline-engine", engineVersion: "0", architecture: "aarch64" },
    images: { world: IMAGE, helper: `sha256:${"1".repeat(64)}`, architecture: "arm64" },
    storage: { profile: "loop-ext4-volume-v1", capture: "tar-capture-v1", uuid: "00000000-0000-4000-8000-000000000000", label: "alife-0ff11e00", capacityMiB: 128, inodes: 4096 },
    seed: { id: "empty-v1", status: "fixed", sha256: "0".repeat(64) },
    user: { uid: 1000, gid: 1000 },
    resources: { container: `alife-${OFFLINE_WORLD}`, backingVolume: "b", deviceVolume: "d", readonlyVolume: "r" },
    configSha256: "0".repeat(64),
  };
  const log = await JsonlEventLog.open({ file: paths.events, runId: OFFLINE_WORLD, clock, limitBytes: 64 << 20, types: WORLD_EVENT_TYPES });
  await log.append("world.provisioned", { superblock: { blockCount: 32768, blockSize: 4096, inodeCount: 4096 } }, { durable: true });
  options.wrapLog?.(log);
  const ownership = new Ownership(path.join(layout.locks, "unused.lock"), {
    schemaVersion: 1,
    kind: "world",
    id: OFFLINE_WORLD,
    token: "0".repeat(32),
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: clock.now().toISOString(),
  });
  const engine = new OfflineEngine();
  const world = new DockerWorld(
    { layout, worldId: OFFLINE_WORLD, ownership, clock, allowPrivilegedHelper: false },
    engine,
    metadata,
    paths,
    log,
    settings,
    { storage: attachedStorage },
  );
  return { world, engine, worldId: OFFLINE_WORLD, log };
}
