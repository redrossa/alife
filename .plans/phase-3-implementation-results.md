# Phase 3 implementation results

**Status:** implemented and verified on the tested OrbStack environment with the
scripted fake mind. The eight defects in `phase-3-verification-findings.md` and
its reverification items (R1–R3) are fixed with regression tests (see
"Verification findings and fixes"). R2-A and R2-B are addressed by
implementing `phase-3-lifecycle-uncertainty-implementation-plan.md`: see
"Lifecycle uncertainty invariant". The final lifecycle review (L1, L2) is
**closed**: its fixed acceptance gate in `phase-3-final-lifecycle-tdd-plan.md`
passes unchanged (see "Final lifecycle gate"), so the Phase 3 offline
verification gate is passed. The operator's
decisions in `phase-3-policy-decisions.md` are implemented (see "Operator
decisions"), with PC1 from `phase-3-policy-verification.md` fixed.
Sign-off is the reviewer's call. Prepared 2026-09-26; revised three times the
same day after verification and decisions. Keep uncommitted with the other plans.

Read with `first-runnable-system.md` (Phase 3, §§8–13) and
`phase-2-implementation-results.md`.

## What exists

| Plan item | Implementation |
| --- | --- |
| Tick loop (§11.1) | `src/core/loop.ts` (`TickLoop`). Per tick, in order: <br>1. Check limits: stop request, attempted model calls, deadline (wall and monotonic time), record reserve, host free space, and that the world is still running. <br>2. Sample sensors; render the observation; assemble context; validate the request. <br>3. Reserve the request's maximum cost; durably record `cost.reserved` and `model.requested`. <br>4. Invoke once, with the request timeout and stop signal. <br>5. Record the reply or failure; reconcile cost. <br>6. Interpret zero or one intention. <br>7. Record `action.prepared` durably in the dispatch hook; submit; record `action.completed`, `running`, `uncertain`, or `refused`. <br>8. Record `tick.completed`; then the cadence sleep. <br>A stop request is checked at every point before an effect (see below). Nothing is retried or replayed. If whether a dispatched command ran is unknown, or the engine later forgets a job's execution, the run ends for review before anything else is sent or dispatched. That uncertainty may be found in an observation, by the job table's refresh before the next dispatch, by background polling, or by a final check before any clean end; the job table then refuses every further dispatch. Once the mind has responded, the jobs its observation reported finished are acknowledged. Model calls attempted (including failures) and calls answered are counted at the invocation boundary, so a later failure in the tick cannot erase them. The tick limit counts attempts; a request refused before it is sent is recorded but is not an attempt. |
| Prompt/context policy (§9.3) | `src/core/context.ts`: `recent-complete-exchanges-v2`. Whole exchanges only; the newest contiguous run that fits. Room for the context-usage line is reserved before history is chosen, so its content cannot change what fits. Evicted exchanges are dropped for good. `ContextOverflowError` ends the run; nothing is sent. |
| Observations and results | `src/core/observation.ts` (`baseline-sensors-v4`, `shell-body-v4`): the sensor text, previous operational outcome, context line, and shell/wait/"Not executed" results. There is no directory listing. The shell tool text states that for a command still running after its wait, later observations report its status and output byte counts but not the output itself. A job whose latest inspection failed is shown with the time its state was last established and the failure. Each section has a computed size bound (`observationBound`, `actionResultBound`), and configuration validation checks the budget against the largest possible observation. |
| Jobs (`continuing-jobs-v2`) | Two additions to Phase 2's job table: <br>- A finished job keeps its admission slot until the mind has responded to an observation reporting it finished (`WorldBackend.acknowledgeJobs`); a failed or unsent request acknowledges nothing. Only delivered finished jobs are dropped, so every completion reaches the mind before retention can drop it, whatever order a caller uses. At most `maximumConcurrentJobs + retainedFinishedJobs` jobs are tracked. <br>- A dispatch can be withdrawn at the last moment before the start request (`DispatchHooks.proceed`). <br>- While any tracked job is `uncertain`, every submission is refused (`UncertainJobsError`); `uncertainJobs()` reports them. |
| Effect records (§11.3, §13.1) | `src/records/run-store.ts`: run directory layout; `RunRecorder`. Text over 16 KiB goes to content-addressed blobs. Everything in the run directory shares `operator.recordLimitMiB`: events, blobs, checkpoints, and the initial files. Every attempted effect has one pre-effect record and one outcome record. `readText` verifies size and hash for inline and blob text alike. Records hold request hashes and the exact text the mind perceived. |
| Simple reservations (§11.2) | `src/records/accounting.ts`: `CostLedger`, integer micro-USD rounded up. The maximum cost is reserved before sending. Known usage is charged; an unknown outcome keeps the whole reservation; a request certainly not processed (including one stopped before sending) is released. A request that does not fit the remaining spend is not sent (`spend_limit`). The fake mind uses zero rates. |
| Clean-stop checkpoints | `src/records/checkpoint.ts`: written only after a clean loop end and a verified, fully recorded world stop. Never overwritten; named by SHA-256; counted against the record limit. They hold loop state, the ledger (no outstanding reservations allowed), world identity, and the deadline. `readCheckpoint` verifies the hash and schema. Nothing resumes from a checkpoint yet (Phase 4). |
| Episode lifecycle (§12) | `src/operator/run.ts` (`startRun`). Refused before any record exists: paid configurations, a world already running, a prompt or script changed since validation, and initial records that leave no room for a tick. Then: records, attach, `ready`, start, `running`, the loop, and a verified stop. Clean ends go `stopping` → `stopped_clean` (operator stop, provider failure) or `completed` (limits). Uncertainty, an unverified stop, or an incompletely recorded stop go to `recovery_required`. A state counts as entered only once its event is durable. Every path after the container runs, including a failed start, stops the world. When a failed start stopped the world itself, its cleanup result (`startCleanup`) is kept. The run ends `completed` only if every stop involved was verified and fully recorded; otherwise it ends `recovery_required`, with the evidence in the record. |
| World stop under record failure | `DockerWorld.stop` attempts its records but never depends on them. A full, failed, or closed world log cannot keep a world running; the result reports `recorded: false`, and the run then requires review. `DockerWorld.start` stops the container after any failure once it is running, including a failed `world.started` or `world.verified` record. |
| Interrupted runs (§11.4) | `src/records/finalize.ts`. `analyzeRun` derives state, outstanding requests/actions/reservations, uncertain results, and log issues from the record alone; it refuses an unknown run ID. `isInterrupted` means active state and no owner that appears alive. `finalizeRun` refuses while the world runs and records the acknowledgement. On an intact log it appends; if the log is damaged or the record limit is unknown, it writes `finalization.json` beside the untouched log. This applies only to runs that are interrupted or awaiting review. A run that ended cleanly and whose log was damaged afterwards is reported by `run status` but not finalized. No exec reconciliation or replay. |
| CLI (§14) | `run status` and `run start` report model calls attempted, answered, and failed. `run start` (foreground; SIGINT/SIGTERM aborts a model request in flight, withdraws a command not yet started, and lets a started command finish its wait), `run status`, `run finalize --acknowledge-uncertainty`, and `lock status` / `lock release --token` for locks left by a dead controller. All untrusted text is escaped. |
| Packing measurement | `scripts/measure-packing.ts` (`npm run measure:packing`) runs the real loop, policy, and rendering on synthetic exchanges (results below). |

Supporting changes:

- Configuration validation's fixed request is now "prompt + tools + largest possible observation"; it was "a full action output". The retained-output check uses the tracked-job bound.
- Retired before any recorded run used them, and now rejected:
  - `shell-body-v2`, `baseline-sensors-v2`, `continuing-jobs-v1`, and `recent-complete-exchanges-v1`, because the tick loop made their behavior observable;
  - `shell-body-v3` and `baseline-sensors-v3`, because of the operator decisions.
- Checkpoint schema 2 records attempted and answered calls; schema 1 was only ever written by tests.
- The test fixture's context budget is back to 32,768 tokens. It was raised only to fit the listing.
- Job admission and dispatch errors moved to `src/core/dispatch.ts`.
- `DockerWorld.facts()` reports the engine and effective storage for the manifest.
- The run event types gain `action.running` and `action.refused`.
- `WorldStopResult` gains `recorded`; `WorldBackend` gains `acknowledgeJobs`; `DockerWorld` exposes `startCleanup`.
- The fake mind picks its turn by tick and keeps no requests; request capture is test-only instrumentation.
- Lock token mismatches are now refusals (exit 1), not internal errors.

## Operator decisions

The operator's decisions are in `phase-3-policy-decisions.md`, and the plan defers to them. This is how each is implemented:

1. **Continuing-job output.** Later stdout and stderr are not delivered; observations give status and byte counts. `shell-body-v4` changes only the shell tool's description, which now says this plainly: later observations report status and output byte counts "but not the output itself". A test checks that it contains no advice on redirection or managing output. The prompt is unchanged.
2. **Directory perception.** Observations no longer contain a listing (`baseline-sensors-v4`). The loop never requests one, and the renderer and size bounds have no listing section. The backend's listing reading remains for operator and diagnostic use. This removed the listing-size question. Without it, the request without history for the example body is about 25k estimator tokens instead of about 126k.
3. **Failed model calls and tick accounting.**
   - **Tick records:** every tick records whether a call was attempted and whether it was answered; the loop, checkpoint, run result, `run status`, and analysis carry the counts.
   - **Tick limit:** `operator.maximumTicks` counts attempted calls, failures included.
   - **Requests never sent** (refused by the spend limit, invalid, overflowing the context, or withdrawn by a stop before invocation) keep their evidence under a `request_not_sent` outcome and are not attempts.
   - **Failures:** a request aborted in flight, and any transport or provider failure, is a failed attempt. It ends the session with no retry; its conservative cost is kept.
   - **Answered calls:** refusals, invalid calls, and no-action replies count as answered.
4. **Context policy.** No change: `recent-complete-exchanges-v2`, a configurable budget (1,000,000 in the example configuration), and nothing summarized, retrieved, or reinjected. The 1,024-token output allowance and 512-token margin remain placeholders until a live model is selected.
5. **Engineering responsibility.** Delegated. The choices previously listed as pending are engineering choices under the safety and evidence contract. These are model-failure classification, failed-start handling, unexpected world stops, lifecycle additions, the record reserve, byte-order-mark handling, and a finished job holding its admission slot until reported. They remain subject to verification.

## Verification findings and fixes

`phase-3-verification-findings.md` reported eight defects. All are fixed. Each regression test was run with its fix temporarily undone and failed.

1. **A failing world log prevented the safety stop (P1).**
   - **Defect:** `DockerWorld.stop` required a durable `world.stopping` record before stopping, so a full or unwritable log left the world running. This also defeated the earlier failed-start fix.
   - **Fix:** Stop records are now attempted but never required; the result says `recorded: false`, and the run requires review. `start` stops the container after any failure once it is running.
   - **Tests:**
     - Offline, a real `DockerWorld` against an engine mock: full and closed real logs, and a failed `world.started` record.
     - On the real engine: an injected `world.started` failure, and a log that fails entirely before the stop. Both stop and remove the container.
2. **Uncertain actions produced clean checkpoints (P1).**
   - **Defect:** a job left `unconfirmed` or `uncertain` after dispatch was recorded, and the run could still end cleanly with a checkpoint.
   - **Fix:** that outcome now ends the loop (`uncertain_action`). The run stops the world and requires review, with no checkpoint. A job known to be running when the wait ended is unaffected.
   - **Tests:** loop and full-episode tests for both states, checking that nothing further is dispatched and the uncertainty is kept for finalization.
3. **A stop before dispatch still started a new command (P1).**
   - **Defect:** a stop arriving after the reply, or while the action was being prepared, did not prevent dispatch.
   - **Fix:** a stop is now checked before sending (the request is recorded as not sent and its reservation released), after the reply (the command is refused), and at the last moment before the start request (the dispatch is withdrawn). A refused call still gets a "Not executed" result.
   - **Tests:** a stop requested while each of `model.requested`, `model.responded`, and `action.prepared` is recorded. In each case nothing starts and every effect is accounted for.
4. **The production fake mind kept every request (P2).**
   - **Fix:** the script position comes from the request's tick, and requests are captured only in tests.
   - **Tests:** a default fake mind keeps nothing and answers ticks out of order correctly. The packing script records only numbers.
5. **Initial run files bypassed the record limit (P2).**
   - **Fix:** the manifest, configuration, prompt, tools, script, and finalization files now count. A run whose initial files plus one tick exceed the limit is refused before any record exists.
   - **Tests:** a completed run's on-disk bytes equal the recorder's accounting, and a 16 MiB script with a 16 MiB limit is refused.
6. **Inline text skipped verification (P2).**
   - **Fix:** `readText` checks size and hash for inline text too.
   - **Tests:** corrupted text, wrong size, wrong hash, a blob with the wrong size, and Unicode round trips.
7. **Job inspection failures were invisible (P2).**
   - **Fix:** summaries carry the time the state was established and the failure, and the observation shows both. A later successful inspection clears the failure.
   - **Tests:** covered in the job table and the rendering.
8. **A completion could be dropped before it was perceived (P2).**
   - **Fix:** a finished job is kept until an observation has reported it finished (`continuing-jobs-v2`).
   - **Tests:** three simultaneous completions with no retention are all reported once, then dropped. Existing retention tests now run an observation between dispatches, as the loop does.

### Reverification items

Each regression test below was run with its fix temporarily undone, and failed.

- **R1. A failed start's cleanup lost its recording evidence (P2).**
  - **Defect:** when `start` stopped the world itself, the run saw an absent container and recorded `completed`, dropping the fact that the stop's records had failed.
  - **Fix:** `DockerWorld` keeps the cleanup result (`startCleanup`), accumulated across attempts. The run treats a start as cleanly ended only if every stop involved was verified and fully recorded, and it records the cleanup in the final state event.
  - **Test:** a full `startRun` over the real `DockerWorld` (mock engine) with a world log that fails persistently from `world.started` on. The container is stopped and removed, and the run is `recovery_required` with the unrecorded cleanup in its record.
- **R2. A job becoming uncertain later allowed another action and a clean checkpoint (P1).**
  - **Defect:** only the dispatch result was checked, so a job that the engine forgot after it was running went unnoticed.
  - **Fix:** every observation is checked. A job classified `uncertain` (the engine no longer knows its execution) is recorded as `action.uncertain`, with the job's known state and output counts, and the run ends for review before another request or dispatch. A failed inspection that only leaves the last known state marked stale does not trigger this.
  - **Tests:** a loop driven by the real `JobTable`, where an `ExecGoneError` follows a running job (no second request or command; the analyzer lists the uncertainty, with nothing outstanding), and a full `startRun` (`recovery_required`, no checkpoint).
- **R3. The completion guarantee had an imprecise scope.**
  - **Defect:** a finished job counted as reported when its summary was generated, not when the mind received it. Outside the loop's ordering, unreported completions could still be dropped.
  - **Fix:** acknowledgement happens only after the request carrying the observation was sent. Until then a finished job holds its admission slot, so it cannot be dropped unseen under any calling order, and the separate cap on unreported jobs is gone. The profile texts state this boundary (`continuing-jobs-v2`, and `baseline-sensors-v3`, since superseded by `v4`); both were revised in place before any run used them.
  - **Tests:**
    - ten sequential submissions without observations: completions hold their slots, later submissions are refused, and nothing is evicted;
    - summaries alone acknowledge nothing;
    - the loop acknowledges only after sending, and not at all when stopped before sending.

  Phase 2's integration helper `settle` now acknowledges a job once it has seen it finished, as an observation would.

### Later verification: the R2 race and PC1

Each regression test below was run with its fix temporarily undone, and failed.

- **R2 race. Uncertainty established after sampling (P1).**
  - **Defect:** a job the engine forgot after the tick's observation was sampled went unnoticed. It could be found during the next submission's refresh, by background polling, or not at all before the last tick. Another command could then start, and the run could end with a clean checkpoint.
  - **Fix:**
    - Uncertainty is now a lasting condition in the job table: while any job is `uncertain`, every submission is refused with `UncertainJobsError`, and uncertain jobs are never dropped.
    - The loop turns that refusal into a completed tick whose command was not started, records `action.uncertain`, and ends for review.
    - Before any clean end, the loop refreshes the jobs (`uncertainJobs()`); any uncertainty sends the run to review. A job the engine forgets after that check ends with the world like any running job.
  - **Tests:**
    - the real job table, finding the loss by refresh and by background polling (the condition persists);
    - the loop over the real job table, finding the loss in an observation, at the next dispatch, and before a clean end, each starting nothing more and recording the job;
    - a full `startRun` whose last tick is the one after which the job is lost: `recovery_required`, no checkpoint.
- **PC1. Known model calls disappeared if their tick did not complete (P2).**
  - **Defect:** the counters advanced only when a tick completed.
  - **Fix:** attempts and responses are now counted immediately after invocation, before anything else is recorded or dispatched. `tick.completed` records the counts that already include the call, and nothing is counted twice.
  - **Analysis:** it now reports calls the record confirms (made, answered, failed) separately from unresolved requests, meaning recorded before invocation with no outcome. It does not count those as attempts or as non-attempts, and `run status` says so.
  - **Tests:**
    - failed records of the response, the action outcome, or the tick, and a failed invocation whose failure record fails: in-process counts are kept, and the analysis reports the unresolved request;
    - a full `startRun` where dispatch loses its outcome: one attempt, one response, no completed tick;
    - existing tests for completed paths and cancellation before invocation still pass.

Also corrected from the R3 reverification note: acknowledgement happens once the mind has responded, not when the request is sent. The profile texts, contract comments, and README now say this.

The findings' notes are addressed in "Operator decisions" above and "Packing measurement" below. The damaged-log limitation for cleanly ended runs is now stated in the table and the README.

An earlier read-only review in the implementation session found three defects, all fixed before the verification: a failed start could leave the world running, an oversized tool name sent the run to review, and a refused start left an empty run. Its fix for the first was incomplete when the cause was a failing world log; that is verification finding 1.

## Lifecycle uncertainty invariant (R2-A, R2-B)

The earlier R2 fixes added checks at particular moments: after an observation, before a dispatch, before a clean end. Each left a window between a check and the effect it guarded, and verification kept finding the next one. This implements `phase-3-lifecycle-uncertainty-implementation-plan.md` instead. Uncertainty is now a lasting fact of the world's execution epoch, enforced where effects are committed and where a run is certified.

**What changed:**

- **Safety object** (`src/core/execution-safety.ts`):
  - One `ExecutionSafety` per execution epoch, owned by `DockerWorld` independently of the job table and shared with it.
  - It latches uncertain effects synchronously, deduplicated by job and bounded by `maximumConcurrentJobs + 1`; overflow is marked as incomplete evidence.
  - It latches required-evidence failures, and it counts effects committed.
  - Admission closes irreversibly. Snapshots are immutable. There is no clear or reset.
  - `seal()` produces the final assessment; any mutation after sealing throws. `certifiesClean` accepts only a sealed, review-free assessment of the expected epoch.
- **Job table:**
  - It latches `execution_lost` on `ExecGoneError`, and `start_outcome_unknown` for a start still unconfirmed after the wait, both before any record.
  - Record failures mark evidence incomplete, including in background work, which is now tracked and settled before sealing.
  - Admission has an early check after the refresh, and a decisive one after creation, the run's `action.prepared`, and the world's `job.prepared`. The decisive check runs after the caller's synchronous `proceed` hook and directly before `transport.start()`, with nothing awaited in between.
  - A command refused there stays spent, `job.start_refused` records `reason: uncertain_jobs` with the affected job IDs, and it is never started or retried.
  - An agent's signal is admitted the same way at its own start request (`runControl`'s `admit`); operator signals and read-only readings stay available.
  - `endWithWorld` keeps uncertain jobs uncertain.
- **Backend stop protocol:**
  - `stop()` closes admission synchronously on entry, and concurrent stops share one operation.
  - The drain collects failures instead of aborting, and inspection stays active during it. Beyond that drain, a failed record never keeps the world running. A stalled record write can still delay the stop (see "What remains").
  - The inspection epoch advances and the engine stop request is issued with no await between them.
  - After a verified stop, jobs, collectors and background evidence settle, records and removal are attempted, and only then is the assessment sealed.
  - A failed or unverified stop returns an unsealed assessment that requires review.
  - A vanished container latches the jobs expected alive. This covers a stop request answered 404 as well as no container found.
  - `WorldStopResult.safety` is required on every branch, including failed-start cleanup (`startCleanup`). A new epoch starts only after a verified, fully recorded, review-free stop, or when the previous epoch committed nothing.
- **Loop:**
  - It reads the synchronous safety snapshot after each observation and after each dispatch.
  - A guard sits directly before `mind.invoke`: if uncertainty was established while the request was being recorded, the request is recorded as not sent (`request_not_sent: review_required`), its reservation is released, and no attempt is counted.
  - A response already in flight is recorded, and its proposed command is refused.
  - The final refresh before a clean end is detection only, not what certifies the run.
- **Finalization:**
  - One run-level writer, `src/records/uncertainty.ts`, records `action.uncertain` for the earlier affected actions. It deduplicates, and a failure is kept rather than blocking the stop.
  - After the stop, the stop assessment's effects are recorded.
  - A checkpoint requires all of: a clean loop end, a verified and fully recorded stop, a sealed and review-free assessment of this run's epoch, and complete uncertainty evidence. Otherwise the run ends `recovery_required`: `uncertain_action` when effects are uncertain, with the requested reason (for example `tick_limit`) kept as `requestedReason`.
  - Synthetic stop results for a stop that threw carry the world's snapshot, unsealed and requiring review.
- **Checkpoint schema 3** embeds the stop and its sealed assessment. The schema accepts only `sealed: true`, `reviewRequired: false`, no uncertain effects, and complete evidence, so it is a second, independent gate: undoing only the finalization predicate still produces no clean checkpoint. A checkpoint file whose `checkpoint.written` or terminal clean record then fails stays as an orphan, and the run is `recovery_required`.
- **Other changes:**
  - **Analysis:** `analyzeEvents` deduplicates uncertain actions.
  - **Record reserve:** it covers the uncertainty and assessment records.
  - **CLI:** `run start` prints the assessment.
  - **Profiles:** `continuing-jobs-v3` and `shell-body-v5` replace the retired `continuing-jobs-v2` and `shell-body-v4`; `baseline-sensors-v4` is unchanged. Tool text, perception, prompts, the 1M context, and the attempt/response accounting (PC1) are unchanged.
  - **Contributor rule:** `runtime/AGENTS.md` now states the invariant.

**Offline matrix (plan §9), with deterministic barriers:**

- **Admission, against the real job table** (`test/unit/admission.test.ts`). The uncertainty is established at each of these points:
  - before the admission refresh;
  - during exec creation;
  - during the preparation hook, found by explicit inspection and, separately, by real background polling;
  - during the world's durable `job.prepared`;
  - inside the synchronous `proceed` hook;
  - after the start request was issued.

  In the last case B was committed once and never replayed, and review is required. In every other case B never starts.
  Further tests: failed uncertain-transition and refusal records, repeated submissions, latch-before-held-record, agent versus operator signals, and the safety object's latch, bound, immutability, sealing and certification.
- **Stop and checkpoint eligibility, through a real `DockerWorld` over an in-memory engine** (`test/support/offline-world.ts`, `test/unit/lifecycle.test.ts`). Only storage attachment is replaced; startup verification, jobs, sensors and the stop run as in production. Cases:
  - a normal verified stop of a running job gives a clean checkpoint with a matching epoch;
  - the job is lost before the final refresh, during the `run.stopping` record, or during the backend's `world.stopping` record;
  - post-stop run-record failures before and after the checkpoint artifact;
  - the drain with a pending submission, and with a rejected submission record;
  - an inspection answered after the stop commit (not read as pre-stop uncertainty);
  - failed removal records;
  - concurrent and repeated stops;
  - a vanished container;
  - a failed stop followed by later uncertainty;
  - fresh epochs after clean versus review-requiring stops;
  - transient engine unavailability (stays stale, not uncertain).
- **Commitment-boundary contract.** `dockerExecTransport.start` issues the engine request synchronously, and `DockerEngine.hijack` calls `http.request` and `end` before returning.
- **Loop.** Uncertainty during the request record means no invocation; during an in-flight call, the response is recorded and its command refused; the fake-world run cases cover loss after sampling, at the final refresh, and during the stop.

**Evidence that the tests catch the defects:**

- **R2-A:** a standalone reproduction (poll during preparation, real poller) run against a saved copy of the pre-change runtime fails for the intended reason: B started. It passes on the current code.
- **R2-B:** the old backend cannot be driven offline, so the guards were undone in the current code instead. Undoing the finalization predicate alone still yields review, because the checkpoint schema refuses. Undoing both makes the R2-B cases produce clean checkpoints and fail.
- **Admission guards:** undoing the job table's final guard fails 7 admission and lifecycle tests. Undoing the pre-invocation guard fails the invocation test.

**What remains:**

- The engine forgetting an execution cannot be produced safely on a real Docker engine, so the uncertainty paths are verified offline. The real-engine integration suite covers start, stop, sealed assessments, and failing world records.
- A world record that never settles (as opposed to one that rejects) still delays the physical stop; bounding that is the Phase 4 watchdog/deadline work, as the plan states.
- An inspection answer that crosses the stop commit is discarded by design (plan I6). An execution lost just before the commit whose answer arrives after it ends with the world.
- After a controller crash only durable evidence exists; interrupted-run handling is unchanged.

## Final lifecycle gate (L1, L2): closed

The reviewer's acceptance files were implemented against unchanged. Their SHA-256 hashes still match the handoff: `308a21dd…545d1` (signal shutdown) and `9a31ffb7…9f709` (epoch restart). The RED baseline was reproduced first: 52 tests, 11 passing and 41 failing, with no cancellations or skips, on both Node 24.14.0 and 25.8.1.

**L1: signals as owned operations** (`src/world/jobs.ts`, `src/world/exec.ts`, `src/world/backend.ts`, `src/core/execution-safety.ts`):

- **Registration.** `signal()` registers each invocation synchronously, before its first await, in an operation registry. A job ID is not an operation ID, so simultaneous signals to the same job are tracked separately. Entries are removed when they settle.
- **Admission.**
  - Shutdown closes new signals of either origin. It is checked on entry, again before the helper is created (`runControl`'s new early check), and again right before its start request.
  - A review-required epoch refuses agent signals, while an operator's explicit signal stays available and attributed until shutdown.
- **One terminal outcome per admitted request.** After the required `job.signal_requested` record, every request ends with one `job.signalled` record:
  - **delivered**;
  - **known not delivered**: withdrawn at admission, a creation failure, or an engine refusal of the start (`ControlNotStartedError`, used only when nothing can have started);
  - **unknown**: a lost start response, a timeout, a non-zero exit, an incomplete or unreadable reading. This is latched as a bounded `ReviewCause` (`signal_delivery_unknown`, attributed to the signal operation, not to a model action) before the outcome is recorded.
- **Record failures.** A failed required record marks the epoch's evidence incomplete. It never turns into a known no-op, and a repeated stop cannot clear it.
- **Stop ordering.** The stop closes admission, drains submissions, commits the engine stop, then settles admitted signal operations, then settles job evidence and world records, and only then seals. A failed or unverified stop returns without waiting, and its pending operations stay owned for the retry. Review causes block certification. The checkpoint schema requires none, and a run with one ends `recovery_required` / `uncertain_signal` (a new stop reason).

**L2: explicit startup outcome** (`src/world/backend.ts`). Each epoch now records whether its startup finished verification (`starting`, `started`, or `refused`). Before any new safety object, cleared receipt, or engine request, `start()` validates the predecessor:

- a started epoch, whether or not any job ran, needs a verified, fully recorded, sealed, review-free stop of that same epoch;
- a refused startup may retry only if it committed nothing, requires no review, and its cleanup (if any) was verified, fully recorded, and review-free.

**Versioning and tests.** `continuing-jobs-v4` replaces `continuing-jobs-v3`, which is retired and was never used by a recorded run. Two of my earlier tests were updated where the frozen contract supersedes them:

- after an agent signal's delivery is unknown, a later agent signal is refused, and the operator's is used to check the exited-job case;
- the refusal message names the unknown signal delivery.

**Completion gate on Node 24.14.0** (from `runtime/`):

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| targeted acceptance, run 3 times | 52/52 each time, 0 cancelled, 0 skipped |
| `npm test` | 303/303, 0 cancelled, 0 skipped |
| `npm run build` | exit 0 |
| `node dist/cli.js config validate test/fixtures/fake.config.json` | valid |
| `npm run measure:packing` | exit 0; results unchanged from "Packing measurement" |

These separate checks were not part of the gate:

- Node 25.8.1 `npm test`: 303/303.
- Docker integration on OrbStack: 22/22 on Node 24 and on Node 25, with no labelled containers or volumes left behind.
- No live model calls.

## Verification (2026-09-26, OrbStack 2.2.3, Engine 29.4.0, arm64)

After all fixes (R1–R3, PC1, the lifecycle uncertainty invariant) and the operator decisions:

- **Node.js 24.14.0 and 25.8.1:** typecheck, lint, build, compiled CLI validation, 303/303 unit tests (including the 52 frozen acceptance tests), and 22/22 integration tests. The integration suite is Phase 2's 18 world tests plus 4 run tests.
- **Cleanup:** no containers or volumes labelled `sh.alife.world` remained after any run.
- **Not run:** the GitHub CI workflow.

The unit tests use a fake world or engine and the real recorder. They cover:

- shell, wait, text, refusal, and invalid replies (including an oversized tool name), each answered for every call and reported next tick;
- the protocol-error threshold, a continuing job, and admission refusal;
- a failed pre-dispatch record;
- provider failure (an attempt, not a response), and the spend limit (not an attempt);
- the deadline, the record reserve, and host capacity;
- a stop at each boundary before an effect;
- uncertain outcomes at dispatch and later (including through the real job table);
- delivery-based acknowledgement of finished jobs;
- an unexpected world stop;
- context eviction, contiguity, no return, exact recorded observations, the request's fields, and overflow;
- run lifecycles, including stops that are unverified or incompletely recorded, a failed start whose own cleanup was not recorded, and refusals before any record;
- a world stop with a full or closed log;
- the record limit across all run files, and text integrity;
- interrupted-run analysis and finalization;
- CLI status, finalize, and lock commands;
- worst-case observation and result bounds, and the ledger;
- that the two prompts differ only in their final sentence;
- that no observation contains a directory listing;
- that the shell tool text is truthful and gives no advice on managing output.

The integration run tests on a real world:

- **Persistence across eviction.** A fake-mind run writes `/world/note.txt`, starts a job that outlives its wait (a later observation reports its exit), and floods 32 KiB results until tick 1's exchange is evicted. At tick 8 it reads the note back. Every action has exactly one outcome, the checkpoint matches, and no controller variable appears in the run records.
- **Persistence across runs.** A second run in a new container finds and reads the file with its own `ls` and `cat`, with no replay. No observation lists `/world`.
- **Killed controller.** A CLI controller is SIGKILLed while its job runs. `run status` reports it interrupted; the locks are released by token; finalize refuses while the world runs; `world stop` succeeds; finalize then records `run.recovery_required` and `run.finalized`. Nothing was dispatched again.
- **World log failures.** With an injected `world.started` failure, and with a log failing entirely before a stop, the world is still stopped and removed. The stop reports its records as incomplete.

## Packing measurement (mechanics only)

`npm run measure:packing` uses the example body: 8 KiB perceived output, 1,024 output tokens, 512 margin, and up to 36 tracked jobs. Packing and these counts both use the configured `utf8-bytes-v1` estimator, an upper bound on real tokens (roughly fourfold for English text). Provider token counts do not change retention by themselves; retention improves only if a different estimator is declared. The fake replies are not held to the output-token allowance; the hostile scenario's 4 KiB replies are fixtures, not evidence of conforming live output.

| Scenario | 1,000,000 | 262,144 | 131,072 |
| --- | --- | --- | --- |
| quiet (short commands, little output) | no eviction in 300 ticks | onset tick 198, keeps 189 | onset 99, keeps 90 |
| typical (~400 B reply text, ~1 KiB output) | onset 275, keeps 272 | onset 72, keeps 68 | onset 36, keeps 33 |
| heavy (output at the cap on both streams) | onset 63, keeps 60 | onset 17, keeps 15 | onset 9, keeps 7 |
| hostile (invalid UTF-8 at the cap, 4 KiB replies) | onset 25, keeps 23 | onset 7, keeps 5 | onset 4, keeps 2 |

At the 1M baseline and the provisional 200-tick cap, eviction happens only when outputs are large. This feeds the horizon calibration in §9.3; it says nothing about agent behavior.

## Not done or not verified

- **Not frozen: seed contents and the control prompt.** `sparse-v1` is still `draft`. Freezing it is an operator approval (§19, item 3), not something this phase did. A unit test checks that the assigned-task prompt replaces only the final sentence.
- **Phase 4 work:**
  - clean resume, `run stop` from another process, heartbeat, and the watchdog;
  - initial and final archives tied to runs, and export;
  - crash injection at every effect boundary; only a kill during a cadence sleep was exercised.

  Without the watchdog, a killed controller leaves its world and jobs running (within the world's limits) until the operator releases the locks and runs `world stop`.
- **Other environments and events.** Docker Desktop, Linux Engine, and engine restarts during a run were not tested.
- **Deferred to Phase 5:** live models, provider-side token counting, and real cost rates.
