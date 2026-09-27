import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { assertStopped, iso, START, watchdogFixture, type WatchdogLease } from "../support/phase4-watchdog.ts";

// Same runWatchdog state machine as the child, without Docker, processes or wall-clock races.
// Deadline = t+3000ms, lease = 1000ms, poll = 100ms. All timestamps are UTC.
describe("Phase 4 deterministic watchdog acceptance", () => {
  it("fixture uses real isolated files, scripted exact-id transport, and cleans up", async () => {
    let directory = "";
    await watchdogFixture(async (f) => {
      directory = f.root;
      assert.deepEqual(JSON.parse(await readFile(f.options.leaseFile, "utf8")), f.lease());
      assert.deepEqual(await f.engine.get("/info"), { ID: f.binding.engineId });
      await f.clock.sleep(100);
      assert.equal(f.clock.now().getTime(), START + 100);
      assert.equal(f.clock.monotonicMs(), 100);
      await assert.rejects(f.engine.get("/containers/successor/json"), /forbidden.*route/);
      assert.equal(f.engine.invariantFailures.length, 1);
      f.engine.invariantFailures.length = 0; // Acknowledge only this deliberate fixture self-test.
    });
    await assert.rejects(access(directory), { code: "ENOENT" });
  });

  it("active initial lease expires without controller participation", async () => {
    await watchdogFixture(async (f) => {
      assertStopped(f, await f.run());
      assert.ok(f.engine.stops()[0]!.elapsed >= 1000);
      assert.ok(f.engine.stops()[0]!.elapsed <= 1100);
      const journal = await f.journal();
      assert.ok(Buffer.byteLength(journal) <= f.options.maximumJournalBytes);
      assert.doesNotMatch(journal, /watchdog-secret-must-not-be-journaled|ALIFE_API_KEY/);
    });
  });

  it("an active lease stays armed while its newly created container is not started yet", async () => {
    await watchdogFixture(async (f) => {
      f.engine.running = false;
      f.clock.onSleep = () => {
        if (f.clock.elapsed === 500) f.engine.running = true;
        return Promise.resolve();
      };
      assertStopped(f, await f.run());
      assert.ok(f.engine.stops()[0]!.elapsed >= 1000, "readiness must protect the later container start, not exit on its initial stopped state");
    });
  });

  it("invalid binding refuses to arm or mutate", async () => {
    await watchdogFixture(async (f) => {
      f.binding.leaseMs = -1;
      const result = await f.run();
      assert.equal(result.outcome, "refused");
      assert.equal(result.verified, false);
      assert.deepEqual(f.engine.stops(), []);
    });
  });

  it("fresh increasing heartbeat extends a live lease, then independently expires", async () => {
    await watchdogFixture(async (f) => {
      f.clock.onSleep = async () => {
        if (f.clock.elapsed === 800) await f.heartbeat({ sequence: 2, issuedAt: iso(800), expiresAt: iso(1800) });
      };
      assertStopped(f, await f.run());
      assert.ok(f.engine.stops()[0]!.elapsed >= 1800);
      assert.ok(f.engine.stops()[0]!.elapsed <= 1900);
    });
  });

  it("a lease that has expired cannot be revived by a late heartbeat during identity verification", async () => {
    await watchdogFixture(async (f) => {
      const get = f.engine.get.bind(f.engine);
      let renewed = false;
      f.engine.get = async (route) => {
        if (!renewed && f.clock.elapsed >= 1000) {
          renewed = true;
          await f.heartbeat({ sequence: 99, issuedAt: iso(f.clock.elapsed), expiresAt: iso(f.clock.elapsed + 1000) });
        }
        return get(route);
      };
      assertStopped(f, await f.run());
      assert.ok(renewed, "fixture reached expiry-time identity verification");
      assert.ok(f.engine.stops()[0]!.elapsed <= 1100, "late renewal cannot reopen an expired lease");
    });
  });

  it("continuous valid renewal never moves the original absolute deadline", async () => {
    await watchdogFixture(async (f) => {
      f.clock.onSleep = async () => {
        const t = f.clock.elapsed;
        await f.heartbeat({ sequence: t + 1, issuedAt: iso(t), expiresAt: iso(t + 1000) });
      };
      assertStopped(f, await f.run());
      assert.ok(f.engine.stops()[0]!.elapsed >= 3000);
      assert.ok(f.engine.stops()[0]!.elapsed <= 3100);
      assert.equal(f.binding.deadline, iso(3000));
    });
  });

  for (const [name, patch] of [
    ["same sequence with later timestamps", { sequence: 1, issuedAt: iso(800), expiresAt: iso(1800) }],
    ["older sequence", { sequence: 0, issuedAt: iso(800), expiresAt: iso(1800) }],
    ["impossible future-issued heartbeat", { sequence: 2, issuedAt: iso(2000), expiresAt: iso(3000) }],
    ["unbounded expiry", { sequence: 2, issuedAt: iso(800), expiresAt: iso(100_000) }],
  ] satisfies [string, Partial<WatchdogLease>][]) {
    it(`${name} cannot extend authority`, async () => {
      await watchdogFixture(async (f) => {
        f.clock.onSleep = async () => { if (f.clock.elapsed === 800) await f.heartbeat(patch); };
        assertStopped(f, await f.run());
        assert.ok(f.engine.stops()[0]!.elapsed <= 1100);
      });
    });
  }

  for (const damage of ["missing", "corrupt", "wrong-token"] as const) {
    it(`${damage} heartbeat fails closed on the bound managed container`, async () => {
      await watchdogFixture(async (f) => {
        f.clock.onSleep = async () => {
          if (f.clock.elapsed !== 500) return;
          if (damage === "missing") await rm(f.options.leaseFile);
          if (damage === "corrupt") await writeFile(f.options.leaseFile, "{broken JSON");
          if (damage === "wrong-token") await f.heartbeat({ controllerToken: "successor-token", sequence: 99, issuedAt: iso(500), expiresAt: iso(1500) });
        };
        assertStopped(f, await f.run());
        assert.ok(f.engine.stops()[0]!.elapsed <= 1100);
      });
    });
  }

  for (const mismatch of ["engine", "world-label", "role-label", "successor-id"] as const) {
    it(`${mismatch} mismatch refuses mutation even with unreadable lease`, async () => {
      await watchdogFixture(async (f) => {
        await writeFile(f.options.leaseFile, "not JSON");
        if (mismatch === "engine") f.engine.engineId = "another-engine";
        if (mismatch === "world-label") f.engine.labels["sh.alife.world"] = "foreign-world";
        if (mismatch === "role-label") f.engine.labels["sh.alife.role"] = "storage";
        if (mismatch === "successor-id") f.engine.inspectedId = "b".repeat(64);
        const result = await f.run();
        assert.equal(result.outcome, "refused");
        assert.equal(result.verified, false);
        assert.equal(f.engine.running, true);
        assert.deepEqual(f.engine.stops(), []);
      });
    });
  }

  for (const mismatch of ["engine", "world-label", "role-label", "successor-id"] as const) {
    it(`revalidates ${mismatch} after arming and before a stop mutation`, async () => {
      await watchdogFixture(async (f) => {
        f.clock.onSleep = () => {
          if (f.clock.elapsed === 500) {
            if (mismatch === "engine") f.engine.engineId = "replacement-engine";
            if (mismatch === "world-label") f.engine.labels["sh.alife.world"] = "foreign-world";
            if (mismatch === "role-label") f.engine.labels["sh.alife.role"] = "storage";
            if (mismatch === "successor-id") f.engine.inspectedId = "b".repeat(64);
          }
          return Promise.resolve();
        };
        const result = await f.run();
        assert.equal(result.outcome, "refused");
        assert.equal(result.verified, false);
        assert.deepEqual(f.engine.stops(), []);
      });
    });
  }

  for (const state of ["stopped", "absent", "running"] as const) {
    it(`matching released heartbeat independently verifies ${state} container`, async () => {
      await watchdogFixture(async (f) => {
        await f.heartbeat({ state: "released" });
        f.engine.running = state === "running";
        f.engine.absent = state === "absent";
        const result = await f.run();
        if (state === "running") assertStopped(f, result);
        else {
          assert.equal(result.outcome, "released");
          assert.equal(result.verified, true);
          assert.deepEqual(f.engine.stops(), []);
          assert.ok(f.engine.calls.some((call) => call.route === "/info"));
          assert.ok(f.engine.calls.some((call) => call.route.endsWith("/json")));
        }
        const calls = structuredClone(f.engine.calls);
        await f.clock.sleep(100);
        assert.deepEqual(f.engine.calls, calls, "finished watcher must not resume or mutate resources");
      });
    });
  }

  it("foreign released epoch cannot abandon the running bound world", async () => {
    await watchdogFixture(async (f) => {
      await f.heartbeat({ state: "released", epochId: "successor-epoch" });
      assertStopped(f, await f.run());
    });
  });

  it("engine outage journals uncertainty, retries at bounded rate, and stops on recovery", async () => {
    await watchdogFixture(async (f) => {
      f.engine.available = false;
      f.clock.onSleep = () => {
        if (f.clock.elapsed >= 1500) f.engine.available = true;
        return Promise.resolve();
      };
      assertStopped(f, await f.run());
      assert.ok(f.engine.stops()[0]!.elapsed >= 1500);
      const attempts = f.engine.calls.filter((call) => call.elapsed < 1500);
      assert.ok(attempts.length >= 2 && attempts.length <= 32);
      assert.match(await f.journal(), /unknown|unavailable|uncertain|retry/i);
    });
  });

  for (const failure of ["engine", "inspect", "stop-no-effect"] as const) {
    it(`cancellation during persistent ${failure} failure is unknown, never clean`, async () => {
      await watchdogFixture(async (f) => {
        if (failure === "engine") f.engine.available = false;
        if (failure === "inspect") f.engine.inspectUnavailable = true;
        if (failure === "stop-no-effect") f.engine.stopMode = "no-effect";
        f.clock.onSleep = () => {
          if (f.clock.elapsed >= 2000) f.abort.abort();
          return Promise.resolve();
        };
        const result = await f.run();
        assert.equal(result.outcome, "unknown");
        assert.equal(result.verified, false);
        assert.equal(f.engine.running, true);
        assert.ok(f.clock.sleeps.length > 0 && f.clock.sleeps.length <= 30);
        assert.ok(f.engine.calls.length <= 100, "failure retry rate is bounded");
      });
    });
  }

  it("lost stop receipt is resolved only by read-only independent verification", async () => {
    await watchdogFixture(async (f) => {
      f.engine.stopMode = "lost-reply";
      assertStopped(f, await f.run());
      assert.equal(f.engine.stops().length, 1, "lost receipt is inspected, not blindly retried");
      assert.equal(f.engine.stops()[0]!.route, `/containers/${f.binding.containerId}/stop`);
    });
  });

  for (const jump of ["backward-utc", "host-sleep", "monotonic-only"] as const) {
    it(`${jump} clock anomaly fails closed instead of renewing`, async () => {
      await watchdogFixture(async (f) => {
        f.clock.onSleep = () => {
          if (f.clock.sleeps.length !== 1) return Promise.resolve();
          if (jump === "backward-utc") f.clock.wall -= 60_000;
          if (jump === "host-sleep") f.clock.wall += 60_000;
          if (jump === "monotonic-only") f.clock.elapsed += 60_000;
          return Promise.resolve();
        };
        assertStopped(f, await f.run());
        assert.ok(f.clock.sleeps.length <= 2, "clock anomaly must not wait out or reset the lease");
      });
    });
  }

  for (const journal of ["rejected", "exhausted"] as const) {
    it(`${journal} separate journal cannot prevent physical stop or alter controller storage`, async () => {
      await watchdogFixture(async (f) => {
        const events = path.join(f.root, "events.jsonl");
        const checkpoint = path.join(f.root, "checkpoint.json");
        await writeFile(events, "controller-events-sentinel\n");
        await writeFile(checkpoint, "controller-checkpoint-sentinel\n");
        if (journal === "rejected") await mkdir(f.options.journalFile);
        else {
          f.options.maximumJournalBytes = 64;
          await writeFile(f.options.journalFile, "x".repeat(64));
        }
        const result = await f.run();
        assert.equal(f.engine.running, false);
        assert.ok(f.engine.stops().length > 0);
        assert.notEqual(result.outcome, "released");
        assert.equal(await readFile(events, "utf8"), "controller-events-sentinel\n");
        assert.equal(await readFile(checkpoint, "utf8"), "controller-checkpoint-sentinel\n");
        if (journal === "exhausted") assert.ok((await readFile(f.options.journalFile)).byteLength <= 64);
      });
    });
  }
});
