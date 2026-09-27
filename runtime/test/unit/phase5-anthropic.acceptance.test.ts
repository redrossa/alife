import assert from "node:assert/strict";
import { test } from "node:test";
import type { MindOutcome, MindRequest } from "../../src/core/contracts.ts";
import { interpretResponse } from "../../src/core/intentions.ts";
import {
  anthropicAPI, KEY, options, request, response, sse, TOOLS, transport,
  type Block, type ContinuedResponse,
} from "../support/phase5-contract.ts";

const signal = () => new AbortController().signal;
const tool = { type: "tool_use", id: "call_offline", name: "shell", input: { command: "printf offline" } };
const frame = (type: string, fields: Block = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
function streamed(block: Block, deltas: readonly Block[], stop = "end_turn"): string {
  const wire = sse([], { stop });
  const boundary = wire.indexOf("event: message_delta");
  return wire.slice(0, boundary) + frame("content_block_start", { index: 0, content_block: block }) +
    deltas.map((delta) => frame("content_block_delta", { index: 0, delta })).join("") +
    frame("content_block_stop", { index: 0 }) + wire.slice(boundary);
}
function responded(outcome: MindOutcome): ContinuedResponse {
  assert.equal(outcome.outcome, "responded", JSON.stringify(outcome));
  assert.ok(outcome.outcome === "responded");
  return outcome.response;
}
function failed(outcome: MindOutcome, processed: "no" | "unknown" = "unknown") {
  assert.equal(outcome.outcome, "failed", JSON.stringify(outcome));
  assert.ok(outcome.outcome === "failed");
  assert.equal(outcome.failure.processed, processed);
  return outcome.failure;
}
async function invoke(wire: string, input: MindRequest = request()) {
  const api = await anthropicAPI();
  const offline = transport([wire]);
  const mind = api.createAnthropicMind(options(offline.fetch));
  const outcome = await mind.invoke(input, signal());
  assert.equal(offline.calls.length, 1);
  return { outcome, offline, mind };
}
function messages(body: Record<string, unknown>): { role: string; content: Block[] }[] {
  assert.ok(Array.isArray(body.messages));
  return (body.messages as { role: string; content: string | Block[] }[]).map((m) => ({
    role: m.role, content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content,
  }));
}
function chunks(wire: string): Response {
  const bytes = new TextEncoder().encode(wire);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

// These controls exercise genuine platform fixtures and the existing core, not a replacement adapter.
test("offline transport control records real Request headers and body", async () => {
  const offline = transport();
  const received = await offline.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": KEY }, body: JSON.stringify({ stream: true }),
  });
  assert.equal(await received.text(), sse());
  assert.equal(offline.calls[0]!.headers.get("x-api-key"), KEY);
  assert.deepEqual(offline.calls[0]!.body, { stream: true });
});
test("SSE byte fixture control survives UTF8 fragmentation", async () => {
  const wire = streamed({ type: "text", text: "" }, [{ type: "text_delta", text: "雪🧪" }]);
  assert.equal(await chunks(wire).text(), wire);
});
test("existing core refuses incomplete actionable replies", () => {
  const decision = interpretResponse({ status: "incomplete", providerRequestId: null, usage: null, latencyMs: 0,
    reply: { text: null, refusal: null, toolCalls: [{ callId: "c", name: "wait", arguments: "{}" }] } }, { maximumCommandBytes: 100 });
  assert.equal(decision.kind, "invalid");
  assert.ok(decision.kind === "invalid");
  assert.equal(decision.reason, "incomplete_response");
});

test("one native streaming Opus request: adaptive/high/128000 and explicit drop_block beta", async () => {
  const { outcome, offline } = await invoke(sse());
  const call = offline.calls[0]!;
  assert.equal(call.url, "https://api.anthropic.com/v1/messages");
  assert.equal(call.headers.get("x-api-key"), KEY);
  assert.equal(call.headers.get("anthropic-version"), "2023-06-01");
  assert.match(call.headers.get("content-type") ?? "", /application\/json/);
  assert.ok(call.headers.get("anthropic-beta")?.split(",").map((v) => v.trim()).includes("thinking-binding-controls-2026-08-01"));
  assert.equal(call.body.model, "claude-opus-5-5");
  assert.equal(call.body.max_tokens, 128_000);
  assert.equal(call.body.stream, true);
  assert.deepEqual(call.body.thinking, { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  assert.deepEqual(call.body.output_config, { effort: "high" });
  assert.equal(responded(outcome).providerRequestId, "req_offline");
});
test("instructions and tool schemas unchanged; no coaching, caches, server tools or forced choices", async () => {
  const input = request({ instructions: "verbatim\n  instructions <&>" });
  const { offline } = await invoke(sse(), input);
  const body = offline.calls[0]!.body;
  assert.ok(body.system === input.instructions || JSON.stringify(body.system) === JSON.stringify([{ type: "text", text: input.instructions }]));
  assert.deepEqual(body.tools, TOOLS.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })));
  assert.deepEqual(messages(body), [{ role: "user", content: [{ type: "text", text: input.observation }] }]);
  assert.deepEqual(Object.keys(body).sort(), ["model", "max_tokens", "stream", "system", "tools", "messages", "thinking", "output_config"].sort());
  assert.ok(!JSON.stringify(body).includes(KEY));
  assert.ok(!JSON.stringify(body).includes("cache_control"));
});
test("native assistant tool use and user result remain paired in selected history", async () => {
  const input = request({ tick: 2, history: [{ tick: 1, observation: "old observation", reply: {
    text: "old reply", refusal: null, toolCalls: [{ callId: "old-call", name: "shell", arguments: '{"command":"pwd"}' }],
  }, results: [{ callId: "old-call", output: "old result" }] }] });
  const { offline } = await invoke(sse(), input);
  const sent = messages(offline.calls[0]!.body);
  assert.deepEqual(sent[0], { role: "user", content: [{ type: "text", text: "old observation" }] });
  assert.deepEqual(sent[1], { role: "assistant", content: [{ type: "text", text: "old reply" }, { type: "tool_use", id: "old-call", name: "shell", input: { command: "pwd" } }] });
  assert.equal(sent[2]!.role, "user");
  assert.deepEqual(sent[2]!.content[0], { type: "tool_result", tool_use_id: "old-call", content: "old result" });
  assert.deepEqual(sent.slice(2).flatMap((m) => m.content).slice(1), [{ type: "text", text: input.observation }]);
});
test("adapter retains no private previous calls or hidden conversation", async () => {
  const api = await anthropicAPI();
  const offline = transport([sse([{ type: "text", text: "PRIVATE_PREVIOUS_REPLY" }]), sse()]);
  const mind = api.createAnthropicMind(options(offline.fetch));
  responded(await mind.invoke(request({ observation: "PRIVATE_PREVIOUS_OBSERVATION" }), signal()));
  responded(await mind.invoke(request({ requestId: "second", tick: 2 }), signal()));
  assert.equal(offline.calls.length, 2);
  assert.deepEqual(messages(offline.calls[1]!.body), [{ role: "user", content: [{ type: "text", text: "Synthetic observation." }] }]);
  assert.ok(!JSON.stringify(offline.calls[1]!.body).includes("PRIVATE_PREVIOUS"));
});
for (const [name, env, credentialEnv] of [
  ["absent credential", {}, "ALIFE_PHASE5_TEST_KEY"],
  ["generic credential is not fallback", { ANTHROPIC_API_KEY: KEY }, "ALIFE_PHASE5_TEST_KEY"],
  ["generic credential selector is forbidden", { ANTHROPIC_API_KEY: KEY }, "ANTHROPIC_API_KEY"],
] as const) test(name, async () => {
  const api = await anthropicAPI();
  const offline = transport();
  await assert.rejects(async () => {
    const mind = api.createAnthropicMind(options(offline.fetch, { env, credentialEnv }));
    await mind.invoke(request(), signal());
  });
  assert.equal(offline.calls.length, 0);
});

test("validated invocation commits transport without an awaited preparation gap after loop admission", async () => {
  const api = await anthropicAPI();
  let entered = false;
  const fetch: typeof globalThis.fetch = () => { entered = true; return Promise.resolve(response()); };
  const mind = api.createAnthropicMind(options(fetch));
  const pending = mind.invoke(request(), signal());
  assert.equal(entered, true, "credential, SDK and wire preparations must finish before the loop's final admission check");
  responded(await pending);
});

test("transport errors cannot leak credentials in recorded outcomes", async () => {
  const api = await anthropicAPI();
  let calls = 0;
  const fetch: typeof globalThis.fetch = () => { calls++; return Promise.reject(new Error(`network error x-api-key=${KEY}`)); };
  const outcome = await api.createAnthropicMind(options(fetch)).invoke(request(), signal());
  failed(outcome);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(outcome).includes(KEY));
});
for (const [status, kind] of [[429, "rate_limited"], [500, "server"], [503, "server"], [401, "authentication"]] as const) {
  test(`HTTP ${status} has no retry or recovery turn`, async () => {
    const api = await anthropicAPI();
    let calls = 0;
    const fetch: typeof globalThis.fetch = () => { calls++; return Promise.resolve(new Response('{"error":{"message":"synthetic"}}', { status, headers: { "retry-after": "0" } })); };
    const result = await api.createAnthropicMind(options(fetch)).invoke(request(), signal());
    assert.equal(failed(result).kind, kind);
    assert.equal(calls, 1);
  });
}
test("connection failure is processed unknown and never retried", async () => {
  const api = await anthropicAPI();
  let calls = 0;
  const fetch: typeof globalThis.fetch = () => { calls++; return Promise.reject(new TypeError("synthetic connection reset")); };
  assert.equal(failed(await api.createAnthropicMind(options(fetch)).invoke(request(), signal())).kind, "connection");
  assert.equal(calls, 1);
});
test("already aborted request sends nothing and is processed no", async () => {
  const api = await anthropicAPI();
  const offline = transport();
  const controller = new AbortController();
  controller.abort();
  failed(await api.createAnthropicMind(options(offline.fetch)).invoke(request(), controller.signal), "no");
  assert.equal(offline.calls.length, 0);
});
for (const mode of ["timeout", "abort after send"] as const) test(`${mode} stays processed unknown without retry`, { timeout: 2_000 }, async () => {
  const api = await anthropicAPI();
  const controller = new AbortController();
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls++;
    const sent = new Request(input, init);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("synthetic abort", "AbortError"));
      if (sent.signal.aborted) abort();
      else sent.signal.addEventListener("abort", abort, { once: true });
      if (mode === "abort after send") controller.abort();
    });
  };
  const cleanup = setTimeout(() => controller.abort(), 500);
  try {
    const result = await api.createAnthropicMind(options(fetch, { requestTimeoutMs: 20 })).invoke(request(), controller.signal);
    const failure = failed(result);
    if (mode === "timeout") assert.equal(failure.kind, "timeout");
    assert.equal(calls, 1);
  } finally { clearTimeout(cleanup); controller.abort(); }
});

for (const [stop, status, reason] of [["end_turn", "completed", "text"], ["max_tokens", "incomplete", "incomplete_response"], ["refusal", "refused", "refusal"]] as const) {
  test(`native ${stop} finish is not repaired or reprompted`, async () => {
    const { outcome } = await invoke(sse([{ type: "text", text: "verbatim response" }], { stop }));
    const result = responded(outcome);
    assert.equal(result.status, status);
    assert.equal(result.reply.text, "verbatim response");
    const decision = interpretResponse(result, { maximumCommandBytes: 1024 });
    assert.ok(decision.kind !== "action");
    assert.equal(decision.reason, reason);
  });
}
test("zero tools and empty assistant output remain ordinary no-action", async () => {
  const { outcome } = await invoke(sse([]));
  const result = responded(outcome);
  assert.deepEqual(result.reply.toolCalls, []);
  assert.deepEqual(interpretResponse(result, { maximumCommandBytes: 1024 }), { kind: "no_action", reason: "empty" });
});
test("one native tool call is exposed unchanged for core interpretation", async () => {
  const { outcome } = await invoke(sse([tool], { stop: "tool_use" }));
  const result = responded(outcome);
  assert.deepEqual(result.reply.toolCalls, [{ callId: "call_offline", name: "shell", arguments: JSON.stringify(tool.input) }]);
  assert.deepEqual(interpretResponse(result, { maximumCommandBytes: 1024 }), { kind: "action", callId: "call_offline", intention: { kind: "shell", command: "printf offline" } });
});
test("multiple calls are not truncated to one: core rejects all", async () => {
  const { outcome } = await invoke(sse([tool, { ...tool, id: "call_second" }], { stop: "tool_use" }));
  const result = responded(outcome);
  assert.equal(result.reply.toolCalls.length, 2);
  const decision = interpretResponse(result, { maximumCommandBytes: 1024 });
  assert.ok(decision.kind === "invalid");
  assert.equal(decision.reason, "multiple_actions");
});
test("malformed completed provider tool JSON fails without repair or a replayable partial exchange", async () => {
  const raw = '{"command":';
  const { outcome } = await invoke(streamed({ ...tool, input: {} }, [{ type: "input_json_delta", partial_json: raw }], "tool_use"));
  assert.equal(failed(outcome).kind, "invalid_response");
});
test("valid JSON with invalid body arguments remains an exact paired, nonexecuted tool exchange", async () => {
  const blocks = [{ ...tool, input: { command: 42 } }];
  const { outcome } = await invoke(sse(blocks, { stop: "tool_use" }));
  const result = responded(outcome);
  const decision = interpretResponse(result, { maximumCommandBytes: 1024 });
  assert.ok(decision.kind === "invalid");
  assert.equal(decision.reason, "invalid_arguments");
  const api = await anthropicAPI();
  const next = transport();
  const mind = api.createAnthropicMind(options(next.fetch));
  responded(await mind.invoke(request({ tick: 2, history: [{ tick: 1, observation: "prior", reply: result.reply,
    results: [{ callId: "call_offline", output: "Not executed: invalid_arguments" }] }] }), signal()));
  assert.deepEqual(messages(next.calls[0]!.body).find((m) => m.role === "assistant")!.content, blocks);
  assert.ok(JSON.stringify(next.calls[0]!.body).includes("Not executed: invalid_arguments"));
});
test("native JSON own __proto__ input fields survive response translation unchanged", async () => {
  const input = JSON.parse('{"command":"pwd","__proto__":{"polluted":true}}') as Record<string, unknown>;
  const result = responded((await invoke(sse([{ ...tool, input }], { stop: "tool_use" }))).outcome);
  const parsed = JSON.parse(result.reply.toolCalls[0]!.arguments) as Record<string, unknown>;
  assert.ok(Object.hasOwn(parsed, "__proto__"));
  assert.deepEqual(parsed, input);
});
test("length-limited tool response cannot become actionable", async () => {
  const { outcome } = await invoke(sse([tool], { stop: "max_tokens" }));
  const result = responded(outcome);
  assert.equal(result.status, "incomplete");
  assert.equal(result.reply.toolCalls.length, 1);
  const decision = interpretResponse(result, { maximumCommandBytes: 1024 });
  assert.ok(decision.kind === "invalid");
  assert.equal(decision.reason, "incomplete_response");
});
for (const thinking of [
  { type: "thinking", thinking: "synthetic private reasoning", signature: "opaque+/signature==" },
  { type: "thinking", thinking: "", signature: "empty-visible-but-signed==" },
  { type: "redacted_thinking", data: "redacted+/opaque==" },
]) test(`${thinking.type} ${"thinking" in thinking && thinking.thinking === "" ? "empty visible" : "opaque"} whole-content continuation roundtrips exactly`, async () => {
  const blocks = [thinking, { type: "text", text: "public text" }, tool];
  const { outcome, mind, offline } = await invoke(sse(blocks, { stop: "tool_use" }));
  const result = responded(outcome);
  assert.equal(result.reply.text, "public text");
  const continuation = result.reply.continuation;
  assert.ok(continuation);
  assert.equal(continuation.profile, "anthropic-thinking-v1");
  assert.deepEqual(JSON.parse(continuation.data), blocks);
  assert.ok(Number.isSafeInteger(continuation.inputTokenBound));
  assert.ok(continuation.inputTokenBound > 0);
  // A fresh instance proves replay is carried by the reply rather than private state.
  const api = await anthropicAPI();
  const next = transport();
  const input = request({ tick: 2, history: [{ tick: 1, observation: "prior", reply: result.reply, results: [{ callId: "call_offline", output: "done" }] }] });
  responded(await api.createAnthropicMind(options(next.fetch)).invoke(input, signal()));
  assert.deepEqual(messages(next.calls[0]!.body).find((m) => m.role === "assistant")!.content, blocks);
  assert.equal(offline.calls.length, 1);
  assert.ok(mind.capabilities.toolCalls);
});
test("continuation cannot replace the recorded public tool/text projection with unrelated provider content", async () => {
  const api = await anthropicAPI();
  const io = transport();
  const mind = api.createAnthropicMind(options(io.fetch));
  const forged = request({ tick: 2, history: [{ tick: 1, observation: "old", reply: {
    text: "public", refusal: null, toolCalls: [],
    ...{ continuation: { profile: "anthropic-thinking-v1", data: JSON.stringify([tool]), inputTokenBound: 128_000 } },
  }, results: [] }] });
  assert.throws(() => mind.validate(forged), /continuation|content|projection|tool|mismatch/i);
  assert.equal(io.calls.length, 0);
});

test("real thinking and signature deltas survive one-byte SSE/UTF8 boundaries", async () => {
  const api = await anthropicAPI();
  const wire = streamed({ type: "thinking", thinking: "", signature: "" }, [
    { type: "thinking_delta", thinking: "雪" }, { type: "thinking_delta", thinking: " reasoning" },
    { type: "signature_delta", signature: "opaque+/" }, { type: "signature_delta", signature: "signature==" },
  ]);
  let calls = 0;
  const fetch: typeof globalThis.fetch = () => { calls++; return Promise.resolve(chunks(wire)); };
  const result = responded(await api.createAnthropicMind(options(fetch)).invoke(request(), signal()));
  assert.deepEqual(JSON.parse(result.reply.continuation!.data), [{ type: "thinking", thinking: "雪 reasoning", signature: "opaque+/signature==" }]);
  assert.equal(calls, 1);
});
test("real text and JSON deltas assemble without loss", async () => {
  const wire = streamed({ type: "text", text: "" }, [{ type: "text_delta", text: "雪" }, { type: "text_delta", text: "\ntext" }]);
  assert.equal(responded((await invoke(wire)).outcome).reply.text, "雪\ntext");
  const raw = '{ "command": "printf offline" }';
  const toolWire = streamed({ ...tool, input: {} }, [{ type: "input_json_delta", partial_json: raw.slice(0, 9) }, { type: "input_json_delta", partial_json: raw.slice(9) }], "tool_use");
  assert.equal(responded((await invoke(toolWire)).outcome).reply.toolCalls[0]!.arguments, raw);
});
test("usage includes generated thinking; all numeric provider counters survive", async () => {
  const { outcome } = await invoke(sse([{ type: "thinking", thinking: "hidden", signature: "s" }], { input: 321, output: 98, usage: { reasoning_tokens: 70 } }));
  const usage = responded(outcome).usage;
  assert.ok(usage);
  assert.equal(usage.inputTokens, 321);
  assert.equal(usage.outputTokens, 98);
  assert.deepEqual(usage.reported, { input_tokens: 321, output_tokens: 98, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, reasoning_tokens: 70 });
});
test("provider input transformations are surfaced without pretending thinking was retained", async () => {
  const transformations = [{ type: "drop_block", path: "messages[1].content[0]", reason: "prefix_mismatch" }];
  const { outcome } = await invoke(sse(undefined, { transformations }));
  assert.deepEqual(responded(outcome).inputTransformations, transformations);
});
test("missing usage remains unknown rather than invented zero", async () => {
  const wire = sse().split("\n").map((line) => {
    if (!line.startsWith("data: ")) return line;
    const value = JSON.parse(line.slice(6)) as { usage?: unknown; message?: { usage?: unknown } };
    delete value.usage;
    if (value.message) delete value.message.usage;
    return `data: ${JSON.stringify(value)}`;
  }).join("\n");
  assert.equal(responded((await invoke(wire)).outcome).usage, null);
});
for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) test(`bad input usage ${JSON.stringify(bad)} cannot certify spend`, async () => {
  const { outcome } = await invoke(sse(undefined, { usage: { input_tokens: bad } }));
  if (outcome.outcome === "failed") assert.equal(failed(outcome).kind, "invalid_response");
  else assert.equal(outcome.response.usage, null);
});
test("unexpected cache billing is not silently counted as ordinary input", async () => {
  const { outcome } = await invoke(sse(undefined, { input: 100, usage: { cache_creation_input_tokens: 500, cache_read_input_tokens: 800, cache_creation: { ephemeral_1h_input_tokens: 500 } } }));
  if (outcome.outcome === "failed") assert.equal(failed(outcome).kind, "invalid_response");
  else assert.equal(outcome.response.usage, null, "Phase 5 standard/no-cache mode must leave unsupported spend unknown");
});
test("large permitted streaming response is not silently truncated", async () => {
  const text = "x".repeat(256 * 1024);
  const { outcome } = await invoke(streamed({ type: "text", text: "" }, [{ type: "text_delta", text }]));
  assert.equal(responded(outcome).reply.text, text);
});
test("response-byte bound rejects oversized stream without partial actionable output", async () => {
  const api = await anthropicAPI();
  const offline = transport([sse([tool, { type: "text", text: "x".repeat(8192) }])]);
  const result = await api.createAnthropicMind(options(offline.fetch, { maximumResponseBytes: 2048 })).invoke(request(), signal());
  assert.equal(failed(result).kind, "invalid_response");
  assert.equal(offline.calls.length, 1);
});
for (const mode of ["early EOF", "provider error event", "reader error"] as const) test(`${mode} after tool block never returns partial actionable reply`, async () => {
  const api = await anthropicAPI();
  const wire = sse([tool], { stop: "tool_use" });
  const prefix = wire.slice(0, wire.indexOf("event: message_delta"));
  let calls = 0;
  let pulled = false;
  const fetch: typeof globalThis.fetch = () => {
    calls++;
    if (mode !== "reader error") return Promise.resolve(response(prefix + (mode === "provider error event" ? frame("error", { error: { type: "overloaded_error", message: "synthetic" } }) : "")));
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (!pulled) { pulled = true; controller.enqueue(new TextEncoder().encode(prefix)); }
      else controller.error(new Error("synthetic midstream failure"));
    } }), { headers: { "content-type": "text/event-stream" } }));
  };
  failed(await api.createAnthropicMind(options(fetch)).invoke(request(), signal()));
  assert.equal(calls, 1);
});
test("unsupported provider content fails closed instead of dropping model-visible data", async () => {
  const { outcome } = await invoke(sse([tool, { type: "server_tool_use", id: "server", name: "web_search", input: { query: "offline" } }]));
  assert.equal(failed(outcome).kind, "invalid_response");
});
