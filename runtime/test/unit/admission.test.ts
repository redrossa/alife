import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DispatchHooks } from "../../src/core/contracts.ts";
import { UncertainJobsError } from "../../src/core/dispatch.ts";
import { certifiesClean, ExecutionSafety, noEpochAssessment, SealedSafetyError, type UncertainEffect } from "../../src/core/execution-safety.ts";
import { ExecGoneError } from "../../src/world/exec.ts";
import { JobTable, type JobEventType } from "../../src/world/jobs.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { FakeTransport, frame } from "../support/fake-exec.ts";

// Phase 3 lifecycle plan §9 A and C: an established uncertainty admits no
// later agent effect, wherever it arrives relative to the awaited steps of a
// submission; the safety object keeps it for the rest of the epoch.

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

interface Recorded {
  readonly type: JobEventType;
  readonly data: Readonly<Record<string, unknown>>;
}

function table(options: { poll?: boolean; record?: (type: JobEventType, data: Readonly<Record<string, unknown>>) => Promise<void> } = {}) {
  const transport = new FakeTransport();
  const safety = new ExecutionSafety({ epochId: "epoch", maximumEffects: 4 });
  const events: Recorded[] = [];
  const waiters: { type: JobEventType; to?: string; open: () => void }[] = [];
  const jobs = new JobTable({
    safety,
    transport,
    clock: new FakeClock(),
    actionWaitMs: 1000,
    maximumConcurrentJobs: 3,
    retainedFinishedJobs: 4,
    capturedOutputBytes: 64,
    // Real background polling when asked for; otherwise effectively none.
    exitPollIntervalMs: options.poll === true ? 5 : 3_600_000,
    record: async (type, data) => {
      events.push({ type, data });
      for (const waiter of waiters) if (waiter.type === type && (waiter.to === undefined || data.to === waiter.to)) waiter.open();
      await options.record?.(type, data);
    },
    control: () => Promise.reject(new Error("unused")),
  });
  /** Resolves when an event of `type` (and transition target `to`) is recorded. */
  const recorded = (type: JobEventType, to?: string) => {
    const waiter = gate();
    waiters.push({ type, ...(to === undefined ? {} : { to }), open: waiter.open });
    return waiter.promise;
  };
  const refused = () => events.filter((event) => event.type === "job.start_refused");
  return { transport, safety, jobs, events, recorded, refused };
}

const plain: DispatchHooks = { prepared: () => Promise.resolve() };

/** Job A running; then the engine forgets it. */
async function runningA(t: ReturnType<typeof table>) {
  const a = await t.jobs.submit({ actionId: "a", command: "sleep 100" }, plain);
  assert.equal(a.state, "running");
  return () => {
    t.transport.failInspect = new ExecGoneError("exec-a");
  };
}

/** Asserts B never started, was refused because of A, and A is latched. */
function assertRefused(t: ReturnType<typeof table>, error: unknown, prepared: boolean) {
  assert.ok(error instanceof UncertainJobsError, String(error));
  assert.deepEqual(error.jobIds, ["a"]);
  const bStarts = [...t.transport.execs.values()].slice(1).reduce((sum, exec) => sum + exec.starts, 0);
  assert.equal(bStarts, 0, "B must never start");
  assert.deepEqual(t.safety.snapshot().uncertainEffects.map((effect) => effect.jobId), ["a"]);
  if (prepared) {
    assert.deepEqual(
      t.refused().map((event) => [event.data.jobId, event.data.reason, event.data.uncertainJobs]),
      [["b", "uncertain_jobs", ["a"]]],
    );
  }
}

describe("final admission guard (R2-A)", () => {
  it("refuses before creating anything when the uncertainty is found by the admission refresh", async () => {
    const t = table();
    (await runningA(t))();
    const error = await t.jobs.submit({ actionId: "b", command: "touch x" }, plain).catch((e: unknown) => e);
    assertRefused(t, error, false);
    assert.equal(t.transport.created, 1);
  });

  it("refuses B when A is lost during B's awaited exec creation", async () => {
    const t = table();
    const forget = await runningA(t);
    const hold = gate();
    t.transport.createGate = hold.promise;
    const pending = t.jobs.submit({ actionId: "b", command: "touch x" }, plain).catch((e: unknown) => e);
    // Wait until B is inside its awaited exec creation (its admission refresh is over).
    while (t.transport.created < 2) await new Promise((resolve) => setImmediate(resolve));
    forget();
    await t.jobs.refreshSafety();
    hold.open();
    assertRefused(t, await pending, true);
    assert.equal(t.transport.created, 2, "B's execution was created but never started");
  });

  for (const discovery of ["explicit inspection", "real background polling"] as const) {
    it(`refuses B when A is lost while B's preparation record is held (${discovery})`, async () => {
      const t = table({ poll: discovery === "real background polling" });
      const forget = await runningA(t);
      const hold = gate();
      const reached = gate();
      const hooks: DispatchHooks = {
        prepared: async () => {
          reached.open();
          await hold.promise;
        },
      };
      const pending = t.jobs.submit({ actionId: "b", command: "touch x" }, hooks).catch((e: unknown) => e);
      await reached.promise;
      forget();
      if (discovery === "explicit inspection") await t.jobs.refreshSafety();
      else await t.recorded("job.state", "uncertain");
      hold.open();
      assertRefused(t, await pending, true);
      await t.jobs.close();
    });
  }

  it("refuses B when A is lost while the world's durable job.prepared record is held", async () => {
    const hold = gate();
    const reached = gate();
    let holdB = false;
    const t = table({
      record: async (type, data) => {
        if (holdB && type === "job.prepared" && data.jobId === "b") {
          reached.open();
          await hold.promise;
        }
      },
    });
    const forget = await runningA(t);
    holdB = true;
    const pending = t.jobs.submit({ actionId: "b", command: "touch x" }, plain).catch((e: unknown) => e);
    await reached.promise;
    forget();
    await t.jobs.refreshSafety();
    hold.open();
    assertRefused(t, await pending, true);
  });

  it("re-reads the safety condition after the caller's synchronous proceed hook", async () => {
    const t = table();
    await runningA(t);
    const effect: UncertainEffect = { actionId: "a", jobId: "a", execId: null, cause: "execution_lost", firstObservedAt: "t", detail: "lost" };
    const hooks: DispatchHooks = {
      prepared: () => Promise.resolve(),
      // Established at the last possible moment before the start request.
      proceed: () => {
        t.safety.latchUncertainty(effect);
        return true;
      },
    };
    assertRefused(t, await t.jobs.submit({ actionId: "b", command: "touch x" }, hooks).catch((e: unknown) => e), true);
  });

  it("keeps a start already handed to the transport: committed once, never replayed, review required", async () => {
    const t = table();
    const forget = await runningA(t);
    const hold = gate();
    t.transport.startGate = hold.promise;
    const pending = t.jobs.submit({ actionId: "b", command: "touch x" }, plain);
    // Wait until B's start request is issued.
    while (t.transport.created < 2 || t.transport.exec(2).starts === 0) await new Promise((resolve) => setImmediate(resolve));
    forget();
    await t.jobs.refreshSafety();
    hold.open();
    const b = await pending;
    assert.equal(b.jobId, "b");
    assert.equal(t.transport.exec(2).starts, 1);
    assert.equal(t.safety.snapshot().committedEffects, 2);
    assert.equal(t.safety.snapshot().reviewRequired, true);
    // Nothing more is admitted.
    await assert.rejects(t.jobs.submit({ actionId: "c", command: "true" }, plain), UncertainJobsError);
    assert.equal(t.transport.exec(2).starts, 1);
  });

  it("never starts B when the uncertain transition and the refusal both fail to record", async () => {
    let failing = false;
    const t = table({
      record: (type) => (failing && (type === "job.state" || type === "job.start_refused") ? Promise.reject(new Error("disk full")) : Promise.resolve()),
    });
    const forget = await runningA(t);
    const hold = gate();
    const reached = gate();
    const hooks: DispatchHooks = {
      prepared: async () => {
        reached.open();
        await hold.promise;
      },
    };
    const pending = t.jobs.submit({ actionId: "b", command: "touch x" }, hooks).catch((e: unknown) => e);
    await reached.promise;
    failing = true;
    forget();
    await t.jobs.refreshSafety().catch(() => undefined);
    hold.open();
    const error = await pending;
    assert.ok(error instanceof UncertainJobsError);
    assert.equal(t.transport.exec(2).starts, 0);
    // The latch preceded the failed record; the failure itself is kept as incomplete evidence.
    assert.deepEqual(t.safety.snapshot().uncertainEffects.map((effect) => effect.jobId), ["a"]);
    assert.equal(t.safety.snapshot().requiredEvidenceFailed, true);
  });

  it("keeps refusing repeated submissions with bounded evidence", async () => {
    const t = table();
    (await runningA(t))();
    for (let n = 0; n < 20; n++) await assert.rejects(t.jobs.submit({ actionId: `b${n}`, command: "true" }, plain), UncertainJobsError);
    assert.equal(t.transport.created, 1);
    assert.equal(t.safety.snapshot().uncertainEffects.length, 1);
  });

  it("latches before its record is written: a held record cannot delay the condition", async () => {
    const held = gate();
    const t = table({ record: (type, data) => (type === "job.state" && data.to === "uncertain" ? held.promise : Promise.resolve()) });
    const forget = await runningA(t);
    forget();
    const refreshing = t.jobs.refreshSafety();
    await new Promise((resolve) => setImmediate(resolve));
    // The uncertain transition's record is still held, yet the condition is already latched.
    assert.deepEqual(t.safety.snapshot().uncertainEffects.map((effect) => effect.jobId), ["a"]);
    assert.equal(t.safety.snapshot().admission, "closed");
    held.open();
    await refreshing;
  });
});

describe("agent signals", () => {
  it("admits an agent's signal like any agent effect, at its own start, while operator signals stay available", async () => {
    const transport = new FakeTransport();
    transport.onStart = (_id, exec) => {
      exec.state = { running: true, exitCode: null };
      queueMicrotask(() => exec.stream!.emit(frame("stderr", "alife-job 57 123456\n")));
    };
    const safety = new ExecutionSafety({ epochId: "epoch", maximumEffects: 4 });
    const controls: (readonly string[])[] = [];
    const jobs = new JobTable({
      safety,
      transport,
      clock: new FakeClock(),
      actionWaitMs: 1000,
      maximumConcurrentJobs: 3,
      retainedFinishedJobs: 4,
      capturedOutputBytes: 64,
      exitPollIntervalMs: 3_600_000,
      record: () => Promise.resolve(),
      control: (cmd, _timeoutMs, admit) => {
        const denial = admit?.() ?? null;
        if (denial !== null) return Promise.reject(denial);
        controls.push(cmd);
        return Promise.resolve({ exitCode: 0, stdout: Buffer.from('{"result":"sent"}'), stderr: Buffer.alloc(0), overflow: false, timedOut: false });
      },
    });
    await jobs.submit({ actionId: "a", command: "sleep 100" }, plain);
    await jobs.submit({ actionId: "b", command: "sleep 100" }, plain);
    safety.latchUncertainty({ actionId: "b", jobId: "b", execId: null, cause: "execution_lost", firstObservedAt: "t", detail: "lost" });
    const agent = await jobs.signal("a", "TERM", "agent");
    assert.equal(agent.delivered, false);
    assert.match(agent.detail, /nothing was signalled: the outcome of b is uncertain/);
    assert.deepEqual(controls, []);
    const operator = await jobs.signal("a", "TERM", "operator");
    assert.equal(operator.delivered, true);
    assert.equal(controls.length, 1);
    await jobs.close();
  });
});

describe("execution safety", () => {
  const effect = (jobId: string): UncertainEffect => ({ actionId: jobId, jobId, execId: null, cause: "execution_lost", firstObservedAt: "t1", detail: "lost" });

  it("latches monotonically: admission closes, repeats deduplicate, the first observation is kept", () => {
    const safety = new ExecutionSafety({ epochId: "e", maximumEffects: 2 });
    assert.equal(safety.snapshot().admission, "open");
    safety.latchUncertainty(effect("a"));
    safety.latchUncertainty({ ...effect("a"), firstObservedAt: "t2" });
    const snapshot = safety.snapshot();
    assert.deepEqual([snapshot.admission, snapshot.reviewRequired, snapshot.uncertainEffects.length, snapshot.uncertainEffects[0]!.firstObservedAt], ["closed", true, 1, "t1"]);
    assert.equal(typeof (safety as unknown as Record<string, unknown>).clear, "undefined");
  });

  it("fails closed instead of dropping evidence beyond its bound", () => {
    const safety = new ExecutionSafety({ epochId: "e", maximumEffects: 2 });
    for (const id of ["a", "b", "c"]) safety.latchUncertainty(effect(id));
    const snapshot = safety.snapshot();
    assert.equal(snapshot.uncertainEffects.length, 2);
    assert.equal(snapshot.requiredEvidenceFailed, true);
    assert.equal(snapshot.reviewRequired, true);
  });

  it("returns immutable snapshots that later changes do not alter", () => {
    const safety = new ExecutionSafety({ epochId: "e", maximumEffects: 2 });
    const before = safety.snapshot();
    safety.latchUncertainty(effect("a"));
    assert.equal(before.uncertainEffects.length, 0);
    assert.ok(Object.isFrozen(before) && Object.isFrozen(before.uncertainEffects));
    assert.throws(() => (before as { reviewRequired: boolean }).reviewRequired = true);
  });

  it("seals once; mutation afterwards is an invariant violation", () => {
    const safety = new ExecutionSafety({ epochId: "e", maximumEffects: 2 });
    safety.noteCommitted();
    const sealed = safety.seal();
    assert.equal(safety.seal(), sealed);
    assert.deepEqual([sealed.sealed, sealed.reviewRequired, sealed.committedEffects], [true, false, 1]);
    assert.ok(certifiesClean(sealed, "e"));
    assert.ok(!certifiesClean(sealed, "another epoch"));
    assert.throws(() => safety.latchUncertainty(effect("a")), SealedSafetyError);
    assert.throws(() => safety.markRequiredEvidenceFailure(), SealedSafetyError);
    assert.throws(() => safety.noteCommitted(), SealedSafetyError);
  });

  it("never certifies an unsealed, uncertain, incompletely evidenced, or epoch-less assessment", () => {
    const unsealed = new ExecutionSafety({ epochId: "e", maximumEffects: 2 });
    assert.ok(!certifiesClean(unsealed.provisional(), "e"));
    assert.equal(unsealed.provisional().reviewRequired, true);
    const uncertain = new ExecutionSafety({ epochId: "e", maximumEffects: 2 });
    uncertain.latchUncertainty(effect("a"));
    assert.ok(!certifiesClean(uncertain.seal(), "e"));
    const evidence = new ExecutionSafety({ epochId: "e", maximumEffects: 2 });
    evidence.markRequiredEvidenceFailure();
    assert.ok(!certifiesClean(evidence.seal(), "e"));
    assert.ok(!certifiesClean(noEpochAssessment(false), "none"));
  });
});
