# Phase 3: make uncertainty a lifecycle invariant

## Status and scope

**Final acceptance handoff:** `phase-3-final-lifecycle-tdd-plan.md` now owns the remaining L1/L2 implementation details, reviewer-authored acceptance tests, and fixed completion gate. This document remains the architectural reference; do not turn its broader discussion into additional completion conditions after the final gate passes.

This is my proposed implementation for closing **R2-A and R2-B** in `phase-3-verification-findings.md`. It replaces the strategy of adding another observation-time check with a single, lasting safety condition enforced at effect admission and finalization.

This document is an implementation handoff, not a claim that the changes exist or pass verification. No runtime code, containers, model calls, or commits are authorized merely by writing it. Keep this plan uncommitted with the other `.plans/` documents.

Read alongside:

- `phase-3-verification-findings.md` — exact reproduced failures;
- `phase-3-policy-decisions.md` — approved experimental policy;
- `phase-3-policy-verification.md` — verified perception/context/accounting changes;
- `first-runnable-system.md` — broader runtime contract;
- `runtime/AGENTS.md` — implementation constraints.

**Do not reopen research decisions.** Preserve no automatic listings, no later-output delivery, no coaching, generous configurable context, continuing jobs, no retries/replay, and separate attempted/answered call accounting. PC1 is already closed and must not regress.

## 1. The implementation decision

Introduce one **execution-epoch safety object**, retained by the world controller and shared with its JobTable. It records uncertainty independently of a job's current process state.

It has three jobs:

1. Remember established uncertainty synchronously, before attempting to log it.
2. Refuse new agent effects at their final local admission boundary.
3. Carry that evidence through shutdown into the run's final classification.

A job's physical state may change from running to stopped. Its unknown execution outcome does **not** thereby become known.

The loop's final check remains useful for detecting problems promptly, but **ceases to be the authority for checkpoint eligibility**. A stopped-world result carrying a sealed safety assessment is authoritative.

No new scheduler, actor framework, general transaction engine, or global mutex is needed. The current single-controller ownership, serial submissions, and JavaScript synchronous call stacks are sufficient when used at the correct boundaries.

## 2. Exact invariants

### I1. Established uncertainty is monotonic

Once an execution epoch records an uncertain effect, it requires review for the remainder of that epoch. Successful later inspection, output EOF, job eviction, acknowledgment, verified world stop, removal of the container, and disposal of the JobTable cannot clear it.

Physical shutdown can be verified while execution history remains uncertain. Represent both facts.

### I2. No later agent effect is admitted

If uncertainty is established before the controller commits a new agent effect to its transport, that effect must not be sent.

The decisive check is **after every awaited preparation operation**, immediately adjacent to the transport invocation, with no intervening `await` or callback that can alter safety state.

This also applies to a new model invocation: a response already in flight may be recorded, but a new invocation must not begin after known review-required uncertainty. No automatic retry or replacement request is introduced.

### I3. Already committed effects are not retroactively called unstarted

If the transport was invoked before uncertainty was established, the effect is already in flight. Keep its real outcome or uncertainty, never replay it, and stop the world under the existing rules. Do not claim a local guard can recall bytes already handed to a transport.

### I4. Physical shutdown cannot authorize clean resumption by itself

A checkpoint requires all of:

- a provisionally clean loop end;
- verified physical world shutdown;
- complete required shutdown/run evidence;
- a sealed assessment for the same execution epoch;
- no uncertain effects or other review-required safety condition;
- existing ledger/checkpoint invariants.

A boolean computed before shutdown cannot establish these conditions.

### I5. Logging failure cannot reopen admission or prevent the safety stop

Latch the safety condition before any logging await. Failed records leave admission closed and require review. Attempt physical shutdown even if evidence writing fails. Do not make successful uncertainty logging a prerequisite for stopping.

### I6. Shutdown-induced disappearance is distinct from pre-stop uncertainty

Preserve the existing stop-epoch distinction for inspections that complete after intentional shutdown was committed. Do not falsely label normal shutdown as an unexpected lost exec.

Conversely, an `ExecGoneError` already processed **before** that boundary must survive shutdown. The previous final loop check is not that boundary.

## 3. Boundaries and terminology

### Local effect commitment

For shell execution, the commitment point is invocation of `ExecTransport.start(execId)`, not eventual remote process startup or receipt of the stream handshake.

The current production chain is suitable: `dockerExecTransport.start()` calls `DockerEngine.hijack()`, which initiates its HTTP request synchronously. Document and test this transport contract. A future transport that queues work across an internal await before sending must enforce admission at that later boundary; callers must not assume an asynchronous queue is an immediate send.

For cognition, the equivalent point is calling `mind.invoke(...)`. Preserve the current attempted/answered accounting semantics and distinguish unsent requests from failed invocations.

### Stop requested versus stop committed

These are different phases:

- **Stop requested/draining:** close admission immediately; existing submissions settle; observations may still establish pre-stop uncertainty.
- **Stop committed:** immediately before invoking the engine's whole-world stop request, advance the inspection epoch and stop ordinary polling. No await separates this transition from the engine stop invocation.
- **Stopped:** physical shutdown is verified; required evidence is collected and the safety result sealed.
- **Stop failed/unverified:** admission remains closed and review is required. Diagnostic inspection may resume under a fresh inspection generation, without erasing prior uncertainty.

A stop request is not itself proof that processes stopped. A stop-epoch transition is a controller interpretation boundary, not a claim about remote timing.

## 4. Concrete data model

Add `runtime/src/core/execution-safety.ts` with a small provider/Docker-independent class and immutable public snapshot types. Keep mutable implementation details private.

Illustrative shape (names can follow local conventions, semantics are required):

```ts
interface UncertainEffect {
  readonly actionId: string;
  readonly jobId: string;
  readonly execId: string | null;
  readonly cause: "execution_lost" | "start_outcome_unknown";
  readonly firstObservedAt: string;
  readonly detail: string; // bounded text, not an arbitrary Error graph
}

interface ExecutionSafetySnapshot {
  readonly epochId: string;
  readonly admission: "open" | "closed";
  readonly reviewRequired: boolean;
  readonly uncertainEffects: readonly UncertainEffect[];
  readonly requiredEvidenceFailed: boolean;
}

interface StopSafetyAssessment extends ExecutionSafetySnapshot {
  readonly sealed: boolean;
}
```

The safety object exposes narrowly scoped operations:

- `latchUncertainty(effect)` — synchronous, idempotent by action/job identity;
- `markRequiredEvidenceFailure()` — synchronous and monotonic;
- `closeAdmission()` — synchronous and irreversible within this epoch;
- `snapshot()` — synchronous, immutable copy; **no engine refresh or I/O**;
- internal stop-phase/generation transitions used by the backend;
- creation of the final immutable assessment after shutdown processing.

Do not expose a general `clear()`, `resetUncertainty()`, or writable map.

### Ownership and lifetime

- `DockerWorld` owns the epoch safety object independently of `#jobs`.
- `JobTable` receives that exact object; it must not maintain a second authoritative uncertainty set that can diverge.
- `LoopWorld`/`WorldBackend` expose a synchronous safety snapshot. Keep active inspection separate, for example `refreshJobSafety(): Promise<void>`.
- Clearing `DockerWorld.#jobs`, closing collectors, or answering an absent-container inspection leaves the safety object intact.
- `WorldStopResult` includes a **required** structured safety assessment. Update every real/fake implementation and fallback; missing assessment must not default to safe.
- The existing standalone world stop/start API can begin a new epoch only after a verified, fully recorded, review-free preceding stop. Create a new object rather than resetting the old one; old result snapshots remain immutable. A refused startup that never admitted execution can retry under existing safe-start rules.
- A review-required epoch cannot be silently restarted on the same controller. Existing explicit finalization/new-experiment rules remain separate; this work does not implement resume or recovery.
- After a controller crash, only durable evidence exists. Do not infer a clean prior epoch from the absence of an in-memory latch. Existing interrupted-run handling remains mandatory.

### Bounds

Latch one bounded entry per affected job, not one entry per poll. Admission closes at the first issue, so there are at most the already admitted active jobs plus any single preparation in progress. Tie the bound to `maximumConcurrentJobs` plus preparation allowance; never grow an unbounded incident list.

Use a finite flag for required-evidence failure, not an array of repeated error strings. Include bounded details/identities in record-reserve calculations. Validate identity/size bounds at construction; a defensive overflow must fail closed, never drop evidence and claim completeness.

## 5. JobTable changes

Primary file: `runtime/src/world/jobs.ts`.

### 5.1 Latch before asynchronous evidence

When `#inspect` accepts a current-generation `ExecGoneError`, synchronously latch the uncertain effect **before** awaiting `job.state` or any other record.

The same principle covers a dispatched start whose processing cannot be established after the bounded wait. An initial stream error does not automatically mean permanent uncertainty if existing authoritative inspection establishes a known outcome before that decision; preserve the existing distinction. Once the runtime actually classifies the effect as uncertain/unconfirmed requiring review, latch it.

If recording this evidence rejects, mark required evidence incomplete. A background `.catch(() => undefined)` may prevent an unhandled rejection, but must never discard the safety classification.

### 5.2 Two admission checks, one authoritative commitment guard

Retain the early check after refresh: it avoids unnecessary exec creation.

Add the decisive synchronous guard after:

1. `transport.create`;
2. the run's `hooks.prepared`;
3. the durable world `job.prepared` record.

Then evaluate operator withdrawal and controller closure, and re-read the safety condition **after** any caller-provided synchronous hook. Nothing user-supplied or awaited may run between the final safety check and `transport.start`.

Conceptually:

```ts
await prepareDurably();
const callerAllows = hooks.proceed?.() !== false;
const denial = currentAdmissionDenial(callerAllows, safety.snapshot());
if (denial !== null) {
  await recordKnownNotStarted(denial);
  throw typedDenial(denial);
}
trackPreparedJob(); // synchronous internal bookkeeping only
const startPromise = transport.start(execId); // commitment point
await handleStartedOrUnknown(startPromise);
```

Do not put `transport.start()` inside a mutex held while records or inspections are awaited. Polling must remain able to establish uncertainty during preparation.

### 5.3 Correct prepared-but-not-started evidence

An exec may have been created and durably prepared but denied at the final barrier:

- keep its action ID spent;
- record `job.start_refused` with reason `uncertain_jobs` and the relevant identities;
- propagate a typed denial with affected uncertain effects to the loop;
- record the new command as `action.refused`, not `action.uncertain`;
- provide its paired “Not executed” tool result;
- record the **earlier affected jobs** as uncertain;
- no transport start, no retry, no replay.

If refusal recording fails, still never start the command; carry both the known refusal and evidence failure to review. Do not allow record failure to convert the denial into an ordinary admission limit that the loop can ignore.

### 5.4 Other entry points

Audit all agent-originated mutating entry points, including `signal(..., requestedBy: "agent")`. They need the same final admission principle at their actual transport boundary. A guard before `runControl()` is insufficient if that helper awaits exec creation before sending a mutating command; give it a start guard or use a dedicated guarded control path.

Keep read-only diagnostic inspection and explicit administrative whole-world stop available. Operator interventions remain separately attributed; do not automatically substitute signalling or retrying for an uncertain agent action. Do not add new tools or change agent-facing capabilities.

## 6. Shutdown protocol and authoritative stop result

Primary files: `runtime/src/world/backend.ts`, `runtime/src/world/jobs.ts`, `runtime/src/core/contracts.ts`.

### 6.1 Close admission at stop entry

At the beginning of `DockerWorld.stop()`, synchronously close agent admission, before the first await for container inspection or logging. Do not wait until after `world.stopping` is written to do this.

Coalesce concurrent stop calls for the same epoch onto one in-flight operation. Otherwise concurrent mutation of stop-record bookkeeping and disposal can produce inconsistent receipts. Repeated results must retain uncertainty and evidence failures; a later successful physical stop cannot erase them.

### 6.2 Drain without prematurely freezing uncertainty

Await in-progress submissions under the existing quiescence contract. Their final guard now refuses any not yet committed start. Already committed starts must be accounted for; no cancellation/replay fiction.

The drain is failure-collecting, not fail-fast: a rejected preparation, refusal, inspection, or evidence write marks required evidence incomplete but must not escape past the identity-checked physical stop. Preserve the original causes and continue shutdown. Add an explicit regression for a submission-record rejection during quiescence.

Liveness qualification: this sequence still waits for pending preparation/record operations. An indefinitely stalled filesystem write can delay physical stopping; this plan does not claim otherwise or solve controller suspension/crash. Do not confuse tolerating rejected writes with a bounded-time guarantee for writes that never settle. Such hard liveness guarantees require the separately planned watchdog/deadline work; do not silently release ownership or allow new dispatch to escape a stalled drain.

Keep pre-stop inspection interpretation active while draining and while pre-stop records await. Anything established here belongs to the epoch's lasting uncertainty evidence.

Attempt `world.stopping` evidence, but handle failure as incomplete evidence rather than skipping the engine stop. Do not introduce a new requirement that uncertainty records must be writable for physical stopping to proceed.

### 6.3 Commit shutdown adjacent to the transport call

After preparation/draining, synchronously advance the inspection epoch and disable ordinary polling, then invoke the engine stop with no intervening await.

An inspection response accepted before that transition can latch uncertainty. A response that crosses it is not used to infer a pre-stop exit/disappearance. This preserves the existing stop-generation protection.

If stop fails or cannot be verified, keep admission closed and return review-required/unverified evidence. A failed stop with observations still possible returns an **unsealed** assessment. If diagnostics restart, prevent old-generation answers from overwriting current state. Newly discovered uncertainty updates the live latch; repeated stop attempts must include it, never reuse a stale earlier assessment.

### 6.4 Preserve epistemic state while ending processes

`JobTable.endWithWorld()` must not turn an already uncertain outcome into a known outcome.

For the minimal implementation:

- known running jobs may become `ended_with_world`;
- already uncertain jobs retain that state, while the verified world stop separately proves their processes are no longer running;
- regardless of physical-state representation, the safety latch never changes;
- collectors still close/drain under existing bounded rules;
- no uncertain job is evicted or acknowledged away before its evidence is transferred.

Do not duplicate an ever-growing collection of full JobSnapshots. The bounded identity/cause record is sufficient for the safety assessment.

### 6.5 Seal only after shutdown processing

After the stop request, verify the container, finish job/collector bookkeeping, attempt required records/removal, and settle relevant outstanding observation/evidence tasks before certifying evidence complete.

The stop itself must already have been attempted; do not hold the physical safety action behind post-stop evidence drainage. A failed/unverifiable evidence drain cannot yield `recorded: true` or a sealed clean assessment. Do not add unbounded background queues or silently ignore pending required writes.

Before disposing `#jobs`, copy the final safety assessment into the stop result and retain it in the world controller. Every success/error/absent-container branch must include it.

Sealing applies to the **world execution epoch**, whose observations and required world-evidence tasks have finished. Required **run-finalization** records written afterward have a separate monotonic completeness flag. Their failure blocks clean finalization without mutating an already sealed world receipt. Do not conflate these two evidence scopes.

Special cases:

- **Absent container with no admitted execution:** preserve current legitimate startup/empty-world behavior, with an explicit assessment.
- **Container vanished while executions were expected alive:** absence is not evidence that their outcomes were accounted for. Require review and preserve affected identities.
- **Failure before/after stop verification or during removal:** report physical verification and evidence completeness separately; never fill in a safe default.
- **Failed-start cleanup:** accumulate the new assessment through `startCleanup` exactly as incomplete recording evidence is accumulated today.
- **Repeated stop:** retain the epoch's issues even when the next inspection finds no container.

## 7. Loop and run finalization

Primary files: `runtime/src/core/loop.ts`, `runtime/src/operator/run.ts`.

### 7.1 Loop checks are early detection, not certificates

Use synchronous safety snapshots at effect boundaries and refreshed observations for detection. The current `#finalCheck` can refresh jobs to improve detection before stopping, but remove its comment claiming jobs forgotten after that check simply count as ending with the world.

Immediately before `mind.invoke`, after all awaited request/reservation preparation, recheck the safety snapshot. If blocked:

- do not invoke;
- record the request as not sent with its actual safety reason;
- release its reservation under the existing not-processed policy;
- leave attempted/answered counters unchanged;
- end for review.

If uncertainty arrives during an invocation already in flight, record its eventual response/failure and costs honestly. Do not send another request or execute its proposed action. Preserve existing bounded request handling; no automatic retry or hidden cognition.

Keep PC1 counting independent of action/tick completion. A response whose command was refused still counts as a response.

### 7.2 One run-level uncertainty writer

Extract the duplicated uncertainty recording logic into a small helper, for example `runtime/src/records/uncertainty.ts`, shared by loop detection and operator finalization.

It must:

- record durable `action.uncertain` evidence for the affected existing action/job;
- preserve exec identity, first-observed cause/time, and bounded provenance;
- avoid treating the newly refused command as the uncertain action;
- deduplicate repeated reporting by action identity;
- only mark an entry as recorded after append succeeds;
- retain failures for finalization and never let a failure prevent stopping.

Update `analyzeEvents` to deduplicate uncertain actions defensively and keep uncertainty lasting even if later physical-state records mention world termination. This is evidence accounting, not a recovery service.

### 7.3 Merge the actual stop assessment

After `loop.run()` returns, its clean result is provisional. Call `world.stop()` as today, but final classification must consume the returned assessment, not just the earlier loop result.

Order:

1. Obtain the actual stop result.
2. Merge stop-assessment uncertainty with anything already known by the loop.
3. Persist any newly discovered uncertain action evidence, plus a bounded stop/safety summary.
4. If uncertainty exists, select `recovery_required / uncertain_action`; retain the originally requested stop reason, such as `tick_limit`, as a separate diagnostic field.
5. If evidence or stop verification is insufficient, require review even if no individual uncertain identity could be recovered.
6. Only then evaluate checkpoint eligibility.

Conceptually:

```ts
const stopped = await stopWorld(requestedReason);
const evidence = await recordRemainingSafetyEvidence(stopped.safety);
const canCheckpoint =
  end.clean && stopped.verified && stopped.recorded &&
  stopped.safety.sealed && !stopped.safety.reviewRequired &&
  evidence.complete && ledgerHasNoOutstandingReservations();
```

No nonempty latch may be omitted from this predicate. A missing/foreign/unsealed assessment is not safe.

All catch/fallback paths need a conservative structured assessment. In particular, `stopWorld`'s synthetic error result must preserve any synchronous world safety snapshot available and be explicitly unsealed/review-required. Do not return an empty issue list as if it proved no uncertainty.

### 7.4 Durable checkpoint gate

Include the sealed safety assessment/receipt in the clean checkpoint's hashed content, referencing the corresponding stop evidence. Bump the checkpoint schema because this adds a required invariant. Validate that the assessment is sealed, review-free, and belongs to the run's execution epoch; do not silently upgrade old checkpoints as safe.

A clean receipt is only created after observation processing is closed for that epoch and required evidence is settled. Thus later awaits for checkpoint writes cannot reopen the final-check-to-stop window. If a future implementation permits safety mutation after sealing, that is an invariant violation, not permission to write a checkpoint from a stale snapshot.

A checkpoint file by itself is not a committed clean run. If writing `checkpoint.written` or the terminal clean lifecycle event fails after the artifact was created, preserve the orphan artifact as evidence and require review; do not delete it to simulate rollback or treat its hash validity as resume authorization. Eligibility also requires the intact matching terminal clean run record and receipt. Test post-stop run-record failures both before checkpoint creation and after artifact creation.

This does not implement Phase 4 resume. It specifies the evidence Phase 4 must require, rather than treating any parseable checkpoint file as sufficient authorization.

## 8. Recording, versioning, and boundedness

Update:

- core contracts, `RunnableWorld`/`LoopWorld`, fake worlds and fake transports;
- world/run event allowlists and serializers for the safety evidence fields;
- checkpoint schema, writer/reader, and relevant fixtures;
- run result and CLI review diagnostics;
- record-space reserve calculations for bounded issue/receipt records;
- `startCleanup` aggregation and all stop-result constructors;
- integration helper assumptions about job final states and repeated starts.

Use immutable named profile versions for changed published semantics:

- introduce `continuing-jobs-v3` for lasting uncertainty and final guarded admission;
- introduce `shell-body-v5` for the clarified no-further-effects/clean-stop contract;
- keep `baseline-sensors-v4` if its actual model-visible text and perception are unchanged; introduce a new sensor version only if that text/behavior changes.

Update configs/tests/README/report consistently. Do not revise already named profile definitions in place. Reject retired execution configurations rather than silently mapping them. Keep historical evidence readable as historical evidence, not automatically resumable evidence.

No extra output, directory data, recovery advice, or strategy is injected into the prompt. A refusal result states what was not executed and why, without coaching.

## 9. Deterministic verification matrix

Add explicit deferred-promise barriers and fake transport/event-recorder controls in `runtime/test/support/`. Avoid tests whose correctness depends on winning a millisecond race.

For polling cases, wait on the actual `job.state -> uncertain` event or a controlled poll completion, not an arbitrary sleep. Use timeouts only to fail a stuck test. Release barriers and close tables in `finally`.

### A. Admission

For each point below, establish uncertainty for running job A while job B is pending, then release B:

| Injection point | Required result |
| --- | --- |
| Before admission refresh | No exec creation/start for B |
| During awaited exec creation | B may have an unstarted exec; zero starts |
| During `hooks.prepared` | Zero B starts; exact prepared/refused evidence |
| During durable `job.prepared` append | Zero B starts; affected A preserved |
| Within synchronous `proceed` callback | Final recheck still denies B |
| Immediately before transport invocation | Zero B starts |
| After transport invocation, before its response | B was committed once; account honestly, no replay, require review |

Exercise both real background polling and explicit inspection. Repeat attempted submissions to prove the latch persists and bounds hold. Test failure writing the uncertain transition and the refusal; neither may start B.

### B. Stop and checkpoint eligibility

Run through real `startRun`, JobTable, recorder, analyzer, checkpoint writer/reader where applicable:

| Injection point | Required result |
| --- | --- |
| After last observation, before final loop refresh | Review, no checkpoint |
| After final refresh, during `run.stopping` append | Review, no checkpoint |
| During backend `world.stopping` append | Review, no checkpoint |
| During submission quiescence | Review, no checkpoint; no late new starts |
| Immediately before stop-epoch commitment | Established uncertainty preserved |
| Inspection begun before stop but answered after commitment | Do not invent pre-stop uncertainty from shutdown effects |
| After verified stop, during job disposal/removal | Existing uncertainty survives; no checkpoint |
| Repeated/concurrent stop calls | Same epoch evidence, no clean downgrade |
| Absent-container and stop-error branches | Explicit conservative assessment, no safe defaults |

For every real uncertainty case assert:

- exact affected action/job identities in analysis;
- no false uncertainty assigned to B when B was known not started;
- no `checkpoint.written` event or newly written clean checkpoint file;
- no accepted clean checkpoint returned by the API;
- `recovery_required` classification, physical stop attempted, no replay;
- evidence failure remains visible when a durable assertion cannot be made.

### C. Safety object and evidence

- Latch occurs before a held or rejected record write.
- Duplicate polls deduplicate; storage stays within its declared bound.
- Job eviction, acknowledgment, EOF, stop, and table disposal never clear issues.
- Returned snapshots cannot mutate the object or be changed by epoch rotation.
- A fresh epoch cannot reuse an unsafe receipt or silently reset a tainted predecessor.
- Failed-start cleanup and repeated-stop aggregation preserve issues and recording failure.
- Record exhaustion still allows engine stop and blocks clean checkpoint creation.
- Required background evidence failure cannot be swallowed into `recorded: true`.
- A failed stop remains unsealed; subsequent diagnostic uncertainty appears in the next assessment.
- A post-stop run-record failure blocks clean finalization without mutating the sealed world receipt. An orphan checkpoint artifact never constitutes a committed clean run.

### D. No false positives and no research-policy regression

- Normal running job deliberately ended by a verified stop remains eligible when all evidence is complete.
- A stale inspection from transient engine unavailability is still reported stale, not automatically treated as `ExecGoneError`.
- A normal exit recorded before shutdown remains a normal exit.
- Unsent requests count zero attempts; responses before later failures remain counted.
- Refused commands have paired tool results and spent IDs; no redispatch.
- No automatic listing/later output/coaching; 1M baseline unchanged.
- Clean stop/start world API tests still work with explicit fresh execution epochs.

### E. Contract-level transport test

Use a mock engine/transport to prove no awaited work lies between the final guard and the actual transport commitment. Inspect `dockerExecTransport.start` and `DockerEngine.hijack`; an end-to-end JobTable test alone does not prove a future adapter won't add a hidden queue.

## 10. Implementation sequence

1. **Add failing deterministic regressions first.** Preserve the two current reproductions and the neighboring boundary cases. They must fail against the current implementation for the intended reason.
2. **Implement the safety object and its unit tests.** Bound it, make its snapshots immutable, and prohibit in-epoch clearing.
3. **Wire it through JobTable and backend ownership.** Latch before records; add final admission guards and correct prepared-refusal outcomes.
4. **Implement stop phase/receipt semantics.** Close admission at entry; preserve pre-stop observations; retain uncertainty through disposal; update every stop branch and startup-cleanup aggregation.
5. **Wire loop and operator finalization.** Guard new cognition, centralize uncertainty evidence, and make actual stop assessment authoritative.
6. **Update analyzer/checkpoint schemas, reserves, profiles, and fixtures.** Keep historical failures explicit and preserve PC1 behavior.
7. **Run the full deterministic matrix and normal-path regressions.** Test the boundary invariant rather than merely checking that the original two examples no longer fail.
8. **Run standard offline gates.** From `runtime/`: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, compiled CLI validation, and packing measurements where profile text changes affect sizes.
9. **Run authorized integration separately.** Only with explicit privileged-test authorization on the verified environment. Use disposable labelled worlds; no engine restart, unrelated resources, or model inference. Exercise real backend stop under held/failing records and verify no clean checkpoint after pre-stop uncertainty.
10. **Update evidence documents.** Describe exact coverage, environments, unrun checks, profile/schema changes, and remaining limitations. Do not mark Phase 3 approved merely because the test count increased.

## 11. Definition of done

R2 is closed only when:

- uncertainty is a retained epoch fact, not a reconstruction from current job states;
- every relevant agent effect has a final admission gate at its actual local commitment boundary;
- all pre-stop uncertainty survives physical shutdown and table disposal;
- run classification and checkpoint eligibility use the sealed stop assessment;
- uncertainty/evidence failure cannot be turned into clean success by logging failure, repeated stop, or absent-container handling;
- both original reproductions and the boundary matrix pass;
- already committed actions are neither falsely cancelled nor replayed;
- ordinary clean shutdown and the approved research policies still work;
- verification reports clearly distinguish offline proof from real-engine integration.

The key review question is no longer “did we add a check here?” It is:

> Can any asynchronous path admit another effect or certify a clean run after this epoch has already established uncertainty?

If the answer depends on when the last observation happened, this implementation is not finished.
