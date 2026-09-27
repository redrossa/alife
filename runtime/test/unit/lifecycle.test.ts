import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { loadConfig, type ResolvedConfig } from "../../src/config/resolve.ts";
import type { DispatchHooks } from "../../src/core/contracts.ts";
import { DispatchRefusedError, UncertainJobsError } from "../../src/core/dispatch.ts";
import type { FakeTurn } from "../../src/mind/fake.ts";
import { startRun, type RunResult } from "../../src/operator/run.ts";
import { prepareStateDir, type StateLayout } from "../../src/operator/state-dir.ts";
import { readCheckpoint } from "../../src/records/checkpoint.ts";
import { readEventLog, type EventType } from "../../src/records/events.ts";
import { analyzeRun } from "../../src/records/finalize.ts";
import { RunRecorder, runPaths } from "../../src/records/run-store.ts";
import { DockerEngine, type RawStream } from "../../src/world/engine.ts";
import { dockerExecTransport } from "../../src/world/exec.ts";
import { variant } from "../support/config.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { offlineWorld, type OfflineWorld } from "../support/offline-world.ts";

// Phase 3 lifecycle plan §9 B, D, and E, through the real backend
// (`DockerWorld` over an in-memory engine), the real job table, recorder,
// analyzer, and checkpoint writer and reader.

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const plain: DispatchHooks = { prepared: () => Promise.resolve() };

async function layout(): Promise<StateLayout> {
  return prepareStateDir(await mkdtemp(path.join(tmpdir(), "alife-lifecycle-")));
}

async function configWith(turns: FakeTurn[], maximumTicks: number): Promise<ResolvedConfig> {
  const file = await variant((c) => (c.operator.maximumTicks = maximumTicks));
  await writeFile(path.join(path.dirname(file), "fake-script.json"), JSON.stringify({ schemaVersion: 1, turns }));
  const loaded = await loadConfig(file);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return loaded.resolved;
}

/** Patches the run recorder so `hook` runs before the named events are appended. Restored by the returned function. */
function beforeRunEvent(hook: (type: EventType, data: Readonly<Record<string, unknown>>) => Promise<void> | void): () => void {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const append = RunRecorder.prototype.append;
  RunRecorder.prototype.append = async function (type, data, options) {
    await hook(type, data);
    return append.call(this, type, data, options);
  };
  return () => (RunRecorder.prototype.append = append);
}

/**
 * Tick 1 starts `sleep 100`, which keeps running; tick 2 waits; the limit is
 * two model calls. `arrange` injects the loss of job 1 somewhere.
 */
async function episode(arrange: (offline: OfflineWorld) => (() => void) | void = () => undefined, turns?: FakeTurn[]) {
  const state = await layout();
  const clock = new FakeClock();
  const offline = await offlineWorld(state, clock, {});
  const restore = arrange(offline);
  let result: RunResult;
  try {
    result = await startRun({
      layout: state,
      resolved: await configWith(turns ?? [{ type: "shell", command: "sleep 100" }, { type: "wait" }], 2),
      worldId: offline.worldId,
      clock,
      signal: new AbortController().signal,
      allowPrivilegedHelper: false,
      openWorld: () => Promise.resolve(offline.world),
      hostFreeMiB: () => Promise.resolve(1_000_000),
    });
  } finally {
    restore?.();
  }
  const paths = runPaths(state, result.runId);
  const log = await readEventLog(paths.events);
  return { result, offline, paths, log, analysis: await analyzeRun(paths, result.runId), checkpoints: await readdir(paths.checkpoints) };
}

type Episode = Awaited<ReturnType<typeof episode>>;

/** The required outcome for every real uncertainty case. */
function assertReviewed({ result, offline, log, analysis, checkpoints }: Episode, requestedReason = "tick_limit") {
  const job = `${result.runId}.t000001.action`;
  assert.deepEqual([result.state, result.reason, result.checkpointSha256], ["recovery_required", "uncertain_action", null], result.detail);
  assert.deepEqual(analysis.uncertainActions.map((action) => action.actionId), [job]);
  assert.ok(!log.events.some((event) => event.type === "checkpoint.written"));
  assert.deepEqual(checkpoints, []);
  // The physical stop happened; nothing was started twice.
  assert.ok(offline.engine.calls.some((call) => call.endsWith("/stop")));
  assert.deepEqual(offline.engine.jobs().map((exec) => exec.starts), [1]);
  const final = log.events.at(-1)!;
  assert.equal(final.type, "run.recovery_required");
  assert.equal(final.data.requestedReason, requestedReason);
}

/** Makes the engine forget job 1, then lets an inspection see it (as a poll would). */
async function lose(offline: OfflineWorld) {
  offline.engine.forget(1);
  await offline.world.refreshJobSafety();
}

describe("stop and checkpoint eligibility (R2-B), real backend", () => {
  it("a normal running job ended by a verified stop remains eligible for a clean checkpoint", async () => {
    const run = await episode();
    assert.deepEqual([run.result.state, run.result.reason], ["completed", "tick_limit"], run.result.detail);
    const checkpoint = await readCheckpoint(run.paths, run.result.checkpointSha256!);
    assert.deepEqual([checkpoint.safety.sealed, checkpoint.safety.reviewRequired, checkpoint.safety.committedEffects], [true, false, 1]);
    assert.equal(checkpoint.safety.epochId, run.result.worldStop!.safety.epochId);
    assert.deepEqual(run.analysis.uncertainActions, []);
  });

  it("loss after the last observation, before the final refresh", async () => {
    const run = await episode((offline) =>
      beforeRunEvent((type, data) => {
        if (type === "tick.completed" && data.attemptedCalls === 2) offline.engine.forget(1);
      }),
    );
    // Found by the loop's own final refresh, which ends it for review.
    assertReviewed(run, "uncertain_action");
  });

  it("loss after the final refresh, while run.stopping is being recorded", async () => {
    let world!: OfflineWorld;
    const run = await episode((offline) => {
      world = offline;
      return beforeRunEvent(async (type) => {
        if (type === "run.stopping") await lose(world);
      });
    });
    assertReviewed(run);
  });

  it("loss while the backend's world.stopping record is being written", async () => {
    const run = await episode((offline) => {
      const append = offline.log.append.bind(offline.log);
      offline.log.append = async (type, data, options) => {
        if (type === "world.stopping") await lose(offline);
        return append(type, data, options);
      };
    });
    assertReviewed(run);
    assert.equal(run.result.worldStop!.safety.sealed, true);
  });

  it("a failed post-stop run record before the checkpoint blocks it; after the artifact, the orphan stays and the run is not clean", async () => {
    for (const failing of ["world.stopped", "checkpoint.written", "run.completed"] as const) {
      const run = await episode(() =>
        beforeRunEvent((type) => {
          if (type === failing) throw new Error("disk full");
        }),
      );
      assert.equal(run.result.state, "recovery_required", failing);
      assert.equal(run.result.checkpointSha256, null, failing);
      // Only a checkpoint written before the failure exists, as evidence; it is never a committed clean run.
      assert.equal(run.checkpoints.length, failing === "world.stopped" ? 0 : 1, failing);
      assert.ok(!run.log.events.some((event) => event.type === "run.completed"), failing);
      assert.equal(run.analysis.state, "recovery_required", failing);
    }
  });
});

describe("backend stop protocol", () => {
  const opened: OfflineWorld[] = [];
  afterEach(async () => {
    for (const offline of opened.splice(0)) await offline.world.close();
  });

  async function started() {
    const state = await layout();
    const offline = await offlineWorld(state, new FakeClock(), {});
    opened.push(offline);
    await offline.world.start();
    const a = await offline.world.submit({ actionId: "a", command: "sleep 100" }, plain);
    assert.equal(a.state, "running");
    return offline;
  }

  it("drains a submission in progress: established uncertainty refuses it, and the stop keeps the uncertainty", async () => {
    const offline = await started();
    const hold = gate();
    const reached = gate();
    const pending = offline.world
      .submit({ actionId: "b", command: "touch /world/x" }, {
        prepared: async () => {
          reached.open();
          await hold.promise;
        },
      })
      .catch((error: unknown) => error);
    await reached.promise;
    const stopping = offline.world.stop("operator_stop");
    await lose(offline);
    hold.open();
    const refused = await pending;
    assert.ok(refused instanceof UncertainJobsError, String(refused));
    const stopped = await stopping;
    assert.deepEqual([stopped.verified, stopped.safety.sealed, stopped.safety.reviewRequired], [true, true, true]);
    assert.deepEqual(stopped.safety.uncertainEffects.map((effect) => effect.jobId), ["a"]);
    assert.deepEqual(offline.engine.jobs().map((exec) => exec.starts), [1, 0]);
  });

  it("a submission whose record is rejected during the drain cannot keep the world running, and blocks certification", async () => {
    const offline = await started();
    const reached = gate();
    const reject = gate();
    const pending = offline.world
      .submit({ actionId: "b", command: "true" }, {
        prepared: async () => {
          reached.open();
          await reject.promise;
          throw new Error("disk full");
        },
      })
      .catch((error: unknown) => error);
    await reached.promise;
    const stopping = offline.world.stop("operator_stop");
    reject.open();
    assert.ok((await pending) instanceof DispatchRefusedError);
    const stopped = await stopping;
    assert.equal(stopped.verified, true);
    assert.deepEqual([stopped.safety.sealed, stopped.safety.requiredEvidenceFailed, stopped.safety.reviewRequired], [true, true, true]);
    assert.deepEqual(offline.engine.jobs().map((exec) => exec.starts), [1, 0]);
  });

  it("does not read an inspection answered after the stop was committed as pre-stop uncertainty", async () => {
    const offline = await started();
    const hold = gate();
    offline.engine.inspectGate = hold.promise;
    const inspecting = offline.world.refreshJobSafety();
    // The inspection is in flight; the stop is committed; only then does the answer arrive, showing the exec gone.
    offline.engine.onStop = () => {
      offline.engine.forget(1);
      offline.engine.inspectGate = null;
      hold.open();
    };
    const stopped = await offline.world.stop("tick_limit");
    await inspecting;
    assert.deepEqual([stopped.verified, stopped.recorded, stopped.safety.sealed, stopped.safety.reviewRequired], [true, true, true, false]);
  });

  it("keeps uncertainty through disposal and removal, and a failed removal record keeps the evidence incomplete", async () => {
    const state = await layout();
    const offline = await offlineWorld(state, new FakeClock(), {
      wrapLog: (log) => {
        const append = log.append.bind(log);
        log.append = (type, data, options) => (type === "world.container_removed" ? Promise.reject(new Error("disk full")) : append(type, data, options));
      },
    });
    opened.push(offline);
    await offline.world.start();
    await offline.world.submit({ actionId: "a", command: "sleep 100" }, plain);
    await lose(offline);
    const stopped = await offline.world.stop("operator_stop");
    assert.deepEqual([stopped.verified, stopped.recorded], [true, false]);
    assert.deepEqual(stopped.safety.uncertainEffects.map((effect) => effect.jobId), ["a"]);
    assert.deepEqual([stopped.safety.sealed, stopped.safety.requiredEvidenceFailed], [true, true]);
    // The job table is gone; the epoch's safety condition is not.
    assert.equal(offline.world.safety()!.reviewRequired, true);
  });

  it("coalesces concurrent stops, and a repeated stop keeps the epoch's issues", async () => {
    const offline = await started();
    await lose(offline);
    const first = offline.world.stop("operator_stop");
    const second = offline.world.stop("operator_stop");
    assert.equal(first, second);
    const stopped = await first;
    const again = await offline.world.stop("operator_stop");
    assert.equal(again.detail, "no world container exists");
    assert.deepEqual(again.safety.uncertainEffects.map((effect) => effect.jobId), ["a"]);
    assert.equal(again.safety, stopped.safety);
  });

  it("does not treat a vanished container as accounting for executions expected alive", async () => {
    const offline = await started();
    offline.engine.container = null;
    const stopped = await offline.world.stop("operator_stop");
    assert.equal(stopped.verified, true);
    assert.deepEqual(stopped.safety.uncertainEffects.map((effect) => [effect.jobId, effect.cause]), [["a", "execution_lost"]]);
    assert.equal(stopped.safety.reviewRequired, true);
  });

  it("returns an unsealed, review-requiring assessment for a failed stop, and later uncertainty reaches the next one", async () => {
    const offline = await started();
    offline.engine.stopError = new Error("engine unavailable");
    const failed = await offline.world.stop("operator_stop");
    assert.deepEqual([failed.verified, failed.safety.sealed, failed.safety.reviewRequired], [false, false, true]);
    // Admission stays closed.
    await assert.rejects(offline.world.submit({ actionId: "b", command: "true" }, plain), DispatchRefusedError);
    await lose(offline);
    offline.engine.stopError = null;
    const stopped = await offline.world.stop("operator_stop");
    assert.deepEqual(stopped.safety.uncertainEffects.map((effect) => effect.jobId), ["a"]);
  });

  it("starts a fresh epoch only after a clean one; a review-requiring epoch cannot be restarted by this controller", async () => {
    const offline = await started();
    const clean = await offline.world.stop("operator_stop");
    assert.equal(clean.safety.reviewRequired, false);
    await offline.world.start();
    assert.notEqual(offline.world.safety()!.epochId, clean.safety.epochId);
    // The new epoch starts clean, whatever the old receipt says; the old receipt is unchanged.
    assert.equal(offline.world.safety()!.committedEffects, 0);
    assert.equal(clean.safety.committedEffects, 1);
    await offline.world.submit({ actionId: "b", command: "sleep 100" }, plain);
    offline.engine.forget(2);
    await offline.world.refreshJobSafety();
    await offline.world.stop("operator_stop");
    await assert.rejects(offline.world.start(), /requires review/);
  });

  it("keeps a stale state from a transient engine failure stale, not uncertain", async () => {
    const offline = await started();
    offline.engine.unavailable = true;
    await offline.world.refreshJobSafety();
    const sample = await offline.world.sample({ listing: false });
    assert.match(sample.jobs[0]!.inspectionFailure ?? "", /unavailable/);
    assert.equal(offline.world.safety()!.reviewRequired, false);
    offline.engine.unavailable = false;
    const stopped = await offline.world.stop("tick_limit");
    assert.deepEqual([stopped.safety.sealed, stopped.safety.reviewRequired], [true, false]);
  });
});

describe("transport commitment boundary", () => {
  it("issues the exec start request synchronously when start is called", () => {
    const hijacked: string[] = [];
    const engine = new (class extends DockerEngine {
      override hijack(route: string): Promise<RawStream> {
        hijacked.push(route);
        return new Promise(() => undefined);
      }
    })({ name: "t", endpoint: "unix:///nonexistent", socketPath: "/nonexistent" });
    const transport = dockerExecTransport(engine, "c".repeat(64), "1000:1000");
    void transport.start("e".repeat(64));
    // No await has happened: the request is already issued.
    assert.deepEqual(hijacked, [`/exec/${"e".repeat(64)}/start`]);
  });

  it("sends the hijacked HTTP request before returning, with no awaited work in between", () => {
    const sent: string[] = [];
    const original = http.request;
    const fake = {
      on: () => fake,
      end: () => sent.push("end"),
      destroy: () => undefined,
    };
    (http as { request: unknown }).request = (options: { path: string }) => {
      sent.push(`request ${options.path}`);
      return fake;
    };
    try {
      const engine = new DockerEngine({ name: "t", endpoint: "unix:///nonexistent", socketPath: "/nonexistent" });
      void engine.hijack("/exec/x/start", { Detach: false, Tty: false }, { timeoutMs: 10 }).catch(() => undefined);
      assert.deepEqual(sent, ["request /v1.44/exec/x/start", "end"]);
    } finally {
      (http as { request: unknown }).request = original;
    }
  });
});
