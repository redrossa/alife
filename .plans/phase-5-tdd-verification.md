# Phase 5 TDD acceptance — frozen RED baseline

**Handback: offline PASS; live compatibility/smoke pending.** See [phase-5-handback-verification.md](phase-5-handback-verification.md) for independent GREEN checks and closure of the frozen offline gate. The RED baseline below remains historical preparation evidence.

**Status at preparation: offline TDD preparation complete. No Phase 5 production implementation or live smoke was performed by that preparation.**

Frozen 2026-09-27 UTC on Node **24.14.0**, **darwin/arm64**. Implementation contract: [phase-5-tdd-implementation-plan.md](phase-5-tdd-implementation-plan.md). Exact acceptance/helper and evidence hashes: [phase-5-acceptance-manifest.json](phase-5-acceptance-manifest.json).

## Verified baseline

Three consecutive targeted runs:

```sh
cd runtime
node --test --test-reporter=tap test/unit/phase5-*.acceptance.test.ts
```

Each produced **159 tests in 4 suites: 153 intended failures, 6 passing controls, zero skips/cancellations/todos**. All leaf failures are `ERR_ASSERTION`, with messages verified to identify missing Anthropic/campaign modules, missing CLI/profiles/context constructor, or unsupported forward configuration. Four suite-level `ERR_TEST_FAILURE` entries merely aggregate failed subtests; there are no loader, compiler, fixture-setup, or unexpected production-regression failures in the measured RED baseline.

| File in `runtime/test/unit/` | Cases | Passing controls | Expected RED |
|---|---:|---:|---:|
| `phase5-anthropic.acceptance.test.ts` | 49 | 3 | 46 |
| `phase5-campaign.acceptance.test.ts` | 35 | 0 | 35 |
| `phase5-cli.acceptance.test.ts` | 9 | 0 | 9 |
| `phase5-config.acceptance.test.ts` | 23 | 1 | 22 |
| `phase5-context.acceptance.test.ts` | 19 | 1 | 18 |
| `phase5-run.acceptance.test.ts` | 24 | 1 | 23 |
| **Total** | **159** | **6** | **153** |

Passing controls exercise actual Request/Response transport fixtures, split UTF-8 SSE bytes, the existing incomplete-response interpreter, credential-free fake configuration/factory, legacy complete-exchange packing, and a real fake-mind start/stop/checkpoint through operator code and the fake world/clock. They are not replacements for the missing live adapter.

The full `npm test` invocation produced **627 tests in 71 suites: 474 passed, 153 intended failures, no skips/cancellations/todos**. All **468 preexisting tests passed**, plus the six new controls. Every failed test location is in a delivered `phase5-*.acceptance.test.ts` file.

Other checks passed:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `node dist/cli.js config validate test/fixtures/fake.config.json`
- `npm run measure:packing`

All **15 frozen Phase 3/4 test/helper hashes** still match. No old acceptance file was modified. A preparation-time snapshot of 59 production/configuration/prompt/package files remained unchanged through verification (`/tmp/alife-phase5-production-snapshot.json`). Build output was regenerated only by the normal build check, not edited or committed.

## Pre-freeze contract corrections

Review and validation happened before this freeze, not as new implementation requirements afterward:

- Reconciled the run fixture's thinking expectation with the required `drop_block` binding setting.
- Distinguished malformed accumulated native JSON (invalid provider response, conservative unknown cost, no replayable partial exchange) from valid JSON that violates the body schema (core protocol refusal with paired results).
- Required actual received-response counts, exact core refusal reasons and paired nonexecution results so parser failure cannot masquerade as protocol correctness.
- Captured uncertainty-injection errors outside callbacks and asserted successful uncertainty establishment, rather than allowing a thrown fixture hook to look like the expected safety outcome.
- Verified the same campaign run/request/maximum reservation in on-disk evidence at fetch, not merely the presence of a word such as “reserve”.
- Reworked store-exhaustion testing to consume capacity with valid positive reservations and abundant remaining money; invalid zero-cost reservations cannot produce a false positive. Included campaign control files in its byte check.
- Bounded child readiness and settled the owned child before fixture teardown in the crash case.
- Added continuation/public-projection consistency, hostile JSON-key preservation and observer-only transformation checks.

Forward tests cannot establish actual Anthropic compatibility or future implementation correctness while their production API is absent. Fixture controls and typecheck show the test apparatus loads and the existing seams work; the implementer must still make the unchanged cases pass through actual production code.

## Evidence

Hashes are in the manifest. Final evidence files:

- `/tmp/alife-phase5-frozen-red-{1,2,3}.log`
- `/tmp/alife-phase5-frozen-full-red.log`
- `/tmp/alife-phase5-{typecheck,lint,build,config,packing}.log`

The full invocation was `npm test -- --test-reporter=tap`; npm's argument handling left its output in Node's default spec format, but it executed the complete unit suite above. The targeted logs use TAP. Draft/author logs are not the frozen baseline.

## Fixed offline handback gate

1. Verify the manifest's **10 Phase 5 acceptance/helper files** and **15 prior gate files** by SHA-256. Genuine test defects require explicit contract review and a disclosed re-freeze, not silent weakening.
2. Pass all **159 Phase 5 cases three consecutive times**, without skips/cancellations/todos, stubs or test-only production facades.
3. Pass `npm test`: **at least 627 tests**, including every preexisting regression. Any necessary non-frozen legacy example/schema expectation updates must be disclosed; removing or weakening regressions to obtain green is not allowed.
4. Pass the five other checks listed above on Node 24.14.0. Record versions, counts, exit codes and retained evidence paths.
5. Verify actual production factory/start/resume/CLI wiring, not an isolated adapter that the CLI never uses. Report implemented limits and any unsupported modes without calling them verified.

Useful hash check from the repository root:

```sh
python3 - <<'PY'
import hashlib, json
from pathlib import Path
m = json.loads(Path('.plans/phase-5-acceptance-manifest.json').read_text())
for f in m['files'] + m['unchangedPriorGate']:
    actual = hashlib.sha256(Path(f['path']).read_bytes()).hexdigest()
    assert actual == f['sha256'], f['path']
print('All 25 acceptance/helper hashes match')
PY
```

**Passing this gate closes offline Phase 5 verification. No fresh exploratory audit or expanding checklist follows.** Tests define the agreed completion scope; they do not prove the absence of all defects.

## Live evidence remains separate

No Docker operations, privileged helper, image build/pull, engine restart, host sleep, provider request or paid calibration ran during preparation. All inference transport in these tests is synthetic. Credentials are not needed for implementation or the offline gate.

Full Phase 5 completion still requires plan §9's opt-in evidence:

- Synthetic compatibility probe: at most **3 requests / 30 minutes / $20 local cap**.
- Fresh-world managed start/stop/resume smoke: at most **6 attempted calls / 60 minutes / $40 local cap**.
- Both consume the **same $100 cumulative campaign authorization**; these are not additional budgets. All failed/unknown requests retain conservative charges.
- Establish real tool-result follow-up, history-prefix change/drop diagnostics, model/context/output limits, conservative estimator versus actual usage, durable billing evidence, independent supervision, safe stop/checkpoint and bounded private artifacts. A model not producing the needed probe case is inconclusive, not permission for automatic extra calls.
- Supply the exact execution run card and credential environment setup beforehand; any required Docker/helper privilege remains separately authorized. Never reuse personal/non-synthetic world data for this smoke.

If offline passes but this evidence is absent, report **“offline complete; live compatibility/smoke pending.”** Passing the fixed offline gate plus the specified bounded live evidence establishes Phase 5 completion, not a multi-day experiment or proof of indefinite unattended operation.

Preparation changed only new tests/helpers and private planning documents. Nothing was staged or committed.
