// Forward Phase 5 contract. No production stubs: absent implementations fail assertions.
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import type { MindAdapter, MindReply, MindRequest, MindResponse } from "../../src/core/contracts.ts";

export interface Continuation {
  readonly profile: "anthropic-thinking-v1";
  /** JSON of the entire provider assistant content array, including signed/redacted thinking. */
  readonly data: string;
  /** Conservative bound for reasoning restored by the opaque blocks, in addition to visible framing. */
  readonly inputTokenBound: number;
}
export type ContinuedReply = MindReply & { readonly continuation?: Continuation };
export type ContinuedResponse = MindResponse & {
  readonly reply: ContinuedReply;
  readonly inputTransformations?: readonly { readonly type: string; readonly path: string; readonly reason: string }[];
};
export interface AnthropicOptions {
  readonly model: "claude-opus-5-5";
  readonly credentialEnv: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof globalThis.fetch;
  readonly tools: MindRequest["tools"];
  readonly contextBudgetTokens: number;
  readonly contextMarginTokens: number;
  readonly maximumOutputTokens: number;
  readonly reasoningEffort: "high";
  readonly requestTimeoutMs: number;
  readonly maximumResponseBytes: number;
}
export interface AnthropicAPI {
  createAnthropicMind(options: AnthropicOptions): MindAdapter;
}
export async function forward<T>(relative: string, exports: readonly string[]): Promise<T> {
  const url = new URL(relative, import.meta.url);
  const exists = await access(url).then(() => true, () => false);
  assert.ok(exists, `Phase 5 missing production module: ${relative}`);
  const api = await import(url.href) as Record<string, unknown>;
  for (const name of exports) assert.equal(typeof api[name], "function", `Phase 5 missing export: ${name}`);
  return api as T;
}
export function anthropicAPI(): Promise<AnthropicAPI> {
  return forward("../../src/mind/anthropic.ts", ["createAnthropicMind"]);
}
export const TOOLS: MindRequest["tools"] = [
  { name: "shell", description: "Execute a shell command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } },
  { name: "wait", description: "Take no action.", parameters: { type: "object", properties: {}, additionalProperties: false } },
];
export const KEY = "phase5-offline-credential-not-a-real-key";
export function request(overrides: Partial<MindRequest> = {}): MindRequest {
  return { requestId: "offline-request-1", tick: 1, instructions: "Synthetic instructions only.", tools: TOOLS, history: [], observation: "Synthetic observation.", maximumOutputTokens: 128_000, ...overrides };
}
export function options(fetch: typeof globalThis.fetch, overrides: Partial<AnthropicOptions> = {}): AnthropicOptions {
  return { model: "claude-opus-5-5", credentialEnv: "ALIFE_PHASE5_TEST_KEY", env: { ALIFE_PHASE5_TEST_KEY: KEY }, fetch, tools: TOOLS,
    contextBudgetTokens: 1_000_000, contextMarginTokens: 512, maximumOutputTokens: 128_000, reasoningEffort: "high", requestTimeoutMs: 1_000,
    maximumResponseBytes: 8 << 20, ...overrides };
}
export type Block = Readonly<Record<string, unknown>>;
export function sse(blocks: readonly Block[] = [{ type: "text", text: "Synthetic response." }], extra: {
  stop?: string; input?: number; output?: number; transformations?: readonly Block[]; usage?: Block;
} = {}): string {
  const frame = (type: string, value: Block) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
  let wire = frame("message_start", { message: { id: "msg_offline", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: extra.input ?? 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...extra.usage },
    ...(extra.transformations ? { input_transformations: extra.transformations } : {}) } });
  blocks.forEach((block, index) => {
    wire += frame("content_block_start", { index, content_block: block });
    wire += frame("content_block_stop", { index });
  });
  wire += frame("message_delta", { delta: { stop_reason: extra.stop ?? "end_turn", stop_sequence: null }, usage: { output_tokens: extra.output ?? 20 } });
  wire += frame("message_stop", {});
  return wire;
}
export function response(wire = sse()): Response {
  return new Response(wire, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_offline" } });
}
export function transport(wires: readonly string[] = [sse()]) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown>; signal: AbortSignal | null | undefined }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const r = new Request(input, init);
    const text = await r.text();
    calls.push({ url: r.url, headers: r.headers, body: JSON.parse(text) as Record<string, unknown>, signal: r.signal });
    const wire = wires[calls.length - 1];
    assert.notEqual(wire, undefined, "offline transport received an extra request (retry or hidden turn)");
    return response(wire);
  };
  return { fetch, calls };
}
