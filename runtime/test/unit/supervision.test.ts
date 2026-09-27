import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parseRunId, parseWorldId } from "../../src/core/ids.ts";
import { acquireOwnership } from "../../src/operator/locks.ts";
import { requestRunStop, viaSocketPath } from "../../src/operator/managed-run.ts";
import { runPaths } from "../../src/records/run-store.ts";
import { JsonlEventLog, WORLD_EVENT_TYPES, type EventLogContents } from "../../src/records/events.ts";
import { analyzeWatchdog } from "../../src/records/finalize.ts";
import { fenceViolation, worldFence } from "../../src/world/backend.ts";
import { createWorldDirectory, worldPaths } from "../../src/world/metadata.ts";
import { prepareStateDir } from "../../src/operator/state-dir.ts";
import { FakeClock } from "../support/fake-clock.ts";

// Implementation tests for Phase 4 choices the acceptance suites leave open:
// which world history fences a resume, and how multi-epoch watchdog evidence is judged.

const WORLD = parseWorldId("w-20260925T161449Z-0000fe7c");

async function worldLog() {
  const root = await mkdtemp(path.join(tmpdir(), "alife-fence-"));
  const paths = worldPaths(await prepareStateDir(root), WORLD);
  await createWorldDirectory(paths);
  const log = await JsonlEventLog.open({ file: paths.events, runId: WORLD, clock: new FakeClock(), limitBytes: 1 << 20, types: WORLD_EVENT_TYPES });
  return { root, paths, log };
}

describe("world history fence", () => {
  it("allows captures and storage handling after the fence, and refuses any later execution", async () => {
    const { root, paths, log } = await worldLog();
    try {
      await log.append("world.provisioned", {});
      await log.append("world.container_created", { id: "a" });
      await log.append("world.stopped", { id: "a" });
      const fence = await worldFence(paths);
      assert.equal(fence?.sequence, 3);
      await log.append("world.attached", {});
      await log.append("archive.created", { archiveId: "a-20260925T161449Z-00000001" });
      assert.equal(await fenceViolation(paths, fence), null);
      await log.append("world.container_created", { id: "b" });
      assert.match((await fenceViolation(paths, fence)) ?? "", /intervening/);
    } finally {
      await log.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a rewritten history and a log that appeared where none was recorded", async () => {
    const { root, paths, log } = await worldLog();
    try {
      await log.append("world.provisioned", {});
      const fence = await worldFence(paths);
      await log.close();
      assert.match((await fenceViolation(paths, null)) ?? "", /did not have/);
      await appendFile(paths.events, "{");
      assert.match((await fenceViolation(paths, fence)) ?? "", /damaged/);
      assert.match((await fenceViolation(paths, { ...fence!, sha256: "0".repeat(64) })) ?? "", /changed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("watchdog evidence across epochs", () => {
  const RUN = "r-20260925T161449Z-0000fe7c";
  const binding = (epochId: string) => ({
    schemaVersion: 1, runId: RUN, worldId: WORLD, epochId, controllerToken: "c".repeat(32), engineId: "engine",
    containerId: epochId === "e1" ? "a".repeat(64) : "b".repeat(64), deadline: "2026-09-25T17:00:00.000Z", leaseMs: 10_000,
  });
  const journal = (records: [string, string, Record<string, unknown>][]): EventLogContents => ({
    issues: [],
    events: records.map(([type, epoch, data], index) => ({
      v: 1, seq: index + 1, runId: RUN, session: "00000000-0000-4000-8000-000000000001", type,
      time: "2026-09-25T16:14:49.000Z", monotonicMs: 0, data: { binding: binding(epoch), ...data },
    })),
  });
  const expected = { runId: RUN, worldId: WORLD, engineId: "engine", epochs: new Set(["e1", "e2"]), supervisedEpochs: new Set(["e1", "e2"]), required: true };

  it("accepts two epochs that were each armed and released after a verified stop", () => {
    const result = analyzeWatchdog(journal([
      ["watchdog.armed", "e1", {}], ["watchdog.released", "e1", { verified: true }],
      ["watchdog.armed", "e2", {}], ["watchdog.released", "e2", { verified: true }],
    ]), expected);
    assert.deepEqual([result.state, result.reviewRequired, result.stopVerified, result.lastSequence], ["released", false, true, 4]);
  });

  it("keeps an earlier epoch's intervention and a supervised epoch without evidence review-required", () => {
    const intervened = analyzeWatchdog(journal([
      ["watchdog.armed", "e1", {}], ["watchdog.expired", "e1", { verified: false }], ["watchdog.stop_verified", "e1", { verified: true }],
      ["watchdog.armed", "e2", {}], ["watchdog.released", "e2", { verified: true }],
    ]), expected);
    assert.equal(intervened.state, "released");
    assert.equal(intervened.reviewRequired, true);
    const missing = analyzeWatchdog(journal([["watchdog.armed", "e1", {}], ["watchdog.released", "e1", { verified: true }]]), expected);
    assert.equal(missing.reviewRequired, true);
    assert.ok(missing.issues.some((issue) => issue.includes("e2")));
  });
});

describe("run control endpoint", () => {
  it("serves and reaches a run-local socket whose path is longer than the platform allows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alife-control-"));
    const layout = await prepareStateDir(path.join(root, "d".repeat(60), "e".repeat(60)));
    const runId = parseRunId("r-20260925T161449Z-0000fe7c");
    const paths = runPaths(layout, runId);
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    assert.ok(Buffer.byteLength(paths.controlSocket) > 104);
    const owner = await acquireOwnership(layout.locks, "run", runId, new FakeClock());
    const server = net.createServer((socket) => socket.once("data", () => socket.end(`${JSON.stringify({ accepted: true, reason: "stop requested" })}\n`)));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        viaSocketPath(paths.controlSocket, (address) => server.listen(address, () => resolve()));
      });
      const descriptor = { schemaVersion: 1, runId, epochId: "session", controllerToken: owner.record.token, socketPath: paths.controlSocket };
      await writeFile(paths.control, JSON.stringify(descriptor));
      assert.deepEqual(await requestRunStop({ layout, runId, clock: new FakeClock() }), { accepted: true, reason: "stop requested" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await owner.release();
      await rm(root, { recursive: true, force: true });
    }
  });
});
