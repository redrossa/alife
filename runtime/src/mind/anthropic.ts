import type {
  Continuation,
  InputTransformation,
  MindAdapter,
  MindCapabilities,
  MindFailureKind,
  MindOutcome,
  MindReply,
  MindRequest,
  MindResponse,
  MindStatus,
  ToolCall,
  ToolDefinition,
  Usage,
} from "../core/contracts.ts";
import { anthropicWireBoundEstimator, continuationProblem, MAXIMUM_CONTINUATION_TOKENS } from "../core/tokens.ts";
import { assertRequestInvariants, RequestInvariantError, type RequestBounds } from "./adapter.ts";

// The Anthropic Messages adapter `anthropic-messages-v1` (Phase 5; profile
// text in config/profiles.ts). One streaming HTTPS request per invocation and
// nothing else: no retries at any layer, no follow-up turns, no provider
// conversation state, no private history. What the mind saw of earlier ticks
// arrives in each request's history, and a reply's complete provider content
// (including signed or redacted reasoning) travels as the reply's explicit
// continuation (`anthropic-thinking-v1`), never in adapter state.
//
// The transport is an injected Fetch-compatible function called synchronously
// by `invoke`, before its first await: everything the call needs (the
// credential, the serialized body) is prepared by then, so the caller's final
// admission check immediately precedes the commitment.

export const ANTHROPIC_ADAPTER = "anthropic-messages-v1";
export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const ANTHROPIC_THINKING_BETA = "thinking-binding-controls-2026-08-01";
export const ANTHROPIC_TRANSPORT = `native fetch; anthropic-version ${ANTHROPIC_API_VERSION}; beta ${ANTHROPIC_THINKING_BETA}`;
const CONTINUATION_PROFILE = "anthropic-thinking-v1";

/** Models this adapter drives, with their verified limits. */
const MODELS = { "claude-opus-5-5": { contextTokens: 1_000_000, maximumOutputTokens: 128_000 } } as const;

const MAXIMUM_ERROR_BODY_BYTES = 16 << 10;
const MAXIMUM_TRANSFORMATIONS = 1024;
const MAXIMUM_TRANSFORMATION_FIELD = 1024;
const SUPPORTED_BLOCKS = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);

export interface AnthropicMindOptions {
  readonly model: keyof typeof MODELS;
  /** The ALIFE_-prefixed variable holding the credential; nothing else is ever consulted. */
  readonly credentialEnv: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof globalThis.fetch;
  readonly tools: readonly ToolDefinition[];
  readonly contextBudgetTokens: number;
  readonly contextMarginTokens: number;
  readonly maximumOutputTokens: number;
  readonly reasoningEffort: "high";
  readonly requestTimeoutMs: number;
  /** Bound on the streamed response and on the reply record built from it. */
  readonly maximumResponseBytes: number;
}

export class CredentialUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialUnavailableError";
  }
}

type Block = Record<string, unknown>;

class InvalidResponse extends Error {}

function isRecord(value: unknown): value is Block {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural JSON equality over own keys (an own `__proto__` key included), ignoring key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index] && sameJson(a[key], b[key]));
}

/** The public reply a list of provider content blocks projects to. */
function project(content: readonly Block[]): { readonly text: string | null; readonly toolCalls: readonly { readonly callId: string; readonly name: string; readonly input: unknown }[] } {
  const texts: string[] = [];
  const toolCalls: { callId: string; name: string; input: unknown }[] = [];
  for (const block of content) {
    if (!SUPPORTED_BLOCKS.has(String(block.type))) throw new InvalidResponse(`unsupported content block ${JSON.stringify(block.type)}`);
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new InvalidResponse("a text block has no text");
      texts.push(block.text);
    }
    if (block.type === "tool_use") {
      if (typeof block.id !== "string" || typeof block.name !== "string" || !isRecord(block.input)) throw new InvalidResponse("a tool use block is malformed");
      toolCalls.push({ callId: block.id, name: block.name, input: block.input });
    }
  }
  return { text: texts.length === 0 ? null : texts.join(""), toolCalls };
}

/** The content a retained reply is sent back as: its continuation, which must agree with its public projection. */
function assistantContent(reply: MindReply): Block[] {
  const { continuation } = reply;
  if (continuation === undefined) {
    // A reply without provider state (for example, from another adapter) is sent as its public projection.
    const content: Block[] = [];
    const text = [reply.text, reply.refusal].filter((part): part is string => part !== null && part.length > 0).join("\n");
    if (text.length > 0) content.push({ type: "text", text });
    for (const call of reply.toolCalls) {
      let input: unknown;
      try {
        input = JSON.parse(call.arguments);
      } catch {
        throw new RequestInvariantError([`tool call ${call.callId} has arguments that are not JSON and cannot be sent back`]);
      }
      if (!isRecord(input)) throw new RequestInvariantError([`tool call ${call.callId} has arguments that are not a JSON object`]);
      content.push({ type: "tool_use", id: call.callId, name: call.name, input });
    }
    return content;
  }
  const problem = continuationProblem(continuation);
  if (problem !== null) throw new RequestInvariantError([problem]);
  const content = JSON.parse(continuation.data) as Block[];
  let projected;
  try {
    projected = project(content);
  } catch (error) {
    throw new RequestInvariantError([`continuation content: ${(error as Error).message}`]);
  }
  const mismatch =
    projected.text !== reply.text ||
    reply.refusal !== null ||
    projected.toolCalls.length !== reply.toolCalls.length ||
    projected.toolCalls.some((call, index) => {
      const recorded = reply.toolCalls[index]!;
      if (recorded.callId !== call.callId || recorded.name !== call.name) return true;
      try {
        return !sameJson(JSON.parse(recorded.arguments), call.input);
      } catch {
        return true;
      }
    });
  if (mismatch) throw new RequestInvariantError(["the continuation content does not match the reply's public projection (text and tool calls)"]);
  return content;
}

/** Resolves the credential from exactly the configured ALIFE_ variable of the supplied environment. */
function credential(options: AnthropicMindOptions): string {
  if (!/^ALIFE_[A-Z0-9_]+$/.test(options.credentialEnv)) {
    throw new CredentialUnavailableError(`the credential variable must be ALIFE_-prefixed; ${JSON.stringify(options.credentialEnv)} is not used`);
  }
  const value = options.env[options.credentialEnv];
  if (value === undefined || value.trim().length === 0) {
    throw new CredentialUnavailableError(`the credential environment variable ${options.credentialEnv} is not set; nothing else is consulted`);
  }
  return value;
}

/**
 * Creates the adapter. The credential is resolved here, once, from the
 * configured variable only; a missing one refuses before anything is sent.
 */
export function createAnthropicMind(options: AnthropicMindOptions): MindAdapter {
  const model = MODELS[options.model] as (typeof MODELS)[keyof typeof MODELS] | undefined;
  if (model === undefined) throw new RangeError(`unsupported Anthropic model ${JSON.stringify(options.model)}`);
  if (options.reasoningEffort !== "high") throw new RangeError(`unsupported reasoning effort ${JSON.stringify(options.reasoningEffort)}`);
  if (!Number.isSafeInteger(options.maximumOutputTokens) || options.maximumOutputTokens < 1 || options.maximumOutputTokens > model.maximumOutputTokens) {
    throw new RangeError(`maximum output ${options.maximumOutputTokens} is outside 1–${model.maximumOutputTokens} for ${options.model}`);
  }
  if (options.contextBudgetTokens > model.contextTokens) throw new RangeError(`the context budget exceeds ${model.contextTokens} tokens for ${options.model}`);
  for (const [name, value] of [["requestTimeoutMs", options.requestTimeoutMs], ["maximumResponseBytes", options.maximumResponseBytes]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  return new AnthropicMind(options, credential(options));
}

class AnthropicMind implements MindAdapter {
  readonly id = ANTHROPIC_ADAPTER;
  readonly capabilities: MindCapabilities;
  readonly #options: AnthropicMindOptions;
  readonly #bounds: RequestBounds;
  readonly #headers: Record<string, string>;

  constructor(options: AnthropicMindOptions, key: string) {
    this.#options = options;
    this.capabilities = { toolCalls: true, reportsUsage: true, maximumOutputTokens: options.maximumOutputTokens };
    this.#bounds = {
      tools: options.tools,
      maximumOutputTokens: options.maximumOutputTokens,
      contextBudgetTokens: options.contextBudgetTokens,
      contextMarginTokens: options.contextMarginTokens,
      estimator: anthropicWireBoundEstimator,
    };
    this.#headers = {
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "anthropic-beta": ANTHROPIC_THINKING_BETA,
      "content-type": "application/json",
      accept: "text/event-stream",
    };
  }

  validate(request: MindRequest): void {
    this.#body(request);
  }

  /** The exact Messages request body; throws, sending nothing, for anything it cannot represent faithfully. */
  #body(request: MindRequest): Block {
    assertRequestInvariants(request, this.#bounds);
    const messages: { role: "user" | "assistant"; content: Block[] }[] = [];
    const user = (content: Block[]) => {
      const last = messages.at(-1);
      if (last?.role === "user") last.content.push(...content);
      else messages.push({ role: "user", content });
    };
    let results: Block[] = [];
    for (const exchange of request.history) {
      user([...results, { type: "text", text: exchange.observation }]);
      const content = assistantContent(exchange.reply);
      if (content.length > 0) messages.push({ role: "assistant", content });
      results = exchange.results.map((result) => ({ type: "tool_result", tool_use_id: result.callId, content: result.output }));
    }
    user([...results, { type: "text", text: request.observation }]);
    return {
      model: this.#options.model,
      max_tokens: this.#options.maximumOutputTokens,
      stream: true,
      system: request.instructions,
      tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
      messages,
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      output_config: { effort: this.#options.reasoningEffort },
    };
  }

  invoke(request: MindRequest, signal: AbortSignal): Promise<MindOutcome> {
    let body: string;
    try {
      body = JSON.stringify(this.#body(request));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (signal.aborted) return Promise.resolve(failure("aborted", "no", "the request was aborted before it was sent"));
    const timeout = AbortSignal.timeout(this.#options.requestTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const started = Date.now();
    // The commitment point: called synchronously, with nothing awaited since the caller's admission check.
    let pending: Promise<Response>;
    try {
      pending = this.#options.fetch(ANTHROPIC_ENDPOINT, { method: "POST", headers: this.#headers, body, signal: combined });
    } catch (error) {
      pending = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.#receive(pending, { signal, timeout }, started);
  }

  async #receive(pending: Promise<Response>, signals: { readonly signal: AbortSignal; readonly timeout: AbortSignal }, started: number): Promise<MindOutcome> {
    const interrupted = (error: unknown): MindOutcome => {
      if (signals.timeout.aborted || (error instanceof Error && error.name === "TimeoutError")) {
        return failure("timeout", "unknown", `no complete response within ${this.#options.requestTimeoutMs} ms`);
      }
      if (signals.signal.aborted) return failure("aborted", "unknown", "the request was aborted after it was sent");
      return failure("connection", "unknown", `the connection failed (${error instanceof Error ? error.name : "unknown error"})`);
    };
    let response: Response;
    try {
      response = await pending;
    } catch (error) {
      return interrupted(error);
    }
    const requestId = response.headers.get("request-id");
    if (response.status !== 200) {
      const type = await errorType(response);
      const kind: MindFailureKind =
        response.status === 401 || response.status === 403
          ? "authentication"
          : response.status === 429
            ? "rate_limited"
            : response.status === 408
              ? "timeout"
              : response.status >= 500
                ? "server"
                : "invalid_response";
      // The provider's own message is not recorded: it could echo request content.
      return failure(kind, "unknown", `HTTP ${response.status}${type === null ? "" : ` (${type})`}${requestId === null ? "" : ` request ${clip(requestId)}`}`);
    }
    if (!/^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel().catch(() => undefined);
      return failure("invalid_response", "unknown", "the response is not an event stream");
    }
    try {
      const message = await this.#stream(response);
      return { outcome: "responded", response: { ...message, providerRequestId: requestId === null ? null : clip(requestId), latencyMs: Date.now() - started } };
    } catch (error) {
      if (error instanceof InvalidResponse) return failure("invalid_response", "unknown", `invalid response: ${clip(error.message)}`);
      if (error instanceof ProviderError) return failure(error.kind, "unknown", `the provider ended the stream with an error (${error.type})`);
      return interrupted(error);
    }
  }

  /** Reads the bounded event stream into one complete message; anything short of that throws. */
  async #stream(response: Response): Promise<Omit<MindResponse, "providerRequestId" | "latencyMs">> {
    const body = response.body;
    if (body === null) throw new InvalidResponse("the response has no body");
    const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parser = new StreamParser(this.#options.maximumOutputTokens);
    let received = 0;
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > this.#options.maximumResponseBytes) throw new InvalidResponse(`the stream exceeded ${this.#options.maximumResponseBytes} bytes`);
        try {
          buffer += decoder.decode(value, { stream: true });
        } catch {
          throw new InvalidResponse("the stream is not valid UTF-8");
        }
        buffer = buffer.replace(/\r\n/g, "\n");
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          parser.event(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
      try {
        buffer += decoder.decode();
      } catch {
        throw new InvalidResponse("the stream ends inside a UTF-8 character");
      }
      if (buffer.trim().length > 0) parser.event(buffer);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const message = parser.finish();
    const reply = message.reply;
    if (Buffer.byteLength(JSON.stringify(reply)) > this.#options.maximumResponseBytes) {
      throw new InvalidResponse(`the reply record would exceed ${this.#options.maximumResponseBytes} bytes`);
    }
    return message;
  }
}

class ProviderError extends Error {
  readonly kind: MindFailureKind;
  readonly type: string;

  constructor(type: string) {
    super(type);
    this.type = clip(type);
    this.kind = type === "overloaded_error" ? "unavailable" : type === "rate_limit_error" ? "rate_limited" : type === "authentication_error" ? "authentication" : "server";
  }
}

function failure(kind: MindFailureKind, processed: "no" | "unknown", message: string): MindOutcome {
  return { outcome: "failed", failure: { kind, processed, message } };
}

function clip(value: string, limit = 256): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** The provider's error type, read from a bounded prefix of an error body; never its message. */
async function errorType(response: Response): Promise<string | null> {
  try {
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
    if (reader === undefined) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAXIMUM_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
    const parsed = JSON.parse(Buffer.concat(chunks).subarray(0, MAXIMUM_ERROR_BODY_BYTES).toString("utf8")) as { error?: { type?: unknown } };
    return typeof parsed.error?.type === "string" && /^[a-z_]{1,64}$/.test(parsed.error.type) ? parsed.error.type : null;
  } catch {
    return null;
  }
}

interface PendingBlock {
  readonly block: Block;
  /** Raw tool input JSON accumulated from deltas, when any arrived. */
  json: string | null;
  stopped: boolean;
}

/** Accumulates Messages stream events into one complete message. */
class StreamParser {
  readonly #maximumOutputTokens: number;
  #started = false;
  #stopped = false;
  #stopReason: string | null = null;
  #usage: Block = {};
  #usagePresent = false;
  #transformations: InputTransformation[] | null = null;
  readonly #blocks: PendingBlock[] = [];

  constructor(maximumOutputTokens: number) {
    this.#maximumOutputTokens = maximumOutputTokens;
  }

  event(text: string): void {
    let name: string | null = null;
    const data: string[] = [];
    for (const line of text.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") name = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data.join("\n"));
    } catch {
      throw new InvalidResponse(`an event${name === null ? "" : ` (${name})`} is not JSON`);
    }
    if (!isRecord(payload)) throw new InvalidResponse("an event is not a JSON object");
    const type = typeof payload.type === "string" ? payload.type : name;
    if (this.#stopped && type !== "ping") throw new InvalidResponse(`an event (${String(type)}) follows the end of the message`);
    switch (type) {
      case "ping":
        return;
      case "error": {
        const error = isRecord(payload.error) ? payload.error : {};
        throw new ProviderError(typeof error.type === "string" ? error.type : "error");
      }
      case "message_start":
        return this.#start(payload);
      case "content_block_start":
        return this.#blockStart(payload);
      case "content_block_delta":
        return this.#delta(payload);
      case "content_block_stop":
        return this.#blockStop(payload);
      case "message_delta":
        return this.#messageDelta(payload);
      case "message_stop":
        if (!this.#started) throw new InvalidResponse("the message stopped before it started");
        this.#stopped = true;
        return;
      default:
        // New event types carry no content this adapter would use; content blocks it cannot read fail below.
        return;
    }
  }

  #start(payload: Block): void {
    if (this.#started) throw new InvalidResponse("the message started twice");
    this.#started = true;
    const message = isRecord(payload.message) ? payload.message : null;
    if (message === null) throw new InvalidResponse("message_start has no message");
    if (Array.isArray(message.content) && message.content.length > 0) throw new InvalidResponse("message_start carries content");
    this.#mergeUsage(message.usage);
    if (message.input_transformations !== undefined && message.input_transformations !== null) {
      this.#transformations = transformations(message.input_transformations);
    }
  }

  #mergeUsage(usage: unknown): void {
    if (!isRecord(usage)) return;
    this.#usagePresent = true;
    for (const key of Object.keys(usage)) this.#usage[key] = usage[key];
  }

  #blockStart(payload: Block): void {
    if (!this.#started) throw new InvalidResponse("a content block started before the message");
    const block = payload.content_block;
    if (payload.index !== this.#blocks.length || !isRecord(block)) throw new InvalidResponse("content blocks are out of order or malformed");
    if (!SUPPORTED_BLOCKS.has(String(block.type))) throw new InvalidResponse(`unsupported content block ${JSON.stringify(block.type)}`);
    if (block.type === "text" && block.citations !== undefined && block.citations !== null) throw new InvalidResponse("citations are not supported");
    this.#blocks.push({ block, json: null, stopped: false });
  }

  #current(payload: Block): PendingBlock {
    const pending = typeof payload.index === "number" ? this.#blocks[payload.index] : undefined;
    if (pending === undefined || pending.stopped) throw new InvalidResponse("an event refers to a content block that is not open");
    return pending;
  }

  #delta(payload: Block): void {
    const pending = this.#current(payload);
    const delta = isRecord(payload.delta) ? payload.delta : {};
    const { block } = pending;
    const append = (field: string, value: unknown) => {
      if (typeof value !== "string") throw new InvalidResponse(`a ${String(delta.type)} delta has no text`);
      const existing = block[field];
      block[field] = (typeof existing === "string" ? existing : "") + value;
    };
    switch (delta.type) {
      case "text_delta":
        if (block.type !== "text") throw new InvalidResponse("a text delta for a non-text block");
        return append("text", delta.text);
      case "thinking_delta":
        if (block.type !== "thinking") throw new InvalidResponse("a thinking delta for a non-thinking block");
        return append("thinking", delta.thinking);
      case "signature_delta":
        if (block.type !== "thinking") throw new InvalidResponse("a signature delta for a non-thinking block");
        return append("signature", delta.signature);
      case "input_json_delta":
        if (block.type !== "tool_use" || typeof delta.partial_json !== "string") throw new InvalidResponse("a malformed tool input delta");
        pending.json = (pending.json ?? "") + delta.partial_json;
        return;
      default:
        throw new InvalidResponse(`unsupported delta ${JSON.stringify(delta.type)}`);
    }
  }

  #blockStop(payload: Block): void {
    const pending = this.#current(payload);
    pending.stopped = true;
    const { block } = pending;
    if (block.type === "tool_use" && pending.json !== null && pending.json.length > 0) {
      let input: unknown;
      try {
        input = JSON.parse(pending.json);
      } catch {
        throw new InvalidResponse("a tool call's accumulated input is not valid JSON");
      }
      if (!isRecord(input)) throw new InvalidResponse("a tool call's input is not a JSON object");
      block.input = input;
    }
  }

  #messageDelta(payload: Block): void {
    const delta = isRecord(payload.delta) ? payload.delta : {};
    if (typeof delta.stop_reason === "string") this.#stopReason = delta.stop_reason;
    this.#mergeUsage(payload.usage);
  }

  finish(): Omit<MindResponse, "providerRequestId" | "latencyMs"> {
    if (!this.#started || !this.#stopped) throw new InvalidResponse("the stream ended before the message was complete");
    if (this.#blocks.some((pending) => !pending.stopped)) throw new InvalidResponse("the stream ended inside a content block");
    const status = statusOf(this.#stopReason);
    const content = this.#blocks.map((pending) => pending.block);
    const projected = project(content);
    const toolCalls: ToolCall[] = projected.toolCalls.map((call, index) => {
      const raw = this.#blocks.filter((pending) => pending.block.type === "tool_use")[index]!.json;
      return { callId: call.callId, name: call.name, arguments: raw !== null && raw.length > 0 ? raw : JSON.stringify(call.input) };
    });
    const usage = usageOf(this.#usagePresent ? this.#usage : null);
    const continuation: Continuation = {
      profile: CONTINUATION_PROFILE,
      data: JSON.stringify(content),
      // What the retained reasoning can cost as input again: the call's own output, reasoning included.
      inputTokenBound: Math.min(usage?.outputTokens ?? this.#maximumOutputTokens, this.#maximumOutputTokens, MAXIMUM_CONTINUATION_TOKENS),
    };
    const reply: MindReply = { text: projected.text, refusal: null, toolCalls, continuation };
    return { status, reply, usage, ...(this.#transformations === null ? {} : { inputTransformations: this.#transformations }) };
  }
}

function statusOf(reason: string | null): MindStatus {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "stop_sequence":
      return "completed";
    case "max_tokens":
    case "model_context_window_exceeded":
    case "pause_turn":
      return "incomplete";
    case "refusal":
      return "refused";
    default:
      throw new InvalidResponse(`unknown stop reason ${JSON.stringify(reason)}`);
  }
}

function transformations(value: unknown): InputTransformation[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_TRANSFORMATIONS) throw new InvalidResponse("input transformations are malformed");
  return value.map((item) => {
    if (!isRecord(item)) throw new InvalidResponse("an input transformation is malformed");
    const fields = [item.type, item.path, item.reason];
    if (fields.some((field) => typeof field !== "string" || field.length > MAXIMUM_TRANSFORMATION_FIELD)) {
      throw new InvalidResponse("an input transformation is malformed");
    }
    return { type: item.type as string, path: item.path as string, reason: item.reason as string };
  });
}

/**
 * Usage the ledger can settle on, or null (unknown: the whole reservation is
 * kept). Only the standard, uncached mode is priced: any cache, server-tool,
 * or other service charge makes the usage unknown rather than undercharged.
 */
function usageOf(raw: Block | null): Usage | null {
  if (raw === null) return null;
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const input = raw.input_tokens;
  const output = raw.output_tokens;
  if (!count(input) || !count(output)) return null;
  const nonzero = (value: unknown): boolean =>
    typeof value === "number" ? value !== 0 : isRecord(value) ? Object.values(value).some(nonzero) : false;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "input_tokens" || key === "output_tokens") continue;
    if (/cache|server_tool/.test(key) && nonzero(value)) return null;
    if (key === "service_tier" && value !== null && value !== "standard") return null;
    if (typeof value === "number" && !count(value)) return null;
  }
  const reported: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) if (typeof value === "number") reported[key] = value;
  return { inputTokens: input as number, outputTokens: output as number, reported };
}
