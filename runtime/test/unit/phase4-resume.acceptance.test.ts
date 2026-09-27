import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import { loadConfig } from "../../src/config/resolve.ts";
import type { WorldSample } from "../../src/core/contracts.ts";
import { parseWorldId, type RunId } from "../../src/core/ids.ts";
import { requestBounds } from "../../src/mind/create.ts";
import { FakeMind, type FakeTurn } from "../../src/mind/fake.ts";
import { acquireOwnership, inspectOwnership } from "../../src/operator/locks.ts";
import * as runModule from "../../src/operator/run.ts";
import type { RunResult, StartRunOptions } from "../../src/operator/run.ts";
import { prepareStateDir } from "../../src/operator/state-dir.ts";
import { FAKE_MIND_RATES, type CostRates } from "../../src/records/accounting.ts";
import { readCheckpoint } from "../../src/records/checkpoint.ts";
import { readEventLog, type EventType } from "../../src/records/events.ts";
import { analyzeRun, finalizeRun } from "../../src/records/finalize.ts";
import { RunRecorder, runPaths } from "../../src/records/run-store.ts";
import { variant } from "../support/config.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { FAKE_IDENTITY, FakeWorld } from "../support/fake-world.ts";

// Proposed Phase 4 public contract, deliberately local until production implements it.
// Do not turn this into a static named import, a stub, or a skipped test.
type ResumeOptions = Omit<StartRunOptions, "resolved" | "worldId" | "onCreated"> & { readonly runId: RunId };
type ResumeRun = (options: ResumeOptions) => Promise<RunResult>;
function resumeAPI(): ResumeRun {
  const candidate = (runModule as typeof runModule & { readonly resumeRun?: ResumeRun }).resumeRun;
  assert.equal(typeof candidate, "function", "Phase 4 contract: operator/run.ts must export resumeRun(options)");
  return candidate!;
}

const WORLD = parseWorldId(FAKE_IDENTITY.worldId);
let fixtureSerial = 0;
const TURNS: FakeTurn[] = [1, 2, 3, 4].map((n) => ({ type: "shell", command: `printf phase4-turn-${n}` }));
const RATES: CostRates = { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, source: "offline acceptance accounting, not provider pricing" };

async function fixture(t: TestContext, settings: {
  turns?: FakeTurn[];
  stopAt?: number;
  mutate?: Parameters<typeof variant>[0];
  rates?: CostRates;
  output?: string;
  runningJob?: boolean;
} = {}) {
  const serial = ++fixtureSerial;
  const root = await mkdtemp(path.join(tmpdir(), "alife-phase4-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await variant((c) => {
    c.operator.maximumTicks = 20;
    c.body.minimumTickIntervalMs = 0;
    c.operator.maximumEstimatedCostUsd = settings.rates ? 10 : 0;
    settings.mutate?.(c);
  });
  t.after(() => rm(path.dirname(source), { recursive: true, force: true }));
  const turns = settings.turns ?? TURNS;
  await writeFile(path.join(path.dirname(source), "fake-script.json"), JSON.stringify({ schemaVersion: 1, turns }));
  const loaded = await loadConfig(source);
  assert.ok(loaded.ok, loaded.ok ? "" : JSON.stringify(loaded.issues));
  const resolved = loaded.resolved;
  const layout = await prepareStateDir(root);
  const clock = new FakeClock();
  const controller = new AbortController();
  const world = new FakeWorld(() => ({ state: settings.runningJob ? "running" : "exited", stdout: settings.output ?? "historical-phase4-output\n" }));
  const mind = new FakeMind({ schemaVersion: 1, turns }, requestBounds(resolved), { capture: true });
  const rates = settings.rates ?? FAKE_MIND_RATES;
  const stopAt = settings.stopAt ?? 1;
  const result = await runModule.startRun({
    layout, resolved, worldId: WORLD, clock, signal: controller.signal,
    allowPrivilegedHelper: false, openWorld: () => Promise.resolve(world),
    random: (size) => Buffer.alloc(size, serial),
    hostFreeMiB: () => Promise.resolve(1_000_000), mind: { mind, rates },
    onTick: ({ tick }) => { if (tick === stopAt) controller.abort("fixture operator stop"); },
  });
  // Every case proves a real clean baseline BEFORE checking for the new API.
  assert.equal(result.state, "stopped_clean", JSON.stringify(result));
  assert.equal(result.reason, "operator_stop");
  assert.equal(result.recorded, true);
  assert.equal(result.attemptedCalls, stopAt);
  assert.equal(mind.requests.length, stopAt);
  assert.ok(result.checkpointSha256);
  const paths = runPaths(layout, result.runId);
  const checkpoint = await readCheckpoint(paths, result.checkpointSha256);
  assert.equal(checkpoint.runId, result.runId);
  assert.equal(checkpoint.worldId, WORLD);
  assert.equal(checkpoint.safety.sealed, true);
  assert.equal(checkpoint.safety.reviewRequired, false);
  assert.equal(checkpoint.loop.completedTicks, stopAt);
  assert.deepEqual(checkpoint.ledger.outstanding, []);
  const log = await readEventLog(paths.events);
  assert.deepEqual(log.issues, []);
  assert.equal(log.events.at(-1)?.type, "run.stopped_clean");
  assert.equal((await analyzeRun(paths, result.runId)).state, "stopped_clean");
  assert.equal(await inspectOwnership(layout.locks, "run", result.runId), null);
  assert.equal(await inspectOwnership(layout.locks, "world", WORLD), null);
  return { root, source, resolved, layout, clock, world, mind, rates, turns, result, paths, checkpoint, log, resumeEpoch: 0 };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function attempt(f: Fixture, extra: Partial<ResumeOptions> = {}) {
  // FakeWorld derives epoch IDs from calls.length. Give each fresh process a
  // disjoint prefix so even successive resumes cannot accidentally reuse its ID.
  const world = new FakeWorld(() => ({ stdout: "fresh-phase4-output\n" }));
  f.resumeEpoch += 1;
  world.calls.push(...Array.from({ length: f.resumeEpoch * 100 }, () => "new-process-epoch"));
  const mind = new FakeMind({ schemaVersion: 1, turns: f.turns }, requestBounds(f.resolved), { capture: true });
  const controller = new AbortController();
  const options: ResumeOptions = {
    layout: f.layout, runId: f.result.runId, clock: f.clock,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
    allowPrivilegedHelper: false, openWorld: () => Promise.resolve(world),
    hostFreeMiB: () => Promise.resolve(1_000_000), mind: { mind, rates: f.rates },
    onTick: () => controller.abort("acceptance operator stop"), ...extra,
  };
  return { world, mind, options };
}
async function refused(f: Fixture, a = attempt(f)) {
  const resume = resumeAPI(); // Outside assert.rejects: missing API is NOT a successful refusal.
  await assert.rejects(() => resume(a.options));
  assert.ok(!a.world.calls.includes("attach"), "refusal must precede attach");
  assert.ok(!a.world.calls.includes("start"), "refusal must precede process start");
  assert.equal(a.world.dispatched.length, 0);
  assert.equal(a.mind.requests.length, 0);
}
async function clean(f: Fixture, a = attempt(f)) {
  const result = await resumeAPI()(a.options);
  assert.equal(result.runId, f.result.runId);
  assert.equal(result.state, "stopped_clean");
  assert.equal(result.reason, "operator_stop");
  assert.equal(result.recorded, true);
  assert.ok(result.checkpointSha256);
  const checkpoint = await readCheckpoint(f.paths, result.checkpointSha256);
  assert.equal(checkpoint.worldId, WORLD);
  assert.equal(checkpoint.deadline, f.checkpoint.deadline);
  const log = await readEventLog(f.paths.events);
  assert.deepEqual(log.issues, []);
  const charges = log.events.filter((event) => event.type === "cost.reconciled").map((event) => {
    assert.equal(typeof event.data.chargedMicroUsd, "number");
    return event.data.chargedMicroUsd as number;
  });
  assert.equal(checkpoint.ledger.accountedMicroUsd, charges.reduce((sum, charge) => sum + charge, 0));
  assert.equal(checkpoint.ledger.limitMicroUsd, f.checkpoint.ledger.limitMicroUsd);
  return { ...a, result, checkpoint };
}
async function appendState(f: Fixture, type: EventType) {
  const records = await RunRecorder.open({ paths: f.paths, runId: f.result.runId, clock: f.clock, limitBytes: 1 << 30 });
  try { await records.append(type, { reason: "controller_interrupted", detail: "acceptance crash boundary" }, { durable: true }); }
  finally { await records.close(); }
}
async function truncateBefore(f: Fixture, type: string) {
  const lines = (await readFile(f.paths.events, "utf8")).trimEnd().split("\n");
  const index = f.log.events.findIndex((event) => event.type === type);
  assert.ok(index > 0);
  await writeFile(f.paths.events, `${lines.slice(0, index).join("\n")}\n`);
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("acceptance barrier timed out")), 2_000); })]);
  } finally { clearTimeout(timer); }
}

describe("Phase 4 clean resume acceptance (real run store)", { timeout: 15_000 }, () => {
  it("continues the same run and world at the next scripted shell with the original deadline and history", async (t) => {
    const f = await fixture(t, { rates: RATES });
    f.clock.advance(10_000);
    const resumed = await clean(f);
    assert.deepEqual(f.world.dispatched.map((r) => r.command), ["printf phase4-turn-1"]);
    assert.deepEqual(resumed.world.dispatched.map((r) => r.command), ["printf phase4-turn-2"]);
    assert.equal(resumed.result.attemptedCalls, 2);
    assert.equal(resumed.result.respondedCalls, 2);
    assert.equal(resumed.result.completedTicks, 2);
    assert.equal(resumed.mind.requests.length, 1);
    assert.deepEqual(resumed.mind.requests[0]!.history, f.checkpoint.loop.history);
    assert.notEqual(resumed.checkpoint.safety.epochId, f.checkpoint.safety.epochId);
    assert.ok(f.checkpoint.ledger.accountedMicroUsd > 0);
    assert.ok(resumed.checkpoint.ledger.accountedMicroUsd > f.checkpoint.ledger.accountedMicroUsd);
    assert.deepEqual(await readCheckpoint(f.paths, f.result.checkpointSha256!), f.checkpoint);
  });

  it("two successive clean resumes retain cumulative counters and contiguous event sequence", async (t) => {
    const f = await fixture(t, { rates: RATES });
    const first = await clean(f);
    const second = await clean(f);
    assert.deepEqual([second.result.completedTicks, second.result.attemptedCalls, second.result.respondedCalls], [3, 3, 3]);
    assert.deepEqual(second.world.dispatched.map((r) => r.command), ["printf phase4-turn-3"]);
    assert.deepEqual(second.mind.requests[0]!.history, first.checkpoint.loop.history);
    assert.notEqual(second.checkpoint.safety.epochId, first.checkpoint.safety.epochId);
    assert.ok(second.checkpoint.ledger.accountedMicroUsd > first.checkpoint.ledger.accountedMicroUsd);
    const log = await readEventLog(f.paths.events);
    assert.deepEqual(log.issues, []);
    assert.deepEqual(log.events.slice(0, f.log.events.length), f.log.events);
    assert.deepEqual(log.events.map((e) => e.seq), log.events.map((_, i) => i + 1));
    assert.equal(log.events.filter((e) => e.type === "run.created").length, 1);
    assert.equal(log.events.filter((e) => e.type === "run.resumed").length, 2);
  });

  it("a completed tick-limit run cannot resume even with its clean checkpoint", async (t) => {
    const f = await fixture(t, { mutate: (c) => { c.operator.maximumTicks = 2; } });
    const a = attempt(f, { onTick: () => {} });
    const completed = await resumeAPI()(a.options);
    assert.equal(completed.state, "completed");
    assert.equal(completed.reason, "tick_limit");
    assert.ok(completed.checkpointSha256);
    assert.equal((await readCheckpoint(f.paths, completed.checkpointSha256)).state, "completed");
    await refused(f);
  });

  for (const field of ["config", "prompt", "tools", "fakeScript"] as const) {
    it(`refuses stored ${field} hash tampering before attach or model invocation`, async (t) => {
      const f = await fixture(t);
      const original = await readFile(f.paths[field]);
      // Config/tools use canonical JSON hashes; whitespace is not a semantic tamper.
      if (field === "config") {
        await writeFile(f.paths.config, JSON.stringify({ ...f.resolved.config,
          operator: { ...f.resolved.config.operator, maximumTicks: 999 } }));
      } else if (field === "tools") {
        await writeFile(f.paths.tools, JSON.stringify(f.resolved.tools.map((tool) => ({ ...tool, description: "tampered tool contract" }))));
      } else {
        await appendFile(f.paths[field], " \n"); // Prompt/script are hashed by bytes.
      }
      assert.notDeepEqual(await readFile(f.paths[field]), original);
      await refused(f);
    });
  }

  it("refuses checkpoint bytes that no longer match the referenced hash", async (t) => {
    const f = await fixture(t);
    await appendFile(path.join(f.paths.checkpoints, `${f.result.checkpointSha256}.json`), " ");
    await assert.rejects(() => readCheckpoint(f.paths, f.result.checkpointSha256!), /hash/);
    await refused(f);
  });
  it("refuses a valid checkpoint swapped from another run even when event hash references agree", async (t) => {
    const f = await fixture(t);
    const other = await fixture(t);
    assert.notEqual(f.result.runId, other.result.runId);
    const hash = other.result.checkpointSha256!;
    await writeFile(path.join(f.paths.checkpoints, `${hash}.json`), await readFile(path.join(other.paths.checkpoints, `${hash}.json`)));
    assert.equal((await readCheckpoint(f.paths, hash)).runId, other.result.runId);
    const events = await readFile(f.paths.events, "utf8");
    await writeFile(f.paths.events, events.replaceAll(f.result.checkpointSha256!, hash));
    assert.deepEqual((await readEventLog(f.paths.events)).issues, []);
    await refused(f);
  });
  it("refuses a missing checkpoint", async (t) => {
    const f = await fixture(t);
    await rm(path.join(f.paths.checkpoints, `${f.result.checkpointSha256}.json`));
    await refused(f);
  });
  it("refuses a partial event tail without repairing or truncating it", async (t) => {
    const f = await fixture(t);
    await appendFile(f.paths.events, '{"schemaVersion":');
    const damaged = await readFile(f.paths.events);
    assert.ok((await readEventLog(f.paths.events)).issues.length > 0);
    await refused(f);
    assert.deepEqual(await readFile(f.paths.events), damaged);
  });
  it("refuses a checkpoint lacking its terminal clean-stop record", async (t) => {
    const f = await fixture(t);
    await truncateBefore(f, "run.stopped_clean");
    await refused(f);
  });
  it("does not discover and trust an orphan checkpoint with no checkpoint event", async (t) => {
    const f = await fixture(t);
    await truncateBefore(f, "checkpoint.written");
    assert.deepEqual(await readCheckpoint(f.paths, f.result.checkpointSha256!), f.checkpoint);
    await refused(f);
  });
  it("refuses finalized runs despite an earlier clean checkpoint", async (t) => {
    const f = await fixture(t);
    await appendState(f, "run.resumed");
    await finalizeRun({ paths: f.paths, runId: f.result.runId, clock: f.clock,
      analysis: await analyzeRun(f.paths, f.result.runId),
      world: { container: "absent", detail: "fake world verified absent" }, limitBytes: 1 << 30 });
    assert.equal((await analyzeRun(f.paths, f.result.runId)).state, "finalized");
    await refused(f);
  });
  for (const state of ["recovery_required", "interrupted"] as const) {
    it(`refuses ${state} execution after an earlier clean checkpoint`, async (t) => {
      const f = await fixture(t);
      await appendState(f, "run.resumed");
      if (state === "recovery_required") await appendState(f, "run.recovery_required");
      assert.equal((await analyzeRun(f.paths, f.result.runId)).state, state === "interrupted" ? "running" : state);
      await refused(f);
    });
  }

  for (const change of ["removed", "changed"] as const) {
    it(`uses stored replayable inputs when original config, prompt and script are ${change}`, async (t) => {
      const f = await fixture(t);
      for (const name of ["config.json", "prompt.txt", "fake-script.json"]) {
        const file = path.join(path.dirname(f.source), name);
        if (change === "removed") await rm(file);
        else await writeFile(file, "NOT THE STORED INPUT");
      }
      // No injected mind: production must create its fake adapter from the stored script.
      const a = attempt(f);
      const { mind: _mind, ...options } = a.options;
      void _mind;
      const resumed = await clean(f, { ...a, options });
      assert.deepEqual(resumed.world.dispatched.map((r) => r.command), ["printf phase4-turn-2"]);
      assert.equal(resumed.checkpoint.configSha256, f.checkpoint.configSha256);
      assert.deepEqual(resumed.checkpoint.loop.history[0], f.checkpoint.loop.history[0]);
      assert.equal(await readFile(f.paths.prompt, "utf8"), f.resolved.prompt.text);
    });
  }

  it("refuses an expired original deadline before attaching", async (t) => {
    const f = await fixture(t);
    f.clock.advance(Date.parse(f.checkpoint.deadline) - f.clock.now().getTime());
    await refused(f);
  });
  it("refuses an operator-stop checkpoint whose remaining attempted-call budget is zero", async (t) => {
    const f = await fixture(t, { mutate: (c) => { c.operator.maximumTicks = 1; } });
    assert.equal(f.checkpoint.loop.attemptedCalls, f.resolved.config.operator.maximumTicks);
    await refused(f);
  });
  it("refuses exhausted spend rather than resetting the ledger", async (t) => {
    const f = await fixture(t, {
      turns: [{ type: "text", text: "x".repeat(1024) }, { type: "wait" }],
      rates: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 1, source: "offline output accounting" },
      mutate: (c) => { c.operator.maximumEstimatedCostUsd = 0.001024; },
    });
    assert.equal(f.checkpoint.ledger.accountedMicroUsd, 1024);
    assert.equal(f.checkpoint.ledger.limitMicroUsd, 1024);
    await refused(f);
    assert.deepEqual(await readCheckpoint(f.paths, f.result.checkpointSha256!), f.checkpoint);
  });
  it("refuses a backward wall-clock jump before effects", async (t) => {
    const f = await fixture(t);
    const clock = new FakeClock(new Date(Date.parse(f.checkpoint.writtenAt) - 1).toISOString());
    await refused(f, attempt(f, { clock }));
  });

  for (const field of ["engineId", "storageIdentity", "image"] as const) {
    it(`refuses a changed world ${field} before starting its process`, async (t) => {
      const f = await fixture(t);
      const a = attempt(f);
      Object.defineProperty(a.world, "identity", { value: { ...FAKE_IDENTITY, [field]: field === "image" ? `sha256:${"f".repeat(64)}` : "different-identity" } });
      await refused(f, a);
    });
  }
  for (const kind of ["run", "world"] as const) {
    it(`denies competing ${kind} ownership without breaking the owner`, async (t) => {
      const f = await fixture(t);
      const id = kind === "run" ? f.result.runId : WORLD;
      const owner = await acquireOwnership(f.layout.locks, kind, id, f.clock);
      try {
        const before = await inspectOwnership(f.layout.locks, kind, id);
        await refused(f);
        assert.deepEqual(await inspectOwnership(f.layout.locks, kind, id), before);
      } finally { await owner.release(); }
    });
  }
  it("two concurrent resumes cannot both admit execution", async (t) => {
    const f = await fixture(t);
    const resume = resumeAPI();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = attempt(f);
    const pending = resume({ ...first.options, openWorld: async () => {
      entered.resolve();
      await bounded(release.promise);
      return first.world;
    } });
    // Observe rejection immediately even if admission fails before reaching the barrier.
    void pending.catch(() => {});
    try {
      await bounded(Promise.race([entered.promise, pending.then(() => { throw new Error("resume ended before opener"); })]));
      await bounded(refused(f));
    } finally { release.resolve(); await bounded(pending); }
    assert.equal(first.world.dispatched.length, 1);
    assert.equal(first.mind.requests.length, 1);
  });

  it("first resumed perception has neutral restart disclosure, fresh sensors, historical context and no automatic listing or hidden call", async (t) => {
    const f = await fixture(t, { runningJob: true });
    assert.equal(f.world.jobs[0]!.state, "running");
    const a = attempt(f);
    const sample = a.world.sample.bind(a.world);
    a.world.sample = async (options): Promise<WorldSample> => ({ ...await sample(options),
      processes: { available: false, reason: "fresh-process-sensor-marker" } });
    const resumed = await clean(f, a);
    assert.equal(a.mind.requests.length, 1);
    const request = a.mind.requests[0]!;
    assert.equal(request.tick, 2);
    assert.equal(request.instructions, f.resolved.prompt.text);
    assert.deepEqual(request.tools, f.resolved.tools);
    assert.deepEqual(request.history, f.checkpoint.loop.history);
    assert.match(JSON.stringify(request.history), /historical-phase4-output/);
    assert.match(request.observation, /fresh-process-sensor-marker/);
    assert.doesNotMatch(request.observation, /was still running.*it was not stopped/);
    assert.equal(a.world.jobs.length, 1); // Only this epoch's newly dispatched command.
    assert.notEqual(a.world.jobs[0]!.jobId, f.world.jobs[0]!.jobId);
    // Semantics, not an invented exact profile sentence. Wording belongs to a versioned profile.
    assert.match(request.observation, /restart|new process|process.*(?:ended|stopped)|resum/i);
    assert.doesNotMatch(request.observation, /you should|you must|remember to|try to|consider (?:using|running)/i);
    assert.ok(!a.world.calls.includes("sample+listing"));
    assert.notEqual(resumed.checkpoint.safety.epochId, f.checkpoint.safety.epochId);
  });

  it("preserves previous whole-exchange evictions instead of restoring observer history", async (t) => {
    const turns: FakeTurn[] = Array.from({ length: 13 }, (_, i) => ({ type: "shell", command: `printf eviction-${i + 1}` }));
    const f = await fixture(t, { turns, stopAt: 12, output: "h".repeat(4096) });
    assert.ok(f.checkpoint.loop.evictedCount > 0, "fixture must really evict before resume");
    const evictedThrough = f.checkpoint.loop.history[0]!.tick - 1;
    const resumed = await clean(f);
    assert.ok(resumed.checkpoint.loop.evictedCount >= f.checkpoint.loop.evictedCount);
    assert.ok(resumed.mind.requests[0]!.history.every((exchange) => exchange.tick > evictedThrough));
    for (const exchange of resumed.mind.requests[0]!.history) {
      assert.deepEqual(exchange, f.checkpoint.loop.history.find((old) => old.tick === exchange.tick));
    }
    assert.equal(resumed.result.attemptedCalls, 13);
  });

  it("a known failed call resumes at the next attempt, retaining conservative unknown-usage cost", async (t) => {
    const f = await fixture(t, { rates: RATES, turns: [TURNS[0]!, { type: "failure", kind: "timeout", processed: "unknown" }, TURNS[2]!] });
    const failed = attempt(f);
    const result = await resumeAPI()(failed.options);
    assert.equal(result.state, "stopped_clean");
    assert.equal(result.reason, "provider_failure");
    assert.deepEqual([result.attemptedCalls, result.respondedCalls], [2, 1]);
    assert.ok(result.checkpointSha256);
    const checkpoint = await readCheckpoint(f.paths, result.checkpointSha256);
    const log = await readEventLog(f.paths.events);
    const reservation = log.events.filter((event) => event.type === "cost.reserved").at(-1)!;
    assert.equal(typeof reservation.data.microUsd, "number");
    assert.ok((reservation.data.microUsd as number) > 0);
    assert.equal(checkpoint.ledger.accountedMicroUsd, f.checkpoint.ledger.accountedMicroUsd + (reservation.data.microUsd as number));
    assert.deepEqual(checkpoint.ledger.outstanding, []);
    const resumed = await clean(f);
    assert.deepEqual([resumed.result.attemptedCalls, resumed.result.respondedCalls], [3, 2]);
    assert.equal(resumed.mind.requests[0]!.tick, 3);
    assert.deepEqual(resumed.world.dispatched.map((r) => r.command), ["printf phase4-turn-3"]);
    assert.ok(resumed.checkpoint.ledger.accountedMicroUsd >= checkpoint.ledger.accountedMicroUsd);
  });
});
