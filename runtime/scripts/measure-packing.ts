// Mechanical context-packing measurement (plan §9.3, Phase 3): runs the real
// tick loop, context policy, and observation rendering against a synthetic
// world and scripted mind, and reports how many complete exchanges each
// budget retains and when eviction begins. It measures mechanics only: the
// fixtures are representative sizes, not agent behavior. Packing uses the
// configured estimator (`utf8-bytes-v1`), which overestimates real token
// counts; retention changes only if a different estimator is declared, not
// because a provider counts fewer tokens. Fake replies are not held to the
// output-token allowance. Nothing is sent anywhere and nothing is written.
//
//   node scripts/measure-packing.ts [ticks]

import { createHash } from "node:crypto";

import type { Clock } from "../src/core/clock.ts";
import { recentCompleteExchanges } from "../src/core/context.ts";
import type { DispatchHooks, JobSnapshot, JobSummary, MindAdapter, WorldSample } from "../src/core/contracts.ts";
import { parseRunId } from "../src/core/ids.ts";
import { TickLoop, type LoopRecords } from "../src/core/loop.ts";
import { utf8BytesEstimator } from "../src/core/tokens.ts";
import { shellBodyTools } from "../src/core/tools.ts";
import { FakeMind, type FakeTurn } from "../src/mind/fake.ts";
import { CostLedger, FAKE_MIND_RATES } from "../src/records/accounting.ts";

const RUN = parseRunId("r-20260926T000000Z-00000000");
const TICKS = Number(process.argv[2] ?? 300);
// The example configuration's body and mind settings (configs/baseline.example.json).
const BODY = { actionWaitMs: 10_000, perceivedOutputBytes: 8192, maximumOutputTokens: 1024, marginTokens: 512 };
const INSTRUCTIONS =
  "You receive observations from a persistent Linux environment.\n" +
  "The available actions are shell and wait. Their schemas describe how to use them.\n" +
  "Action results are provided in subsequent observations.\n" +
  "Your working context is bounded; older exchanges may no longer be available.\n" +
  "No external task or success criterion is supplied.\n";

interface Scenario {
  readonly name: string;
  readonly description: string;
  /** Reply text accompanying each call. */
  readonly replyBytes: number;
  readonly commandBytes: number;
  /** Output per stream; `invalid` output decodes to U+FFFD, three bytes per byte shown. */
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly invalid: boolean;
  /** Jobs listed in every observation. */
  readonly jobs: number;
}

const SCENARIOS: readonly Scenario[] = [
  { name: "quiet", description: "short commands, little output, a few jobs listed", replyBytes: 0, commandBytes: 40, stdoutBytes: 120, stderrBytes: 0, invalid: false, jobs: 2 },
  { name: "typical", description: "some reply text, ~1 KiB of output", replyBytes: 400, commandBytes: 160, stdoutBytes: 1024, stderrBytes: 64, invalid: false, jobs: 8 },
  { name: "heavy", description: "output at the perceived cap on both streams", replyBytes: 1500, commandBytes: 600, stdoutBytes: 65_536, stderrBytes: 65_536, invalid: false, jobs: 36 },
  { name: "hostile", description: "invalid UTF-8 at the cap (3x expansion), maximal reply text", replyBytes: 4096, commandBytes: 8000, stdoutBytes: 65_536, stderrBytes: 65_536, invalid: true, jobs: 36 },
];

const BUDGETS = [1_000_000, 262_144, 131_072];

class ManualClock implements Clock {
  #ms = Date.parse("2026-09-26T00:00:00.000Z");
  #mono = 0;
  now(): Date {
    return new Date(this.#ms);
  }
  monotonicMs(): number {
    return this.#mono;
  }
  sleep(ms: number): Promise<void> {
    this.#ms += ms;
    this.#mono += ms;
    return Promise.resolve();
  }
}

const records: LoopRecords = {
  append: () => Promise.resolve(0),
  text: (value) => Promise.resolve({ sha256: createHash("sha256").update(value).digest("hex"), bytes: Buffer.byteLength(value) }),
  json: (value) => records.text(JSON.stringify(value)),
  remainingBytes: () => Number.MAX_SAFE_INTEGER,
  writable: true,
};

function world(scenario: Scenario) {
  const summaries: JobSummary[] = Array.from({ length: scenario.jobs }, (_, index) => ({
    jobId: `${RUN}.t${String(index + 1).padStart(6, "0")}.action`,
    state: "exited",
    exitCode: 0,
    rootPid: 1000 + index,
    stdoutBytes: scenario.stdoutBytes,
    stderrBytes: scenario.stderrBytes,
    output: "complete",
    observedAt: "2026-09-26T00:00:00.000Z",
    inspectionFailure: null,
  }));
  const fill = (bytes: number) => new Uint8Array(Math.min(bytes, 1 << 20)).fill(scenario.invalid ? 0xff : 0x61);
  return {
    sample: (options: { readonly listing: boolean }): Promise<WorldSample> =>
      Promise.resolve({
        sampledAt: "",
        sensorProfile: "baseline-sensors-v4",
        durationMs: 0,
        storage: { available: true, value: { totalBytes: 134_217_728, availableBytes: 120_000_000, totalInodes: 4096, availableInodes: 3900 } },
        memory: { available: true, value: { usageBytes: 20_000_000, limitBytes: 268_435_456 } },
        processes: { available: true, value: { count: 6, limit: 64 } },
        jobs: summaries,
        listing: options.listing
          ? {
              available: true,
              value: {
                entries: ["lost+found", "materials"].map((name) => ({ nameBase64: Buffer.from(name).toString("base64"), name, type: "directory" as const, sizeBytes: null })),
                truncated: false,
              },
            }
          : null,
      }),
    submit: async (request: { actionId: string }, hooks: DispatchHooks): Promise<JobSnapshot> => {
      await hooks.prepared({ jobId: request.actionId, execId: "exec", containerId: "container" });
      const stdout = fill(scenario.stdoutBytes);
      const stderr = fill(scenario.stderrBytes);
      return {
        jobId: request.actionId,
        execId: "exec",
        state: "exited",
        exitCode: 0,
        rootPid: 4242,
        startedAt: "",
        exitObservedAt: null,
        observedAt: "",
        stdout: { retained: stdout, totalBytes: scenario.stdoutBytes, truncated: false },
        stderr: { retained: stderr, totalBytes: scenario.stderrBytes, truncated: false },
        output: "complete",
        detail: null,
        inspectionFailure: null,
      };
    },
    acknowledgeJobs: () => undefined,
    safety: () => null,
    refreshJobSafety: () => Promise.resolve(),
    inspect: () => Promise.resolve({ identity: {} as never, container: "running" as const, storageAttached: true }),
  };
}

async function measure(scenario: Scenario, budget: number) {
  const tools = shellBodyTools({ actionWaitMs: BODY.actionWaitMs });
  const command = `printf '%s' ${"c".repeat(Math.max(0, scenario.commandBytes - 12))}`;
  const turn: FakeTurn = {
    type: "calls",
    calls: [{ name: "shell", arguments: JSON.stringify({ command }) }],
    ...(scenario.replyBytes > 0 ? { text: "t".repeat(scenario.replyBytes) } : {}),
  };
  const mind = new FakeMind(
    { schemaVersion: 1, turns: Array.from({ length: TICKS }, () => turn) },
    { tools, maximumOutputTokens: BODY.maximumOutputTokens, contextBudgetTokens: budget, contextMarginTokens: BODY.marginTokens, estimator: utf8BytesEstimator },
  );
  // Only the measured numbers are kept per request, not the requests themselves.
  const requests: { tick: number; retained: number; estimate: number; observationBytes: number }[] = [];
  const measured: MindAdapter = {
    id: mind.id,
    capabilities: mind.capabilities,
    validate: (request) => mind.validate(request),
    invoke: (request, signal) => {
      requests.push({
        tick: request.tick,
        retained: request.history.length,
        estimate: utf8BytesEstimator.request(request),
        observationBytes: Buffer.byteLength(request.observation),
      });
      return mind.invoke(request, signal);
    },
  };
  const clock = new ManualClock();
  const loop = new TickLoop({
    world: world(scenario),
    mind: measured,
    policy: recentCompleteExchanges({ budgetTokens: budget, maximumOutputTokens: BODY.maximumOutputTokens, marginTokens: BODY.marginTokens, estimator: utf8BytesEstimator }),
    records,
    ledger: new CostLedger(0, FAKE_MIND_RATES),
    clock,
    settings: {
      runId: RUN,
      instructions: INSTRUCTIONS,
      tools,
      maximumTicks: TICKS,
      deadline: new Date(clock.now().getTime() + 10 * 365 * 86_400_000),
      maximumConsecutiveProtocolErrors: 1000,
      minimumTickIntervalMs: 0,
      requestTimeoutMs: 60_000,
      maximumOutputTokens: BODY.maximumOutputTokens,
      maximumCommandBytes: 8192,
      perceivedOutputBytes: BODY.perceivedOutputBytes,
      exposeContextUsage: true,
      tickRecordReserveBytes: 0,
      minimumHostFreeMiB: 0,
      hostFreeMiB: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    },
  });
  const end = await loop.run(new AbortController().signal);
  const onset = requests.find((request) => request.retained < request.tick - 1)?.tick ?? null;
  const last = requests.at(-1);
  return {
    end: end.reason,
    ticks: requests.length,
    onset,
    retainedAtEnd: last?.retained ?? 0,
    // After eviction begins, the fewest exchanges any request kept; before it, every exchange was kept.
    minimumRetained: onset === null ? (last?.retained ?? 0) : Math.min(...requests.slice(onset - 1).map((request) => request.retained)),
    largestRequest: Math.max(...requests.map((request) => request.estimate)),
    observationBytes: last?.observationBytes ?? 0,
  };
}

console.log(`Context packing, ${TICKS} ticks, packed and measured with ${utf8BytesEstimator.id} (an upper bound on real token counts)`);
console.log(`Body: perceivedOutputBytes ${BODY.perceivedOutputBytes}, maximumOutputTokens ${BODY.maximumOutputTokens}, margin ${BODY.marginTokens}\n`);
console.log("scenario  budget     ticks  eviction onset  retained (min/end)  largest request  observation bytes  end");
for (const scenario of SCENARIOS) {
  for (const budget of BUDGETS) {
    const result = await measure(scenario, budget);
    console.log(
      [
        scenario.name.padEnd(8),
        String(budget).padEnd(10),
        String(result.ticks).padEnd(6),
        (result.onset === null ? "none" : `tick ${result.onset}`).padEnd(15),
        `${result.minimumRetained}/${result.retainedAtEnd}`.padEnd(19),
        String(result.largestRequest).padEnd(16),
        String(result.observationBytes).padEnd(18),
        result.end,
      ].join(" "),
    );
  }
}
console.log("\nScenarios:");
for (const scenario of SCENARIOS) console.log(`  ${scenario.name}: ${scenario.description}`);
