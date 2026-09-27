# Engineering contracts and verification

These are reviewed engineering records, not the website's conceptual
[documentation](../docs/). New files in this directory are ignored by default;
`.gitignore` explicitly selects the published contracts and verification history.
Private authoring reviews and provider/subscription research notes are excluded.

## Current checkpoint

**Phase 5 is offline complete; live compatibility/smoke pending.**

Start with:

- [Phase 5 independent handback](phase-5-handback-verification.md): the completed
  offline gate, limitations, and remaining live milestone.
- [Implementation contract](phase-5-tdd-implementation-plan.md) and
  [operator decisions](phase-5-policy-decisions.md).
- [Frozen acceptance manifest](phase-5-acceptance-manifest.json): the 10 Phase 5
  tests/helpers and 15 prior-gate files checked by CI.
- [RED baseline](phase-5-tdd-verification.md) and
  [implementation results](phase-5-implementation-results.md).

CI reproduces offline checks. It does not contact a provider, exercise Docker,
verify account entitlement or certify published prices. Model/rate/platform
statements describe the documented implementation and historical verification;
check current provider support and pricing before the separately authorized
live smoke. The smoke spending cap does not authorize a multi-day experiment.

## Historical progression

- [Initial design with later amendments](first-runnable-system.md).
- [Phase 1 verification](phase-1-implementation-findings.md).
- [Phase 2 spike handoff](phase-2-implementation-handoff.md),
  [implementation](phase-2-implementation-results.md), and
  [verification](phase-2-verification-findings.md).
- [Phase 3 policy decisions](phase-3-policy-decisions.md),
  [policy verification](phase-3-policy-verification.md),
  [implementation](phase-3-implementation-results.md), and
  [final verification history](phase-3-verification-findings.md).
  Its [lifecycle proposal](phase-3-lifecycle-uncertainty-implementation-plan.md)
  led to the [frozen TDD gate](phase-3-final-lifecycle-tdd-plan.md).
- [Phase 4 handback](phase-4-handback-verification.md),
  [implementation](phase-4-implementation-results.md),
  [plan](phase-4-tdd-implementation-plan.md),
  [RED baseline](phase-4-tdd-verification.md), and
  [manifest](phase-4-acceptance-manifest.json).

Historical RED findings, withheld sign-offs and future-tense proposals remain
as history. Later explicit decisions and handback closure take precedence;
those earlier passages are not a list of currently unresolved bugs.

## Publication and evidence boundaries

The frozen manifests and hash-pinned tests/helpers are byte-identical to the
accepted gates. Publication edits to prose do not alter those contracts:

- Personal temporary-directory prefixes and a private session locator were
  replaced with `<OS_TEMP>` / `<private-evidence>` labels in historical reports.
- The Phase 5 run card now starts from the tracked placeholder example rather
  than relying on the author's private scratchpad configuration.
- Links to excluded authoring/provider notes were replaced with dispositions;
  operative policy remains in the tracked decisions and implementation plan.
- Stale top-level status/publication wording was updated. Exact earlier prose
  copies and their hash inventory were retained privately before these edits.

`/tmp/...`, scratchpad and private-archive references identify historical local
evidence; those logs/configurations are **not bundled or publicly downloadable**.
Their recorded hashes are provenance, not proof that a reader can fetch them.
Reproducing the offline gate needs only tracked files and package installs—not
private evidence, API credentials, pinned local Docker images or model spending.

Do not publish raw run exports by default: they are private, unredacted evidence.
Review any proposed dataset separately. Do not modify frozen tests or manifests
for implementation convenience; genuine contract changes require explicit review.
