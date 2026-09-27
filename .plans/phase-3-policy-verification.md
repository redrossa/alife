# Phase 3 policy-change verification

## Verdict

**Policy-change verification passes; PC1 is closed.** The perception, interface, context, and model-call accounting changes match `phase-3-policy-decisions.md`, including the previously failing incomplete-tick accounting paths.

**Phase 3 offline verification now passes.** The final fixed lifecycle gate closes L1/L2 as recorded in `phase-3-verification-findings.md`: 52 unchanged acceptance tests pass three times, and the full suite passes 303/303. The lifecycle review is complete; PC1 accounting remains closed. Privileged integration was not independently rerun.

## PC1 fix reverification

- Invocation outcomes update the in-process attempt/response counters before response/failure recording or action dispatch. `tick.completed` records existing totals without incrementing them again.
- Regression tests cover failures recording `model.responded`, `action.completed`, `tick.completed`, and `model.failed`; known counts survive even when no tick completes.
- The full-run original failure path now returns one attempt and one response with zero completed ticks.
- An additional independent full-run reproduction completed one wait tick, then received a shell response whose dispatch outcome was lost. It correctly returned **one completed tick, two attempts, and two responses**, agreeing with durable analysis. No later scripted turn ran.
- Interrupted-record analysis and CLI output explicitly distinguish confirmed calls from requests with unknown invocation status; missing evidence is not guessed into an attempt or a non-attempt.
- Pre-invocation cancellation and ordinary completed-path tests still pass.
- Node **24.14.0**: **214/214 unit tests in 42 suites**, typecheck, lint, build, and compiled CLI fixture validation passed. No Docker operations, privileged integration tests, model calls, or runtime source edits.

The original finding and initial verification evidence below are retained for provenance; their unresolved wording is superseded by this section.

## Verified policy changes

- **No automatic later-job output:** observations render job state and output byte counts, not later stdout/stderr. Immediate tool-result output remains available under the declared head-retention policy.
- **No coaching:** `shell-body-v4` describes the output interface without redirection, recovery, or memory-management advice. The baseline prompt is unchanged.
- **No automatic directory listing:** the loop requests `sample({ listing: false })`; the backend sensor skips directory scanning for that request. Rendering excludes directory entries even if a caller supplies a sample containing them. Operator/diagnostic listing support remains separate.
- **Versioned behavior:** configuration uses `shell-body-v4` and `baseline-sensors-v4`; their superseded names are rejected. Observation size bounds no longer reserve the former listing. The fake fixture again fits 32,768 tokens; this does not change the research baseline.
- **Generous context:** `baseline.example.json` retains 1,000,000 total tokens. Complete-exchange packing remains configurable, evicts only as required, and adds no summaries, retrieval, or reinjection. Fixed-request overflow refuses execution rather than silently shrinking the configured budget. Live-model capacity/pricing and final output/reasoning allowance remain later gates.
- **Ordinary call accounting:** independent full-run checks confirm a timeout and a failed invocation marked `processed: no` each produce one attempt, zero responses, and one failure, without retry. Refusal, invalid tool call, text-only reply, and wait produce four attempts and four responses. Completed-path run results, checkpoints, and analysis agree. Pre-invocation refusals remain separate from attempted calls; unknown processing retains conservative cost accounting.

## PC1 — Known call activity disappears from results if its tick does not complete — P2, now closed

**Locations:**

- `runtime/src/core/loop.ts:531–544`: call counters advance only inside `#complete`, after action dispatch and a successful `tick.completed` append.
- `runtime/src/operator/run.ts:220–221`: run results copy these counters.
- `runtime/src/operator/run-commands.ts:112–113`: the CLI presents them as actual attempted and answered calls.

**Independent offline reproduction:** run the real `startRun` with the fake mind and a fake world that records `action.prepared`, then throws a lost-dispatch-outcome error after the mind has returned a shell response.

```text
run state: recovery_required
reason: uncertain_action
run result: attemptedCalls = 0, respondedCalls = 0
analysis of durable records: attempted = 1, responded = 1
```

The uncertainty classification and outstanding action are correct. The new cognitive counters are not: an unfinished action/tick erases the already-known model attempt and response from the foreground result. Recording failures before `tick.completed` expose the same dependence on tick completion.

**Required correction:** track invocation attempts and received responses at their own boundaries, independently of action execution and tick completion. Preserve known counts when later dispatch or recording fails. Keep unsent requests excluded and ensure failure paths cannot double-count. Do not solve this by counting every prepared `model.requested` record as a sent request.

**Required regressions:**

1. A model response followed by uncertain dispatch reports one attempt and one response even though no tick completes.
2. Failures recording the response, action outcome, or tick completion preserve the known in-process call counts, while durable analysis honestly states any evidentiary limits.
3. A failed invocation followed by failed failure/tick recording still counts the known invocation in the returned result.
4. Ordinary completed paths retain agreement between results, checkpoints, and log analysis; pre-invocation cancellation still counts zero attempts.

### Interrupted-record reporting qualification

`analyzeEvents` infers confirmed attempts from terminal `model.responded` / sent `model.failed` events. It preserves outstanding requests, but `run status` labels its count simply “attempted,” even when invocation status for an outstanding request is unknown. Explicitly distinguish confirmed counts from unresolved invocation status. An outstanding pre-effect request record alone cannot establish whether a call was made, and must not be converted into either a definite attempt or a definite non-attempt.

## Verification performed

On Node 24.14.0:

- Typecheck, lint, build, and compiled CLI fixture validation passed.
- **208/208 unit tests in 41 suites passed.**
- Packing measurements completed; the fake fixture's fixed request estimate is **25,317 / 32,768** tokens.
- Independent offline call-accounting reproductions and targeted existing regressions were also run.

No runtime source edits, Docker operations, privileged integration reruns, or paid model calls. The implementation report's integration results were not independently rerun in this review. No commit was made.
