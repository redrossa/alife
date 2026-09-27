import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadConfig } from "../../src/config/resolve.ts";
import type { SignalResult, WorldStopResult } from "../../src/core/contracts.ts";
import { certifiesClean } from "../../src/core/execution-safety.ts";
import { startRun } from "../../src/operator/run.ts";
import { prepareStateDir } from "../../src/operator/state-dir.ts";
import { readCheckpoint } from "../../src/records/checkpoint.ts";
import { type WorldEventType, readEventLog } from "../../src/records/events.ts";
import { analyzeRun } from "../../src/records/finalize.ts";
import { runPaths } from "../../src/records/run-store.ts";
import { SIGNAL_SCRIPT } from "../../src/world/jobs.ts";
import { EngineResponseError } from "../../src/world/engine.ts";
import { variant } from "../support/config.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { FakeStream, frame } from "../support/fake-exec.ts";
import { offlineWorld } from "../support/offline-world.ts";

// Fixed acceptance gate for L1. No Docker, sleeps, private-state inspection, or
// implementation changes. The real backend/control transport/JobTable run over
// OfflineEngine. World record acknowledgements are in memory so, after the
// engine-stop event, draining one event-loop turn deterministically exhausts
// all runnable work. Held promises are the ONLY outstanding work in that phase.
// Full-run cases below additionally use the real run recorder and checkpoints.

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("acceptance barrier did not complete within 5 seconds")), 5_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const observe = <T>(promise: Promise<T>) => promise.then(
  (value) => ({ ok: true as const, value }),
  (error: unknown) => ({ ok: false as const, error }),
);

type Write = { type: WorldEventType; data: Readonly<Record<string, unknown>>; completed: boolean };
type Phase = "request record" | "exec creation" | "start response" | "outcome record";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "alife-signal-acceptance-"));
  const layout = await prepareStateDir(root);
  const clock = new FakeClock();
  const writes: Write[] = [];
  let hook: ((write: Write) => Promise<void> | void) | null = null;
  const offline = await offlineWorld(layout, clock, {
    wrapLog(log) {
      log.append = async (type, data) => {
        const write = { type, data, completed: false };
        writes.push(write);
        await hook?.(write);
        write.completed = true;
        return writes.length;
      };
    },
  });
  const stopped = gate();
  offline.engine.onStop = stopped.open;
  const releases: (() => void)[] = [];
  const work: Promise<unknown>[] = [];
  const signalExecs = () => [...offline.engine.execs.values()].filter((exec) => exec.kind === "signal");
  const signalStarts = () => signalExecs().reduce((n, exec) => n + exec.starts, 0);
  return {
    ...offline, root, layout, clock, writes, stopped, releases, work, signalExecs, signalStarts,
    setHook(next: typeof hook) { hook = next; },
    async startJob() {
      await offline.world.start();
      const job = await offline.world.submit({ actionId: "a", command: "sleep 100" }, { prepared: async () => {} });
      assert.equal(job.state, "running");
    },
    async dispose() {
      for (const release of releases) release();
      try {
        await within(Promise.allSettled(work));
      } finally {
        hook = null;
        try { await within(offline.world.close()); }
        finally { await rm(root, { recursive: true, force: true }); }
      }
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Hold one signal at the selected externally observable effect/evidence boundary. */
function holdSignal(f: Fixture, phase: Phase, rejectEvidence = false) {
  const reached = gate();
  const release = gate();
  f.releases.push(release.open, reached.open);
  const pause = async () => { reached.open(); await release.promise; };
  f.setHook(async (write) => {
    if ((phase === "request record" && write.type === "job.signal_requested") ||
        (phase === "outcome record" && write.type === "job.signalled")) await pause();
    const failureType = phase === "request record" ? "job.signal_requested" : "job.signalled";
    if (rejectEvidence && write.type === failureType) throw new Error("injected required signal evidence failure");
  });
  if (phase === "exec creation") {
    const post = f.engine.post.bind(f.engine);
    f.engine.post = (route, options = {}) => {
      const result = post(route, options);
      const cmd = (options.body as { Cmd?: string[] } | undefined)?.Cmd;
      return route.endsWith("/exec") && cmd?.includes(SIGNAL_SCRIPT) === true
        ? pause().then(() => result)
        : result;
    };
  }
  if (phase === "start response") {
    const hijack = f.engine.hijack.bind(f.engine);
    f.engine.hijack = (route) => {
      // Invoke the transport BEFORE holding its response: the effect is committed.
      const result = hijack(route);
      const id = /^\/exec\/([^/]+)\/start$/.exec(route)?.[1];
      return id !== undefined && f.engine.execs.get(id)?.kind === "signal"
        ? pause().then(() => result)
        : result;
    };
  }
  return { reached: reached.promise, release: release.open };
}

function stopObserved(f: Fixture) {
  let returned = false;
  const result = f.world.stop("operator_stop");
  f.work.push(observe(result));
  void result.then(() => { returned = true; }, () => { returned = true; });
  return { result, returned: () => returned };
}

function assertNoLateWrites(f: Fixture, count: number) {
  assert.equal(f.writes.length, count, "no required epoch record may start after the receipt was returned");
}

for (const origin of ["agent", "operator"] as const) {
  describe(`L1 ${origin} signal shutdown acceptance`, () => {
    for (const phase of ["request record", "exec creation", "start response", "outcome record"] as const) {
      for (const rejectEvidence of [false, true]) {
        it(`drains ${phase}; required evidence ${rejectEvidence ? "rejects" : "succeeds"}`, async () => {
          const f = await fixture();
          try {
            await f.startJob();
            const held = holdSignal(f, phase, rejectEvidence);
            const signal = observe(f.world.signalJob("a", "TERM", origin));
            f.work.push(signal);
            await within(held.reached);
            const stopping = stopObserved(f);
            // A pending signal record/response must NOT delay the actual engine stop.
            await within(f.stopped.promise);
            await turn();
            assert.equal(f.engine.container?.running ?? false, false);
            assert.equal(stopping.returned(), false, "stop must not return/seal while required signal work is unresolved");
            held.release();
            const signalResult = await within(signal);
            const receipt = await within(stopping.result);
            assert.equal(receipt.verified, true);
            assert.equal(receipt.safety.sealed, true);
            if (rejectEvidence) {
              assert.equal(receipt.safety.reviewRequired, true);
              assert.equal(receipt.safety.requiredEvidenceFailed, true);
              assert.equal(certifiesClean(receipt.safety, receipt.safety.epochId), false);
            } else {
              assert.equal(signalResult.ok, true, "successful evidence must return the known signal outcome");
              if (signalResult.ok) assert.equal(signalResult.value.delivered, phase === "start response" || phase === "outcome record");
              assert.equal(certifiesClean(receipt.safety, receipt.safety.epochId), true,
                "known withdrawal or a recorded signal outcome must not itself taint the epoch");
              const outcomes = f.writes.filter((write) => write.type === "job.signalled" && write.completed);
              assert.equal(outcomes.length, 1, "each admitted signal request needs one terminal outcome");
              if (phase === "request record" || phase === "exec creation") assert.equal(outcomes[0]!.data.delivered, false);
            }
            assert.equal(f.signalStarts(), phase === "request record" || phase === "exec creation" ? 0 : 1,
              "uncommitted signals are withdrawn; already committed signals are never replayed");
            const count = f.writes.length;
            const retained = JSON.stringify(receipt);
            await turn();
            assertNoLateWrites(f, count);
            assert.equal(JSON.stringify(receipt), retained);
            if (rejectEvidence) {
              const again = await f.world.stop("operator_stop");
              assert.equal(again.safety.reviewRequired, true, "a second stop must retain the evidence failure");
            }
          } finally { await f.dispose(); }
        });
      }
    }

    it("refuses a new signal immediately after stop entry, before the engine stop is committed", async () => {
      const f = await fixture();
      const entered = gate();
      const release = gate();
      f.releases.push(release.open);
      try {
        await f.startJob();
        f.setHook(async (write) => {
          if (write.type === "world.stopping") { entered.open(); await release.promise; }
        });
        const stopping = stopObserved(f);
        await within(entered.promise);
        const signal = observe(f.world.signalJob("a", "TERM", origin));
        f.work.push(signal);
        const result = await within(signal);
        if (result.ok) assert.equal(result.value.delivered, false);
        assert.equal(f.signalStarts(), 0, "operator attribution must not bypass shutdown admission closure");
        release.open();
        const receipt = await within(stopping.result);
        assert.equal(certifiesClean(receipt.safety, receipt.safety.epochId), true);
      } finally { await f.dispose(); }
    });
  });
}

describe("L1 operation inventory and positive controls", () => {
  for (const identical of [false, true]) {
    it(`settles both ${identical ? "identical" : "mixed-origin"} simultaneous signals to the same job; finishing one does not release the other`, async () => {
      const f = await fixture();
      const reached = [gate(), gate()];
      const release = [gate(), gate()];
      f.releases.push(...release.map((entry) => entry.open));
      try {
        await f.startJob();
        const hijack = f.engine.hijack.bind(f.engine);
        let signalNumber = 0;
        f.engine.hijack = (route) => {
          const result = hijack(route);
          const id = /^\/exec\/([^/]+)\/start$/.exec(route)?.[1];
          if (id === undefined || f.engine.execs.get(id)?.kind !== "signal") return result;
          const n = signalNumber++;
          reached[n]!.open();
          return release[n]!.promise.then(() => result);
        };
        const secondSignal = identical ? "TERM" : "INT";
        const secondOrigin = identical ? "agent" : "operator";
        const a = observe(f.world.signalJob("a", "TERM", "agent"));
        const b = observe(f.world.signalJob("a", secondSignal, secondOrigin));
        f.work.push(a, b);
        await within(Promise.all(reached.map((entry) => entry.promise)));
        const stopping = stopObserved(f);
        await within(f.stopped.promise);
        release[0]!.open();
        const aResult = await within(a);
        assert.equal(aResult.ok, true);
        if (aResult.ok) assert.deepEqual([aResult.value.jobId, aResult.value.signal, aResult.value.delivered], ["a", "TERM", true]);
        await turn();
        assert.equal(stopping.returned(), false, "one remaining operation still owns required evidence");
        release[1]!.open();
        const bResult = await within(b);
        assert.equal(bResult.ok, true);
        if (bResult.ok) assert.deepEqual([bResult.value.jobId, bResult.value.signal, bResult.value.delivered], ["a", secondSignal, true]);
        const receipt = await within(stopping.result);
        assert.equal(certifiesClean(receipt.safety, receipt.safety.epochId), true);
        assert.deepEqual(f.writes.filter((write) => write.type === "job.signalled" && write.completed)
          .map((write) => [write.data.jobId, write.data.signal, write.data.requestedBy]).sort(),
        [["a", "TERM", "agent"], ["a", secondSignal, secondOrigin]].sort());
        assert.equal(f.signalStarts(), 2);
      } finally { await f.dispose(); }
    });
  }

  it("coalesces concurrent stops without sealing over a held signal outcome", async () => {
    const f = await fixture();
    try {
      await f.startJob();
      const held = holdSignal(f, "outcome record", true);
      const signal = observe(f.world.signalJob("a", "TERM", "operator"));
      f.work.push(signal);
      await within(held.reached);
      const first = f.world.stop("operator_stop");
      const second = f.world.stop("operator_stop");
      f.work.push(observe(first), observe(second));
      assert.equal(first, second);
      let returned = false;
      void first.then(() => { returned = true; }, () => { returned = true; });
      await within(f.stopped.promise);
      await turn();
      assert.equal(returned, false, "coalesced stop still waits for the same pending evidence");
      held.release();
      await within(signal);
      const [a, b] = await within(Promise.all([first, second]));
      assert.equal(a, b);
      assert.equal(a.safety.reviewRequired, true);
      assert.equal(a.safety.requiredEvidenceFailed, true);
    } finally { await f.dispose(); }
  });

  it("a failed stop and later retry retain ownership of the pending signal evidence", async () => {
    const f = await fixture();
    try {
      await f.startJob();
      const held = holdSignal(f, "start response", true);
      const signal = observe(f.world.signalJob("a", "TERM", "operator"));
      f.work.push(signal);
      await within(held.reached);
      f.engine.stopError = new Error("injected stop failure");
      const first = f.world.stop("operator_stop");
      f.work.push(observe(first));
      const failed = await within(first);
      assert.equal(failed.verified, false);
      assert.equal(failed.safety.sealed, false);
      assert.equal(failed.safety.reviewRequired, true);
      const retryCommitted = gate();
      f.engine.onStop = retryCommitted.open;
      f.engine.stopError = null;
      const retry = stopObserved(f);
      await within(retryCommitted.promise);
      await turn();
      assert.equal(retry.returned(), false, "retry must not forget work admitted before the first stop");
      held.release();
      await within(signal);
      const receipt = await within(retry.result);
      assert.equal(receipt.verified, true);
      assert.equal(receipt.safety.requiredEvidenceFailed, true);
      assert.equal(receipt.safety.reviewRequired, true);
      assert.equal(f.signalStarts(), 1);
    } finally { await f.dispose(); }
  });

  for (const origin of ["agent", "operator"] as const) {
    it(`normal ${origin} signal followed by a clean stop remains clean`, async () => {
      const f = await fixture();
      try {
        await f.startJob();
        const signal = await f.world.signalJob("a", "TERM", origin);
        assert.equal(signal.delivered, true);
        const receipt = await f.world.stop("operator_stop");
        assert.equal(certifiesClean(receipt.safety, receipt.safety.epochId), true);
        assert.equal(f.signalStarts(), 1);
        assert.equal(f.writes.filter((write) => write.type === "job.signalled" && write.completed).length, 1);
      } finally { await f.dispose(); }
    });
  }

  it("an explicit operator signal remains available before shutdown in an already review-required epoch", async () => {
    const f = await fixture();
    try {
      await f.startJob();
      f.engine.forget(1);
      await f.world.refreshJobSafety();
      assert.equal(f.world.safety()!.reviewRequired, true);
      const agent = await f.world.signalJob("a", "TERM", "agent");
      assert.equal(agent.delivered, false);
      assert.equal(f.signalStarts(), 0);
      const operator = await f.world.signalJob("a", "TERM", "operator");
      assert.equal(operator.delivered, true);
      assert.equal(f.signalStarts(), 1);
      const receipt = await f.world.stop("operator_stop");
      assert.equal(receipt.safety.reviewRequired, true);
      assert.deepEqual(receipt.safety.uncertainEffects.map((effect) => effect.jobId), ["a"]);
    } finally { await f.dispose(); }
  });
});

describe("L1 known signal refusals remain accounted and clean", () => {
  for (const origin of ["agent", "operator"] as const) {
    for (const stage of ["create", "start"] as const) {
      it(`${origin}: explicit engine refusal at ${stage} records a known non-effect`, async () => {
        const f = await fixture();
        try {
          await f.startJob();
          const post = f.engine.post.bind(f.engine);
          f.engine.post = (route, options = {}) => {
            const cmd = (options.body as { Cmd?: string[] } | undefined)?.Cmd;
            return stage === "create" && route.endsWith("/exec") && cmd?.includes(SIGNAL_SCRIPT) === true
              ? Promise.reject(new EngineResponseError(403, "explicit signal exec creation refusal"))
              : post(route, options);
          };
          const hijack = f.engine.hijack.bind(f.engine);
          f.engine.hijack = (route) => {
            const id = /^\/exec\/([^/]+)\/start$/.exec(route)?.[1];
            return stage === "start" && id !== undefined && f.engine.execs.get(id)?.kind === "signal"
              ? Promise.reject(new EngineResponseError(403, "explicit signal start refusal"))
              : hijack(route);
          };
          const signal = observe(f.world.signalJob("a", "TERM", origin));
          f.work.push(signal);
          const outcome = await within(signal);
          assert.equal(outcome.ok, true, "known refusal should return a recorded not-delivered result");
          if (outcome.ok) assert.equal(outcome.value.delivered, false);
          assert.equal(f.signalStarts(), 0);
          const writes = f.writes.filter((write) => write.type === "job.signalled" && write.completed);
          assert.equal(writes.length, 1);
          assert.deepEqual([writes[0]!.data.jobId, writes[0]!.data.signal, writes[0]!.data.requestedBy, writes[0]!.data.delivered],
            ["a", "TERM", origin, false]);
          const stopped = await within(f.world.stop("operator_stop"));
          assert.equal(certifiesClean(stopped.safety, stopped.safety.epochId), true,
            "a trustworthy refusal plus complete evidence is not an unknown effect");
        } finally { await f.dispose(); }
      });
    }
  }
});

describe("L1 unknown committed signal outcomes cannot certify clean", () => {
  for (const origin of ["agent", "operator"] as const) {
    for (const failure of ["lost start response", "inspection timeout", "unreadable result"] as const) {
      it(`${origin}: ${failure}`, async () => {
        const f = await fixture();
        try {
          await f.startJob();
          const hijack = f.engine.hijack.bind(f.engine);
          f.engine.hijack = (route) => {
            const id = /^\/exec\/([^/]+)\/start$/.exec(route)?.[1];
            const exec = id === undefined ? undefined : f.engine.execs.get(id);
            if (exec?.kind !== "signal") return hijack(route);
            if (failure === "unreadable result") {
              f.engine.calls.push(`HIJACK ${route}`);
              exec.starts += 1;
              exec.running = false;
              exec.exitCode = 0;
              const stream = new FakeStream();
              exec.stream = stream;
              stream.emit(frame("stdout", "not a signal delivery result"));
              stream.finish("eof");
              return Promise.resolve(stream);
            }
            const result = hijack(route);
            return failure === "lost start response"
              ? result.then(() => { throw new Error("signal start response lost after commitment"); })
              : result;
          };
          if (failure === "inspection timeout") {
            const get = f.engine.get.bind(f.engine);
            f.engine.get = (route) => {
              const id = /^\/exec\/([^/]+)\/json$/.exec(route)?.[1];
              return id !== undefined && f.engine.execs.get(id)?.kind === "signal"
                ? Promise.resolve({ Running: true, ExitCode: null })
                : get(route);
            };
          }
          const signal = observe(f.world.signalJob("a", "TERM", origin));
          f.work.push(signal);
          await within(signal);
          assert.equal(f.signalStarts(), 1, "the signal crossed its commitment boundary exactly once");
          const stopped = await within(f.world.stop("operator_stop"));
          assert.equal(stopped.verified, true);
          assert.equal(stopped.safety.reviewRequired, true, "unknown delivery is not a known no-op merely because recording succeeded");
          assert.equal(certifiesClean(stopped.safety, stopped.safety.epochId), false);
          assert.equal((await f.world.stop("operator_stop")).safety.reviewRequired, true);
        } finally { await f.dispose(); }
      });
    }
  }
});

describe("L1 full-run checkpoint acceptance", () => {
  for (const rejectEvidence of [false, true]) {
    it(`held signal evidence ${rejectEvidence ? "failure forbids" : "success permits"} a clean checkpoint`, async () => {
      const f = await fixture();
      const configFile = await variant((config) => { config.operator.maximumTicks = 2; });
      await writeFile(path.join(path.dirname(configFile), "fake-script.json"), JSON.stringify({
        schemaVersion: 1, turns: [{ type: "shell", command: "sleep 100" }, { type: "wait" }],
      }));
      let signal: ReturnType<typeof observe<SignalResult>> | undefined;
      try {
        const loaded = await loadConfig(configFile);
        assert.equal(loaded.ok, true);
        if (!loaded.ok) throw new Error("invalid fixture");
        const held = holdSignal(f, "start response", rejectEvidence);
        const stop = f.world.stop.bind(f.world);
        let receipt: WorldStopResult | undefined;
        f.world.stop = async (reason) => {
          await held.reached; // Arrange the actual backend stop at the intended boundary.
          receipt = await stop(reason);
          return receipt;
        };
        const run = startRun({
          layout: f.layout, resolved: loaded.resolved, worldId: f.worldId, clock: f.clock,
          signal: new AbortController().signal, allowPrivilegedHelper: false,
          openWorld: () => Promise.resolve(f.world), hostFreeMiB: () => Promise.resolve(1_000_000),
          onTick(report) {
            if (report.tick === 1) {
              const actionId = f.writes.find((write) => write.type === "job.prepared")!.data.jobId as string;
              signal = observe(f.world.signalJob(actionId, "TERM", "operator"));
              f.work.push(signal);
            }
          },
        });
        f.work.push(observe(run));
        await within(f.stopped.promise);
        await turn();
        // Capture prematurity, but release and finish the full run before asserting its evidence.
        const sealedEarly = receipt !== undefined;
        held.release();
        assert.ok(signal);
        const signalResult = await within(signal);
        if (!rejectEvidence) {
          assert.equal(signalResult.ok, true);
          if (signalResult.ok) assert.equal(signalResult.value.delivered, true);
        }
        const result = await within(run);
        const paths = runPaths(f.layout, result.runId);
        const events = await readEventLog(paths.events);
        const analysis = await analyzeRun(paths, result.runId);
        assert.deepEqual(events.issues, []);
        assert.deepEqual([result.attemptedCalls, result.respondedCalls], [2, 2]);
        if (rejectEvidence) {
          assert.equal(result.state, "recovery_required", "failed signal evidence must not commit a clean run");
          assert.equal(result.checkpointSha256, null);
          assert.deepEqual(await readdir(paths.checkpoints), []);
          assert.ok(!events.events.some((event) => event.type === "checkpoint.written" || event.type === "run.completed"));
          assert.equal(analysis.state, "recovery_required");
          assert.equal(result.worldStop!.safety.requiredEvidenceFailed, true);
        } else {
          assert.equal(result.state, "completed");
          assert.ok(result.checkpointSha256);
          const checkpoint = await readCheckpoint(paths, result.checkpointSha256);
          assert.equal(checkpoint.safety.reviewRequired, false);
          assert.equal(analysis.state, "completed");
        }
        assert.equal(sealedEarly, false, "the backend assessment preceded the signal's required evidence");
      } finally {
        await f.dispose();
        await rm(path.dirname(configFile), { recursive: true, force: true });
      }
    });
  }
});
