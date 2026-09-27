# Phase 5 — Anthropic live mind: TDD implementation handoff

## Status and authority

**TDD preparation complete; gate frozen.** This is a forward implementation contract, not production implementation or a successful live-run report. Preparation was offline. [The acceptance manifest](phase-5-acceptance-manifest.json) pins 10 Phase 5 files and 15 prior gate files; [the verification report](phase-5-tdd-verification.md) records 159 targeted cases (153 expected RED, 6 passing controls) identically across three runs, all 468 legacy tests passing, and the fixed handback checks.

Sources of truth: `phase-5-policy-decisions.md` and `first-runnable-system.md`. Private provider research informed this contract; the operative continuation policy and required compatibility checks are specified here. Phase 4 is closed. Do not reopen its lifecycle review or repeat disruptive machine tests. No Docker resources, paid requests, dependencies, production changes, staging or commits are authorized by writing this handoff.

The operator selected Anthropic API / Opus 5.5 after the subscription investigation, high reasoning, the model-supported maximum generated-token allowance, 1,000,000 combined context tokens, and **USD $100 cumulative across all Phase 5 smoke tests**, not per run. Model-visible synthetic observations may leave the machine. This does not authorize a multi-day run. Credentials use only the configured controller-side ALIFE_ variable; never paste them in chat.

## 1. Deliverable and non-goals

Deliver one real, serial, single-response Anthropic Messages adapter wired through the existing managed start/resume lifecycle. Record bounded requests/responses and provider transformations, preserve complete exchanges including provider continuation state, and enforce a durable cross-run campaign budget before every paid transport commitment.

Do not import Pi's autonomous loop, prompts, host tools, summaries, history repair, retry/recovery behavior or subscription authentication. Pi 0.87.1's provider implementation is a reference for signed thinking replay and `drop_block`, not proof of this implementation's behavior. A direct Messages streaming adapter or a narrowly configured SDK is acceptable if the frozen wire tests pass. No agentic SDK, forced-tool workaround, model-generated summaries, extra token-count model calls, server conversation handles, background model work, retries or automatic replay.

Keep `shell-body-v5`, `baseline-sensors-v4`, `continuing-jobs-v4`, `resume-discontinuity-v1` and watchdog behavior unchanged. The mind still chooses zero or one shell/wait action per tick. Multiple calls, syntactically valid native inputs that violate the body argument schema, length-limited valid messages and unknown tools execute nothing under the existing interpreter; their tool calls retain correctly paired nonexecution results. Syntactically malformed accumulated provider JSON is instead an invalid provider response: keep bounded diagnostic evidence and a conservative unknown charge, but do not repair it or insert an unreplayable partial exchange into model history. No listings, memory coaching, redirection advice or recovery suggestions are added.

## 2. Selected endpoint and configuration

Pinned initial support:

| Field | Value |
|---|---|
| Provider/model | `anthropic` / `claude-opus-5-5` |
| Endpoint | standard HTTPS `https://api.anthropic.com/v1/messages` |
| Transport | streaming; one HTTP inference request per invocation |
| Total context | 1,000,000 including output reservation and existing margin |
| Maximum generated tokens | 128,000, including reasoning |
| Thinking/effort | adaptive / high |
| Thinking binding | documented `thinking-binding-controls-2026-08-01` beta and `prefix_mismatch_behavior: "drop_block"` |
| Prompt caching | no requested cache writes in this first adapter profile |
| Service modes | standard only; no fast, batch, geography modifier or server tools |
| Retries | `none-v1`, including SDK and lower-level transport retries |

Official documentation and installed Pi agree on the model ID and limits; this is not an account entitlement check. Before paid execution verify the account supports them and that official rates/modes have not changed. Refuse unsupported settings rather than downgrade. Keep the maximum output setting even if a bounded request timeout ends a slow response; do not silently reduce the allowance or continue automatically.

Published standard uncached input/output bounds at investigation were $4/$20 per million. Configured upper rates may be more conservative, not below the known selected-mode bounds. Preserve nullable pricing/date fields for configuration inspection, but block paid execution when unverifiable. No cache is requested; unknown/nonzero billable categories must be covered conservatively or cause a fail-closed unknown-cost result, never an undercharge.

Extend the strict existing schema additively with an Anthropic mind variant: `provider`, `model`, `credentialEnv`, existing output/timeout/retry fields, `reasoningEffort`, and existing `costBound`. Add an absolute `operator.campaignDirectory` required for Anthropic. Historical fake configs remain valid with no campaign or credentials. OpenAI remains unimplemented and blocked; do not accidentally enable it while removing the Anthropic blocker.

Add immutable profiles `recent-complete-exchanges-v3`, `anthropic-wire-bound-v1`, and an explicit `anthropic-thinking-v1` continuation description. Real Anthropic configuration must select the new estimator/context profiles. Keep old entries unchanged for fake runs and historical records. Do not change the existing body/sensor profiles just to add wire metadata. The illustrative baseline may be migrated to Anthropic during implementation, with declared fixture-expectation changes, but no working credentials or invented pinned images.

## 3. Adapter boundary and wire contract

Forward module `src/mind/anthropic.ts` exports `createAnthropicMind(options): MindAdapter`; ID `anthropic-messages-v1`. The exact forward options are in `test/support/phase5-contract.ts`: explicit model, env-name plus injected environment, injected Fetch-compatible transport, tools, combined token bounds, high effort, timeout and a maximum response byte count. Unit tests provide all transport and environment inputs. Production `createMind(resolved, dependencies?)` chooses this actual adapter; optional dependencies `{env, fetch}` permit offline factory verification, not a second implementation.

- Resolve only the configured ALIFE_ variable. No .env, generic key fallback, subscription tokens, accidental process-environment fallback when an explicit environment is supplied, custom unverified endpoint or credential-bearing diagnostics.
- Validate requests before sending. Translate the declared system/tools, each observation, assistant content and paired tool results into native Messages fields. Preserve order and semantic values, including hostile JSON keys. No instruction injection or unrequested context.
- Native tool definitions remain descriptions of the existing body, not mandatory tool selection. Text-only/refused/empty output remains allowed. Preserve multiple/unknown calls for core interpretation instead of choosing one silently.
- Accumulate SSE with explicit total-byte, block and parsing bounds. Handle UTF-8/chunk boundaries and signature/input deltas. Require a complete valid terminal message. A lost or malformed stream never becomes a completed actionable partial response.
- Return provider request identity, usage, latency, completion status and provider-reported input transformations. Unknown usage stays unknown. Output usage includes reasoning; do not infer it from visible summary length or add a separately billed reasoning field twice.
- SDK retries must be disabled explicitly. A timeout, disconnection, 429/5xx, truncated/error stream or ambiguous transport failure makes exactly one attempt. Preserve unknown processing conservatively. A pre-send validation/abort/missing key sends nothing.
- Fixed-size sanitized errors must not contain request authorization, raw response errors echoing secrets, environment contents or uncontrolled headers. Bound response buffering even on error.
- Perform all asynchronous preparations before the final lifecycle admission check. The injected Fetch-compatible boundary is the tested commitment point: for a valid admitted request, `invoke()` calls it synchronously before yielding. Prefer native fetch if an SDK cannot satisfy this boundary without delayed preparation. The actual fetch/inference commitment must follow a synchronous stop/lease/epoch check without another await; do not move credential lookup, budget I/O or token-count requests into that gap.

## 4. Reasoning is bounded explicit exchange data

Core remains provider/SDK-type independent. Add optional plain-data continuation to a reply:

```ts
{ profile: "anthropic-thinking-v1", data: string, inputTokenBound: number }
```

`data` is JSON of the complete provider assistant content array, including thinking, signatures, redacted thinking and public blocks. Preserve ordinary/redacted blocks and empty visible thinking carrying a signature. The public projection must agree with the stored full content; do not let unrelated continuation content smuggle new tools/text into history. Unknown, malformed or inconsistent continuation is refused rather than repaired. Fake replies need no continuation.

`inputTokenBound` is a nonnegative safe integer, at most the model's 128,000-token generated ceiling, bounding reasoning restored from opaque state. Prefer a trustworthy total output-usage upper bound; if unavailable use the full generated allowance. Never use encrypted signature length as the only proxy for reasoning tokens. The estimator additionally covers visible public content, serialized continuation bytes, JSON escaping, tools and provider framing; conservative double counting is acceptable. Provider framing is a declared conservative bound, empirically checked by the live smoke, not a universal tokenizer theorem.

Expose new `recentCompleteExchangesV3(ContextBudget)` in `core/context.ts` and `tokenEstimator("anthropic-wire-bound-v1")`. Keep the old constructor/profile unchanged. V3 retains the newest contiguous suffix of complete exchanges, with opaque state evicted with its exchange. Reserve output plus margin and the full context-usage appendix before selecting history. A fixed request that cannot fit is refused; never shrink the maximum output allowance or add a summary to make it fit.

The adapter has no private conversation history. Reusing the same instance with an empty/smaller supplied history must not resend omitted material. `drop_block` allows the server to discard reasoning invalidated by a changed prefix; record `input_transformations` in observer evidence. These diagnostics do not become new coaching text. Bound and validate transformation records. Server-dropped opaque state does not justify restoring evicted messages or treating its removal as free budget retrospectively without usage evidence.

Persist continuation through bounded reply records, loop history and clean checkpoints. Introduce a new checkpoint version (5) and manifest version as needed rather than changing the interpretation of existing version 4 data. Continue reading/resuming valid historical v4 fake runs under their original policies; v3 remains historical non-resumable evidence. Do not invent continuation for historical records. Hash/integrity/schema checks and original deadline/configuration protections remain.

## 5. Durable $100 campaign ledger

The existing `CostLedger` is per run; it is not sufficient for the authorization. Add `src/records/campaign.ts` with the forward interface fixed in `test/support/phase5-campaign.ts`:

- Explicit `createCampaign({directory,campaignId,limitMicroUsd,maximumBytes})` initializes private metadata/journal once; never overwrites/reinitializes existing evidence.
- `openCampaign({directory,campaignId})` requires existing valid data and acquires exclusive ownership. It never implicitly creates missing/reset records or breaks a stale lock.
- A handle exposes async `reserve`, `settle`, `snapshot`, `close`. Reserve identities are `(runId, requestId)` and are spent permanently, including after settlement and reopen.
- `reserve({runId,requestId,maximumMicroUsd})` durably holds a positive safe integer charge before effects, or returns null without reserving if it cannot fit. Its journal entry includes these exact identity/amount fields together, so a request's full hold can be established independently of in-memory state. Use integer micro-USD and round up token-rate multiplication. `$100 = 100000000` micro-USD.
- `settle` accepts known usage/charge, known not processed, or unknown. Unknown consumes the entire reservation. Reconciliation never counts both outstanding and settled charges, and duplicate settlements cannot refund money. Unexpected over-bound actual usage is preserved, marks review required and blocks further admission.
- `snapshot` reports campaign ID, immutable limit, accounted/outstanding/remaining amounts and review state. Limit and identity are not overridden by opening config. Numeric corruption and partial/truncated/corrupt records fail closed; missing evidence is not zero spending.
- Hold exclusive campaign ownership for an episode; reject competing paid episodes before world attach. Serializing paid runs is a deliberate Phase 5 implementation constraint, not a multi-agent scheduler. Ordinary clean close allows subsequent runs to open the same campaign. Controller crash leaves durable reservations and may leave a stale lock; explicit reviewed recovery is required, never automatic acquisition/refund.
- Keep all campaign files private, out of repository, with symlink defenses, immutable initialization metadata and a bounded journal. Store exhaustion refuses future requests while preserving prior evidence. Account outstanding obligations on reopen even after a clean handle close.

The actual smoke campaign ID is `phase5-smoke-v1`, limit at most $100. Use **one operator-designated canonical directory across every paid smoke/probe/run**, even if a run's ordinary state directory changes. No `run start`/resume/probe path may initialize a new campaign as a convenience. Explicit initialization is a provisioning action; the operator must not create replacement campaigns to reset spending. The filesystem/operator remains trusted—this is durable admission control, not protection against an operator deleting billing evidence.

Expose `campaign create --directory <absolute> --limit-usd <positive-up-to-100> [--json]` and `campaign status --directory <absolute> [--json]`. These commands use fixed ID `phase5-smoke-v1`; JSON status contains the snapshot fields above. Reject sub-micro-USD, nonfinite, nonpositive and over-$100 limits before creating files. Creation is explicit and cannot reset or raise an existing campaign. Status never initializes missing evidence. Journal schema/paths and these CLI instructions must be documented by the implementation. The frozen tests pin `metadata.json`/`journal.jsonl` where needed for corruption checks. Campaign size is a separate bounded operational accounting store, not hidden unbounded observer storage and not agent context.

## 6. Run wiring and two-ledger commitment

For real providers, campaign acquisition/config/credential validation must precede world attach/start. Dependency injection of a mind for testing must not bypass paid-path campaign enforcement. Fake runs do not acquire it.

Before each transport commitment:

1. Assemble/validate the exact bounded request; ensure observer capacity and remaining deadline.
2. Reserve per-run maximum and durably reserve the same maximum in the shared campaign.
3. Record run request/reservation and campaign identity durably. If either preparation fails, send nothing. Known-unsent reservations may be released only with trustworthy evidence; uncertain crash windows keep their full hold.
4. Recheck stop, supervision and execution-epoch safety synchronously immediately before transport. No await between this check and the call.
5. Invoke once, reconcile both ledgers conservatively, and preserve evidence before another model call or action. A failed record cannot make spent money free or allow more calls.

A clean checkpoint references the immutable campaign identity/directory binding but is not an authority to rewind its latest balance. Resume opens the current shared ledger and preserves historical run accounting, selected prices/mode, bounded continuation, call counters and original deadline. Exhausted, missing, conflicted, corrupt or substituted campaign evidence refuses before touching the world. Do not replay a request with missing usage; retain the reservation/unknown charge. Record failures must still allow physical world stop under the existing safety contract.

Provider failures count attempted calls separately from responses/completed ticks. Incomplete stream output dispatches no action. Existing lifecycle guards and frozen Phase 3/4 regressions continue to cover world uncertainty and watchdog behavior; Phase 5 adds provider-path checks, not a new review of their implementation.

Budget admissions may conservatively charge all supported input at a single upper rate as long as every category fits the bound; no speculative cache discount. Report attempted reservations, actual reported usage and conservative retained charges separately from provider invoice claims.

## 7. Records, resource bounds and credentials

Record adapter/model identity, exact effort/output/context/binding/cache modes, endpoint API version, dependency version (or explicit native transport identity), verified pricing source/date, campaign binding and bounded transformations. Retained signed blocks are sensitive research data, not credential material: private exact evidence exports may contain them; say so. Exports are not automatic publication or redaction.

Do not put API keys into resolved config, stored prompts, manifests, event/error text, checkpoints, archives/exports, world/helpers or watchdog environment. Normal credential values are passed only in the configured controller's HTTPS authorization header. No shell command expansion of keys, .env loading or operator token printing. A synthetic sentinel checks leakage offline.

Recalculate `tickRecordReserveBytes` for the bounded full response, continuation, observer envelope, checkpoint and provider error/transformations. Enforce stream response bounds before unbounded accumulation. Stop for insufficient observer capacity without sending a model request; do not claim the legacy 16MiB limit necessarily fits a 128K-output live tick. The proposed acceptance live fixtures use 128MiB record capacity. A maximum request deadline must fit inside the controller lease and remaining managed-run deadline, with the existing stop margin.

## 8. Offline acceptance and fixed handback

The executable forward tests are organized by responsibility:

- `phase5-cli.acceptance.test.ts`: explicit bounded campaign creation/status, no implicit reset or initialization.
- `phase5-config.acceptance.test.ts`: strict config, immutable profile addition, credential-free validation, pricing blockers, actual production factory.
- `phase5-anthropic.acceptance.test.ts`: outgoing Messages payload and streamed parsing, continuation, usage, limits, authentication isolation, abort/no-retry behavior.
- `phase5-context.acceptance.test.ts`: opaque token accounting, combined budget, no summaries/reinjection, suffix eviction and malformed-state refusal.
- `phase5-campaign.acceptance.test.ts`: durable cross-run admission, conservative settlement, exclusive ownership, corruption/capacity and crash behavior.
- `phase5-run.acceptance.test.ts`: actual Anthropic adapter over offline transport inside start/resume and real records, campaign integration and lifecycle effects.

Absent APIs fail explicit assertions, never import failures masquerading as refusal. Passing fixture controls validate fake-world/transport/storage setup. Every test is offline; no genuine credential is needed. Actual provider streams and failure cases are synthesized at the transport boundary, not at the MindAdapter response boundary.

Implementation order: preserve RED evidence → add config/profiles and bounded continuation contracts → estimator/context/checkpoint compatibility → streaming adapter and factory → durable campaign → run/managed/CLI wiring → all tests GREEN → documented opt-in smoke. Do not weaken tests, change frozen helpers, substitute a test facade or edit old acceptance gates to turn green. A genuine test defect needs explicit contract review and disclosed re-freeze.

Handback requires matching frozen hashes, three consecutive 159/159 targeted passes, all legacy tests plus the new suite (at least 627 total), typecheck/lint/build, compiled fake config validation and packing measurement on Node 24.14.0. Counts and log hashes belong in the verification document rather than guessed here. Passing the agreed offline gate closes offline verification; no open-ended audit follows.

## 9. Permission-gated live evidence (not unit tests)

Phase 5 completion also needs a bounded approved smoke, because offline SSE fixtures cannot establish account access or actual token counting. This preparation does not execute one. Before execution, the implementer supplies an explicit invocation/run card, current pricing verification, campaign initialization/status, credential-env name only, and any needed Docker/helper authorization. No automatic startup probe from config validation, import, unit tests or `run start`.

Engineering probe envelope: **at most 3 inference requests, 30 minutes total, $20 local cap**, additionally subject to the $100 shared campaign. Synthetic inputs only, no world side effects. Exercise ordinary signed-thinking/tool-result follow-up and a deliberately changed retained prefix with `drop_block`. Never fabricate a provider-signed block; if the model does not produce a usable case within these attempts, mark the probe inconclusive rather than reprompt/retry automatically. A synthetic probe is not a baseline behavioral trial and its instructions/results must be kept separate from the baseline prompt.

Managed fresh-world smoke envelope: **at most 6 attempted model calls across explicit start/resume, 60 minutes absolute duration, $40 local cap**, additionally subject to the remaining shared campaign. Existing body/world/sensor policies and baseline prompt unchanged. Preserve independent watchdog, stop, bounded capture and private export evidence. No engine restart, host sleep, foreign-resource operations or implied privileged-helper approval. If fresh world provisioning needs privileges, obtain the per-command authorization first.

The above envelopes are engineering limits under the already-approved total, not extra allowances. Probe + managed reservations share one ledger; failed/ambiguous attempts consume it conservatively. Unused local allowances do not reset anything. Further manually approved smoke attempts can use only the remaining $100 authorization, with recorded call/time limits, never automatic retries.

Capture model/API identity, raw sanitized usage/transformations, conservative estimated vs reported input, generated/reasoning accounting, latency, record growth, actual stop/checkpoint/campaign receipts and export paths. Prove no request exceeded the combined 1M bound and no admission exceeded remaining campaign/run funds. Cache metrics should truthfully be zero/not enabled for this initial profile; caching optimization is not a hidden completion prerequisite.

If only offline tests pass, report **offline complete; live compatibility/smoke pending**, not Phase 5 complete. If live entitlement, accounting or protocol limits fail, report the specific incompatibility and stop. Passing the frozen offline gate plus this bounded live evidence establishes Phase 5 completion within its support boundary. A multi-day experiment, automatic compaction, caching changes and other models remain separate follow-up work.
