import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { loadConfig } from "../../src/config/resolve.ts";
import { parseWorldId } from "../../src/core/ids.ts";
import { startRun } from "../../src/operator/run.ts";
import { prepareStateDir } from "../../src/operator/state-dir.ts";
import { readCheckpoint } from "../../src/records/checkpoint.ts";
import { JsonlEventLog, WATCHDOG_EVENT_TYPES } from "../../src/records/events.ts";
import { analyzeRun, finalizeRun, pendingAcknowledgement, type RunAnalysis } from "../../src/records/finalize.ts";
import { runPaths } from "../../src/records/run-store.ts";
import { variant } from "../support/config.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { FAKE_IDENTITY, FakeWorld } from "../support/fake-world.ts";
import { loadWatchdog, watchdogFixture } from "../support/phase4-watchdog.ts";

interface WatchdogAnalysis {
  readonly state: "absent" | "armed" | "released" | "expired" | "unknown";
  readonly reviewRequired: boolean;
  readonly lastSequence: number;
  readonly stopVerified: boolean | null;
  readonly issues: readonly unknown[];
}
function watchdog(analysis: RunAnalysis): WatchdogAnalysis {
  const result = (analysis as unknown as { watchdog?: WatchdogAnalysis }).watchdog;
  assert.ok(result, "Phase 4 run analysis must include independent watchdog evidence, not only controller events");
  return result;
}
async function fixture(t: TestContext, managed = true) {
  const root = await mkdtemp(path.join(tmpdir(), "alife-p4-evidence-"));
  const config = await variant((c) => {
    c.operator.maximumTicks = 3;
    c.body.minimumTickIntervalMs = 0; // Isolate stored evidence from cadence cancellation.
  });
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(path.dirname(config), { recursive: true, force: true }); });
  const layout = await prepareStateDir(root);
  const loaded = await loadConfig(config);
  assert.ok(loaded.ok);
  const clock = new FakeClock();
  const stop = new AbortController();
  const result = await startRun({ layout, resolved: loaded.resolved, worldId: parseWorldId(FAKE_IDENTITY.worldId), clock,
    signal: stop.signal, allowPrivilegedHelper: false, openWorld: () => Promise.resolve(new FakeWorld()),
    hostFreeMiB: () => Promise.resolve(1_000_000), onTick: () => stop.abort("fixture clean stop"),
  });
  assert.equal(result.state, "stopped_clean");
  assert.ok(result.checkpointSha256);
  const paths = runPaths(layout, result.runId);
  const checkpoint = await readCheckpoint(paths, result.checkpointSha256);
  if (managed) {
    // Forward schema fixture: new managed starts declare supervision in run.created.
    const rows = (await readFile(paths.events, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
    rows.find((event) => event.type === "run.created")!.data.supervision = "watchdog-v1";
    await writeFile(paths.events, rows.map((event) => JSON.stringify(event)).join("\n") + "\n");
  }
  const journalFile = path.join(paths.directory, "watchdog.jsonl");
  const binding = { schemaVersion: 1, runId: result.runId, worldId: checkpoint.worldId, epochId: checkpoint.safety.epochId,
    controllerToken: "c".repeat(32), engineId: checkpoint.world.engineId, containerId: "a".repeat(64), deadline: checkpoint.deadline, leaseMs: 10_000 };
  async function journal(records: { type: typeof WATCHDOG_EVENT_TYPES[number]; data: Record<string, unknown> }[]) {
    const log = await JsonlEventLog.open({ file: journalFile, runId: result.runId, clock, limitBytes: 64 << 10, types: WATCHDOG_EVENT_TYPES });
    try { for (const record of records) await log.append(record.type, { binding, ...record.data }, { durable: true }); }
    finally { await log.close(); }
  }
  return { layout, paths, clock, result, checkpoint, binding, journalFile, journal,
    analyze: () => analyzeRun(paths, result.runId),
  };
}

describe("P4-E watchdog evidence, status and explicit finalization", () => {
  it("fixture creates a published clean checkpoint and independent writable journal", async (t) => {
    const f = await fixture(t, false);
    const before = await readFile(f.paths.events);
    assert.equal((await f.analyze()).state, "stopped_clean");
    await f.journal([{ type: "watchdog.armed", data: { watchdogPid: 12345 } }]);
    const record = JSON.parse((await readFile(f.journalFile, "utf8")).trim()) as { seq: number; runId: string };
    assert.equal(record.seq, 1);
    assert.equal(record.runId, f.result.runId);
    assert.deepEqual(await readFile(f.paths.events), before);
  });

  it("recognizes a historical unsupervised run without fabricating watchdog proof", async (t) => {
    const f = await fixture(t, false);
    const a = await f.analyze();
    assert.equal(watchdog(a).state, "absent");
    assert.equal(watchdog(a).reviewRequired, false, "absence on a historical core-only run is not invented watchdog expiry");
    assert.equal(watchdog(a).stopVerified, null);
  });

  it("managed supervision with no journal is missing evidence, not a clean release", async (t) => {
    const f = await fixture(t);
    const a = await f.analyze();
    assert.equal(watchdog(a).reviewRequired, true);
    assert.ok(watchdog(a).issues.length > 0);
  });

  it("released evidence has its own sequence and does not rewrite controller history", async (t) => {
    const f = await fixture(t);
    const before = await readFile(f.paths.events);
    const old = await f.analyze();
    await f.journal([{ type: "watchdog.armed", data: { watchdogPid: 12345 } },
      { type: "watchdog.released", data: { verified: true, reason: "world independently verified stopped" } }]);
    const a = await f.analyze();
    assert.equal(watchdog(a).state, "released");
    assert.equal(watchdog(a).reviewRequired, false);
    assert.equal(watchdog(a).stopVerified, true);
    assert.equal(watchdog(a).lastSequence, 2);
    assert.equal(a.lastSequence, old.lastSequence, "watchdog sequence never advances controller sequence");
    assert.deepEqual(await readFile(f.paths.events), before);
  });

  for (const verified of [true, false]) {
    it(`expiry (stop verified=${verified}) remains a review-required intervention`, async (t) => {
      const f = await fixture(t);
      await f.journal([{ type: "watchdog.armed", data: { watchdogPid: 12345 } },
        { type: "watchdog.expired", data: { verified, reason: "lease expired" } }]);
      const a = await f.analyze();
      assert.equal(watchdog(a).state, "expired");
      assert.equal(watchdog(a).reviewRequired, true);
      assert.equal(watchdog(a).stopVerified, verified);
      const acknowledged = pendingAcknowledgement(a) as unknown as { watchdog?: WatchdogAnalysis };
      assert.ok(acknowledged.watchdog, "operator finalization must acknowledge watchdog evidence explicitly");
      assert.equal(acknowledged.watchdog.reviewRequired, true);
    });
  }

  it("a later release cannot erase an earlier expiry in the same run", async (t) => {
    const f = await fixture(t);
    await f.journal([{ type: "watchdog.armed", data: { watchdogPid: 12345 } },
      { type: "watchdog.expired", data: { verified: false, reason: "engine unavailable" } },
      { type: "watchdog.released", data: { verified: true, reason: "late release" } }]);
    assert.equal(watchdog(await f.analyze()).reviewRequired, true);
  });

  for (const corruption of ["partial tail", "foreign run", "foreign epoch", "foreign engine", "foreign container", "duplicate sequence", "release without stop proof"] as const) {
    it(`${corruption} cannot certify a clean managed run`, async (t) => {
      const f = await fixture(t);
      await f.journal([{ type: "watchdog.armed", data: { watchdogPid: 12345 } },
        { type: "watchdog.released", data: { verified: true, reason: "stopped" } }]);
      if (corruption === "partial tail") await appendFile(f.journalFile, '{"partial":');
      else {
        const rows = (await readFile(f.journalFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { seq: number; runId: string; data: { binding: typeof f.binding; verified?: boolean } });
        if (corruption === "foreign run") rows[1]!.runId = "r-20260925T161449Z-ffffffff";
        if (corruption === "foreign epoch") rows[1]!.data.binding.epochId = "00000000-0000-4000-8000-000000000099";
        if (corruption === "foreign engine") rows[1]!.data.binding.engineId = "different-engine";
        if (corruption === "foreign container") rows[1]!.data.binding.containerId = "b".repeat(64);
        if (corruption === "duplicate sequence") rows[1]!.seq = rows[0]!.seq;
        if (corruption === "release without stop proof") rows[1]!.data.verified = false;
        await writeFile(f.journalFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      }
      const bytes = await readFile(f.journalFile);
      assert.equal(watchdog(await f.analyze()).reviewRequired, true);
      assert.deepEqual(await readFile(f.journalFile), bytes, "inspection never repairs the journal");
    });
  }

  it("analysis consumes the actual watchdog producer's expiry and independent stop proof", async (t) => {
    const runWatchdog = await loadWatchdog();
    const f = await fixture(t);
    await watchdogFixture(async (watch) => {
      f.binding.leaseMs = 1000;
      Object.assign(watch.binding, f.binding);
      watch.engine.engineId = f.binding.engineId;
      watch.engine.inspectedId = f.binding.containerId;
      watch.engine.labels["sh.alife.world"] = f.binding.worldId;
      watch.clock.wall = f.clock.now().getTime();
      watch.options.journalFile = f.journalFile;
      await watch.heartbeat({ issuedAt: f.clock.now().toISOString(),
        expiresAt: new Date(f.clock.now().getTime() + f.binding.leaseMs).toISOString() });
      const result = await runWatchdog(watch.options);
      assert.equal(result.outcome, "stopped");
      assert.equal(result.verified, true);
      const records = (await readFile(f.journalFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
      assert.ok(records.some((record) => record.type === "watchdog.stop_verified"));
      const analysis = watchdog(await f.analyze());
      assert.equal(analysis.state, "expired");
      assert.equal(analysis.stopVerified, true);
      assert.equal(analysis.reviewRequired, true);
    });
  });

  it("finalizes a watchdog-invalidated clean-looking controller log, preserving both streams", async (t) => {
    const f = await fixture(t);
    await f.journal([{ type: "watchdog.armed", data: { watchdogPid: 12345 } },
      { type: "watchdog.expired", data: { verified: true, reason: "lease expired" } }]);
    const journal = await readFile(f.journalFile);
    const a = await f.analyze();
    assert.equal(watchdog(a).reviewRequired, true);
    const record = await finalizeRun({ paths: f.paths, runId: f.result.runId, clock: f.clock, analysis: a,
      world: { container: "absent", detail: "verified stopped fixture" }, limitBytes: 64 << 20 });
    const acknowledged = record.acknowledged as unknown as { watchdog?: WatchdogAnalysis };
    assert.ok(acknowledged.watchdog);
    assert.equal(acknowledged.watchdog.reviewRequired, true);
    assert.deepEqual(await readFile(f.journalFile), journal);
    assert.equal((await f.analyze()).state, "finalized");
  });
});
