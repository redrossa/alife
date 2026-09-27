# Phase 5 — operator decisions

These decisions capture the operator's approvals following Phase 4 closure. They supersede conflicting Phase 5 provider/output assumptions in `first-runnable-system.md`. They do not authorize a multi-day experiment, privileged Docker operations, or a new Phase 4 audit.

## Access and model preference

1. Investigate subscription-backed OpenAI or Anthropic access first. It must permit this custom autonomous harness under the provider's terms and preserve Alife's explicit prompts, context, tools, accounting and no-hidden-loop requirements. Compatibility is not established yet. A subscription is not assumed to provide general API access or unlimited inference.
2. If suitable subscription access is unavailable and metered API access is needed, the operator will supply Anthropic API credentials for **Opus 5.5**. Verify the exact available model ID, capabilities, pricing and account limits before implementation/live use.
3. Credentials must not be pasted into conversation or committed. Use the configured controller-only credential mechanism; do not expose credentials to worlds, helpers, or the watchdog.

## Cognition limits

- Reasoning effort: **high**, mapped explicitly to the selected model's supported parameter.
- Generated-token allowance: **the model-supported maximum**, verified for the chosen endpoint/model, not the provisional 1,024-token limit.
- Total context remains **1,000,000 tokens**, including the output allowance and existing estimation margin. A larger output allowance reduces available input; do not silently shrink the total context baseline or exceed the combined budget.
- Verify billable reasoning-token treatment. If these constraints cannot be met together, report the incompatibility rather than substituting silently.

## Provider reasoning and history compatibility

Following inspection of installed Pi 0.87.1, the operator accepted using its Anthropic provider-handling pattern, not its coding-agent loop:

- Preserve provider reasoning/signature blocks explicitly with retained complete exchanges, subject to the combined 1M context budget and bounded records. No separate hidden history or resurrection of evicted context.
- Use the documented thinking-binding beta and `thinking.block_binding.prefix_mismatch_behavior = "drop_block"` for Opus 5.5, allowing the provider to discard reasoning invalidated by history changes. Record provider-reported input transformations; do not claim all submitted reasoning was retained.
- Keep Alife's oldest-complete-exchange eviction, with no automatic conversation summaries, extra model turns, or retries.
- Verify reasoning token accounting, tool pairing, trimming, resume and outgoing payloads in the Phase 5 gate. Pi's implementation is a reference, not proof of Alife compatibility or authorization to import all Pi defaults.

This resolves the reasoning-history question raised during private provider research. Live compatibility remains to be tested; no further research-policy approval is needed for this agreed pattern.

## Data and smoke-test scope

The operator approves hosted-provider transmission of model-visible instructions, tool definitions, observations and retained history, including bounded command output. The initial smoke test should use a fresh disposable world with synthetic/non-sensitive content. This is not approval to upload arbitrary host files or secrets, or to give the provider direct Docker access.

The operator approves proceeding toward a small Phase 5 smoke test. The frozen TDD plan §9 defines initial engineering envelopes: up to 3 requests/30 minutes/$20 for the synthetic compatibility probe, and up to 6 attempts/60 minutes/$40 for the managed smoke. Both are subordinate to the same $100 campaign; provide the exact execution run card before running them. Existing explicit permissions for Docker provisioning/privileged helpers still apply.

## Shared paid-inference authorization

**Approved budget: USD $100 total across ALL Phase 5 API smoke tests.**

- Aggregate across providers, runs, attempts and any paid API calibration undertaken as part of smoke testing. It is not $100 per run, account, model or provider.
- Maintain a cumulative campaign ledger; a new process/run must not reset the authorization.
- Admit a request only if its verified conservative maximum charge fits the remaining campaign budget as well as its run limits.
- Retain conservative reservations for unknown usage; do not treat missing receipts as free requests or refund reservations without evidence.
- Include every applicable billed category in the bound or refuse that mode. Confirm the pricing/billing basis before spending.
- No automatic retries or replay; additional paid execution after the shared allowance is exhausted requires fresh approval.
- This authorization does **not** cover the later multi-day experiment. Its cadence, duration and spending authorization remain separate decisions after calibration.

## Process

Retain TDD: implementation plan and frozen acceptance gate before production implementation. Engineering mechanics remain delegated. Do not reopen completed Phase 4 work or change research-facing body/world/context behavior implicitly.

After private subscription-access research, the operator accepted proceeding with the Anthropic API fallback. The offline TDD handoff is frozen in `phase-5-tdd-implementation-plan.md`, `phase-5-tdd-verification.md`, and `phase-5-acceptance-manifest.json`. Implementation has since passed the offline gate; see `phase-5-handback-verification.md`. Live compatibility/smoke remains pending. No paid calls were made during preparation or handback verification.
