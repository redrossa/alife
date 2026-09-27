import type { Continuation, ContinuationProfile, MindRequest, ToolDefinition } from "./contracts.ts";

/**
 * Versioned input-size estimator. An estimate must never be lower than what
 * the provider will count, so budget checks err toward sending less.
 */
export interface TokenEstimator {
  readonly id: string;
  text(value: string): number;
  request(request: MindRequest): number;
}

// Byte-level BPE tokenizers emit at least one byte per token, so UTF-8 length
// bounds the token count of text. Each message, tool call, and tool definition
// also costs a few framing tokens; 32 per item is a generous allowance. This
// overestimates typical English text roughly fourfold; Phase 5 compares it
// against provider-reported counts before any pilot parameter is frozen.
const ITEM_OVERHEAD = 32;

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function toolTokens(tools: readonly ToolDefinition[]): number {
  return tools.reduce((sum, tool) => sum + ITEM_OVERHEAD + bytes(JSON.stringify(tool)), 0);
}

export const utf8BytesEstimator: TokenEstimator = {
  id: "utf8-bytes-v1",
  text: (value) => bytes(value),
  request: (request) => {
    let total = ITEM_OVERHEAD + bytes(request.instructions) + toolTokens(request.tools);
    for (const exchange of request.history) {
      total += ITEM_OVERHEAD + bytes(exchange.observation);
      const { reply } = exchange;
      if (reply.text !== null) total += ITEM_OVERHEAD + bytes(reply.text);
      if (reply.refusal !== null) total += ITEM_OVERHEAD + bytes(reply.refusal);
      for (const call of reply.toolCalls) {
        total += ITEM_OVERHEAD + bytes(call.callId) + bytes(call.name) + bytes(call.arguments);
      }
      for (const result of exchange.results) {
        total += ITEM_OVERHEAD + bytes(result.callId) + bytes(result.output);
      }
    }
    return total + ITEM_OVERHEAD + bytes(request.observation);
  },
};

/** The largest reasoning a continuation can restore: the selected models' generated-token ceiling. */
export const MAXIMUM_CONTINUATION_TOKENS = 128_000;
export const CONTINUATION_PROFILES: readonly ContinuationProfile[] = ["anthropic-thinking-v1"];

/** Why a reply's continuation cannot be accounted for, or null. Malformed state is refused, never estimated. */
export function continuationProblem(continuation: Continuation): string | null {
  if (!(CONTINUATION_PROFILES as readonly string[]).includes(continuation.profile)) return `unknown continuation profile ${JSON.stringify(continuation.profile)}`;
  const bound = continuation.inputTokenBound;
  if (!Number.isSafeInteger(bound) || bound < 0 || bound > MAXIMUM_CONTINUATION_TOKENS) return `continuation token bound ${String(bound)} is out of range`;
  if (typeof continuation.data !== "string") return "continuation data is not a string";
  let value: unknown;
  try {
    value = JSON.parse(continuation.data);
  } catch {
    return "continuation data is not JSON";
  }
  if (!Array.isArray(value) || value.some((block) => typeof block !== "object" || block === null || Array.isArray(block))) {
    return "continuation data is not an array of content blocks";
  }
  return null;
}

// Wire-level framing per item (role, block type, IDs, separators): a generous allowance.
const WIRE_ITEM = 64;
/** Bytes of a string as a JSON string literal: escaping included. */
function wire(value: string): number {
  return bytes(JSON.stringify(value));
}

/**
 * `anthropic-wire-bound-v1`: every text at its JSON-escaped wire size, a
 * framing allowance per item, and each retained continuation at its serialized
 * size plus its declared reasoning bound. Conservative double counting of a
 * reply's public projection alongside its continuation is deliberate.
 */
export const anthropicWireBoundEstimator: TokenEstimator = {
  id: "anthropic-wire-bound-v1",
  text: (value) => wire(value),
  request: (request) => {
    let total = 4 * WIRE_ITEM + wire(request.instructions);
    for (const tool of request.tools) {
      total += WIRE_ITEM + bytes(JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    }
    for (const exchange of request.history) {
      total += WIRE_ITEM + wire(exchange.observation);
      const { reply } = exchange;
      if (reply.text !== null) total += WIRE_ITEM + wire(reply.text);
      if (reply.refusal !== null) total += WIRE_ITEM + wire(reply.refusal);
      for (const call of reply.toolCalls) total += WIRE_ITEM + wire(call.callId) + wire(call.name) + wire(call.arguments);
      for (const result of exchange.results) total += WIRE_ITEM + wire(result.callId) + wire(result.output);
      if (reply.continuation !== undefined) {
        const problem = continuationProblem(reply.continuation);
        if (problem !== null) throw new RangeError(`tick ${exchange.tick}: ${problem}`);
        total += WIRE_ITEM + bytes(reply.continuation.data) + reply.continuation.inputTokenBound;
      }
    }
    return total + WIRE_ITEM + wire(request.observation);
  },
};

export function tokenEstimator(id: string): TokenEstimator {
  if (id === utf8BytesEstimator.id) return utf8BytesEstimator;
  if (id === anthropicWireBoundEstimator.id) return anthropicWireBoundEstimator;
  throw new RangeError(`unknown token estimator ${JSON.stringify(id)}`);
}
