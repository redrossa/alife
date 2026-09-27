import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { WorldStopResult } from "../../src/core/contracts.ts";
import { DispatchRefusedError } from "../../src/core/dispatch.ts";
import { prepareStateDir } from "../../src/operator/state-dir.ts";
import type { WorldEventType } from "../../src/records/events.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { offlineWorld, type OfflineWorld } from "../support/offline-world.ts";

// L2 acceptance gate: real DockerWorld/JobTable/safety, in-memory engine only.
// A successful startup is not a refused startup merely because no job ran.
async function fixture(run: (offline: OfflineWorld, logging: { reject: WorldEventType | null }) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "alife-epoch-restart-"));
  const logging: { reject: WorldEventType | null } = { reject: null };
  let offline: OfflineWorld | undefined;
  try {
    offline = await offlineWorld(await prepareStateDir(root), new FakeClock(), {
      wrapLog: (log) => {
        const append = log.append.bind(log);
        log.append = (type, data, options) =>
          type === logging.reject ? Promise.reject(new Error(`injected evidence failure: ${type}`)) : append(type, data, options);
      },
    });
    await run(offline, logging);
  } finally {
    logging.reject = null;
    try {
      if (offline !== undefined) {
        offline.engine.stopError = null;
        try {
          await offline.world.stop("operator_stop");
        } finally {
          await offline.world.close();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function effectCalls(offline: OfflineWorld): string[] {
  // Include container AND exec creation/start, including startup probes.
  return offline.engine.calls.filter((call) =>
    call === "POST /containers/create" || /^(POST|HIJACK) .*\/(exec|start)$/.test(call),
  );
}

async function assertRestartBlocked(offline: OfflineWorld, receipt: WorldStopResult) {
  const oldReceipt = structuredClone(receipt);
  const oldSafety = structuredClone(offline.world.safety());
  const before = effectCalls(offline);
  const rejected = await offline.world.start().then(() => false, () => true);
  assert.deepEqual(
    { rejected, effects: effectCalls(offline), safety: offline.world.safety(), receipt },
    { rejected: true, effects: before, safety: oldSafety, receipt: oldReceipt },
    "restart must reject without engine create/start, epoch replacement, or rewriting the predecessor receipt",
  );
}

function assertClean(receipt: WorldStopResult) {
  assert.deepEqual(
    [receipt.verified, receipt.recorded, receipt.safety.sealed, receipt.safety.reviewRequired, receipt.safety.requiredEvidenceFailed],
    [true, true, true, false, false],
  );
}

describe("L2 same-controller epoch restart acceptance", () => {
  for (const event of ["world.stopping", "world.stopped", "world.container_removed"] as const) {
    for (const recovery of ["restore logging", "restore logging and repeat stop"] as const) {
      it(`zero-job successful epoch: rejected ${event} blocks restart after ${recovery}`, async () => {
        await fixture(async (offline, logging) => {
          await offline.world.start();
          const epoch = offline.world.safety()!.epochId;
          assert.deepEqual(offline.engine.jobs(), []);
          logging.reject = event;
          const stopped = await offline.world.stop("operator_stop");
          assert.deepEqual(
            [stopped.verified, stopped.recorded, stopped.safety.sealed, stopped.safety.requiredEvidenceFailed, stopped.safety.reviewRequired, stopped.safety.committedEffects],
            [true, false, true, true, true, 0],
          );
          assert.equal(stopped.safety.epochId, epoch);
          assert.equal(offline.engine.container, null);
          const old = structuredClone(stopped);
          logging.reject = null;
          if (recovery === "restore logging and repeat stop") {
            const repeated = await offline.world.stop("operator_stop");
            assert.equal(repeated.verified, true);
            assert.deepEqual(repeated.safety, old.safety);
            assert.deepEqual(stopped, old);
          }
          await assertRestartBlocked(offline, stopped);
        });
      });
    }
  }

  it("successful epoch with denied preparation and zero actual job starts cannot discard failed evidence on restart", async () => {
    await fixture(async (offline) => {
      await offline.world.start();
      await assert.rejects(offline.world.submit({ actionId: "denied", command: "true" }, {
        prepared: () => Promise.reject(new Error("required preparation evidence rejected")),
      }), DispatchRefusedError);
      assert.deepEqual(offline.engine.jobs().map((job) => job.starts), [0]);
      assert.equal(offline.world.safety()!.committedEffects, 0);
      const stopped = await offline.world.stop("operator_stop");
      assert.deepEqual(
        [stopped.verified, stopped.safety.sealed, stopped.safety.requiredEvidenceFailed, stopped.safety.reviewRequired],
        [true, true, true, true],
      );
      await assertRestartBlocked(offline, stopped);
    });
  });

  for (const failure of ["stop request rejected", "stop returned but container still running"] as const) {
    it(`zero-job successful epoch: ${failure} blocks restart without replacing safety`, async () => {
      await fixture(async (offline) => {
        await offline.world.start();
        const post = offline.engine.post.bind(offline.engine);
        if (failure === "stop request rejected") offline.engine.stopError = new Error("injected stop failure");
        else {
          offline.engine.post = (route, options) => {
            if (route.endsWith("/stop")) {
              offline.engine.calls.push(`POST ${route}`);
              return Promise.resolve(null);
            }
            return post(route, options);
          };
        }
        try {
          const stopped = await offline.world.stop("operator_stop");
          assert.deepEqual([stopped.verified, stopped.safety.sealed, stopped.safety.reviewRequired, stopped.safety.committedEffects], [false, false, true, 0]);
          assert.equal(offline.engine.container?.running, true);
          assert.deepEqual(offline.engine.jobs(), []);
          await assertRestartBlocked(offline, stopped);
        } finally {
          offline.engine.post = post;
          offline.engine.stopError = null;
        }
      });
    });
  }

  for (const jobState of ["zero jobs", "completed job", "running job"] as const) {
    it(`clean successful epoch with ${jobState} permits a new epoch and preserves the old receipt`, async () => {
      await fixture(async (offline) => {
        await offline.world.start();
        if (jobState !== "zero jobs") {
          const job = await offline.world.submit({ actionId: "one", command: "sleep 100" }, { prepared: () => Promise.resolve() });
          assert.equal(job.state, "running");
          if (jobState === "completed job") {
            offline.engine.finishJob(1, 0);
            await offline.world.refreshJobSafety();
            assert.equal((await offline.world.inspectJob("one")).state, "exited");
          }
        }
        const stopped = await offline.world.stop("operator_stop");
        assertClean(stopped);
        assert.equal(stopped.safety.committedEffects, jobState === "zero jobs" ? 0 : 1);
        const old = structuredClone(stopped);
        const creates = effectCalls(offline).filter((call) => call === "POST /containers/create").length;
        await offline.world.start();
        assert.notEqual(offline.world.safety()!.epochId, old.safety.epochId);
        assert.equal(offline.world.safety()!.reviewRequired, false);
        assert.equal(offline.world.safety()!.committedEffects, 0);
        assert.equal(offline.engine.container?.running, true);
        assert.equal(effectCalls(offline).filter((call) => call === "POST /containers/create").length, creates + 1);
        assert.deepEqual(stopped, old);
        assertClean(await offline.world.stop("operator_stop"));
        assert.deepEqual(stopped, old);
      });
    });
  }

  for (const failure of ["cleanup evidence rejected", "cleanup stop unverified"] as const) {
    it(`a refused startup is not a retry exemption when ${failure}`, async () => {
      await fixture(async (offline, logging) => {
        const post = offline.engine.post.bind(offline.engine);
        offline.engine.post = (route, options) => {
          if (/^\/containers\/[^/]+\/start$/.test(route)) {
            offline.engine.calls.push(`POST ${route}`);
            return Promise.reject(new Error("startup refused before execution"));
          }
          return post(route, options);
        };
        if (failure === "cleanup evidence rejected") logging.reject = "world.stopped";
        else offline.engine.stopError = new Error("cleanup stop unavailable");
        try {
          await assert.rejects(offline.world.start());
        } finally {
          offline.engine.post = post;
          logging.reject = null;
          offline.engine.stopError = null;
        }
        assert.equal(offline.engine.execs.size, 0);
        const cleanup = offline.world.startCleanup;
        assert.ok(cleanup);
        assert.equal(cleanup.safety.reviewRequired, true);
        if (failure === "cleanup evidence rejected") assert.equal(cleanup.recorded, false);
        else assert.equal(cleanup.verified, false);
        await assertRestartBlocked(offline, cleanup);
      });
    });
  }

  it("genuinely refused pre-execution container start with verified recorded cleanup may retry", async () => {
    await fixture(async (offline) => {
      const post = offline.engine.post.bind(offline.engine);
      offline.engine.post = (route, options) => {
        if (/^\/containers\/[^/]+\/start$/.test(route)) {
          offline.engine.calls.push(`POST ${route}`);
          return Promise.reject(new Error("transient startup refusal before execution"));
        }
        return post(route, options);
      };
      try {
        await assert.rejects(offline.world.start());
      } finally {
        offline.engine.post = post;
      }
      assert.equal(offline.engine.execs.size, 0);
      assert.equal(offline.engine.container, null);
      const cleanup = offline.world.startCleanup;
      assert.ok(cleanup);
      assertClean(cleanup);
      assert.equal(cleanup.safety.committedEffects, 0);
      const old = structuredClone(cleanup);
      await offline.world.start();
      assert.notEqual(offline.world.safety()!.epochId, old.safety.epochId);
      assert.equal(offline.world.safety()!.reviewRequired, false);
      assert.equal((await offline.world.inspect()).container, "running");
      assert.deepEqual(offline.engine.jobs(), []);
      assert.deepEqual(cleanup, old);
      assertClean(await offline.world.stop("operator_stop"));
      assert.deepEqual(cleanup, old);
    });
  });
});
