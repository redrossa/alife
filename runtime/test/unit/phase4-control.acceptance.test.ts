import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { main } from "../../src/cli.ts";
import { loadConfig } from "../../src/config/resolve.ts";
import type { Clock } from "../../src/core/clock.ts";
import type { MindOutcome } from "../../src/core/contracts.ts";
import { parseWorldId, type RunId } from "../../src/core/ids.ts";
import { requestBounds } from "../../src/mind/create.ts";
import { FakeMind } from "../../src/mind/fake.ts";
import { inspectOwnership } from "../../src/operator/locks.ts";
import { startRun } from "../../src/operator/run.ts";
import { prepareStateDir, type StateLayout } from "../../src/operator/state-dir.ts";
import { FAKE_MIND_RATES } from "../../src/records/accounting.ts";
import { runPaths } from "../../src/records/run-store.ts";
import { variant } from "../support/config.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { FAKE_IDENTITY, FakeWorld } from "../support/fake-world.ts";

type StopRequest = (options: { layout: StateLayout; runId: RunId; clock: Clock }) => Promise<{ accepted: boolean; reason: string }>;
async function requestStop(): Promise<StopRequest> {
  const file = fileURLToPath(new URL("../../src/operator/managed-run.ts", import.meta.url));
  assert.equal(await access(file).then(() => true, () => false), true, "Phase 4 must implement authenticated run control in managed-run.ts");
  const module = await import(pathToFileURL(file).href) as { requestRunStop?: StopRequest };
  assert.equal(typeof module.requestRunStop, "function", "Phase 4 must export requestRunStop");
  return module.requestRunStop!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_r, reject) => {
    timer = setTimeout(() => reject(new Error("control acceptance barrier timed out")), 5000);
  })]); } finally { clearTimeout(timer); }
}

async function fixture(dropReply = false) {
  const root = await mkdtemp("/tmp/alife-p4-control-");
  const controller = new AbortController();
  const sockets = new Set<net.Socket>();
  let serverToClose: net.Server | undefined;
  let fileToRemove: string | undefined;
  let settledForCleanup: Promise<unknown> | undefined;
  async function dispose() {
    controller.abort();
    for (const socket of sockets) socket.destroy();
    if (serverToClose?.listening) await new Promise<void>((resolve) => serverToClose!.close(() => resolve()));
    // Do not delete records while an unexpectedly live operation can still write.
    if (settledForCleanup !== undefined) await within(settledForCleanup);
    await rm(root, { recursive: true, force: true });
    if (fileToRemove !== undefined) await rm(path.dirname(fileToRemove), { recursive: true, force: true });
  }
  try {
  const layout = await prepareStateDir(root);
  const file = await variant((config) => {
    config.operator.maximumTicks = 2;
    config.body.minimumTickIntervalMs = 0; // This fixture isolates control delivery, not cadence cancellation.
  });
  fileToRemove = file;
  const loaded = await loadConfig(file);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("fixture configuration invalid");
  const clock = new FakeClock();
  const world = new FakeWorld();
  const created = deferred<RunId>();
  const invoked = deferred<void>();
  const completeMind = deferred<MindOutcome>();
  const mind = new FakeMind({ schemaVersion: 1, turns: [{ type: "wait" }] }, requestBounds(loaded.resolved));
  const normalInvoke = mind.invoke.bind(mind);
  mind.invoke = (request, signal) => {
    invoked.resolve();
    signal.addEventListener("abort", () => {
      // The fixture's fake cognition is known and has no billable/side effects.
      void normalInvoke(request, new AbortController().signal).then(completeMind.resolve);
    }, { once: true });
    return completeMind.promise;
  };
  const run = startRun({ layout, resolved: loaded.resolved, worldId: parseWorldId(FAKE_IDENTITY.worldId), clock,
    signal: controller.signal, allowPrivilegedHelper: false, openWorld: () => Promise.resolve(world),
    mind: { mind, rates: FAKE_MIND_RATES }, hostFreeMiB: () => Promise.resolve(1_000_000),
    onCreated: (runId) => created.resolve(runId),
  });
  // Observe failure immediately, including if fixture setup fails later.
  const settled = run.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  settledForCleanup = settled;
  const runId = await within(created.promise);
  await within(invoked.promise);
  const paths = runPaths(layout, runId);
  const owner = await inspectOwnership(layout.locks, "run", runId);
  assert.ok(owner?.holder);
  const socketPath = path.join(paths.directory, "control.sock");
  const controlFile = path.join(paths.directory, "control.json");
  const descriptor = { schemaVersion: 1, runId, epochId: "00000000-0000-4000-8000-000000000002", controllerToken: owner.holder.token, socketPath };
  const requests: Record<string, unknown>[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 4096) { socket.destroy(); return; }
      if (!input.includes("\n")) return;
      let request: Record<string, unknown>;
      try { request = JSON.parse(input.split("\n")[0]!) as Record<string, unknown>; }
      catch { socket.end(JSON.stringify({ accepted: false, reason: "invalid request" }) + "\n"); return; }
      requests.push(request);
      const accepted = request.command === "stop" && request.runId === runId &&
        request.controllerToken === descriptor.controllerToken && request.epochId === descriptor.epochId;
      if (accepted) controller.abort();
      if (dropReply) socket.destroy();
      else socket.end(JSON.stringify({ accepted, reason: accepted ? "operator stop requested" : "ownership mismatch" }) + "\n");
    });
  });
  serverToClose = server;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await writeFile(controlFile, JSON.stringify(descriptor), { mode: 0o600 });
  return { root, layout, clock, runId, paths, owner, controlFile, descriptor, requests, settled, dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], `control fixture failed; unsettled records preserved at ${root}`, { cause: cleanupError }); }
    throw error;
  }
}

describe("P4-C authenticated cross-process stop protocol and CLI", () => {
  it("fixture has a real active run, live ownership, and a working bound control socket", async () => {
    const f = await fixture();
    try {
      const reply = await within(new Promise<string>((resolve, reject) => {
        const socket = net.connect(f.descriptor.socketPath);
        let text = "";
        socket.once("error", reject);
        socket.once("connect", () => socket.write(JSON.stringify({ schemaVersion: 1, command: "stop",
          runId: f.runId, epochId: f.descriptor.epochId, controllerToken: f.descriptor.controllerToken }) + "\n"));
        socket.on("data", (chunk) => { text += chunk.toString(); });
        socket.once("end", () => resolve(text));
      }));
      assert.equal((JSON.parse(reply) as { accepted: boolean }).accepted, true);
      const ended = await within(f.settled);
      assert.equal(ended.ok, true);
      if (ended.ok) assert.equal(ended.value.state, "stopped_clean", JSON.stringify(ended.value));
    } finally { await f.dispose(); }
  });

  it("sends a bound stop request, not a PID signal, to the live controller", async () => {
    const stop = await requestStop();
    const f = await fixture();
    let signals = 0;
    const onSignal = () => { signals++; };
    process.on("SIGINT", onSignal);
    try {
      const result = await stop({ layout: f.layout, runId: f.runId, clock: f.clock });
      assert.equal(result.accepted, true);
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0]!.controllerToken, f.owner.holder!.token);
      assert.equal(f.requests[0]!.epochId, f.descriptor.epochId);
      const ended = await within(f.settled);
      assert.equal(ended.ok, true);
      if (ended.ok) assert.equal(ended.value.state, "stopped_clean");
      assert.equal(signals, 0, "do not blindly signal the lock's PID");
    } finally { process.off("SIGINT", onSignal); await f.dispose(); }
  });

  for (const change of ["token", "run ID", "outside socket", "missing descriptor", "invalid JSON"] as const) {
    it(`refuses ${change} without contacting the endpoint or signalling a process`, async () => {
      const stop = await requestStop();
      const f = await fixture();
      try {
        const descriptor = { ...f.descriptor };
        if (change === "token") descriptor.controllerToken = "f".repeat(32);
        if (change === "run ID") descriptor.runId = "r-20260925T161449Z-ffffffff" as RunId;
        if (change === "outside socket") descriptor.socketPath = "/tmp/not-this-run.sock";
        if (change === "missing descriptor") await rm(f.controlFile);
        else await writeFile(f.controlFile, change === "invalid JSON" ? "{" : JSON.stringify(descriptor));
        const result = await stop({ layout: f.layout, runId: f.runId, clock: f.clock });
        assert.equal(result.accepted, false);
        assert.ok(result.reason.length > 0);
        assert.deepEqual(f.requests, []);
        assert.equal((await inspectOwnership(f.layout.locks, "run", f.runId))?.holder?.token, f.owner.holder!.token);
      } finally { await f.dispose(); }
    });
  }

  it("does not retry a stop request whose acknowledgement was lost", async () => {
    const stop = await requestStop();
    const f = await fixture(true);
    try {
      const result = await stop({ layout: f.layout, runId: f.runId, clock: f.clock });
      assert.equal(result.accepted, false);
      assert.match(result.reason, /unknown|acknowledg|closed/i);
      assert.equal(f.requests.length, 1, "at most one operator request; loss of acknowledgement is not a retry authorization");
      const ended = await within(f.settled);
      assert.equal(ended.ok, true);
    } finally { await f.dispose(); }
  });

  it("run stop --json uses the authenticated endpoint and reports its acknowledgement", async () => {
    await requestStop();
    const f = await fixture();
    try {
      const out: string[] = [], err: string[] = [];
      const code = await main(["run", "stop", f.runId, "--state-dir", f.layout.root, "--json"], (s) => out.push(s), (s) => err.push(s));
      assert.equal(code, 0, err.join("\n"));
      assert.equal(f.requests.length, 1);
      assert.equal((JSON.parse(out.join("\n")) as { accepted: boolean }).accepted, true);
      assert.equal((await within(f.settled)).ok, true);
    } finally { await f.dispose(); }
  });

  it("help exposes every Phase 4 operator command", async () => {
    const out: string[] = [];
    assert.equal(await main(["help"], (s) => out.push(s)), 0);
    const help = out.join("\n");
    for (const command of ["run stop", "run resume", "run capture", "run export", "observe list", "observe read"]) {
      assert.ok(help.includes(command), `Phase 4 CLI must document ${command}`);
    }
  });
});
