import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { recentCompleteExchanges } from "../../src/core/context.ts";
import type { MindRequest } from "../../src/core/contracts.ts";
import { parseRunId } from "../../src/core/ids.ts";
import { TickLoop, type LoopSettings, type LoopWorld } from "../../src/core/loop.ts";
import { utf8BytesEstimator } from "../../src/core/tokens.ts";
import { ExecutionSafety } from "../../src/core/execution-safety.ts";
import { ExecGoneError } from "../../src/world/exec.ts";
import { JobTable } from "../../src/world/jobs.ts";
import { shellBodyTools } from "../../src/core/tools.ts";
import { FakeMind, type FakeTurn } from "../../src/mind/fake.ts";
import { CostLedger, FAKE_MIND_RATES, type CostRates } from "../../src/records/accounting.ts";
import { readEventLog, type EventEnvelope } from "../../src/records/events.ts";
import { analyzeEvents } from "../../src/records/finalize.ts";
import { createRunDirectory, readText, RunRecorder, runPaths, type TextRef } from "../../src/records/run-store.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { FakeTransport } from "../support/fake-exec.ts";
import { FakeWorld } from "../support/fake-world.ts";

const RUN = parseRunId("r-20260925T161449Z-0000000a");
const TOOLS = shellBodyTools({ actionWaitMs: 1000 });
const INSTRUCTIONS = "You receive observations from a persistent Linux environment.\n";

interface HarnessOptions {
  readonly world?: FakeWorld;
  /** Replaces the fake world for the loop, e.g. one backed by the real job table. */
  readonly loopWorld?: LoopWorld;
  readonly budget?: number;
  readonly settings?: Partial<LoopSettings>;
  readonly rates?: CostRates;
  readonly limitUsd?: number;
  readonly limitBytes?: number;
}

async function harness(turns: FakeTurn[], options: HarnessOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "alife-loop-"));
  const layout = { root, runs: path.join(root, "runs"), worlds: path.join(root, "worlds"), locks: path.join(root, "locks") };
  await mkdir(layout.runs);
  const paths = runPaths(layout, RUN);
  await createRunDirectory(paths);
  const clock = new FakeClock();
  const records = await RunRecorder.open({ paths, runId: RUN, clock, limitBytes: options.limitBytes ?? 64 << 20 });
  const budget = options.budget ?? 262_144;
  const mind = new FakeMind(
    { schemaVersion: 1, turns },
    { tools: TOOLS, maximumOutputTokens: 1024, contextBudgetTokens: budget, contextMarginTokens: 512, estimator: utf8BytesEstimator },
    { capture: true },
  );
  const world = options.world ?? new FakeWorld();
  // A started world has an execution epoch, as the loop requires.
  await world.start();
  const settings: LoopSettings = {
    runId: RUN,
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    maximumTicks: turns.length,
    deadline: new Date(clock.now().getTime() + 3_600_000),
    maximumConsecutiveProtocolErrors: 5,
    minimumTickIntervalMs: 1000,
    requestTimeoutMs: 60_000,
    maximumOutputTokens: 1024,
    maximumCommandBytes: 8192,
    perceivedOutputBytes: 4096,
    exposeContextUsage: true,
    tickRecordReserveBytes: 1 << 20,
    minimumHostFreeMiB: 0,
    hostFreeMiB: () => Promise.resolve(1_000_000),
    ...options.settings,
  };
  const ledger = new CostLedger(options.limitUsd ?? 0, options.rates ?? FAKE_MIND_RATES);
  const loop = new TickLoop({
    world: options.loopWorld ?? world,
    mind,
    policy: recentCompleteExchanges({ budgetTokens: budget, maximumOutputTokens: 1024, marginTokens: 512, estimator: utf8BytesEstimator }),
    records,
    ledger,
    clock,
    settings,
  });
  const events = async (): Promise<readonly EventEnvelope[]> => {
    const log = await readEventLog(paths.events);
    assert.deepEqual(log.issues, []);
    return log.events;
  };
  const run = async (signal = new AbortController().signal) => {
    try {
      return await loop.run(signal);
    } finally {
      await records.close();
    }
  };
  return { loop, world, mind, records, paths, clock, ledger, events, run };
}

const of = (events: readonly EventEnvelope[], type: string) => events.filter((event) => event.type === type);

/** Every request and action has exactly one recorded outcome, and every reservation is settled. */
function assertAccounted(events: readonly EventEnvelope[]): void {
  const analysis = analyzeEvents(RUN, events, [], false, null);
  assert.deepEqual(analysis.outstanding, { requests: [], actions: [], reservations: [] });
  // Every recorded request has exactly one outcome (a request stopped before sending fails with `sent: false`).
  const requested = of(events, "model.requested").map((event) => event.data.requestId);
  const answered = [...of(events, "model.responded"), ...of(events, "model.failed")]
    .map((event) => event.data.requestId)
    .filter((id) => requested.includes(id));
  assert.deepEqual([...answered].sort(), [...requested].sort());
}

describe("tick loop", () => {
  it("executes shell and wait, records effects before dispatch, and reports results with the call", async () => {
    const h = await harness([{ type: "shell", command: "echo hello" }, { type: "wait" }, { type: "shell", command: "true" }], {
      world: new FakeWorld((command) => (command === "echo hello" ? { stdout: "hello\n" } : { exitCode: 0 })),
    });
    const end = await h.run();
    assert.deepEqual(end, { clean: true, reason: "tick_limit", detail: "3 model calls attempted" });
    assert.deepEqual(h.world.dispatched.map((request) => request.command), ["echo hello", "true"]);

    const [, second, third] = h.mind.requests as [MindRequest, MindRequest, MindRequest];
    const first = second.history[0]!;
    assert.equal(first.tick, 1);
    assert.equal(first.results.length, 1);
    assert.match(first.results[0]!.output, /^job: r-20260925T161449Z-0000000a\.t000001\.action\nstate: exited with status 0\n/);
    assert.match(first.results[0]!.output, /stdout: 6 bytes\nhello\n/);
    assert.match(second.observation, /Previous outcome: your shell command exited with status 0\./);
    assert.equal(third.history[1]!.results[0]!.output, "No action was taken.\n");
    assert.match(third.observation, /Previous outcome: no action \(wait\)\./);

    const events = await h.events();
    // The pre-dispatch record precedes the outcome and is durable.
    const types = events.filter((event) => event.tick === 1).map((event) => event.type);
    assert.deepEqual(types, [
      "observation.sampled",
      "context.assembled",
      "cost.reserved",
      "model.requested",
      "model.responded",
      "cost.reconciled",
      "intention.accepted",
      "action.prepared",
      "action.completed",
      "tick.completed",
    ]);
    assertAccounted(events);
  });

  it("treats text and refusal as valid no-action ticks, never reprompting", async () => {
    const h = await harness([{ type: "text", text: "Looking around." }, { type: "refusal", text: "No." }, { type: "wait" }]);
    assert.equal((await h.run()).reason, "tick_limit");
    assert.equal(h.mind.requests.length, 3);
    assert.equal(h.world.dispatched.length, 0);
    const [, second, third] = h.mind.requests as [MindRequest, MindRequest, MindRequest];
    assert.match(second.observation, /Previous outcome: no action \(a reply without a tool call\)\./);
    assert.match(third.observation, /Previous outcome: no action \(a refusal\)\./);
    assert.deepEqual(third.history.map((exchange) => exchange.results.length), [0, 0]);
    const events = await h.events();
    assert.deepEqual(of(events, "intention.accepted").map((event) => event.data.reason), ["text", "refusal", undefined]);
    assertAccounted(events);
  });

  it("executes nothing for invalid replies, answers every call, and reports the error next tick", async () => {
    const h = await harness([
      { type: "calls", calls: [{ name: "shell", arguments: '{"command":"ls"}' }, { name: "wait", arguments: "{}" }] },
      { type: "calls", calls: [{ name: "browse", arguments: "{}" }] },
      { type: "calls", calls: [{ name: "shell", arguments: "not json" }] },
      { type: "shell", command: "x".repeat(8193) },
      { type: "calls", calls: [{ name: "shell", arguments: '{"command":"ls"}' }], status: "incomplete" },
      { type: "wait" },
    ], { settings: { maximumConsecutiveProtocolErrors: 10 } });
    assert.equal((await h.run()).reason, "tick_limit");
    assert.equal(h.world.dispatched.length, 0);
    const last = h.mind.requests.at(-1)!;
    const results = last.history.map((exchange) => exchange.results.map((result) => result.output));
    assert.deepEqual(results[0], [
      "Not executed: 2 tool calls; at most one is accepted per tick\n",
      "Not executed: 2 tool calls; at most one is accepted per tick\n",
    ]);
    assert.deepEqual(results[1], ['Not executed: no tool named "browse"\n']);
    assert.deepEqual(results[2], ["Not executed: arguments are not valid JSON\n"]);
    assert.deepEqual(results[3], ["Not executed: command is 8193 bytes; the limit is 8192\n"]);
    assert.deepEqual(results[4], ["Not executed: tool call in an incomplete response\n"]);
    assert.match(h.mind.requests[1]!.observation, /Previous outcome: nothing was executed: 2 tool calls; at most one is accepted per tick\./);
    const events = await h.events();
    assert.deepEqual(
      of(events, "intention.rejected").map((event) => event.data.reason),
      ["multiple_actions", "unknown_tool", "invalid_arguments", "command_too_large", "incomplete_response"],
    );
    assert.deepEqual(of(events, "tick.completed").map((event) => event.data.protocolErrorStreak), [1, 2, 3, 4, 5, 0]);
  });

  it("keeps known model calls counted when a later record fails and the tick never completes", async () => {
    for (const [type, turn, counts] of [
      ["model.responded", { type: "wait" }, [1, 1]],
      ["action.completed", { type: "shell", command: "true" }, [1, 1]],
      ["tick.completed", { type: "wait" }, [1, 1]],
      ["model.failed", { type: "failure", kind: "timeout", processed: "unknown" }, [1, 0]],
    ] as const) {
      const h = await harness([turn]);
      const append = h.records.append.bind(h.records);
      h.records.append = (event, data, options) => (event === type ? Promise.reject(new Error("disk full")) : append(event, data, options));
      const end = await h.run();
      assert.equal(end.clean, false, type);
      assert.deepEqual([h.loop.state.attemptedCalls, h.loop.state.respondedCalls], counts, type);
      assert.equal(h.loop.state.completedTicks, 0, type);
      // The durable record cannot confirm what it never received; it says so instead of guessing.
      const calls = analyzeEvents(RUN, await h.events(), [], false, null).calls;
      if (type === "model.responded" || type === "model.failed") assert.deepEqual(calls, { confirmedAttempted: 0, answered: 0, failed: 0, unresolved: 1 }, type);
      else assert.deepEqual(calls, { confirmedAttempted: 1, answered: 1, failed: 0, unresolved: 0 }, type);
    }
  });

  it("clips an oversized tool name instead of failing to record it", async () => {
    const h = await harness([{ type: "calls", calls: [{ name: "n".repeat(300_000), arguments: "{}" }] }, { type: "wait" }]);
    assert.equal((await h.run()).reason, "tick_limit");
    const rejected = of(await h.events(), "intention.rejected")[0]!;
    assert.equal(rejected.data.reason, "unknown_tool");
    assert.ok(Buffer.byteLength(rejected.data.detail as string) < 300);
  });

  it("stops at the consecutive protocol error threshold", async () => {
    const bad: FakeTurn = { type: "calls", calls: [{ name: "nope", arguments: "{}" }] };
    const h = await harness([bad, bad, { type: "wait" }, bad, bad, bad, { type: "wait" }], { settings: { maximumConsecutiveProtocolErrors: 3 } });
    const end = await h.run();
    assert.deepEqual([end.clean, end.reason], [true, "protocol_error_threshold"]);
    assert.equal(h.mind.requests.length, 6);
  });

  it("returns a still-running job without stopping it and reports it in later observations", async () => {
    const h = await harness([{ type: "shell", command: "sleep 100" }, { type: "wait" }], {
      world: new FakeWorld(() => ({ state: "running", stdout: "started\n" })),
    });
    await h.run();
    const result = h.mind.requests[1]!.history[0]!.results[0]!.output;
    assert.match(result, /state: still running after 0 s of waiting; it was not stopped, and later observations report its status\n/);
    assert.match(result, /process: 101 \(also its process group\)\n/);
    assert.match(result, /stdout so far: 8 bytes\nstarted\n/);
    const observation = h.mind.requests[1]!.observation;
    assert.match(observation, /Previous outcome: your shell command was still running as job r-20260925T161449Z-0000000a\.t000001\.action when the wait ended; it was not stopped\./);
    assert.match(observation, /Jobs \(1 tracked, oldest first\):\n {2}r-20260925T161449Z-0000000a\.t000001\.action: running, process 101; output being collected: stdout 8 bytes, stderr 0 bytes\n/);
    const events = await h.events();
    assert.equal(of(events, "action.running").length, 1);
    assertAccounted(events);
  });

  it("reports an admission refusal as a known outcome: nothing ran", async () => {
    const world = new FakeWorld(() => ({ state: "running" }));
    world.admissionLimit = 1;
    const h = await harness([{ type: "shell", command: "sleep 100" }, { type: "shell", command: "sleep 200" }, { type: "wait" }], { world });
    assert.equal((await h.run()).reason, "tick_limit");
    assert.deepEqual(world.dispatched.map((request) => request.command), ["sleep 100"]);
    const last = h.mind.requests[2]!;
    assert.match(last.history[1]!.results[0]!.output, /^Not executed: 1 jobs are running, still collecting output, or finished but not yet reported in an observation; the limit is 1/);
    assert.match(last.observation, /Previous outcome: your shell command was not run: 1 jobs are running, still collecting output/);
    const events = await h.events();
    assert.deepEqual(of(events, "action.refused").map((event) => [event.data.reason, event.data.prepared]), [["admission", false]]);
    assertAccounted(events);
  });

  it("never starts a command whose pre-dispatch record failed, and ends the run for review", async () => {
    const h = await harness([{ type: "shell", command: "touch x" }]);
    const { records } = h;
    const append = records.append.bind(records);
    records.append = (type, data, options) => (type === "action.prepared" ? Promise.reject(new Error("disk full")) : append(type, data, options));
    const end = await h.run();
    assert.deepEqual([end.clean, end.reason], [false, "record_failure"]);
    assert.match(end.detail, /disk full/);
    assert.equal(h.world.dispatched.length, 0);
    assert.equal(h.world.withheld.length, 1);
  });

  it("stops cleanly on a provider failure, keeping the reservation when processing is unknown", async () => {
    const rates = { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, source: "test" };
    const h = await harness([{ type: "wait" }, { type: "failure", kind: "timeout", processed: "unknown" }], { rates, limitUsd: 10 });
    const end = await h.run();
    assert.deepEqual([end.clean, end.reason], [true, "provider_failure"]);
    const events = await h.events();
    const reconciled = of(events, "cost.reconciled");
    assert.deepEqual(reconciled.map((event) => event.data.basis), ["usage", "unknown"]);
    const reserved = of(events, "cost.reserved")[1]!.data.microUsd;
    assert.equal(reconciled[1]!.data.chargedMicroUsd, reserved);
    assert.equal(of(events, "tick.completed").length, 2);
    assert.deepEqual(h.loop.state.previousOutcome, { kind: "model_failed", failure: "timeout" });
    // The failed call is an attempt, not a response.
    assert.deepEqual([h.loop.state.attemptedCalls, h.loop.state.respondedCalls], [2, 1]);
    assert.deepEqual(of(events, "tick.completed").map((event) => [event.data.attempted, event.data.responded]), [[true, true], [true, false]]);
    assert.deepEqual(analyzeEvents(RUN, events, [], false, null).calls, { confirmedAttempted: 2, answered: 1, failed: 1, unresolved: 0 });
    assertAccounted(events);
  });

  it("refuses to send a request whose maximum cost does not fit the remaining spend", async () => {
    const rates = { inputUsdPerMillionTokens: 1000, outputUsdPerMillionTokens: 1000, source: "test" };
    const h = await harness([{ type: "wait" }], { rates, limitUsd: 0.01 });
    const end = await h.run();
    assert.deepEqual([end.clean, end.reason], [true, "spend_limit"]);
    assert.equal(h.mind.requests.length, 0);
    const events = await h.events();
    assert.equal(of(events, "model.requested").length, 0);
    assert.equal(of(events, "cost.reserved").length, 0);
    assert.equal(of(events, "model.failed")[0]!.data.sent, false);
    // Refused before invocation: a tick with its own evidence, but no attempted call.
    assert.deepEqual(of(events, "tick.completed").map((event) => [event.data.outcome, event.data.attempted]), [[{ kind: "request_not_sent", reason: "spend_limit" }, false]]);
    assert.deepEqual([h.loop.state.completedTicks, h.loop.state.attemptedCalls], [1, 0]);
  });

  it("stops before a tick at the deadline, the record reserve, host capacity, or an operator request", async () => {
    const late = await harness([{ type: "wait" }, { type: "wait" }, { type: "wait" }], {
      settings: { minimumTickIntervalMs: 40_000, deadline: new Date(Date.parse("2026-09-25T16:14:49.000Z") + 60_000) },
    });
    const end = await late.run();
    assert.equal(end.reason, "deadline");
    assert.equal(late.mind.requests.length, 2);

    const capacity = await harness([{ type: "wait" }], { settings: { tickRecordReserveBytes: 1 << 30 } });
    assert.equal((await capacity.run()).reason, "record_capacity");
    const host = await harness([{ type: "wait" }], { settings: { minimumHostFreeMiB: 10, hostFreeMiB: () => Promise.resolve(5) } });
    assert.equal((await host.run()).reason, "host_capacity");
    for (const h of [capacity, host]) assert.equal(h.mind.requests.length, 0);

    // A stop requested while observing: nothing is reserved, sent, or evicted for that tick.
    const early = await harness([{ type: "wait" }, { type: "wait" }]);
    const controller = new AbortController();
    early.world.beforeSample = (tick) => {
      if (tick === 2) controller.abort("SIGINT");
    };
    const stoppedEarly = await early.run(controller.signal);
    assert.deepEqual([stoppedEarly.clean, stoppedEarly.reason, stoppedEarly.detail], [true, "operator_stop", "the operator requested a stop before the model request was sent"]);
    assert.equal(early.mind.requests.length, 1);
    assert.equal(early.loop.state.completedTicks, 1);
    const earlyEvents = await early.events();
    assert.equal(of(earlyEvents, "model.requested").length, 1);
    assert.equal(of(earlyEvents, "cost.reserved").length, 1);
    assert.deepEqual(of(earlyEvents, "operator.intervention").map((event) => [event.data.when, event.data.reason]), [["before the model request was sent", "SIGINT"]]);
    assertAccounted(earlyEvents);

    // A stop during the request aborts it; its processing is unknown, so its reservation is kept.
    const inflight = await harness([{ type: "wait" }, { type: "wait" }]);
    const during = new AbortController();
    const invoke = inflight.mind.invoke.bind(inflight.mind);
    inflight.mind.invoke = (request, signal) => {
      during.abort("SIGTERM");
      return invoke(request, signal);
    };
    const stopped = await inflight.run(during.signal);
    assert.deepEqual([stopped.clean, stopped.reason, stopped.detail], [true, "operator_stop", "the operator requested a stop during the model request"]);
    const events = await inflight.events();
    assert.deepEqual(of(events, "model.failed").map((event) => [event.data.kind, event.data.processed]), [["aborted", "unknown"]]);
    assert.deepEqual(of(events, "cost.reconciled").map((event) => event.data.basis), ["unknown"]);
    assert.equal(of(events, "operator.intervention").length, 1);
    assertAccounted(events);
  });

  it("starts no new command once a stop is requested, at any boundary before the effect", async () => {
    for (const [boundary, when, prepared] of [
      ["model.responded", "before the action was dispatched", false],
      ["action.prepared", "before the action was dispatched", true],
    ] as const) {
      const h = await harness([{ type: "shell", command: "echo changed > /world/file" }, { type: "wait" }]);
      const controller = new AbortController();
      const append = h.records.append.bind(h.records);
      h.records.append = async (type, data, options) => {
        const seq = await append(type, data, options);
        if (type === boundary) controller.abort("SIGINT");
        return seq;
      };
      const end = await h.run(controller.signal);
      assert.deepEqual([end.clean, end.reason, end.detail], [true, "operator_stop", `the operator requested a stop ${when}`], boundary);
      assert.deepEqual(h.world.dispatched, [], boundary);
      const events = await h.events();
      assert.deepEqual(of(events, "action.refused").map((event) => [event.data.reason, event.data.prepared]), [["operator_stop", prepared]], boundary);
      assert.equal(of(events, "tick.completed").length, 1);
      assert.equal(of(events, "operator.intervention").length, 1);
      assertAccounted(events);
    }

    // A stop while the request itself is being recorded: it is never sent, so nothing is charged.
    const h = await harness([{ type: "wait" }]);
    const controller = new AbortController();
    const append = h.records.append.bind(h.records);
    h.records.append = async (type, data, options) => {
      const seq = await append(type, data, options);
      if (type === "model.requested") controller.abort("SIGINT");
      return seq;
    };
    const end = await h.run(controller.signal);
    assert.equal(end.detail, "the operator requested a stop before the model request was sent");
    assert.equal(h.mind.requests.length, 0);
    const events = await h.events();
    assert.deepEqual(of(events, "model.failed").map((event) => [event.data.sent, event.data.processed]), [[false, "no"]]);
    assert.deepEqual(of(events, "cost.reconciled").map((event) => [event.data.basis, event.data.chargedMicroUsd]), [["not_processed", 0]]);
    assert.deepEqual(of(events, "tick.completed").map((event) => [event.data.outcome, event.data.attempted]), [[{ kind: "request_not_sent", reason: "operator_stop" }, false]]);
    assert.equal(h.loop.state.attemptedCalls, 0);
    assertAccounted(events);
  });

  it("ends for review, scheduling nothing more, when whether a command ran is unknown", async () => {
    for (const state of ["unconfirmed", "uncertain"] as const) {
      const h = await harness([{ type: "shell", command: "touch /world/x" }, { type: "wait" }], { world: new FakeWorld(() => ({ state })) });
      const end = await h.run();
      assert.deepEqual([end.clean, end.reason], [false, "uncertain_action"], state);
      assert.equal(h.mind.requests.length, 1);
      assert.equal(h.world.dispatched.length, 1);
      const events = await h.events();
      assert.equal(of(events, "action.uncertain").length, 1);
      assert.equal(of(events, "tick.completed").length, 1);
    }
  });

  it("acknowledges finished jobs only once the observation reporting them has been sent", async () => {
    const h = await harness([{ type: "shell", command: "true" }, { type: "wait" }, { type: "wait" }]);
    await h.run();
    const job = `${RUN}.t000001.action`;
    // Tick 1 reported no jobs; ticks 2 and 3 reported the finished job, after their requests were sent.
    assert.deepEqual(h.world.acknowledged, [[], [job], [job]]);

    const stopped = await harness([{ type: "shell", command: "true" }, { type: "wait" }]);
    const controller = new AbortController();
    stopped.world.beforeSample = (tick) => {
      if (tick === 2) controller.abort("SIGINT");
    };
    await stopped.run(controller.signal);
    // Tick 2's observation was never sent, so its report of the finished job was not delivered.
    assert.deepEqual(stopped.world.acknowledged, [[]]);
  });

  describe("a job the engine forgets, with the real job table", () => {
    /** A loop world over the real job table; `lose(sample)` decides when the engine forgets job 1. */
    function tableWorld(lose: (sample: number) => "before" | "after" | null) {
      const transport = new FakeTransport();
      const safety = new ExecutionSafety({ epochId: "loop-epoch", maximumEffects: 3 });
      const table = new JobTable({
        safety,
        transport,
        clock: new FakeClock(),
        actionWaitMs: 1000,
        maximumConcurrentJobs: 2,
        retainedFinishedJobs: 4,
        capturedOutputBytes: 64,
        exitPollIntervalMs: 60_000,
        record: () => Promise.resolve(),
        control: () => Promise.reject(new Error("unused")),
      });
      const fake = new FakeWorld();
      let samples = 0;
      const forget = () => (transport.failInspect = new ExecGoneError("exec-1"));
      const loopWorld: LoopWorld = {
        sample: async (options) => {
          const when = lose(++samples);
          if (when === "before") forget();
          const sampled = { ...(await fake.sample(options)), jobs: await table.summaries() };
          if (when === "after") forget();
          return sampled;
        },
        submit: (request, hooks) => table.submit(request, hooks),
        acknowledgeJobs: (ids) => table.acknowledge(ids),
        safety: () => safety.snapshot(),
        refreshJobSafety: () => table.refreshSafety(),
        inspect: () => Promise.resolve({ identity: fake.identity, container: "running", storageAttached: true }),
      };
      return { transport, table, loopWorld };
    }

    const JOB = `${RUN}.t000001.action`;

    for (const [name, lose, turns, discovered] of [
      ["in the next observation", (n: number) => (n === 2 ? "before" : null), [{ type: "shell", command: "sleep 100" }, { type: "shell", command: "touch /world/x" }], "observation"],
      ["after sampling, by the next command's refresh", (n: number) => (n === 2 ? "after" : null), [{ type: "shell", command: "sleep 100" }, { type: "shell", command: "touch /world/x" }], "dispatch"],
      ["after the last observation, before a clean end", (n: number) => (n === 2 ? "after" : null), [{ type: "shell", command: "sleep 100" }, { type: "wait" }], "before_stop"],
    ] as const) {
      it(`ends for review, starting nothing more, when it is found ${name}`, async () => {
        const { transport, table, loopWorld } = tableWorld(lose);
        try {
          const h = await harness([...turns], { loopWorld });
          const end = await h.run();
          assert.deepEqual([end.clean, end.reason], [false, "uncertain_action"], end.detail);
          assert.equal(transport.created, 1);
          const events = await h.events();
          const analysis = analyzeEvents(RUN, events, [], false, null);
          assert.deepEqual(analysis.uncertainActions.map((action) => [action.actionId, action.state]), [[JOB, "uncertain"]]);
          assert.deepEqual(of(events, "action.uncertain").map((event) => event.data.discovered), [discovered]);
          assert.deepEqual(analysis.outstanding, { requests: [], actions: [], reservations: [] });
        } finally {
          await table.close();
        }
      });
    }
  });

  it("never invokes the mind once uncertainty is established while the request is being recorded", async () => {
    const world = new FakeWorld(() => ({ state: "running" }));
    const h = await harness([{ type: "shell", command: "sleep 100" }, { type: "wait" }], { world, rates: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, source: "test" }, limitUsd: 10 });
    const append = h.records.append.bind(h.records);
    h.records.append = async (type, data, options) => {
      const seq = await append(type, data, options);
      // Established after the pre-request records were awaited, before the invocation.
      if (type === "model.requested" && options?.tick === 2) world.lose(world.jobs[0]!.jobId);
      return seq;
    };
    const end = await h.run();
    assert.deepEqual([end.clean, end.reason], [false, "uncertain_action"]);
    assert.equal(h.mind.requests.length, 1);
    assert.deepEqual([h.loop.state.attemptedCalls, h.loop.state.respondedCalls], [1, 1]);
    const events = await h.events();
    assert.deepEqual(of(events, "model.failed").map((event) => [event.data.kind, event.data.sent, event.data.processed]), [["review_required", false, "no"]]);
    assert.deepEqual(of(events, "cost.reconciled").map((event) => event.data.basis), ["usage", "not_processed"]);
    assert.deepEqual(analyzeEvents(RUN, events, [], false, null).uncertainActions.map((action) => action.actionId), [`${RUN}.t000001.action`]);
    assertAccounted(events);
  });

  it("records a response that was in flight when uncertainty arose, but never executes its command", async () => {
    const world = new FakeWorld(() => ({ state: "running" }));
    const h = await harness([{ type: "shell", command: "sleep 100" }, { type: "shell", command: "touch /world/x" }], { world });
    const invoke = h.mind.invoke.bind(h.mind);
    h.mind.invoke = (request, signal) => {
      // Established while tick 2's call is in flight.
      if (request.tick === 2) world.lose(world.jobs[0]!.jobId);
      return invoke(request, signal);
    };
    const end = await h.run();
    assert.deepEqual([end.clean, end.reason], [false, "uncertain_action"]);
    assert.deepEqual([h.loop.state.attemptedCalls, h.loop.state.respondedCalls], [2, 2]);
    assert.deepEqual(world.dispatched.map((request) => request.command), ["sleep 100"]);
    const events = await h.events();
    assert.deepEqual(of(events, "action.refused").map((event) => [event.data.reason, event.data.prepared]), [["uncertain_jobs", false]]);
    assert.deepEqual(analyzeEvents(RUN, events, [], false, null).uncertainActions.map((action) => action.actionId), [`${RUN}.t000001.action`]);
    assertAccounted(events);
  });

  it("ends for review when the world stops without being asked", async () => {
    const h = await harness([{ type: "wait" }, { type: "wait" }]);
    h.world.beforeSample = () => {
      h.world.container = "stopped";
    };
    const end = await h.run();
    assert.deepEqual([end.clean, end.reason], [false, "world_exit"]);
    assert.equal(h.mind.requests.length, 1);
  });
});

describe("context in the loop", () => {
  it("evicts whole old exchanges for good while the world keeps their effects", async () => {
    const files = new Map<string, string>();
    const world = new FakeWorld((command) => {
      const write = /^printf %s (\S+) > (\S+)$/.exec(command);
      if (write) {
        files.set(write[2]!, write[1]!);
        return { exitCode: 0 };
      }
      const read = /^cat (\S+)$/.exec(command);
      if (read) return files.has(read[1]!) ? { stdout: files.get(read[1]!)! } : { exitCode: 1, stderr: "No such file\n" };
      return { stdout: "y".repeat(3000) };
    });
    const turns: FakeTurn[] = [
      { type: "shell", command: "printf %s remember-me > note.txt" },
      ...Array.from({ length: 8 }, (): FakeTurn => ({ type: "shell", command: "yes y | head -c 3000" })),
      { type: "shell", command: "cat note.txt" },
      { type: "wait" },
    ];
    const h = await harness(turns, { world, budget: 16_384 });
    assert.equal((await h.run()).reason, "tick_limit");

    const final = h.mind.requests.at(-1)!;
    const retained = final.history.map((exchange) => exchange.tick);
    assert.ok(!retained.includes(1), `tick 1 should be evicted, retained ${retained.join(",")}`);
    // The newest exchanges are kept, contiguously.
    assert.deepEqual(retained, Array.from({ length: retained.length }, (_, index) => 11 - retained.length + index));
    assert.match(final.history.at(-1)!.results[0]!.output, /stdout: 11 bytes\nremember-me/);

    // Once evicted, an exchange never returns.
    let evictedSoFar = new Set<number>();
    for (const request of h.mind.requests) {
      const ticks = new Set(request.history.map((exchange) => exchange.tick));
      for (const tick of evictedSoFar) assert.ok(!ticks.has(tick), `tick ${tick} came back in request ${request.tick}`);
      const offered = Array.from({ length: request.tick - 1 }, (_, index) => index + 1);
      evictedSoFar = new Set(offered.filter((tick) => !ticks.has(tick)));
    }
    assert.match(final.observation, /earlier exchanges are no longer included/);

    const events = await h.events();
    const evicted = of(events, "context.evicted").flatMap((event) => event.data.ticks as number[]);
    assert.deepEqual(evicted, Array.from({ length: evicted.length }, (_, index) => index + 1));
    assert.equal(h.loop.state.evictedCount, evicted.length);
    assertAccounted(events);
  });

  it("delivers only instructions, tools, retained exchanges, and the observation, exactly as recorded", async () => {
    const h = await harness([{ type: "shell", command: "echo a" }, { type: "text", text: "hm" }, { type: "wait" }]);
    await h.run();
    const events = await h.events();
    const observations = of(events, "observation.sampled");
    for (const [index, request] of h.mind.requests.entries()) {
      assert.deepEqual(Object.keys(request).sort(), ["history", "instructions", "maximumOutputTokens", "observation", "requestId", "tick", "tools"]);
      assert.equal(request.instructions, INSTRUCTIONS);
      assert.equal(await readText(h.paths, observations[index]!.data.observation as TextRef), request.observation);
      // Each prior exchange is what was delivered then, and what came back.
      for (const exchange of request.history) {
        assert.equal(exchange.observation, h.mind.requests[exchange.tick - 1]!.observation);
      }
    }
    // No directory listing is ever delivered: the agent inspects the filesystem itself.
    for (const request of h.mind.requests) assert.doesNotMatch(request.observation, /Listing|lost\+found/);
    assert.ok(h.world.calls.filter((call) => call.startsWith("sample")).every((call) => call === "sample"));
    assert.match(h.mind.requests[0]!.observation, /There was no previous request in this run\./);
    assert.match(h.mind.requests[1]!.observation, /The previous request used \d+ input tokens as reported\./);
  });

  it("stops cleanly when even the request without history cannot fit", async () => {
    const h = await harness([{ type: "wait" }], { budget: 3000 });
    const end = await h.run();
    assert.deepEqual([end.clean, end.reason], [true, "context_overflow"]);
    assert.equal(h.mind.requests.length, 0);
  });
});
