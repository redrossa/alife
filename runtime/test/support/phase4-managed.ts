import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";

import { loadConfig } from "../../src/config/resolve.ts";
import type { ArchiveResult, MindAdapter } from "../../src/core/contracts.ts";
import { newArchiveId, type RunId } from "../../src/core/ids.ts";
import { SHELL_TOOL } from "../../src/core/tools.ts";
import type { RunResult, StartRunOptions } from "../../src/operator/run.ts";
import { prepareStateDir } from "../../src/operator/state-dir.ts";
import type { EventEnvelope } from "../../src/records/events.ts";
import { runPaths, type RunPaths } from "../../src/records/run-store.ts";
import { CAPTURE_COVERAGE, captureInto, type CaptureLimits } from "../../src/world/archive.ts";
import type { DockerContext } from "../../src/world/engine.ts";
import { worldPaths } from "../../src/world/metadata.ts";
import { writeTar } from "../../src/world/tar.ts";
import { variant } from "./config.ts";
import { FakeClock } from "./fake-clock.ts";
import { offlineWorld } from "./offline-world.ts";

export interface WatchResult {
  outcome: "released" | "stopped" | "unknown" | "refused";
  verified: boolean;
  reason: string;
  containerId: string | null;
}
export interface LaunchOptions {
  leaseFile: string;
  journalFile: string;
  binding: { schemaVersion: 1; runId: string; worldId: string; epochId: string; controllerToken: string; engineId: string; containerId: string; deadline: string; leaseMs: number };
  context: DockerContext;
  pollIntervalMs: number;
  maximumJournalBytes: number;
}
export interface WatchHandle {
  pid: number;
  heartbeat(): Promise<void>;
  completed: Promise<WatchResult>;
  release(): Promise<WatchResult>;
}
export interface ManagedAPI {
  startManagedRun(options: StartRunOptions & { launchWatchdog?: (options: LaunchOptions) => Promise<WatchHandle> }): Promise<RunResult>;
  requestRunStop(options: Pick<StartRunOptions, "layout" | "clock"> & { runId: RunId }): Promise<{ accepted: boolean; reason: string }>;
}
export async function managedAPI(): Promise<ManagedAPI> {
  const url = new URL("../../src/operator/managed-run.ts", import.meta.url);
  assert.ok(existsSync(url), "Phase 4: src/operator/managed-run.ts must exist (no production stub)");
  const module = await import(url.href) as Record<string, unknown>;
  for (const name of ["startManagedRun", "requestRunStop"]) assert.equal(typeof module[name], "function", `Phase 4: missing ${name} export`);
  return module as unknown as ManagedAPI;
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function bounded<T>(promise: Promise<T>, label = "managed operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within 3 seconds`)), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
export const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
export async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `${label} did not occur within 2.5 seconds`);
    await turn();
  }
}
export async function events(paths: RunPaths): Promise<EventEnvelope[]> {
  const text = await readFile(paths.events, "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as EventEnvelope);
}
export async function treeBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    const info = await stat(file);
    bytes += info.isDirectory() ? await treeBytes(file) : info.size;
  }
  return bytes;
}

/** Only capture is substituted on DockerWorld. Its lifecycle, exec transport,
 * epoch safety, physical stop, and run records are the real implementations. */
export async function managedFixture(t: TestContext, api?: ManagedAPI, recordLimitMiB?: number) {
  const root = await mkdtemp("/tmp/alife-managed-"); // Run-local Unix sockets must fit macOS's sockaddr_un bound.
  const layout = await prepareStateDir(root);
  const clock = new FakeClock();
  const config = await variant((c) => {
    c.operator.maximumTicks = 1;
    c.operator.heartbeatIntervalSeconds = 1;
    c.operator.watchdogLeaseSeconds = 90;
    if (recordLimitMiB !== undefined) c.operator.recordLimitMiB = recordLimitMiB;
  });
  const loaded = await loadConfig(config);
  assert.ok(loaded.ok, loaded.ok ? "" : JSON.stringify(loaded.issues));
  const preparation = deferred();
  const prepareEntered = deferred();
  let holdPreparation = false;
  const offline = await offlineWorld(layout, clock, { wrapLog(log) {
    const append = log.append.bind(log);
    log.append = async (type, data, options) => {
      if (type === "job.prepared" && holdPreparation) {
        prepareEntered.resolve();
        await preparation.promise;
      }
      return append(type, data, options);
    };
  } });
  const abort = new AbortController();
  const arming = deferred();
  const armed = deferred<LaunchOptions>();
  const completion = deferred<WatchResult>();
  const mindEntered = deferred();
  const mindReply = deferred();
  const heartbeatEntered = deferred();
  const created = deferred<RunPaths>();
  const captures: { label: string; result: ArchiveResult; directory: string }[] = [];
  const trace: string[] = [];
  const invariantFailures: unknown[] = [];
  async function checked<T>(action: () => T | Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) {
      if (error instanceof assert.AssertionError) invariantFailures.push(error);
      throw error;
    }
  }
  let paths: RunPaths | undefined;
  let pending: Promise<RunResult> | undefined;
  let binding: LaunchOptions | undefined;
  let calls = 0;
  let releases = 0;
  let heartbeats = 0;
  let holdMind = false;
  let failHeartbeat = false;
  let captureFailure: "initial" | "final" | undefined;
  let incompleteFinal = false;
  let payloadBytes = 16;
  let beforeStart: (() => Promise<void>) | undefined;
  let onReady: (() => void) | undefined;
  const post = offline.engine.post.bind(offline.engine);
  offline.engine.post = async (route, options) => {
    if (/^\/containers\/[^/]+\/start$/.test(route)) {
      trace.push("container.start");
      await checked(() => beforeStart?.());
    }
    return post(route, options);
  };
  offline.engine.onStop = () => { trace.push("container.stop"); };
  offline.world.captureArtifacts = (label: string, optionalLimits?: CaptureLimits): Promise<ArchiveResult> => checked(async () => {
    const phase = captures.length === 0 ? "initial" : "final";
    assert.notEqual(offline.engine.container?.running, true, `${phase} archive requires no live container`);
    assert.ok([...offline.engine.execs.values()].every((exec) => !exec.running), "no writers at capture");
    if (phase === "final") assert.ok(trace.includes("container.stop"), "final archive follows physical stop");
    trace.push(`capture.${phase}`);
    if (captureFailure === phase) throw new Error(`fixture ${phase} capture failure`);
    const archiveId = newArchiveId(clock.now());
    const directory = path.join(worldPaths(layout, offline.worldId).archives, archiveId);
    await mkdir(directory, { recursive: true });
    const limits = optionalLimits ?? { maximumBytes: 32 << 20, maximumEntries: 100, timeoutMs: 3000 };
    const tar = writeTar([{ path: "result.bin", type: "file", mode: 0o600, content: Buffer.alloc(payloadBytes, 0x61) }], 0);
    const outcome = await captureInto(directory, limits, (sink) => {
      sink(tar);
      return Promise.resolve({ containerId: "offline-capture-helper", name: "offline-capture-helper", exitCode: 0, timedOut: false, stopped: false, stdout: Buffer.alloc(0), stdoutBytes: tar.length, stderr: Buffer.alloc(0), stderrBytes: 0, streamProblem: null });
    });
    const omissions = [...outcome.omissions, ...(phase === "final" && incompleteFinal ? ["fixture: socket omitted"] : [])];
    const sourceState = { state: "clean", mountCount: 1, lastWriteTime: clock.now().toISOString() };
    const manifest = {
      schemaVersion: 1, archiveId, worldId: offline.worldId, label, capture: "tar-capture-v1",
      createdAt: clock.now().toISOString(), completedAt: clock.now().toISOString(),
      complete: outcome.complete && omissions.length === 0, omissions, coverage: CAPTURE_COVERAGE, limits,
      archive: { file: "archive.tar", bytes: outcome.bytes, sha256: outcome.sha256 },
      source: { uuid: offline.world.metadata.storage.uuid, device: "/dev/loop0", before: sourceState, after: sourceState, unchanged: true },
      helper: outcome.helper, entryCount: outcome.entries.length, entries: outcome.entries,
    };
    await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    const result = { archiveId, complete: manifest.complete, entries: outcome.entries.length, bytes: outcome.bytes, omissions };
    captures.push({ label, result, directory });
    await offline.log.append("archive.created", { ...result, label, sha256: outcome.sha256 }, { durable: true });
    return result;
  });
  const mind: MindAdapter = {
    id: "fake-v1", capabilities: { toolCalls: true, reportsUsage: true, maximumOutputTokens: loaded.resolved.config.mind.maximumOutputTokens },
    validate() {},
    async invoke() {
      calls++;
      mindEntered.resolve();
      if (holdMind) await mindReply.promise;
      return { outcome: "responded", response: {
        providerRequestId: null, status: "completed", latencyMs: 0, usage: { inputTokens: 1, outputTokens: 1, reported: {} },
        reply: { text: null, refusal: null, toolCalls: [{ callId: "managed-call", name: SHELL_TOOL, arguments: JSON.stringify({ command: "printf managed" }) }] },
      } };
    },
  };
  const handle: WatchHandle = {
    pid: 987654321,
    completed: completion.promise,
    heartbeat() {
      heartbeats++;
      heartbeatEntered.resolve();
      return failHeartbeat ? Promise.reject(new Error("fixture heartbeat lost")) : Promise.resolve();
    },
    release: () => checked(() => {
      releases++;
      trace.push("watchdog.release");
      assert.notEqual(offline.engine.container?.running, true, "never release protection of a live container");
      const result: WatchResult = { outcome: "released", verified: true, reason: "controller verified stop", containerId: binding?.binding.containerId ?? null };
      completion.resolve(result);
      return result;
    }),
  };
  t.after(async () => {
    abort.abort();
    arming.resolve(); mindReply.resolve(); preparation.resolve();
    completion.resolve({ outcome: "unknown", verified: false, reason: "fixture cleanup", containerId: binding?.binding.containerId ?? null });
    try {
      if (pending !== undefined) await bounded(pending.catch(() => undefined), "cleanup");
    } catch (error) {
      t.diagnostic(`unsettled fixture retained at ${root}; do not close records or delete files under a live operation`);
      throw error;
    }
    offline.engine.stopError = null;
    await bounded(offline.world.stop("operator_stop"));
    await offline.world.close();
    await rm(root, { recursive: true, force: true });
    await rm(path.dirname(config), { recursive: true, force: true });
    if (invariantFailures.length > 0) throw invariantFailures[0];
  });
  return {
    root, layout, clock, offline, abort, arming, armed, completion, mindEntered, mindReply, heartbeatEntered, prepareEntered, preparation, created, captures, trace,
    get paths() { assert.ok(paths, "run records must exist"); return paths; },
    get calls() { return calls; }, get releases() { return releases; }, get heartbeats() { return heartbeats; },
    get runId() { assert.ok(binding); return binding.binding.runId as RunId; },
    get recordLimit() { return loaded.resolved.config.operator.recordLimitMiB * (1 << 20); },
    holdMind() { holdMind = true; }, holdPreparation() { holdPreparation = true; },
    failHeartbeat() { failHeartbeat = true; },
    failCapture(phase: "initial" | "final") { captureFailure = phase; },
    incompleteFinal() { incompleteFinal = true; },
    largeCapture(bytes: number) { payloadBytes = bytes; },
    beforeStart(hook: () => Promise<void>) { beforeStart = hook; },
    onReady(hook: () => void) { onReady = hook; },
    start() {
      assert.ok(api, "managed API required to start the managed fixture");
      assert.equal(pending, undefined, "one managed episode per fixture");
      pending = api.startManagedRun({
        layout, resolved: loaded.resolved, worldId: offline.worldId, clock, signal: abort.signal,
        allowPrivilegedHelper: false, openWorld: () => Promise.resolve(offline.world),
        hostFreeMiB: () => Promise.resolve(1_000_000), mind: { mind, rates: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0, source: "offline fixture" } },
        onCreated(id, p) { paths = p; assert.equal(p.directory, runPaths(layout, id).directory); created.resolve(p); },
        async launchWatchdog(options) {
          binding = options;
          trace.push("watchdog.launch");
          armed.resolve(options);
          await arming.promise;
          trace.push("watchdog.ready");
          onReady?.();
          return handle;
        },
      });
      void pending.catch(() => undefined);
      return pending;
    },
  };
}
export type ManagedFixture = Awaited<ReturnType<typeof managedFixture>>;
export function noEffects(f: ManagedFixture) {
  assert.equal(f.calls, 0, "no mind invocation");
  assert.ok(!f.offline.engine.calls.some((call) => /^POST \/containers\/[^/]+\/start$/.test(call)), "container never started");
  assert.ok([...f.offline.engine.execs.values()].every((exec) => exec.starts === 0), "no exec starts");
  assert.ok(!f.offline.engine.calls.some((call) => call.startsWith("DELETE /volumes/")), "persistent backing volume is retained");
}
export async function reviewedStop(f: ManagedFixture, pending: Promise<RunResult>) {
  const result = await bounded(pending);
  assert.equal(result.state, "recovery_required", result.detail);
  assert.equal(result.checkpointSha256, null);
  assert.equal(result.worldStop?.verified, true);
  assert.ok(f.trace.includes("container.stop"));
  assert.equal(f.offline.engine.jobs().reduce((sum, job) => sum + job.starts, 0), 0, "no shell committed after watchdog loss");
  assert.ok(!(await events(f.paths)).some((event) => event.type === "checkpoint.written"));
  return result;
}
