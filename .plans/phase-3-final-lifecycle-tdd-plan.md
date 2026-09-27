# Phase 3 final lifecycle handoff: implement against a fixed acceptance gate

## Completion status — independently verified GREEN

**COMPLETE.** On Node 24.14.0, both frozen test hashes match; all **52 acceptance tests pass in three consecutive runs**, and the full suite passes **303/303** with no skips or cancellations. Typecheck, lint, build, compiled fixture validation, and packing measurement also pass. L1/L2 are closed and the Phase 3 offline verification gate passes. No further exploratory audit is a condition of closure.

Evidence: `/tmp/alife-lifecycle-final-green-{1,2,3}.log`, `/tmp/alife-lifecycle-final-full-green.log`, and the final verification section of `phase-3-verification-findings.md`. No production/test edits, Docker operations, or model calls were made during verification. Privileged integration was not independently rerun.

The handoff and RED baseline below are preserved as historical evidence; their pre-implementation status statements do not override this completed gate.

## 1. Agreement and scope

The reviewer owns the acceptance tests in this handoff. **They are already written and run against the unfixed implementation.** This is not an instruction to implement first and invent passing tests afterward.

This handoff closes the remaining lifecycle review, covering:

- **L1:** ownership of signal operations and their required evidence through shutdown, including trustworthy refusal versus unknown delivery;
- **L2:** same-controller restart eligibility after successfully started versus genuinely refused execution epochs;
- preservation of the already passing original R2 races, accounting, context, perception, and normal lifecycle behavior.

**Completion rule:** when the unchanged acceptance tests and the existing offline verification gates in §8 all pass, this lifecycle review is **COMPLETE**. Mark L1/L2 closed and the Phase 3 offline verification gate passed. Do not add another exploratory audit as a condition of closing it or move the acceptance criteria after implementation.

This is a finite, explicit conformance gate, not a mathematical proof that no future bug can exist. A genuinely new bug discovered later is a separate maintenance issue, not grounds for retroactively extending this handoff. Live-provider work, privileged integration reruns, watchdogs, crash recovery, and Phase 4 are not newly imposed completion conditions here. Report those boundaries honestly rather than claiming this offline suite ran Docker or live models.

## 2. Delivered tests and RED baseline

### New, fixed acceptance files

1. `runtime/test/unit/signal-shutdown.acceptance.test.ts` — **37 cases**.
2. `runtime/test/unit/epoch-restart.acceptance.test.ts` — **15 cases**.

These use the actual DockerWorld, JobTable, safety object, execution/control transports, and existing in-memory engine. Full-run cases additionally use the actual run recorder, analyzer, checkpoint writer, and checkpoint reader. No Docker, paid API, or source implementation patch is involved.

### Verified baseline on Node 24.14.0

| Check | Result before implementation |
| --- | --- |
| New acceptance suite | **52 tests: 11 pass, 41 fail** |
| Repeated acceptance runs | Same result in **three consecutive runs** |
| Full unit suite | **303 tests: 262 pass, 41 fail**, 56 suites |
| Existing tests | All **251** still pass |
| Failure causes | All **41 are assertion failures**, in the two new files only |
| Canceled/skipped tests | **0 / 0** |
| Typecheck and lint | Pass |
| Build and compiled fixture validation | Pass |

The red tests are intentionally included in normal `npm test`. Do not skip them to restore a green build. They are the implementation task.

### Frozen file hashes (SHA-256)

```text
308a21ddd24928137036e05dcc616049152a416dbafa6e121a1f787e343545d1  runtime/test/unit/signal-shutdown.acceptance.test.ts
9a31ffb70787a73d76e215520182c783bd454cc916bad454c25fed4693b9f709  runtime/test/unit/epoch-restart.acceptance.test.ts
```

Do not weaken assertions, add skips, change fixture behavior to hide the defects, or add test-environment branches to production. Additional implementation tests are welcome but cannot replace these. If a test itself has a demonstrable defect, bring that concrete defect back rather than silently changing the contract.

Raw local RED evidence:

- `/tmp/alife-lifecycle-final-red-1.log`
- `/tmp/alife-lifecycle-final-red-2.log`
- `/tmp/alife-lifecycle-final-red-3.log`
- `/tmp/alife-lifecycle-final-full-red.log`

The counts, failure families, and hashes here remain the handoff record even if temporary logs are later removed.

## 3. What the tests require

### L1 matrix

For **both agent and operator signals**, hold execution at each of:

1. Required `job.signal_requested` record.
2. Signal exec creation response, before its start commitment.
3. Signal start response, after the start transport has already been invoked.
4. Required `job.signalled` outcome record.

At each boundary test both successful and rejected required evidence: **16 cases**.

Each asserts:

- the actual engine stop is still issued while the signal promise/record is held;
- the stop operation does not return a sealed assessment before required signal work settles;
- a not-yet-committed signal is withdrawn, with zero signal starts;
- an already committed signal is not replayed;
- successful evidence yields one truthful terminal outcome and allows a clean assessment;
- failed required evidence prevents clean certification and survives repeated stop;
- no required epoch records start after the receipt has returned.

Additional L1 cases:

- A new signal after stop entry is denied for either origin, including while `world.stopping` is held (**2**).
- Two concurrent signals to the **same job**, with one still pending: releasing one cannot release the other's evidence ownership. Both mixed-origin and completely identical invocations are tested; exact result and `(jobId, signal, requestedBy)` multisets are checked (**2**).
- Concurrent stop calls coalesce but do not seal over unresolved signal evidence (**1**).
- Failed physical stop, then retry, retains ownership of the pending operation (**1**).
- Ordinary agent/operator signals followed by clean stop stay clean (**2**).
- An explicit operator signal remains available in a review-required epoch **before shutdown**, while an agent signal is denied (**1**).
- Trustworthy engine refusals at create/start return recorded known non-effects and remain clean, for both origins (**4**).
- Lost start response, inspection timeout, and unreadable delivery result after commitment require review for both origins (**6**).
- Full-run held signal success permits a real clean checkpoint; required signal evidence failure forbids checkpoint creation and a clean terminal run (**2**).

Total: **37**.

The unknown-outcome and known-refusal cases are deliberately included now. Tracking a promise is insufficient if its rejection or its “delivery unknown” result is then interpreted as a known no-op. Conversely, classifying every refusal as unknown would be an incorrect overcorrection. Both sides of that contract belong to this frozen signal-lifecycle gate.

### L2 matrix

- Successfully started, zero-job epoch: reject each of `world.stopping`, `world.stopped`, and `world.container_removed`, then restore logging—with and without a repeated stop. Restart must still be denied (**6**).
- Successfully started epoch with rejected preparation and zero actual job starts also cannot discard failed evidence (**1**).
- Failed stop request and unverified still-running container block restart without replacing safety (**2**).
- Clean predecessors with zero jobs, a completed job, or a running job permit a fresh epoch while preserving the prior receipt (**3**).
- A refused startup with rejected cleanup evidence or unverified cleanup is not a retry exemption (**2**).
- A genuine startup refusal with no admitted agent execution and verified, adequately recorded cleanup may retry (**1**).

Total: **15**.

Restart denial is checked **before further engine create/start effects or epoch replacement**. Merely throwing after allocating a new epoch or beginning another startup does not pass.

### Existing acceptance remains in force

The full unit suite includes the original R2 admission/stop boundary matrices, sealed safety assessment checks, record failures, startup cleanup, no replay, context/perception policies, and PC1 attempt/response accounting. Those 251 passing tests are not discarded just because the final handoff focuses on L1/L2.

## 4. Implementation: one operation-ownership mechanism for signals

Primary files:

- `runtime/src/world/jobs.ts`
- `runtime/src/world/exec.ts`
- `runtime/src/world/backend.ts`
- `runtime/src/core/execution-safety.ts` only where a precise review cause is needed

### 4.1 Register before the first await

Split `signal()` into a public registration wrapper and a private asynchronous implementation. Register the operation's promise synchronously before asynchronous work can escape lifecycle ownership. Keep each invocation distinct, including simultaneous signals to the same job.

Use the existing settleable evidence mechanism or an equivalent bounded-lifetime operation registry. It must cover the **whole operation**, not only the helper's transport promise:

```text
request admission
  -> required request record
  -> helper creation
  -> final transport admission
  -> start response / inspection / output
  -> classify known vs unknown outcome
  -> required terminal record
  -> refresh / cleanup
  -> deregister
```

A job ID is not a unique operation ID. Do not use a single per-job “signal pending” boolean or overwrite one pending signal with another. Remove registry entries on both success and failure; do not retain completed promises indefinitely.

A rejected promise being caught is not evidence of a safe outcome. Record/retain the corresponding known refusal, unknown outcome, or evidence failure before releasing its lifecycle ownership.

### 4.2 Separate physical stop from evidence settlement

Retain the current correct shutdown order:

1. Close new effect admission synchronously.
2. Drain/refuse ordinary pending shell submissions under the existing contract.
3. Commit the actual engine stop, preserving the current inspection-epoch distinction.
4. Settle already admitted signals and their required evidence.
5. Finish required world records and dispose of resources.
6. Seal and return the immutable assessment.

**Do not put unresolved signal records/responses ahead of the physical engine stop.** The tests hold those promises and require that the engine stop is still issued. Otherwise a failed or stuck signal could prevent the safety action.

This does mean the stop API waits to issue its final assessment until finite, already admitted work is accounted for. Existing transport deadlines still apply. This work does not promise to resolve an indefinitely stalled host write or implement a watchdog.

Concurrent stop calls must continue sharing the same operation. A failed/unverified stop may return its unsealed review-required assessment, but its pending operations must remain owned and reach the subsequent stop's assessment.

### 4.3 Operator attribution does not bypass shutdown closure

Keep two different questions separate:

- Is the world review-required? New **agent** effects are forbidden; an explicit operator intervention can still be allowed and attributed.
- Has shutdown begun? New signal operations from **either origin** are forbidden. Whole-world safety stop remains available.

This preserves the intended operator intervention capability without letting operator-labelled signals appear after the sealing barrier has begun.

Check closure before accepting a new signal request and again at its actual start commitment. A signal admitted earlier but held at request recording or exec creation must be withdrawn if shutdown begins before its start.

### 4.4 Known withdrawals and refusals need terminal outcomes

After the required request record has been accepted, a withdrawn signal needs one required `job.signalled` outcome identifying its job, signal, origin, and known non-delivery. It must return the existing not-delivered result rather than being mistaken for an unknown mutation.

`runControl` currently creates the helper before calling its final `admit` callback. Add an early admission check as well: if shutdown was already requested while the signal request record was pending, do not attempt helper creation against a stopped/removed container. Keep the decisive post-create check too.

Supply a closure-aware guard for operator controls as well as agent controls; only the handling of prior uncertainty differs by origin.

The tests inject trustworthy **403 refusals**, not arbitrary ambiguous server failures. Translate proven create/start refusal into a recorded known non-effect. Do not generalize this into “all transport/server errors mean nothing executed.” No retry or redispatch is permitted.

### 4.5 Unknown delivery requires review, even if the outcome record succeeds

When a mutating signal helper was committed but its delivery cannot be established—lost start response, timeout, or unreadable result—retain a review-required fact before attempting its outcome record. A `delivered: false` field with a detail saying “unknown” must not be treated as proof of a known no-op.

Preserve attribution: uncertainty about an operator signal is not evidence that the model selected an uncertain shell action. Use a precise bounded review cause/operation identity, or explicitly incomplete required outcome evidence, rather than inventing a model action. Keep the diagnostic evidence available in the signal records and stop assessment.

A required record rejection independently marks evidence incomplete. Neither failure may disappear when the operation promise settles. Repeated stop cannot turn it into a clean epoch.

The existing clean-checkpoint gate should then reject the assessment naturally. Do not special-case these test scenarios in the operator/checkpoint code.

## 5. Implementation: explicit startup outcome, not a command counter

Primary file: `runtime/src/world/backend.ts`.

### 5.1 Remember whether this epoch successfully started

Add explicit internal startup lifecycle state (for example `starting`, `started`, `startup_refused`) associated with the current safety object. Set `started` only when startup verification finishes successfully.

`committedEffects === 0` cannot substitute for this distinction. A world may successfully run, receive only wait/text responses, or reject a preparation, and still need review for incomplete shutdown evidence.

### 5.2 Validate the predecessor before changing anything

Before assigning a new safety object, clearing `#lastStop` / `#startCleanup`, creating a container, or issuing any start/probe request:

- For a successfully started predecessor, require a verified, fully recorded, sealed, review-free stop of that same epoch.
- For a genuinely refused startup, permit the narrow existing safe retry only when no agent execution was admitted and cleanup is known adequate. The delivered retry fixture has verified and recorded cleanup.
- Refused startup with unverified cleanup or failed cleanup evidence cannot use that exception.
- Preserve legitimate no-execution startup retries; do not ban all repeat `start()` calls.

On denial, preserve the prior epoch snapshot and immutable receipts. Restoring the logger does not retroactively write missing evidence. A repeated absent-container stop does not absolve the earlier required-evidence failure.

On a legitimate new epoch, create a new safety object; never clear the old object's fields. Old returned receipts must remain unchanged after the new epoch starts and stops.

## 6. Test mechanics and why these are deterministic

The signal tests deliberately use **in-memory world record acknowledgements** after provisioning. They still run the actual production backend/JobTable/control path. This removes filesystem scheduling from the stop-assessment ordering assertion.

After the fake engine emits the stop-commit event:

- engine operations and unheld world record acknowledgements are promise/microtask work;
- a single `setImmediate` turn exhausts that runnable work;
- the explicit held promise is the only unresolved signal boundary;
- a returned stop result at this point proves premature completion.

The five-second barrier deadline is a test failure bound, not a sleep used to make the race happen. All held gates release in cleanup. Tests observe rejections immediately to avoid unhandled promises, settle tracked work, close the backend, and remove only their own temporary directories.

The restart tests use real world JSONL writes. Their failure injections select exact event types. Full-run signal cases use real run files and verify both the returned result and persisted checkpoint/terminal-event outcome.

The tests do not inspect private JobTable fields or require a particular registry implementation. They freeze observable lifecycle behavior. They do require known withdrawals/refusals to return the current truthful result shape and required terminal evidence.

## 7. TDD execution order

1. Run the delivered acceptance suite unchanged and preserve its RED output.
2. Implement signal operation ownership and stop admission closure; make the held-operation matrix pass.
3. Implement trustworthy refusal/withdrawal versus unknown-delivery classification; make both positive and negative control-outcome cases pass.
4. Implement explicit predecessor startup-state validation; make the epoch matrix pass without breaking legitimate retries.
5. Run the full suite to preserve the existing 251 tests and policy/accounting behavior.
6. Run the fixed final checks below; hand back command outputs and the implementation summary.

Do not change runtime code merely to make test instrumentation observe a different order while still certifying unresolved evidence. Do not suppress failures, drop signal outcome records, unconditionally require review for every run, disable signals, or forbid all restarts. The positive controls intentionally reject those shortcuts.

## 8. Fixed completion gate

From `runtime/`, on Node 24:

```sh
npm run typecheck
npm run lint
node --test test/unit/signal-shutdown.acceptance.test.ts test/unit/epoch-restart.acceptance.test.ts
npm test
npm run build
node dist/cli.js config validate test/fixtures/fake.config.json
npm run measure:packing
```

Repeat the targeted acceptance command three times; all **52** tests must pass each time, with no skips or cancellations. The full suite must pass without removing or weakening tests; with the current suite that is **303/303** (additional tests may increase the total).

The two new file hashes must still match §2. Tests/fixtures must not be altered to conceal production behavior. No Docker mutations or paid calls are part of this gate. If separately authorized integration is run, report its result separately.

**Once this gate is green, close this lifecycle review.** Verification at handback is running these commands and checking that the agreed tests were preserved—not conducting another open-ended bug hunt or adding another precondition.

## 9. Handoff changes already made

- Added the two acceptance test files only; production code is unchanged.
- Ran and verified RED, including the full-run false-clean-checkpoint signal case.
- Ran the final acceptance set three consecutive times with identical counts and intended assertion failures.
- Confirmed that all pre-existing tests still pass, and typecheck/lint/build/CLI validation remain passing.
- Added this implementation plan and linked it from the findings.

This deliberately leaves `npm test` red until the implementation is corrected. That is the requested TDD handoff, not an unfinished test-writing task.
