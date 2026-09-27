import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import type { DispatchHooks, DispatchIdentity } from "../../src/core/contracts.ts";
import { EngineResponseError, EngineUnavailableError } from "../../src/world/engine.ts";
import { ExecGoneError, runControl, type ControlResult } from "../../src/world/exec.ts";
import { DispatchRefusedError, JobAdmissionError, JobTable, launchCommand, UncertainJobsError, UnknownJobError, type JobEventType } from "../../src/world/jobs.ts";
import { JsonlEventLog, readEventLog, WORLD_EVENT_TYPES } from "../../src/records/events.ts";
import { ExecutionSafety } from "../../src/core/execution-safety.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { FakeTransport, frame } from "../support/fake-exec.ts";

interface Recorded {
  readonly type: JobEventType;
  readonly data: Readonly<Record<string, unknown>>;
  readonly durable: boolean;
}

/** A promise the test resolves when it chooses, to hold an operation at an await boundary. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

function setup(
  options: {
    maximumConcurrentJobs?: number;
    retainedFinishedJobs?: number;
    capturedOutputBytes?: number;
    previouslyPrepared?: string[];
    record?: (type: JobEventType, data: Readonly<Record<string, unknown>>, durable: boolean) => Promise<void>;
  } = {},
) {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const events: Recorded[] = [];
  const controls: (readonly string[])[] = [];
  let controlResult: ControlResult = { exitCode: 0, stdout: Buffer.from('{"result":"sent"}'), stderr: Buffer.alloc(0), overflow: false, timedOut: false };
  const safety = new ExecutionSafety({ epochId: "test-epoch", maximumEffects: (options.maximumConcurrentJobs ?? 2) + 1 });
  const table = new JobTable({
    safety,
    transport,
    clock,
    actionWaitMs: 1_000,
    maximumConcurrentJobs: options.maximumConcurrentJobs ?? 2,
    retainedFinishedJobs: options.retainedFinishedJobs ?? 4,
    capturedOutputBytes: options.capturedOutputBytes ?? 16,
    outputCloseAfterExitMs: 20,
    exitPollIntervalMs: 10,
    ...(options.previouslyPrepared === undefined ? {} : { previouslyPrepared: options.previouslyPrepared }),
    record: (type, data, durable) => {
      events.push({ type, data, durable });
      return options.record?.(type, data, durable) ?? Promise.resolve();
    },
    control: (cmd, _timeoutMs, admit) => {
      // As runControl does: the admission check sits between creating and starting the command.
      const denial = admit?.() ?? null;
      if (denial !== null) return Promise.reject(denial);
      controls.push(cmd);
      return Promise.resolve(controlResult);
    },
  });
  const prepared: DispatchIdentity[] = [];
  const hooks: DispatchHooks = {
    prepared: (identity) => {
      prepared.push(identity);
      return Promise.resolve();
    },
  };
  return {
    safety,
    transport,
    clock,
    events,
    controls,
    table,
    prepared,
    hooks,
    setControlResult: (result: ControlResult) => (controlResult = result),
  };
}

const MARKER = (pid: number) => frame("stderr", `alife-job ${pid} 123456\n`);

/** What the loop does each tick: summarize, deliver, then acknowledge the jobs reported finished. */
async function observe(table: JobTable) {
  const jobs = await table.summaries();
  table.acknowledge(jobs.filter((job) => job.state === "exited" && job.output !== "open").map((job) => job.jobId));
  return jobs;
}

describe("JobTable", () => {
  it("returns a still-running job after the bounded wait without terminating or rerunning it", async () => {
    const { transport, table, hooks, prepared, events } = setup();
    const snapshot = await table.submit({ actionId: "job-1", command: "sleep 100" }, hooks);
    assert.equal(snapshot.state, "running");
    assert.equal(snapshot.exitCode, null);
    assert.equal(transport.created, 1);
    assert.equal(transport.exec(1).starts, 1);
    assert.deepEqual(transport.exec(1).cmd, launchCommand("sleep 100"));
    assert.equal(transport.exec(1).workingDir, "/world");
    assert.equal(transport.exec(1).stream?.destroyed, false, "waiting must not close the job's output");
    assert.equal(prepared.length, 1);
    assert.deepEqual(prepared[0], { jobId: "job-1", execId: snapshot.execId, containerId: transport.containerId });
    const preparedEvent = events.find((event) => event.type === "job.prepared");
    assert.equal(preparedEvent?.durable, true);

    // Later inspection observes completion from the same execution.
    transport.exec(1).state = { running: false, exitCode: 0 };
    const later = await table.inspect("job-1");
    assert.equal(later.state, "exited");
    assert.equal(later.exitCode, 0);
    assert.notEqual(later.exitObservedAt, null);
    assert.equal(transport.created, 1);
    assert.equal(transport.exec(1).starts, 1);
  });

  it("returns exit status and output when the job finishes within the wait", async () => {
    const { transport, table, hooks } = setup({ capturedOutputBytes: 8 });
    transport.onStart = (_id, exec) => {
      exec.state = { running: false, exitCode: 3 };
      queueMicrotask(() => {
        exec.stream!.emit(Buffer.concat([MARKER(42), frame("stdout", "hello world"), frame("stderr", "oops")]));
        exec.stream!.finish("eof");
      });
    };
    const snapshot = await table.submit({ actionId: "job-1", command: "false" }, hooks);
    assert.equal(snapshot.state, "exited");
    assert.equal(snapshot.exitCode, 3);
    assert.equal(snapshot.rootPid, 42);
    assert.equal(snapshot.output, "complete");
    assert.equal(Buffer.from(snapshot.stdout.retained).toString(), "hello wo");
    assert.equal(snapshot.stdout.totalBytes, 11);
    assert.equal(snapshot.stdout.truncated, true);
    // The launcher's line is not command output.
    assert.equal(Buffer.from(snapshot.stderr.retained).toString(), "oops");
    assert.equal(snapshot.stderr.totalBytes, 4);
  });

  it("never starts a job the caller withdraws after its records, and records the refusal", async () => {
    const { transport, table, events } = setup();
    const hooks: DispatchHooks = { prepared: () => Promise.resolve(), proceed: () => false };
    await assert.rejects(table.submit({ actionId: "w", command: "touch /world/x" }, hooks), /caller withdrew the dispatch/);
    assert.equal(transport.created, 1);
    assert.equal(transport.exec(1).starts, 0);
    assert.deepEqual(events.map((event) => event.type), ["job.prepared", "job.start_refused"]);
  });

  it("marks a state it could not refresh as stale until an inspection succeeds", async () => {
    const { transport, table, hooks } = setup();
    await table.submit({ actionId: "s", command: "sleep 9" }, hooks);
    const confirmed = (await table.summaries())[0]!;
    assert.deepEqual([confirmed.state, confirmed.inspectionFailure], ["running", null]);
    transport.failInspect = new EngineUnavailableError("gone");
    const stale = (await table.summaries())[0]!;
    assert.equal(stale.state, "running");
    assert.match(stale.inspectionFailure!, /gone/);
    assert.equal(stale.observedAt, confirmed.observedAt);
    transport.failInspect = null;
    transport.exec(1).state = { running: false, exitCode: 0 };
    const recovered = (await table.summaries())[0]!;
    assert.deepEqual([recovered.state, recovered.inspectionFailure], ["exited", null]);
  });

  it("reports every finished job before retention drops it, whatever the calling order", async () => {
    const { transport, table, hooks } = setup({ maximumConcurrentJobs: 3, retainedFinishedJobs: 0, capturedOutputBytes: 4 });
    for (const id of ["a", "b", "c"]) await table.submit({ actionId: id, command: "sleep 9" }, hooks);
    assert.deepEqual((await observe(table)).map((job) => job.state), ["running", "running", "running"]);
    // All three finish before the next observation, with no retention at all.
    for (const n of [1, 2, 3]) {
      transport.exec(n).state = { running: false, exitCode: n };
      transport.exec(n).stream!.finish("eof");
    }
    await delay(20);
    await table.list();
    // A summary that is not delivered acknowledges nothing.
    assert.equal((await table.summaries()).length, 3);
    const reported = await observe(table);
    assert.deepEqual(reported.map((job) => [job.jobId, job.state, job.exitCode]), [["a", "exited", 1], ["b", "exited", 2], ["c", "exited", 3]]);
    // Having been delivered, they may now be dropped.
    assert.deepEqual(await table.summaries(), []);

    // Without observations, unreported completions hold their slots: nothing is dropped unseen.
    const one = setup({ maximumConcurrentJobs: 1, retainedFinishedJobs: 0 });
    one.transport.onStart = (_id, exec) => {
      exec.state = { running: false, exitCode: 0 };
      queueMicrotask(() => exec.stream!.finish("eof"));
    };
    await one.table.submit({ actionId: "j0", command: "true" }, one.hooks);
    for (let n = 1; n < 10; n++) await assert.rejects(one.table.submit({ actionId: `j${n}`, command: "true" }, one.hooks), JobAdmissionError);
    assert.deepEqual((await one.table.summaries()).map((job) => job.jobId), ["j0"]);
    assert.deepEqual(one.events.filter((event) => event.type === "job.evicted"), []);
  });

  it("refuses every further dispatch once a job is uncertain, however that was discovered", async () => {
    // Discovered by the refresh inside the next submission.
    const one = setup({ maximumConcurrentJobs: 3 });
    await one.table.submit({ actionId: "a", command: "sleep 100" }, one.hooks);
    assert.equal((await one.table.summaries())[0]!.state, "running");
    one.transport.failInspect = new ExecGoneError("exec-1");
    await assert.rejects(one.table.submit({ actionId: "b", command: "touch /world/x" }, one.hooks), UncertainJobsError);
    assert.equal(one.transport.created, 1);
    assert.deepEqual(one.safety.snapshot().uncertainEffects.map((effect) => effect.jobId), ["a"]);
    // It persists: later submissions are refused too, and the job is never dropped.
    one.transport.failInspect = null;
    await assert.rejects(one.table.submit({ actionId: "c", command: "true" }, one.hooks), UncertainJobsError);
    assert.equal(one.transport.created, 1);

    // Discovered by background polling, with no call into the table.
    const two = setup({ maximumConcurrentJobs: 3 });
    await two.table.submit({ actionId: "a", command: "sleep 100" }, two.hooks);
    two.transport.failInspect = new ExecGoneError("exec-1");
    await delay(50);
    await two.table.refreshSafety();
    assert.deepEqual(two.safety.snapshot().uncertainEffects.map((effect) => effect.jobId), ["a"]);
    await assert.rejects(two.table.submit({ actionId: "b", command: "true" }, two.hooks), UncertainJobsError);
    assert.equal(two.transport.created, 1);
  });

  it("rejects a job over the admission bound before creating anything", async () => {
    const { transport, table, hooks, prepared } = setup({ maximumConcurrentJobs: 2 });
    await table.submit({ actionId: "a", command: "sleep 9" }, hooks);
    await table.submit({ actionId: "b", command: "sleep 9" }, hooks);
    await assert.rejects(table.submit({ actionId: "c", command: "touch /world/third" }, hooks), JobAdmissionError);
    assert.equal(transport.created, 2);
    assert.equal(prepared.length, 2);

    // A finished job frees its slot once its output is complete.
    transport.exec(1).state = { running: false, exitCode: 0 };
    transport.exec(1).stream!.finish("eof");
    await table.inspect("a");
    // Finished, but it holds its slot until an observation reporting it has been delivered.
    await assert.rejects(table.submit({ actionId: "c", command: "true" }, hooks), JobAdmissionError);
    table.acknowledge(["a"]);
    await table.submit({ actionId: "c", command: "true" }, hooks);
    assert.equal(transport.created, 3);
  });

  it("keeps a slot while an exited job's output is still being collected, then closes it", async () => {
    const { transport, table, hooks } = setup({ maximumConcurrentJobs: 1 });
    await table.submit({ actionId: "a", command: "sleep 100 &" }, hooks);
    transport.exec(1).state = { running: false, exitCode: 0 };
    const exited = await table.inspect("a");
    assert.equal(exited.state, "exited");
    assert.equal(exited.output, "open");
    await assert.rejects(table.submit({ actionId: "b", command: "true" }, hooks), JobAdmissionError);

    await delay(60);
    const closed = await table.inspect("a");
    assert.equal(closed.output, "closed_after_exit");
    assert.equal(transport.exec(1).stream!.destroyed, true);
    // Finished, but it holds its slot until an observation reporting it has been delivered.
    await assert.rejects(table.submit({ actionId: "b", command: "true" }, hooks), JobAdmissionError);
    table.acknowledge(["a"]);
    await table.submit({ actionId: "b", command: "true" }, hooks);
  });

  it("never dispatches a job ID twice", async () => {
    const { transport, table, hooks } = setup();
    await table.submit({ actionId: "a", command: "true" }, hooks);
    await assert.rejects(table.submit({ actionId: "a", command: "true" }, hooks), DispatchRefusedError);
    assert.equal(transport.created, 1);
  });

  it("does not start a job whose pre-dispatch record fails", async () => {
    const { transport, table } = setup();
    const failing: DispatchHooks = { prepared: () => Promise.reject(new Error("disk full")) };
    await assert.rejects(table.submit({ actionId: "a", command: "rm -rf /world/*" }, failing), /not started, and no further job will be: disk full/);
    assert.equal(transport.exec(1).starts, 0);
    assert.deepEqual(await table.list(), []);
  });

  it("reports an engine refusal as not started and frees the slot", async () => {
    const { transport, table, hooks, events } = setup({ maximumConcurrentJobs: 1 });
    transport.failNextStart = new EngineResponseError(409, "container is not running");
    await assert.rejects(table.submit({ actionId: "a", command: "true" }, hooks), DispatchRefusedError);
    assert.ok(events.some((event) => event.type === "job.start_refused" && event.durable));
    await table.submit({ actionId: "b", command: "true" }, hooks);
  });

  it("keeps an unanswered start tracked and inspected, never starts it again, and latches its unknown outcome", async () => {
    const { transport, table, hooks, safety } = setup({ maximumConcurrentJobs: 1 });
    transport.failNextStart = new EngineUnavailableError("socket closed");
    const unknown = await table.submit({ actionId: "a", command: "true" }, hooks);
    assert.equal(unknown.state, "unconfirmed");
    assert.equal(unknown.output, "failed");
    assert.match(unknown.detail ?? "", /may or may not have started/);
    // Whether it ran is unknown: the epoch requires review, and nothing more is admitted.
    assert.deepEqual(safety.snapshot().uncertainEffects.map((effect) => [effect.jobId, effect.cause]), [["a", "start_outcome_unknown"]]);
    await assert.rejects(table.submit({ actionId: "b", command: "true" }, hooks), UncertainJobsError);

    // The engine later shows it did start, and then that it exited: the job's state is known now,
    // but the latch is a fact of the epoch and stays.
    transport.exec(1).state = { running: true, exitCode: null };
    assert.equal((await table.inspect("a")).state, "running");
    transport.exec(1).state = { running: false, exitCode: 0 };
    assert.equal((await table.inspect("a")).state, "exited");
    assert.equal(transport.exec(1).starts, 1);
    table.acknowledge(["a"]);
    await assert.rejects(table.submit({ actionId: "b", command: "true" }, hooks), UncertainJobsError);
    assert.equal(safety.snapshot().reviewRequired, true);
    assert.equal(transport.created, 1);
  });

  it("serializes submissions so concurrent duplicates and admissions cannot interleave", async () => {
    const { transport, table, hooks } = setup({ maximumConcurrentJobs: 1 });
    const results = await Promise.allSettled([
      table.submit({ actionId: "a", command: "sleep 9" }, hooks),
      table.submit({ actionId: "a", command: "sleep 9" }, hooks),
      table.submit({ actionId: "b", command: "sleep 9" }, hooks),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "rejected", "rejected"],
    );
    assert.equal(transport.created, 1);
  });

  it("sees exits and closes held-open output by polling, without waiting for another tick", async () => {
    const { transport, table, hooks } = setup({ maximumConcurrentJobs: 1 });
    await table.submit({ actionId: "a", command: "sleep 1; sleep 999 &" }, hooks);
    transport.exec(1).state = { running: false, exitCode: 0 };
    // Nothing calls into the table; the poller observes the exit and the close timer follows.
    await delay(120);
    assert.equal(transport.exec(1).stream!.destroyed, true);
    const job = await table.inspect("a");
    assert.equal(job.state, "exited");
    assert.equal(job.output, "closed_after_exit");
    // Finished, but it holds its slot until an observation reporting it has been delivered.
    await assert.rejects(table.submit({ actionId: "b", command: "true" }, hooks), JobAdmissionError);
    table.acknowledge(["a"]);
    await table.submit({ actionId: "b", command: "true" }, hooks);
  });

  it("labels output cut off by releasing the world as failed, not complete", async () => {
    const { transport, table, hooks } = setup();
    await table.submit({ actionId: "a", command: "sleep 9" }, hooks);
    const inspections = transport.inspections;
    await table.close();
    const [job] = await table.list();
    assert.equal(job!.output, "failed");
    assert.match(job!.detail ?? "", /released/);
    assert.equal(transport.inspections, inspections);
  });

  it("inspects jobs again when a stop could not be verified", async () => {
    const { transport, table, hooks } = setup();
    await table.submit({ actionId: "a", command: "sleep 9" }, hooks);
    table.beginWorldStop();
    table.stopNotVerified();
    transport.exec(1).state = { running: false, exitCode: 0 };
    assert.equal((await table.inspect("a")).state, "exited");
    await assert.rejects(table.submit({ actionId: "b", command: "true" }, hooks), DispatchRefusedError);
  });

  it("marks an execution the engine forgot as uncertain", async () => {
    const { transport, table, hooks } = setup();
    await table.submit({ actionId: "a", command: "sleep 9" }, hooks);
    const { ExecGoneError } = await import("../../src/world/exec.ts");
    transport.inspect = (id) => Promise.reject(new ExecGoneError(id));
    const snapshot = await table.inspect("a");
    assert.equal(snapshot.state, "uncertain");
  });

  it("keeps the last known state when the engine is unavailable", async () => {
    const { transport, table, hooks } = setup();
    await table.submit({ actionId: "a", command: "sleep 9" }, hooks);
    transport.inspect = () => Promise.reject(new EngineUnavailableError("gone"));
    const snapshot = await table.inspect("a");
    assert.equal(snapshot.state, "running");
    assert.match(snapshot.inspectionFailure ?? "", /gone/);
  });

  it("drops the oldest finished jobs beyond the retention bound", async () => {
    const { transport, table, hooks, events } = setup({ maximumConcurrentJobs: 4, retainedFinishedJobs: 1 });
    transport.onStart = (_id, exec) => {
      exec.state = { running: false, exitCode: 0 };
      queueMicrotask(() => exec.stream!.finish("eof"));
    };
    // As in the loop, an observation is delivered after each dispatch; only reported jobs can be dropped.
    for (const id of ["a", "b", "c"]) {
      await table.submit({ actionId: id, command: "true" }, hooks);
      await observe(table);
    }
    assert.deepEqual(
      (await table.list()).map((job) => job.jobId),
      ["c"],
    );
    await assert.rejects(table.inspect("a"), UnknownJobError);
    assert.deepEqual(
      events.filter((event) => event.type === "job.evicted").map((event) => event.data.jobId),
      ["a", "b"],
    );
  });

  it("signals a running job's process group after recording the request", async () => {
    const { transport, table, hooks, controls, events } = setup();
    transport.onStart = (_id, exec) => {
      exec.state = { running: true, exitCode: null };
      queueMicrotask(() => exec.stream!.emit(MARKER(57)));
    };
    await table.submit({ actionId: "a", command: "sleep 100" }, hooks);
    const result = await table.signal("a", "TERM", "agent");
    assert.deepEqual(result, { jobId: "a", signal: "TERM", delivered: true, scope: "process_group", detail: "sent SIGTERM to process group 57" });
    assert.deepEqual(controls[0]!.slice(-3), ["57", "123456", "TERM"]);
    const requested = events.findIndex((event) => event.type === "job.signal_requested");
    const signalled = events.findIndex((event) => event.type === "job.signalled");
    assert.ok(requested !== -1 && requested < signalled && events[requested]!.durable);
  });

  it("reports honestly when nothing could be signalled", async () => {
    const { transport, table, hooks, controls, setControlResult } = setup();
    // No launcher marker: the process identity is unknown.
    await table.submit({ actionId: "a", command: "sleep 100" }, hooks);
    assert.equal((await table.signal("a", "KILL", "operator")).delivered, false);
    assert.equal(controls.length, 0);

    // The marker must be the first stderr bytes; later text is ordinary output.
    transport.exec(1).stream!.emit(Buffer.concat([frame("stderr", "warning\n"), MARKER(60)]));
    const unmarked = await table.inspect("a");
    assert.equal(unmarked.rootPid, null);
    assert.equal(Buffer.from(unmarked.stderr.retained).toString(), "warning\nalife-jo");

    transport.onStart = (_id, exec) => {
      exec.state = { running: true, exitCode: null };
      queueMicrotask(() => exec.stream!.emit(MARKER(61)));
    };
    await table.submit({ actionId: "b", command: "sleep 100" }, hooks);
    setControlResult({ exitCode: 0, stdout: Buffer.from('{"result":"identity_mismatch"}'), stderr: Buffer.alloc(0), overflow: false, timedOut: false });
    const mismatch = await table.signal("b", "TERM", "agent");
    assert.equal(mismatch.delivered, false);
    assert.match(mismatch.detail, /another process/);

    setControlResult({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), overflow: false, timedOut: true });
    assert.match((await table.signal("b", "TERM", "agent")).detail, /delivery is unknown/);
    // Unknown delivery requires review: further agent signals are refused; the operator's remain available.
    const refused = await table.signal("b", "TERM", "agent");
    assert.equal(refused.delivered, false);
    assert.match(refused.detail, /nothing was signalled: .*signal's delivery is unknown/);

    transport.exec(2).state = { running: false, exitCode: 143 };
    const after = await table.signal("b", "TERM", "operator");
    assert.equal(after.delivered, false);
    assert.match(after.detail, /job is exited/);
  });

  it("ends every unfinished job with the world and refuses new ones", async () => {
    const { transport, table, hooks } = setup();
    await table.submit({ actionId: "a", command: "sleep 100" }, hooks);
    transport.exec(1).stream!.finish("eof");
    // The engine reports the status of the process the stop killed; that is data, not a normal exit,
    // even when the stream's end prompts an inspection while the world is stopping.
    table.beginWorldStop();
    transport.exec(1).state = { running: false, exitCode: 137 };
    assert.equal((await table.inspect("a")).state, "running");
    await table.endWithWorld();
    const [job] = await table.list();
    assert.equal(job!.state, "ended_with_world");
    assert.equal(job!.exitCode, 137);
    await assert.rejects(table.submit({ actionId: "b", command: "true" }, hooks), DispatchRefusedError);
  });

  it("marks output from a stream closed without end-of-file as failed, not complete", async () => {
    const { transport, table, hooks } = setup();
    transport.onStart = (_id, exec) => {
      exec.state = { running: false, exitCode: 0 };
      queueMicrotask(() => {
        exec.stream!.emit(frame("stdout", "partial"));
        exec.stream!.finish("closed");
      });
    };
    const snapshot = await table.submit({ actionId: "a", command: "true" }, hooks);
    assert.equal(snapshot.output, "failed");
    assert.match(snapshot.detail ?? "", /closed without end-of-file/);
    assert.equal(Buffer.from(snapshot.stdout.retained).toString(), "partial");
  });

  it("marks output from a malformed stream as failed", async () => {
    const { transport, table, hooks } = setup();
    transport.onStart = (_id, exec) => {
      exec.state = { running: false, exitCode: 0 };
      queueMicrotask(() => exec.stream!.emit(Buffer.from([9, 0, 0, 0, 0, 0, 0, 1, 0x41])));
    };
    const snapshot = await table.submit({ actionId: "a", command: "true" }, hooks);
    assert.equal(snapshot.output, "failed");
    assert.match(snapshot.detail ?? "", /invalid stream frame/);
  });
});

describe("JobTable lifecycle coordination", () => {
  it("never starts a submission whose preparation hook finishes after release began", async () => {
    const { transport, table } = setup();
    const held = gate();
    const hooks: DispatchHooks = { prepared: () => held.promise };
    const submission = table.submit({ actionId: "a", command: "rm -rf /world/x" }, hooks);
    await delay(5);
    let closed = false;
    const closing = table.close().then(() => (closed = true));
    await delay(5);
    assert.equal(closed, false, "release waits for the pending submission");
    held.open();
    await assert.rejects(submission, DispatchRefusedError);
    await closing;
    assert.equal(transport.exec(1).starts, 0);
    await assert.rejects(table.submit({ actionId: "b", command: "true" }, { prepared: () => Promise.resolve() }), DispatchRefusedError);
    assert.equal(transport.created, 1);
  });

  it("never starts a submission whose durable record finishes after a stop began", async () => {
    const held = gate();
    let holdNext = true;
    const { transport, table, hooks, events } = setup({
      record: (type) => {
        if (type === "job.prepared" && holdNext) {
          holdNext = false;
          return held.promise;
        }
        return Promise.resolve();
      },
    });
    const submission = table.submit({ actionId: "a", command: "true" }, hooks);
    await delay(5);
    // The backend's stop order: quiesce, then begin the stop, then end jobs after the verified stop.
    const stopping = table.quiesce().then(() => {
      table.beginWorldStop();
      return table.endWithWorld();
    });
    held.open();
    await assert.rejects(submission, /began stopping or being released before the start/);
    await stopping;
    assert.equal(transport.exec(1).starts, 0);
    const refused = events.find((event) => event.type === "job.start_refused");
    assert.equal(refused?.durable, true);
    assert.deepEqual(await table.list(), []);
  });

  it("tracks a start already in flight before release completes", async () => {
    const { transport, table, hooks } = setup();
    const held = gate();
    const start = transport.start.bind(transport);
    transport.start = async (id) => {
      await held.promise;
      return start(id);
    };
    const submission = table.submit({ actionId: "a", command: "sleep 9" }, hooks);
    await delay(5);
    let closed = false;
    const closing = table.close().then(() => (closed = true));
    await delay(5);
    assert.equal(closed, false, "release cannot finish while a start is in flight");
    held.open();
    const snapshot = await submission;
    await closing;
    assert.equal(transport.exec(1).starts, 1);
    assert.equal(snapshot.jobId, "a");
    const [job] = await table.list();
    assert.equal(job!.jobId, "a");
    assert.equal(job!.output, "failed");
    assert.equal(transport.exec(1).stream!.destroyed, true);
  });

  it("records a refused start in the real event log before the log closes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alife-jobs-"));
    const file = path.join(directory, "events.jsonl");
    const log = await JsonlEventLog.open({ file, runId: "w-20260925T161449Z-abababab", clock: new FakeClock(), limitBytes: 1 << 20, types: WORLD_EVENT_TYPES });
    const held = gate();
    let holdNext = true;
    const { transport, table, hooks } = setup({
      record: async (type, data, durable) => {
        if (type === "job.prepared" && holdNext) {
          holdNext = false;
          await held.promise;
        }
        await log.append(type, data, { durable });
      },
    });
    const submission = table.submit({ actionId: "a", command: "true" }, hooks);
    await delay(5);
    // The backend's release order: the job table, then the log.
    const closing = (async () => {
      await table.close();
      await log.close();
    })();
    held.open();
    await assert.rejects(submission, DispatchRefusedError);
    await closing;
    assert.equal(transport.exec(1).starts, 0);
    const contents = await readEventLog(file);
    assert.deepEqual(contents.issues, []);
    assert.deepEqual(
      contents.events.map((event) => event.type),
      ["job.prepared", "job.start_refused"],
    );
  });

  it("refuses an evicted job ID before creating anything, while history stays bounded", async () => {
    const { transport, table, hooks } = setup({ maximumConcurrentJobs: 4, retainedFinishedJobs: 1 });
    transport.onStart = (_id, exec) => {
      exec.state = { running: false, exitCode: 0 };
      queueMicrotask(() => exec.stream!.finish("eof"));
    };
    await table.submit({ actionId: "a", command: "echo once >> /world/log" }, hooks);
    await observe(table);
    await table.submit({ actionId: "b", command: "true" }, hooks);
    await observe(table);
    assert.deepEqual(
      (await table.list()).map((job) => job.jobId),
      ["b"],
    );
    await assert.rejects(table.submit({ actionId: "a", command: "echo once >> /world/log" }, hooks), /already prepared/);
    assert.equal(transport.created, 2);
    await table.submit({ actionId: "c", command: "true" }, hooks);
    assert.equal(transport.created, 3);
    await observe(table);
    assert.equal((await table.list()).length, 1);
  });

  it("refuses job IDs this world prepared before, under any controller", async () => {
    const { transport, table, hooks } = setup({ previouslyPrepared: ["run-1.t000001.action"] });
    await assert.rejects(table.submit({ actionId: "run-1.t000001.action", command: "true" }, hooks), /already prepared/);
    assert.equal(transport.created, 0);
  });

  it("fails closed after a pre-dispatch record fails, so failures cannot accumulate", async () => {
    const { transport, table, hooks } = setup();
    const failing: DispatchHooks = { prepared: () => Promise.reject(new Error("disk")) };
    await assert.rejects(table.submit({ actionId: "x", command: "true" }, failing), /no further job will be/);
    for (let n = 0; n < 50; n++) {
      await assert.rejects(table.submit({ actionId: `y${n}`, command: "true" }, failing), /earlier pre-dispatch record failed/);
    }
    // The failed ID stays spent, and healthy hooks do not reopen the table.
    await assert.rejects(table.submit({ actionId: "x", command: "true" }, hooks), /earlier pre-dispatch record failed/);
    await assert.rejects(table.submit({ actionId: "z", command: "true" }, hooks), /earlier pre-dispatch record failed/);
    assert.equal(transport.created, 1, "at most one unstarted execution is left by the failure");
    assert.equal(transport.exec(1).starts, 0);
  });

  it("fails closed when the real world log rejects the pre-dispatch record", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alife-jobs-"));
    const file = path.join(directory, "events.jsonl");
    // A one-byte limit refuses every append, as a full log would.
    const log = await JsonlEventLog.open({ file, runId: "w-20260925T161449Z-abababab", clock: new FakeClock(), limitBytes: 1, types: WORLD_EVENT_TYPES });
    const { transport, table, hooks } = setup({ record: (type, data, durable) => log.append(type, data, { durable }).then(() => undefined) });
    await assert.rejects(table.submit({ actionId: "a", command: "true" }, hooks), /record limit/);
    for (let n = 0; n < 1000; n++) {
      await assert.rejects(table.submit({ actionId: `b${n}`, command: "true" }, hooks), /earlier pre-dispatch record failed/);
    }
    assert.equal(transport.created, 1);
    assert.equal(transport.exec(1).starts, 0);
    await log.close();
    assert.deepEqual((await readEventLog(file)).events, []);
  });

  it("discards an inspection answer that arrives after a stop began", async () => {
    const { transport, table, hooks, events } = setup();
    await table.submit({ actionId: "a", command: "sleep 100" }, hooks);
    const answer = gate<{ running: boolean; exitCode: number | null }>();
    const inspect = transport.inspect.bind(transport);
    transport.inspect = () => answer.promise;
    const inspection = table.inspect("a");
    await delay(5);
    table.beginWorldStop();
    answer.open({ running: false, exitCode: 137 });
    assert.equal((await inspection).state, "running");
    transport.inspect = inspect;
    transport.exec(1).state = { running: false, exitCode: 137 };
    await table.endWithWorld();
    const [job] = await table.list();
    assert.equal(job!.state, "ended_with_world");
    assert.equal(job!.exitCode, 137);
    assert.ok(!events.some((event) => event.type === "job.state" && event.data.to === "exited"));
  });

  it("keeps a normal exit observed before the stop began", async () => {
    const { transport, table, hooks } = setup();
    await table.submit({ actionId: "a", command: "true" }, hooks);
    transport.exec(1).state = { running: false, exitCode: 0 };
    assert.equal((await table.inspect("a")).state, "exited");
    table.beginWorldStop();
    await table.endWithWorld();
    const [job] = await table.list();
    assert.equal(job!.state, "exited");
    assert.equal(job!.exitCode, 0);
  });
});

describe("runControl", () => {
  async function reading(end: "eof" | "closed") {
    const transport = new FakeTransport();
    transport.onStart = (_id, exec) => {
      exec.state = { running: false, exitCode: 0 };
      queueMicrotask(() => {
        exec.stream!.emit(frame("stdout", '{"ok":true}'));
        exec.stream!.finish(end);
      });
    };
    const result = await runControl(transport, new FakeClock(), ["python3", "-c", "..."], { timeoutMs: 1_000, stdoutLimit: 1024 });
    return { result, transport };
  }

  it("accepts a reading whose stream reached end-of-file", async () => {
    const { result, transport } = await reading("eof");
    assert.equal(result.exitCode, 0);
    assert.equal(result.overflow, false);
    assert.equal(result.stdout.toString(), '{"ok":true}');
    assert.equal(transport.exec(1).workingDir, "/");
  });

  it("treats a reading whose stream closed early as incomplete", async () => {
    const { result } = await reading("closed");
    assert.equal(result.overflow, true);
  });
});
