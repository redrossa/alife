# Phase 5 — implementation results

**Status: offline complete; live compatibility/smoke pending.** The frozen offline gate passes. The plan's §9 live evidence has not been run: it needs operator setup and explicit approval. The steps are in the run card below. Contract: [phase-5-tdd-implementation-plan.md](phase-5-tdd-implementation-plan.md). Frozen tests: [phase-5-acceptance-manifest.json](phase-5-acceptance-manifest.json).

**Independent handback:** [offline gate verified and closed](phase-5-handback-verification.md); live compatibility/smoke remains pending.

## Offline gate (Node 24.14.0, darwin/arm64, 2026-09-27)

This is the final run, taken after all source changes including the probe tooling. Only a CLI help-text line changed after it; I reran typecheck, lint, build and the CLI tests for that change.

| Check | Result |
| --- | --- |
| 10 Phase 5 acceptance/helper files and 15 prior-gate files vs manifest hashes | all 25 match; none edited |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 (Phase 4 carry-over below) |
| `node --test test/unit/phase5-*.acceptance.test.ts` ×3 consecutive | 159/159 each; 0 fail, 0 cancelled, 0 skipped, 0 todo |
| `npm test` | 630/630 (627 frozen and legacy, plus 3 new probe tests); 0 cancelled, skipped or todo |
| `npm run build`; `node dist/cli.js config validate test/fixtures/fake.config.json` | exit 0; valid |
| `npm run measure:packing` | exit 0; output unchanged |

I also ran the Phase 4 command (`node --test test/unit/phase4-*.acceptance.test.ts`) during implementation: 160/160. Logs are in the session scratchpad (`p5gate/`, final run `p5final/`).

No legacy test expectation was changed.

## Production wiring verified

- **Config and CLI to the adapter.**
  - `config validate` → `resolveConfig`: anthropic is runnable only with verified rates at or above the model's minimum, a `verifiedOn` date and a campaign directory. OpenAI stays blocked.
  - `run start` / `run resume` → `createMind` → `createAnthropicMind`: `process.env[credentialEnv]` only, and native `fetch`.
- **Campaign.**
  - `startEpisode` opens the campaign right after the mind is created, before any lock or world, and closes it in `finally`.
  - `resumeEpisode` refuses a paid checkpoint that has no campaign binding, and reopens the campaign from the binding.
- **Admission.** `TickLoop` reserves in the run ledger and then in the campaign (`SpendAuthority`). The request record and the synchronous transport call follow.
  - A campaign refusal ends the run cleanly with `spend_limit`.
  - A failure to record in either ledger is unclean (`record_failure`).
  - Settlement is mirrored in both ledgers.
- **Records.**
  - `run.created` records the campaign binding and the mind description.
  - The checkpoint (schema 5) records the campaign binding and the reply continuation.
  - The manifest records `mind.model` and the transport (`anthropic-messages-v1`).
- **Probe.** `probe anthropic` → `runAnthropicProbe`, with synthetic inputs only, the same campaign, and hard limits of 3 calls, 30 minutes and $20.

## Disclosures

- **`npm test` concurrency.** `package.json` now runs `node --test --test-concurrency=4`. Under the default concurrency (11 files at once), fsync contention on macOS (`F_FULLFSYNC`) pushed the frozen Phase 4 resume suite past its 15 s timeout and cancelled 2 tests. At concurrency 4 that suite takes about 9 s. The tests themselves are unchanged.
- **Durability trims (fewer fsyncs, same safety argument):**
  - `run.started` and `run.resumed` are no longer synced on their own; the next durable record covers them.
  - The campaign `owner.lock` file is created with O_EXCL but not synced. It only matters while its process is alive.
  - A campaign `settle` is flushed by the next `reserve` or by `close`, not by itself. If a settle is lost in a crash, its reservation stays held in full. That only overcounts spending, so the campaign stays conservative.
  - Campaign reservations are synced before the request record, as before.
- **Checkpoints.**
  - Schema 5 adds the campaign binding and optional reply continuations.
  - A schema 4 checkpoint still resumes, with no campaign binding. A paid mind never wrote one, so it is fake-only.
  - A schema 3 checkpoint still reads but cannot be resumed.
- **Configs.** `configs/baseline.example.json` is unchanged. The new `configs/anthropic-smoke.example.json` contains placeholders, and `verifiedOn: null` keeps it unrunnable until it is filled in.
- **Phase 4 carry-over (already accepted).** An eslint override disables `no-unnecessary-type-assertion` for the frozen `phase4-resume.acceptance.test.ts`. This was accepted in `phase-4-handback-verification.md`; the original “pending contract review” wording here was stale.
- **CLI help.** The `run start` description no longer says "fake mind only".

## Implemented limits (support boundary)

- **Model:** `claude-opus-5-5` only, over Anthropic Messages streaming with `anthropic-version: 2023-06-01`.
- **Request settings:**
  - adaptive thinking with `output_config.effort: "high"`;
  - the `thinking-binding-controls-2026-08-01` beta with `drop_block`;
  - at most 128,000 output tokens (reasoning included);
  - a 1,000,000-token total bound (estimator `anthropic-wire-bound-v1`, context `recent-complete-exchanges-v3`).
- **Mode:** standard only, with no prompt caching, batch, fast mode, regional (`inference_geo`) pricing or server tools. If usage reports any of those charges, the call's usage is treated as unknown and its whole reservation is kept.
- **Calls:** no retries, summaries or compaction. Input transformations the provider reports are recorded, never acted on.
- **Not implemented:** OpenAI, other models, caching.

## Live evidence: pending (plan §9)

Pricing was verified on 2026-09-27 from the official pricing page, https://platform.claude.com/docs/en/about-claude/pricing.
- **Standard Opus 5.5:** $4/MTok base input, $20/MTok output, and the 1M context at standard rates.
- **Other modes, not used:**
  - cache writes $5 (5m) or $8 (1h), cache hits $0.20;
  - `inference_geo: "us"` 1.1×;
  - fast mode $8/$40; batch $2/$10.
- **Tool use** adds a 286-token system prompt. It is covered by the estimator's margin: the reported input is compared against the estimate.

Account entitlement for the model and beta has not been verified; that needs a live call.

### Worst-case reservations (per call, conservative)

- **Output:** 128,000 × $20/MTok = $2.56.
- **Input:** estimate × $4/MTok. The first smoke call is estimated at 25,650 tokens, about $0.10. The absolute ceiling is (1,000,000 − 128,000) × $4/MTok ≈ $3.49.
- **Probe:** three reservations of about $2.6 each, under the $20 local cap.
- **Smoke:** at most 6 calls. Each call is at most about $6.05, so the smoke stays under the $40 local cap.
- **Campaign:** the probe and the smoke together stay under the $100 campaign. Held and unknown amounts count against it in full.

### Run card (nothing below has been executed)

Prerequisites:
- **Credential:** in the controller shell only, set `ALIFE_ANTHROPIC_API_KEY`. Never put it in chat, in the repository or in a file under it.
- **Tools:** Node 24.14.0, and `npm run build` in `runtime/`.
- **State:** the state directory is the default `~/.local/state/alife`.
- **Config:** copy `runtime/configs/anthropic-smoke.example.json` to a private location outside the repository. Fill its placeholders with locally verified pinned world/helper image IDs, an absolute path to the baseline prompt, the canonical campaign directory, and currently verified pricing/date. Validate the resulting configuration before execution. The author's filled scratchpad draft is private and is not a prerequisite or a published example. Local image IDs from prior reports are not guaranteed to exist on another machine.

Commands below use `alife` as shorthand for `node runtime/dist/cli.js` from the repository root. Generic `~/.local/state/` paths illustrate an operator-owned local setup, not checked-in state.

1. **Create the campaign.** No cost.
   - `alife campaign create --directory ~/.local/state/alife-campaigns/phase5-smoke-v1 --limit-usd 100`
   - The parent directory must exist, and the target must not. Create the parent first with `mkdir -m 700 ~/.local/state/alife-campaigns`; it does not exist yet.
   - Then run `campaign status` on the same directory to confirm.
2. **Synthetic probe.** Paid: at most 3 requests, 30 minutes and $20.
   - `alife probe anthropic --config <config> --output <new private dir> --confirm-paid`
   - It records `probe.jsonl` and `report.json`, including `toolFollowUp`, `prefixChange`, `estimateHeld` and the amount charged.
   - If there is an entitlement, accounting or protocol failure, stop and report it.
3. **Fresh world.**
   - `alife world create --config <config> --docker-context orbstack` is unprivileged.
   - Attach and capture use the privileged storage helper and need per-command authorization.
4. **Managed smoke.** Paid: at most 6 attempted calls, 60 minutes and $40.
   - `alife run start --world <id> --config <config> --allow-privileged-helper`
   - `alife run stop <run-id>` partway through, then `alife run resume <run-id> --allow-privileged-helper`.
   - Afterwards: `run status`, `run export --output <new dir>`, and `campaign status`.
5. **Record:**
   - model and API identity, and sanitized usage and transformations;
   - estimated versus reported input, and generated and reasoning accounting;
   - latency and record growth;
   - the stop, checkpoint and campaign receipts, and the export path;
   - confirmation that caching was zero or not enabled.
