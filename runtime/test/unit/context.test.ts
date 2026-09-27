import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { ContextOverflowError, recentCompleteExchanges } from "../../src/core/context.ts";
import type { ContextInput, Exchange, JobSnapshot, WorldSample } from "../../src/core/contracts.ts";
import {
  actionResultBound,
  clip,
  CONTEXT_APPENDIX_BYTES,
  DETAIL_BYTES,
  observationBound,
  renderActionResult,
  renderContextUsage,
  renderObservation,
} from "../../src/core/observation.ts";
import { utf8BytesEstimator } from "../../src/core/tokens.ts";
import { shellBodyTools } from "../../src/core/tools.ts";
import { CostLedger, microUsd } from "../../src/records/accounting.ts";
import { PROMPTS } from "../support/config.ts";

const tools = shellBodyTools({ actionWaitMs: 1000 });

function exchange(tick: number, bytes: number): Exchange {
  return {
    tick,
    observation: `tick ${tick}`,
    reply: { text: null, refusal: null, toolCalls: [{ callId: `c${tick}`, name: "shell", arguments: '{"command":"ls"}' }] },
    results: [{ callId: `c${tick}`, output: "o".repeat(bytes) }],
  };
}

function input(history: Exchange[], appendix: ContextInput["appendix"] = null): ContextInput {
  return { requestId: "r", tick: history.length + 1, instructions: "instructions", tools, history, observation: "now", appendix };
}

describe("recent-complete-exchanges-v2", () => {
  const budget = { budgetTokens: 12_000, maximumOutputTokens: 1000, marginTokens: 500, estimator: utf8BytesEstimator };
  const policy = recentCompleteExchanges(budget);

  it("keeps the newest whole exchanges that fit and nothing older", () => {
    const history = Array.from({ length: 10 }, (_, index) => exchange(index + 1, 2000));
    const assembly = policy.assemble(input(history));
    const kept = assembly.status.retainedTicks;
    assert.ok(kept.length > 0 && kept.length < 10);
    assert.deepEqual(kept, history.slice(10 - kept.length).map((item) => item.tick));
    assert.deepEqual(assembly.status.evictedTicks, history.slice(0, 10 - kept.length).map((item) => item.tick));
    assert.deepEqual(assembly.request.history, history.slice(10 - kept.length));
    assert.ok(assembly.estimatedInputTokens + budget.maximumOutputTokens + budget.marginTokens <= budget.budgetTokens);
    // Deterministic.
    assert.deepEqual(policy.assemble(input(history)), assembly);
  });

  it("never skips a newer exchange to fit an older, smaller one", () => {
    const history = [exchange(1, 10), exchange(2, 10_000), exchange(3, 10)];
    assert.deepEqual(policy.assemble(input(history)).status.retainedTicks, [3]);
  });

  it("reserves the appendix before choosing history, so its content cannot change what fits", () => {
    const history = Array.from({ length: 10 }, (_, index) => exchange(index + 1, 1500));
    const without = policy.assemble(input(history, { maximumBytes: 2000, render: () => "" }));
    const full = policy.assemble(input(history, { maximumBytes: 2000, render: () => "z".repeat(2000) }));
    assert.deepEqual(full.status, without.status);
    assert.ok(full.estimatedInputTokens <= full.status.estimatedInputTokens);
    assert.ok(full.request.observation.endsWith("z".repeat(2000)));
    assert.throws(() => policy.assemble(input(history, { maximumBytes: 10, render: () => "z".repeat(11) })), /reserved/);
  });

  it("refuses rather than shrinking the request when the fixed part does not fit", () => {
    const tight = recentCompleteExchanges({ ...budget, budgetTokens: 2000 });
    assert.throws(() => tight.assemble(input([])), ContextOverflowError);
  });
});

function sample(overrides: Partial<WorldSample> = {}): WorldSample {
  return {
    sampledAt: "",
    sensorProfile: "baseline-sensors-v4",
    durationMs: 0,
    storage: { available: true, value: { totalBytes: 100, availableBytes: 50, totalInodes: 10, availableInodes: 5 } },
    memory: { available: true, value: { usageBytes: 1, limitBytes: 2 } },
    processes: { available: false, reason: "no statistics" },
    jobs: [],
    listing: null,
    ...overrides,
  };
}

describe("observations", () => {
  it("renders sensors factually, with no directory listing even when one was sampled", () => {
    const text = renderObservation({
      tick: 3,
      elapsedMs: 4500,
      previous: { kind: "not_dispatched", detail: "limit" },
      sample: sample({
        jobs: [
          { jobId: "j1", state: "exited", exitCode: 2, rootPid: 7, stdoutBytes: 3, stderrBytes: 0, output: "complete", observedAt: "2026-09-25T16:14:50.000Z", inspectionFailure: null },
          { jobId: "j2", state: "running", exitCode: null, rootPid: 8, stdoutBytes: 0, stderrBytes: 0, output: "open", observedAt: "2026-09-25T16:14:51.000Z", inspectionFailure: "engine unavailable" },
        ],
        listing: {
          available: true,
          value: {
            entries: [
              { nameBase64: "", name: "a\u001b[2Jb", type: "file", sizeBytes: 4 },
              { nameBase64: "/w==", name: null, type: "other", sizeBytes: null },
            ],
            truncated: true,
          },
        },
      }),
    });
    assert.equal(
      text,
      "Tick 3. This run has been running for 4 s.\n" +
        "Previous outcome: your shell command was not run: limit.\n" +
        "World:\n" +
        "  /world storage: 50 of 100 bytes available, 5 of 10 inodes available\n" +
        "  memory: 1 of 2 bytes in use\n" +
        "  processes: unavailable (no statistics)\n" +
        "Jobs (2 tracked, oldest first):\n" +
        "  j1: exited with status 2, process 7; output complete: stdout 3 bytes, stderr 0 bytes\n" +
        "  j2: running as of 2026-09-25T16:14:51.000Z (the latest inspection failed: engine unavailable), process 8; output being collected: stdout 0 bytes, stderr 0 bytes\n",
    );
  });

  it("stays within its computed bound for hostile, maximal content", () => {
    const limits = { trackedJobs: 5, exposeContextUsage: true };
    const hostile = "\u0001".repeat(255);
    const text = renderObservation({
      tick: 999_999_999,
      elapsedMs: 10 ** 15,
      previous: { kind: "invalid", reason: "invalid_arguments", detail: "d".repeat(10_000) },
      sample: sample({
        storage: { available: false, reason: "r".repeat(10_000) },
        memory: { available: false, reason: "r".repeat(10_000) },
        processes: { available: false, reason: "r".repeat(10_000) },
        jobs: Array.from({ length: 5 }, (_, index) => ({
          jobId: `r-20260925T161449Z-0000000a.t00000${index}.action`,
          state: "uncertain" as const,
          exitCode: null,
          rootPid: null,
          stdoutBytes: 2 ** 40,
          stderrBytes: 2 ** 40,
          output: "closed_after_exit" as const,
          observedAt: "+275760-09-13T00:00:00.000Z",
          inspectionFailure: "f".repeat(10_000),
        })),
        listing: {
          available: true,
          value: { entries: Array.from({ length: 64 }, () => ({ nameBase64: "", name: hostile, type: "file" as const, sizeBytes: 2 ** 40 })), truncated: true },
        },
      }),
    });
    const usage = renderContextUsage(
      { budgetTokens: 2_000_000, maximumOutputTokens: 131_072, marginTokens: 100_000, estimator: "utf8-bytes-v1", estimatedInputTokens: 1_999_999, retainedTicks: [999_998, 999_999], evictedTicks: [1, 999_997] },
      { first: false, inputTokens: 1_999_999 },
      999_999,
    );
    assert.ok(Buffer.byteLength(usage) <= CONTEXT_APPENDIX_BYTES, `${Buffer.byteLength(usage)} bytes`);
    assert.ok(Buffer.byteLength(text) + Buffer.byteLength(usage) <= observationBound(limits));
    assert.ok(Buffer.byteLength(clip("é".repeat(1000))) <= DETAIL_BYTES);
  });

  it("reports what the context holds, distinguishing the estimate from reported usage", () => {
    const status = { budgetTokens: 1000, maximumOutputTokens: 100, marginTokens: 10, estimator: "utf8-bytes-v1", estimatedInputTokens: 800, retainedTicks: [4, 5], evictedTicks: [3] };
    assert.equal(
      renderContextUsage(status, { first: false, inputTokens: 700 }, 2),
      "Context: this request is estimated at no more than 800 input tokens (utf8-bytes-v1, an overestimate); the budget is 1000 tokens including 100 for your reply. The previous request used 700 input tokens as reported.\n" +
        "This request includes your exchanges from ticks 4–5. 3 earlier exchanges are no longer included; tick 3 was dropped for this request.\n",
    );
    assert.match(renderContextUsage({ ...status, retainedTicks: [], evictedTicks: [] }, { first: true, inputTokens: null }, 0), /no previous request in this run\.\nThis request includes none of your earlier exchanges\.\n$/);
  });

  it("renders action results within their bound, showing only the perceived head", () => {
    const retained = new Uint8Array(100).fill(0xff);
    const job: JobSnapshot = {
      jobId: "j",
      execId: "e",
      state: "exited",
      exitCode: 0,
      rootPid: 5,
      startedAt: "",
      exitObservedAt: null,
      observedAt: "",
      stdout: { retained, totalBytes: 5000, truncated: true },
      stderr: { retained: Buffer.from("warn\n"), totalBytes: 5, truncated: false },
      output: "complete",
      detail: null,
      inspectionFailure: null,
    };
    const text = renderActionResult(job, 1200, 64);
    assert.match(text, /^job: j\nstate: exited with status 0\nprocess: 5 \(also its process group\)\noutput: complete\nstdout: 5000 bytes; the first 32 are shown\n�{32}\nstderr: 5 bytes\nwarn\n$/);
    assert.ok(Buffer.byteLength(text) <= actionResultBound(64));
  });
});

describe("shell tool text", () => {
  it("states truthfully that later output is not shown, without advice on managing it", () => {
    const shell = shellBodyTools({ actionWaitMs: 10_000 })[0]!.description;
    assert.match(shell, /later observations report its status and how many bytes of output it produced, but not the output itself/);
    assert.doesNotMatch(shell, /redirect|file|save|>|memory|should/i);
  });
});

describe("cost ledger", () => {
  it("reserves the maximum, charges known usage, keeps unknown outcomes, and rounds up", () => {
    assert.equal(microUsd(3, 0.5), 2);
    const ledger = new CostLedger(0.01, { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, source: "test" });
    const first = ledger.reserve("a", 1000, 1000)!;
    assert.equal(first.microUsd, 3000);
    assert.equal(ledger.remainingMicroUsd, 7000);
    assert.equal(ledger.settle("a", { basis: "usage", inputTokens: 500, outputTokens: 100 }), 700);
    ledger.reserve("b", 1000, 1000);
    assert.equal(ledger.settle("b", { basis: "unknown" }), 3000);
    ledger.reserve("c", 1000, 1000);
    assert.equal(ledger.settle("c", { basis: "not_processed" }), 0);
    assert.equal(ledger.remainingMicroUsd, 10_000 - 3700);
    assert.equal(ledger.reserve("d", 3000, 2000), null);
    assert.deepEqual(ledger.snapshot(), { limitMicroUsd: 10_000, accountedMicroUsd: 3700, outstanding: [] });
    assert.throws(() => ledger.settle("d", { basis: "unknown" }), /no outstanding reservation/);
  });
});

describe("prompts", () => {
  it("differ only in the final sentence between the no-task and assigned-task conditions", async () => {
    const baseline = (await readFile(path.join(PROMPTS, "baseline.txt"), "utf8")).split("\n");
    const assigned = (await readFile(path.join(PROMPTS, "assigned-task.txt"), "utf8")).split("\n");
    assert.deepEqual(assigned.slice(0, 4), baseline.slice(0, 4));
    assert.equal(baseline[4], "No external task or success criterion is supplied.");
    assert.ok(!assigned.join("\n").includes("No external task"));
    assert.match(assigned.slice(4).join("\n"), /^Create \/world\/catalog\.py/);
  });
});
