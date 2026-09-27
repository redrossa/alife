import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  acquireOwnership,
  inspectOwnership,
  Ownership,
  OwnershipConflictError,
  releaseAbandonedOwnership,
  releaseGuardPath,
  ReleaseInProgressError,
} from "../../src/operator/locks.ts";
import { chooseStateDir, prepareStateDir, REPOSITORY_ROOT, StateDirError } from "../../src/operator/state-dir.ts";
import { FakeClock } from "../support/fake-clock.ts";

const WORLD = "w-20260925T161449Z-abababab";

async function exitedPid(): Promise<number> {
  const exited = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => exited.on("exit", resolve));
  return exited.pid!;
}

async function temp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "alife-operator-"));
}

describe("state directory", () => {
  it("chooses flag, then ALIFE_STATE_DIR, then XDG_STATE_HOME, then home", () => {
    const env = { ALIFE_STATE_DIR: "/a", XDG_STATE_HOME: "/x" };
    assert.deepEqual(chooseStateDir({ flag: "/f", env, home: "/h" }), { path: "/f", source: "flag" });
    assert.deepEqual(chooseStateDir({ env, home: "/h" }), { path: "/a", source: "ALIFE_STATE_DIR" });
    assert.deepEqual(chooseStateDir({ env: { XDG_STATE_HOME: "/x" }, home: "/h" }), { path: "/x/alife", source: "XDG_STATE_HOME" });
    assert.deepEqual(chooseStateDir({ env: {}, home: "/h" }), { path: "/h/.local/state/alife", source: "home" });
    assert.throws(() => chooseStateDir({ env: { ALIFE_STATE_DIR: "relative" }, home: "/h" }), StateDirError);
  });

  it("creates a private layout", async () => {
    const root = path.join(await temp(), "state");
    const layout = await prepareStateDir(root);
    for (const dir of [layout.root, layout.runs, layout.worlds, layout.locks]) {
      assert.equal((await stat(dir)).mode & 0o777, 0o700, dir);
    }
    // Idempotent on an intact layout.
    await prepareStateDir(root);
  });

  it("refuses locations inside the repository", async () => {
    await assert.rejects(prepareStateDir(path.join(REPOSITORY_ROOT, "runs")), /inside/);
    await assert.rejects(prepareStateDir(path.join(REPOSITORY_ROOT, "www", ".alife")), /inside/);
  });

  it("refuses symlinked repository paths", async () => {
    const link = path.join(await temp(), "repo-link");
    await symlink(REPOSITORY_ROOT, link);
    await assert.rejects(prepareStateDir(path.join(link, "state")), /inside/);
  });

  it("treats children named with a leading `..` as inside", async () => {
    const parent = await temp();
    const root = path.join(parent, "repo");
    await mkdir(root, { mode: 0o700 });
    await assert.rejects(prepareStateDir(path.join(root, "..state"), { forbiddenRoots: [root] }), /inside/);
    await assert.rejects(prepareStateDir(path.join(root, "..", "repo", "...", "x"), { forbiddenRoots: [root] }), /inside/);
    await assert.rejects(prepareStateDir(path.join(REPOSITORY_ROOT, "..alife")), /inside/);

    const link = path.join(parent, "link");
    await symlink(root, link);
    await assert.rejects(prepareStateDir(path.join(link, "..state"), { forbiddenRoots: [root] }), /inside/);

    // Genuinely outside: a sibling of the forbidden root, including one whose name starts with `..`.
    await prepareStateDir(path.join(parent, "..state"), { forbiddenRoots: [root] });
    await prepareStateDir(path.join(parent, "repo-state"), { forbiddenRoots: [root] });
  });

  it("refuses shared or symlinked state directories without changing them", async () => {
    const shared = path.join(await temp(), "shared");
    await mkdir(shared, { mode: 0o755 });
    await chmod(shared, 0o755);
    await assert.rejects(prepareStateDir(shared), /accessible to other users/);
    assert.equal((await stat(shared)).mode & 0o777, 0o755);

    const base = await temp();
    await mkdir(path.join(base, "real"), { mode: 0o700 });
    await symlink(path.join(base, "real"), path.join(base, "link"));
    await assert.rejects(prepareStateDir(path.join(base, "link")), /symbolic link/);
  });
});

describe("ownership locks", () => {
  it("grants one owner at a time", async () => {
    const locks = await temp();
    const clock = new FakeClock();
    const owner = await acquireOwnership(locks, "world", WORLD, clock);
    assert.equal((await stat(owner.path)).mode & 0o777, 0o600);

    const conflict = await acquireOwnership(locks, "world", WORLD, clock).catch((e: unknown) => e);
    assert.ok(conflict instanceof OwnershipConflictError);
    assert.equal(conflict.status.holder?.pid, process.pid);
    assert.equal(conflict.status.appearsAlive, true);

    await owner.release();
    assert.equal(await inspectOwnership(locks, "world", WORLD), null);
    await (await acquireOwnership(locks, "world", WORLD, clock)).release();
  });

  it("only acquires locks for exact IDs", async () => {
    const locks = await temp();
    await assert.rejects(acquireOwnership(locks, "world", "../escape", new FakeClock()), RangeError);
    await assert.rejects(acquireOwnership(locks, "run", WORLD, new FakeClock()), RangeError);
  });

  it("does not release a lock that another owner now holds", async () => {
    const locks = await temp();
    const owner = await acquireOwnership(locks, "world", WORLD, new FakeClock());
    const record = JSON.parse(await readFile(owner.path, "utf8")) as Record<string, unknown>;
    await writeFile(owner.path, JSON.stringify({ ...record, token: "0".repeat(32) }));
    await assert.rejects(owner.release(), /no longer held/);
    assert.notEqual(await inspectOwnership(locks, "world", WORLD), null);
  });

  it("shares one release between concurrent calls and never touches a replacement", async () => {
    const locks = await temp();
    for (let trial = 0; trial < 25; trial++) {
      const owner = await acquireOwnership(locks, "world", WORLD, new FakeClock());
      const releases = Promise.all([owner.release(), owner.release()]);
      let replacement: Ownership | null = null;
      while (replacement === null) {
        replacement = await acquireOwnership(locks, "world", WORLD, new FakeClock()).catch(() => null);
      }
      await releases;
      await owner.release();
      assert.equal((await inspectOwnership(locks, "world", WORLD))?.holder?.token, replacement.record.token);
      await replacement.release();
    }
  });

  it("refuses to release for an obsolete owner", async () => {
    const locks = await temp();
    const owner = await acquireOwnership(locks, "world", WORLD, new FakeClock());
    const obsolete = new Ownership(owner.path, owner.record);
    await owner.release();
    const current = await acquireOwnership(locks, "world", WORLD, new FakeClock());
    await assert.rejects(obsolete.release(), /no longer held/);
    assert.equal((await inspectOwnership(locks, "world", WORLD))?.holder?.token, current.record.token);
    assert.equal(await stat(releaseGuardPath(owner.path)).catch(() => null), null);
  });

  it("does not remove a lock while another release holds its guard", async () => {
    const locks = await temp();
    const owner = await acquireOwnership(locks, "world", WORLD, new FakeClock());
    const guard = releaseGuardPath(owner.path);
    await writeFile(guard, "");
    await assert.rejects(owner.release(), ReleaseInProgressError);
    await assert.rejects(releaseAbandonedOwnership(locks, "world", WORLD, owner.record.token), ReleaseInProgressError);
    assert.notEqual(await inspectOwnership(locks, "world", WORLD), null);
    // A failed attempt can be retried once the guard is gone.
    await unlink(guard);
    await owner.release();
    assert.equal(await inspectOwnership(locks, "world", WORLD), null);
  });

  it("serializes concurrent abandoned releases so neither removes a newer owner", async () => {
    const locks = await temp();
    const pid = await exitedPid();
    for (let trial = 0; trial < 25; trial++) {
      const owner = await acquireOwnership(locks, "world", WORLD, new FakeClock());
      await writeFile(owner.path, JSON.stringify({ ...owner.record, pid }));
      const releases = Promise.allSettled([
        releaseAbandonedOwnership(locks, "world", WORLD, owner.record.token),
        releaseAbandonedOwnership(locks, "world", WORLD, owner.record.token),
      ]);
      let replacement: Ownership | null = null;
      while (replacement === null) {
        replacement = await acquireOwnership(locks, "world", WORLD, new FakeClock()).catch(() => null);
      }
      const outcomes = await releases;
      assert.ok(outcomes.some((o) => o.status === "fulfilled"));
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") assert.match(String(outcome.reason), /in progress|does not match|removed during release/);
      }
      assert.equal((await inspectOwnership(locks, "world", WORLD))?.holder?.token, replacement.record.token);
      await replacement.release();
    }
  });

  it("releases an abandoned lock only with its token and a dead holder", async () => {
    const locks = await temp();
    const owner = await acquireOwnership(locks, "world", WORLD, new FakeClock());
    await assert.rejects(releaseAbandonedOwnership(locks, "world", WORLD, "f".repeat(32)), /token does not match/);
    await assert.rejects(releaseAbandonedOwnership(locks, "world", WORLD, owner.record.token), OwnershipConflictError);

    // Rewrite the lock as if held by an exited process.
    await writeFile(owner.path, JSON.stringify({ ...owner.record, pid: await exitedPid() }));
    const status = await inspectOwnership(locks, "world", WORLD);
    assert.equal(status?.appearsAlive, false);
    await releaseAbandonedOwnership(locks, "world", WORLD, owner.record.token);
    assert.equal(await inspectOwnership(locks, "world", WORLD), null);
  });

  it("reports an unreadable lock instead of removing it", async () => {
    const locks = await temp();
    await writeFile(path.join(locks, `world-${WORLD}.lock`), "{");
    const conflict = await acquireOwnership(locks, "world", WORLD, new FakeClock()).catch((e: unknown) => e);
    assert.ok(conflict instanceof OwnershipConflictError);
    assert.equal(conflict.status.holder, null);
  });
});
