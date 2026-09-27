import { isDeepStrictEqual } from "node:util";

import type { MindRequest, ToolDefinition } from "../core/contracts.ts";
import type { TokenEstimator } from "../core/tokens.ts";

// Request invariants every adapter enforces before transport (plan §9.1). The
// normalized request cannot express provider-side conversation state; each
// provider adapter additionally checks its own serialized body (Phase 5).

export interface RequestBounds {
  readonly tools: readonly ToolDefinition[];
  readonly maximumOutputTokens: number;
  readonly contextBudgetTokens: number;
  readonly contextMarginTokens: number;
  readonly estimator: TokenEstimator;
}

export class RequestInvariantError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`request violates adapter invariants: ${violations.join("; ")}`);
    this.name = "RequestInvariantError";
    this.violations = violations;
  }
}

export function requestViolations(request: MindRequest, bounds: RequestBounds): string[] {
  const violations: string[] = [];

  if (request.instructions.trim().length === 0) violations.push("instructions are empty");
  if (request.observation.length === 0) violations.push("current observation is empty");
  if (!Number.isSafeInteger(request.tick) || request.tick < 1) violations.push(`invalid tick ${request.tick}`);

  if (!isDeepStrictEqual(request.tools, bounds.tools)) {
    violations.push("tool definitions differ from the configured body profile");
  }
  if (request.maximumOutputTokens !== bounds.maximumOutputTokens) {
    violations.push(
      `maximum output tokens ${request.maximumOutputTokens} differ from the configured ${bounds.maximumOutputTokens}`,
    );
  }

  const seenCallIds = new Set<string>();
  let previousTick = 0;
  for (const exchange of request.history) {
    // Validate before comparing: NaN compares false both ways and would skip the ordering checks.
    if (!Number.isSafeInteger(exchange.tick) || exchange.tick < 1) {
      violations.push(`invalid history tick ${exchange.tick}`);
    } else {
      if (exchange.tick <= previousTick || exchange.tick >= request.tick) {
        violations.push(`history tick ${exchange.tick} is out of order`);
      }
      previousTick = exchange.tick;
    }

    const calls = exchange.reply.toolCalls.map((call) => call.callId);
    const results = exchange.results.map((result) => result.callId);
    for (const id of calls) {
      if (seenCallIds.has(id)) violations.push(`duplicate tool call ID ${JSON.stringify(id)}`);
      seenCallIds.add(id);
    }
    if (new Set(results).size !== results.length) {
      violations.push(`tick ${exchange.tick} has duplicate tool results`);
    }
    for (const id of calls) {
      if (!results.includes(id)) violations.push(`tick ${exchange.tick} has a tool call without a result`);
    }
    for (const id of results) {
      if (!calls.includes(id)) violations.push(`tick ${exchange.tick} has a tool result without a call`);
    }
  }

  const estimate = bounds.estimator.request(request);
  const total = estimate + bounds.maximumOutputTokens + bounds.contextMarginTokens;
  if (total > bounds.contextBudgetTokens) {
    violations.push(
      `estimated ${estimate} input + ${bounds.maximumOutputTokens} output + ${bounds.contextMarginTokens} margin ` +
        `tokens exceed the ${bounds.contextBudgetTokens}-token budget (${bounds.estimator.id})`,
    );
  }

  return violations;
}

export function assertRequestInvariants(request: MindRequest, bounds: RequestBounds): void {
  const violations = requestViolations(request, bounds);
  if (violations.length > 0) throw new RequestInvariantError(violations);
}
