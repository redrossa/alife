import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalJson, canonicalSha256, deepFreeze } from "../../src/core/hash.ts";
import { actionId, isRunId, isWorldId, newRunId, newWorldId, parseRunId, parseWorldId, requestId } from "../../src/core/ids.ts";
import {
  allowedTransitions,
  IllegalTransitionError,
  isResumable,
  isTerminal,
  RUN_STATES,
  STATE_EVENTS,
  transition,
} from "../../src/core/state.ts";
import { EVENT_TYPES } from "../../src/records/events.ts";
import { escapeTerminal } from "../../src/operator/terminal.ts";

const now = new Date("2026-09-25T16:14:49.123Z");
const fixedBytes = (size: number) => new Uint8Array(size).fill(0xab);

describe("identifiers", () => {
  it("formats sortable, path-safe world and run IDs", () => {
    const world = newWorldId(now, fixedBytes);
    const run = newRunId(now, fixedBytes);
    assert.equal(world, "w-20260925T161449Z-abababab");
    assert.equal(run, "r-20260925T161449Z-abababab");
    assert.ok(isWorldId(world) && !isRunId(world));
    assert.ok(isRunId(run) && !isWorldId(run));
    assert.equal(requestId(run, 42), `${run}.t000042.request`);
    assert.equal(actionId(run, 1_000_000), `${run}.t1000000.action`);
  });

  it("rejects anything that is not exactly an ID", () => {
    for (const bad of ["", "w-20260925T161449Z-ABABABAB", "w-20260925T161449Z-abababab/..", " w-20260925T161449Z-abababab", "../w"]) {
      assert.throws(() => parseWorldId(bad), RangeError);
    }
    assert.throws(() => parseRunId("w-20260925T161449Z-abababab"), RangeError);
    assert.throws(() => requestId(parseRunId("r-20260925T161449Z-abababab"), 0), RangeError);
  });

  it("uses fresh randomness by default", () => {
    assert.notEqual(newRunId(now), newRunId(now));
  });
});

describe("run lifecycle", () => {
  it("follows the declared transitions", () => {
    let state = transition("created", "ready");
    state = transition(state, "running");
    state = transition(state, "stopping");
    state = transition(state, "stopped_clean");
    assert.ok(isResumable(state));
    state = transition(state, "running");
    state = transition(state, "recovery_required");
    assert.ok(!isResumable(state));
    state = transition(state, "finalized");
    assert.ok(isTerminal(state));
  });

  it("never resumes or rewrites an interrupted run", () => {
    assert.throws(() => transition("recovery_required", "running"), IllegalTransitionError);
    assert.throws(() => transition("recovery_required", "stopped_clean"), IllegalTransitionError);
    assert.throws(() => transition("running", "stopped_clean"), IllegalTransitionError);
    assert.throws(() => transition("finalized", "running"), IllegalTransitionError);
    assert.deepEqual(allowedTransitions("completed"), []);
  });

  it("records every state with a known event type", () => {
    for (const state of RUN_STATES) {
      assert.ok((EVENT_TYPES as readonly string[]).includes(STATE_EVENTS[state]), state);
    }
  });
});

describe("canonical JSON", () => {
  it("sorts keys and is stable", () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 0, y: -1.5 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":-1.5,"z":0}}');
    assert.equal(canonicalSha256({ a: 1, b: 2 }), canonicalSha256({ b: 2, a: 1 }));
  });

  it("rejects values JSON would silently change", () => {
    assert.throws(() => canonicalJson({ a: undefined }), /unsupported undefined/);
    assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/);
    assert.throws(() => canonicalJson(new Date()), /plain objects/);
  });

  it("rejects sparse arrays instead of dropping holes", () => {
    assert.throws(() => canonicalJson(Array(1)), /\$\[0\]: sparse array hole/);
    assert.throws(() => canonicalJson(Array(2)), /sparse array hole/);
    assert.throws(() => canonicalJson({ a: [1, Object.assign(Array(3), { 0: 2, 2: 3 })] }), /\$\.a\[1\]\[1\]: sparse array hole/);
    assert.throws(() => canonicalSha256(Object.assign(Array(3), { 0: 1, 2: 2 })), /sparse array hole/);
    assert.equal(canonicalJson([true, null, [0]]), "[true,null,[0]]");
    assert.equal(canonicalSha256([1, 2]), canonicalSha256([1, 2]));
    assert.notEqual(canonicalSha256([]), canonicalSha256([null]));
  });

  it("deep-freezes nested data", () => {
    const value = deepFreeze({ a: { b: [1] } });
    assert.ok(Object.isFrozen(value.a.b));
  });
});

describe("escapeTerminal", () => {
  it("escapes control bytes and bidirectional overrides", () => {
    assert.equal(escapeTerminal("a\u001b[2Jb\u0007\u009b"), "a\\x1b[2Jb\\x07\\x9b");
    assert.equal(escapeTerminal("x\u202ey\u2028"), "x\\u202ey\\u2028");
    assert.equal(escapeTerminal("line\nnext"), "line\\x0anext");
    assert.equal(escapeTerminal("line\nnext", { keepNewlines: true }), "line\nnext");
    assert.equal(escapeTerminal("plain é ✓"), "plain é ✓");
  });
});
