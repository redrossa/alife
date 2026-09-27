# Phase 3 verification findings

## Verdict

**Phase 3 offline verification PASSES. The lifecycle review is COMPLETE.** L1 and L2 are closed by the fixed acceptance gate in `phase-3-final-lifecycle-tdd-plan.md`. R1, R2-A/R2-B, R3, policy changes, and PC1 remain closed. Historical unresolved descriptions below are superseded by this verdict.

This review supplements `.plans/phase-3-implementation-results.md` and uses `.plans/first-runnable-system.md` as the approved contract. References describe the reviewed source and may move during fixes.

**Final TDD handoff and completion gate:** `phase-3-final-lifecycle-tdd-plan.md`. The original RED baseline was **41 failures and 11 passes**. Independent verification now passes all **52 unchanged acceptance tests** and the full **303-test suite**. The agreed gate is met; no additional exploratory audit or acceptance condition is imposed.

**Earlier implementation design:** `phase-3-lifecycle-uncertainty-implementation-plan.md` gives the invariant-based architecture for R2-A/R2-B. The final TDD handoff now governs completion of the remaining L1/L2 work.

## Final acceptance verification — L1/L2 closed

Independently executed on **Node 24.14.0**:

- Both frozen acceptance-file SHA-256 hashes match the handoff exactly.
- Targeted acceptance: **52/52**, three consecutive runs, zero cancellations or skips.
- Full unit suite: **303/303**, 56 suites, zero cancellations or skips.
- Typecheck, lint, build, compiled fake-config validation, and `measure:packing`: all pass.
- The reported earlier-test changes preserve coverage while applying the frozen unknown-signal contract; the offline fixture still exercises the real backend with in-memory engine transport. No test-environment bypass was found in the targeted lifecycle files.

GREEN evidence: `/tmp/alife-lifecycle-final-green-{1,2,3}.log` and `/tmp/alife-lifecycle-final-full-green.log`.

No production or test code was changed during this verification. No Docker operations, privileged integration reruns, or live-model calls were performed. The implementer's reported OrbStack integration results were not independently rerun and are separate from the completed offline gate.

**Closure:** L1 signal/evidence ownership and L2 epoch restart eligibility meet the agreed acceptance contract. This concludes the lifecycle review.

## Previous invariant-implementation verification — historical

**Passed on Node 24.14.0:** typecheck, lint, build, compiled CLI validation, and **251/251 tests in 49 suites**. Packing measurements also completed successfully. No runtime source edits, Docker operations, privileged integration reruns, or model calls.

### Original R2-A and R2-B reproductions closed

- Independent rerun of the original real-poller/preparation race now starts only A. B is refused before transport start, its refusal is recorded, its ID stays spent, and A's uncertainty remains latched.
- Final admission checks run after all preparation awaits and after the synchronous caller hook, directly before the transport commitment.
- Shutdown retains pre-stop uncertainty rather than converting it into a clean outcome. Run classification consumes the actual matching-epoch stop assessment, and checkpoint schema 3 independently rejects unsafe assessments.
- The expanded deterministic suite covers held run/backend stopping records, drain interleavings, late inspection answers crossing shutdown, vanished containers, failed removal records, concurrent/repeated stops, and orphan checkpoint artifacts.
- This is a substantive invariant-based correction, not another observation-only guard.

### L1. In-flight signal evidence is omitted from the sealing barrier — P1

**Locations:** `runtime/src/world/jobs.ts:640–717` (`signal`); `runtime/src/world/backend.ts:988–1007` (evidence settlement and sealing).

`signal()` participates in neither the serialized submission drain nor the background evidence set. A stop can therefore certify the epoch before that operation's required outcome record finishes.

**Deterministic offline reproduction using the real DockerWorld and in-memory engine:**

1. Start a world and running job.
2. Issue an operator signal and hold its already-invoked start response behind a barrier.
3. Stop the world while that response is pending.
4. Stop returns `verified: true`, `recorded: true`, with a sealed, review-free assessment.
5. Release the signal response, but reject its required `job.signalled` record.
6. The signal operation rejects; the retained assessment remains clean.

The record wrapper skips marking evidence failure once the safety object is sealed. This is not cured by mutating that immutable assessment afterward: sealing happened too early.

**Scope qualification:** reproduced a false clean **world stop assessment**, not a full-run checkpoint bypass. The run predicate would accept that assessment if its other conditions were met. The reproduction used an operator signal; both agent and operator signals share the omitted operation tracking.

**Required correction:** register every in-flight signal/control operation and its required outcome evidence before its first await. Close admission for new signal operations when shutdown begins, while retaining administrative whole-world stop capability. Drain/account for already committed operations before sealing, without making successful evidence writes a prerequisite for physical stopping. Operator permission to signal a review-required but still-running world is not permission to create untracked work during finalization. Add held-response, rejected-outcome-record, and stop-overlap regressions for both signal origins. Check the operation inventory rather than assuming shell submissions are the only foreground evidence producers.

### L2. Zero-command epochs bypass the predecessor-review guard — P2

**Location:** `runtime/src/world/backend.ts:640–648`.

The restart guard applies only when `previous.snapshot().committedEffects > 0`. This conflates a refused startup that admitted no execution with a world that successfully ran but happened to receive no shell command.

**Deterministic offline reproduction using the real DockerWorld:**

1. Successfully start the world without submitting a job.
2. Reject `world.stopping`; physical stop and removal succeed.
3. The stop returns `recorded: false`, `requiredEvidenceFailed: true`, `reviewRequired: true`, `sealed: true`.
4. Restore recording and call `start()` on the same controller.
5. Startup succeeds with a new epoch and open admission; the previous evidence/review failure is no longer the controller's current safety condition.

**Required correction:** track successful epoch startup explicitly. A successfully started predecessor always requires a verified, fully recorded, review-free stop before same-controller restart, even with zero shell commands. Keep the narrow safe retry exception for a refused startup that never admitted execution; a zero command counter alone does not establish that exception. Preserve the old receipt and review requirement. Add both negative zero-command/failed-record and positive refused-start retry regressions.

### Additional diagnostic qualification

A repeated absent-container stop derives its `recorded` flag from only that attempt's errors, so it can say `recorded: true` after a preceding stop had missing records. The retained safety evidence failure still prevents clean certification; this is **not** another demonstrated checkpoint bypass. Clarify whether this field describes the current attempt or cumulative epoch evidence, and keep CLI/report language consistent.

The historical sections below retain earlier evidence; this latest section supersedes their status descriptions.

## Previous R2 race-fix verification

Node **24.14.0**: **214/214 tests in 42 suites**, typecheck, lint, build, and compiled CLI fixture validation passed. No runtime source edits, Docker operations, privileged integration reruns, or model calls.

### What is now fixed

- Submission refresh rejects an already uncertain job via `UncertainJobsError`, before creating the next exec.
- Uncertainty discovered by background polling remains visible to subsequent admission checks.
- The loop records affected action identities and requires review when submission reports that uncertainty.
- The final loop check catches uncertainty established after the last observation but before that check, including a final wait tick.

These close the previous exact reproductions, but not the full lifecycle invariant.

### R2-A: uncertainty during preparation still permits dispatch — P1

**Location:** `runtime/src/world/jobs.ts:268–316`.

The uncertainty check runs before awaited exec creation, the preparation hook, and the durable world record. The final dispatch barrier checks closure and operator withdrawal, but not newly established uncertainty.

**Independent deterministic reproduction using the real JobTable and its actual background poller:**

1. Job A is confirmed running.
2. Job B passes submission refresh and admission.
3. Pause B's preparation hook, representing an awaited durable preparation write.
4. Make inspections of A raise `ExecGoneError`; wait for the background poller to establish and record A as `uncertain`.
5. Release B's preparation hook.

Observed: **B starts and returns `running`; two executions started, with A already uncertain before B's start.** A separate explicit-refresh interleaving reproduces the same result.

**Required correction:** enforce established uncertainty at the final synchronous dispatch barrier, after all awaited preparation work and with no asynchronous gap before requesting start. Preserve the prepared-but-not-started outcome and affected uncertain job identities. Add a deterministic poll-during-preparation regression, not just a poll-before-submission test.

### R2-B: final-check-to-stop race still produces a clean checkpoint — P1

**Locations:** `runtime/src/core/loop.ts:228`; `runtime/src/operator/run.ts:350–361`; `runtime/src/world/backend.ts:885–915`; `runtime/src/world/jobs.ts:638–649`.

The loop's final check is followed by awaited stopping records and quiescence. During that interval, inspection can establish uncertainty before `beginWorldStop()`. `endWithWorld()` explicitly converts an already uncertain job to `ended_with_world`, and checkpoint eligibility still relies on the earlier `end.clean` result.

**Independent deterministic offline full-run reproduction:**

1. A shell action returns `running`.
2. The loop's final uncertainty check returns an empty list.
3. While recording `run.stopping`, an inspection receives `ExecGoneError` and establishes the job as `uncertain`, before shutdown begins.
4. Stop follows the backend's JobTable sequence: quiesce, begin stop, end with world.
5. The known uncertainty is overwritten, and the run creates a clean checkpoint.

```text
finalCheck: []
beforeStop: uncertain
afterStop: ended_with_world
afterStop uncertainJobs: []
state: completed
reason: tick_limit
readCheckpoint: accepted
analysis.uncertainActions: []
transitions: running -> uncertain -> ended_with_world
```

The reproduction used the real `startRun`, loop, JobTable, records, analyzer, and checkpoint writer/reader, with a fake transport and world lifecycle following the backend stop sequence. Actual `DockerWorld.stop()` was inspected, not executed. Historical private evidence run: `<OS_TEMP>/alife-r2-stop-Pc5BJG/runs/r-20260925T161449Z-1254320d`. The machine-specific temporary-directory prefix is omitted for publication; this evidence is not bundled.

This is **not** a late inspection crossing intentional shutdown or merely unavailable exit status. Uncertainty was established before the stop epoch. A later verified world stop does not recover the prior unknown execution outcome.

**Required correction:** preserve pre-stop uncertainty as a lasting lifecycle fact through shutdown, even if physical job state subsequently changes. Propagate affected identities into the run's evidence and checkpoint eligibility at the actual shutdown boundary. Do not close this with another earlier snapshot check. Test both the pending `run.stopping` record and backend stop preparation/quiescence windows, asserting review, retained uncertain action identities, and no checkpoint.

The historical sections below retain earlier evidence; this section supersedes their status descriptions.

## Previous lifecycle-fix verification

- Node **24.14.0**: typecheck, lint, build, compiled CLI validation, **207/207 tests in 40 suites**, and packing measurements passed.
- No privileged integration rerun, Docker operations, live model calls, or runtime source edits.
- **R1 closed:** `DockerWorld.startCleanup` preserves structured cleanup evidence. Full `startRun` coverage with the real backend and a failing world log now yields `recovery_required`, with `verified: true`, `recorded: false`, and the cleanup evidence retained in the run record.
- **R3 closed for the reported reproductions:** generating summaries no longer acknowledges delivery; finished unacknowledged jobs keep admission slots rather than being silently evicted. Repeated submissions without observations cannot overflow the notification backlog. Successful model invocation acknowledges the reported finished jobs; failed or unsent requests preserve them conservatively. Describe this boundary accurately rather than claiming acknowledgment occurs immediately on sending.
- **R2 partially fixed:** uncertainty visible in the next sampled observation now blocks the next request/action and prevents a clean checkpoint. The remaining race below is not covered by that check.

### Remaining R2 race: uncertainty established after sampling — P1

**Locations:** `runtime/src/core/loop.ts` sampled-job uncertainty check and clean-end handling; `runtime/src/world/jobs.ts:255–261` submission refresh/admission.

1. Tick 1 starts job A and confirms it running.
2. Tick 2 samples A as running.
3. The engine forgets A after sampling.
4. Submitting job B refreshes existing jobs. That refresh changes A to `uncertain`, but admission still starts B if another slot is available.
5. The tick limit ends the run before another observation can detect the uncertainty.

An offline full-run reproduction using the actual JobTable and real recorder/checkpoint writer returned:

```text
state: completed
reason: tick_limit
commands started: 2
checkpoint accepted by readCheckpoint(): true
analysis.uncertainActions: []
world job transition: running -> uncertain
```

An additional independent direct-JobTable reproduction confirmed that a `running` summary followed by `ExecGoneError` during the next submission still starts the second command, even though the first job's uncertainty has already been established and recorded by the world.

**Required correction:** propagate established uncertainty independently of observation timing. It must block further dispatch and disqualify clean finalization even when no next tick occurs. Preserve the affected job/action identity in run analysis. Add a deterministic regression that introduces the loss after sampling, and exercise uncertainty discovered by submission refresh/background inspection as well as the final tick. Do not merely add another observation-only check; make the uncertainty persist as a lifecycle condition until review.

The historical sections below retain earlier findings and then-current statuses; this section supersedes them.

## Previous fix reverification

### Checks

- Node **24.14.0**: typecheck, lint, build, compiled CLI validation, and **203/203 tests in 40 suites passed**.
- Packing measurements rerun successfully, including the 1M configuration.
- Additional read-only audits and offline reproductions checked real backend cleanup, the run/checkpoint path, cancellation boundaries, record accounting, inline hashes, production fake-mind retention, and job observations.
- Independently checked stored-file byte accounting against actual disk bytes and verified rejection of the original corrupt inline reference, plus a Unicode/BOM round trip.
- No privileged integration rerun, Docker operations, live model calls, or runtime source edits.

### Resolved behavior

- Full/closed world logs no longer prevent the actual engine stop. Startup also attempts cleanup after post-start recording failure.
- Immediate `unconfirmed`/`uncertain` dispatch results now end for review with no checkpoint.
- Operator cancellation prevents new dispatch across the tested pre-effect boundaries, including held preparation writes through the real JobTable. Already-started work is not replayed.
- Production FakeMind no longer archives every request; capture is explicit test instrumentation, and script indexing uses the tick.
- Initial run artifacts now count against the record limit, with preflight rejection before creating a run when initial data plus tick reserve cannot fit.
- Inline and blob evidence both validate byte length and hash.
- Job observations now disclose inspection failures and last-established timestamps; successful inspection clears the stale failure.
- The original zero-retention/simultaneous-completion case now reports terminal states before eviction under normal one-submission-per-observation tick ordering.
- Observable behavior changes received new profile versions. This is not approval of pending perception choices.

### R1. Failed-start cleanup drops incomplete-recording evidence — P2

**Locations:** `runtime/src/world/backend.ts:612–671`; `runtime/src/operator/run.ts:263–279`.

The physical safety stop is fixed. However, backend startup can perform that stop internally and report missing stop records only in its thrown error text. The operator layer then sees an absent/stopped container, skips its own stop call, and enters `completed`, without preserving the internal cleanup's `recorded: false` result.

An offline full-episode reproduction returned:

```text
state: completed
reason: world_start_failed
worldStop: null
checkpointSha256: null
```

The detail listed failed `world.stopping`, `world.stopped`, and `world.container_removed` records. Finalization refused the completed run.

This no longer leaves the container running, and no clean checkpoint is produced in this path. The residual defect is incorrect evidence/lifecycle classification, contradicting the report's claim that an incompletely recorded stop always requires review.

**Required correction:** preserve structured cleanup evidence across the startup exception boundary. An absent container proves it is not running; it does not prove cleanup was fully recorded. Add a full `startRun` regression combining internal startup cleanup and persistent world-log failure, asserting recovery-required classification and retained stop evidence.

### R2. Later job uncertainty still permits another action and a clean checkpoint — P1

**Locations:** `runtime/src/core/loop.ts:243,382–384`; `runtime/src/world/jobs.ts` inspection transition to `uncertain`; run/checkpoint finalization.

The new uncertainty guard checks the most recent dispatch result. It does not handle a previously running job becoming uncertain in a later observation.

An offline reproduction used the actual JobTable: the first action returned `running`; a subsequent inspection raised `ExecGoneError`, changing that job to `uncertain`. The loop sampled and rendered that uncertainty but started a second command and ended:

```text
state: completed
reason: tick_limit
checkpoint: non-null, accepted by readCheckpoint()
analysis.uncertainActions: []
```

The checkpoint's observation contained the first job's unknown state. This does not mean the first job never started: its earlier running state was known. The newly unknown execution outcome is nevertheless not preserved as an uncertainty requiring review under the approved contract.

**Required correction:** handle later established job uncertainty as well as immediate dispatch uncertainty. Record the affected identity and known history, stop further scheduling, and prevent a clean checkpoint pending review. Keep ordinary running jobs and a transient failed inspection with explicitly stale last-known state distinct from a job classified `uncertain`. Test a running-to-uncertain transition through the full loop and run analyzer, not only initial uncertain return values.

### R3. Terminal-feedback guarantee still needs a precise scope

**Locations:** `runtime/src/world/jobs.ts:454–474,513–517`; `runtime/src/config/profiles.ts` continuing-job and sensor definitions.

The normal-loop regression is fixed. Two narrower qualifications remain:

1. `summaries()` acknowledges a finished job when the sample is generated, before context assembly, durable observation recording, or mind invocation. A discarded sample can therefore consume the notification. Current failure paths generally end the run; no silent loss during otherwise successful normal ticks was demonstrated. Do not equate sample generation with guaranteed model receipt.
2. The API still evicts unreported completions beyond `maximumConcurrentJobs + 1`. With concurrency 1, zero retention, and ten sequential completed submissions without observations, only jobs 8 and 9 remained in the next summary; jobs 0–7 had `job.evicted` with `reported: false`.

Normal Phase 3 ordering (one submission between observations) avoids the second case. The bound relies on that prerequisite, but the backend API does not enforce it and the profile's retention promise is unconditional.

**Required clarification/correction:** state the delivery boundary and supported ordering accurately, or enforce notification-aware admission/acknowledgment so the wider promise holds. Do not characterize this reproduction as evidence that the ordinary tick loop still loses every completion.

### Pending policy decisions

The revised report lists later job output and worst-case listing size as open perception choices, and recategorizes the other original items as plan-derived or implementation conventions. This review does **not** grant operator approval to those choices merely because they were reclassified. Discuss pending choices explicitly, one at a time, as requested.

The original findings below are retained as historical evidence. Their descriptions of old behavior are superseded where the resolved behavior above says otherwise.

## Initial verification performed

- Node **24.14.0**: typecheck, lint, build, compiled CLI configuration validation, and **188/188 tests in 38 suites passed**.
- `npm run measure:packing` reproduced the submitted packing results, including the 1M configuration.
- Read-only audits of the loop, context/perception, run lifecycle, accounting, records, checkpoints, and finalization.
- Additional offline reproductions used real runtime components with fake worlds/transports, including a real exhausted event log and the real run/checkpoint writer.
- **No privileged integration rerun.** The reported 21 passing integration tests remain implementation-session evidence, not independently rerun results here.
- No Docker resources, model calls, engine restarts, or runtime source edits. This findings document is the review artifact.

## 1. Persistent world-log failure prevents the safety stop — P1

**Locations:** `runtime/src/world/backend.ts:655,807–825,989`; `runtime/src/operator/run.ts` failed-start and final cleanup paths.

### Finding

`DockerWorld.stop()` must successfully append durable `world.stopping` before it quiesces submissions or sends the engine stop request. If the world log is full or persistently unwritable, it throws before attempting to stop the container.

This also defeats the submitted failed-start cleanup fix: `world.started` and `world.verified` are recorded after container startup. If those writes fail persistently, calling the same `stop()` hits the same failed evidence store. Closing the backend afterward does not stop the container.

### Evidence

An offline reproduction instantiated the actual `DockerWorld` with a correctly named/labelled running mock container and a real `JsonlEventLog` whose capacity was exhausted. Both `stop("world_start_failed")` and `stop("record_failure")` failed:

```text
error: event log would exceed its 1-byte record limit
running: true
engine calls: GET /containers/<world-name>/json
```

Neither attempted POST `/stop`. The tiny test limit models exhausted remaining capacity; the production world-log limit is 256 MiB.

The real backend stop path was reproduced; a complete real-backend startup was not run. The source establishes its connection to the failed-start cleanup.

### Required correction

A failed attempt to record a safety stop must not prevent the identity-checked stop attempt itself. Preserve evidence uncertainty and do not report a clean checkpoint when necessary records failed. Keep storage intact and avoid unrelated resources.

Add backend-level regressions with a full and a failed/closed real logger, including a startup record failure after the container became running. A FakeWorld whose stop is independent of recorder health does not cover this defect. This is an alive-controller cleanup failure, not deferred watchdog work.

## 2. Uncertain world actions produce clean checkpoints — P1 / approved-policy contradiction

**Locations:** `runtime/src/core/loop.ts:419–438`; `runtime/src/operator/run.ts:330–352`; `runtime/src/records/checkpoint.ts`; `runtime/src/records/finalize.ts:113–115`.

### Finding

The loop records `action.uncertain` for an `unconfirmed` or `uncertain` job, then continues normally. Analysis removes that action from the outstanding set. A later clean limit stop can therefore create an accepted clean checkpoint despite unresolved execution uncertainty.

This is explicitly disclosed as decision 8 in the implementation report, but conflicts with the approved interruption contract: do not rebuild resumable state from uncertain effects. A verified world stop establishes that processes are no longer running; it does not establish whether the earlier command executed or what effects it had.

### Evidence

Full offline `startRun` reproductions used the real recorder/checkpoint writer, one fake shell turn, a FakeWorld returning respectively `unconfirmed` and `uncertain`, and a verified stop. Both returned:

```text
state: completed
reason: tick_limit
completedTicks: 1
recorded: true
checkpointSha256: non-null
```

`readCheckpoint()` accepted both. Analysis retained one uncertain action but reported no outstanding actions. Finalization then refused the completed run.

No command replay or actual resume was demonstrated; resume is not implemented yet. The defect is already present in the clean classification and checkpoint eligibility.

### Required correction

Apply the approved uncertainty boundary: stop further scheduling, preserve the unknown outcome, stop the world, and require review/finalization rather than issuing a clean checkpoint. Keep ordinary known-running jobs distinct from uncertainty; bounded wait expiry alone must not trigger this path.

Add full-episode tests for both uncertain states and assert recovery-required status, no clean checkpoint, retained uncertainty, and no redispatch. A different policy requires explicit operator approval, not an implementation-side reinterpretation.

## 3. Operator stop can arrive before dispatch yet a new command still starts — P1

**Locations:** `runtime/src/core/loop.ts:270,328–365,384–403`.

### Finding

The loop checks the stop signal before recording/sending the model request, but does not guard the later action dispatch or the completion of the asynchronous preparation hook. A stop arriving while recording the model reply or preparing the command can therefore be followed by a new world mutation.

This is different from allowing an already-dispatched command to finish its bounded wait. The README describes that latter behavior; the approved stop contract says to stop scheduling new work.

### Evidence

Offline reproductions aborted the signal at two boundaries:

1. After `model.responded` was recorded, before interpretation/dispatch.
2. At completion of `action.prepared`, before the fake world's execution.

In each case, `echo changed > /world/file` was subsequently dispatched. With a zero cadence delay, the loop then returned clean `operator_stop` and recorded the intervention only between ticks.

The dispatch was also observed using the real run recorder. That first fixture's synchronously throwing fake sleep caused a separate final error; a second zero-cadence reproduction isolated the stop/dispatch defect and its clean operator-stop result.

### Required correction

Check cancellation at the relevant pre-effect boundaries, including after awaited durable preparation and before starting the execution. Preserve truthful accounting and paired tool results for refused actions. Do not cancel or replay work merely because an already-started action outlived its wait.

Add deterministic tests holding reply recording and preparation recording, requesting stop while held, and proving no new command starts when released. Also cover stop arrival during the pre-request record writes.

## 4. Production FakeMind keeps every previous full request in memory — P2

**Locations:** `runtime/src/mind/fake.ts:60–61,84–85`; `runtime/src/mind/create.ts:32`.

### Finding

`FakeMind.requests` appends every full request and is also used to index the script. The production fake-mind factory uses this same implementation. Consequently observations, replies, result text, and history arrays remain reachable after the context policy evicts their exchanges.

The request sent on the next tick is correctly packed; there is no evidence of old content being reinjected into model-visible context. The defect is controller memory retention growing with the episode instead of being bounded by active context. Durable record limits do not bound this separate in-memory request archive.

### Required correction

Separate script position from request capture. Make full-request recording optional test instrumentation, not production behavior; keep observer evidence in the bounded run store. Retain only bounded production state.

Test production factory behavior across repeated eviction while still permitting a test spy to inspect requests. Do not describe the existing all-request array as bounded working memory.

## 5. Initial run artifacts bypass the observer record-capacity limit — P2

**Locations:** `runtime/src/operator/run.ts:189–196`; `runtime/src/records/run-store.ts:88–117`.

### Finding

Resolved configuration, prompt, tools, fake script, and manifest are written before the recorder opens. The recorder counts events, blobs, and checkpoints, but not those initial files. Actual run data can therefore exceed `operator.recordLimitMiB` while the recorder reports substantial remaining space.

### Evidence

An offline full-episode reproduction used a valid 16 MiB fake script (one wait turn plus trailing JSON whitespace), a 16 MiB record limit, and one tick:

```text
result: completed, 1 tick
configured limit: 16,777,216 bytes
actual run files: 16,791,725 bytes
recorder usedBytes: 9,354 bytes
```

The omitted overhead is bounded by source-file limits; this is not unlimited growth. Nevertheless, the broader observer/run-store cap is not enforced across the run's files.

### Required correction

Include initial artifacts in shared accounting and admission, including reopen/finalization accounting as applicable. Refuse an oversized initial record set before world effects. If distinct budgets are intended instead, declare and validate them explicitly rather than presenting one limit as the whole observer-store cap.

Add actual-file-size tests near the configured limit, not only tests of `remainingBytes()`.

## 6. Inline text evidence bypasses hash and size verification — P2

**Location:** `runtime/src/records/run-store.ts:163–168`.

### Finding and reproduction

The reader documents hash verification, but immediately returns inline text. Blob references verify both length and hash; inline references do neither.

```ts
await readText(paths, {
  text: "changed",
  sha256: "0".repeat(64),
  bytes: 1,
});
// Returns "changed" without rejecting either mismatch.
```

This is an evidence-integrity defect, not a demonstrated action-execution or resume exploit.

### Required correction

Verify byte length and SHA-256 for both reference forms before returning text. Add inline corruption, incorrect-size, and valid round-trip tests, including Unicode.

## 7. Job inspection failures disappear from mind-visible observations — P2

**Locations:** `runtime/src/world/jobs.ts:387,488–498`; `runtime/src/core/observation.ts` job rendering; `JobSummary` contract.

### Finding

A failed engine inspection preserves the last known job state and puts the failure in `JobSnapshot.detail`. Summaries discard that detail and the observation timestamp. The agent therefore receives an unqualified `running` state even when the latest inspection failed.

### Evidence

With the real JobTable, make inspection throw `EngineUnavailableError("gone")` after initially observing a running job:

```text
inspect().detail: last inspection failed: gone
summaries(): [{ jobId: "a", state: "running", exitCode: null,
                rootPid: null, stdoutBytes: 0, stderrBytes: 0,
                output: "open" }]
```

The renderer has no freshness/failure field from which to disclose uncertainty. This is separate from the intentional decision to omit later output bytes.

### Required correction

Carry bounded observation freshness/error information through the sensory contract and rendering. Distinguish last-known state from a successfully refreshed state. Include a recovery test where a later inspection succeeds and stale failure information is cleared or explicitly dated.

## 8. Completion feedback can be evicted before it is ever perceived — P2 / interface-contract gap

**Locations:** `runtime/src/config/schema.ts:73`; `runtime/src/world/jobs.ts:450–455,483–498`; `runtime/src/core/tools.ts:24–25`; `runtime/src/core/observation.ts:244`.

### Finding and reproduction

The tool/result text promises that later observations report a continuing job's status. But the validated configuration allows `retainedFinishedJobs = 0`, and summary generation refreshes and evicts before returning observations.

Using the real JobTable:

```text
submit(): running
execution subsequently exits with code 7 and EOF
next summaries(): []
```

Positive retention smaller than a simultaneous batch of completions can lose some terminal feedback too. The usual example retention is larger, so this is not a claim that the default configuration drops every completion.

### Required correction

Either guarantee a bounded terminal notification before eviction, or explicitly define and disclose lossy completion feedback in the profile and tool/result wording. Test the zero-retention and simultaneous-completion cases. Bounded history is valid policy; an unqualified promise that the implementation cannot honor is not.

## Policy and calibration notes

These are distinct from the demonstrated defects above:

- **Later job output:** the report deliberately exposes later state and byte counts, not retained stdout/stderr. That is not an accidental rendering bug. It needs explicit interface documentation and review against the approved usable job-management requirement; do not claim the agent can retrieve retained output through a tool that does not exist.
- **Versioned profiles:** the report says existing profile definitions were amended instead of adding versions. Repository guidance requires behavior changes through new profiles. Distinguish harmless documentation completion from observable changes, and version the latter rather than relying on an unapproved exception.
- **Packing estimates:** the measured results reproduce. However, smaller provider-reported token counts will not by themselves increase retention while packing continues to use `utf8-bytes-v1`. Provider-token-based packing could improve retention after a declared estimator change; the report's claim that real retention automatically will be higher is too strong.
- **Fake output ceiling:** scripted fake replies may exceed the declared maximum output-token allowance (including intentionally adversarial fixtures). Label such measurements accordingly; do not present them as proof of output-ceiling-conforming live behavior.
- **Damaged terminal logs:** a completed run with a subsequently appended partial JSON tail reports the damage, but finalization refuses because its last lifecycle state is terminal. This is a recovery-scope limitation, not a demonstrated ordinary crash or replay defect; clarify the report's damaged-log fallback claim rather than implying it applies to every damaged run.
- Seed freezing, live-model token/pricing verification, resume, external stop/watchdog, and comprehensive crash injection remain their declared later gates. Their absence was not counted as a Phase 3 implementation bug.

## Sign-off criteria

1. Fix the safety and evidence defects above with deterministic regression tests.
2. Resolve the completion-feedback contract and version/document experimental behavior consistently.
3. Do not accept report decision 8 as overriding the already approved uncertainty contract without explicit operator approval.
4. Rerun typecheck, lint, unit tests, build, compiled CLI validation, and packing measurements on Node 24.
5. With explicit authorization, rerun disposable labelled Docker integration tests. Include real-backend cleanup under recording failure where safely reproducible; do not restart an engine hosting unrelated resources.
6. Update the implementation results with actual verification scope, remaining limitations, and accurate packing claims.

Passing the existing 188-test suite does not close these findings.
