import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { systemClock } from "../../src/core/clock.ts";
import { createAnthropicMind } from "../../src/mind/anthropic.ts";
import { runAnthropicProbe } from "../../src/operator/probe.ts";
import { createCampaign } from "../../src/records/campaign.ts";
import { options, sse, TOOLS, transport } from "../support/phase5-contract.ts";

// Offline only: synthetic streams at the transport boundary, a real campaign on disk.
const RATES = { inputUsdPerMillionTokens: 4, outputUsdPerMillionTokens: 20, source: "offline probe test" };
const SIGNED = { type: "thinking", thinking: "offline reasoning", signature: "offline-signature" };
const WAIT = { type: "tool_use", id: "tool_probe_wait", name: "wait", input: {} };
const DONE = { type: "text", text: "DONE" };

async function fixture(wires: readonly string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "alife-probe-"));
  const io = transport(wires);
  const campaign = await createCampaign({ directory: path.join(root, "campaign"), campaignId: "phase5-smoke-v1", limitMicroUsd: 100_000_000, maximumBytes: 1 << 20 });
  const mind = createAnthropicMind(options(io.fetch));
  const run = () => runAnthropicProbe({
    mind, rates: RATES, campaign, tools: TOOLS, maximumOutputTokens: 128_000, output: path.join(root, "probe"),
    probeId: "probe-offline", clock: systemClock, signal: new AbortController().signal,
  });
  return { root, io, campaign, run, dispose: async () => { await campaign.close(); await rm(root, { recursive: true, force: true }); } };
}

describe("synthetic compatibility probe (offline)", () => {
  it("replays signed reasoning with its tool result, then changes the prefix, within three calls and the campaign", async () => {
    const f = await fixture([
      sse([SIGNED, WAIT], { stop: "tool_use" }),
      sse([DONE]),
      sse([DONE], { transformations: [{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_mismatch" }] }),
    ]);
    try {
      const report = await f.run();
      assert.equal(f.io.calls.length, 3);
      assert.deepEqual([report.toolFollowUp, report.prefixChange, report.estimateHeld], ["passed", "transformations_reported", true]);
      const second = f.io.calls[1]!.body.messages as { role: string; content: Record<string, unknown>[] }[];
      assert.deepEqual(second.find((message) => message.role === "assistant")!.content, [SIGNED, WAIT]);
      assert.equal(second.at(-1)!.content[0]!.type, "tool_result");
      assert.notEqual(f.io.calls[2]!.body.system, f.io.calls[1]!.body.system, "the third request changes the prefix");
      assert.ok(!JSON.stringify(f.io.calls.map((call) => call.body)).includes("baseline"), "synthetic instructions only");
      const state = await f.campaign.snapshot();
      assert.deepEqual(state.outstanding, []);
      assert.equal(state.accountedMicroUsd, report.chargedMicroUsd);
      assert.equal(report.steps.reduce((sum, step) => sum + step.chargedMicroUsd, 0), report.chargedMicroUsd);
      const lines = (await readFile(report.evidence, "utf8")).trim().split("\n");
      assert.equal(lines.length, 6);
    } finally {
      await f.dispose();
    }
  });

  it("stops as inconclusive, without asking again, when the first reply has no signed reasoning and tool call", async () => {
    const f = await fixture([sse([DONE])]);
    try {
      const report = await f.run();
      assert.equal(f.io.calls.length, 1);
      assert.deepEqual([report.toolFollowUp, report.prefixChange], ["inconclusive", "inconclusive"]);
    } finally {
      await f.dispose();
    }
  });

  it("keeps the whole reservation for an unknown outcome and never retries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alife-probe-"));
    const campaign = await createCampaign({ directory: path.join(root, "campaign"), campaignId: "phase5-smoke-v1", limitMicroUsd: 100_000_000, maximumBytes: 1 << 20 });
    let calls = 0;
    const mind = createAnthropicMind(options(() => { calls++; return Promise.reject(new TypeError("offline connection reset")); }));
    try {
      const report = await runAnthropicProbe({ mind, rates: RATES, campaign, tools: TOOLS, maximumOutputTokens: 128_000, output: path.join(root, "probe"),
        probeId: "probe-offline", clock: systemClock, signal: new AbortController().signal });
      assert.equal(calls, 1);
      assert.equal(report.steps[0]!.chargedMicroUsd, report.steps[0]!.reservedMicroUsd);
      assert.equal((await campaign.snapshot()).accountedMicroUsd, report.steps[0]!.reservedMicroUsd);
    } finally {
      await campaign.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
