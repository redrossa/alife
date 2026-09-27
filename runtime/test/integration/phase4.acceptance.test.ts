// Real-engine qualification, NOT evidence of Phase 4 completion when skipped.
// No engine restart, host sleep, provider calls, global prune, or PID guessing.
// Frozen additional production contract: run-local watchdog.json is private,
// schema 1 {pid, binding, leaseFile, journalFile, heartbeatIntervalMs}; binding
// is the exact startWatchdog binding. Paths are run-local lease.json and
// watchdog.jsonl. Descriptor is durable before the first boundary. The journal
// uses watchdog.stop_verified / watchdog.released with data.verified=true.
// startWatchdog returns {pid,heartbeat,completed,release}, in a distinct process;
// CLI start uses startManagedRun; CLI resume uses resumeManagedRun (the low-level
// run.ts resumeRun remains independently testable). Both use default supervision.
// run capture <run-id> --label <label> is the frozen explicit capture interface.
// Capture/inspection are benign history, not an intervening execution generation.
// Suspend/host-sleep/engine-restart qualifications are deliberately not here.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { loadConfig } from "../../src/config/resolve.ts";
import { systemClock } from "../../src/core/clock.ts";
import { newWorldId, parseRunId, type RunId } from "../../src/core/ids.ts";
import { acquireOwnership, inspectOwnership } from "../../src/operator/locks.ts";
import { prepareStateDir } from "../../src/operator/state-dir.ts";
import { readCheckpoint } from "../../src/records/checkpoint.ts";
import { readEventLog } from "../../src/records/events.ts";
import { analyzeRun, pendingAcknowledgement } from "../../src/records/finalize.ts";
import { runPaths } from "../../src/records/run-store.ts";
import { createWorld, openWorldForDestruction } from "../../src/world/backend.ts";
import { DockerEngine, resolveDockerContext } from "../../src/world/engine.ts";
import { readWorldMetadata, worldPaths } from "../../src/world/metadata.ts";
import { WORLD_LABEL } from "../../src/world/resources.ts";

const context = process.env.ALIFE_TEST_DOCKER_CONTEXT;
const worldImage = process.env.ALIFE_TEST_WORLD_IMAGE;
const helperImage = process.env.ALIFE_TEST_HELPER_IMAGE;
const authorized = Boolean(context && worldImage && helperImage &&
  process.env.ALIFE_TEST_ALLOW_PRIVILEGED_HELPER === "1" && process.env.ALIFE_TEST_PHASE4_DOCKER === "1");
const runtime = path.resolve(import.meta.dirname, "../..");
const cliFile = path.join(runtime, "src/cli.ts");
const childFile = path.join(runtime, "test/support/phase4-managed-child.ts");
const LEASE = 10_000;
const ALLOWANCE = 30_000;
const boundaries = ["after_model_requested", "after_model_responded", "after_action_prepared", "after_action_commit", "after_world_stop", "after_checkpoint_file"] as const;

interface Descriptor {
  schemaVersion: number; pid: number; leaseFile: string; journalFile: string; heartbeatIntervalMs: number;
  binding: { schemaVersion: number; runId: string; worldId: string; epochId: string; controllerToken: string; engineId: string; containerId: string; deadline: string; leaseMs: number };
}
interface Journal { type: string; data: { verified?: boolean; watchdogPid?: number } }
interface Container { Id: string; Names: string[]; Labels: Record<string, string>; State: string }

async function until(check: () => boolean | Promise<boolean>, ms: number, label: string) {
  const end = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < end, `timed out: ${label}`);
    await delay(100);
  }
}
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("child/barrier timed out")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t: TestContext) {
  assert.ok(authorized);
  for (const image of [worldImage, helperImage]) assert.match(image!, /^sha256:[a-f0-9]{64}$/, "built/pinned IDs only");
  // Dynamic resolution makes missing Phase 4 implementation RED when authorized,
  // not a compile error or a silently skipped qualification.
  for (const [file, name] of [["managed-run.ts", "startManagedRun"], ["managed-run.ts", "resumeManagedRun"], ["watchdog.ts", "startWatchdog"], ["run.ts", "resumeRun"]]) {
    const api = await import(new URL(`../../src/operator/${file}`, import.meta.url).href) as Record<string, unknown>;
    assert.equal(typeof api[name!], "function", `unimplemented Phase 4 API: ${file}:${name}`);
  }
  const root = await mkdtemp("/tmp/p4-real-"); // Keep run-local Unix sockets below sockaddr_un path limits.
  t.diagnostic(`private evidence retained at ${root}`);
  const layout = await prepareStateDir(path.join(root, "state"));
  const engine = new DockerEngine(await resolveDockerContext(context!));
  const expectedEngineId = (await engine.get("/info") as { ID: string }).ID;
  assert.ok(typeof expectedEngineId === "string" && expectedEngineId.length > 0);
  for (const image of [worldImage, helperImage]) {
    const inspected = await engine.get(`/images/${image}/json`) as { Id: string };
    assert.equal(inspected.Id, image, "do not pull or silently retag images");
  }
  const worldId = newWorldId(systemClock.now());
  const config = JSON.parse(await readFile(path.join(runtime, "test/fixtures/fake.config.json"), "utf8")) as Record<string, Record<string, unknown>>;
  Object.assign(config.world!, { image: worldImage, seed: "empty-v1", memoryMiB: 128, pids: 64, fileDescriptors: 128, tmpMiB: 8, shmMiB: 4 });
  Object.assign(config.world!.storage as object, { helperImage, capacityMiB: 32, inodes: 1024 });
  Object.assign(config.body!, { prompt: "prompt.txt", minimumTickIntervalMs: 30_000, actionWaitMs: 2000 });
  Object.assign(config.operator!, { maximumTicks: 3, maximumRunSeconds: 600, minimumHostFreeMiB: 64, watchdogLeaseSeconds: LEASE / 1000, heartbeatIntervalSeconds: 2 });
  assert.equal(config.mind!.provider, "fake");
  config.mind!.requestTimeoutMs = 5000;
  const script = { schemaVersion: 1, turns: [
    { type: "shell", command: "printf 'once\\n' >> /world/append.txt; sqlite3 /world/state.db 'create table t(v); insert into t values (42);'" },
    { type: "shell", command: "cat /world/append.txt; sqlite3 /world/state.db 'select v from t'; test \"$(wc -l < /world/append.txt)\" = 1 && test \"$(sqlite3 /world/state.db 'select count(*) from t')\" = 1" },
    { type: "wait" },
  ] };
  const file = path.join(root, "config.json");
  await copyFile(path.join(runtime, "prompts/baseline.txt"), path.join(root, "prompt.txt"));
  await writeFile(path.join(root, "fake-script.json"), JSON.stringify(script), { mode: 0o600 });
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const loaded = await loadConfig(file);
  assert.ok(loaded.ok);
  const children: { child: ChildProcess; ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; output: () => string }[] = [];
  let success = false;
  let created = false;
  const runIds = new Set<RunId>();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "",
    ...(process.env.DOCKER_CONFIG === undefined ? {} : { DOCKER_CONFIG: process.env.DOCKER_CONFIG }),
    ALIFE_TEST_DOCKER_CONTEXT: context, ALIFE_TEST_WORLD_IMAGE: worldImage, ALIFE_TEST_HELPER_IMAGE: helperImage,
    ALIFE_TEST_ALLOW_PRIVILEGED_HELPER: "1", ALIFE_TEST_PHASE4_DOCKER: "1",
  };
  function launch(args: string[], ipc = false) {
    const child = spawn(process.execPath, args, { env, stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    void ended.catch(() => undefined);
    const handle = { child, ended, output: () => output };
    children.push(handle);
    return handle;
  }
  async function cli(...args: string[]) {
    const h = launch([cliFile, ...args, "--state-dir", layout.root]);
    const result = await within(h.ended, 120_000);
    return { ...result, output: h.output() };
  }
  async function containers(): Promise<Container[]> {
    return await engine.get("/containers/json", { query: { all: "true", filters: JSON.stringify({ label: [`${WORLD_LABEL}=${worldId}`] }) } }) as Container[];
  }
  async function inventory() {
    const metadata = await readWorldMetadata(worldPaths(layout, worldId), worldId);
    const owned = await containers();
    for (const c of owned) {
      assert.equal(c.Labels[WORLD_LABEL], worldId);
      assert.equal(c.Labels["sh.alife.role"], "world", "no stray managed helper");
      assert.deepEqual(c.Names, [`/${metadata.resources.container}`]);
    }
    const reply = await engine.get("/volumes", { query: { filters: JSON.stringify({ label: [`${WORLD_LABEL}=${worldId}`] }) } }) as { Volumes: { Name: string }[] | null };
    const names = (reply.Volumes ?? []).map((v) => v.Name).sort();
    assert.deepEqual(names, [metadata.resources.backingVolume, metadata.resources.deviceVolume].sort(), "exact owned volume inventory; no unrelated resource operations");
    return owned;
  }
  async function releaseDeadLocks() {
    for (const [kind, id] of [["world", worldId], ...[...runIds].map((id) => ["run", id] as const)] as const) {
      const status = await inspectOwnership(layout.locks, kind, id);
      if (status === null) continue;
      assert.ok(status.holder, "unreadable lock: preserve evidence");
      assert.ok(children.some((h) => h.child.pid === status.holder!.pid), "never release an unowned holder");
      assert.equal(status.appearsAlive, false, "never break a live/ambiguous lock");
      const result = await cli("lock", "release", kind, id, "--token", status.holder.token);
      assert.equal(result.code, 0, result.output);
    }
  }
  t.after(async () => {
    try {
      for (const h of children) {
        if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill("SIGKILL");
        await within(h.ended, 10_000);
      }
      if (!created) return;
      // Safety cleanup must not depend on a healthy guardian journal. Stop only
      // this fixture's exact verified world container; never delete backing data
      // merely because a watcher or a record failed. This is not run recovery.
      assert.equal((await engine.get("/info") as { ID: string }).ID, expectedEngineId);
      const metadata = await readWorldMetadata(worldPaths(layout, worldId), worldId);
      for (const container of await containers()) {
        if (container.Labels["sh.alife.role"] !== "world") continue;
        assert.equal(container.Labels[WORLD_LABEL], worldId);
        assert.deepEqual(container.Names, [`/${metadata.resources.container}`]);
        assert.match(container.Id, /^[a-f0-9]{64}$/);
        if (container.State === "running") {
          await engine.post(`/containers/${container.Id}/stop`, { query: { t: "5" } });
          const inspected = await engine.get(`/containers/${container.Id}/json`) as { Id: string; State: { Running: boolean } };
          assert.equal(inspected.Id, container.Id);
          assert.equal(inspected.State.Running, false);
        }
      }
      // Do not destroy a volume while an independent guardian might use it.
      // Absence of terminal evidence leaves backing data in place.
      for (const id of runIds) {
        const journal = path.join(runPaths(layout, id).directory, "watchdog.jsonl");
        await until(async () => {
          const records = await readFile(journal, "utf8").catch(() => "");
          try {
            const parsed = records.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Journal);
            const armed = parsed.findLastIndex((r) => r.type === "watchdog.armed");
            return armed >= 0 && parsed.slice(armed + 1).some((r) => ["watchdog.stop_verified", "watchdog.released"].includes(r.type) && r.data.verified === true);
          } catch { return false; }
        }, LEASE + ALLOWANCE, "watchdog terminal evidence before cleanup");
      }
      await releaseDeadLocks();
      const ownership = await acquireOwnership(layout.locks, "world", worldId, systemClock);
      try {
        const world = await openWorldForDestruction({ layout, worldId, ownership, clock: systemClock, allowPrivilegedHelper: true });
        try {
          assert.equal((await world.stop("operator_stop")).verified, true);
          if (success) {
            const result = await world.destroy();
            assert.equal(result.verified, true, result.detail);
            assert.deepEqual(await containers(), []);
            const leftovers = await engine.get("/volumes", { query: { filters: JSON.stringify({ label: [`${WORLD_LABEL}=${worldId}`] }) } }) as { Volumes: unknown[] | null };
            assert.deepEqual(leftovers.Volumes ?? [], [], "exact owned volumes removed only after verified destruction");
          }
        } finally { await world.close(); }
      } finally { await ownership.release(); }
    } catch (error) {
      t.diagnostic(`cleanup uncertain; backing data and evidence preserved at ${root}: ${String(error)}`);
      throw error;
    }
    // Never recursively remove state, even on success. Evidence is operator-owned.
  });
  const ownership = await acquireOwnership(layout.locks, "world", worldId, systemClock);
  try {
    created = true;
    const world = await createWorld({ layout, worldId, ownership, clock: systemClock, allowPrivilegedHelper: true }, { dockerContext: context!, resolved: loaded.resolved, minimumHostFreeMiB: 64 });
    await world.close();
  } finally { await ownership.release(); }
  async function descriptor(id: RunId, pid: number) {
    const directory = runPaths(layout, id).directory;
    const descriptorFile = path.join(directory, "watchdog.json");
    const d = JSON.parse(await readFile(descriptorFile, "utf8")) as Descriptor;
    assert.equal((await stat(descriptorFile)).mode & 0o077, 0);
    assert.equal(d.schemaVersion, 1);
    assert.ok(Number.isSafeInteger(d.pid) && d.pid > 1);
    assert.notEqual(d.pid, pid); assert.notEqual(d.pid, process.pid);
    assert.equal(d.leaseFile, path.join(directory, "lease.json"));
    assert.equal(d.journalFile, path.join(directory, "watchdog.jsonl"));
    assert.ok(d.heartbeatIntervalMs > 0 && d.heartbeatIntervalMs <= 3000);
    assert.equal(d.binding.leaseMs, LEASE);
    assert.equal(d.binding.runId, id); assert.equal(d.binding.worldId, worldId);
    assert.equal(d.binding.schemaVersion, 1);
    assert.match(d.binding.containerId, /^[a-f0-9]{64}$/);
    assert.ok(d.binding.epochId.length > 0);
    assert.match(d.binding.controllerToken, /^[a-f0-9]{32}$/);
    assert.equal(d.binding.engineId, (await engine.get("/info") as { ID: string }).ID);
    assert.ok(Date.parse(d.binding.deadline) > Date.now());
    const runLog = await readEventLog(runPaths(layout, id).events);
    assert.deepEqual(runLog.issues, []);
    assert.equal(d.binding.deadline, runLog.events.find((e) => e.type === "run.started")?.data.deadline, "guardian bound to original run deadline");
    const holder = await inspectOwnership(layout.locks, "run", id);
    if (holder !== null) {
      assert.equal(holder.holder?.pid, pid);
      assert.equal(holder.holder?.token, d.binding.controllerToken);
    }
    const journal = (await readFile(d.journalFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Journal);
    assert.equal(journal.findLast((r) => r.type === "watchdog.armed")?.data.watchdogPid, d.pid, "durable armed process identity");
    return d;
  }
  async function barrier(name: string) {
    const h = launch([childFile, layout.root, file, worldId, name], true);
    const reached = new Promise<RunId>((resolve, reject) => {
      h.child.on("message", (raw: unknown) => {
        try {
          const m = raw as { type: string; runId: string; worldId?: string; name?: string };
          if (m.type === "created") runIds.add(parseRunId(m.runId));
          if (m.type === "boundary") {
            assert.equal(m.name, name); assert.equal(m.worldId, worldId);
            const id = parseRunId(m.runId); assert.ok(runIds.has(id)); resolve(id);
          }
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
      void h.ended.then(() => reject(new Error(`exited before exact ${name}: ${h.output()}`)), reject);
    });
    const id = await within(reached, 120_000);
    return { h, id, d: await descriptor(id, h.child.pid!) };
  }
  async function kill(h: ReturnType<typeof launch>) {
    assert.equal(h.child.exitCode, null); assert.equal(h.child.signalCode, null);
    assert.equal(h.child.kill("SIGKILL"), true);
    assert.equal((await within(h.ended, 10_000)).signal, "SIGKILL");
  }
  async function stopped(d: Descriptor, killedAt = Date.now()) {
    await until(async () => (await containers()).every((c) => c.Id !== d.binding.containerId || c.State !== "running"), Math.max(0, killedAt + LEASE + ALLOWANCE - Date.now()), "exact world stopped within lease + allowance");
    assert.ok(Date.now() <= killedAt + LEASE + ALLOWANCE, "verified physical stop must meet the kill-relative bound");
    assert.ok((await inventory()).every((c) => c.State !== "running"), "no replacement/automatic resume");
    await until(async () => {
      const journal = (await readFile(d.journalFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Journal);
      const armed = journal.findLastIndex((r) => r.type === "watchdog.armed" && r.data.watchdogPid === d.pid);
      assert.ok(armed >= 0);
      return journal.slice(armed + 1).some((r) => ["watchdog.stop_verified", "watchdog.released"].includes(r.type) && r.data.verified === true);
    }, ALLOWANCE, "durable watchdog terminal evidence");
  }
  return { root, layout, worldId, file, cli, launch, descriptor, barrier, kill, stopped, inventory, releaseDeadLocks, runIds, done() { success = true; } };
}

describe("Phase 4 authorized real-engine acceptance (skips are NOT qualification)", {
  skip: authorized ? false : "requires ALL Docker gates plus ALIFE_TEST_PHASE4_DOCKER=1", concurrency: false, timeout: 1_800_000,
}, () => {
  it("managed CLI start, clean stop, supervised explicit resume, persistent state and private artifacts", { timeout: 300_000 }, async (t) => {
    const f = await fixture(t);
    const h = f.launch([cliFile, "run", "start", "--world", f.worldId, "--config", f.file, "--state-dir", f.layout.root, "--allow-privileged-helper"]);
    // CLI progress is only a stop scheduling aid, never a crash-boundary proof.
    await until(() => { assert.equal(h.child.exitCode, null, h.output()); return /tick 1: /.test(h.output()); }, 120_000, "first CLI tick");
    const id = parseRunId(/run (r-\S+) in world/.exec(h.output())![1]!); f.runIds.add(id);
    const d = await f.descriptor(id, h.child.pid!);
    assert.equal((await f.inventory()).filter((c) => c.Id === d.binding.containerId && c.State === "running").length, 1);
    const liveCapture = await f.cli("run", "capture", id, "--label", "must-refuse-live", "--allow-privileged-helper");
    assert.notEqual(liveCapture.code, 0, liveCapture.output);
    assert.match(liveCapture.output, /running|live|stop|own|lock|held/i);
    assert.equal((await f.inventory()).filter((c) => c.Id === d.binding.containerId && c.State === "running").length, 1, "capture refusal never silently stops the run");
    const stop = await f.cli("run", "stop", id); assert.equal(stop.code, 0, stop.output);
    assert.equal((await within(h.ended, 120_000)).code, 0, h.output());
    const paths = runPaths(f.layout, id);
    const first = await analyzeRun(paths, id); assert.equal(first.state, "stopped_clean");
    const checkpoint = await readCheckpoint(paths, first.checkpointSha256!);
    assert.equal(checkpoint.loop.completedTicks, 1); assert.equal(checkpoint.loop.attemptedCalls, 1);
    assert.equal(checkpoint.safety.epochId, d.binding.epochId);
    await f.stopped(d);
    const capture = await f.cli("run", "capture", id, "--label", "operator-paused", "--allow-privileged-helper");
    assert.equal(capture.code, 0, capture.output);
    const archiveDirectory = worldPaths(f.layout, f.worldId).archives;
    const manual = (await Promise.all((await readdir(archiveDirectory)).map(async (archiveId) => {
      const manifest = JSON.parse(await readFile(path.join(archiveDirectory, archiveId, "manifest.json"), "utf8")) as { label: string; complete: boolean };
      return { archiveId, ...manifest };
    }))).filter((m) => m.label === "operator-paused");
    assert.equal(manual.length, 1); assert.equal(manual[0]!.complete, true);
    const manualId = manual[0]!.archiveId;
    const manualTar = await readFile(path.join(archiveDirectory, manualId, "archive.tar"));
    const pausedList = await f.cli("observe", "list", id, "--archive", manualId);
    assert.equal(pausedList.code, 0, pausedList.output); assert.match(pausedList.output, /append.txt/);
    const pausedRead = await f.cli("observe", "read", id, "--archive", manualId, "append.txt");
    assert.equal(pausedRead.code, 0, pausedRead.output); assert.match(pausedRead.output, /once/);
    assert.deepEqual(await readFile(path.join(archiveDirectory, manualId, "archive.tar")), manualTar);
    const resumed = f.launch([cliFile, "run", "resume", id, "--state-dir", f.layout.root, "--allow-privileged-helper"]);
    await until(() => { assert.equal(resumed.child.exitCode, null, resumed.output()); return /tick 2: /.test(resumed.output()); }, 120_000, "resumed tick two");
    const next = await f.descriptor(id, resumed.child.pid!);
    assert.notEqual(next.binding.containerId, d.binding.containerId);
    assert.notEqual(next.binding.epochId, d.binding.epochId);
    assert.equal(next.binding.deadline, checkpoint.deadline);
    assert.equal((await within(resumed.ended, 120_000)).code, 0, resumed.output());
    const last = await analyzeRun(paths, id); assert.equal(last.state, "completed");
    const final = await readCheckpoint(paths, last.checkpointSha256!);
    assert.equal(final.deadline, checkpoint.deadline);
    assert.equal(final.loop.completedTicks, 3); assert.equal(final.loop.attemptedCalls, 3); assert.equal(final.loop.respondedCalls, 3);
    assert.deepEqual(final.loop.history[0], checkpoint.loop.history[0]);
    assert.equal(final.ledger.limitMicroUsd, checkpoint.ledger.limitMicroUsd);
    assert.ok(final.ledger.accountedMicroUsd >= checkpoint.ledger.accountedMicroUsd);
    assert.deepEqual(final.ledger.outstanding, []);
    assert.match(final.loop.history[1]!.results[0]!.output, /exited with status 0/);
    assert.match(final.loop.history[1]!.results[0]!.output, /once\n42\n/);
    const events = await readEventLog(paths.events); assert.deepEqual(events.issues, []);
    assert.equal(events.events.filter((e) => e.type === "model.requested").length, 3);
    assert.equal(events.events.filter((e) => e.type === "action.prepared").length, 2);
    assert.deepEqual(last.outstanding, { requests: [], actions: [], reservations: [] });
    await f.stopped(next);
    const archives = worldPaths(f.layout, f.worldId).archives;
    const manifests = await Promise.all((await readdir(archives)).map(async (archiveId) => ({ archiveId, bytes: await readFile(path.join(archives, archiveId, "manifest.json")) })));
    assert.ok(manifests.length >= 4, "complete initial/final capture for both epochs");
    for (const m of manifests) {
      const manifest = JSON.parse(m.bytes.toString()) as { complete: boolean; source: { unchanged: boolean } };
      assert.equal(manifest.complete, true); assert.equal(manifest.source.unchanged, true);
    }
    const chosen = manifests.find((m) => m.archiveId === manualId)!; assert.ok(chosen);
    const archiveFile = path.join(archives, chosen.archiveId, "archive.tar");
    const before = await readFile(archiveFile);
    const list = await f.cli("observe", "list", id, "--archive", chosen.archiveId); assert.equal(list.code, 0, list.output); assert.match(list.output, /append.txt/);
    const read = await f.cli("observe", "read", id, "--archive", chosen.archiveId, "append.txt"); assert.equal(read.code, 0, read.output); assert.match(read.output, /once/);
    assert.deepEqual(await readFile(archiveFile), before);
    assert.deepEqual(await readFile(path.join(archives, chosen.archiveId, "manifest.json")), chosen.bytes);
    const destination = path.join(f.root, "export");
    const exported = await f.cli("run", "export", id, "--output", destination); assert.equal(exported.code, 0, exported.output);
    assert.equal((await stat(destination)).mode & 0o077, 0);
    assert.deepEqual(await readFile(path.join(destination, "run", "events.jsonl")), await readFile(paths.events));
    const exportedFiles = await readdir(destination, { recursive: true });
    const manualCopies = exportedFiles.filter((name) => name.includes(manualId) && name.endsWith("archive.tar"));
    assert.equal(manualCopies.length, 1, "explicit run-associated capture is included in export");
    assert.deepEqual(await readFile(path.join(destination, manualCopies[0]!)), manualTar);
    for (const name of exportedFiles) assert.equal((await stat(path.join(destination, name))).mode & 0o077, 0, `private export: ${name}`);
    f.done();
  });

  it("refuses clean run A after tracked run B executes in the same world, despite identical identity/config", { timeout: 300_000 }, async (t) => {
    const f = await fixture(t);
    async function paused() {
      const h = f.launch([cliFile, "run", "start", "--world", f.worldId, "--config", f.file, "--state-dir", f.layout.root, "--allow-privileged-helper"]);
      await until(() => { assert.equal(h.child.exitCode, null, h.output()); return /tick 1: /.test(h.output()); }, 120_000, "tracked run first tick");
      const id = parseRunId(/run (r-\S+) in world/.exec(h.output())![1]!); f.runIds.add(id);
      const d = await f.descriptor(id, h.child.pid!);
      const stop = await f.cli("run", "stop", id); assert.equal(stop.code, 0, stop.output);
      assert.equal((await within(h.ended, 120_000)).code, 0, h.output());
      const analysis = await analyzeRun(runPaths(f.layout, id), id);
      assert.equal(analysis.state, "stopped_clean");
      await f.stopped(d);
      return { id, d, checkpoint: await readCheckpoint(runPaths(f.layout, id), analysis.checkpointSha256!) };
    }
    const a = await paused();
    const original = await readFile(runPaths(f.layout, a.id).events);
    const b = await paused();
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.d.binding.containerId, b.d.binding.containerId);
    assert.equal(a.checkpoint.configSha256, b.checkpoint.configSha256);
    const identity = (world: typeof a.checkpoint.world) => ({ engineId: world.engineId, storageUuid: world.storageUuid, image: world.image });
    assert.deepEqual(identity(a.checkpoint.world), identity(b.checkpoint.world), "engine/image/storage identity alone cannot fence execution generations");
    const historyFile = worldPaths(f.layout, f.worldId).events;
    const history = await readFile(historyFile);
    const refused = await f.cli("run", "resume", a.id, "--allow-privileged-helper");
    assert.notEqual(refused.code, 0, refused.output);
    assert.match(refused.output, /intervening|generation|another run|world.*(?:history|chang)|subsequent|stale/i);
    assert.deepEqual(await readFile(runPaths(f.layout, a.id).events), original, "fence refusal never changes A's clean evidence");
    assert.deepEqual(await readFile(historyFile), history, "no replacement container or world effect on refusal");
    assert.ok((await f.inventory()).every((c) => c.State !== "running"));
    f.done();
  });

  for (const boundary of boundaries) it(`SIGKILL at ${boundary}: independent exact-world stop, no replay or resume`, { timeout: 240_000 }, async (t) => {
    const f = await fixture(t);
    const { h, id, d } = await f.barrier(boundary);
    const paths = runPaths(f.layout, id);
    const before = await readEventLog(paths.events); assert.deepEqual(before.issues, []);
    const types = before.events.map((e) => e.type);
    const required = { after_model_requested: "model.requested", after_model_responded: "model.responded", after_action_prepared: "action.prepared", after_action_commit: "action.prepared", after_world_stop: "run.stopping", after_checkpoint_file: "run.stopping" }[boundary];
    assert.ok(types.includes(required));
    assert.ok(!types.includes("run.stopped_clean"));
    if (boundary === "after_model_requested") assert.ok(!types.includes("model.responded"));
    if (boundary === "after_action_prepared") assert.ok(!types.some((type) => ["action.completed", "action.running", "action.refused", "action.uncertain"].includes(type)));
    if (boundary === "after_checkpoint_file") {
      assert.ok((await readdir(paths.checkpoints)).length > 0, "durable but unpublished orphan checkpoint");
      assert.ok(!types.includes("checkpoint.written"));
    }
    if (["after_world_stop", "after_checkpoint_file"].includes(boundary)) assert.ok((await f.inventory()).every((c) => c.State !== "running"));
    else assert.equal((await f.inventory()).filter((c) => c.Id === d.binding.containerId && c.State === "running").length, 1);
    const killedAt = Date.now();
    await f.kill(h);
    // Wait full lease even for already-stopped boundaries; independent guardian
    // completion is required, not merely an absent container.
    await delay(LEASE + 1000);
    await f.stopped(d, killedAt);
    const frozen = await readFile(paths.events);
    assert.deepEqual((await readEventLog(paths.events)).events, before.events, "watchdog never rewrites controller records");
    const analysis = await analyzeRun(paths, id);
    if (boundary === "after_model_requested") assert.equal(analysis.outstanding.requests.length, 1);
    if (boundary === "after_action_prepared") assert.equal(analysis.outstanding.actions.length, 1);
    if (boundary === "after_action_commit" && !types.some((type) => ["action.completed", "action.running", "action.uncertain"].includes(type))) assert.equal(analysis.outstanding.actions.length, 1);
    const status = await f.cli("run", "status", id); assert.equal(status.code, 0, status.output); assert.match(status.output, /INTERRUPTED|recovery_required/i);
    assert.deepEqual(await analyzeRun(paths, id), analysis, "status must preserve unknowns and costs");
    assert.deepEqual(await readFile(paths.events), frozen);
    await f.releaseDeadLocks();
    const refused = await f.cli("run", "resume", id, "--allow-privileged-helper"); assert.notEqual(refused.code, 0, refused.output);
    assert.match(refused.output, /interrupted|checkpoint|recovery|resum|clean/i);
    assert.deepEqual(await readFile(paths.events), frozen, "refusal cannot reconcile/replay unknown effects");
    const finalized = await f.cli("run", "finalize", id, "--acknowledge-uncertainty"); assert.equal(finalized.code, 0, finalized.output);
    const final = await analyzeRun(paths, id); assert.equal(final.state, "finalized");
    const finalLog = await readEventLog(paths.events);
    const acknowledgement = final.finalization?.acknowledged ?? finalLog.events.find((e) => e.type === "run.finalized")?.data.acknowledged;
    assert.deepEqual(acknowledgement, pendingAcknowledgement(analysis), "permanent acknowledgement preserves every unknown, watchdog intervention, and cost reservation");
    const again = await f.cli("run", "resume", id, "--allow-privileged-helper"); assert.notEqual(again.code, 0);
    const end = await readEventLog(paths.events);
    for (const type of ["model.requested", "action.prepared", "cost.reserved", "cost.reconciled"]) assert.deepEqual(end.events.filter((e) => e.type === type), before.events.filter((e) => e.type === type));
    await delay(3000);
    assert.ok((await f.inventory()).every((c) => c.State !== "running"));
    f.done();
  });

  it("SIGKILL after terminal clean record permits only explicit supervised resume", { timeout: 240_000 }, async (t) => {
    const f = await fixture(t);
    const { h, id, d } = await f.barrier("after_terminal_record");
    const paths = runPaths(f.layout, id);
    const clean = await analyzeRun(paths, id); assert.equal(clean.state, "stopped_clean");
    const checkpoint = await readCheckpoint(paths, clean.checkpointSha256!);
    assert.equal(checkpoint.stopReason, "operator_stop"); assert.equal(checkpoint.loop.completedTicks, 1);
    assert.deepEqual(clean.outstanding, { requests: [], actions: [], reservations: [] });
    const journal = (await readFile(d.journalFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Journal);
    assert.ok(journal.some((r) => r.type === "watchdog.released" && r.data.verified === true));
    await f.kill(h);
    const frozen = await readFile(paths.events);
    await delay(LEASE + 1000); await f.stopped(d);
    assert.deepEqual(await readFile(paths.events), frozen, "never automatic resume after clean controller death");
    await f.releaseDeadLocks();
    const resume = await f.cli("run", "resume", id, "--allow-privileged-helper"); assert.equal(resume.code, 0, resume.output);
    const end = await analyzeRun(paths, id); assert.equal(end.state, "completed");
    const final = await readCheckpoint(paths, end.checkpointSha256!);
    assert.equal(final.deadline, checkpoint.deadline); assert.equal(final.loop.completedTicks, 3);
    assert.equal(final.loop.attemptedCalls, 3); assert.deepEqual(final.loop.history[0], checkpoint.loop.history[0]);
    assert.match(final.loop.history[1]!.results[0]!.output, /exited with status 0/);
    assert.match(final.loop.history[1]!.results[0]!.output, /once\n42\n/);
    const next = JSON.parse(await readFile(path.join(paths.directory, "watchdog.json"), "utf8")) as Descriptor;
    assert.notEqual(next.binding.containerId, d.binding.containerId); assert.notEqual(next.binding.epochId, d.binding.epochId);
    await f.stopped(next);
    f.done();
  });
});
