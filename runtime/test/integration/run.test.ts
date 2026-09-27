// Phase 3 gate on a real Docker engine (plan §16): scripted actions write and
// read persistent files across ticks and context eviction, every attempted
// effect is accounted for, and an interrupted controller leaves a run that is
// detected and finalized without replay. Opt-in and explicit, like the world
// tests: it creates one disposable, labelled world, runs the explicitly
// authorized privileged storage helper, and removes exactly what it created.
//
//   ALIFE_TEST_DOCKER_CONTEXT=orbstack \
//   ALIFE_TEST_ALLOW_PRIVILEGED_HELPER=1 \
//   ALIFE_TEST_WORLD_IMAGE=sha256:… ALIFE_TEST_HELPER_IMAGE=sha256:… \
//   npm run test:integration

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { loadConfig, type ResolvedConfig } from "../../src/config/resolve.ts";
import { systemClock } from "../../src/core/clock.ts";
import { newWorldId, parseRunId, type WorldId } from "../../src/core/ids.ts";
import { main } from "../../src/cli.ts";
import { requestBounds } from "../../src/mind/create.ts";
import { FakeMind, type FakeTurn } from "../../src/mind/fake.ts";
import { acquireOwnership } from "../../src/operator/locks.ts";
import { startRun } from "../../src/operator/run.ts";
import { prepareStateDir, type StateLayout } from "../../src/operator/state-dir.ts";
import { FAKE_MIND_RATES } from "../../src/records/accounting.ts";
import { readCheckpoint } from "../../src/records/checkpoint.ts";
import { JsonlEventLog, readEventLog, WORLD_EVENT_TYPES } from "../../src/records/events.ts";
import { analyzeRun } from "../../src/records/finalize.ts";
import { runPaths } from "../../src/records/run-store.ts";
import { createWorld, DockerWorld, openWorldForDestruction, runtimeSettings, worldHistory } from "../../src/world/backend.ts";
import { DockerEngine, resolveDockerContext } from "../../src/world/engine.ts";
import { readWorldMetadata, worldPaths } from "../../src/world/metadata.ts";
import { WORLD_LABEL } from "../../src/world/resources.ts";

const CONTEXT = process.env.ALIFE_TEST_DOCKER_CONTEXT;
const WORLD_IMAGE = process.env.ALIFE_TEST_WORLD_IMAGE;
const HELPER_IMAGE = process.env.ALIFE_TEST_HELPER_IMAGE;
if (!CONTEXT || !WORLD_IMAGE || !HELPER_IMAGE || process.env.ALIFE_TEST_ALLOW_PRIVILEGED_HELPER !== "1") {
  throw new Error(
    "integration tests need ALIFE_TEST_DOCKER_CONTEXT, ALIFE_TEST_WORLD_IMAGE, ALIFE_TEST_HELPER_IMAGE, and " +
      "ALIFE_TEST_ALLOW_PRIVILEGED_HELPER=1 (explicit authorization for the privileged storage helper)",
  );
}

const RUNTIME = path.resolve(import.meta.dirname, "../..");
const CLI = path.join(RUNTIME, "src/cli.ts");
/** Must never reach the world or a record. */
const CONTROLLER_SECRET = "controller-secret-c0ffee";
process.env.ALIFE_TEST_CONTROLLER_SECRET = CONTROLLER_SECRET;

let root: string;
let layout: StateLayout;
let engine: DockerEngine;
let worldId: WorldId;
let configDirectory: string;

/** A configuration for this world with its own fake script; perception is large so a few ticks force eviction. */
async function configWith(turns: FakeTurn[], operator: Record<string, number> = {}, body: Record<string, number> = {}): Promise<{ resolved: ResolvedConfig; file: string }> {
  const config = JSON.parse(await readFile(path.join(RUNTIME, "test/fixtures/fake.config.json"), "utf8")) as Record<string, Record<string, unknown>>;
  const world = config.world!;
  world.image = WORLD_IMAGE;
  world.storage = { ...(world.storage as object), helperImage: HELPER_IMAGE, capacityMiB: 32, inodes: 1024 };
  Object.assign(world, { seed: "sparse-v1", memoryMiB: 128, pids: 64, fileDescriptors: 128, tmpMiB: 8, shmMiB: 4 });
  Object.assign(config.body!, {
    minimumTickIntervalMs: 0,
    actionWaitMs: 500,
    maximumConcurrentJobs: 2,
    retainedFinishedJobs: 8,
    capturedOutputBytes: 65_536,
    perceivedOutputBytes: 65_536,
    // Small enough that a few 32 KiB results fill the room left for history and force eviction.
    contextBudgetTokens: 140_000,
    prompt: "prompt.txt",
    ...body,
  });
  Object.assign(config.operator!, operator);
  const directory = await mkdtemp(path.join(configDirectory, "config-"));
  await copyFile(path.join(RUNTIME, "prompts/baseline.txt"), path.join(directory, "prompt.txt"));
  await writeFile(path.join(directory, "fake-script.json"), JSON.stringify({ schemaVersion: 1, turns }));
  const file = path.join(directory, "config.json");
  await writeFile(file, JSON.stringify(config));
  const result = await loadConfig(file);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return { resolved: result.resolved, file };
}

async function run(turns: FakeTurn[], body: Record<string, number> = {}) {
  const { resolved } = await configWith(turns, { maximumTicks: turns.length }, body);
  const mind = new FakeMind(resolved.fakeScript!.script, requestBounds(resolved), { capture: true });
  const result = await startRun({
    layout,
    resolved,
    worldId,
    clock: systemClock,
    signal: new AbortController().signal,
    allowPrivilegedHelper: true,
    mind: { mind, rates: FAKE_MIND_RATES },
  });
  const paths = runPaths(layout, result.runId);
  const log = await readEventLog(paths.events);
  assert.deepEqual(log.issues, []);
  return { result, requests: mind.requests, events: log.events, paths };
}

async function labelled(): Promise<{ containers: number; volumes: number }> {
  const filters = JSON.stringify({ label: [`${WORLD_LABEL}=${worldId}`] });
  const containers = (await engine.get("/containers/json", { query: { all: "true", filters } })) as unknown[];
  const volumes = ((await engine.get("/volumes", { query: { filters } })) as { Volumes: unknown[] | null }).Volumes ?? [];
  return { containers: containers.length, volumes: volumes.length };
}

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, "--state-dir", root], (line) => out.push(line), (line) => err.push(line));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "alife-run-it-"));
  configDirectory = await mkdtemp(path.join(tmpdir(), "alife-run-config-"));
  layout = await prepareStateDir(root);
  engine = new DockerEngine(await resolveDockerContext(CONTEXT));
  worldId = newWorldId(systemClock.now());
  const { resolved } = await configWith([]);
  const lock = await acquireOwnership(layout.locks, "world", worldId, systemClock);
  try {
    const world = await createWorld(
      { layout, worldId, ownership: lock, clock: systemClock, allowPrivilegedHelper: false },
      { dockerContext: CONTEXT, resolved, minimumHostFreeMiB: 0 },
    );
    await world.close();
  } finally {
    await lock.release();
  }
});

after(async () => {
  if (worldId !== undefined && !(await worldHistory(worldPaths(layout, worldId)).catch(() => ({ destroyed: false }))).destroyed) {
    const lock = await acquireOwnership(layout.locks, "world", worldId, systemClock);
    try {
      const world = await openWorldForDestruction({ layout, worldId, ownership: lock, clock: systemClock, allowPrivilegedHelper: true });
      try {
        await world.stop("operator_stop");
        const destroyed = await world.destroy();
        assert.ok(destroyed.verified, destroyed.detail);
      } finally {
        await world.close();
      }
    } finally {
      await lock.release();
    }
    assert.deepEqual(await labelled(), { containers: 0, volumes: 0 });
  }
  await rm(configDirectory, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("durable loop on a real world", () => {
  it("writes and reads persistent files across ticks and context eviction, accounting for every effect", async () => {
    const flood = "head -c 40000 /dev/zero | tr '\\0' y";
    const turns: FakeTurn[] = [
      { type: "shell", command: "printf 'remember-me\\n' > /world/note.txt && ls /world/materials" },
      { type: "shell", command: "sleep 1; echo done-late" },
      ...Array.from({ length: 5 }, (): FakeTurn => ({ type: "shell", command: flood })),
      { type: "shell", command: "cat /world/note.txt" },
      { type: "wait" },
    ];
    // A 500 ms cadence gives the continuing job time to finish before the last tick.
    const { result, requests, events, paths } = await run(turns, { minimumTickIntervalMs: 500 });
    assert.deepEqual([result.state, result.reason, result.completedTicks], ["completed", "tick_limit", 9], result.detail);
    assert.ok(result.worldStop?.verified);

    // Tick 1 wrote the file and saw the seed.
    const first = requests[1]!.history.find((exchange) => exchange.tick === 1)!;
    assert.match(first.results[0]!.output, /state: exited with status 0\n/);
    assert.match(first.results[0]!.output, /fragments\.txt\nmeasurements\.csv\n/);
    // Nothing lists /world for the agent: it saw the seed only through its own ls.
    for (const request of requests) assert.doesNotMatch(request.observation, /Listing|materials/);

    // Tick 2 outlived its wait, kept running, and later observations saw it finish.
    const second = requests[2]!.history.find((exchange) => exchange.tick === 2)!;
    assert.match(second.results[0]!.output, /state: still running after 0 s of waiting; it was not stopped/);
    const job = `${result.runId}.t000002.action`;
    assert.ok(
      requests.some((request) => request.observation.includes(`${job}: exited with status 0`)),
      "a later observation reports the continuing job's exit",
    );

    // By tick 8, tick 1's exchange was evicted, yet the file it wrote is still there.
    const reading = requests[8]!;
    const retained = reading.history.map((exchange) => exchange.tick);
    assert.ok(!retained.includes(1), `retained ${retained.join(",")}`);
    assert.deepEqual(retained, Array.from({ length: retained.length }, (_, index) => 9 - retained.length + index));
    const read = reading.history.find((exchange) => exchange.tick === 8)!;
    assert.match(read.results[0]!.output, /stdout: 12 bytes\nremember-me\n/);
    assert.match(reading.observation, /earlier exchanges? (?:is|are) no longer included/);
    assert.ok(events.some((event) => event.type === "context.evicted"));

    // Every request and action has exactly one outcome; nothing is outstanding.
    const analysis = await analyzeRun(paths, result.runId);
    assert.equal(analysis.state, "completed");
    assert.deepEqual(analysis.outstanding, { requests: [], actions: [], reservations: [] });
    const prepared = events.filter((event) => event.type === "action.prepared").length;
    const resolved = events.filter((event) => ["action.completed", "action.running", "action.uncertain", "action.refused"].includes(event.type)).length;
    assert.equal(prepared, 8);
    assert.equal(resolved, prepared);

    const checkpoint = await readCheckpoint(paths, result.checkpointSha256!);
    // The checkpoint rests on the real stop's sealed, review-free assessment of this run's epoch.
    assert.deepEqual([checkpoint.safety.sealed, checkpoint.safety.reviewRequired, checkpoint.safety.committedEffects], [true, false, 8]);
    assert.equal(checkpoint.safety.epochId, result.worldStop.safety.epochId);
    assert.equal(checkpoint.loop.completedTicks, 9);
    assert.ok(checkpoint.loop.evictedCount > 0);
    assert.deepEqual(checkpoint.loop.history.map((exchange) => exchange.tick), [...retained, 9]);

    // No controller variable reached the run's records.
    for (const name of await readdir(paths.directory, { recursive: true })) {
      const file = path.join(paths.directory, name);
      const content = await readFile(file).catch(() => null);
      if (content !== null) assert.ok(!content.includes(CONTROLLER_SECRET), `${name} contains the controller secret`);
    }
  });

  it("finds the files again in a later run, in a new container, with no replay", async () => {
    const { result, requests, events } = await run([{ type: "shell", command: "cat /world/note.txt; ls /world" }, { type: "wait" }]);
    assert.equal(result.state, "completed", result.detail);
    assert.doesNotMatch(requests[0]!.observation, /note\.txt/);
    assert.match(requests[1]!.history[0]!.results[0]!.output, /remember-me\n[\s\S]*note\.txt/);
    assert.equal(events.filter((event) => event.type === "action.prepared").length, 1);
  });

  it("detects a killed controller, and finalizes only after the world is stopped", async () => {
    // Tick 1 starts a long job; the controller is killed while it waits before tick 2.
    const { file } = await configWith([{ type: "shell", command: "sleep 600" }, { type: "wait" }], { maximumTicks: 2 });
    const config = JSON.parse(await readFile(file, "utf8")) as { body: Record<string, unknown> };
    config.body.minimumTickIntervalMs = 3_600_000;
    await writeFile(file, JSON.stringify(config));
    const child = spawn(process.execPath, [CLI, "run", "start", "--world", worldId, "--config", file, "--state-dir", root], {
      // The Docker CLI resolves the context from HOME; nothing else is passed.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const deadline = Date.now() + 60_000;
    while (!/tick 1: /.test(output)) {
      assert.ok(Date.now() < deadline && child.exitCode === null, `the run did not complete tick 1: ${output}`);
      await delay(100);
    }
    const runId = parseRunId(/run (r-\S+) in world/.exec(output)![1]!);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));

    const status = await cli("run", "status", runId);
    assert.match(status.out, /running \(INTERRUPTED: no live owner\)/);
    assert.doesNotMatch(status.out, /unknown outcome/);

    // The dead controller's locks are released explicitly, by token.
    for (const [kind, id] of [["run", runId], ["world", worldId]] as const) {
      const shown = await cli("lock", "status", kind, id);
      assert.match(shown.out, /appears dead/);
      const token = /token ([a-f0-9]{32})/.exec(shown.out)![1]!;
      assert.equal((await cli("lock", "release", kind, id, "--token", token)).code, 0);
    }

    // The world is still running (the job too); finalization refuses until it is stopped.
    const refused = await cli("run", "finalize", runId, "--acknowledge-uncertainty");
    assert.equal(refused.code, 1);
    assert.match(refused.err, /still running; stop it explicitly/);
    const stopped = await cli("world", "stop", worldId);
    assert.equal(stopped.code, 0, stopped.err);
    const finalized = await cli("run", "finalize", runId, "--acknowledge-uncertainty");
    assert.equal(finalized.code, 0, finalized.err);
    assert.match(finalized.out, /finalized; it cannot be resumed/);
    const analysis = await analyzeRun(runPaths(layout, runId), runId);
    assert.equal(analysis.state, "finalized");
    const log = await readEventLog(runPaths(layout, runId).events);
    assert.deepEqual(log.events.slice(-2).map((event) => event.type), ["run.recovery_required", "run.finalized"]);
    // Nothing was dispatched again after the interruption.
    assert.equal(log.events.filter((event) => event.type === "action.prepared").length, 1);
  });

  it("stops a real world whose log fails, at startup and when stopping", async () => {
    const { resolved } = await configWith([]);
    const paths = worldPaths(layout, worldId);
    const metadata = await readWorldMetadata(paths, worldId);
    const lock = await acquireOwnership(layout.locks, "world", worldId, systemClock);
    const container = async () => ((await engine.get("/containers/json", { query: { all: "true", filters: JSON.stringify({ label: [`${WORLD_LABEL}=${worldId}`, "sh.alife.role=world"] }) } })) as unknown[]).length;
    try {
      const access = { layout, worldId, ownership: lock, clock: systemClock, allowPrivilegedHelper: true };
      let failing: (type: string) => boolean = () => false;
      const log = await JsonlEventLog.open({ file: paths.events, runId: worldId, clock: systemClock, limitBytes: 256 << 20, types: WORLD_EVENT_TYPES });
      const append = log.append.bind(log);
      log.append = (type, data, options) => (failing(type) ? Promise.reject(new Error("injected record failure")) : append(type, data, options));
      const world = new DockerWorld(access, engine, metadata, paths, log, runtimeSettings(resolved.config));
      try {
        // The container is running when its start record fails: the world stops and removes it.
        failing = (type) => type === "world.started";
        await assert.rejects(world.start(), /after its container was running \(injected record failure\); stopped/);
        assert.equal(await container(), 0);

        // A started world whose log then fails entirely is still stopped, and says its records are incomplete.
        failing = () => false;
        await world.start();
        assert.equal(await container(), 1);
        failing = () => true;
        const stopped = await world.stop("record_failure");
        assert.deepEqual([stopped.verified, stopped.recorded], [true, false]);
        // Physically stopped, but the epoch's evidence is incomplete: sealed, yet never certifiable as clean.
        assert.deepEqual([stopped.safety.sealed, stopped.safety.requiredEvidenceFailed, stopped.safety.reviewRequired], [true, true, true]);
        assert.match(stopped.detail, /not recorded: world\.stopping: injected record failure/);
        assert.equal(await container(), 0);
      } finally {
        failing = () => false;
        await world.close();
      }
    } finally {
      await lock.release();
    }
  });
});

