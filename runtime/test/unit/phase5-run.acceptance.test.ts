import assert from "node:assert/strict";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { parseWorldId } from "../../src/core/ids.ts";
import { startRun } from "../../src/operator/run.ts";
import { readEventLog } from "../../src/records/events.ts";
import { exportRun } from "../../src/records/export.ts";
import { RunRecorder, runPaths, type TextRef } from "../../src/records/run-store.ts";
import { FAKE_IDENTITY, FakeWorld } from "../support/fake-world.ts";
import { campaignFiles } from "../support/phase5-campaign.ts";
import { KEY, response, sse, type ContinuedReply } from "../support/phase5-contract.ts";
import { attempt, BLOCKS, campaignAPI, CAMPAIGN_ID, evidence, files, RATES, setup, SHELL, THINKING, WAIT, type Fixture } from "../support/phase5-run.ts";

async function snapshot(f: Fixture) {
  const api = await campaignAPI();
  const owner = await api.openCampaign({ directory: f.campaignDirectory, campaignId: CAMPAIGN_ID });
  try { return await owner.snapshot(); } finally { await owner.close(); }
}
async function assertBeforeWorld(a: Awaited<ReturnType<typeof attempt>>) {
  await assert.rejects(a.run, /campaign|spend|budget|journal|corrupt|missing|ENOENT/i);
  assert.equal(a.world.calls.includes("attach"), false);
  assert.equal(a.world.calls.includes("start"), false);
  assert.equal(a.world.dispatched.length, 0);
  assert.equal(a.wire.calls.length, 0);
}

describe("Phase 5 actual operator + Anthropic wire + durable campaign (offline)", { timeout: 15_000, concurrency: false }, () => {
  it("positive control: unchanged fake configuration runs and checkpoints with the same fake world/clock", async (t) => {
    const f = await setup(t, { fake: true });
    const world = new FakeWorld();
    const controller = new AbortController();
    const result = await startRun({ layout: f.layout, resolved: f.resolved, worldId: parseWorldId(FAKE_IDENTITY.worldId),
      clock: f.clock, signal: controller.signal, allowPrivilegedHelper: false, random: f.random,
      openWorld: () => Promise.resolve(world), hostFreeMiB: () => Promise.resolve(1_000_000), onTick: () => controller.abort() });
    const e = await evidence(f, result);
    assert.equal(e.checkpoint.loop.completedTicks, 1);
    assert.equal(result.attemptedCalls, 1);
    assert.equal(e.checkpoint.ledger.accountedMicroUsd, 0);
  });

  it("runs two real-adapter turns with signed thinking, exact tool-result linkage, and no hidden turn", async (t) => {
    const f = await setup(t);
    const a = await attempt(f, { wires: [sse(BLOCKS, { stop: "tool_use" }), sse([WAIT], { stop: "tool_use" })], stopAt: 2 });
    const e = await evidence(f, await a.run());
    assert.equal(a.wire.calls.length, 2);
    assert.deepEqual(a.world.dispatched.map((r) => r.command), ["printf phase5-result"]);
    const first = a.wire.calls[0]!.body;
    assert.equal(first.model, "claude-opus-5-5");
    assert.equal(first.max_tokens, 128_000);
    assert.deepEqual(first.thinking, { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    assert.deepEqual(first.output_config, { effort: "high" });
    const messages = a.wire.calls[1]!.body.messages as { role: string; content: unknown }[];
    assert.deepEqual(messages.find((m) => m.role === "assistant")?.content, BLOCKS);
    const content = messages.filter((m) => m.role === "user").flatMap((m) => Array.isArray(m.content) ? m.content as unknown[] : []) as Record<string, unknown>[];
    const result = content.find((b) => b.type === "tool_result");
    assert.equal(result?.tool_use_id, "tool_offline_1");
    assert.match(JSON.stringify(result?.content), /phase5-result/);
    assert.equal(e.checkpoint.loop.history.length, 2);
    assert.equal(e.checkpoint.ledger.accountedMicroUsd, 1_600);
  });

  it("persists the complete opaque continuation and its conservative bound in reply records and checkpoint", async (t) => {
    const f = await setup(t);
    const a = await attempt(f);
    const e = await evidence(f, await a.run());
    const reply = e.checkpoint.loop.history[0]!.reply as ContinuedReply;
    assert.equal(reply.continuation?.profile, "anthropic-thinking-v1");
    assert.deepEqual(JSON.parse(reply.continuation.data), BLOCKS);
    assert.ok(reply.continuation.inputTokenBound > 0);
    assert.ok(reply.continuation.inputTokenBound <= 128_000);
    const event = e.log.events.find((event) => event.type === "model.responded");
    assert.ok(event);
    const ref = event.data.reply as TextRef;
    const recorded = JSON.parse(ref.text ?? await readFile(path.join(e.paths.blobs, ref.sha256), "utf8")) as ContinuedReply;
    assert.deepEqual(recorded, reply);
    assert.ok(JSON.stringify(e.checkpoint).includes(CAMPAIGN_ID), "checkpoint must pin campaign identity");
    assert.ok(JSON.stringify(e.checkpoint).includes(f.campaignDirectory), "checkpoint must pin campaign directory");
  });

  it("records provider-reported thinking drops without injecting diagnostics into agent observations", async (t) => {
    const f = await setup(t);
    const transformations = [{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_mismatch" }];
    const a = await attempt(f, { wires: [sse(BLOCKS, { stop: "tool_use", transformations }), sse([WAIT], { stop: "tool_use" })], stopAt: 2 });
    const e = await evidence(f, await a.run());
    const event = e.log.events.find((entry) => entry.type === "model.responded");
    assert.ok(event);
    assert.deepEqual(event.data.inputTransformations, transformations);
    assert.doesNotMatch(JSON.stringify(a.wire.calls[1]!.body.messages), /thinking_dropped|prefix_mismatch/,
      "provider diagnostics are observer evidence, not instructions or added context");
  });

  it("keeps the neutral prompt/tools and baseline sensors, without unsolicited directory listings or coaching", async (t) => {
    const f = await setup(t);
    const a = await attempt(f);
    await evidence(f, await a.run());
    const wire = a.wire.calls[0]!.body;
    const systemText = typeof wire.system === "string" ? wire.system : (wire.system as { text: string }[]).map((x) => x.text).join("");
    assert.equal(systemText, f.resolved.prompt.text);
    const tools = wire.tools as { name: string; description: string; input_schema: unknown }[];
    assert.deepEqual(tools.map((x) => ({ name: x.name, description: x.description, parameters: x.input_schema })), f.resolved.tools);
    assert.ok(a.world.calls.includes("sample"));
    assert.equal(a.world.calls.includes("sample+listing"), false);
    assert.doesNotMatch(JSON.stringify(wire.messages), /lost\+found|try again|you should|remember to/i);
  });

  it("makes a durable shared reservation visible at fetch, then reconciles reported usage", async (t) => {
    const f = await setup(t);
    let journalAtFetch = "";
    let eventLogAtFetch = "";
    let directory = "";
    let calls = 0;
    const a = await attempt(f, { fetch: async () => {
      calls++;
      journalAtFetch = await readFile(campaignFiles(f.campaignDirectory).journal, "utf8");
      eventLogAtFetch = await readFile(path.join(directory, "events.jsonl"), "utf8");
      return response(sse([WAIT], { stop: "tool_use" }));
    } });
    const result = await startRun({ ...a.start, onCreated: (_id, paths) => { directory = paths.directory; } });
    await evidence(f, result);
    assert.equal(calls, 1);
    const runEvents = eventLogAtFetch.trim().split("\n").map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
    const requested = runEvents.find((event) => event.type === "model.requested");
    const reserved = runEvents.find((event) => event.type === "cost.reserved");
    assert.ok(requested && reserved);
    assert.equal(requested.data.requestId, reserved.data.requestId);
    assert.ok(Number.isSafeInteger(reserved.data.microUsd) && Number(reserved.data.microUsd) > 0);
    const objects = (value: unknown): Record<string, unknown>[] => {
      if (value === null || typeof value !== "object") return [];
      if (Array.isArray(value)) return value.flatMap(objects);
      const object = value as Record<string, unknown>;
      return [object, ...Object.values(object).flatMap(objects)];
    };
    const journalEntries = journalAtFetch.trim().split("\n").flatMap((line) => objects(JSON.parse(line) as unknown));
    assert.ok(journalEntries.some((entry) => entry.runId === result.runId && entry.requestId === requested.data.requestId &&
      entry.maximumMicroUsd === reserved.data.microUsd), "same full reservation must exist in campaign evidence before fetch");
    const state = await snapshot(f);
    assert.equal(state.accountedMicroUsd, 800);
    assert.deepEqual(state.outstanding, []);
    assert.equal(state.remainingMicroUsd, 100_000_000 - 800);
  });

  it("a second new run shares campaign spend instead of resetting it despite injected mind/rates", async (t) => {
    const f = await setup(t);
    const first = await attempt(f);
    const one = await first.run();
    await evidence(f, one);
    const second = await attempt(f);
    const two = await second.run();
    await evidence(f, two);
    assert.notEqual(one.runId, two.runId);
    assert.equal((await snapshot(f)).accountedMicroUsd, 1_600);
  });

  it("an exhausted campaign refuses before attaching the world even with an injected real adapter", async (t) => {
    const f = await setup(t);
    const api = await campaignAPI();
    const owner = await api.openCampaign({ directory: f.campaignDirectory, campaignId: CAMPAIGN_ID });
    const request = { runId: "r-20260925T161449Z-00000001", requestId: "r-20260925T161449Z-00000001.t000001.request", maximumMicroUsd: 100_000_000 };
    assert.ok(await owner.reserve(request));
    await owner.settle({ runId: request.runId, requestId: request.requestId, basis: "usage", chargedMicroUsd: 100_000_000 });
    await owner.close();
    await assertBeforeWorld(await attempt(f));
  });

  it("a missing campaign is never implicitly created by startRun", async (t) => {
    const f = await setup(t, { campaign: "missing" });
    await campaignAPI(); // API presence is not a successful negative assertion.
    await assertBeforeWorld(await attempt(f));
  });

  it("a corrupt campaign journal refuses before attach or transport", async (t) => {
    const f = await setup(t);
    await appendFile(campaignFiles(f.campaignDirectory).journal, "{broken-json\n");
    await assertBeforeWorld(await attempt(f));
  });

  it("unknown transport processing retains the full reservation and never retries", async (t) => {
    const f = await setup(t);
    let calls = 0;
    const a = await attempt(f, { fetch: () => { calls++; return Promise.reject(new Error("offline connection lost after dispatch")); } });
    const result = await a.run();
    assert.equal(calls, 1);
    assert.equal(result.attemptedCalls, 1);
    assert.equal(result.respondedCalls, 0);
    assert.equal(a.world.dispatched.length, 0);
    const log = await readEventLog(runPaths(f.layout, result.runId).events);
    const reservation = log.events.find((e) => e.type === "cost.reserved");
    assert.ok(reservation);
    assert.equal((await snapshot(f)).accountedMicroUsd, reservation.data.microUsd);
    assert.ok(Number(reservation.data.microUsd) >= 128_000 * 20);
  });

  it("a timeout keeps the charge and does not replay the provider request", async (t) => {
    const f = await setup(t);
    let calls = 0;
    const a = await attempt(f, { fetch: () => { calls++; return Promise.reject(new DOMException("offline timeout", "TimeoutError")); } });
    const result = await a.run();
    assert.equal(calls, 1);
    assert.equal(result.attemptedCalls, 1);
    assert.equal(result.respondedCalls, 0);
    assert.equal(a.world.dispatched.length, 0);
    assert.ok((await snapshot(f)).accountedMicroUsd >= 128_000 * 20);
  });

  it("clean resume restores signed history, pricing, campaign spend, counters, and original deadline", async (t) => {
    const f = await setup(t);
    const first = await attempt(f);
    const stopped = await first.run();
    const before = await evidence(f, stopped);
    f.clock.advance(10_000);
    const second = await attempt(f, { wires: [sse([WAIT], { stop: "tool_use" })] });
    second.world.calls.push("new-process");
    const resumed = await second.resume(stopped.runId);
    const after = await evidence(f, resumed);
    assert.equal(resumed.runId, stopped.runId);
    assert.equal(resumed.attemptedCalls, 2);
    assert.equal(after.checkpoint.deadline, before.checkpoint.deadline);
    assert.deepEqual(after.checkpoint.loop.history[0], before.checkpoint.loop.history[0]);
    const messages = second.wire.calls[0]!.body.messages as { role: string; content: unknown }[];
    assert.deepEqual(messages.find((m) => m.role === "assistant")?.content, BLOCKS);
    assert.match(JSON.stringify(messages), /phase5-result/);
    assert.match(JSON.stringify(messages), /resum|restart|discontinuity/i);
    assert.equal(second.world.dispatched.length, 0);
    assert.equal(after.checkpoint.ledger.accountedMicroUsd, 1_600);
    assert.equal((await snapshot(f)).accountedMicroUsd, 1_600);
    for (const e of after.log.events.filter((e) => e.type === "cost.reserved")) {
      assert.deepEqual(e.data.rates, RATES);
    }
  });

  it("resume refuses a replacement campaign identity before world attach or transport", async (t) => {
    const f = await setup(t);
    const first = await attempt(f);
    const result = await first.run();
    await evidence(f, result);
    await rm(f.campaignDirectory, { recursive: true });
    const api = await campaignAPI();
    const replacement = await api.createCampaign({ directory: f.campaignDirectory, campaignId: "different-campaign", limitMicroUsd: 100_000_000, maximumBytes: 1 << 20 });
    await replacement.close();
    const next = await attempt(f);
    await assert.rejects(() => next.resume(result.runId), /campaign|identity/i);
    assert.equal(next.world.calls.includes("attach"), false);
    assert.equal(next.wire.calls.length, 0);
  });

  for (const [label, blocks, stop, reason] of [
    ["multiple actions", [SHELL, WAIT], "tool_use", "multiple_actions"],
    ["malformed shell arguments", [{ ...SHELL, input: { command: 42 } }], "tool_use", "invalid_arguments"],
    ["unknown tool", [{ ...SHELL, name: "erase_host" }], "tool_use", "unknown_tool"],
    ["incomplete response", [THINKING, SHELL], "max_tokens", "incomplete_response"],
  ] as const) {
    it(`${label} never dispatches a shell`, async (t) => {
      const f = await setup(t);
      const a = await attempt(f, { wires: [sse(blocks, { stop })] });
      const result = await a.run();
      assert.equal(result.attemptedCalls, 1);
      assert.equal(result.respondedCalls, 1, "a parser/adapter failure cannot masquerade as a core protocol refusal");
      assert.equal(a.wire.calls.length, 1);
      assert.equal(a.world.dispatched.length, 0);
      const e = await evidence(f, result);
      assert.equal(e.log.events.some((entry) => entry.type === "action.prepared"), false);
      assert.equal(e.log.events.find((entry) => entry.type === "intention.rejected")?.data.reason, reason);
      const exchange = e.checkpoint.loop.history[0]!;
      const ids = blocks.filter((block) => block.type === "tool_use").map((block) => (block as { id: string }).id);
      assert.deepEqual(exchange.reply.toolCalls.map((call) => call.callId), ids);
      assert.deepEqual(exchange.results.map((result) => result.callId), ids);
      for (const result of exchange.results) assert.match(result.output, /Not executed:/);
    });
  }

  it("a stop during awaited durable preparation prevents transport", async (t) => {
    const f = await setup(t);
    const a = await attempt(f);
    // Retained deliberately for .apply(this, args) in the instrumentation wrapper.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = RunRecorder.prototype.append;
    let stopped = false;
    t.mock.method(RunRecorder.prototype, "append", async function (this: RunRecorder, ...args: Parameters<typeof original>) {
      const result = await original.apply(this, args);
      if (args[0] === "model.requested") { stopped = true; a.controller.abort("stop during durable preparation"); }
      return result;
    });
    const result = await a.run();
    assert.equal(stopped, true);
    assert.equal(result.attemptedCalls, 0);
    assert.equal(a.wire.calls.length, 0);
    assert.equal(a.world.dispatched.length, 0);
    assert.equal((await snapshot(f)).accountedMicroUsd, 0);
  });

  it("a required request-record write failure prevents transport and shell effects", async (t) => {
    const f = await setup(t);
    const a = await attempt(f);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = RunRecorder.prototype.append;
    let failed = false;
    t.mock.method(RunRecorder.prototype, "append", async function (this: RunRecorder, ...args: Parameters<typeof original>) {
      if (args[0] === "model.requested") { failed = true; throw new Error("offline required record failure"); }
      return original.apply(this, args);
    });
    const result = await a.run();
    assert.equal(failed, true);
    assert.equal(result.state, "recovery_required");
    assert.equal(a.wire.calls.length, 0);
    assert.equal(a.world.dispatched.length, 0);
  });

  it("uncertainty established during second request preparation prevents its transport", async (t) => {
    const f = await setup(t);
    const a = await attempt(f, { stopAt: 2 });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = RunRecorder.prototype.append;
    let requests = 0;
    let injected = false;
    let injectionError: unknown = null;
    t.mock.method(RunRecorder.prototype, "append", async function (this: RunRecorder, ...args: Parameters<typeof original>) {
      const result = await original.apply(this, args);
      if (args[0] === "model.requested" && ++requests === 2) {
        try { a.world.lose(a.world.jobs[0]!.jobId); injected = true; }
        catch (error) { injectionError = error; }
      }
      return result;
    });
    const result = await a.run();
    assert.equal(injectionError, null);
    assert.equal(injected, true);
    assert.equal(a.world.safety()?.reviewRequired, true);
    assert.equal(requests, 2);
    assert.equal(result.state, "recovery_required");
    assert.equal(result.attemptedCalls, 1);
    assert.equal(a.wire.calls.length, 1);
    assert.equal(a.world.dispatched.length, 1);
  });

  it("credentials stay exclusively in transport headers, not records, checkpoints, or exports", async (t) => {
    const f = await setup(t);
    const a = await attempt(f);
    const result = await a.run();
    const e = await evidence(f, result);
    assert.equal(a.wire.calls[0]!.headers.get("x-api-key"), KEY);
    assert.equal(JSON.stringify(a.wire.calls[0]!.body).includes(KEY), false);
    const exported = await exportRun({ layout: f.layout, runId: result.runId, outputDirectory: path.join(f.root, "export"), maximumBytes: 128 << 20, maximumFiles: 1000 });
    assert.equal(exported.complete, true, JSON.stringify(exported.omissions));
    for (const item of [...await files(e.paths.directory), ...await files(exported.directory)]) {
      assert.equal(item.text.includes(KEY), false, `credential leaked into ${item.file}`);
    }
    const manifest = JSON.parse(await readFile(e.paths.manifest, "utf8")) as { mind: { model: string } };
    assert.equal(manifest.mind.model, "claude-opus-5-5");
  });

  it("missing credentials refuse the production factory path before world attach or transport", async (t) => {
    const f = await setup(t);
    const a = await attempt(f);
    const saved = process.env.ALIFE_PHASE5_TEST_KEY;
    delete process.env.ALIFE_PHASE5_TEST_KEY;
    t.after(() => {
      if (saved === undefined) delete process.env.ALIFE_PHASE5_TEST_KEY;
      else process.env.ALIFE_PHASE5_TEST_KEY = saved;
    });
    let fetches = 0;
    // Even a broken credential check cannot reach a real network from this test.
    t.mock.method(globalThis, "fetch", () => { fetches++; return Promise.reject(new Error("offline transport guard")); });
    const { mind, ...start } = a.start;
    assert.ok(mind); // Drop only the adapter injection: exercise createMind inside startRun.
    await assert.rejects(() => startRun(start), /credential|ALIFE_PHASE5_TEST_KEY/i);
    assert.equal(fetches, 0);
    assert.equal(a.world.calls.includes("attach"), false);
    assert.equal(a.world.calls.includes("start"), false);
    assert.equal(a.world.dispatched.length, 0);
  });

  it("tampered stored pricing refuses resume before world attachment", async (t) => {
    const f = await setup(t);
    const a = await attempt(f);
    const result = await a.run();
    const e = await evidence(f, result);
    const stored = JSON.parse(await readFile(e.paths.config, "utf8")) as { mind: { costBound: { outputUsdPerMillionTokens: number } } };
    stored.mind.costBound.outputUsdPerMillionTokens = 0;
    await writeFile(e.paths.config, JSON.stringify(stored));
    const next = await attempt(f);
    await assert.rejects(() => next.resume(result.runId), /inputs|hash|config|cost/i);
    assert.equal(next.world.calls.includes("attach"), false);
    assert.equal(next.wire.calls.length, 0);
  });
});
