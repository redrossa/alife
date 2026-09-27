import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as context from "../../src/core/context.ts";
import type { ContextInput, ContextPolicy, Exchange } from "../../src/core/contracts.ts";
import { TOKEN_ESTIMATORS } from "../../src/config/profiles.ts";
import { tokenEstimator, utf8BytesEstimator, type TokenEstimator } from "../../src/core/tokens.ts";
import { request, type ContinuedReply } from "../support/phase5-contract.ts";

function estimator(): TokenEstimator {
  assert.ok("anthropic-wire-bound-v1" in TOKEN_ESTIMATORS, "Phase 5 continuation-aware estimator missing");
  const value = tokenEstimator("anthropic-wire-bound-v1");
  assert.equal(value.id, "anthropic-wire-bound-v1");
  return value;
}
function policy(budgetTokens = 1_000_000, maximumOutputTokens = 128_000): ContextPolicy {
  const f = (context as unknown as { recentCompleteExchangesV3?: (budget: context.ContextBudget) => ContextPolicy }).recentCompleteExchangesV3;
  assert.equal(typeof f, "function", "Phase 5 context.ts must export recentCompleteExchangesV3");
  return f!({ budgetTokens, maximumOutputTokens, marginTokens: 512, estimator: estimator() });
}
function exchange(tick: number, bound = 128_000, marker = `kept-${tick}`): Exchange {
  const content = [
    { type: "thinking", thinking: "", signature: marker },
    { type: "tool_use", id: `call-${tick}`, name: "wait", input: {} },
  ];
  const reply: ContinuedReply = { text: null, refusal: null, toolCalls: [{ callId: `call-${tick}`, name: "wait", arguments: "{}" }],
    continuation: { profile: "anthropic-thinking-v1", data: JSON.stringify(content), inputTokenBound: bound } };
  return { tick, observation: `Observation ${tick}.`, reply, results: [{ callId: `call-${tick}`, output: "No action was taken." }] };
}
function input(history: readonly Exchange[] = []): ContextInput {
  const r = request({ history, tick: 20 });
  return { ...r, appendix: null };
}

describe("Phase 5 bounded continuation context", () => {
  it("fixture control: legacy packing remains a complete-exchange suffix without summarization", () => {
    const history = [exchange(1), exchange(2)].map((e) => ({ ...e, reply: { text: null, refusal: null, toolCalls: e.reply.toolCalls } }));
    const old = context.recentCompleteExchanges({ budgetTokens: 32_768, maximumOutputTokens: 1024, marginTokens: 512, estimator: utf8BytesEstimator });
    const assembled = old.assemble(input(history));
    assert.equal(old.id, "recent-complete-exchanges-v2");
    assert.deepEqual(assembled.request.history, history);
  });
  it("uses a new version rather than changing the immutable v2 identity", () => {
    assert.equal(policy().id, "recent-complete-exchanges-v3");
    assert.equal(context.RECENT_COMPLETE_EXCHANGES, "recent-complete-exchanges-v2");
  });
  it("bounds opaque reasoning even when its visible text is empty and its signature is short", () => {
    const e = estimator();
    const history = [exchange(1)];
    const full = e.request(request({ history, tick: 2 }));
    const base = e.request(request({ tick: 2 }));
    assert.ok(full - base >= 128_000, "encoded signature bytes cannot substitute for restored reasoning tokens");
  });
  it("accounts for continuation serialized bytes as well as reconstructed reasoning tokens", () => {
    const e = estimator();
    const a = e.request(request({ history: [exchange(1, 128_000, "a")] }));
    const b = e.request(request({ history: [exchange(1, 128_000, "b".repeat(10_001))] }));
    assert.ok(b - a >= 10_000);
  });
  it("counts UTF8/JSON escaping and tool-result framing rather than visible character count", () => {
    const e = estimator();
    const history = [exchange(1)];
    const text = '\u0000\\"🧬'.repeat(1000);
    history[0] = { ...history[0]!, results: [{ callId: "call-1", output: text }] };
    assert.ok(e.request(request({ history })) >= 128_000 + Buffer.byteLength(JSON.stringify(text)));
  });
  it("reserves maximum output and margin inside—not in addition to—the 1M budget", () => {
    const assembled = policy().assemble(input(Array.from({ length: 12 }, (_, i) => exchange(i + 1))));
    assert.ok(assembled.status.evictedTicks.length > 0);
    assert.ok(assembled.estimatedInputTokens + 128_000 + 512 <= 1_000_000);
    assert.equal(assembled.request.maximumOutputTokens, 128_000);
    assert.equal(assembled.status.budgetTokens, 1_000_000);
    assert.equal(assembled.status.estimator, "anthropic-wire-bound-v1");
  });
  it("drops oldest complete exchanges with their opaque state and never a tool result alone", () => {
    const history = Array.from({ length: 12 }, (_, i) => exchange(i + 1));
    const assembled = policy().assemble(input(history));
    assert.ok(assembled.request.history.length > 0 && assembled.request.history.length < history.length);
    assert.deepEqual(assembled.request.history, history.slice(-assembled.request.history.length));
    const signatures = assembled.request.history.flatMap((e) => {
      const blocks = JSON.parse((e.reply as ContinuedReply).continuation!.data) as { signature?: string }[];
      return blocks.map((b) => b.signature).filter((s) => s !== undefined);
    });
    for (const tick of assembled.status.evictedTicks) assert.ok(!signatures.includes(`kept-${tick}`));
    for (const kept of assembled.request.history) assert.deepEqual(kept.results.map((r) => r.callId), kept.reply.toolCalls.map((c) => c.callId));
  });
  it("never skips a large newest exchange to reinject a smaller older one", () => {
    const p = policy(200_000);
    const a = exchange(1, 1), b = exchange(2, 128_000);
    const assembled = p.assemble(input([a, b]));
    assert.deepEqual(assembled.request.history, []);
    assert.deepEqual(assembled.status.evictedTicks, [1, 2]);
  });
  it("is stateless: no formerly retained content returns when a later request omits it", () => {
    const p = policy();
    p.assemble(input([exchange(1, 128_000, "FORGOTTEN_SIGNATURE")]));
    const assembled = p.assemble(input([]));
    assert.deepEqual(assembled.request.history, []);
    assert.ok(!JSON.stringify(assembled).includes("FORGOTTEN_SIGNATURE"));
  });
  it("does not mutate caller history/signatures or insert a summary when eviction occurs", () => {
    const history = Array.from({ length: 12 }, (_, i) => exchange(i + 1));
    const before = JSON.stringify(history);
    const source = input(history);
    const assembled = policy().assemble(source);
    assert.equal(JSON.stringify(history), before);
    assert.equal(assembled.request.instructions, source.instructions);
    assert.equal(assembled.request.observation, source.observation);
    assert.deepEqual(assembled.request.tools, source.tools);
  });
  it("refuses an oversized fixed request without silently lowering output", () => {
    const p = policy();
    assert.throws(() => p.assemble({ ...input(), observation: "x".repeat(1_000_000) }), context.ContextOverflowError);
  });
  it("reserves the appendix before choosing history and exposes truthful occupancy", () => {
    const p = policy();
    const assembled = p.assemble({ ...input(Array.from({ length: 12 }, (_, i) => exchange(i + 1))), appendix: {
      maximumBytes: 4096,
      render(status) { return `\nRetained:${status.retainedTicks.join(",")}; estimated=${status.estimatedInputTokens}`; },
    } });
    assert.ok(assembled.estimatedInputTokens <= assembled.status.estimatedInputTokens);
    assert.ok(assembled.status.estimatedInputTokens + 128_000 + 512 <= 1_000_000);
    assert.ok(assembled.request.observation.includes(`Retained:${assembled.status.retainedTicks.join(",")}`));
  });
  for (const bad of [-1, 0.5, NaN, Infinity, 128_001, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects invalid opaque token bound ${String(bad)} before estimation`, () => {
      const e = estimator();
      assert.throws(() => e.request(request({ history: [exchange(1, bad)] })));
    });
  }
  it("refuses malformed continuation data instead of quietly dropping its accounting", () => {
    const e = estimator();
    const x = exchange(1);
    const reply = x.reply as ContinuedReply;
    const bad = { ...x, reply: { ...reply, continuation: { ...reply.continuation!, data: "not json" } } };
    assert.throws(() => e.request(request({ history: [bad] })));
  });
});
