# Phase 2 verification findings

## Verdict

All six original findings and both follow-up gaps (R1 and R2) are now verified resolved in the reviewed code and offline tests. No outstanding defect remains from this review. This closes the code-review findings, not independent privileged integration verification: Docker integration tests were not rerun in this verification session.

This document supplements `.plans/phase-2-implementation-results.md`; it does not replace the implementation report or claim that its integration results were independently rerun.

## Final fix verification

- Node **24.14.0**: typecheck, lint, build, compiled CLI configuration validation, and all **149 unit tests in 30 suites passed**.
- **R1 resolved:** the first preparation-record failure latches admission closed to further submissions before exec creation. Independently queued 1,000 distinct submissions against a real one-byte-limit `JsonlEventLog`: all rejected, only one exec created, zero starts, zero events. Failed IDs no longer accumulate without bound. Regression coverage also exercises preparation-hook failures and healthy hooks after failure.
- **R2 resolved:** helper drainage requires actual EOF. Premature closure records an explicit stream problem. Independently reran the real `runHelper`/`captureInto` path with a fake engine emitting a valid tar then `closed`: `complete: false`, an explicit `closed without end-of-file` omission, and the received entry retained.
- Reviewed the corresponding EOF handling added to job collectors and `runControl`; regressions confirm premature closure is failed/incomplete while normal EOF remains accepted.
- Earlier lifecycle, duplicate-ID, stop-epoch, signed timestamp, and BOM regressions continue to pass.
- No runtime source edits, Docker resource operations, engine restarts, or model calls were performed. Only this findings document was updated.
- Privileged integration verification still requires explicit authorization. Existing implementation-session integration results are not represented as independently rerun results here.

The sections below preserve earlier review evidence and their then-current statuses. Their unresolved language is historical and superseded by this final verification.

## Previous fix reverification

### Checks

- Node 24.14.0: typecheck, lint, build, compiled CLI configuration validation, and all **142 unit tests in 29 suites passed**.
- Reviewed the submission barrier, backend stop/close ordering, stop-epoch handling, durable ID reload, and capture/parser changes and regressions.
- Independently reproduced both remaining gaps below using real runtime code with offline transports/helpers. No Docker resources or paid APIs were used.
- Privileged integration tests were not rerun; their reported results remain implementation-session evidence, not independently verified results.
- No runtime source files changed during reverification.

### Status of the original findings

| Finding | Reverification result |
| --- | --- |
| 1. Dispatch after closure | Fixed: post-record admission check plus awaited submission quiescence before backend stop/close. Regressions cover held hooks, durable writes with a real event log, and in-flight starts. |
| 2. Evicted ID reuse | Replay case fixed, including loading durable prepared IDs on start. Failure-path metadata bound remains unresolved; see R1. |
| 3. Stop-racing inspection | Fixed: stop epochs discard late answers, including errors; normal exits observed before stopping remain normal exits. |
| 4. Undrained capture | Missing-end drain timeout fixed. Premature closure without EOF can still report complete; see R2. |
| 5. Negative timestamps | Fixed: signed base-256 mtime decoding retains safe-integer bounds and rejects negative unsigned fields. |
| 6. BOM filenames | Fixed: filename decoding preserves leading U+FEFF and fatal invalid-UTF-8 handling. |

### R1. Failed preparation attempts bypass the claimed deduplication memory bound — P2

**Location:** `runtime/src/world/jobs.ts:203–206,260–267`

The new `#prepared` set retains every attempted ID before either preparation record succeeds. On a hook or world-log recording failure, submission throws but neither closes admission nor bounds the retained failure IDs. Subsequent distinct IDs can keep accumulating without adding bytes to the durable log.

Consequently, the implementation report's statement that the set is bounded by the world log's size limit is not true on this path. This is not a remaining duplicate execution: the attempted commands do not start. It is an unbounded metadata failure path introduced by retaining failed IDs indefinitely.

**Independent reproduction:** use the real `JobTable` and `JsonlEventLog`, a fake execution transport, and a one-byte log limit to force the same rejection as a full log. Submit 1,000 distinct IDs, then retry every ID to prove all remain retained.

```text
recordLimitBytes: 1
eventsWritten: 0
retainedSpentIdsProven: 1000
trackedJobs: 0
execsCreated: 1000
execsStarted: 0
```

**Required correction:** bound admission independently of successful log writes, or fail closed to further submissions after preparation-record failure. Preserve at-most-once protection; do not simply evict potentially dispatched IDs. Add tests for repeated hook failures and a full/rejecting real event log, proving further attempts cannot grow metadata indefinitely.

### R2. Premature stream closure is still accepted as successful drainage — P2

**Location:** `runtime/src/world/resources.ts:465–468` (consumed by completeness checking in `runtime/src/world/archive.ts`)

The end callback sets `drained = true` for all reasons, but only records an error for `reason === "error"`. Thus `reason === "closed"` without EOF is accepted as successful drainage when closure happens at a frame boundary. `engine.ts` distinguishes these events: readable `end` maps to `eof`, while readable `close` without a preceding end maps to `closed`.

**Independent reproduction:** use `FakeEngine` with the real `runHelper` and `captureInto`; emit a complete tar frame, report helper exit zero, and call `stream.finish("closed")` rather than EOF.

```json
{ "complete": true, "omissions": [], "entries": 1 }
```

This reproduces false completeness under premature closure, not an observed failure on a real Docker engine. Pending stderr warnings can be abandoned without disclosure.

**Required correction:** require actual EOF for successful stream drainage; record premature closure as a stream problem. Preserve existing explicit timeout/byte-limit/error reporting. Add a regression for `closed` without EOF at a frame boundary, alongside normal EOF, errors, and the already-covered missing-end timeout.

### Remaining sign-off work

Resolve R1 and R2, add their regression tests, rerun the offline checks, and rerun authorized integration tests. The original descriptions below are retained as historical findings, not claims that all six original bugs remain present.

## Initial verification performed

- Node 24.14.0: typecheck, lint, build, compiled CLI help/config validation, and all 128 unit tests in 27 suites passed.
- Node 25.8.1: all 128 unit tests passed.
- Reviewed storage/backend lifecycle, continuing jobs and execution transport, capture streaming, and tar indexing.
- Exercised additional offline mocks and generated archive fixtures described below.
- Did not rerun the reported 17 integration tests: those require explicitly enabling the privileged storage helper.
- Created or modified no Docker resources; performed no engine restart or model calls.
- Changed no runtime source files during verification.

Line references describe the implementation at review time and may move during fixes.

## 1. Pending submissions can dispatch after closure — P1

**Locations:**

- `runtime/src/world/jobs.ts:231–255`
- `runtime/src/world/backend.ts:715–716,736–790,916–919`

### Finding

Submission checks whether the job table is closed before several awaited operations, but does not recheck before starting the execution. Backend stop/close operations do not synchronize with pending submissions.

`close()` closes collectors and the event log without stopping the container. A submission awaiting completion of its durable `job.prepared` write can subsequently call `transport.start()`, despite job-table closure. The backend API therefore lacks a dispatch barrier before handle closure and potential ownership release.

### Offline reproduction

1. Start a submission using the real `JobTable` with `FakeTransport`.
2. Pause its recorder while writing `job.prepared`.
3. Call `table.close()`.
4. Release the recorder and await submission.

Observed:

```text
startsAfterClose: 1
actualRunning: true
reportedState: unconfirmed
collectorDestroyed: false
```

A separate reproduction paused the preparation hook, completed `beginWorldStop()` and `endWithWorld()`, then resumed submission; the fake transport still started the execution.

### Qualifications

- Do not interpret the fake-transport stop reproduction as proof that Docker executes commands after a verified container stop. Docker should refuse an exec against the stopped or removed container; it cannot migrate to a replacement container.
- During an actual stop, dispatch can race the stop request while the container still runs.
- Pausing only the preparation hook across a fully completed backend close normally encounters the closed real event log before dispatch. The stronger close scenario pauses the durable log write or leaves a transport start in flight. `JsonlEventLog.close()` drains writes, not their callers' subsequent dispatches.
- Current CLI commands do not submit jobs. This affects the existing backend API and its forthcoming run-loop integration, rather than demonstrating a current CLI exploit.

### Required correction and regression coverage

Make stop/close coordinate with pending submissions and in-flight starts. Ensure closure cannot finish while a submission can still initiate an untracked execution. Preserve honest uncertainty for requests already sent; do not retry or replay them.

Test closure and stopping at each awaited submission boundary, including durable preparation recording and transport start. Include backend-level coverage using the real event log, not only a no-op recorder.

## 2. Eviction defeats duplicate-dispatch protection — P1

**Locations:** `runtime/src/world/jobs.ts:232,416`

### Finding

Duplicate detection relies on the same map that evicts finished jobs. Evicting a job's retained history also removes the protection against dispatching its action ID again. There is no additional backend identity guard.

### Offline reproduction

Using the real `JobTable` and `FakeTransport`, with `retainedFinishedJobs = 1`:

1. Submit and finish action A.
2. Submit and finish action B.
3. List jobs, evicting A.
4. Submit action A again.

The third submission creates a third execution rather than being rejected. A command associated with A can therefore be dispatched twice.

### Required correction and regression coverage

Separate dispatch-identity protection from retained output/history. Protection must survive eviction without introducing unbounded in-memory metadata. Define the identity scope explicitly and preserve the no-replay contract across relevant lifecycle boundaries.

Add a regression proving that reuse of an evicted action ID is rejected before exec creation/start, while new IDs remain admissible and history remains bounded.

## 3. Stop-induced exits can be recorded as normal completion — P2

**Location:** `runtime/src/world/jobs.ts:341–360`

### Finding

An inspection that begins before `beginWorldStop()` can resolve afterward and transition the job to ordinary `exited`. `endWithWorld()` then preserves that classification. Checking the stopping flag only before the asynchronous inspection does not prevent this race.

This contradicts the implementation report's claim that stop-induced exits remain classified as `ended_with_world`.

### Offline reproduction

1. Submit a running job.
2. Begin an inspection and hold its transport response.
3. Call `beginWorldStop()`.
4. Resolve the inspection with `running: false, exitCode: 137`.
5. Complete `endWithWorld()`.

The job reports `exited` both before and after finalization, rather than retaining the stop-related classification.

### Required correction and regression coverage

Invalidate, synchronize, or conservatively handle observations that cross the stopping boundary. Do not turn a stop-racing response into evidence of ordinary completion.

Add a deferred-inspection regression covering this ordering and verify the resulting snapshots and recorded events. Also preserve legitimately observed normal exits that completed before stopping began.

## 4. Capture can report completeness after abandoning an undrained stream — P2

**Locations:**

- `runtime/src/world/resources.ts:507–510`
- `runtime/src/world/archive.ts:166–175`

### Finding

The helper races stream completion against a five-second drain deadline but does not record which won. If the deadline wins at a frame boundary, forced stream destruction leaves `streamProblem` null. Capture can then be marked complete despite abandoning unread output, including possible stderr omission warnings.

### Offline reproduction

A mocked helper:

1. Emits a valid tar archive.
2. Reports exit code zero.
3. Never delivers stream end.

After approximately 5,007 ms, capture returns:

```text
complete: true
omissions: []
```

The still-open stream has been forcibly destroyed.

### Required correction and regression coverage

Track whether stream completion was actually observed. Label a drain-deadline closure incomplete and record the reason, even when the received tar is structurally complete and helper exit status is zero.

Test valid tar plus missing EOF, delayed stderr, closure at a frame boundary, and normal completed drainage.

## 5. Valid negative timestamps halt archive indexing — P2

**Locations:**

- `runtime/src/world/tar.ts:125,291`
- `runtime/src/world/archive.ts:125–130`

### Finding

The numeric parser rejects all negative GNU base-256 values, including modification times. Negative modification times are valid metadata. A world user can set a pre-1970 timestamp, causing indexing to stop permanently for that entry and all subsequent entries.

Capture is correctly labeled incomplete on this parser error, and raw archive bytes are retained. The defect is unsupported valid metadata despite the advertised whole-second timestamp coverage, not silent archive loss.

### Offline reproduction

Generate a valid GNU-format archive with:

1. File `old`, with `mtime = -1`.
2. File `later`.

`TarReader` throws `negative mtime` and indexes zero entries. This was reproduced with a Python-generated GNU archive and independently with a correctly checksummed signed timestamp fixture.

### Required correction and regression coverage

Support signed timestamps while keeping appropriate nonnegative checks for fields such as sizes. Retain safe-integer/range validation.

Test negative, zero, and positive modification times and confirm that subsequent entries are indexed. Keep malformed and out-of-range numeric-field tests.

## 6. Filename decoding strips a leading UTF-8 BOM — P3

**Location:** `runtime/src/world/archive.ts:67–71`

### Finding

`TextDecoder` uses its default BOM handling. A legitimate filename beginning with U+FEFF loses that character in the decoded manifest path. Raw `pathBase64` remains correct, but distinct filenames can receive the same decoded path.

### Offline reproduction

Capture an archive containing files named `"\uFEFFname"` and `"name"`.

Observed:

```json
{
  "complete": true,
  "entries": [
    { "path": "name", "pathBase64": "77u/bmFtZQ==" },
    { "path": "name", "pathBase64": "bmFtZQ==" }
  ]
}
```

### Required correction and regression coverage

Preserve the BOM when decoding filenames, using `ignoreBOM: true` with fatal UTF-8 decoding.

Add a regression showing that both decoded paths remain distinct and match their raw bytes. Preserve the existing behavior for invalid UTF-8 names and continue escaping untrusted paths for terminal display.

## Sign-off criteria

1. Address the findings and add the regression coverage above.
2. Rerun typecheck, lint, build, compiled CLI checks, and the full unit suite on supported Node 24.
3. Rerun the integration suite with explicit authorization for privileged helpers, using disposable owned resources and data-preserving cleanup.
4. Add targeted integration coverage for lifecycle coordination and capture stream-completion reporting where practical; retain deterministic offline race tests.
5. Update the implementation report with the fixes, actual check results, and remaining limitations.
6. Keep engine-restart, controller-crash/watchdog, and host-sleep claims separate unless those scenarios are explicitly authorized and tested.

Passing the existing unit suite alone is not sufficient to close these findings.
