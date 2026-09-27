import { z } from "zod";

import type {
  MindAdapter,
  MindCapabilities,
  MindFailureKind,
  MindOutcome,
  MindReply,
  MindRequest,
  ToolCall,
} from "../core/contracts.ts";
import { SHELL_TOOL, WAIT_TOOL } from "../core/tools.ts";
import { assertRequestInvariants, type RequestBounds } from "./adapter.ts";

// Scripted mind for offline tests and smoke runs. It sends nothing anywhere
// and costs nothing, but enforces the same request invariants as a provider
// adapter, so a harness bug that would leak state or orphan a tool call fails
// here first.

const FAILURE_KINDS = [
  "connection",
  "timeout",
  "rate_limited",
  "authentication",
  "server",
  "invalid_response",
  "unavailable",
] as const satisfies readonly MindFailureKind[];

const turnSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("shell"), command: z.string() }),
  z.strictObject({ type: z.literal("wait") }),
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({ type: z.literal("refusal"), text: z.string() }),
  // Raw calls, for exercising malformed, unknown, and multiple actions.
  z.strictObject({
    type: z.literal("calls"),
    calls: z.array(z.strictObject({ name: z.string(), arguments: z.string() })).max(16),
    text: z.string().optional(),
    status: z.enum(["completed", "incomplete"]).optional(),
  }),
  z.strictObject({
    type: z.literal("failure"),
    kind: z.enum(FAILURE_KINDS),
    processed: z.enum(["no", "unknown"]),
  }),
]);

export const fakeScriptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  turns: z.array(turnSchema).max(100_000),
});

export type FakeScript = z.infer<typeof fakeScriptSchema>;
export type FakeTurn = FakeScript["turns"][number];

export class FakeMind implements MindAdapter {
  readonly id = "fake-v1";
  readonly capabilities: MindCapabilities;
  /**
   * Every request that passed validation, in order, only when constructed with
   * `capture` (test instrumentation). Otherwise empty: the mind keeps nothing
   * between requests, so controller memory stays bounded by the active context.
   */
  readonly requests: MindRequest[] = [];

  readonly #turns: readonly FakeTurn[];
  readonly #bounds: RequestBounds;
  readonly #capture: boolean;

  constructor(script: FakeScript, bounds: RequestBounds, options: { readonly capture?: boolean } = {}) {
    this.#turns = script.turns;
    this.#bounds = bounds;
    this.#capture = options.capture ?? false;
    this.capabilities = { toolCalls: true, reportsUsage: true, maximumOutputTokens: bounds.maximumOutputTokens };
  }

  validate(request: MindRequest): void {
    assertRequestInvariants(request, this.#bounds);
  }

  invoke(request: MindRequest, signal: AbortSignal): Promise<MindOutcome> {
    // Report every failure, including invariant violations, as a rejection.
    return new Promise((resolve) => resolve(this.#respond(request, signal)));
  }

  #respond(request: MindRequest, signal: AbortSignal): MindOutcome {
    signal.throwIfAborted();
    this.validate(request);
    if (this.#capture) this.requests.push(request);

    // Turn N answers tick N: one request per tick, so the script position needs no memory.
    const index = request.tick - 1;
    const turn = this.#turns[index];
    if (turn === undefined) {
      return {
        outcome: "failed",
        failure: { kind: "unavailable", processed: "no", message: `fake script has no turn ${index + 1}` },
      };
    }
    if (turn.type === "failure") {
      return {
        outcome: "failed",
        failure: { kind: turn.kind, processed: turn.processed, message: `scripted ${turn.kind} failure` },
      };
    }

    const call = (name: string, args: string, n: number): ToolCall => ({
      callId: `fake-call-${request.tick}-${n}`,
      name,
      arguments: args,
    });
    let reply: MindReply;
    let status: "completed" | "incomplete" | "refused" = "completed";
    switch (turn.type) {
      case "shell":
        reply = { text: null, refusal: null, toolCalls: [call(SHELL_TOOL, JSON.stringify({ command: turn.command }), 0)] };
        break;
      case "wait":
        reply = { text: null, refusal: null, toolCalls: [call(WAIT_TOOL, "{}", 0)] };
        break;
      case "text":
        reply = { text: turn.text, refusal: null, toolCalls: [] };
        break;
      case "refusal":
        reply = { text: null, refusal: turn.text, toolCalls: [] };
        status = "refused";
        break;
      case "calls":
        reply = {
          text: turn.text ?? null,
          refusal: null,
          toolCalls: turn.calls.map((c, n) => call(c.name, c.arguments, n)),
        };
        status = turn.status ?? "completed";
        break;
    }

    const estimator = this.#bounds.estimator;
    const outputTokens =
      estimator.text(reply.text ?? "") +
      estimator.text(reply.refusal ?? "") +
      reply.toolCalls.reduce((sum, c) => sum + estimator.text(c.name) + estimator.text(c.arguments), 0);
    return {
      outcome: "responded",
      response: {
        providerRequestId: null,
        status,
        reply,
        usage: { inputTokens: estimator.request(request), outputTokens, reported: {} },
        latencyMs: 0,
      },
    };
  }
}
