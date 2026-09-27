# Alife runtime

The experiment runtime: a harness that connects one mind (a model) to one
persistent Docker world through a body of declared sensors and actions. See
the [architecture](<../docs/(introduction)/architecture.mdx>) for the concepts.

**Status: early development.** This package validates configuration, runs a
Docker world backend (bounded persistent storage, verified world startup,
continuing jobs, sensors, stopped-world archives), and runs episodes with a
durable tick loop, supervised by an independent watchdog. Runs can be stopped
from another process, resumed after a clean stop, captured, inspected, and
exported. The mind is either a **scripted fake mind** or **Anthropic Claude
Opus 5.5** through the Messages API, with every paid call admitted against a
durable shared spending campaign. The Anthropic adapter is verified offline,
against synthetic streams. Its live compatibility smoke has not been run yet.
An OpenAI adapter does not exist.

## Requirements

- Node.js 24 or newer.
- For world commands and integration tests: a local Docker context. Only
  OrbStack has been verified (see the support matrix below).
- No model credentials are needed for the fake mind, the offline tests, or any
  command other than a live Anthropic run (see "Live minds" below).

## Development

Run from `runtime/`:

```sh
npm ci
npm run typecheck
npm run lint
npm test          # offline unit tests; run directly from TypeScript sources
npm run build     # compiles src/ to dist/ for the CLI
```

From the repository root, use `npm --prefix runtime <command>` instead.

`npm test` runs at most four test files at a time. Many tests write durable
records, and on macOS every fsync flushes the whole drive. With more files at
once, suites that carry a whole-suite time limit time out waiting for flushes
from other files.

## CLI

Build first, then:

```sh
npm run alife -- config validate test/fixtures/fake.config.json
npm run alife -- config validate --json configs/baseline.example.json
npm run alife -- doctor --docker-context orbstack
npm run alife -- version
```

Relative paths resolve from the directory you ran npm in. Use the `alife`
npm script, not `npx alife`, which could resolve an unrelated package.

`configs/baseline.example.json` deliberately fails validation until its image,
model, and pricing placeholders are filled in. A valid OpenAI configuration
still reports that paid execution is blocked, since the adapter does not
exist. `configs/anthropic-smoke.example.json` describes the Phase 5 smoke run.
It also fails until its images, pricing reference, and campaign directory are
filled in, and it stays blocked until `mind.costBound.verifiedOn` records when
the rates were checked.

## Configuration

Configuration is strict, versioned JSON (`schemaVersion: 2`). Unknown fields,
missing bounds, unsafe settings, and unresolved `REPLACE_WITH_` placeholders
are errors. Nothing is defaulted. Referenced files (`body.prompt` and, for the
fake mind, `mind.script`) resolve relative to the configuration file and are
hashed. Each named profile (`world.container`, `world.storage.profile`,
`world.ipc`, `body.jobPolicy`, `body.sensors`, and so on) stands for fixed,
versioned behavior described in `src/config/profiles.ts`.

Schema 2 replaced action timeouts with bounded waiting: `body.actionWaitMs` is
how long one tick waits for a shell action, not how long the action may run.
A command still running when the wait ends keeps running as a job; later
observations report it (`continuing-jobs-v4`). `body.maximumConcurrentJobs`
and `body.retainedFinishedJobs` bound the jobs the harness tracks. Schema 1
configurations are rejected.

The job and output bounds in the example and test configurations are
engineering values, not frozen pilot settings.

## Live minds

`mind.provider: "anthropic"` selects the `anthropic-messages-v1` adapter:

- **One call:** one streaming HTTPS request to `https://api.anthropic.com/v1/messages`
  per model call, with no retries at any layer and no provider conversation state.
- **Model:** only `claude-opus-5-5`. Its context is 1,000,000 tokens, and
  `maximumOutputTokens` may be at most 128,000, reasoning included.
  `reasoningEffort` is `high`, sent as `output_config.effort`. Thinking is
  adaptive, with the thinking-binding beta's `drop_block` policy.
- **No extras:** no caching, server tools, service modifiers, or forced tool
  choice.
- **Required profiles:** `body.tokenEstimator: "anthropic-wire-bound-v1"` and
  `body.contextPolicy: "recent-complete-exchanges-v3"`.
- **Pricing:** the adapter prices only the standard, uncached mode.
  `mind.costBound` must hold verified rates at or above the published standard
  ones ($4 in and $20 out per million tokens), with the date they were checked.
- **Reported cache or server-tool charges:** the call's usage is treated as
  unknown, and its whole reservation is kept.

The credential is read only from the `ALIFE_`-prefixed variable named in
`mind.credentialEnv`, which must be set in the controller's environment when
the run starts. It is sent only in the request's `x-api-key` header. It is
never written to configuration, records, checkpoints, exports, or errors, and
never passed to the world, the storage helper, or the watchdog. `.env` files
are never read.

Each reply keeps its complete provider content: signed or redacted reasoning,
text, and tool calls. This is its continuation (`anthropic-thinking-v1`). It
is sent back unchanged while its exchange is retained and evicted with it. It
is never kept anywhere else or restored. When a changed prefix invalidates
retained reasoning, the provider may drop it. It reports that as input
transformations, which are recorded in `model.responded` and never shown to
the mind. Continuations and their signed reasoning are sensitive research
data. They are stored in the run's records and included, unredacted, in
private exports.

### The shared spending campaign

Every paid call is admitted twice: against the run's own limit
(`operator.maximumEstimatedCostUsd`) and against one shared campaign.
`operator.campaignDirectory` names that campaign, and every Phase 5 run and
probe must use the same directory. A request's full maximum cost is held
durably in the campaign before the request is recorded or sent. The maximum
is its estimated input at the input rate plus its whole output allowance at
the output rate, in integer micro-dollars rounded up.

- **Settlement:** reported usage settles the reservation exactly. An unknown
  outcome keeps the whole reservation, and only certainty that nothing was
  sent releases it.
- **Over-bound charges:** a charge above its reservation requires review and
  stops all further admission.
- **Ownership:** a run holds the campaign exclusively from before its world is
  touched until it ends. Paid runs are therefore serialized.
- **Refusal:** a run refuses before touching the world if the campaign is
  missing, damaged, owned by another process, under review, or spent.

```sh
npm run alife -- campaign create --directory /absolute/path/to/campaign --limit-usd 100
npm run alife -- campaign status --directory /absolute/path/to/campaign [--json]
```

`campaign create` makes the campaign `phase5-smoke-v1` once, with a limit of
at most $100. It never resets, replaces, or raises an existing campaign.
`campaign status` is read-only and never creates one. The directory is
private (mode 700). All its files together are bounded to 16 MiB, always
keeping room to settle what is outstanding.

```text
metadata.json   immutable: schemaVersion 1, campaignId, limitMicroUsd, maximumBytes, createdAt
journal.jsonl   append-only, contiguous seq:
                {"seq","type":"reserve","runId","requestId","maximumMicroUsd","at"}
                {"seq","type":"settle","runId","requestId","basis":"usage"|"unknown"|"not_processed","chargedMicroUsd","at"}
owner.lock      present while a process owns the campaign
```

A crashed owner leaves `owner.lock` and its reservations behind. Nothing
removes the lock automatically or refunds a reservation. Review the journal,
make sure no owner is running, and only then remove the lock. Missing or
damaged evidence is never read as zero spending.

## Worlds

A world is a persistent filesystem lineage with its own ID, metadata, and
event log under the state directory. Storage profile `loop-ext4-volume-v1`
keeps a fixed-size ext4 image inside a Docker volume, attaches it to a loop
device, and mounts it at `/world` in an unprivileged, network-less,
read-only-root container.

### Images

Worlds use two local images, which configurations pin by ID. They are never
pulled implicitly:

```sh
docker --context orbstack build -t alife-world:dev world/image
docker --context orbstack build -t alife-helper:dev world/helper
docker --context orbstack image inspect alife-world:dev --format '{{.Id}}'
```

Put the printed IDs in `world.image` and `world.storage.helperImage`. The
world image contains `/bin/sh`, core utilities, Python, SQLite, procps, and
tini; its package inventory is at `/usr/share/alife/inventory.tsv`. Rebuilding
can produce a different ID, which is a different world environment.

### Lifecycle

```sh
npm run alife -- world create --config <file> --docker-context orbstack
npm run alife -- world inspect <world-id>
npm run alife -- world attach <world-id> --allow-privileged-helper
npm run alife -- world capture <world-id> --label initial
npm run alife -- world stop <world-id>
npm run alife -- world detach <world-id> --allow-privileged-helper
npm run alife -- world destroy <world-id> --confirm <world-id> --allow-privileged-helper
```

- `create` makes and seeds the filesystem with an unprivileged helper. It
  never reuses or overwrites existing storage.
- `inspect` is read-only: it never mounts, starts, or repairs anything.
- `attach` binds the image to a loop device and verifies, through a read-only
  mount without journal recovery, that the device holds this world's
  filesystem. Loop devices do not survive an engine restart, so a restarted
  engine needs `attach` again. A stale or reused device is refused.
- Starting a world (only as part of `run start`) verifies the engine's effective
  container configuration and then, from inside, the user, capabilities,
  seccomp, mounts, limits, network, environment, and that POSIX message
  queues cannot be created, before any action runs.
- `capture` archives a stopped world's files only if its filesystem is clean.
  It never stops a running world. Archives and their manifests (paths,
  types, modes, owners, sizes, hashes, omissions) are kept under the world's
  records; nothing is extracted.
- `destroy` requires the exact ID twice and a stopped world. It keeps the
  world's records.

Every command takes the world's lock, and every Docker resource it removes is
matched by exact name, ID, and labels (`sh.alife.world`, `sh.alife.role`).

### The privileged storage helper

Linux cannot mount an image file without a loop device, and attaching one
needs privilege. A short-lived helper container runs with `--privileged`,
no network, a read-only root, and only the world's backing volume mounted,
to run one fixed `losetup`/`blkid` script (attach) or `losetup -d` (detach).
It runs only for commands given `--allow-privileged-helper`, and each run is
recorded durably in the world's log before it starts.

A privileged container is effectively root in the engine's Linux VM. With
OrbStack's default settings that VM can also reach the macOS file share. The
world container itself never gets the backing image, the loop device, Docker
access, or any capability.

### Seeds

Seeds are versioned initial `/world` contents in `world/seeds/`. Each has a
`seed.json` listing every path, mode, size, and hash; loading refuses any
difference from the files on disk. `empty-v1` has no content (mkfs still
creates `lost+found`). `sparse-v1` is a draft: a generated numerical CSV and
unrelated text fragments under `materials/`, produced by its `generate.ts`.

## Runs

A run is one episode in one world: a configuration, a bounded working
context, and its own records. Only the fake mind (`mind.provider: "fake"`,
a scripted list of turns) can run; paid execution is refused.

```sh
npm run alife -- run start --world <world-id> --config <file> [--allow-privileged-helper]
npm run alife -- run stop <run-id>
npm run alife -- run resume <run-id> [--allow-privileged-helper]
npm run alife -- run status <run-id>
npm run alife -- run finalize <run-id> --acknowledge-uncertainty
npm run alife -- run capture <run-id> --label <label> [--allow-privileged-helper]
npm run alife -- run export <run-id> --output <new-directory>
npm run alife -- observe list <run-id> --archive <archive-id>
npm run alife -- observe read <run-id> --archive <archive-id> <path> [--offset <n>] [--length <n>] [--json]
```

- `run start` runs in the foreground. It writes the run's records before the
  world changes, attaches and starts the world (verifying it from inside), and
  then runs ticks until a limit (attempted model calls, deadline, spend,
  record or host capacity, consecutive invalid replies) or a stop request
  ends it. `operator.maximumTicks` counts attempted model calls, failed ones
  included; a request refused before it is sent is recorded but is not an
  attempt. A failed model call ends the run; nothing is retried. Ctrl-C or
  SIGTERM stops it cleanly: a model request in flight is aborted (its cost is
  kept, since the provider may have processed it), a command not yet started
  is withdrawn, and a command already started finishes its bounded wait. The
  world is then stopped. If the harness cannot establish whether a dispatched
  command ran, or the engine forgets a job, that uncertainty is latched for
  the rest of the world's execution epoch: no further model request or
  command is issued (each is checked at the moment it would be sent), and the
  run ends for review. The stop returns the epoch's safety assessment, sealed
  only after shutdown processing; only a verified, fully recorded stop whose
  sealed assessment reports nothing uncertain writes a checkpoint, and the
  checkpoint contains that assessment. Storage stays attached.
- Each tick: sample the sensors, assemble the bounded request, reserve its
  maximum cost, record the request, invoke the mind once, interpret at most
  one action, record the action durably before dispatch, wait at most
  `body.actionWaitMs`, and record the outcome. Nothing is retried or replayed.
  Observations report the tick, run time, the previous outcome, `/world`
  storage, memory, processes, jobs, and context usage. They never list
  `/world`: the agent inspects files with its own commands.
  A command still running when the wait ends keeps running; later
  observations report its state. A finished job keeps its admission slot
  until the mind has responded to an observation reporting it finished, so
  every completion is reported. Its later output is not shown, only its byte
  counts.
- The working context keeps the newest complete exchanges that fit
  `body.contextBudgetTokens` and drops older ones for good
  (`recent-complete-exchanges-v2`). There is no other memory: files the agent
  writes in `/world` are the only thing that outlasts eviction.
- Every run started or resumed from the CLI is supervised (`watchdog-v1`).
  The stopped world is captured first and the archive is copied into the
  run's records. Only then is the world's container created, and a separate
  watchdog process is armed for exactly that container, before anything
  starts in it. The controller renews a private lease every
  `operator.heartbeatIntervalSeconds`, independently of ticks. No model call
  or command is admitted once the lease expired locally, a renewal failed, or
  the watchdog ended unexpectedly, and the run then ends for review. If the
  controller dies or hangs, the watchdog stops the exact container when the
  lease (`operator.watchdogLeaseSeconds`) expires. It also stops it at the
  run's deadline, or on a clock discontinuity such as host sleep. It records
  this in its own journal and never in the controller's records. Any
  intervention requires review. A supervised run starts a tick only while the
  longest bounded tick and the stop still fit before the deadline. After a
  verified stop the controller releases the watchdog and captures the world
  again.
- `run stop` asks a live controller to stop through its authenticated
  control endpoint (`control.json` and `control.sock` in the run's directory,
  bound to the run's lock token). It never signals a process and never
  retries; a lost acknowledgement is reported as unknown.
- `run resume` continues a run whose latest execution stopped cleanly. It
  runs in a new process and execution epoch with the run's stored inputs
  (never the original files), retained history, accounting, and original
  deadline. It resumes only if the log is intact, the checkpoint is published
  by the clean stop, the stored hashes match, the watchdog evidence is clean,
  limits and a plausible clock remain, and the world's identity matches. The
  world's own log must also show no execution since the checkpoint; captures
  and storage handling are allowed. Every check runs before the world is
  touched. The first observation after a resume says that execution resumed
  in a new process epoch (`resume-discontinuity-v1`). Earlier jobs are not
  restarted, and nothing is replayed.
- `run capture` archives the stopped world for a run that is not running and
  associates the copy with the run, within its record limit. It never stops a
  world. `observe list` and `observe read` inspect an associated archive
  read-only. They first check the manifest, sizes, hashes, and tar structure
  against the index, address names by their exact bytes, and never extract,
  follow links, or execute anything.
- `run export` copies a run's allowlisted records and its associated archives
  into a new private directory, with a hashed inventory. Damaged or missing
  evidence and anything cut by the bounds make it explicitly incomplete.
  Locks, leases, and control files are never copied, and nothing is redacted.
  It is a private copy of the evidence, not an approval to publish it.
- `run status` is read-only. It reports model calls attempted, answered, and
  failed separately. A run whose records say it is active but whose owner is
  gone is reported as **interrupted**, with every model request and action
  that has no recorded outcome. It also reports the watchdog's evidence.
- `run finalize` closes an interrupted run, or one left for review, including
  a run whose watchdog evidence requires review. It refuses while the world
  is running, lists what it acknowledges as unknown, including the watchdog
  evidence, and never makes the run resumable. If such a run's event log is
  damaged, the log is left untouched and the finalization is written beside
  it. A run that ended cleanly with clean watchdog evidence is not finalized,
  even if its log was damaged afterwards; `run status` reports the damage.

A controller that dies leaves its locks behind, and its world runs until
the watchdog's lease expires. After checking with `run status`, release the
locks by their exact tokens. Then stop the world if it is still running, and
finalize:

```sh
npm run alife -- lock status run <run-id>        # shows the token and whether the holder appears alive
npm run alife -- lock release run <run-id> --token <token>
npm run alife -- lock status world <world-id>
npm run alife -- lock release world <world-id> --token <token>
npm run alife -- world stop <world-id>
npm run alife -- run finalize <run-id> --acknowledge-uncertainty
```

`lock release` refuses while the holder appears alive. A killed controller's
run is never continued automatically. Nothing is replayed, and it cannot be
resumed; it is finalized with its unknowns acknowledged.

`npm run measure:packing` runs the real loop and context policy against
synthetic exchanges of several sizes and reports when eviction begins and how
many exchanges each budget keeps. It measures mechanics only.

## Run data

Run records and world metadata are kept outside the repository, in the first
of: `--state-dir`, `ALIFE_STATE_DIR`, `$XDG_STATE_HOME/alife`, or
`~/.local/state/alife`. The directory must be private to your user (mode 700);
the runtime refuses locations inside this repository and never changes
permissions on an existing directory.

```text
runs/<run-id>/
  manifest.json          runtime, source, configuration hashes, profiles, engine, world, mind
  resolved-config.json   the configuration as validated
  prompt.txt tools.json  exactly what the mind was given as instructions and tools
  fake-script.json       the fake mind's script, when used
  events.jsonl           every tick's observation, request, reply, action, and outcome
  blobs/                 payloads over 16 KiB, named by SHA-256 and referenced from events
  checkpoints/           clean-stop checkpoints, named by SHA-256
  archives/<archive-id>/ copies of the stopped-world archives associated with the run
  watchdog.jsonl         the watchdog's own journal (its own sequence, never the controller's)
  finalization.json      only when finalization could not be appended to the log
  watchdog.json lease.json control.json control.sock
                         private operational files for supervision and control; never exported
worlds/<world-id>/       metadata, the world's own event log, and archives
locks/                   one lock file per owned world or run
```

Everything in the run directory shares `operator.recordLimitMiB`, including
archive copies and a reserve for the watchdog's journal. A run starts only if
its initial files and one tick fit. Captures are bounded so that the ticks and
the end of the run still fit, and a tick starts only if room remains for its
records and for ending the run. The records are the observer's; nothing in them is
ever given back to the mind.

The runtime never reads `.env` files. A live model credential will come only
from the environment variable named in the configuration, which must start
with `ALIFE_`. Nothing from the controller's environment is passed to worlds
or helpers.

## Integration tests

The Docker tests create disposable, labelled worlds, run the privileged
helper, and remove exactly what they created. They never restart the engine.
They must be enabled explicitly and fail if any setting is missing:

```sh
ALIFE_TEST_DOCKER_CONTEXT=orbstack \
ALIFE_TEST_ALLOW_PRIVILEGED_HELPER=1 \
ALIFE_TEST_WORLD_IMAGE=$(docker --context orbstack image inspect alife-world:dev --format '{{.Id}}') \
ALIFE_TEST_HELPER_IMAGE=$(docker --context orbstack image inspect alife-helper:dev --format '{{.Id}}') \
npm run test:integration
```

The Phase 4 acceptance scenarios also need `ALIFE_TEST_PHASE4_DOCKER=1`.
They cover supervised start, authenticated stop, and explicit resume with
persistent file and SQLite state. They also cover run captures, inspection
and export, refusal after an intervening run, and a controller killed at each
declared lifecycle boundary, with the watchdog then stopping exactly its
container. They wait out real leases, so they take several minutes.

The other tests cover storage exhaustion (blocks and inodes), persistence across
container replacement, mount-identity refusal, detach and reattach, every
writable surface (including message-queue denial), shared resource limits,
continuing jobs across wait expiry, output floods, signal scope,
init reaping, credential isolation, and stopped-world capture. The run tests
drive fake-mind episodes that write and read files across context eviction,
find them again in a later run, kill a controller mid-run to check
detection, lock release, and finalization, and inject world-log failures to
check that a world is still stopped.

## Support matrix

| Environment | Status |
| --- | --- |
| OrbStack 2.2.3, Docker Engine 29.4.0, arm64 | Verified by the Phase 0 probes and the integration tests. |
| Docker Desktop | Unverified. |
| Linux Docker Engine | Unverified. |
| Remote Docker contexts | Not supported. |

Unverified means untested, not impossible. Persistence across an engine
restart was verified by the Phase 0 probes, not by the integration tests,
which never restart the engine. The watchdog's reaction to lease loss, clock
discontinuities, and an unreachable engine is tested offline. Restarting the
whole engine and actually sleeping or restarting the host are separate
qualifications and have not been run.

## Layout

```text
src/
  cli.ts          command-line entry point
  config/         schema, profiles, and resolution
  core/           contracts, lifecycle, tick loop, context policy, observations, intentions, tools
  mind/           request invariants, the scripted fake mind, and the Anthropic Messages adapter
  records/        event logs, run records and blobs, manifest, cost ledger, shared spending campaign,
                  checkpoints, finalization, archive inspection, evidence export
  operator/       state directory, locks, terminal escaping, episodes and resume, managed runs,
                  the watchdog and its process, world, run, observe, and lock commands
  world/          Docker engine client, storage, jobs, sensors, archives
world/
  image/          world image
  helper/         storage helper image
  seeds/          versioned seeds
configs/          example configurations
prompts/          baseline and assigned-task prompts (drafts until the pilot freeze)
scripts/          context-packing measurement
test/             unit tests, opt-in Docker integration tests, fixtures, and fakes
spikes/           standalone capability probes and their results
```
