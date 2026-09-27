import type { ContextAssembly, ContextInput, ContextPolicy, ContextStatus, MindRequest } from "./contracts.ts";
import type { TokenEstimator } from "./tokens.ts";

// Context policy `recent-complete-exchanges-v2` (plan §9.3): the fixed
// instructions, tools, and current observation, then the newest complete
// prior exchanges that fit. Nothing is summarized, retrieved, or reinjected.
// Exchanges are whole units, so a tool call never loses its result.

export const RECENT_COMPLETE_EXCHANGES = "recent-complete-exchanges-v2";

export interface ContextBudget {
  /** Total tokens for input, maximum output, and margin together. */
  readonly budgetTokens: number;
  readonly maximumOutputTokens: number;
  readonly marginTokens: number;
  readonly estimator: TokenEstimator;
}

/** Even the request without history does not fit. Nothing is shrunk or dropped to make it fit. */
export class ContextOverflowError extends Error {
  readonly neededTokens: number;
  readonly availableTokens: number;

  constructor(needed: number, available: number, estimator: string) {
    super(`the request without history needs up to ${needed} input tokens by ${estimator}; ${available} are available`);
    this.name = "ContextOverflowError";
    this.neededTokens = needed;
    this.availableTokens = available;
  }
}

export const RECENT_COMPLETE_EXCHANGES_V3 = "recent-complete-exchanges-v3";

export function recentCompleteExchanges(budget: ContextBudget): ContextPolicy {
  return completeExchanges(budget, RECENT_COMPLETE_EXCHANGES, "x");
}

/**
 * `recent-complete-exchanges-v3`: the same selection, for estimators that
 * size continuation state and JSON escaping. The context line is reserved at
 * its worst-case wire size (a control character escapes to six bytes).
 */
export function recentCompleteExchangesV3(budget: ContextBudget): ContextPolicy {
  return completeExchanges(budget, RECENT_COMPLETE_EXCHANGES_V3, "\u0000");
}

function completeExchanges(budget: ContextBudget, id: string, padding: string): ContextPolicy {
  const { estimator } = budget;
  const available = budget.budgetTokens - budget.maximumOutputTokens - budget.marginTokens;

  return {
    id,
    assemble(input: ContextInput): ContextAssembly {
      const reserve = input.appendix?.maximumBytes ?? 0;
      const request = (history: MindRequest["history"], observation: string): MindRequest => ({
        requestId: input.requestId,
        tick: input.tick,
        instructions: input.instructions,
        tools: input.tools,
        history,
        observation,
        maximumOutputTokens: budget.maximumOutputTokens,
      });

      // Size with the appendix at its maximum. For a byte-bounded estimator, any
      // appendix of at most `reserve` bytes estimates no higher than this padding.
      const sizing = input.observation + padding.repeat(reserve);
      const fixed = estimator.request(request([], sizing));
      if (fixed > available) throw new ContextOverflowError(fixed, available, estimator.id);

      // Add prior exchanges newest first until the next one does not fit. The
      // retained set is always a contiguous suffix: an older exchange is never
      // included in place of a newer one that did not fit.
      let kept = 0;
      let total = fixed;
      for (let index = input.history.length - 1; index >= 0; index--) {
        const cost = estimator.request(request([input.history[index]!], "")) - estimator.request(request([], ""));
        if (total + cost > available) break;
        total += cost;
        kept += 1;
      }
      const retained = input.history.slice(input.history.length - kept);
      const evicted = input.history.slice(0, input.history.length - kept);

      const status: ContextStatus = {
        budgetTokens: budget.budgetTokens,
        maximumOutputTokens: budget.maximumOutputTokens,
        marginTokens: budget.marginTokens,
        estimator: estimator.id,
        estimatedInputTokens: total,
        retainedTicks: retained.map((exchange) => exchange.tick),
        evictedTicks: evicted.map((exchange) => exchange.tick),
      };
      let observation = input.observation;
      if (input.appendix !== null) {
        const text = input.appendix.render(status);
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > reserve) throw new RangeError(`context appendix is ${bytes} bytes; ${reserve} were reserved`);
        observation += text;
      }
      const final = request(retained, observation);
      const estimatedInputTokens = estimator.request(final);
      // The final request can only be smaller than what was sized; anything else is a defect.
      if (estimatedInputTokens > total) {
        throw new Error(`assembled request estimates ${estimatedInputTokens} tokens, above the ${total} it was sized for`);
      }
      return { request: final, status, estimatedInputTokens };
    },
  };
}
