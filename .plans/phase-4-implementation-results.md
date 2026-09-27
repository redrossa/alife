# Phase 4 — implementation results

**Status: Phase 4 COMPLETE within the documented support boundary.** Both gates passed: the offline gate, and the operator-authorized Docker gate (all 9 Phase 4 scenarios and all existing integration tests). Whole-engine restart and real host sleep remain separate, unrun platform qualifications. Contract: [phase-4-tdd-implementation-plan.md](phase-4-tdd-implementation-plan.md). Frozen tests: [phase-4-acceptance-manifest.json](phase-4-acceptance-manifest.json).

## Offline gate (Node 24.14.0, darwin/arm64)

| Check | Result |
| --- | --- |
| 13 Phase 4 acceptance/helper files and 2 Phase 3 files vs manifest hashes | all 15 match; none edited |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 (see "contract review" below) |
| `node --test test/unit/phase4-*.acceptance.test.ts` ×3 consecutive | 160/160 each; 0 fail, 0 cancelled, 0 skipped, 0 todo |
| `npm test` | 468/468 (463 frozen/legacy + 5 new implementation tests); 0 cancelled/skipped |
| `npm run build`; `node dist/cli.js config validate test/fixtures/fake.config.json` | exit 0; valid |
| `npm run measure:packing` | exit 0; output identical to the Phase 3 run and the verifier's log |

Also: `npm test` on Node 25.8.1 is 467/467 (run before the socket-path fix below). RED before implementation matched the handoff exactly (160 tests, 6 fixture controls pass, 154 fail). Logs are in the session scratchpad (`gate4/`).

## Docker gate (authorized by the operator)

- Environment: context `orbstack`, engine ID `ebf1ee81-aefd-482e-a2f4-80b1201cc57e`, Docker Engine 29.4.0.
- Images, pinned by ID and neither pulled nor built:
  - world `sha256:66889a5c7325015e107c3539f3eb8a4e60860ee059a4accf2b7edf98ad02ec78`;
  - helper `sha256:2d7f2318b85c5047b303ec47d3e442bc1aec0640bcd2badede47054ea38437a6`.
- Command: `npm run test:integration` with every opt-in, including `ALIFE_TEST_PHASE4_DOCKER=1`, run on Node 24.
- Result: **31/31, with no failures, cancellations or skips**. That is the 9 Phase 4 scenarios, 4 run tests, and 18 world tests; the whole run took 288 s.
- Evidence directories retained by the Phase 4 suite: `/tmp/p4-real-{3kX4gs,3qSxyk,3TcYEx,hXLMt4,JmlrtI,kqQq33,Mp2MJT,Q2asbu,wpUFNT}`.
- Afterwards, no labelled containers remained and no watchdog process was running. The only labelled volumes belong to `w-20260926T234338Z-8653a824`, which was created before this gate and left untouched.

The first Docker attempt failed one existing test, "detects a killed controller". Its state directory is under macOS's long temporary path, so `runs/<id>/control.sock` exceeded the Unix socket address limit, and the managed start refused, recorded as `world_start_failed` before anything started. The fix binds and connects a run-local socket whose absolute path is too long through a path relative to its directory. The working directory is changed and restored synchronously around the bind or connect call. A unit test covers it. After the fix, the offline gate was rerun (above) and then the whole Docker gate.

## What was built

- **Watchdog** (`operator/watchdog.ts`, `watchdog-child.ts`). `runWatchdog` is the one state machine, and the child process runs it too. Monotonic lease, original deadline, and wall/monotonic discontinuity detection. Unusable or out-of-sequence leases fail closed. Identity (engine ID, exact container ID, world and role labels) is re-verified before every mutation. A lost stop reply is resolved by inspection, not a blind retry. Retries are bounded. The journal is separate, bounded, and uses the event envelope. `startWatchdog` writes the lease first and spawns a detached child with an empty environment and no exec args. It resolves only after the child durably journals `watchdog.armed`; releases are verified.
- **Managed runs** (`operator/managed-run.ts`). `startManagedRun`, `resumeManagedRun`, `requestRunStop`, and `captureIntoRun`. The startup order is:
  1. control endpoint;
  2. bounded initial capture, copied and associated durably;
  3. container created;
  4. watchdog armed through the new `StartHooks.beforeContainerStart`;
  5. a synchronous final admission check;
  6. container start.

  Heartbeats run on real timers. The local lease is checked at every commitment point, and loss is lasting. A verified stop is followed by the release and then the final capture. An unverified stop keeps protection. The CLI `run start` and `run resume` use these entry points.
- **Resume** (`operator/run.ts`: `resumeRun`, `resumeEpisode`). Preflight under the run lock checks: an intact log whose latest execution is `stopped_clean`; publication by that execution's checkpoint and terminal records (orphans are never trusted); checkpoint hash, schema, run, and world; stored manifest, config, prompt, tools, and script hashes; watchdog evidence; attempted-call, spend, deadline, and clock limits; world identity; and the world-history fence. Only then are the world lock, the world, and the records touched. It restores the loop state and ledger and keeps the original deadline. The first observation uses `resume-discontinuity-v1`.
- **Evidence** (`records/finalize.ts`). `analyzeWatchdog` validates the journal: bindings per epoch, known epochs, run, world, and engine, sequence integrity, release proof, sticky expiry, and a supervised epoch without evidence. It is included in `RunAnalysis` and `pendingAcknowledgement`. Finalization accepts a clean-looking run whose watchdog evidence requires review.
- **Inspection and export** (`records/inspection.ts`, `records/export.ts`). Archive reads verify the manifest schema, file identity (no symlinks), size, hash, tar structure, and the index (re-derived with the production `TarReader`, which now records data offsets). Paths are byte-exact. Reads are bounded ranges; ambiguous names, links, and special entries are refused. Export writes a private, allowlisted copy with a hashed inventory. Damaged, missing, or bounded-out evidence makes it explicitly incomplete. Lock, lease, and control files and `.env` are excluded, and nothing is redacted.
- **CLI**: `run stop`, `run resume`, `run capture`, `run export`, `observe list`, and `observe read`; `run status` also reports watchdog evidence.

## Decisions within the delegated mechanics

- **Checkpoint schema 4** adds `worldFence`: the world log's sequence and a hash of its bytes at the checkpoint. After the fence, only nonmutating world events are allowed (attach, captures, stops or removals of stopped containers, detach). Schema 3 checkpoints still read, but cannot be resumed.
- **Resume and failures.**
  - New transitions `stopped_clean → completed | recovery_required` apply when a resumed epoch's start fails after creating a container.
  - A resume refused before anything was created leaves the run unchanged and resumable.
- **Record budget.**
  - Archive copies count against the run's limit.
  - The watchdog journal (64 KiB per epoch) and the supervision files (16 KiB) are reserved from the controller's share.
  - The initial capture gets half of what remains after one tick's reserve, and the final capture gets the rest.
  - An incomplete initial capture refuses the start.
- **Supervised deadline margin.** The watchdog enforces the deadline at its instant, so a supervised run starts a tick only while `requestTimeoutMs + actionWaitMs + 60 s` still fits. Otherwise it stops cleanly for its deadline; without this, every deadline-ended managed run would need review. This is documented in the `watchdog-v1` profile text.
- **Fewer full-flush syncs.**
  - **Why.** On macOS each `fsync` is `F_FULLFSYNC`, serialized system-wide. The frozen resume suite has a 15 s whole-suite timeout, and even in the verifier's RED run it took 14.1 s under `npm test`.
  - **What changed.** A durable flag was dropped only where the next durable record in the same log precedes any effect: `cost.reserved`, `model.responded` and `model.failed`, `cost.reconciled`, `action.*`, `tick.completed`, `operator.intervention`, `world.stopped` (run log), `checkpoint.written`, `run.started` and `run.resumed`, and the supervision notes. Also:
    - the initial run files are written and synced together;
    - the run's two locks share one directory sync, with lock contents still durable before their names;
    - lock release is not synced, since a lock that reappears only blocks;
    - `close()` skips a sync with nothing new;
    - the git source identity is read once per process;
    - boundaries flush the records before a host observes them.
  - **Result.** The resume suite runs in about 3.9 s alone, about 10.9 s in the Phase 4 command, and about 13.2 s under full `npm test`.
- `sourceIdentity` is memoized per process: edits made on disk after a process loaded its code do not change the code running.

## Contract review requested

`test/unit/phase4-resume.acceptance.test.ts:32` (`return candidate!;`) was written while `resumeRun` did not exist. Now that `run.ts` exports it, typescript-eslint reports the non-null assertion as unnecessary (`no-unnecessary-type-assertion`), and the file is hash-pinned. `eslint.config.js` has a documented override of that one rule for that one file. The verifier can instead remove the `!` and re-pin the hash; the override then goes.

## Superseded legacy expectation

`test/unit/cli.test.ts` expected `run resume` to be an unknown command. It now checks that each new run command still needs an exact run ID and its required flags.

## Remaining

- Separate platform qualifications, not run: whole-engine restart and real host sleep.
- Timing risk: the resume suite's 15 s budget has about 1.8 s of margin under full `npm test` on this machine.
