import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Exchange, MindRequest, MindResponse } from "../../src/core/contracts.ts";
import { interpretResponse } from "../../src/core/intentions.ts";
import { utf8BytesEstimator } from "../../src/core/tokens.ts";
import { shellBodyTools } from "../../src/core/tools.ts";
import { assertRequestInvariants, RequestInvariantError, requestViolations, type RequestBounds } from "../../src/mind/adapter.ts";
import { FakeMind, fakeScriptSchema } from "../../src/mind/fake.ts";

const tools = shellBodyTools({ actionWaitMs: 10_000 });
const bounds: RequestBounds = {
  tools,
  maximumOutputTokens: 1024,
  contextBudgetTokens: 32_768,
  contextMarginTokens: 512,
  estimator: utf8BytesEstimator,
};

function request(overrides: Partial<MindRequest> = {}): MindRequest {
  return {
    requestId: "r-20260925T161449Z-00000000.t000003.request",
    tick: 3,
    instructions: "You receive observations from a persistent Linux environment.",
    tools,
    history: [],
    observation: "tick 3",
    maximumOutputTokens: 1024,
    ...overrides,
  };
}

function exchange(tick: number, calls: string[], results: string[]): Exchange {
  return {
    tick,
    observation: `tick ${tick}`,
    reply: { text: null, refusal: null, toolCalls: calls.map((callId) => ({ callId, name: "wait", arguments: "{}" })) },
    results: results.map((callId) => ({ callId, output: "waited" })),
  };
}

function response(reply: Partial<MindResponse["reply"]>, status: MindResponse["status"] = "completed"): MindResponse {
  return {
    providerRequestId: null,
    status,
    reply: { text: null, refusal: null, toolCalls: [], ...reply },
    usage: null,
    latencyMs: 0,
  };
}

const call = (name: string, args: string) => ({ callId: "c1", name, arguments: args });
const limits = { maximumCommandBytes: 16 };

describe("interpretResponse", () => {
  it("accepts exactly one well-formed shell or wait call", () => {
    assert.deepEqual(interpretResponse(response({ toolCalls: [call("shell", '{"command":"ls -la"}')] }), limits), {
      kind: "action",
      callId: "c1",
      intention: { kind: "shell", command: "ls -la" },
    });
    assert.deepEqual(interpretResponse(response({ toolCalls: [call("wait", "{}")] }), limits), {
      kind: "action",
      callId: "c1",
      intention: { kind: "wait" },
    });
  });

  it("treats text, silence, and refusal as valid inaction", () => {
    assert.deepEqual(interpretResponse(response({ text: "thinking" }), limits), { kind: "no_action", reason: "text" });
    assert.deepEqual(interpretResponse(response({}), limits), { kind: "no_action", reason: "empty" });
    assert.deepEqual(interpretResponse(response({ refusal: "no" }, "refused"), limits), { kind: "no_action", reason: "refusal" });
    // A refusal wins over any accompanying call.
    assert.equal(interpretResponse(response({ refusal: "no", toolCalls: [call("wait", "{}")] }), limits).kind, "no_action");
  });

  it("rejects multiple calls together", () => {
    const decision = interpretResponse(
      response({ toolCalls: [call("wait", "{}"), { callId: "c2", name: "shell", arguments: '{"command":"ls"}' }] }),
      limits,
    );
    assert.equal(decision.kind, "invalid");
    assert.equal(decision.kind === "invalid" && decision.reason, "multiple_actions");
  });

  it("rejects malformed, unknown, oversized, and incomplete calls", () => {
    const reason = (r: MindResponse) => {
      const decision = interpretResponse(r, limits);
      return decision.kind === "invalid" ? decision.reason : decision.kind;
    };
    assert.equal(reason(response({ toolCalls: [call("shell", "{command")] })), "invalid_arguments");
    assert.equal(reason(response({ toolCalls: [call("shell", '"ls"')] })), "invalid_arguments");
    assert.equal(reason(response({ toolCalls: [call("shell", '{"command":"ls","cwd":"/"}')] })), "invalid_arguments");
    assert.equal(reason(response({ toolCalls: [call("shell", '{"command":"  "}')] })), "invalid_arguments");
    assert.equal(reason(response({ toolCalls: [call("shell", '{"command":"a\\u0000b"}')] })), "invalid_arguments");
    assert.equal(reason(response({ toolCalls: [call("wait", '{"seconds":5}')] })), "invalid_arguments");
    assert.equal(reason(response({ toolCalls: [call("python", "{}")] })), "unknown_tool");
    assert.equal(reason(response({ toolCalls: [call("shell", '{"command":"echo 0123456789abcdef"}')] })), "command_too_large");
    assert.equal(reason(response({ toolCalls: [call("wait", "{}")] }, "incomplete")), "incomplete_response");
    assert.equal(reason(response({ text: "partial" }, "incomplete")), "incomplete_response");
  });

  it("counts command size in UTF-8 bytes", () => {
    // Eight characters, sixteen bytes: at the limit.
    const decision = interpretResponse(response({ toolCalls: [call("shell", JSON.stringify({ command: "éééééééé" }))] }), limits);
    assert.equal(decision.kind, "action");
    const over = interpretResponse(response({ toolCalls: [call("shell", JSON.stringify({ command: "ééééééééé" }))] }), limits);
    assert.equal(over.kind, "invalid");
  });
});

describe("request invariants", () => {
  it("accepts a bounded request with paired history", () => {
    assert.deepEqual(requestViolations(request({ history: [exchange(1, ["a"], ["a"]), exchange(2, [], [])] }), bounds), []);
  });

  it("rejects orphaned tool calls and results", () => {
    assert.throws(() => assertRequestInvariants(request({ history: [exchange(1, ["a"], [])] }), bounds), /without a result/);
    assert.throws(() => assertRequestInvariants(request({ history: [exchange(1, [], ["a"])] }), bounds), /without a call/);
    assert.throws(
      () => assertRequestInvariants(request({ history: [exchange(1, ["a"], ["a"]), exchange(2, ["a"], ["a"])] }), bounds),
      /duplicate tool call ID/,
    );
  });

  it("rejects out-of-order or future history", () => {
    assert.match(requestViolations(request({ history: [exchange(2, [], []), exchange(1, [], [])] }), bounds).join(), /out of order/);
    assert.match(requestViolations(request({ history: [exchange(3, [], [])] }), bounds).join(), /out of order/);
  });

  it("rejects history ticks that are not positive safe integers", () => {
    for (const tick of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 2 ** 53]) {
      assert.match(requestViolations(request({ history: [exchange(tick, [], [])] }), bounds).join(), /invalid history tick/, String(tick));
    }
    // An invalid tick does not disable ordering checks for the rest of the history.
    const violations = requestViolations(request({ history: [exchange(Number.NaN, [], []), exchange(2, [], []), exchange(1, [], [])] }), bounds);
    assert.deepEqual(violations, ["invalid history tick NaN", "history tick 1 is out of order"]);
  });

  it("rejects altered tools, output allowance, or empty inputs", () => {
    const violations = (r: MindRequest) => requestViolations(r, bounds).join("; ");
    assert.match(violations(request({ tools: tools.slice(0, 1) })), /tool definitions/);
    assert.match(violations(request({ maximumOutputTokens: 4096 })), /maximum output tokens/);
    assert.match(violations(request({ instructions: " " })), /instructions are empty/);
    assert.match(violations(request({ observation: "" })), /observation is empty/);
  });

  it("rejects a request that does not fit the context budget", () => {
    const error = (() => {
      try {
        assertRequestInvariants(request({ observation: "x".repeat(32_000) }), bounds);
      } catch (e) {
        return e;
      }
      return null;
    })();
    assert.ok(error instanceof RequestInvariantError);
    assert.match(error.violations.join(), /exceed the 32768-token budget \(utf8-bytes-v1\)/);
  });
});

describe("FakeMind", () => {
  const script = fakeScriptSchema.parse({
    schemaVersion: 1,
    turns: [
      { type: "shell", command: "ls" },
      { type: "refusal", text: "no" },
      { type: "calls", calls: [{ name: "wait", arguments: "{}" }, { name: "wait", arguments: "{}" }] },
      { type: "failure", kind: "timeout", processed: "unknown" },
    ],
  });
  const signal = new AbortController().signal;

  it("replays scripted turns, then reports exhaustion as a failure", async () => {
    const mind = new FakeMind(script, bounds, { capture: true });
    const first = await mind.invoke(request({ tick: 1 }), signal);
    assert.equal(first.outcome, "responded");
    assert.deepEqual(first.outcome === "responded" && first.response.reply.toolCalls, [
      { callId: "fake-call-1-0", name: "shell", arguments: '{"command":"ls"}' },
    ]);

    const second = await mind.invoke(request({ tick: 2 }), signal);
    assert.equal(second.outcome === "responded" && second.response.status, "refused");

    const third = await mind.invoke(request({ tick: 3 }), signal);
    assert.equal(third.outcome === "responded" && third.response.reply.toolCalls.length, 2);

    const fourth = await mind.invoke(request({ tick: 4 }), signal);
    assert.deepEqual(fourth.outcome === "failed" && fourth.failure.processed, "unknown");

    const fifth = await mind.invoke(request({ tick: 5 }), signal);
    assert.deepEqual(fifth.outcome === "failed" && fifth.failure.kind, "unavailable");
    assert.equal(mind.requests.length, 5);
  });

  it("validates before accepting a request and records nothing on violation", async () => {
    const mind = new FakeMind(script, bounds, { capture: true });
    await assert.rejects(mind.invoke(request({ history: [exchange(1, ["a"], [])] }), signal), RequestInvariantError);
    assert.equal(mind.requests.length, 0);
  });

  it("honors cancellation before sending", async () => {
    const mind = new FakeMind(script, bounds, { capture: true });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(mind.invoke(request(), controller.signal), { name: "AbortError" });
    assert.equal(mind.requests.length, 0);
  });

  it("keeps no requests unless capturing, and answers each tick with that tick's turn", async () => {
    const mind = new FakeMind(script, bounds);
    const third = await mind.invoke(request({ tick: 3 }), signal);
    assert.equal(third.outcome === "responded" && third.response.reply.toolCalls.length, 2);
    const first = await mind.invoke(request({ tick: 1 }), signal);
    assert.equal(first.outcome === "responded" && first.response.reply.toolCalls[0]!.name, "shell");
    assert.deepEqual(mind.requests, []);
  });

  it("rejects unknown script fields", () => {
    assert.equal(fakeScriptSchema.safeParse({ schemaVersion: 1, turns: [{ type: "wait", seconds: 1 }] }).success, false);
  });
});
