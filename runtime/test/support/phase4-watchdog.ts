import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Clock } from "../../src/core/clock.ts";
import { EngineResponseError, EngineUnavailableError, type DockerEngine } from "../../src/world/engine.ts";

export interface WatchdogBinding {
  schemaVersion: 1;
  runId: string;
  worldId: string;
  epochId: string;
  controllerToken: string;
  engineId: string;
  containerId: string;
  deadline: string;
  leaseMs: number;
}
export interface WatchdogLease {
  schemaVersion: 1;
  runId: string;
  worldId: string;
  epochId: string;
  controllerToken: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  state: "active" | "released";
}
export interface WatchdogOptions {
  leaseFile: string;
  journalFile: string;
  binding: WatchdogBinding;
  clock: Clock;
  engine: Pick<DockerEngine, "get" | "post">;
  signal: AbortSignal;
  pollIntervalMs: number;
  maximumJournalBytes: number;
}
export interface WatchdogResult {
  outcome: "released" | "stopped" | "unknown" | "refused";
  verified: boolean;
  reason: string;
  containerId: string | null;
}
export type RunWatchdog = (options: WatchdogOptions) => Promise<WatchdogResult>;

export const START = Date.parse("2026-09-25T12:00:00.000Z");
export const iso = (elapsed: number): string => new Date(START + elapsed).toISOString();
export class WatchdogClock implements Clock {
  wall = START;
  elapsed = 0;
  sleeps: number[] = [];
  onSleep: () => Promise<void> = () => Promise.resolve();
  now(): Date { return new Date(this.wall); }
  monotonicMs(): number { return this.elapsed; }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    assert.ok(Number.isFinite(ms) && ms > 0, "retry must yield for a positive bounded interval");
    assert.ok(ms <= 1000, "sleep cannot outlive the initial lease");
    assert.ok(this.sleeps.length < 100, "watchdog did not terminate within deterministic sleep budget");
    this.sleeps.push(ms);
    this.elapsed += ms;
    this.wall += ms;
    await this.onSleep();
  }
}
export interface EngineCall { method: "GET" | "POST"; route: string; elapsed: number }
export class WatchdogEngine implements Pick<DockerEngine, "get" | "post"> {
  clock: WatchdogClock;
  binding: WatchdogBinding;
  calls: EngineCall[] = [];
  invariantFailures: unknown[] = [];
  running = true;
  absent = false;
  available = true;
  engineId: string;
  inspectedId: string;
  labels: Record<string, string>;
  stopMode: "stop" | "no-effect" | "lost-reply" | "unavailable" = "stop";
  inspectUnavailable = false;
  constructor(clock: WatchdogClock, binding: WatchdogBinding) {
    this.clock = clock;
    this.binding = binding;
    this.engineId = binding.engineId;
    this.inspectedId = binding.containerId;
    this.labels = { "sh.alife.world": binding.worldId, "sh.alife.role": "world" };
  }
  record(method: "GET" | "POST", route: string): void {
    try {
      assert.ok(this.calls.length < 400, "transport must not busy-loop without sleeping");
      this.calls.push({ method, route, elapsed: this.clock.elapsed });
      assert.ok(method === "GET"
        ? route === "/info" || route === `/containers/${this.binding.containerId}/json`
        : route === `/containers/${this.binding.containerId}/stop`, `forbidden ${method} route ${route}`);
    } catch (error) {
      this.invariantFailures.push(error);
      throw error;
    }
    if (!this.available) throw new EngineUnavailableError("scripted engine outage");
  }
  async get(route: string): Promise<unknown> {
    await Promise.resolve();
    this.record("GET", route);
    if (route === "/info") return { ID: this.engineId };
    assert.equal(route, `/containers/${this.binding.containerId}/json`);
    if (this.inspectUnavailable) throw new EngineUnavailableError("scripted inspect outage");
    if (this.absent) throw new EngineResponseError(404, "bound container absent");
    return {
      Id: this.inspectedId, Name: `/alife-${this.binding.worldId}`,
      Config: { Labels: this.labels, Env: ["ALIFE_API_KEY=watchdog-secret-must-not-be-journaled"] },
      State: { Running: this.running, Status: this.running ? "running" : "exited", ExitCode: 0, OOMKilled: false },
    };
  }
  async post(route: string): Promise<unknown> {
    await Promise.resolve();
    this.record("POST", route);
    assert.equal(route, `/containers/${this.binding.containerId}/stop`);
    if (this.stopMode === "unavailable") throw new EngineUnavailableError("stop unavailable");
    if (this.stopMode !== "no-effect") this.running = false;
    if (this.stopMode === "lost-reply") throw new EngineUnavailableError("stop reply lost");
    return null;
  }
  stops(): EngineCall[] { return this.calls.filter((call) => call.method === "POST"); }
}

export async function loadWatchdog(): Promise<RunWatchdog> {
  // URL indirection intentionally keeps the absent Phase 4 module out of TS resolution.
  const url = new URL("../../src/operator/watchdog.ts", import.meta.url);
  const loaded: unknown = await import(url.href).catch((error: unknown) => {
    assert.fail(`Phase 4 requires src/operator/watchdog.ts exporting runWatchdog: ${String(error)}`);
  });
  assert.ok(typeof loaded === "object" && loaded !== null && "runWatchdog" in loaded);
  assert.equal(typeof loaded.runWatchdog, "function", "Phase 4 runWatchdog API must exist");
  return loaded.runWatchdog as RunWatchdog;
}

export async function watchdogFixture<T>(body: (f: WatchdogFixture) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "alife-phase4-watchdog-"));
  const clock = new WatchdogClock();
  const binding: WatchdogBinding = {
    schemaVersion: 1, runId: "r-20260925T161449Z-00000000", worldId: "w-20260925T161449Z-00000000", epochId: "00000000-0000-4000-8000-000000000003",
    controllerToken: "c".repeat(32), engineId: "engine-pinned", containerId: "a".repeat(64),
    deadline: iso(3000), leaseMs: 1000,
  };
  const engine = new WatchdogEngine(clock, binding);
  const abort = new AbortController();
  const options: WatchdogOptions = {
    binding, clock, engine, signal: abort.signal, leaseFile: path.join(root, "watchdog.lease.json"),
    journalFile: path.join(root, "watchdog.journal.jsonl"), pollIntervalMs: 100, maximumJournalBytes: 8192,
  };
  const lease = (patch: Partial<WatchdogLease> = {}): WatchdogLease => ({
    schemaVersion: 1, runId: binding.runId, worldId: binding.worldId, epochId: binding.epochId,
    controllerToken: binding.controllerToken, sequence: 1, issuedAt: iso(0), expiresAt: iso(1000), state: "active", ...patch,
  });
  const f: WatchdogFixture = {
    root, clock, binding, engine, abort, options, lease,
    heartbeat: async (patch = {}) => { await writeFile(options.leaseFile, JSON.stringify(lease(patch))); },
    journal: async () => readFile(options.journalFile, "utf8"),
    run: async () => {
      const run = await loadWatchdog();
      const result = await run(options);
      assert.ok(["released", "stopped", "unknown", "refused"].includes(result.outcome));
      assert.equal(typeof result.verified, "boolean");
      assert.ok(typeof result.reason === "string" && result.reason.length > 0);
      assert.ok(result.containerId === binding.containerId || result.containerId === null);
      return result;
    },
  };
  try {
    await f.heartbeat();
    const result = await body(f);
    if (engine.invariantFailures.length > 0) throw engine.invariantFailures[0];
    return result;
  } finally { await rm(root, { recursive: true, force: true }); }
}
export interface WatchdogFixture {
  root: string;
  clock: WatchdogClock;
  binding: WatchdogBinding;
  engine: WatchdogEngine;
  abort: AbortController;
  options: WatchdogOptions;
  lease: (patch?: Partial<WatchdogLease>) => WatchdogLease;
  heartbeat: (patch?: Partial<WatchdogLease>) => Promise<void>;
  journal: () => Promise<string>;
  run: () => Promise<WatchdogResult>;
}
export function assertStopped(f: WatchdogFixture, result: WatchdogResult): void {
  assert.equal(result.outcome, "stopped");
  assert.equal(result.verified, true);
  assert.equal(result.containerId, f.binding.containerId);
  assert.equal(f.engine.running, false);
  const stopIndex = f.engine.calls.findLastIndex((call) => call.method === "POST");
  assert.ok(stopIndex >= 0, "physical stop required");
  assert.ok(f.engine.calls.slice(stopIndex + 1).some((call) => call.route.endsWith("/json")), "receipt requires inspect after stop");
}
