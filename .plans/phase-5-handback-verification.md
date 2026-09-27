# Phase 5 handback — offline PASS; live smoke pending

**The frozen Phase 5 offline gate passes. Offline implementation verification is closed.** Full Phase 5 completion still requires the already-specified live compatibility probe and fresh-world managed smoke. No live evidence was submitted: the implementation report explicitly marks both unrun.

Verification used the fixed gate in `phase-5-tdd-verification.md`, not an expanded exploratory audit.

## Independently executed checks

Environment: Node **24.14.0**, **darwin/arm64**.

| Check | Independent result |
|---|---|
| Frozen acceptance/helper hashes | All 10 Phase 5 and 15 prior-gate hashes match |
| Phase 5 targeted suite, three consecutive runs | **159/159** each, 4 suites |
| Full `npm test` | **630/630**, 72 suites |
| Typecheck | Exit 0 |
| Lint | Exit 0 |
| Build | Exit 0 |
| Compiled CLI fake-config validation | Exit 0 |
| Packing measurement | Exit 0; byte-identical to frozen packing evidence |

All test runs have **zero failures, cancellations, skips and todos**. The full suite exceeds the frozen minimum of 627; the implementation adds three probe tests. No frozen test/helper was changed.

Commands used from `runtime/`, with Node 24.14.0 first on PATH:

```sh
# Run three times consecutively:
node --test --test-reporter=tap test/unit/phase5-*.acceptance.test.ts
npm run typecheck
npm run lint
npm test
npm run build
node dist/cli.js config validate test/fixtures/fake.config.json
npm run measure:packing
```

## Production-path verification

Bounded inspection confirmed actual production wiring:

- CLI start/resume use the managed lifecycle and the production mind factory.
- `src/mind/create.ts` selects `createAnthropicMind` for the Anthropic config variant, with the configured ALIFE_ credential name, explicit supplied environment or process environment, and injected transport or native fetch. OpenAI remains unavailable.
- The configured shared campaign is enforced by start/resume and the synthetic probe, with durable reservations before requests. It is not a separate cap silently initialized per run.
- The existing factory/run acceptance cases exercise the actual adapter over synthetic transport; the inspected production paths are not test-only facades.

The initial supported path remains Opus 5.5, adaptive/high, up to 128,000 generated tokens within the combined 1M context, explicit retained continuation and `drop_block`, standard uncached mode, no automatic retries or summaries. Passing offline fixtures does not establish account entitlement or live provider acceptance.

## Disclosures and qualifications

- `npm test` now uses `--test-concurrency=4`. This is accepted scheduling, not a reduced test inventory or skipped test. The independent full run passed all 630 cases, including the frozen Phase 4 process/lifecycle cases. No requirement in the frozen gate fixes the previous file concurrency.
- The single-file Phase 4 ESLint exception was **already accepted** in `phase-4-handback-verification.md`. The submitted report's “pending contract review” wording was stale; it is not a new blocker.
- The implementation report discloses durability batching and checkpoint version 5 with historical fake-run compatibility. The frozen gate passes with these changes. This handback does not extend that result into a fresh proof of every possible crash/storage failure.
- The report says no legacy expectations were changed. Hash identity was independently established for all 25 frozen files; no claim is made that every other historically untracked file has a separately retained pre-implementation byte inventory.
- The report's pricing verification, scratchpad config and proposed live run card are preparation, **not execution evidence**. No credentials, live entitlement, Docker state or paid billing receipts were inspected or validated here.

## Retained independent evidence

| File | SHA-256 |
|---|---|
| `/tmp/alife-phase5-handback-green-1.log` | `a3bd2675c1c28148d4865bd36fef01a9cd5cfc30f0d514ddcc9c51c737bd9590` |
| `/tmp/alife-phase5-handback-green-2.log` | `fec3d8c26e9c19aa3ef458c92d0c3f9e14d47f6d7342e2bf332e93ab65234bdc` |
| `/tmp/alife-phase5-handback-green-3.log` | `91331b7a655b2a3421ccbd805a33125f5c8f7fb8d703dd069adb28208443b9e0` |
| `/tmp/alife-phase5-handback-full.log` | `6d6af258c1f23915de923fb1d9315ed988f95ec48bb920bb7fc35966576f00e6` |
| `/tmp/alife-phase5-handback-typecheck.log` | `328ab720949fc12d752e2a0ccb4e539e7dac5fd8a76d3fdac0ca67e32f1d4477` |
| `/tmp/alife-phase5-handback-lint.log` | `76118f9f32920ed103f3b58ab62809b0b0701ffc6e8dc8323900c3724c0cc907` |
| `/tmp/alife-phase5-handback-build.log` | `ec70c986e753ca51887b719a8fb7770a4370c922224a7af616082f0bf17fa779` |
| `/tmp/alife-phase5-handback-config.log` | `6ee2b83fdab0fef73bc7a8c308fe7dc682d918e71bac028a46524ca97bf9a820` |
| `/tmp/alife-phase5-handback-packing.log` | `455fe54a424d512955a062d6e8160af5bc3089d1740d8a3173f3c55e33daa972` |

## Remaining milestone — unchanged live gate

1. Set up the configured controller-only credential and the one canonical shared campaign; review the exact run card and current pricing before spending.
2. Run the synthetic compatibility probe: at most **3 requests / 30 minutes / $20**.
3. With required per-command Docker/helper authorization, run the fresh synthetic-world managed smoke: at most **6 attempted calls / 60 minutes / $40**, including explicit stop/resume and retained artifacts/evidence.
4. Both consume the **same approved $100 total**, including conservative holds for unknown outcomes. Neither authorizes a multi-day experiment.

Until that evidence passes, the status is **“offline complete; live compatibility/smoke pending.”** No further offline review conditions remain under the frozen gate.

This verification made no production, configuration or test changes; it ran no Docker operation, privileged helper or provider request, and staged/committed nothing. Only verification/planning records were updated.
