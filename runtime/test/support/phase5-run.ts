import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { loadConfig } from "../../src/config/resolve.ts";
import { parseWorldId } from "../../src/core/ids.ts";
import { startRun, resumeRun, type StartRunOptions, type RunResult } from "../../src/operator/run.ts";
import { prepareStateDir } from "../../src/operator/state-dir.ts";
import { readCheckpoint } from "../../src/records/checkpoint.ts";
import { readEventLog } from "../../src/records/events.ts";
import { runPaths } from "../../src/records/run-store.ts";
import { variant } from "./config.ts";
import { FakeClock } from "./fake-clock.ts";
import { FakeWorld, FAKE_IDENTITY } from "./fake-world.ts";
import { anthropicAPI, options, sse, transport, type Block } from "./phase5-contract.ts";
import { campaignAPI } from "./phase5-campaign.ts";
export { campaignAPI } from "./phase5-campaign.ts";

export const CAMPAIGN_ID = "phase5-smoke-v1";
export const RATES = { inputUsdPerMillionTokens: 4, outputUsdPerMillionTokens: 20, source: "offline fixture", verifiedOn: "2026-09-27" };
export const THINKING: Block = { type: "thinking", thinking: "offline signed reasoning", signature: "offline-signature" };
export const SHELL: Block = { type: "tool_use", id: "tool_offline_1", name: "shell", input: { command: "printf phase5-result" } };
export const WAIT: Block = { type: "tool_use", id: "tool_offline_wait", name: "wait", input: {} };
export const BLOCKS = [THINKING, { type: "redacted_thinking", data: "offline-opaque-block" }, SHELL];

let serial = 0;
export async function setup(t: TestContext, settings: { fake?: boolean; campaign?: "missing"; limitMicroUsd?: number; maximumTicks?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "alife-phase5-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignDirectory = path.join(root, "campaign");
  const source = await variant((c) => {
    c.body.minimumTickIntervalMs = 0;
    c.operator.maximumTicks = settings.maximumTicks ?? 20;
    c.operator.recordLimitMiB = 128;
    if (!settings.fake) {
      c.body.contextBudgetTokens = 1_000_000;
      c.body.contextPolicy = "recent-complete-exchanges-v3";
      c.body.tokenEstimator = "anthropic-wire-bound-v1";
      c.mind = { provider: "anthropic", model: "claude-opus-5-5", credentialEnv: "ALIFE_PHASE5_TEST_KEY", maximumOutputTokens: 128_000,
        requestTimeoutMs: 1_000, retryProfile: "none-v1", reasoningEffort: "high", costBound: RATES };
      c.operator.maximumEstimatedCostUsd = 100;
      c.operator.campaignDirectory = campaignDirectory;
    }
  });
  t.after(() => rm(path.dirname(source), { recursive: true, force: true }));
  const loaded = await loadConfig(source);
  // Intentionally outside any rejection assertion: absent schema support is a red assertion.
  assert.ok(loaded.ok, `Phase 5 real configuration must load: ${loaded.ok ? "" : JSON.stringify(loaded.issues)}`);
  if (!settings.fake && settings.campaign !== "missing") {
    const api = await campaignAPI();
    const handle = await api.createCampaign({ directory: campaignDirectory, campaignId: CAMPAIGN_ID,
      limitMicroUsd: settings.limitMicroUsd ?? 100_000_000, maximumBytes: 1 << 20 });
    await handle.close(); // Handles are lifetime-exclusive: the run must open, never create/reset.
  }
  const layout = await prepareStateDir(path.join(root, "state"));
  const clock = new FakeClock();
  const random = (size: number) => Buffer.alloc(size, ++serial);
  return { root, campaignDirectory, source, resolved: loaded.resolved, layout, clock, random };
}
export type Fixture = Awaited<ReturnType<typeof setup>>;
export async function attempt(f: Fixture, settings: { wires?: readonly string[]; fetch?: typeof globalThis.fetch; stopAt?: number } = {}) {
  const wire = transport(settings.wires ?? [sse(BLOCKS, { stop: "tool_use" })]);
  const api = await anthropicAPI(); // Never substitute FakeMind in provider acceptance.
  const mind = api.createAnthropicMind(options(settings.fetch ?? wire.fetch, { tools: f.resolved.tools }));
  const world = new FakeWorld(() => ({ stdout: "phase5-result\n" }));
  const controller = new AbortController();
  const start: StartRunOptions = {
    layout: f.layout, resolved: f.resolved, worldId: parseWorldId(FAKE_IDENTITY.worldId), clock: f.clock,
    signal: controller.signal, allowPrivilegedHelper: false, openWorld: () => Promise.resolve(world),
    mind: { mind, rates: RATES }, hostFreeMiB: () => Promise.resolve(1_000_000), random: f.random,
    onTick: ({ tick }) => { if (tick >= (settings.stopAt ?? 1)) controller.abort("offline operator stop"); },
  };
  return { wire, mind, world, controller, start,
    run: () => startRun(start),
    resume: (runId: RunResult["runId"]) => resumeRun({ ...start, runId }),
  };
}
export async function evidence(f: Fixture, result: RunResult) {
  assert.equal(result.state, "stopped_clean", JSON.stringify(result));
  assert.equal(result.reason, "operator_stop");
  assert.equal(result.recorded, true);
  assert.ok(result.checkpointSha256);
  const paths = runPaths(f.layout, result.runId);
  const checkpoint = await readCheckpoint(paths, result.checkpointSha256);
  const log = await readEventLog(paths.events);
  assert.deepEqual(log.issues, []);
  assert.deepEqual(checkpoint.ledger.outstanding, []);
  return { paths, checkpoint, log };
}
export async function files(directory: string): Promise<{ file: string; text: string }[]> {
  const result: { file: string; text: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file));
    else if (entry.isFile()) result.push({ file, text: await readFile(file, "utf8") });
  }
  return result;
}
