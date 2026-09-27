# Phase 3 operator decisions

These decisions were approved during review of Phase 3. They supplement the implementation plan and results; recording them does not claim that corresponding code changes are implemented or verified. Observable behavior changes require new profile versions.

## 1. Continuing-job output — approved

Do not automatically deliver later stdout/stderr from continuing jobs. Later observations provide bounded job status and byte counts. The agent is responsible for managing output through its own shell actions and files.

Describe the interface truthfully, but do not add redirection instructions, recovery hints, or an imposed memory-management strategy to the agent prompt. This decision does not waive truthful status, bounded retention, or no-replay requirements.

## 2. Directory perception — approved

Remove the automatic directory listing from observations. The agent discovers filesystem contents by choosing shell actions such as directory inspection itself. Resource and job observations remain available under their declared profiles.

This supersedes the planned automatic initial/resume shallow listing and eliminates the pending listing-byte-cap choice. Introduce the appropriate new sensor profile; do not silently alter an existing one.

## 3. Failed model calls and tick accounting — approved

Distinguish attempted cognitive steps from steps that received a model response:

- A failed model call counts as an attempted tick, not a completed cognitive step.
- Record attempted calls and received responses separately. Use attempts for the operational tick limit; do not allow failures to bypass that safeguard.
- A model refusal, invalid tool call, or intentional inaction is a received response, not an infrastructure failure.
- Infrastructure failures include request timeout, transport loss, provider unavailability, and an aborted in-flight request. Requests refused before invocation are not actual attempted model calls; preserve their separate evidence.
- Keep the no-automatic-retry policy. A failed call ends the current execution session with its failure recorded; this decision does not itself determine clean-stop versus recovery-required classification or authorize resume.
- Cost accounting remains separate. Preserve conservative charges/reservations when processing or usage is unknown.
- Analysis compares behavior over received responses while reporting attempts, failures, elapsed time, and cost. Do not interpret infrastructure failure as agent-chosen silence, abandonment, or mortality.

## 4. Context policy — approved

Use a generous, configurable context budget, targeting **1,000,000 total tokens** when supported by the selected model/API. The total includes input, the output/reasoning allowance, and the estimation margin; it is not an additional input-only budget or a requirement to fill each request.

Do not deliberately impose a small memory window in the first experiment. Smaller windows are explicit later experiments. Preserve complete exchanges, evict only as necessary, and add no hidden summaries, retrieval, or automatic persistent memory service.

Choose the exact output/reasoning allowance when selecting the live model; the current 1,024-token output allowance and 512-token margin are engineering placeholders, not frozen SOTA settings. Verify capability, token accounting, pricing, and actual retention before live experiments. Do not silently reduce the configured budget.

## 5. Engineering responsibility — delegated

The operator explicitly delegates low-level engineering rules to the implementer/reviewer. Do not request separate operator approval for routine failure classification, safe shutdown, failed-start handling, record-capacity reserves, or encoding correctness.

Apply the existing safety and evidence contract:

- Fully accounted effects and verified, adequately recorded shutdown may support a clean stop. "Clean" describes shutdown integrity, not successful agent behavior.
- Uncertain world effects, unverified world state, or insufficient required evidence demand review, not a resumable clean checkpoint.
- Preserve specific failure causes and conservative accounting. No automatic retry, replay, or resume.
- Bound all relevant records and preserve accurate text/byte provenance.
- Introduce new profile versions for observable behavior changes.

Delegation is not approval of a particular unverified implementation or permission to waive a finding. Engineering choices must still satisfy tests and the approved safety contract. It also does not authorize privileged tests, disruptive operations, or paid inference implicitly.

## Decision boundary and remaining work

Bring the operator choices that affect what the agent perceives, can do, remembers, or is encouraged to do, or how behavior is interpreted as research evidence. Handle routine engineering mechanics without repeatedly requesting policy approval.

**No further research-facing decision is currently blocking Phase 3.** Implement these approved choices, close the remaining verification findings, and verify the result. This document records decisions, not implementation completion or Phase 3 sign-off.
