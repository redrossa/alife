import type { ResolvedConfig } from "../config/resolve.ts";
import type { MindAdapter } from "../core/contracts.ts";
import { tokenEstimator } from "../core/tokens.ts";
import { FAKE_MIND_RATES, type CostRates } from "../records/accounting.ts";
import type { RequestBounds } from "./adapter.ts";
import { createAnthropicMind } from "./anthropic.ts";
import { FakeMind } from "./fake.ts";

/** The bounds every adapter enforces on a request, from the resolved configuration. */
export function requestBounds(resolved: ResolvedConfig): RequestBounds {
  const { body, mind } = resolved.config;
  return {
    tools: resolved.tools,
    maximumOutputTokens: mind.maximumOutputTokens,
    contextBudgetTokens: body.contextBudgetTokens,
    contextMarginTokens: body.contextMarginTokens,
    estimator: tokenEstimator(body.tokenEstimator),
  };
}

export class MindUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MindUnavailableError";
  }
}

/**
 * The largest streamed response, and reply record, a call may produce: 128
 * bytes per generated token covers the stream's per-delta framing, plus a
 * fixed allowance for the message envelope. Record reserves use the same bound.
 */
export function responseBytesBound(maximumOutputTokens: number): number {
  return 128 * maximumOutputTokens + (1 << 20);
}

/** What a live adapter needs from the controller; defaults are the process environment and global fetch. */
export interface MindDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The configured mind and the rates its requests are reserved at. The live
 * adapter reads only its configured ALIFE_ credential variable; a missing one
 * refuses here, before anything else happens.
 */
export function createMind(resolved: ResolvedConfig, dependencies: MindDependencies = {}): { readonly mind: MindAdapter; readonly rates: CostRates } {
  const { mind } = resolved.config;
  if (mind.provider === "anthropic") {
    const { costBound } = mind;
    if (costBound.inputUsdPerMillionTokens === null || costBound.outputUsdPerMillionTokens === null) {
      throw new MindUnavailableError("the configured cost bound is incomplete; paid execution is blocked");
    }
    const adapter = createAnthropicMind({
      model: mind.model,
      credentialEnv: mind.credentialEnv,
      env: dependencies.env ?? process.env,
      fetch: dependencies.fetch ?? globalThis.fetch,
      tools: resolved.tools,
      contextBudgetTokens: resolved.config.body.contextBudgetTokens,
      contextMarginTokens: resolved.config.body.contextMarginTokens,
      maximumOutputTokens: mind.maximumOutputTokens,
      reasoningEffort: mind.reasoningEffort,
      requestTimeoutMs: mind.requestTimeoutMs,
      maximumResponseBytes: responseBytesBound(mind.maximumOutputTokens),
    });
    return {
      mind: adapter,
      rates: {
        inputUsdPerMillionTokens: costBound.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: costBound.outputUsdPerMillionTokens,
        source: costBound.source,
        ...(costBound.verifiedOn === null ? {} : { verifiedOn: costBound.verifiedOn }),
      },
    };
  }
  if (mind.provider !== "fake" || resolved.fakeScript === null) {
    throw new MindUnavailableError("the OpenAI adapter is not implemented; only the fake and Anthropic minds are");
  }
  return { mind: new FakeMind(resolved.fakeScript.script, requestBounds(resolved)), rates: FAKE_MIND_RATES };
}
