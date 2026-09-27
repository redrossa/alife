# Phase 4 — safety and operator inspection: TDD implementation contract

## Status and agreement

This is the Phase 4 implementation handoff, not an implementation or a claim that Phase 4 passes. Production code is not to be written before the delivered acceptance suite is run RED.

**The reviewer owns these acceptance tests. The tests and completion commands are the completion contract. Once the frozen gate below passes, Phase 4 is COMPLETE within the stated support boundary. There is no additional exploratory audit, new hidden test set, or moving completion criterion afterward.** Additional implementation tests may strengthen coverage but cannot replace or weaken the delivered suite.

Phase 3 remains closed. The new failing tests specify features which do not exist yet; they do not reopen Phase 3's findings.

The acceptance inventory, file hashes, actual RED counts, and verification evidence are recorded in `phase-4-acceptance-manifest.json` and `phase-4-tdd-verification.md`. Read those alongside this plan. The test-local interfaces are intentional forward contracts; missing implementation is reported as an assertion rather than solved with stubs or skips.

## 1. Deliverable and boundaries

An operator can:

1. Start a fake-model run protected by an independent watchdog before its world container starts.
2. Stop it from another CLI process using authenticated local control.
3. Inspect it and explicitly resume a genuinely clean stop with the same stored inputs, history, accounting, world lineage, and original deadline.
4. Lose or crash the controller and have the watchdog stop only its exact owned world, with truthful separate evidence.
5. Finalize an interrupted/review-required episode without replay, automatic recovery, or restoring resumability.
6. Capture initial/final/manual stopped-world archives, browse them without extraction, and export bounded private evidence.

No live provider, paid inference, hidden memory, automatic retry, process restoration, automatic crash resume, mounted image snapshots, automatic publication, or general-purpose artifact extraction is added.

### Support and test permissions

- **Mandatory offline gate:** runs without Docker or paid APIs. It includes actual independent Node processes and a local Unix-socket HTTP fake engine, not just mocked watchdog outcomes.
- **Mandatory supported-environment gate:** the explicitly authorized Phase 4 Docker acceptance suite, plus existing Docker integration, on the selected verified local environment. Its controllers/resources are disposable and exactly scoped. A skipped integration suite is NOT completion.
- **Separate platform qualifications:** restarting the whole engine/application and actually sleeping/restarting the host remain separately authorized operations. This handoff does not run them or claim they passed. Offline clock/engine-loss tests and scoped controller suspension cover the defined runtime reactions; they do not prove availability while the host or engine is unavailable. Machine-wide experiments are not an additional surprise condition after this gate.
- Docker must stay context/provider independent. OrbStack is the currently verified environment, not a required Docker-management brand.

The operator's previous engineering delegation covers the mechanics specified here. No new research-facing choice is delegated to a test author. Existing policy decisions in `phase-3-policy-decisions.md` override older prose in `first-runnable-system.md`.

## 2. Invariants, not scattered checks

### 2.1 Admission requires both world safety and a live execution lease

A managed execution session owns a monotonically closing admission condition. At every actual model-call, shell-start, or agent-signal commitment:

- the world epoch still admits that effect;
- there is no operator stop;
- the original deadline/budgets still permit it;
- the session's watchdog is ready, its local lease has not expired, and no heartbeat failure or unexpected watchdog completion has been latched.

The final guard has no await gap before transport commitment. Readiness obtained earlier is not a lifetime permission. Lease loss during response recording, action preparation, or a suspended controller's return must prevent later dispatch. A late heartbeat cannot revive an already expired lease.

World-stop evidence and run-session evidence are distinct. A physically clean stop does not erase missing supervisor/record evidence. Do not fabricate an uncertain model action merely to represent a watchdog failure.

### 2.2 Safety stop never depends on successful bookkeeping

The watchdog and controller must attempt their exact authorized physical stop even when their own journal/record write fails or its allowance is exhausted. Neither may certify what it could not verify.

Quiescence, signal evidence, sealed assessments, no replay, and accounting from Phase 3 remain in force. Do not replace them with a simpler Phase 4 path.

### 2.3 Resume is a new process epoch, not a fresh episode or crash recovery

Resume preserves the run ID, original inputs, original deadline, cumulative calls/costs, bounded history, and evictions. It creates fresh processes and a fresh guarded epoch. It neither replays prior shell commands nor restarts continuing jobs.

Any uncertainty, interrupted finalization, conflicting ownership, insufficient evidence, exhausted limit, suspicious clock history, or intervening world execution blocks resume before attach/start/model effects.

## 3. Concrete module/API contracts

Test-local interfaces intentionally describe missing APIs without adding production placeholders.

| Production location | Responsibility / forward API |
| --- | --- |
| `operator/run.ts` | Keep existing low-level `startRun`. Add `resumeRun(options)` using stored inputs and a verified checkpoint. `ResumeRunOptions = Omit<StartRunOptions, 'resolved' | 'worldId' | 'onCreated'> & {runId}`. These are lifecycle primitives used by isolated fixtures, not the supervised CLI entry points. |
| `operator/managed-run.ts` | `startManagedRun(options)` and `resumeManagedRun(options)` wrap the lifecycle with required watchdog readiness, local lease admission, control endpoint, automatic capture, and final evidence publication. Their default wiring is real production supervision. Add `requestRunStop({layout,runId,clock}) -> {accepted,reason}`. |
| `operator/watchdog.ts` | `runWatchdog(options)` is the actual independent state machine, dependency-injectable for deterministic unit tests. `startWatchdog(options)` launches a separate Node process and resolves only after durable readiness. |
| Watchdog child entry | Thin executable entry to the SAME `runWatchdog`, using a resolved local Docker socket and allowlisted environment; not a second algorithm. |
| `records/finalize.ts` | Combine controller and watchdog evidence without mixing their sequence spaces or rewriting either log. Extend status/finalization with explicit watchdog acknowledgement. |
| `records/inspection.ts` | `listArchive({directory,limits})`; `readArchiveFile({directory,pathBase64,offset,length,limits})`. Return bounded data/completeness, never extraction or execution. |
| `records/export.ts` | `exportRun({layout,runId,outputDirectory,maximumBytes,maximumFiles})` produces a private exact-evidence copy with a hashed inventory and explicit incompleteness. |
| Run capture coordinator / CLI | Add `run capture`, associate copied archive bytes/manifests with a run, and share the run record budget. Reuse existing stopped-world capture. |
| `operator/run-commands.ts`, `cli.ts` | Wire start/resume to managed wrappers; add stop/capture/export and observe list/read. Preserve strict argument validation, terminal escaping, JSON mode, and explicit privilege flags. |
| World startup seam | Permit an awaited before-container-start hook after Docker returns the exact newly created container ID but before `POST /containers/<id>/start`. After the hook, recheck admission synchronously. No agent or startup-probe exec occurs before required protection. |

Normal injection is acceptable; production branches based on test names, `NODE_ENV`, fixture paths, or fake-provider selection are not. In particular, a real Docker run with the fake mind still requires the watchdog. Existing frozen Phase 3 tests can continue using the low-level lifecycle API without inventing an external daemon for an in-memory world.

### 3.1 Watchdog binding and handle

A binding is immutable for one execution epoch:

```text
schemaVersion: 1
runId, worldId, epochId, controllerToken
engineId, containerId
deadline: original absolute UTC deadline
leaseMs
```

`runWatchdog` options also contain `leaseFile`, `journalFile`, `clock`, `engine` (`get`/`post` of the existing DockerEngine transport), `signal`, `pollIntervalMs`, and `maximumJournalBytes`.

Its result is:

```text
{ outcome: released | stopped | unknown | refused,
  verified: boolean, reason: string, containerId: string | null }
```

`startWatchdog` takes the same immutable binding/paths/bounds plus the resolved `DockerContext`. It returns:

```text
{ pid, heartbeat(): Promise<void>,
  completed: Promise<WatchdogResult>,
  release(): Promise<WatchdogResult> }
```

The launcher initializes its own private lease before waiting for readiness; subsequent renewals use the returned production `heartbeat()` method. The returned PID is the actual distinct child, not the controller PID. The child must survive controller death and must exit after its own final result. `release()` is not permission to abandon a live container.

### 3.2 Lease and private descriptors

Atomically replace a private lease file containing:

```text
{schemaVersion:1, runId, worldId, epochId, controllerToken,
 sequence, issuedAt, expiresAt, state: active | released}
```

- Increasing sequence and plausible timestamps can renew a still-live lease only within its declared bound.
- Same/older sequence, wrong binding, future-issued or unbounded expiry cannot extend authority.
- The original deadline is in the pinned binding; a heartbeat cannot change it.
- A previously active but expired lease is closed permanently.
- An active lease protects a newly created, not-yet-started container; do not exit just because its initial `Running` is false.
- A matching released lease is accepted only after independent stopped/absent verification.

A private run-local `watchdog.json` records schema 1 `{pid,binding,leaseFile,journalFile,heartbeatIntervalMs}`. For the CLI path, files are `lease.json` and `watchdog.jsonl` in the run directory. This is operator metadata, not model input or publication content.

The local stop endpoint uses a private run-local `control.json`:

```text
{schemaVersion:1,runId,epochId,controllerToken,socketPath}
```

A one-request Unix-socket connection sends one bounded JSON line containing `schemaVersion:1`, `command:'stop'`, and the bound run/epoch/token. The acknowledgement is `{accepted,reason}`. Authenticate against current ownership; refuse outside-run socket paths, stale tokens, wrong run IDs, missing/malformed descriptors. Do not blindly signal a PID. Lost acknowledgement is reported as unknown/unacknowledged and is not retried automatically. Record the accepted operator intervention in the controller ledger.

## 4. Resume implementation

### 4.1 Preflight before mutation

Acquire exclusive run and world ownership with existing token-safe locks. Validate:

1. The latest execution ended `stopped_clean`, not merely that some checkpoint exists.
2. A durable checkpoint reference AND matching terminal record publish that checkpoint. Never scan the directory and bless an orphan file.
3. Checkpoint hash/schema/run/world/config identity, full event-log integrity, stored manifest/config/prompt/tools/script hashes, and required supervisor evidence all agree.
4. No outstanding/uncertain world actions or unaccounted required evidence. Conservative unknown model usage remains charged; it is not free budget.
5. Remaining attempted calls, deadline, spending, record capacity, and host capacity allow another step. Refuse before effects if not.
6. Clock evidence is plausible. Within one process use monotonic duration; do not compare monotonic origins across processes. UTC moving backward relative to the checkpoint is not extra time.
7. Engine/storage/image identity matches, and no tracked intervening execution has used that world since the checkpoint. Merely matching a UUID is insufficient after another episode ran.

Use a world-history generation/fence recorded with the checkpoint. Allow provably nonmutating inspect/capture history; refuse intervening starts or unclassifiable/missing lifecycle evidence. This does not claim to detect arbitrary manual state-file or Docker tampering by the trusted host operator.

On refusal, preserve prior receipts, locks belonging to others, controller logs, and world history. No forced resume, configuration override, automatic repair, or replay.

### 4.2 Restore the bounded kernel only

Reconstruct configuration and fake script from verified run-owned copies, not the original mutable source paths. Restore the ledger, attempted/responded counters, complete retained exchanges, eviction total, protocol streak, and original deadline. Never restore evicted observer history into model context.

The next request uses the next attempted tick/unique request identity, including after a known failed call. Resume does not refund a lost response or rewind the fake script to repeat it. The fake adapter's explicit script remains the only response source before Phase 5.

Create a new process/epoch. Old receipts/checkpoints stay immutable. Repeated clean resumes continue the same event stream and accounting; only one concurrent caller may admit execution.

### 4.3 Perception on resume

The first resumed request has fresh sensors and a neutral discontinuity observation:

- execution resumed and processes were restarted;
- previously running jobs do not still exist in this new process epoch;
- pre-stop exchanges remain historical, not current process status.

Do not repeat an old “still running; it was not stopped” sentence as the current outcome. Preserve its original tool result in historical context instead. No automatic `ls`, directory listing, summaries, retrieval, memory hints, redirection advice, or recovery coaching. Do not alter the baseline instructions/tools.

Name the added intervention observation with a new immutable profile, e.g. `resume-discontinuity-v1`, and record it explicitly in the resumed-session metadata. Do not silently edit an existing sensor/body profile. Keep historical formats readable; if a new checkpoint/manifest schema is necessary, validate legacy clean evidence explicitly rather than silently rewriting it. The low-level resume tests intentionally start from valid Phase 3 records. New managed epochs require new supervision proof before starting.

## 5. Managed session implementation

### 5.1 Startup ordering

```text
validate stored/config inputs and ownership
→ allocate private run/session records and control endpoint
→ bounded initial stopped-world capture and durable run association
→ create world container, obtain its exact ID (not yet started)
→ pin supervisor binding and launch independent watchdog
→ await durable watchdog.armed/readiness
→ final synchronous stop/deadline/lease/world-admission check
→ start container and perform existing startup verification
→ normal serial ticks with continuing lease maintenance
```

Failed capture or failed arming must not admit the world/model. Cleanup may stop/remove an unstarted disposable container but never destroy persistent backing data implicitly.

### 5.2 During execution

Heartbeats are independent of cognitive ticks and bounded shell waits. A slow or held model invocation must not suppress them. Watch both heartbeat failure and unexpected `completed` settlement. The controller also checks its own lease immediately at effect admission, so waking before its watchdog cannot issue a command on an expired lease.

Close admission monotonically on loss. Preserve known counts and reservations, stop physically, and classify the run for review. A later successful heartbeat/result does not erase the loss.

### 5.3 Normal stopping and failure

```text
close admission / acknowledge operator stop
→ existing submission/signal/evidence shutdown protocol
→ verify physical world stop and settle required world evidence
→ release/join watchdog only when it no longer protects live execution
→ bounded final capture, explicit complete/incomplete/failure record
→ persist checkpoint only if all resume evidence is eligible
→ durable checkpoint reference and terminal run record
→ release control endpoint/ownership
```

Final capture failure does not invent an uncertain agent action or block physical stop. Record it explicitly; missing required terminal evidence still blocks a clean checkpoint. Incomplete artifacts must never be advertised as complete.

If physical stop is unverified, do not release the independent guardian. Keep review-required status and retained evidence. A guardian unable to reach the engine cannot guarantee a stop; it records uncertainty, retries at a bounded rate, and stops the exact verified resource when control returns.

## 6. Watchdog safety and evidence

Before any mutation, revalidate the selected engine ID and exact container ID/world/role labels. Do not cache identity indefinitely across a wait/reconnect. A replacement engine/container or changed labels are refusal, not permission to act on a name match. Never prune, destroy volumes, kill unrelated containers, or replay execs.

Detect expired leases, the original deadline, and suspicious wall/monotonic discontinuities. A fresh-looking heartbeat received after local expiry cannot revive authority. Retry unavailable inspections/stops at a bounded rate; independently inspect after a successful or lost stop response. HTTP success is not proof that a process stopped.

The watchdog has no model credential or arbitrary parent environment. Strip provider credentials, unrelated secrets, `NODE_OPTIONS`, and loader/preload injection. Pass only the explicit transport/runtime necessities. Its output/journal is bounded and terminal-safe.

### Separate journal contract

Use the existing JSONL envelope (`v`, `seq`, `runId`, `session`, `type`, `time`, `monotonicMs`, `data`), never controller sequence numbers.

- `watchdog.armed`: `data.binding` and actual `data.watchdogPid`.
- `watchdog.expired`: binding, reason, and explicit known/unknown stop verification as applicable. Expiry is a lasting intervention even if stopping later succeeds.
- `watchdog.stop_verified`: binding, `verified:true`, reason, after independent inspection. Add this event type to the watchdog stream; it is not a controller event.
- `watchdog.released`: binding, `verified:true`, reason, only after independent safe-release verification.
- Additional bounded diagnostic events are permitted; never use them to erase expiry or missing evidence.

`run.created.data.supervision = 'watchdog-v1'` declares managed evidence requirements. Absence on a historical core-only run must not fabricate a historical watchdog. Absence/malformed evidence on a declared managed run is insufficient proof.

Extend `analyzeRun().watchdog` with `{state,reviewRequired,lastSequence,stopVerified,issues}`. States are `absent`, `armed`, `released`, `expired`, `unknown`. Validate run/epoch/engine/container binding and stream integrity; a foreign release cannot certify this epoch. Multiple legitimate clean epochs have distinct bindings. An expiry remains review-required even if followed by release. Analysis must not rewrite either stream.

This summary is not, by itself, resume certification: checkpoint publication, world history, and all other preflight checks still apply. Finalization and `pendingAcknowledgement` include the watchdog evidence explicitly, alongside unknown actions/requests/reservations. A clean-looking controller terminal record cannot hide contradictory guardian evidence. Finalization never makes an interrupted/review-required run resumable.

## 7. Capture, inspection, and export

### 7.1 Run association and budgets

Reuse existing clean stopped-world capture, identity checks, no-journal-recovery mounts, and bounded tar implementation. Capture initial state before first execution, capture final state after verified stop, and identify capture phases/epochs. Resume captures are distinct from the original seeded-world provenance; do not silently reseed or restore.

`run capture <run-id> --label <label> [--allow-privileged-helper]` captures only a stopped world. It never stops a live world implicitly. It acquires run/world ownership and verifies the run/world relation. Copy the bounded archive and manifest into `runs/<id>/archives/<archive-id>/` and append a durable association with phase, archive ID, completeness, and omissions.

Only associated artifacts belong to an export—not every archive from every episode sharing the world. The original world capture remains unchanged. All run-owned copies, manifests, controller records, and reserved watchdog/control evidence must fit declared observer-store bounds. Partition/reserve the independent journal allowance before execution; do not race two independent writers on a single unreserved byte counter. Bound capture/copy before allocating or writing excess bytes.

Initial capture failure refuses first execution. Bounded incompleteness is always explicit. Final capture failure is preserved as `archive.failed`; it cannot prevent verified stopping or masquerade as a complete artifact. An incomplete archive alone is not uncertainty about an agent action.

### 7.2 Read-only inspection API

Limits: `{maximumArchiveBytes,maximumEntries,maximumReadBytes}`.

- Listing returns `{entries,complete,omissions}` using the existing `ArchiveEntryRecord` representation.
- Reading returns `{data:Uint8Array,totalBytes,offset,truncated,complete,omissions}`.
- `pathBase64` is byte-exact; invalid UTF-8 and filename BOMs must not alias another name.
- `truncated` describes the requested window, separately from capture `complete`.
- Check manifest/archive byte length and hashes, tar structure, index paths/counts/content hashes, and actual regular files. Do not trust a fabricated index over inconsistent bytes.
- Reject ambiguous duplicate-name reads, links/special files, unsafe integer arithmetic, malformed base64, over-limit operations, and symlinked host source files.
- Hostile archive names are data, not paths to extract or shell arguments to execute. No recursive extraction or link following.

CLI `observe list/read` operates on the run-associated archive, uses bounded reads, and escapes terminal controls. `observe read <run-id> --archive <archive-id> <path> --offset <n> --length <n> --json` returns `dataBase64`, `offset`, `totalBytes`, `truncated`, `complete`, and `omissions` (additional identity fields are permitted). JSON mode is byte-exact, including binary file content. It never starts or mounts the source world.

### 7.3 Private export

`exportRun` writes a fresh destination, private directories (0700), private regular files (0600), and `export-manifest.json` with the complete emitted inventory `{path,bytes,sha256}`, completeness, and omissions. Record files are under `run/`; associated artifacts under `archives/`.

Allowlist evidence paths. Exclude operational control descriptors, lease authority files, ownership locks, arbitrary extra files, and `.env`; do not collect environment secrets. Preserve watchdog evidence verbatim, including its historical binding fields. This is not a claim that raw evidence contains no sensitive values: recorded commands/content and historical binding identifiers remain in the private copy. Do not silently redact them. This is a private exact-evidence export, not publication approval, transferable control metadata, or an automatic secret scrubber.

Refuse existing destinations, output inside the source/repository, symlink traversal, or actively owned runs. Preserve damaged/interrupted evidence verbatim with explicit incompleteness, including finalization and watchdog records. Missing referenced blobs or incomplete archives cannot yield `complete:true`. Byte/file caps include the export manifest and any retained partial output. Never mutate source records, run the model, or replay actions.

## 8. Acceptance coverage and deterministic crash hooks

Delivered offline suites:

- `phase4-resume.acceptance.test.ts`: cumulative continuation, stored-input integrity, unchanged source independence, no replay, budgets/clocks, state/checkpoint refusal, ownership/concurrency, fresh neutral perception, eviction and failed-call accounting.
- `phase4-watchdog.acceptance.test.ts`: deterministic leases, deadlines, stale/future/corrupt heartbeats, initial unstarted container, late renewal, startup and post-arming identity changes, independent verification, transport failure/recovery, time discontinuities, bounded journals and failure-rate behavior.
- `phase4-watchdog-process.acceptance.test.ts`: actual child readiness, separate PID, renewal beyond a lease, controller SIGKILL/SIGSTOP, absolute deadline, actual environment isolation, and guardian process exit, over a local fake engine socket.
- `phase4-managed.acceptance.test.ts`: actual backend startup commitment behind readiness, capture association/order/bounds, startup stop/expiry races, watchdog/heartbeat loss during held cognition/preparation, controller-first wake after local expiry, stop/release ownership and fail-safe capture.
- `phase4-control.acceptance.test.ts`: real active run/ownership and Unix-socket control fixture; authenticated request, malformed/stale authority, lost acknowledgement/no retry, CLI stop and command discoverability.
- `phase4-evidence.acceptance.test.ts`: independent watchdog sequence/binding evidence, managed versus historical requirements, corruption, sticky intervention, and explicit finalization acknowledgement.
- `phase4-artifacts.acceptance.test.ts`: byte-exact hostile archive handling, bounded reads, truthful incompleteness, source immutability, private bounded exports, source/output containment, allowlisting, damaged records, and associated-only artifacts.

Fixture-only positive controls validate the real run-store, archive/blob, backend, local control, clock/engine, and socket scaffolding even before Phase 4 APIs exist. A missing API assertion must occur outside `assert.rejects` or result-error fallbacks. Catch an operation's rejection, not the subsequent assertions about its result.

### Authorized real Docker suite

`test/integration/phase4.acceptance.test.ts` exercises normal CLI start/stop/resume, persistent file/SQLite state, capture/observe/export, intervening-run world fencing, and controlled crashes.

The managed wrapper exposes optional host-side `onBoundary(name,{runId,worldId})` instrumentation. Thread this through production lifecycle code; do not use an environment-dependent fake implementation. The callback is awaited only at the declared point. Default production behavior has no callback.

| Boundary | Exact placement |
| --- | --- |
| `after_model_requested` | Request durable, before invocation. |
| `after_model_responded` | Response durable, before later action commitment. |
| `after_action_prepared` | Required preparation durable, before shell transport commitment. |
| `after_action_commit` | Transport committed; outcome may still be unrecorded. |
| `after_world_stop` | Physical stop verified, before checkpoint publication. |
| `after_checkpoint_file` | Checkpoint file durable, before checkpoint-reference/terminal publication. |
| `after_terminal_record` | All clean-stop proof and watchdog release durable, terminal record durable, before controller exit. |

The fixture reports an exact reached boundary through IPC, then blocks. The parent SIGKILLs only that owned controller. It does not infer a crash point from polling a log that might already be stale.

For the first six boundaries, demand independent exact-world stop, unchanged controller evidence, no replay, resume refusal, and explicit finalization. After an already durable clean terminal record, explicit supervised resume is permitted; automatic resume still is not. Do not describe a crash after completed clean finalization as if it necessarily invalidated earlier durable truth.

Integration cleanup never prunes globally or releases an unrelated/live owner. It retains state/evidence, and preserves backing data on uncertain cleanup. It destroys only successfully verified disposable test resources.

## 9. Implementation sequence — RED → minimal implementation → GREEN

1. Run the delivered offline tests unchanged. Confirm the documented missing-feature/behavior assertion baseline and passing fixture controls. Check the frozen Phase 3 hashes.
2. Implement record/schema readers, immutable stored-input reconstruction, resume preflight and bounded kernel restoration. Make the resume suite green before broad CLI wiring.
3. Implement deterministic watchdog state machine and bounded journal. Make its positive and negative tests green; then wire the independent child and pass actual process tests.
4. Implement managed startup hooks, session admission, ownership-bound control endpoint, heartbeat/release protocol, and checkpoint/terminal ordering. Connect CLI start/resume only through managed entry points.
5. Integrate watchdog analysis/finalization. Do not let a healthy-looking controller log erase independent contradictory evidence.
6. Implement run-associated capture/budgeting, read-only inspection, and private export. Keep privilege checks at existing explicit boundaries.
7. Wire/verify CLI arguments and human/JSON output, then run all offline acceptance and legacy tests.
8. With explicit operator authorization, run the scoped real Docker acceptance and existing integration. Preserve evidence locations and failures. Fix the implementation, not the contract.
9. Update runtime README/status documentation for implemented commands and limitations. Do not publish placeholder website docs or claim live-model execution.

No new dependencies are required by the tests. If implementation adds any, use npm and keep lockfiles synchronized. Do not commit or provision based on this plan alone.

## 10. Frozen completion gate

Use Node 24. From `runtime/`:

```sh
npm run typecheck
npm run lint
node --test test/unit/phase4-*.acceptance.test.ts
npm test
npm run build
node dist/cli.js config validate test/fixtures/fake.config.json
npm run measure:packing
```

Run the targeted Phase 4 command three consecutive times with zero failures, skips, cancellations, or todos. The full unit suite must also pass, including the 303 Phase 3 tests and the unchanged 52-test final lifecycle gate. Additional tests may increase counts; removing or weakening the frozen tests is not a fix.

Then, only with explicit disposable-resource/privileged-helper authorization and built pinned images:

```sh
ALIFE_TEST_DOCKER_CONTEXT=<verified-local-context> \
ALIFE_TEST_WORLD_IMAGE=sha256:<world-image-id> \
ALIFE_TEST_HELPER_IMAGE=sha256:<helper-image-id> \
ALIFE_TEST_ALLOW_PRIVILEGED_HELPER=1 \
ALIFE_TEST_PHASE4_DOCKER=1 \
npm run test:integration
```

Both existing integration and all nine Phase 4 cases must execute and pass with zero skips/cancellations. Record context/engine/image identities and retained evidence directories. These variables are explicit opt-in, not permission inferred from installed Docker or from prior demo runs.

Verify every acceptance/helper file against `phase-4-acceptance-manifest.json`. Source entry points must be real implementations used by CLI, not test-only facades. No test-environment bypass, stub, disabled watchdog, blanket no-resume behavior, swallowed assertion, or fake success receipt is acceptable.

**When these gates pass, mark Phase 4 COMPLETE.** No additional open-ended review is required. If Docker authorization is not granted, report **offline gate passed; Phase 4 integration pending**, not full completion. Clearly retain the separate unverified machine-wide disruption qualifications rather than inventing new gates after implementation.
