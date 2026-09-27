import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { parseRunId, type RunId } from "../../src/core/ids.ts";
import { bounded, events, managedAPI, managedFixture, noEffects, reviewedStop, treeBytes, turn, until } from "../support/phase4-managed.ts";

// No Docker, provider calls, production stubs, or edits to frozen Phase 3 tests.
// Each case loads the missing forward API by assertion before creating resources.
const options = { timeout: 12_000 };

it("managed fixture: valid config, real archive and actual backend startup/stop", options, async (t) => {
  const f = await managedFixture(t);
  const archive = await f.offline.world.captureArtifacts("fixture-initial");
  assert.equal(archive.complete, true);
  assert.equal(archive.entries, 1);
  await f.offline.world.start();
  assert.equal(f.offline.engine.container?.running, true);
  const stopped = await f.offline.world.stop("operator_stop");
  assert.equal(stopped.verified, true);
  assert.equal(stopped.safety.reviewRequired, false);
});

it("managed: initial archive is run-associated before first start; final capture follows verified stop", options, async (t) => {
  const f = await managedFixture(t, await managedAPI());
  f.beforeStart(async () => {
    assert.equal(f.captures.length, 1);
    const initial = f.captures[0]!;
    const event = (await events(f.paths)).find((e) => e.type === "archive.created" && e.data.phase === "initial");
    assert.equal(event?.data.archiveId, initial.result.archiveId, "association durable before POST start");
    const directory = path.join(f.paths.directory, "archives", initial.result.archiveId);
    assert.deepEqual(await readFile(path.join(directory, "archive.tar")), await readFile(path.join(initial.directory, "archive.tar")));
    assert.deepEqual(await readFile(path.join(directory, "manifest.json")), await readFile(path.join(initial.directory, "manifest.json")));
    assert.ok(f.trace.includes("watchdog.ready"));
  });
  f.arming.resolve();
  const result = await bounded(f.start());
  assert.equal(result.worldStop?.verified, true);
  assert.equal(f.captures.length, 2);
  const log = await events(f.paths);
  for (const [index, phase] of ["initial", "final"].entries()) {
    const capture = f.captures[index]!;
    assert.ok(log.some((e) => e.type === "archive.created" && e.data.phase === phase && e.data.archiveId === capture.result.archiveId));
    const manifest = JSON.parse(await readFile(path.join(f.paths.directory, "archives", capture.result.archiveId, "manifest.json"), "utf8")) as { complete: boolean; worldId: string };
    assert.equal(manifest.complete, true);
    assert.equal(manifest.worldId, f.offline.worldId);
  }
  assert.ok(f.trace.indexOf("container.stop") < f.trace.indexOf("capture.final"));
});

it("managed: watcher binds selected world, exact newly created container, epoch and fixed startup deadline", options, async (t) => {
  const f = await managedFixture(t, await managedAPI());
  const startedAt = f.clock.now().getTime();
  const pending = f.start();
  const launch = await bounded(f.armed.promise);
  assert.equal(launch.binding.schemaVersion, 1);
  assert.equal(launch.binding.worldId, f.offline.worldId);
  assert.equal(launch.binding.engineId, "offline-engine");
  assert.equal(launch.binding.containerId, f.offline.engine.container?.id);
  assert.equal(launch.binding.runId, path.basename(f.paths.directory));
  assert.ok(launch.binding.epochId.length > 0);
  assert.ok(launch.binding.controllerToken.length >= 32);
  const config = JSON.parse(await readFile(f.paths.config, "utf8")) as { operator: { maximumRunSeconds: number } };
  assert.equal(Date.parse(launch.binding.deadline), startedAt + config.operator.maximumRunSeconds * 1000);
  assert.equal(launch.context.socketPath, "/nonexistent");
  assert.ok(launch.pollIntervalMs > 0 && launch.maximumJournalBytes > 0 && launch.binding.leaseMs > 0);
  assert.ok(launch.leaseFile.startsWith(f.root + path.sep));
  assert.notEqual(launch.leaseFile, launch.journalFile);
  f.arming.resolve();
  const result = await bounded(pending);
  assert.equal(result.worldStop?.safety.epochId, launch.binding.epochId);
  const started = (await events(f.paths)).find((e) => e.type === "run.started");
  assert.equal(started?.data.deadline, launch.binding.deadline);
});

it("managed: held watchdog readiness permits an unstarted container but no exec or mind", options, async (t) => {
  const f = await managedFixture(t, await managedAPI());
  const pending = f.start();
  await bounded(f.armed.promise);
  await turn();
  assert.ok(f.offline.engine.container);
  noEffects(f);
  f.arming.resolve();
  assert.equal((await bounded(pending)).worldStop?.verified, true);
  assert.equal(f.calls, 1);
});

it("managed: arming rejection refuses execution without deleting persistent storage", options, async (t) => {
  const f = await managedFixture(t, await managedAPI());
  const pending = f.start();
  await bounded(f.armed.promise);
  f.arming.reject(new Error("fixture watchdog could not arm durably"));
  await bounded(pending.catch(() => undefined));
  noEffects(f);
  assert.equal(f.releases, 0);
  assert.notEqual(f.offline.engine.container?.running, true);
});

for (const where of ["mind", "preparation"] as const) {
  it(`managed: unexpected watchdog completion during held ${where} closes admission and requires review`, options, async (t) => {
    const f = await managedFixture(t, await managedAPI());
    if (where === "mind") f.holdMind(); else f.holdPreparation();
    f.arming.resolve();
    const pending = f.start();
    await bounded(where === "mind" ? f.mindEntered.promise : f.prepareEntered.promise);
    f.completion.resolve({ outcome: "unknown", verified: false, reason: "watchdog disconnected unexpectedly", containerId: f.offline.engine.container!.id });
    await turn();
    f.mindReply.resolve(); f.preparation.resolve();
    await reviewedStop(f, pending);
    assert.equal(f.calls, 1, "no subsequent invocation");
  });
}

for (const where of ["mind", "preparation"] as const) {
  it(`managed: controller-first wake after its local lease expired cannot dispatch from held ${where}`, options, async (t) => {
    const f = await managedFixture(t, await managedAPI());
    if (where === "mind") f.holdMind(); else f.holdPreparation();
    f.arming.resolve();
    const pending = f.start();
    const launch = await bounded(f.armed.promise);
    await bounded(where === "mind" ? f.mindEntered.promise : f.prepareEntered.promise);
    // The watchdog has not reported anything yet. Controller admission must
    // independently reject the expired lease before a late heartbeat can renew it.
    f.clock.advance(launch.binding.leaseMs + 1);
    f.mindReply.resolve(); f.preparation.resolve();
    await reviewedStop(f, pending);
    assert.equal(f.calls, 1);
  });
}

it("managed: heartbeat rejection fails closed while a mind reply is held", options, async (t) => {
  const f = await managedFixture(t, await managedAPI());
  f.holdMind();
  f.arming.resolve();
  const pending = f.start();
  await bounded(f.mindEntered.promise);
  f.failHeartbeat();
  const previous = f.heartbeats;
  // Wait only for an actual heartbeat, never assume a fixed wall-clock delay.
  await until(() => f.heartbeats > previous, "next heartbeat");
  await turn();
  f.mindReply.resolve();
  await reviewedStop(f, pending);
});

it("managed: startup deadline expiring while arming is held cannot start after readiness", options, async (t) => {
  const f = await managedFixture(t, await managedAPI());
  const pending = f.start();
  const launch = await bounded(f.armed.promise);
  f.clock.advance(Date.parse(launch.binding.deadline) - f.clock.now().getTime() + 1);
  f.arming.resolve();
  await bounded(pending.catch(() => undefined));
  noEffects(f);
});

for (const condition of ["stop", "expiry"] as const) {
  it(`managed: ${condition} at readiness closes the ready-to-start admission window`, options, async (t) => {
    const f = await managedFixture(t, await managedAPI());
    const pending = f.start();
    const launch = await bounded(f.armed.promise);
    f.onReady(() => {
      if (condition === "stop") f.abort.abort();
      else f.clock.advance(Date.parse(launch.binding.deadline) - f.clock.now().getTime() + 1);
    });
    f.arming.resolve();
    await bounded(pending.catch(() => undefined));
    noEffects(f);
  });
}

it("managed: stop requested before startup admits no later agent effects", options, async (t) => {
  const f = await managedFixture(t, await managedAPI());
  f.abort.abort();
  f.arming.resolve();
  await bounded(f.start().catch(() => undefined));
  noEffects(f);
});

it("managed: run-owned stop during held startup prevents container start", options, async (t) => {
  const api = await managedAPI();
  const f = await managedFixture(t, api);
  const pending = f.start();
  await bounded(f.armed.promise);
  const stopping = api.requestRunStop({ layout: f.layout, clock: f.clock, runId: f.runId });
  assert.equal((await bounded(stopping)).accepted, true);
  f.arming.resolve();
  await bounded(pending.catch(() => undefined));
  noEffects(f);
});

it("managed: verified clean stop releases watchdog exactly once; normal completion is not loss", options, async (t) => {
  const f = await managedFixture(t, await managedAPI());
  f.arming.resolve();
  const result = await bounded(f.start());
  assert.equal(result.state, "completed", result.detail);
  assert.ok(result.checkpointSha256);
  assert.equal(result.worldStop?.verified, true);
  assert.equal(result.worldStop?.safety.reviewRequired, false);
  assert.equal(f.releases, 1, "child must be released/joined, not leaked");
  assert.equal((await bounded(f.completion.promise)).outcome, "released");
  assert.ok(f.trace.indexOf("container.stop") < f.trace.indexOf("watchdog.release"));
});

it("managed: failed physical stop retains watchdog protection and forbids final capture", options, async (t) => {
  const f = await managedFixture(t, await managedAPI());
  f.offline.engine.stopError = new Error("fixture physical stop unavailable");
  f.arming.resolve();
  const result = await bounded(f.start());
  assert.equal(result.worldStop?.verified, false);
  assert.equal(result.state, "recovery_required");
  assert.equal(result.checkpointSha256, null);
  assert.equal(f.releases, 0);
  assert.equal(f.offline.engine.container?.running, true);
  assert.equal(f.captures.length, 1);
});

it("managed: initial capture failure refuses first start and records explicit artifact failure", options, async (t) => {
  const f = await managedFixture(t, await managedAPI());
  f.failCapture("initial"); f.arming.resolve();
  await bounded(f.start().catch(() => undefined));
  noEffects(f);
  const failure = (await events(f.paths)).find((e) => e.type === "archive.failed" && e.data.phase === "initial");
  assert.ok(failure, "initial capture failure must not disappear");
  assert.ok("archiveId" in failure.data, "failed archive identity explicitly recorded, null if none allocated");
});

for (const failure of ["failed", "incomplete"] as const) {
  it(`managed: final capture ${failure} stays explicit without inventing uncertain agent action`, options, async (t) => {
    const f = await managedFixture(t, await managedAPI());
    if (failure === "failed") f.failCapture("final"); else f.incompleteFinal();
    f.arming.resolve();
    const result = await bounded(f.start());
    assert.equal(result.worldStop?.verified, true);
    assert.deepEqual(result.worldStop?.safety.uncertainEffects, []);
    assert.notEqual(result.reason, "uncertain_action");
    const artifact = (await events(f.paths)).find((e) => ["archive.created", "archive.failed"].includes(e.type) && e.data.phase === "final");
    assert.ok(artifact);
    assert.ok("archiveId" in artifact.data);
    if (failure === "failed") assert.equal(artifact.type, "archive.failed");
    else {
      assert.equal(artifact.data.complete, false);
      assert.ok(Array.isArray(artifact.data.omissions) && artifact.data.omissions.includes("fixture: socket omitted"));
      const manifest = JSON.parse(await readFile(path.join(f.paths.directory, "archives", String(artifact.data.archiveId), "manifest.json"), "utf8")) as { complete: boolean; omissions: string[] };
      assert.equal(manifest.complete, false);
      assert.ok(manifest.omissions.includes("fixture: socket omitted"));
    }
    assert.equal(f.releases, 1);
  });
}

it("managed: oversized source archives cannot overrun shared run record capacity or precede effects", options, async (t) => {
  const f = await managedFixture(t, await managedAPI(), 16);
  f.largeCapture(20 << 20); f.arming.resolve();
  f.beforeStart(async () => {
    assert.ok(await treeBytes(f.paths.directory) <= f.recordLimit);
    const archive = (await events(f.paths)).find((e) => e.data.phase === "initial" && ["archive.created", "archive.failed"].includes(e.type));
    assert.ok(archive, "capacity decision must be durable before effects");
    assert.ok(archive.type === "archive.failed" || archive.data.complete === false, "oversized archive never presented as complete");
  });
  await bounded(f.start().catch(() => undefined));
  assert.ok(await treeBytes(f.paths.directory) <= f.recordLimit, "all record files and copies share the cap");
  const archive = (await events(f.paths)).find((e) => e.data.phase === "initial" && ["archive.created", "archive.failed"].includes(e.type));
  assert.ok(archive, "capacity omission explicitly recorded even if startup refused");
  assert.ok(archive.type === "archive.failed" || archive.data.complete === false);
});

it("managed: authenticated local stop with known outcomes is clean, recorded and idempotent", options, async (t) => {
  const api = await managedAPI();
  const f = await managedFixture(t, api);
  f.holdMind(); f.arming.resolve();
  const pending = f.start();
  await bounded(f.mindEntered.promise);
  // A blind process.kill would hit this test runner. Record every attempt instead.
  const signals: (number | string)[] = [];
  t.mock.method(process, "kill", (_pid: number, signal: number | string = "SIGTERM") => { signals.push(signal); return true; });
  const request = { layout: f.layout, clock: f.clock, runId: f.runId };
  assert.equal((await bounded(api.requestRunStop(request))).accepted, true);
  f.mindReply.resolve();
  const result = await bounded(pending);
  assert.equal(result.reason, "operator_stop");
  assert.notEqual(result.state, "recovery_required", result.detail);
  assert.equal(result.worldStop?.verified, true);
  assert.ok(result.checkpointSha256);
  assert.equal(f.calls, 1);
  assert.equal(f.offline.engine.jobs().reduce((sum, job) => sum + job.starts, 0), 0);
  assert.ok((await events(f.paths)).some((event) => event.type === "operator.intervention"));
  assert.equal((await bounded(api.requestRunStop(request))).accepted, false);
  assert.ok(signals.every((signal) => signal === 0), "control endpoint, not PID signalling");
});

it("managed: missing/stale owners and malformed IDs never signal the test process", options, async (t) => {
  const api = await managedAPI();
  const f = await managedFixture(t, api);
  const runId = parseRunId("r-20260925T161449Z-12345678");
  const signals: (number | string)[] = [];
  t.mock.method(process, "kill", (_pid: number, signal: number | string = "SIGTERM") => { signals.push(signal); return true; });
  const request = { layout: f.layout, clock: f.clock, runId };
  assert.equal((await bounded(api.requestRunStop(request))).accepted, false);
  const lock = path.join(f.layout.locks, `run-${runId}.lock`);
  const record = JSON.stringify({ schemaVersion: 1, kind: "run", id: runId, token: "1".repeat(32), pid: process.pid, hostname: hostname(), acquiredAt: f.clock.now().toISOString() });
  await writeFile(lock, record);
  assert.equal((await bounded(api.requestRunStop(request))).accepted, false, "PID exists but has no authenticated run endpoint");
  assert.equal(await readFile(lock, "utf8"), record, "stale ownership is not silently removed");
  for (const bad of ["../escape", "", "r-invalid", `${runId}\n`]) {
    const response = await bounded(api.requestRunStop({ ...request, runId: bad as RunId }).catch((error: unknown) => error));
    assert.ok(response instanceof Error || (typeof response === "object" && response !== null && "accepted" in response && response.accepted === false));
  }
  assert.ok(signals.every((signal) => signal === 0));
});
