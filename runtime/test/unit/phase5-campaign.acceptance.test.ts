import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { assertBlocked, CAMPAIGN_ID, fixture, reservation, RUN_B } from "../support/phase5-campaign.ts";

// Generic fixture limits are intentionally small. The integration campaign alone is $100.
test("campaign: explicit creation initializes a private empty budget", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  assert.deepEqual(await owner.snapshot(), { campaignId: CAMPAIGN_ID, limitMicroUsd: 100,
    accountedMicroUsd: 0, outstanding: [], remainingMicroUsd: 100, reviewRequired: false });
});

test("campaign: canonical $100 limit is exactly 100000000 microUSD", async (t) => {
  const f = await fixture(t, { limitMicroUsd: 100_000_000 });
  const owner = await f.create();
  assert.ok(await owner.reserve(reservation(99_999_999)));
  assert.ok(await owner.reserve(reservation(1, 2)));
  assert.equal(await owner.reserve(reservation(1, 3)), null);
  assert.equal((await owner.snapshot()).remainingMicroUsd, 0);
});

test("campaign: reservation is recorded before a synthetic provider effect", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  const request = reservation();
  assert.deepEqual(await owner.reserve(request), request);
  let effects = 0;
  // Observe production bytes, not a fake adapter or monkeypatched filesystem.
  const journal = await readFile(f.files.journal, "utf8");
  assert.ok(journal.endsWith("\n"));
  assert.ok(journal.includes(request.runId) && journal.includes(request.requestId));
  effects++;
  await owner.close();
  assert.deepEqual((await (await f.reopen()).snapshot()).outstanding, [request]);
  assert.equal(effects, 1);
});

test("campaign: different runs/provider-request identities share one aggregate cap", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  const first = reservation(60);
  assert.ok(await owner.reserve(first));
  await owner.settle({ ...first, basis: "usage", chargedMicroUsd: 55 });
  const second = reservation(45, 1, RUN_B);
  assert.ok(await owner.reserve(second));
  assert.equal(await owner.reserve(reservation(1, 2, RUN_B)), null);
  assert.equal((await owner.snapshot()).remainingMicroUsd, 0);
});

test("campaign: inclusive cap and integer arithmetic preserve the final microUSD", async (t) => {
  const f = await fixture(t, { limitMicroUsd: 7 });
  const owner = await f.create();
  for (let tick = 1; tick <= 7; tick++) assert.ok(await owner.reserve(reservation(1, tick)));
  const before = await owner.snapshot();
  assert.equal(before.remainingMicroUsd, 0);
  assert.equal(await owner.reserve(reservation(1, 8)), null);
  assert.deepEqual(await owner.snapshot(), before);
});

test("campaign: unknown completion keeps the entire maximum without refund", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  const request = reservation(70);
  await owner.reserve(request);
  await owner.settle({ ...request, basis: "unknown" });
  await owner.close();
  const state = await (await f.reopen()).snapshot();
  assert.equal(state.accountedMicroUsd, 70);
  assert.equal(state.remainingMicroUsd, 30);
  assert.deepEqual(state.outstanding, []);
});

test("campaign: explicit certain-not-processed evidence releases the maximum", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  const request = reservation(100);
  await owner.reserve(request);
  await owner.settle({ ...request, basis: "not_processed" });
  assert.equal((await owner.snapshot()).accountedMicroUsd, 0);
  assert.equal((await owner.snapshot()).remainingMicroUsd, 100);
  assert.ok(await owner.reserve(reservation(100, 2)));
});

test("campaign: reported usage reconciles exactly and only frees the difference", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  const request = reservation(70);
  await owner.reserve(request);
  await owner.settle({ ...request, basis: "usage", chargedMicroUsd: 31 });
  const state = await owner.snapshot();
  assert.equal(state.accountedMicroUsd, 31);
  assert.equal(state.remainingMicroUsd, 69);
  assert.equal(state.reviewRequired, false);
  assert.ok(await owner.reserve(reservation(69, 2)));
});

test("campaign: over-bound usage is preserved, flags review, and blocks all subsequent admission", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  const request = reservation(20);
  await owner.reserve(request);
  await owner.settle({ ...request, basis: "usage", chargedMicroUsd: 101 });
  const state = await owner.snapshot();
  assert.equal(state.accountedMicroUsd, 101);
  assert.equal(state.reviewRequired, true);
  assert.deepEqual(state.outstanding, []);
  assert.ok(state.remainingMicroUsd <= 0);
  await assertBlocked(owner, reservation(0, 2));
  await owner.close();
  const reopened = await f.reopen();
  assert.deepEqual(await reopened.snapshot(), state);
  await assertBlocked(reopened, reservation(1, 3));
});

test("campaign: over-bound usage blocks admission even when campaign funds remain", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  await owner.reserve(reservation(20));
  await owner.settle({ ...reservation(20), basis: "usage", chargedMicroUsd: 21 });
  const state = await owner.snapshot();
  assert.equal(state.accountedMicroUsd, 21);
  assert.equal(state.remainingMicroUsd, 79);
  assert.equal(state.reviewRequired, true);
  await assertBlocked(owner, reservation(1, 2));
  assert.deepEqual(await owner.snapshot(), state);
});

for (const basis of ["usage", "unknown", "not_processed"] as const) {
  test(`campaign: ${basis} settlement never permits reservation-ID replay after reopening`, async (t) => {
    const f = await fixture(t);
    const owner = await f.create();
    const request = reservation();
    await owner.reserve(request);
    await assert.rejects(() => owner.reserve(request));
    await owner.settle(basis === "usage" ? { ...request, basis, chargedMicroUsd: 10 } : { ...request, basis });
    await assert.rejects(() => owner.reserve(request));
    await owner.close();
    const reopened = await f.reopen();
    const before = await reopened.snapshot();
    await assert.rejects(() => reopened.reserve(request));
    assert.deepEqual(await reopened.snapshot(), before);
  });
}

test("campaign: duplicate or unreserved settlement is refused without refund", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  const request = reservation();
  await owner.reserve(request);
  await owner.settle({ ...request, basis: "unknown" });
  await owner.close();
  const reopened = await f.reopen();
  const before = await reopened.snapshot();
  await assert.rejects(() => reopened.settle({ ...request, basis: "not_processed" }));
  await assert.rejects(() => reopened.settle({ ...reservation(1, 9), basis: "usage", chargedMicroUsd: 0 }));
  assert.deepEqual(await reopened.snapshot(), before);
});

for (const invalid of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`campaign: invalid amount ${String(invalid)} fails creation, reserve, and settlement`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(() => f.api.createCampaign({ ...f.options, directory: path.join(f.root, "invalid-limit"), limitMicroUsd: invalid }));
    await assert.rejects(() => f.api.createCampaign({ ...f.options, directory: path.join(f.root, "invalid-size"), maximumBytes: invalid }));
    const owner = await f.create();
    const request = reservation();
    await owner.reserve(request);
    const before = await owner.snapshot();
    await assert.rejects(() => owner.reserve(reservation(invalid, 2)));
    await assert.rejects(() => owner.settle({ ...request, basis: "usage", chargedMicroUsd: invalid }));
    assert.deepEqual(await owner.snapshot(), before);
  });
}

test("campaign: close/reopen preserves spent and outstanding; absence of evidence never refunds", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  await owner.reserve(reservation(30));
  await owner.settle({ ...reservation(30), basis: "usage", chargedMicroUsd: 25 });
  await owner.reserve(reservation(60, 2));
  const before = await owner.snapshot();
  await owner.close();
  await assert.rejects(() => owner.reserve(reservation(1, 3)));
  const reopened = await f.reopen();
  assert.deepEqual(await reopened.snapshot(), before);
  assert.equal(before.remainingMicroUsd, 15);
  assert.equal(await reopened.reserve(reservation(16, 4)), null);
});

test("campaign: creating an existing campaign refuses without resetting any records", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  await owner.reserve(reservation(90));
  await owner.close();
  const metadata = await readFile(f.files.metadata);
  const journal = await readFile(f.files.journal);
  await assert.rejects(() => f.api.createCampaign({ ...f.options, limitMicroUsd: 1000 }));
  assert.deepEqual(await readFile(f.files.metadata), metadata);
  assert.deepEqual(await readFile(f.files.journal), journal);
  assert.equal((await (await f.reopen()).snapshot()).remainingMicroUsd, 10);
});

test("campaign: opening missing storage never initializes it", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.reopen());
  await assert.rejects(() => stat(f.options.directory), { code: "ENOENT" });
});

for (const damage of ["missing metadata", "missing journal", "corrupt metadata", "corrupt journal", "truncated journal"] as const) {
  test(`campaign: ${damage} fails closed and is not silently repaired`, async (t) => {
    const f = await fixture(t);
    const owner = await f.create();
    await owner.reserve(reservation(80));
    await owner.close();
    const target = damage.includes("metadata") ? f.files.metadata : f.files.journal;
    if (damage.startsWith("missing")) await rm(target);
    else if (damage === "truncated journal") {
      const bytes = await readFile(target);
      await writeFile(target, bytes.subarray(0, bytes.length - 3));
    } else await writeFile(target, "{not-json\n");
    const before = await readFile(target).catch(() => null);
    await assert.rejects(() => f.reopen());
    assert.deepEqual(await readFile(target).catch(() => null), before);
  });
}

test("campaign: caller metadata mismatch refuses without adopting another identity", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  await owner.reserve(reservation());
  await owner.close();
  await assert.rejects(() => f.api.openCampaign({ directory: f.options.directory, campaignId: "other-campaign" }));
  assert.equal((await (await f.reopen()).snapshot()).campaignId, CAMPAIGN_ID);
});

test("campaign: bounded store exhaustion prevents admission and preserves prior outstanding", async (t) => {
  const f = await fixture(t, { maximumBytes: 4096, limitMicroUsd: 10_000_000 });
  const owner = await f.create();
  const first = reservation(1);
  assert.ok(await owner.reserve(first));
  let blocked = false;
  let admittedCount = 1;
  for (let tick = 2; tick <= 4097; tick++) {
    const before = await owner.snapshot();
    assert.ok(before.remainingMicroUsd > 4097, "money exhaustion must not stand in for store exhaustion");
    const outcome = await owner.reserve(reservation(1, tick)).then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    if (outcome.value === null) {
      if (outcome.error !== null) {
        assert.ok(outcome.error instanceof Error);
        assert.match(outcome.error.message, /capacity|limit|full|space/i);
      }
      assert.deepEqual(await owner.snapshot(), before);
      blocked = true;
      break;
    }
    admittedCount++;
  }
  assert.ok(admittedCount > 1, "valid reservations must actually consume store capacity before refusal");
  assert.ok(blocked, "finite byte limit must block further valid positive reservations");
  const state = await owner.snapshot();
  assert.ok(state.outstanding.some((r) => r.requestId === first.requestId));
  assert.equal(state.outstanding.length, admittedCount);
  assert.equal(state.remainingMicroUsd, 10_000_000 - admittedCount);
  let bytes = 0;
  for (const name of await readdir(f.options.directory)) {
    const info = await lstat(path.join(f.options.directory, name));
    if (info.isFile()) bytes += info.size;
  }
  assert.ok(bytes <= 4096, "all regular accounting/control files count against the bounded campaign store");
  await owner.close();
  assert.deepEqual(await (await f.reopen()).snapshot(), state);
});

test("campaign: persisted directory and files are private; broadened metadata permissions refuse", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  assert.equal((await stat(f.options.directory)).mode & 0o777, 0o700);
  for (const name of await readdir(f.options.directory)) {
    const info = await lstat(path.join(f.options.directory, name));
    assert.equal(info.mode & 0o077, 0, `non-private campaign entry ${name}`);
  }
  assert.equal((await stat(f.files.metadata)).mode & 0o777, 0o600);
  assert.equal((await stat(f.files.journal)).mode & 0o777, 0o600);
  await owner.close();
  await chmod(f.files.metadata, 0o644);
  await assert.rejects(() => f.reopen());
});

test("campaign: symlink campaign directory is rejected by create and open", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  await owner.close();
  const alias = path.join(f.root, "alias");
  await symlink(f.options.directory, alias);
  await assert.rejects(() => f.api.openCampaign({ directory: alias, campaignId: CAMPAIGN_ID }));
  await assert.rejects(() => f.api.createCampaign({ ...f.options, directory: alias }));
});

test("campaign: symlink metadata and journal are rejected without changing targets", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  await owner.reserve(reservation());
  await owner.close();
  for (const file of [f.files.metadata, f.files.journal]) {
    const bytes = await readFile(file);
    const target = path.join(f.root, `${path.basename(file)}-target`);
    await writeFile(target, bytes, { mode: 0o600 });
    await rm(file);
    await symlink(target, file);
    await assert.rejects(() => f.reopen());
    assert.deepEqual(await readFile(target), bytes);
    await rm(file);
    await writeFile(file, bytes, { mode: 0o600 });
  }
});

test("campaign: two concurrent owners yield one lifetime owner and never independent caps", async (t) => {
  const f = await fixture(t);
  await (await f.create()).close();
  const attempts = await Promise.allSettled([f.reopen(), f.reopen()]);
  const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  const winner = winners[0];
  assert.ok(winner);
  const owner = winner.value;
  assert.ok(await owner.reserve(reservation(80)));
  await assert.rejects(() => f.reopen());
  await owner.settle({ ...reservation(80), basis: "usage", chargedMicroUsd: 80 });
  await assert.rejects(() => f.reopen());
  await owner.close();
  const next = await f.reopen();
  assert.equal(await next.reserve(reservation(21, 2, RUN_B)), null);
  assert.ok(await next.reserve(reservation(20, 3, RUN_B)));
});

test("campaign: child crash after reservation leaves durable charge and stale ownership; no auto recovery", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await (await f.create()).close();
  const child = fork(new URL("../support/phase5-campaign-child.ts", import.meta.url), [f.options.directory, CAMPAIGN_ID], {
    execArgv: [], env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const completion = once(child, "exit");
  try {
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
  const ready = once(child, "message", { signal: AbortSignal.timeout(5_000) });
  const premature = once(child, "exit").then(() => { throw new Error(`child exited before reservation: ${stderr}`); });
  const [message] = await Promise.race([ready, premature]) as [unknown];
  assert.ok(typeof message === "object" && message !== null && "type" in message && message.type === "reserved");
  const journal = await readFile(f.files.journal);
  assert.ok(journal.toString().includes(reservation(70).requestId));
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  // Neither stale PID detection nor repeated opens authorizes breaking ownership/refunding.
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(() => f.reopen());
  await assert.rejects(() => f.api.createCampaign(f.options));
  assert.deepEqual(await readFile(f.files.journal), journal);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await completion;
  }
});

test("campaign: metadata bytes remain immutable across reserves, settlement, and reopening", async (t) => {
  const f = await fixture(t);
  const owner = await f.create();
  const metadata = await readFile(f.files.metadata);
  await owner.reserve(reservation());
  await owner.settle({ ...reservation(), basis: "usage", chargedMicroUsd: 10 });
  await owner.close();
  await f.reopen();
  assert.deepEqual(await readFile(f.files.metadata), metadata);
});
