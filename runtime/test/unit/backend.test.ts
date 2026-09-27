import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../../src/config/resolve.ts";
import { parseWorldId } from "../../src/core/ids.ts";
import { acquireOwnership } from "../../src/operator/locks.ts";
import { prepareStateDir } from "../../src/operator/state-dir.ts";
import { JsonlEventLog, readEventLog, WORLD_EVENT_TYPES, type WorldEventType } from "../../src/records/events.ts";
import { runPaths } from "../../src/records/run-store.ts";
import { startRun, type RunnableWorld } from "../../src/operator/run.ts";
import { DockerWorld, runtimeSettings, type WorldAccess } from "../../src/world/backend.ts";
import { DockerEngine, EngineResponseError, type RequestOptions } from "../../src/world/engine.ts";
import { createWorldDirectory, worldPaths, type WorldMetadata } from "../../src/world/metadata.ts";
import { labels, resourceNames } from "../../src/world/resources.ts";
import { FIXTURES } from "../support/config.ts";
import { FakeClock } from "../support/fake-clock.ts";

const WORLD = parseWorldId("w-20260925T161449Z-0000d00d");
const NAMES = resourceNames(WORLD);
const IMAGE = `sha256:${"0".repeat(64)}`;

interface Body {
  Image: string;
  Env: string[];
  User: string;
  Labels: Record<string, string>;
  HostConfig: Record<string, unknown> & { Mounts: { Source: string; Target: string; ReadOnly: boolean }[] };
}

/** One world container, echoing back the configuration it was created with. */
class WorldEngine extends DockerEngine {
  readonly calls: string[] = [];
  container: { id: string; name: string; body: Body; running: boolean } | null = null;

  constructor() {
    super({ name: "fake", endpoint: "unix:///nonexistent", socketPath: "/nonexistent" });
  }

  #json() {
    const c = this.container!;
    return {
      Id: c.id,
      Name: `/${c.name}`,
      Image: c.body.Image,
      Config: { Labels: c.body.Labels, Env: c.body.Env, User: c.body.User },
      State: { Running: c.running, Status: c.running ? "running" : "exited", ExitCode: c.running ? 0 : 137, OOMKilled: false, StartedAt: "t", FinishedAt: "" },
      HostConfig: c.body.HostConfig,
      Mounts: c.body.HostConfig.Mounts.map((mount) => ({ Type: "volume", Name: mount.Source, Destination: mount.Target, RW: !mount.ReadOnly })),
    };
  }

  override get(route: string): Promise<unknown> {
    this.calls.push(`GET ${route}`);
    const key = decodeURIComponent(/^\/containers\/([^/]+)\/json$/.exec(route)?.[1] ?? "");
    if (this.container === null || (key !== this.container.id && key !== this.container.name)) {
      return Promise.reject(new EngineResponseError(404, "no such container"));
    }
    return Promise.resolve(this.#json());
  }

  override post(route: string, options: RequestOptions = {}): Promise<unknown> {
    this.calls.push(`POST ${route}`);
    if (route === "/containers/create") {
      this.container = { id: "c".repeat(64), name: options.query!.name!, body: options.body as Body, running: false };
      return Promise.resolve({ Id: this.container.id });
    }
    if (route.endsWith("/start")) this.container!.running = true;
    if (route.endsWith("/stop")) this.container!.running = false;
    return Promise.resolve(null);
  }

  override delete(route: string): Promise<unknown> {
    this.calls.push(`DELETE ${route}`);
    this.container = null;
    return Promise.resolve(null);
  }
}

/** Skips storage attachment, which needs the helper containers this fake engine does not run. */
class UnattachedWorld extends DockerWorld {
  override attach(): Promise<void> {
    return Promise.resolve();
  }
}

async function setup(log: (file: string, clock: FakeClock) => Promise<JsonlEventLog<WorldEventType>>) {
  const layout = await prepareStateDir(await mkdtemp(path.join(tmpdir(), "alife-backend-")));
  const clock = new FakeClock();
  const paths = worldPaths(layout, WORLD);
  await createWorldDirectory(paths);
  const loaded = await loadConfig(path.join(FIXTURES, "fake.config.json"));
  if (!loaded.ok) throw new Error("fixture invalid");
  const settings = runtimeSettings(loaded.resolved.config);
  const metadata: WorldMetadata = {
    schemaVersion: 1,
    worldId: WORLD,
    createdAt: clock.now().toISOString(),
    docker: { context: "fake", engineId: "fake-engine", engineVersion: "0", architecture: "aarch64" },
    images: { world: IMAGE, helper: `sha256:${"1".repeat(64)}`, architecture: "arm64" },
    storage: { profile: "loop-ext4-volume-v1", capture: "tar-capture-v1", uuid: "00000000-0000-4000-8000-000000000000", label: "alife-0000d00d", capacityMiB: 128, inodes: 4096 },
    seed: { id: "empty-v1", status: "fixed", sha256: "0".repeat(64) },
    user: { uid: 1000, gid: 1000 },
    resources: NAMES,
    configSha256: "0".repeat(64),
  };
  const ownership = await acquireOwnership(layout.locks, "world", WORLD, clock);
  const access: WorldAccess = { layout, worldId: WORLD, ownership, clock, allowPrivilegedHelper: false };
  const engine = new WorldEngine();
  const world = new UnattachedWorld(access, engine, metadata, paths, await log(paths.events, clock), settings);
  return { engine, world, layout, ownership, resolved: loaded.resolved };
}

const open = (limitBytes: number) => (file: string, clock: FakeClock) =>
  JsonlEventLog.open({ file, runId: WORLD, clock, limitBytes, types: WORLD_EVENT_TYPES });

describe("world stop without a working world log", () => {
  for (const [name, broken] of [
    ["full", open(1)],
    [
      "closed",
      async (file: string, clock: FakeClock) => {
        const log = await open(1 << 20)(file, clock);
        await log.close();
        return log;
      },
    ],
  ] as const) {
    it(`still stops and removes a running world when the log is ${name}`, async () => {
      const { engine, world } = await setup(broken);
      engine.container = { id: "c".repeat(64), name: NAMES.container, body: { Image: IMAGE, Env: [], User: "1000:1000", Labels: labels(WORLD, "world"), HostConfig: { Mounts: [] } }, running: true };
      const result = await world.stop("record_failure");
      assert.equal(result.verified, true);
      assert.equal(result.recorded, false);
      assert.match(result.detail, /not recorded: world\.stopping: /);
      assert.ok(engine.calls.includes(`POST /containers/${"c".repeat(64)}/stop`), engine.calls.join("\n"));
      assert.equal(engine.container, null);
    });
  }

  it("stops a container that started when a startup record then fails", async () => {
    const { engine, world } = await setup(async (file, clock) => {
      const log = await open(1 << 20)(file, clock);
      const append = log.append.bind(log);
      // Everything records normally except the start itself.
      log.append = (type, data, options) => (type === "world.started" ? Promise.reject(new Error("disk full")) : append(type, data, options));
      return log;
    });
    await assert.rejects(world.start(), /after its container was running \(disk full\); stopped/);
    assert.deepEqual(
      engine.calls.filter((call) => call.startsWith("POST") || call.startsWith("DELETE")),
      ["POST /containers/create", `POST /containers/${"c".repeat(64)}/start`, `POST /containers/${"c".repeat(64)}/stop`, `DELETE /containers/${"c".repeat(64)}`],
    );
    assert.equal(engine.container, null);
  });

  it("leaves a run for review when a failed start stopped the world but could not record it", async () => {
    let broken = false;
    const { engine, world, layout, ownership, resolved } = await setup(async (file, clock) => {
      const log = await open(1 << 20)(file, clock);
      const append = log.append.bind(log);
      // From the start record on, the world log fails persistently.
      log.append = (type, data, options) => {
        if (type === "world.started") broken = true;
        return broken ? Promise.reject(new Error("disk full")) : append(type, data, options);
      };
      return log;
    });
    // startRun takes the world lock itself.
    await ownership.release();
    const runnable: RunnableWorld = {
      identity: world.identity,
      get startCleanup() {
        return world.startCleanup;
      },
      facts: () =>
        Promise.resolve({
          engine: { dockerContext: "fake", engineId: "fake-engine", version: "0", apiVersion: "1.44", os: "fake", architecture: "aarch64", kernel: "0", cgroupVersion: "2", securityOptions: [] },
          world: { image: IMAGE, imageArchitecture: "arm64", seed: "empty-v1", seedSha256: "0".repeat(64), requestedCapacityMiB: 128, effectiveCapacityBytes: 128 << 20, effectiveInodes: 4096 },
        }),
      attach: () => world.attach(),
      start: () => world.start(),
      stop: (reason) => world.stop(reason),
      close: () => world.close(),
      inspect: () => world.inspect(),
      sample: (options) => world.sample(options),
      submit: (request, hooks) => world.submit(request, hooks),
      acknowledgeJobs: (ids) => world.acknowledgeJobs(ids),
      safety: () => world.safety(),
      refreshJobSafety: () => world.refreshJobSafety(),
    };
    const result = await startRun({
      layout,
      resolved,
      worldId: WORLD,
      clock: new FakeClock(),
      signal: new AbortController().signal,
      allowPrivilegedHelper: false,
      openWorld: () => Promise.resolve(runnable),
      hostFreeMiB: () => Promise.resolve(1_000_000),
    });
    // The container was stopped and removed by the world itself...
    assert.equal(engine.container, null);
    assert.ok(engine.calls.includes(`POST /containers/${"c".repeat(64)}/stop`));
    // ...but its stop was not recorded, so the run is not closed as complete.
    assert.deepEqual([result.state, result.reason], ["recovery_required", "world_start_failed"]);
    assert.deepEqual([result.worldStop?.verified, result.worldStop?.recorded], [true, false]);
    const log = await readEventLog(runPaths(layout, result.runId).events);
    const final = log.events.at(-1)!;
    assert.equal(final.type, "run.recovery_required");
    assert.equal((final.data.startCleanup as { recorded: boolean }).recorded, false);
  });
});

