import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { canonicalJson } from "../../src/core/hash.ts";
import { EVENT_TYPES, InvalidEventError, JsonlEventLog, MAX_EVENT_BYTES, readEventLog, RecordCapacityError, WATCHDOG_EVENT_TYPES } from "../../src/records/events.ts";
import { manifestSchema, runtimeIdentity, sourceIdentity } from "../../src/records/manifest.ts";
import { FakeClock } from "../support/fake-clock.ts";

const RUN = "r-20260925T161449Z-abababab";

async function logFile(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), "alife-events-")), "events.jsonl");
}

describe("JsonlEventLog", () => {
  it("appends sequenced, timestamped events that read back cleanly", async () => {
    const file = await logFile();
    const clock = new FakeClock();
    const log = await JsonlEventLog.open({ file, runId: RUN, clock, limitBytes: 1 << 20, types: EVENT_TYPES });
    assert.equal(await log.append("run.created", { configSha256: "x" }, { durable: true }), 1);
    clock.advance(1500);
    assert.equal(await log.append("tick.completed", {}, { tick: 1 }), 2);
    await log.close();

    const { events, issues } = await readEventLog(file);
    assert.deepEqual(issues, []);
    assert.deepEqual(
      events.map((e) => [e.seq, e.type, e.tick, e.time, e.monotonicMs]),
      [
        [1, "run.created", undefined, "2026-09-25T16:14:49.000Z", 0],
        [2, "tick.completed", 1, "2026-09-25T16:14:50.500Z", 1500],
      ],
    );
    assert.equal(events[0]!.session, events[1]!.session);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  it("serializes concurrent appends in call order", async () => {
    const file = await logFile();
    const log = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES });
    const seqs = await Promise.all(Array.from({ length: 20 }, (_, i) => log.append("observation.sampled", { i })));
    await log.close();
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
    const { events, issues } = await readEventLog(file);
    assert.deepEqual(issues, []);
    assert.deepEqual(events.map((e) => e.data.i), Array.from({ length: 20 }, (_, i) => i));
  });

  it("continues an intact log in a new session", async () => {
    const file = await logFile();
    const first = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES });
    await first.append("run.created", {});
    await first.close();
    const second = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES });
    assert.equal(await second.append("run.resumed", {}), 2);
    await second.close();
    const { events } = await readEventLog(file);
    assert.notEqual(events[0]!.session, events[1]!.session);
  });

  it("rejects unknown types, oversized events, and writes past the record limit", async () => {
    const file = await logFile();
    const log = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 600, types: EVENT_TYPES });
    await assert.rejects(log.append("run.died" as never, {}), RangeError);
    await assert.rejects(log.append("model.responded", { text: "x".repeat(MAX_EVENT_BYTES) }), /limit is/);
    await log.append("run.created", {});
    await assert.rejects(log.append("model.responded", { text: "x".repeat(600) }), RecordCapacityError);
    // A rejected event consumes no sequence number.
    assert.equal(log.lastSequence, 1);
    await log.close();
  });

  it("rejects events that would not read back unchanged, before writing anything", async () => {
    const file = await logFile();
    const log = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES });
    const rejected: [Record<string, unknown>, { tick?: number }, RegExp][] = [
      [{}, { tick: 0 }, /tick/],
      [{}, { tick: 1.5 }, /tick/],
      [{ value: Number.NaN }, {}, /\$\.data\.value: non-finite number/],
      [{ value: Number.POSITIVE_INFINITY }, {}, /non-finite number/],
      [{ value: undefined }, {}, /\$\.data\.value: unsupported undefined/],
      [{ value: Object.assign(Array(3), { 0: 1, 2: 2 }) }, {}, /sparse array hole/],
      [{ value: new Date(0) }, {}, /only plain objects/],
      [{ value: 1n }, {}, /unsupported bigint/],
    ];
    for (const [data, options, message] of rejected) {
      await assert.rejects(log.append("action.prepared", data, options), (error: unknown) => {
        assert.ok(error instanceof InvalidEventError, String(error));
        assert.match(error.message, message);
        return true;
      });
    }
    assert.equal(log.lastSequence, 0);
    assert.equal(await log.append("action.prepared", { value: 1 }, { tick: 1, durable: true }), 1);
    await log.close();

    const { events, issues } = await readEventLog(file);
    assert.deepEqual(issues, []);
    assert.deepEqual(events.map((e) => [e.seq, e.tick, e.data]), [[1, 1, { value: 1 }]]);
  });

  it("rejects clock readings the reader would refuse", async () => {
    const file = await logFile();
    const clock = new FakeClock();
    clock.monotonicMs = () => Number.NaN;
    const log = await JsonlEventLog.open({ file, runId: RUN, clock, limitBytes: 1 << 20, types: EVENT_TYPES });
    await assert.rejects(log.append("run.created", {}), InvalidEventError);
    await log.close();
    assert.equal((await readFile(file)).length, 0);
  });

  it("keeps watchdog events in their own log", async () => {
    const file = await logFile();
    const log = await JsonlEventLog.open({
      file,
      runId: RUN,
      clock: new FakeClock(),
      limitBytes: 1 << 20,
      types: WATCHDOG_EVENT_TYPES,
    });
    await log.append("watchdog.armed", {});
    await assert.rejects(log.append("run.created" as never, {}), RangeError);
    await log.close();
  });

  it("refuses to append to a damaged log or another run's log", async () => {
    const file = await logFile();
    const log = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES });
    await log.append("run.created", {});
    await log.close();
    await assert.rejects(
      JsonlEventLog.open({ file, runId: "r-20260925T161449Z-cdcdcdcd", clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES }),
      /different run/,
    );
    await appendFile(file, '{"v":1,"seq":2');
    await assert.rejects(JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES }), /damaged/);
  });
});

describe("readEventLog", () => {
  it("reports partial tails, malformed lines, gaps, and foreign runs without discarding evidence", async () => {
    const file = await logFile();
    const log = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES });
    await log.append("run.created", {});
    await log.append("run.ready", {});
    await log.close();
    const [first, second] = (await readFile(file, "utf8")).trim().split("\n") as [string, string];
    const foreign = JSON.stringify({ ...(JSON.parse(second) as object), seq: 3, runId: "r-20260925T161449Z-cdcdcdcd" });
    await writeFile(file, `${first}\nnot json\n${foreign}\n${second}\n{"v":1`);

    const { events, issues } = await readEventLog(file);
    assert.equal(events.length, 3);
    assert.deepEqual(
      issues.map((i) => [i.line, i.kind]),
      [
        [5, "partial_tail"],
        [2, "malformed"],
        [3, "sequence"],
        [3, "run_mismatch"],
        [4, "sequence"],
      ],
    );
  });
});

describe("readEventLog round trip", () => {
  it("preserves an own __proto__ key without changing any prototype", async () => {
    const file = await logFile();
    const log = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES });
    const data = JSON.parse('{"__proto__":{"evidence":"keep"},"ordinary":1,"nested":{"__proto__":[1]}}') as Record<string, unknown>;
    await log.append("model.responded", data);
    await log.append("run.ready", { plain: true });
    await log.close();

    const written = await readFile(file, "utf8");
    assert.ok(written.includes('"data":{"__proto__":{"evidence":"keep"},"nested":{"__proto__":[1]},"ordinary":1}'));
    const { events, issues } = await readEventLog(file);
    assert.deepEqual(issues, []);
    const read = events[0]!.data;
    assert.ok(Object.hasOwn(read, "__proto__"));
    assert.deepEqual(Object.keys(read), ["__proto__", "nested", "ordinary"]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(read, "__proto__")?.value, { evidence: "keep" });
    assert.equal(Object.getPrototypeOf(read), Object.prototype);
    assert.equal((read as { evidence?: unknown }).evidence, undefined);
    assert.equal(({} as { evidence?: unknown }).evidence, undefined);

    // Byte-exact: re-serializing what was read reproduces the file.
    assert.equal(events.map((event) => `${canonicalJson(event)}\n`).join(""), written);

    // The log stays intact and can be continued.
    const reopened = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES });
    assert.equal(await reopened.append("run.stopping", {}), 3);
    await reopened.close();
  });

  it("reports an own __proto__ key on the envelope instead of dropping it", async () => {
    const file = await logFile();
    const log = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES });
    await log.append("run.created", {});
    await log.close();
    const line = (await readFile(file, "utf8")).replace('{"data"', '{"__proto__":{"seq":9},"data"');
    await writeFile(file, line);
    const { events, issues } = await readEventLog(file);
    assert.equal(events.length, 0);
    assert.deepEqual(issues.map((i) => [i.kind, i.detail]), [["schema", 'line 1: Unrecognized key: "__proto__"']]);
  });

  it("rejects data that is not a JSON object", async () => {
    const file = await logFile();
    const log = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES });
    await assert.rejects(log.append("run.created", [] as never), InvalidEventError);
    await log.close();
  });
});

describe("readEventLog encoding", () => {
  it("reports invalid UTF-8 as corruption and leaves the bytes untouched", async () => {
    const file = await logFile();
    const log = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES });
    await log.append("run.created", { text: "AB" });
    await log.append("run.ready", {});
    await log.close();
    const damaged = await readFile(file);
    damaged[damaged.indexOf("AB")] = 0xff;
    await writeFile(file, damaged);

    const { events, issues } = await readEventLog(file);
    assert.deepEqual(
      issues.map((i) => [i.line, i.kind]),
      [
        [1, "encoding"],
        [2, "sequence"],
      ],
    );
    assert.equal(events.length, 1);
    assert.ok(!events.some((e) => JSON.stringify(e).includes("\ufffd")));
    await assert.rejects(
      JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES }),
      /damaged.*not valid UTF-8/,
    );
    assert.deepEqual(await readFile(file), damaged);
  });

  it("does not strip a byte-order mark", async () => {
    const file = await logFile();
    const log = await JsonlEventLog.open({ file, runId: RUN, clock: new FakeClock(), limitBytes: 1 << 20, types: EVENT_TYPES });
    await log.append("run.created", {});
    await log.close();
    await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile(file)]));
    assert.deepEqual((await readEventLog(file)).issues.map((i) => i.kind), ["malformed"]);
  });
});

describe("manifest", () => {
  it("identifies the runtime and source without secrets", async () => {
    const runtime = await runtimeIdentity();
    assert.equal(runtime.package, "@alife/runtime");
    assert.equal(runtime.node, process.version);

    const source = await sourceIdentity(import.meta.dirname);
    if (source.revision !== null) {
      assert.match(source.revision, /^[a-f0-9]{40,64}$/);
      assert.equal(source.dirty === true, source.dirtySha256 !== null);
    }
    const outside = await sourceIdentity(tmpdir());
    assert.deepEqual(outside, { revision: null, dirty: null, dirtySha256: null });
  });

  it("is strict", () => {
    const result = manifestSchema.safeParse({ schemaVersion: 1, apiKey: "secret" });
    assert.equal(result.success, false);
    assert.ok(!result.success && result.error.issues.some((issue) => issue.code === "unrecognized_keys"));
  });
});
