# Phase 4 TDD acceptance — frozen RED baseline

**Handback closure: Phase 4 PASS.** See [phase-4-handback-verification.md](phase-4-handback-verification.md) for the independently rerun offline gate and verified retained Docker evidence. The RED baseline below is preserved as historical TDD evidence.

**Status at preparation: TDD preparation complete; Phase 4 implementation not started by this handoff.**

Frozen on 2026-09-27 UTC, Node **24.14.0**, **darwin/arm64**. Implementation contract: [phase-4-tdd-implementation-plan.md](phase-4-tdd-implementation-plan.md). Exact acceptance/helper hashes: [phase-4-acceptance-manifest.json](phase-4-acceptance-manifest.json).

## Verified baseline

The targeted command was run three consecutive times:

```sh
cd runtime
node --test test/unit/phase4-*.acceptance.test.ts
```

Each run produced **160 tests in 8 suites: 154 expected failures, 6 passing fixture controls, zero skips/cancellations**. All 154 failures are `ERR_ASSERTION` and were checked by message, not just exit code: missing Phase 4 APIs, missing watchdog analysis, or missing CLI command documentation. No failed fixture preconditions remain in this baseline. These are intentional RED results, not a green implementation claim.

| Acceptance file (`runtime/test/unit/`) | Tests | Fixture controls passing | Expected RED |
| --- | ---: | ---: | ---: |
| `phase4-resume.acceptance.test.ts` | 31 | 0 | 31 |
| `phase4-watchdog.acceptance.test.ts` | 36 | 1 | 35 |
| `phase4-watchdog-process.acceptance.test.ts` | 5 | 1 | 4 |
| `phase4-managed.acceptance.test.ts` | 23 | 1 | 22 |
| `phase4-control.acceptance.test.ts` | 10 | 1 | 9 |
| `phase4-evidence.acceptance.test.ts` | 16 | 1 | 15 |
| `phase4-artifacts.acceptance.test.ts` | 39 | 1 | 38 |
| **Total** | **160** | **6** | **154** |

Resume cases construct and validate actual clean-stop records before the missing-API assertion; they are not fabricated checkpoint-only fixtures. Additional positive controls exercise the isolated watchdog clock/transport, real local HTTP engine socket, actual backend startup/stop, real run ownership/control socket, independent journal, and real run/archive/blob fixtures.

`npm test` produced **463 tests in 64 suites: 309 passed, 154 expected failures, zero skips/cancellations**. All **303 preexisting tests passed**. Every failure belongs to the delivered Phase 4 files.

Other checks passed:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `node dist/cli.js config validate test/fixtures/fake.config.json`
- `npm run measure:packing`

The two frozen Phase 3 acceptance hashes still match the prior agreed gate:

```text
308a21ddd24928137036e05dcc616049152a416dbafa6e121a1f787e343545d1  runtime/test/unit/signal-shutdown.acceptance.test.ts
9a31ffb70787a73d76e215520182c783bd454cc916bad454c25fed4693b9f709  runtime/test/unit/epoch-restart.acceptance.test.ts
```

## Evidence files

Logs remain outside the repository:

| File | SHA-256 |
| --- | --- |
| `/tmp/alife-phase4-frozen-red-1.log` | `c388e47d67a96d5c230fd32b0c71e9de342407b797c6c832463c443dfc8bb270` |
| `/tmp/alife-phase4-frozen-red-2.log` | `e1436c206fc2a1fd90650469349bc2a3253bcf9f936cb32a8e0183e06f3b7b9b` |
| `/tmp/alife-phase4-frozen-red-3.log` | `9baf2db4891e24f983d726b42cb2083157ababa16faf2fd4f5479041bd9932eb` |
| `/tmp/alife-phase4-frozen-full-red.log` | `ca5e0a27309d0a3e265eb03c13ed992eb945a565fe28cc530f1927c219cec57a` |
| `/tmp/alife-phase4-packing.log` | `455fe54a424d512955a062d6e8160af5bc3089d1740d8a3173f3c55e33daa972` |

Earlier `acceptance-red` and `final-red` logs were authoring drafts, not the frozen baseline. Review and execution exposed fixture issues (including control/evidence cadence cancellation, macOS socket path length, swallowed callback assertions, and incomplete cleanup). Those were corrected before this freeze. The final message-by-message check confirms that evidence tests now reach the intended absent-watchdog-analysis assertion instead of failing to create a clean fixture.

## Docker tests: written, not executed

`runtime/test/integration/phase4.acceptance.test.ts` contains **nine** permission-gated scenarios:

1. Managed CLI start → authenticated stop → supervised explicit resume, persistent file/SQLite state, initial/final/manual capture, inspection and private export.
2. Refuse resume of clean run A after tracked run B executes in the same world, despite unchanged engine/storage/image identity.
3–8. Exact-boundary controller SIGKILL after model request, model response, action preparation, action commitment, verified world stop, and checkpoint file write. Require independent exact-world stop, no replay, resume refusal, and explicit uncertainty finalization.
9. SIGKILL after fully durable clean terminal/release evidence: no automatic continuation, but explicit supervised resume remains possible.

They require all existing Docker integration opt-ins **plus** `ALIFE_TEST_PHASE4_DOCKER=1`. No Docker test, privileged helper, engine restart, host sleep, image build/pull, or paid inference was run during this preparation. The real-process offline fixture talks only to its local fake engine socket.

The nine Docker cases have not been behaviorally validated against a real engine yet. Typecheck/lint validate their source, not their integration outcome. Do not describe them as passed or count skipped cases as qualification.

## Handback gate — fixed, not open-ended

The implementer must:

1. Preserve all 13 hashed acceptance/helper files and both frozen Phase 3 tests. Genuine test defects require explicit contract review, not silent weakening to obtain green.
2. Pass all **160** Phase 4 offline tests **three consecutive times**, with no skips, cancellations, todos, or stubbed APIs.
3. Pass the full unit suite (**at least 463 tests**) and the listed typecheck/lint/build/config/packing commands.
4. With explicit authorization, pass all **nine Phase 4 Docker cases and all existing integration tests**, with no skips/cancellations, and report environment/image identities and evidence paths.
5. Use actual production wiring for the tested entry points and CLI. No test-only facades or environment-dependent safety bypasses.

**Passing this gate establishes Phase 4 completion within the documented support boundary. No fresh exploratory audit or expanding checklist follows.** If only the offline gate is completed, report “offline complete; authorized Docker integration pending.” Actual whole-engine restart and host sleep remain separately authorized, unverified platform qualifications—not hidden extra gates.

Preparation changed tests/helpers and private planning documents only. It did not change production source, runtime configuration, or the frozen Phase 3 tests; nothing was staged or committed.
