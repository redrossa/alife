import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadConfig, type ResolvedConfig } from "../../src/config/resolve.ts";
import { sha256Hex } from "../../src/core/hash.ts";
import { parseRunId, parseWorldId, type RunId } from "../../src/core/ids.ts";
import type { FakeTurn } from "../../src/mind/fake.ts";
import { acquireOwnership, inspectOwnership, OwnershipConflictError } from "../../src/operator/locks.ts";
import { RunRefusedError, startRun, type StartRunOptions } from "../../src/operator/run.ts";
import { prepareStateDir, type StateLayout } from "../../src/operator/state-dir.ts";
import { readCheckpoint } from "../../src/records/checkpoint.ts";
import { readEventLog } from "../../src/records/events.ts";
import { analyzeRun, finalizeRun, FinalizeRefusedError, isInterrupted } from "../../src/records/finalize.ts";
import { manifestSchema } from "../../src/records/manifest.ts";
import { createRunDirectory, readText, RunRecorder, runPaths } from "../../src/records/run-store.ts";
import { variant } from "../support/config.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { FAKE_IDENTITY, FakeWorld } from "../support/fake-world.ts";

const WORLD = parseWorldId(FAKE_IDENTITY.worldId);

async function configWith(turns: FakeTurn[], mutate: Parameters<typeof variant>[0] = () => {}): Promise<ResolvedConfig> {
  const file = await variant(mutate);
  await writeFile(path.join(path.dirname(file), "fake-script.json"), JSON.stringify({ schemaVersion: 1, turns }));
  const loaded = await loadConfig(file);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return loaded.resolved;
}

async function layout(): Promise<StateLayout> {
  return prepareStateDir(await mkdtemp(path.join(tmpdir(), "alife-run-")));
}

function options(state: StateLayout, resolved: ResolvedConfig, world: FakeWorld, extra: Partial<StartRunOptions> = {}): StartRunOptions {
  return {
    layout: state,
    resolved,
    worldId: WORLD,
    clock: new FakeClock(),
    signal: new AbortController().signal,
    allowPrivilegedHelper: false,
    openWorld: () => Promise.resolve(world),
    hostFreeMiB: () => Promise.resolve(1_000_000),
    ...extra,
  };
}

async function types(state: StateLayout, runId: RunId): Promise<string[]> {
  const log = await readEventLog(runPaths(state, runId).events);
  assert.deepEqual(log.issues, []);
  return log.events.map((event) => event.type);
}

const lifecycle = (all: string[]) => all.filter((type) => type.startsWith("run.") || type === "checkpoint.written" || type === "world.stopped");

describe("run episode", () => {
  it("runs to its limit, stops the world, and writes a verifiable checkpoint", async () => {
    const state = await layout();
    const resolved = await configWith([{ type: "shell", command: "echo hi" }, { type: "wait" }, { type: "text", text: "..." }], (c) => {
      c.operator.maximumTicks = 3;
    });
    const world = new FakeWorld(() => ({ stdout: "hi\n" }));
    const result = await startRun(options(state, resolved, world));
    assert.equal(result.state, "completed");
    assert.equal(result.reason, "tick_limit");
    assert.equal(result.completedTicks, 3);
    assert.ok(result.recorded);
    assert.deepEqual(world.calls.filter((call) => !call.startsWith("sample")), ["facts", "attach", "start", "stop:tick_limit", "close"]);

    const all = await types(state, result.runId);
    assert.deepEqual(lifecycle(all), ["run.created", "run.ready", "run.started", "run.stopping", "world.stopped", "checkpoint.written", "run.completed"]);

    const paths = runPaths(state, result.runId);
    const checkpoint = await readCheckpoint(paths, result.checkpointSha256!);
    assert.equal(checkpoint.state, "completed");
    assert.equal(checkpoint.loop.completedTicks, 3);
    assert.deepEqual(checkpoint.loop.history.map((exchange) => exchange.tick), [1, 2, 3]);
    assert.deepEqual(checkpoint.ledger.outstanding, []);
    assert.equal(checkpoint.world.storageUuid, FAKE_IDENTITY.storageIdentity);

    const manifest = manifestSchema.parse(JSON.parse(await readFile(paths.manifest, "utf8")));
    assert.equal(manifest.mind.adapter, "fake-v1");
    assert.equal(manifest.config.sha256, resolved.configSha256);
    assert.equal(sha256Hex(await readFile(paths.prompt)), resolved.prompt.sha256);
    assert.equal(sha256Hex(await readFile(paths.fakeScript)), resolved.fakeScript!.sha256);

    const analysis = await analyzeRun(paths, result.runId);
    assert.equal(analysis.state, "completed");
    assert.equal(analysis.completedTicks, 3);
    assert.deepEqual(analysis.outstanding, { requests: [], actions: [], reservations: [] });
    assert.equal(await inspectOwnership(state.locks, "run", result.runId), null);
    assert.equal(await inspectOwnership(state.locks, "world", WORLD), null);
  });

  it("stops cleanly on request, leaving a resumable state", async () => {
    const state = await layout();
    const resolved = await configWith([{ type: "wait" }, { type: "wait" }, { type: "wait" }]);
    const controller = new AbortController();
    const world = new FakeWorld();
    world.beforeSample = (tick) => {
      if (tick === 2) controller.abort("SIGTERM");
    };
    const result = await startRun(options(state, resolved, world, { signal: controller.signal }));
    assert.deepEqual([result.state, result.reason], ["stopped_clean", "operator_stop"]);
    // The stop came while tick 2 was observing, so tick 2 sent nothing and is not counted.
    assert.equal(result.completedTicks, 1);
    const checkpoint = await readCheckpoint(runPaths(state, result.runId), result.checkpointSha256!);
    assert.equal(checkpoint.state, "stopped_clean");
    assert.deepEqual(checkpoint.loop.previousOutcome, { kind: "wait" });
    assert.deepEqual(checkpoint.loop.history.map((exchange) => exchange.tick), [1]);
  });

  it("stops cleanly after a provider failure", async () => {
    const state = await layout();
    const result = await startRun(options(state, await configWith([{ type: "wait" }, { type: "failure", kind: "connection", processed: "no" }]), new FakeWorld()));
    assert.deepEqual([result.state, result.reason], ["stopped_clean", "provider_failure"]);
  });

  it("leaves the run for review, without a checkpoint, when the world stop cannot be verified", async () => {
    const state = await layout();
    const world = new FakeWorld();
    world.stopResult = { verified: false, recorded: true, detail: "engine unavailable" };
    const result = await startRun(options(state, await configWith([{ type: "wait" }], (c) => (c.operator.maximumTicks = 1)), world));
    assert.equal(result.state, "recovery_required");
    assert.equal(result.checkpointSha256, null);
    assert.match(result.detail, /could not be verified: engine unavailable/);
    const all = await types(state, result.runId);
    assert.ok(!all.includes("checkpoint.written"));
    assert.deepEqual(lifecycle(all).slice(-2), ["run.stopping", "run.recovery_required"]);
    const analysis = await analyzeRun(runPaths(state, result.runId), result.runId);
    assert.equal(analysis.state, "recovery_required");
  });

  it("requires review, not a checkpoint, when whether a command ran is unknown", async () => {
    for (const state of ["unconfirmed", "uncertain"] as const) {
      const layoutFor = await layout();
      const world = new FakeWorld(() => ({ state }));
      const result = await startRun(options(layoutFor, await configWith([{ type: "shell", command: "touch /world/x" }, { type: "wait" }]), world));
      assert.deepEqual([result.state, result.reason, result.checkpointSha256], ["recovery_required", "uncertain_action", null], state);
      assert.ok(world.calls.includes("stop:uncertain_action"));
      assert.equal(world.dispatched.length, 1);
      const analysis = await analyzeRun(runPaths(layoutFor, result.runId), result.runId);
      assert.equal(analysis.state, "recovery_required");
      assert.deepEqual(analysis.uncertainActions.map((action) => action.state), [state]);
      assert.ok(!(await types(layoutFor, result.runId)).includes("checkpoint.written"));
    }
  });

  it("requires review, not a checkpoint, when a running job later becomes uncertain", async () => {
    const state = await layout();
    const world = new FakeWorld(() => ({ state: "running" }));
    world.beforeSample = (tick) => {
      if (tick === 2) world.lose(world.jobs[0]!.jobId);
    };
    const result = await startRun(options(state, await configWith([{ type: "shell", command: "sleep 100" }, { type: "shell", command: "touch /world/x" }, { type: "wait" }]), world));
    assert.deepEqual([result.state, result.reason, result.checkpointSha256], ["recovery_required", "uncertain_action", null]);
    assert.equal(world.dispatched.length, 1);
    assert.ok(world.calls.includes("stop:uncertain_action"));
    const analysis = await analyzeRun(runPaths(state, result.runId), result.runId);
    assert.deepEqual(analysis.uncertainActions.map((action) => action.state), ["uncertain"]);
  });

  describe("a running job lost late in the run", () => {
    /** Tick 1 starts a job that keeps running; tick 2 waits; the limit is 2 model calls. */
    async function lateLoss(arrange: (world: FakeWorld, lose: () => void) => void) {
      const state = await layout();
      const world = new FakeWorld(() => ({ state: "running" }));
      arrange(world, () => world.lose(world.jobs[0]!.jobId));
      const resolved = await configWith([{ type: "shell", command: "sleep 100" }, { type: "wait" }], (c) => (c.operator.maximumTicks = 2));
      const result = await startRun(options(state, resolved, world));
      const analysis = await analyzeRun(runPaths(state, result.runId), result.runId);
      const all = await types(state, result.runId);
      // In every case: review, the lost action identified, no checkpoint, no replay.
      assert.deepEqual([result.state, result.reason, result.checkpointSha256], ["recovery_required", "uncertain_action", null]);
      assert.deepEqual(analysis.uncertainActions.map((action) => action.actionId), [`${result.runId}.t000001.action`]);
      assert.ok(!all.includes("checkpoint.written"));
      assert.equal(world.dispatched.length, 1);
      assert.deepEqual((await readdir(runPaths(state, result.runId).checkpoints)), []);
      return { result, analysis };
    }

    it("after tick 2's observation: the request is never sent", async () => {
      const { result, analysis } = await lateLoss((world, lose) => {
        world.beforeSample = (tick) => {
          if (tick === 2) queueMicrotask(lose);
        };
      });
      assert.deepEqual([result.attemptedCalls, analysis.calls.unresolved], [1, 0]);
    });

    it("after the last answered call, found by the final refresh", async () => {
      const { result } = await lateLoss((world, lose) => (world.beforeRefresh = lose));
      assert.equal(result.attemptedCalls, 2);
    });

    it("after the final refresh, while the world is being stopped (R2-B)", async () => {
      const { result } = await lateLoss((world, lose) => (world.duringStop = lose));
      assert.equal(result.attemptedCalls, 2);
      assert.match(result.detail, /would have ended for tick_limit/);
    });

    it("while run.stopping is being recorded", async () => {
      // Restored in `finally`; called with the recorder as `this`.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const append = RunRecorder.prototype.append;
      let world: FakeWorld | null = null;
      RunRecorder.prototype.append = function (type, data, options) {
        if (type === "run.stopping") world!.lose(world!.jobs[0]!.jobId);
        return append.call(this, type, data, options);
      };
      try {
        await lateLoss((w) => (world = w));
      } finally {
        RunRecorder.prototype.append = append;
      }
    });
  });

  it("reports a known model call even when its action's outcome is lost and the tick never completes", async () => {
    const state = await layout();
    const world = new FakeWorld();
    world.failAfterPrepare = new Error("connection reset after the start request");
    const result = await startRun(options(state, await configWith([{ type: "shell", command: "touch /world/x" }, { type: "wait" }]), world));
    assert.deepEqual([result.state, result.reason], ["recovery_required", "uncertain_action"]);
    assert.deepEqual([result.completedTicks, result.attemptedCalls, result.respondedCalls], [0, 1, 1]);
    const analysis = await analyzeRun(runPaths(state, result.runId), result.runId);
    assert.deepEqual(analysis.calls, { confirmedAttempted: 1, answered: 1, failed: 0, unresolved: 0 });
    assert.equal(analysis.outstanding.actions.length, 1);
  });

  it("leaves the run for review when the world stopped but its stop was not fully recorded", async () => {
    const state = await layout();
    const world = new FakeWorld();
    world.stopResult = { verified: true, recorded: false, detail: "stopped; not recorded: world.stopping: disk full" };
    const result = await startRun(options(state, await configWith([{ type: "wait" }], (c) => (c.operator.maximumTicks = 1)), world));
    assert.deepEqual([result.state, result.checkpointSha256], ["recovery_required", null]);
    assert.match(result.detail, /stopped, but its stop was not fully recorded/);
  });

  it("stops the world and leaves the run for review when the loop ends uncleanly", async () => {
    const state = await layout();
    const world = new FakeWorld();
    world.beforeSample = (tick) => {
      if (tick === 2) world.container = "stopped";
    };
    const result = await startRun(options(state, await configWith([{ type: "wait" }, { type: "wait" }]), world));
    assert.deepEqual([result.state, result.reason], ["recovery_required", "world_exit"]);
    assert.ok(world.calls.includes("stop:world_exit"));
    assert.deepEqual(lifecycle(await types(state, result.runId)).slice(-2), ["run.started", "run.recovery_required"]);
  });

  it("ends without any action when the world cannot start, and says whether it is known to be stopped", async () => {
    const state = await layout();
    const resolved = await configWith([{ type: "wait" }]);
    const failed = new FakeWorld();
    failed.startError = new Error("verification failed");
    const stopped = await startRun(options(state, resolved, failed));
    assert.deepEqual([stopped.state, stopped.reason], ["completed", "world_start_failed"]);
    assert.deepEqual(lifecycle(await types(state, stopped.runId)), ["run.created", "run.ready", "run.completed"]);

    const running = new FakeWorld();
    running.startError = new Error("stop after failed start was not verified");
    running.containerAfterFailedStart = "running";
    const stoppedAfter = await startRun(options(state, resolved, running));
    // The run stops a container that a failed start left running.
    assert.ok(running.calls.includes("stop:world_start_failed"), running.calls.join(","));
    assert.equal(running.container, "absent");
    assert.deepEqual([stoppedAfter.state, stoppedAfter.worldStop?.verified], ["completed", true]);

    const stuck = new FakeWorld();
    stuck.startError = new Error("world.verified could not be recorded");
    stuck.containerAfterFailedStart = "running";
    stuck.stopResult = { verified: false, recorded: true, detail: "engine unavailable" };
    const unknown = await startRun(options(state, resolved, stuck));
    assert.ok(stuck.calls.includes("stop:world_start_failed"));
    assert.equal(unknown.state, "recovery_required");

    const unattached = new FakeWorld();
    unattached.attachError = new Error("stale loop device");
    const refused = await startRun(options(state, resolved, unattached));
    assert.deepEqual([refused.state, refused.reason], ["completed", "world_start_failed"]);
    assert.ok(!unattached.calls.includes("start"));
  });

  it("refuses paid execution and a world owned by another controller before creating records", async () => {
    const state = await layout();
    const paid = await configWith([], (c) => {
      c.mind = {
        provider: "openai",
        model: "some-model",
        credentialEnv: "ALIFE_OPENAI_API_KEY",
        maximumOutputTokens: 1024,
        requestTimeoutMs: 60_000,
        retryProfile: "none-v1",
        costBound: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, source: "test", verifiedOn: "2026-09-25" },
      };
      c.operator.maximumEstimatedCostUsd = 1;
    });
    await assert.rejects(startRun(options(state, paid, new FakeWorld())), RunRefusedError);

    const lock = await acquireOwnership(state.locks, "world", WORLD, new FakeClock());
    const world = new FakeWorld();
    await assert.rejects(startRun(options(state, await configWith([{ type: "wait" }]), world)), OwnershipConflictError);
    assert.deepEqual(world.calls, []);
    await lock.release();

    // A world still running (for example, left by a killed controller) is refused before any record.
    const left = new FakeWorld();
    left.container = "running";
    await assert.rejects(startRun(options(state, await configWith([{ type: "wait" }]), left)), /already running/);
    assert.ok(!left.calls.includes("attach"));

    // So is a prompt changed after validation.
    const changed = await configWith([{ type: "wait" }]);
    await writeFile(changed.prompt.path, "a different prompt\n");
    await assert.rejects(startRun(options(state, changed, new FakeWorld())), /prompt file changed/);
    assert.deepEqual(await readdir(state.runs), []);
  });
});

describe("run records", () => {
  it("counts every file the run stores against its record limit", async () => {
    const state = await layout();
    const result = await startRun(options(state, await configWith([{ type: "shell", command: "echo hi" }, { type: "wait" }]), new FakeWorld(() => ({ stdout: "hi\n" }))));
    const paths = runPaths(state, result.runId);
    let onDisk = 0;
    for (const name of await readdir(paths.directory, { recursive: true })) {
      const info = await stat(path.join(paths.directory, name));
      if (info.isFile()) onDisk += info.size;
    }
    const recorder = await RunRecorder.open({ paths, runId: result.runId, clock: new FakeClock(), limitBytes: 16 << 20 });
    try {
      assert.equal(recorder.usedBytes, onDisk);
    } finally {
      await recorder.close();
    }
  });

  it("refuses a run whose initial records leave no room for a tick, before any record exists", async () => {
    const state = await layout();
    const file = await variant((c) => (c.operator.recordLimitMiB = 16));
    // A valid script padded to the 16 MiB script limit.
    const script = JSON.stringify({ schemaVersion: 1, turns: [{ type: "wait" }] });
    await writeFile(path.join(path.dirname(file), "fake-script.json"), script + " ".repeat((16 << 20) - script.length));
    const loaded = await loadConfig(file);
    assert.ok(loaded.ok);
    await assert.rejects(startRun(options(state, loaded.resolved, new FakeWorld())), /initial records .* exceed operator\.recordLimitMiB/);
    assert.deepEqual(await readdir(state.runs), []);
  });

  it("verifies inline and blob text against its size and hash", async () => {
    const state = await layout();
    const runId = parseRunId("r-20260925T161449Z-00000b0b");
    const paths = runPaths(state, runId);
    await createRunDirectory(paths);
    const recorder = await RunRecorder.open({ paths, runId, clock: new FakeClock(), limitBytes: 1 << 20 });
    try {
      const small = await recorder.text("naïve ✓ text");
      const large = await recorder.text("é".repeat(20_000));
      assert.equal(await readText(paths, small), "naïve ✓ text");
      assert.equal(await readText(paths, large), "é".repeat(20_000));
      await assert.rejects(readText(paths, { ...small, text: "changed" }), /inline text does not match/);
      await assert.rejects(readText(paths, { ...small, bytes: small.bytes + 1 }), /inline text does not match/);
      await assert.rejects(readText(paths, { ...small, sha256: "0".repeat(64) }), /inline text does not match/);
      await assert.rejects(readText(paths, { ...large, bytes: 1 }), /blob .* does not match/);
    } finally {
      await recorder.close();
    }
  });
});

describe("interrupted runs", () => {
  const RUN = parseRunId("r-20260925T161449Z-0000beef");

  /** A log as a controller killed right after dispatching tick 1's action would leave it. */
  async function interrupted(state: StateLayout) {
    const paths = runPaths(state, RUN);
    await createRunDirectory(paths);
    const clock = new FakeClock();
    const records = await RunRecorder.open({ paths, runId: RUN, clock, limitBytes: 1 << 20 });
    const request = `${RUN}.t000001.request`;
    const action = `${RUN}.t000001.action`;
    await records.append("run.created", { worldId: WORLD }, { durable: true });
    await records.append("run.ready", {}, { durable: true });
    await records.append("run.started", {}, { durable: true });
    await records.append("cost.reserved", { requestId: request, microUsd: 0 }, { tick: 1, durable: true });
    await records.append("model.requested", { requestId: request }, { tick: 1, durable: true });
    await records.append("model.responded", { requestId: request }, { tick: 1, durable: true });
    await records.append("cost.reconciled", { requestId: request }, { tick: 1, durable: true });
    await records.append("action.prepared", { actionId: action, jobId: action, execId: "exec-1" }, { tick: 1, durable: true });
    await records.close();
    return { paths, clock, action };
  }

  it("detects a prepared action without an outcome and finalizes only with the world stopped", async () => {
    const state = await layout();
    const { paths, clock, action } = await interrupted(state);
    const analysis = await analyzeRun(paths, RUN);
    assert.equal(analysis.state, "running");
    assert.deepEqual(analysis.outstanding.actions, [{ actionId: action, tick: 1, jobId: action, execId: "exec-1" }]);
    assert.deepEqual(analysis.outstanding.requests, []);
    assert.ok(isInterrupted(analysis, null));
    assert.ok(!isInterrupted(analysis, { holder: null, appearsAlive: true }));

    await assert.rejects(
      finalizeRun({ paths, runId: RUN, clock, analysis, world: { container: "running", detail: "running" }, limitBytes: 1 << 20 }),
      FinalizeRefusedError,
    );
    const record = await finalizeRun({ paths, runId: RUN, clock, analysis, world: { container: "absent", detail: "no container" }, limitBytes: 1 << 20 });
    assert.equal(record.logProblem, null);
    assert.deepEqual(record.acknowledged.actions.map((item) => item.actionId), [action]);
    const log = await readEventLog(paths.events);
    assert.deepEqual(log.events.slice(-2).map((event) => [event.type, event.data.reason ?? null]), [
      ["run.recovery_required", "controller_interrupted"],
      ["run.finalized", null],
    ]);
    const after = await analyzeRun(paths, RUN);
    assert.equal(after.state, "finalized");
    assert.ok(!isInterrupted(after, null));
    await assert.rejects(
      finalizeRun({ paths, runId: RUN, clock, analysis: after, world: { container: "absent", detail: "" }, limitBytes: 1 << 20 }),
      FinalizeRefusedError,
    );
  });

  it("keeps a damaged log untouched and records the finalization beside it", async () => {
    const state = await layout();
    const { paths, clock } = await interrupted(state);
    await appendFile(paths.events, '{"v":1,"seq":9,"trunc');
    const before = await readFile(paths.events);
    const analysis = await analyzeRun(paths, RUN);
    assert.equal(analysis.issues[0]!.kind, "partial_tail");
    const record = await finalizeRun({ paths, runId: RUN, clock, analysis, world: { container: "unknown", detail: "engine unavailable" }, limitBytes: 1 << 20 });
    assert.match(record.logProblem!, /damaged/);
    assert.deepEqual(await readFile(paths.events), before);
    const after = await analyzeRun(paths, RUN);
    assert.equal(after.state, "finalized");
    assert.equal(after.finalization!.world.container, "unknown");
  });

  it("records the finalization beside the log when the run's record limit is unknown", async () => {
    const state = await layout();
    const { paths, clock } = await interrupted(state);
    const before = await readFile(paths.events);
    const record = await finalizeRun({ paths, runId: RUN, clock, analysis: await analyzeRun(paths, RUN), world: { container: "absent", detail: "" }, limitBytes: null });
    assert.match(record.logProblem!, /configuration/);
    assert.deepEqual(await readFile(paths.events), before);
    assert.equal((await analyzeRun(paths, RUN)).state, "finalized");
  });

  it("refuses to finalize a run that ended cleanly", async () => {
    const state = await layout();
    const result = await startRun(options(state, await configWith([{ type: "wait" }], (c) => (c.operator.maximumTicks = 1)), new FakeWorld()));
    const paths = runPaths(state, result.runId);
    await assert.rejects(
      finalizeRun({ paths, runId: result.runId, clock: new FakeClock(), analysis: await analyzeRun(paths, result.runId), world: { container: "absent", detail: "" }, limitBytes: 1 << 20 }),
      /ended completed/,
    );
  });
});
