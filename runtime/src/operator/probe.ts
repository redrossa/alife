import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

import type { Clock } from "../core/clock.ts";
import type { Exchange, MindAdapter, MindOutcome, MindRequest, ToolDefinition } from "../core/contracts.ts";
import { messageOf } from "../core/errors.ts";
import { anthropicWireBoundEstimator } from "../core/tokens.ts";
import { microUsd, type CostRates } from "../records/accounting.ts";
import type { Campaign } from "../records/campaign.ts";

// The Phase 5 synthetic compatibility probe (plan §9): at most three live
// requests, under a local time and money cap and the shared spending
// campaign, with synthetic instructions and observations only (never the
// baseline prompt, never world content). It checks, in order, that a reply
// with signed reasoning and a tool call can be sent back with its tool result,
// and what the provider reports when a changed prefix invalidates that
// reasoning (`drop_block`). A case the model does not produce is inconclusive:
// nothing is re-asked or retried.

export const PROBE_LIMITS = { maximumCalls: 3, maximumSeconds: 1800, maximumMicroUsd: 20_000_000 } as const;

const INSTRUCTIONS = "This is a synthetic protocol probe of a research harness, not a task. Follow each message's instruction exactly.";
const CHANGED_INSTRUCTIONS = `${INSTRUCTIONS} (Probe variant: the instructions changed after the earlier turns.)`;
const STEPS = [
  "Probe step 1: call the wait tool exactly once, and write nothing else.",
  "Probe step 2: the wait tool returned. Reply with the single word DONE as text, and call no tool.",
  "Probe step 3: reply with the single word DONE as text, and call no tool.",
] as const;

export interface ProbeOptions {
  readonly mind: MindAdapter;
  readonly rates: CostRates;
  readonly campaign: Campaign;
  readonly tools: readonly ToolDefinition[];
  readonly maximumOutputTokens: number;
  /** A new directory for the probe's private evidence. */
  readonly output: string;
  readonly probeId: string;
  readonly clock: Clock;
  readonly signal: AbortSignal;
}

export interface ProbeStep {
  readonly step: number;
  readonly requestId: string;
  readonly estimatedInputTokens: number;
  readonly reservedMicroUsd: number;
  readonly outcome: "responded" | "failed" | "not_admitted";
  readonly chargedMicroUsd: number;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ProbeReport {
  readonly probeId: string;
  readonly steps: readonly ProbeStep[];
  /** A reply carrying signed reasoning and a tool call was accepted back with its tool result. */
  readonly toolFollowUp: "passed" | "failed" | "inconclusive";
  /** The provider reported what it did with reasoning invalidated by a changed prefix. */
  readonly prefixChange: "transformations_reported" | "no_transformations_reported" | "failed" | "inconclusive";
  /** Whether every reported input count stayed within the conservative estimate. */
  readonly estimateHeld: boolean | null;
  readonly chargedMicroUsd: number;
  readonly evidence: string;
}

function blocks(outcome: MindOutcome): { readonly types: string[]; readonly signed: boolean; readonly toolUse: boolean } {
  if (outcome.outcome !== "responded" || outcome.response.reply.continuation === undefined) return { types: [], signed: false, toolUse: false };
  const content = JSON.parse(outcome.response.reply.continuation.data) as { type?: unknown; signature?: unknown }[];
  const types = content.map((block) => String(block.type));
  return {
    types,
    signed: content.some((block) => (block.type === "thinking" && typeof block.signature === "string" && block.signature.length > 0) || block.type === "redacted_thinking"),
    toolUse: types.includes("tool_use"),
  };
}

/** Runs the probe; writes `probe.jsonl` and `report.json` into a new private directory. */
export async function runAnthropicProbe(options: ProbeOptions): Promise<ProbeReport> {
  await mkdir(options.output, { mode: 0o700 });
  const evidence = path.join(options.output, "probe.jsonl");
  const log = await open(evidence, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const started = options.clock.monotonicMs();
  const steps: ProbeStep[] = [];
  let charged = 0;
  const history: Exchange[] = [];
  const record = async (value: unknown) => {
    await log.write(`${JSON.stringify(value)}\n`);
    await log.datasync();
  };

  /** One admitted request, or null when the caps or the campaign refuse it (nothing is sent then). */
  const call = async (step: number, instructions: string): Promise<MindOutcome | null> => {
    const requestId = `${options.probeId}.step${step}`;
    const request: MindRequest = {
      requestId,
      tick: step,
      instructions,
      tools: options.tools,
      history: [...history],
      observation: STEPS[step - 1]!,
      maximumOutputTokens: options.maximumOutputTokens,
    };
    const estimate = anthropicWireBoundEstimator.request(request);
    const reservation = microUsd(estimate, options.rates.inputUsdPerMillionTokens) + microUsd(options.maximumOutputTokens, options.rates.outputUsdPerMillionTokens);
    const refuse = async (why: string) => {
      steps.push({ step, requestId, estimatedInputTokens: estimate, reservedMicroUsd: reservation, outcome: "not_admitted", chargedMicroUsd: 0, detail: { why } });
      await record({ step, requestId, admitted: false, why });
      return null;
    };
    if (steps.filter((item) => item.outcome !== "not_admitted").length >= PROBE_LIMITS.maximumCalls) return refuse("the probe's call limit is reached");
    if (options.clock.monotonicMs() - started >= PROBE_LIMITS.maximumSeconds * 1000) return refuse("the probe's time limit is reached");
    if (charged + reservation > PROBE_LIMITS.maximumMicroUsd) return refuse("the probe's local spending cap would be exceeded");
    if (options.signal.aborted) return refuse("the operator stopped the probe");
    options.mind.validate(request);
    if ((await options.campaign.reserve({ runId: options.probeId, requestId, maximumMicroUsd: reservation })) === null) return refuse("the shared campaign cannot admit it");
    await record({ step, requestId, admitted: true, estimatedInputTokens: estimate, reservedMicroUsd: reservation, instructions, observation: request.observation, historyTicks: history.map((exchange) => exchange.tick) });
    let outcome: MindOutcome;
    try {
      outcome = await options.mind.invoke(request, options.signal);
    } catch (error) {
      outcome = { outcome: "failed", failure: { kind: "connection", processed: "unknown", message: messageOf(error) } };
    }
    let charge: number;
    if (outcome.outcome === "responded" && outcome.response.usage !== null) {
      const { usage } = outcome.response;
      charge = microUsd(usage.inputTokens, options.rates.inputUsdPerMillionTokens) + microUsd(usage.outputTokens, options.rates.outputUsdPerMillionTokens);
      await options.campaign.settle({ runId: options.probeId, requestId, basis: "usage", chargedMicroUsd: charge });
    } else if (outcome.outcome === "failed" && outcome.failure.processed === "no") {
      charge = 0;
      await options.campaign.settle({ runId: options.probeId, requestId, basis: "not_processed" });
    } else {
      charge = reservation;
      await options.campaign.settle({ runId: options.probeId, requestId, basis: "unknown" });
    }
    charged += charge;
    const shape = blocks(outcome);
    const detail =
      outcome.outcome === "responded"
        ? {
            status: outcome.response.status,
            providerRequestId: outcome.response.providerRequestId,
            latencyMs: outcome.response.latencyMs,
            usage: outcome.response.usage,
            inputTransformations: outcome.response.inputTransformations ?? [],
            blocks: shape.types,
            text: outcome.response.reply.text,
            toolCalls: outcome.response.reply.toolCalls,
            continuationBytes: outcome.response.reply.continuation === undefined ? 0 : Buffer.byteLength(outcome.response.reply.continuation.data),
            reportedInputWithinEstimate: outcome.response.usage === null ? null : outcome.response.usage.inputTokens <= estimate,
          }
        : { failure: outcome.failure };
    steps.push({ step, requestId, estimatedInputTokens: estimate, reservedMicroUsd: reservation, outcome: outcome.outcome, chargedMicroUsd: charge, detail });
    await record({ step, requestId, outcome: outcome.outcome, chargedMicroUsd: charge, ...detail });
    return outcome;
  };

  let toolFollowUp: ProbeReport["toolFollowUp"] = "inconclusive";
  let prefixChange: ProbeReport["prefixChange"] = "inconclusive";
  try {
    const first = await call(1, INSTRUCTIONS);
    const shape = first === null ? null : blocks(first);
    const call1 = first?.outcome === "responded" ? first.response : null;
    // Only a reply with signed reasoning and exactly one wait call makes the follow-up meaningful.
    if (call1 !== null && shape !== null && shape.signed && shape.toolUse && call1.reply.toolCalls.length === 1 && call1.status === "completed") {
      history.push({ tick: 1, observation: STEPS[0], reply: call1.reply, results: [{ callId: call1.reply.toolCalls[0]!.callId, output: "No action was taken.\n" }] });
      const second = await call(2, INSTRUCTIONS);
      if (second !== null) toolFollowUp = second.outcome === "responded" ? "passed" : "failed";
      if (second?.outcome === "responded") {
        history.push({ tick: 2, observation: STEPS[1], reply: second.response.reply, results: [] });
        const third = await call(3, CHANGED_INSTRUCTIONS);
        if (third !== null) {
          prefixChange =
            third.outcome !== "responded"
              ? "failed"
              : (third.response.inputTransformations ?? []).length > 0
                ? "transformations_reported"
                : "no_transformations_reported";
        }
      }
    }
  } finally {
    await log.close();
  }
  const reported = steps.flatMap((step) => (typeof step.detail.reportedInputWithinEstimate === "boolean" ? [step.detail.reportedInputWithinEstimate] : []));
  const report: ProbeReport = {
    probeId: options.probeId,
    steps,
    toolFollowUp,
    prefixChange,
    estimateHeld: reported.length === 0 ? null : reported.every(Boolean),
    chargedMicroUsd: charged,
    evidence,
  };
  const file = await open(path.join(options.output, "report.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  return report;
}
