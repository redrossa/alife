# Phase 1 implementation verification findings

## Verdict

Phase 1 is substantially implemented, but it is not ready for sign-off. Standard checks pass; additional offline reproductions exposed ownership, state-directory, and record-integrity defects.

Fix the findings below and add regression tests before building Phase 2 on these primitives. This review does not assess missing functionality assigned to later phases.

## Verification performed

From `runtime/`:

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm test` — 63 tests passed, none failed or skipped.
- `npm run build` — passed.
- Compiled CLI configuration validation and version commands — passed.
- `npm ls --depth=0` and package/lockfile root metadata comparison — passed.

The separate runtime package and credential-free CI configuration were inspected. Checks ran locally on Node.js **25.8.1**, macOS arm64; GitHub CI's Node.js 24 environment was not independently executed.

Additional reproductions used temporary directories and, for the ownership race, instrumented filesystem-operation scheduling. No source files were changed, no Docker resources were used, and no paid APIs were called. The build regenerated ignored output.

Paths and line numbers below refer to the implementation as reviewed and may move after fixes.

## 1. Concurrent release can delete a new owner's lock

**Priority:** P1 — high  
**Location:** `runtime/src/operator/locks.ts:102–110`; equivalent check/delete race at `161–169`.

### Finding

Token verification and unlinking are separate operations. Two concurrent `Ownership.release()` calls can both verify the original token. After the first removes the lock and a replacement owner acquires it, the second can delete the replacement owner's lock.

The `#released` flag is set only after unlinking and directory synchronization, so it does not serialize concurrent calls. Abandoned-lock release also separates verification from deletion.

### Reproduction

Using instrumented `unlink` scheduling, with real lock files in a temporary directory:

1. Acquire the original ownership.
2. Call its `release()` twice concurrently.
3. Let both calls verify the original token.
4. Complete the first unlink.
5. Acquire replacement ownership.
6. Allow the second unlink.

The replacement lock disappeared, and a third owner successfully acquired ownership without the replacement owner releasing it.

### Required correction

Serialize release calls and protect ownership replacement across token-check/delete operations, including abandoned-lock release. Re-reading a token without coordinating deletion still leaves a race.

### Regression coverage

- Concurrent releases cannot remove a replacement lock.
- Concurrent abandoned-lock releases cannot remove newly acquired ownership.
- An obsolete owner cannot release the current owner's lock.

## 2. State-directory containment permits `..`-prefixed children

**Priority:** P1 — high  
**Location:** `runtime/src/operator/state-dir.ts:71`.

### Finding

The containment check uses `relative.startsWith("..")` to identify locations outside a forbidden root. This incorrectly treats ordinary child names such as `..state` as parent-directory traversal.

### Reproduction

```ts
await prepareStateDir(path.join(temp, "..state"), {
  forbiddenRoots: [temp],
});
```

This succeeded and created the layout inside the forbidden root. The same check therefore permits `<repository>/..state`, contrary to the requirement that run data remain outside the checkout.

### Required correction

Distinguish the exact parent component `..` and the prefix `..${path.sep}` from ordinary names beginning with two dots. Preserve the existing real-path containment checks.

### Regression coverage

Reject `..state` and other `..`-prefixed descendants inside a forbidden root, including symlink-resolved locations. Continue accepting genuinely external sibling directories.

## 3. Event writes acknowledge records that the reader rejects

**Priority:** P2 — medium  
**Location:** `runtime/src/records/events.ts:147–163`.

### Finding

The writer constructs an envelope but does not validate it against `eventEnvelopeSchema` before serialization and writing.

It also uses `JSON.stringify` directly on payloads, which silently omits `undefined` properties and converts `NaN` to `null`.

### Reproduction

```ts
await log.append("action.prepared", {}, { tick: 0, durable: true });
```

The append returned sequence `1` successfully. After closing, `readEventLog()` reported a schema issue and returned no valid events for that record; reopening refuses the damaged log.

### Required correction

Validate the complete envelope and reject payload values that cannot be serialized without loss before writing any bytes. Invalid input must not advance the sequence or damage an otherwise usable log.

### Regression coverage

- Invalid tick and envelope values are rejected before writing.
- Non-finite numbers, `undefined`, and other unsupported payload values are rejected rather than altered.
- A valid append following a rejected input reads back cleanly with the correct sequence.

## 4. Invalid UTF-8 evidence is silently repaired

**Priority:** P2 — medium  
**Location:** `runtime/src/records/events.ts:216`.

### Finding

`readFile(file, "utf8")` replaces malformed byte sequences with U+FFFD instead of reporting corruption. An otherwise valid JSON event can therefore be accepted with altered evidence, and the log remains eligible for continued appending.

### Reproduction

An otherwise valid event was written with raw byte `0xff` inside a quoted `data.text` value. `readEventLog()` returned the replacement character `�` and an empty issues list.

### Required correction

Decode UTF-8 fatally before accepting records. Report invalid encoding as corruption, preserve the original file, and refuse continued appending to the damaged log.

### Regression coverage

Inject malformed UTF-8 into a syntactically valid event. Reading must report corruption, reopening must refuse appending, and source bytes must remain unchanged.

## 5. Unreadable configuration files escape structured validation

**Priority:** P2 — medium  
**Location:** `runtime/src/config/resolve.ts:40` (`readBounded`).

### Finding

`readBounded` translates errors from `stat` into `FileProblem`, but its subsequent `readFile` call is outside that error handling. When metadata is readable but file contents are not, `loadConfig` throws instead of returning validation issues.

This also affects referenced prompt and fake-script reads. The CLI's JSON validation mode consequently cannot reliably return a structured invalid-input report for these failures.

### Reproduction

A temporary configuration file was created with mode `000`. `loadConfig(file)` threw `EACCES` rather than returning `{ ok: false, issues: [...] }`.

### Required correction

Translate file-read failures into the same structured file problems used for metadata failures, preserving the appropriate configuration or referenced-file location.

### Regression coverage

Cover denied reads for configuration, prompt, and fake-script files. Use deterministic fault injection where filesystem permission tests are unreliable, such as privileged test environments. Verify structured CLI JSON output and a nonzero exit status.

## 6. Sparse arrays break canonical JSON and hashing

**Priority:** P2 — medium  
**Location:** `runtime/src/core/hash.ts:28`.

### Finding

Array serialization uses `map`, which skips holes. Sparse elements therefore bypass the rejection of unsupported values.

### Reproduction

```ts
canonicalJson(Array(1)); // "[]"
canonicalJson(Array(2)); // "[,]" — invalid JSON

canonicalSha256(Array(1)) === canonicalSha256([]); // true
```

The utility can emit invalid JSON or collapse distinct array lengths into the same identity hash. JSON-loaded configurations do not naturally contain sparse arrays, so this is a scaffold utility defect rather than a demonstrated configuration-path exploit.

### Required correction

Reject sparse arrays explicitly, consistently with the utility's refusal to silently drop or change unsupported values.

### Regression coverage

Sparse arrays of different lengths, including nested sparse arrays, must throw. Dense arrays must retain deterministic serialization and hashing.

## 7. History ticks bypass request invariants

**Priority:** P2 — medium  
**Location:** `runtime/src/mind/adapter.ts:44` and the subsequent history-order checks.

### Finding

The current request tick is checked with `Number.isSafeInteger`, but history ticks are checked only using ordering comparisons. Fractional ticks can satisfy those comparisons, and comparisons against `NaN` are false, allowing it to bypass the ordering guard.

### Reproduction

With an otherwise valid request at tick `3`, a history exchange at tick `1.5` or `NaN` produced an empty violations list.

### Required correction

Require every history tick to be a positive safe integer before applying strict ordering and past-tick checks.

### Regression coverage

Reject fractional, non-finite, zero, negative, and unsafe-integer history ticks, while retaining coverage for duplicate, out-of-order, and future ticks.

## Sign-off criteria

- Correct the findings above and add regression tests.
- Rerun typecheck, lint, the complete test suite, build, and compiled CLI smoke tests.
- Verify the supported Node.js 24 environment through CI or an equivalent local run.
- Keep verification offline and credential-free; no Docker or live-model execution is necessary for these fixes.
