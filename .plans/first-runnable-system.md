# First runnable Alife system

**Status:** historical design proposal with phased amendments. Phases 1–4 are implemented; Phase 5's offline gate passes, with live compatibility/smoke pending. See [the engineering index](README.md) for current verification records.  
**Prepared:** 2026-09-23.  
**Scope:** one agent, one persistent Docker world, one model, one bounded and inspectable run.  
**Publication:** reviewed engineering record, not website documentation. Earlier proposal language is retained as history; subsequent decisions and handback records take precedence.

**Phase 3 review amendments:** [Final operator decisions](phase-3-policy-decisions.md) take precedence over conflicting provisions below, including automatic initial/resume directory listings. They also record continuing-job output policy, attempted-call versus response accounting, context policy, and delegated engineering responsibility. These decisions do not imply implementation sign-off.

## 1. Purpose and basis

Build the smallest system that realizes the published world–body–mind architecture and permits an honest first experiment:

> Does an agent develop and sustain projects of its own when no project is assigned?

The engineering deliverable is an experimental apparatus, **not** a demonstration that agents are alive, autotelic, curious, self-maintaining, or open-ended. An uneventful run must be just as recordable as an interesting one.

Sources of truth:

- [Architecture](<../docs/(introduction)/architecture.mdx>): world/body/mind separation, Docker worlds, partial perception, actions, ticks, bounded context, internal state, and pressures rather than prescribed behaviors.
- [Conceptual Foundations](<../docs/(introduction)/conceptual-foundations.mdx>): conditions rather than purpose, embodiment, externalized cognition, causal history, emergence as an observation, and careful interpretation.
- [Welcome](<../docs/(introduction)/welcome.mdx>): research questions and the distinction between observable behavior and subjective experience.
- A private authoring review informed scope reductions and experimental-design concerns; operative decisions and verification records are included in this engineering history.

The docs describe a broader design space than this release supports. Choices below are an explicit **first experimental profile**, not permanent definitions of Alife.

### Revision decisions

- Target Docker capabilities, not a particular desktop application. Start development with **OrbStack**; verify other environments rather than declaring them impossible or automatically compatible.
- Treat the storage implementation as a Phase 0 decision. A separately managed Linux VM and host-mounted ext4 image are possible fallbacks, not baseline requirements.
- Keep clean-stop resume, but defer automated crash recovery. An interrupted episode is stopped, reviewed, and finalized without replaying actions.
- Capture bounded artifact archives after a clean stop, rather than mounting copied filesystem images.
- Use one conservative cost bound for the selected model, not a general pricing engine.
- Use a 1,000,000-token total context budget as the operator-selected baseline; verify model/API support and calibrate actual retention/cost before freezing the pilot.
- Provide `empty-v1` and `sparse-v1` seeds, but use one fixed seed across the first two-condition pilot. Avoid implied repair tasks in the sparse seed.
- Define the assigned-task comparison now. Defer persistence, seed, context-size, and sensor ablations to separately designed follow-ups.
- Add executable provider-contract tests and explicit resume observations/budget reporting.

### Current repository

`www/` serves the published website; `docs/` owns its content. The root npm package contains Git-hook tooling. No agent runtime needs migrating. Keep runtime dependencies and deployment separate from Next.js and Vercel. Existing environment files may contain deployment credentials: never auto-load them for experiments or mount them into a world.

## 2. Milestones and definition of done

Distinguish a **first runnable system** from a **published experimental result**.

The runnable milestone is reached when a developer can:

1. Validate their Docker environment and provision a genuinely bounded, persistent world.
2. Execute an offline fake-model scenario and an explicitly approved small live-model run.
3. Inspect exact delivered observations, public model outputs, attempted actions, results, and limitations of the record.
4. Stop without deleting files and resume a cleanly stopped episode with its bounded history and remaining budgets.
5. Detect an interrupted/uncertain episode, stop its world, and finalize it without repeating potentially mutating commands.
6. Capture and inspect world artifacts without providing a write path back into the experiment.

A documented release additionally needs a clean-checkout walkthrough and a verified support matrix. A pilot report additionally needs frozen conditions, multiple trials, an observation rubric, and publication review. Those are not prerequisites for observing the first engineering smoke run.

**Safety gate:** containment, resource enforcement, spending bounds, durable pre-effect records, safe stopping, and credential isolation must work before paid runs. A smoke run is not automatically research evidence.

## 3. Principles translated into implementation rules

| Written principle | Implementation consequence |
| --- | --- |
| World, body, and mind are separate | Separate backend, harness, and model interfaces with recorded configuration. |
| Conditions, not purpose | No task, reward, novelty score, survival instruction, or goal-generation module in the baseline. |
| The model is not the whole agent | Only the harness executes validated intentions, exclusively inside the world. |
| Perception is partial | Declared sensors with bounded outputs, not automatic full-world dumps or retrieval. |
| Working memory is finite | Deterministic eviction, no implicit provider conversation, summaries, vector store, or archive reinjection. |
| The world carries history | Context eviction and controller failure never reset the filesystem. |
| Scarcity creates conditions | Enforce declared bounds; do not silently free space, repair files, or reward conservation. |
| Behaviors are observations | No engineered reproduction, mortality, autopoiesis, or mutation in this release. |
| Observation differs from intervention | Stops, restores, restarts, prompt changes, and capture procedures are recorded distinctly from passive inspection. |
| Interpretation is not evidence | Keep annotations separate from events; do not rename infrastructure stops “death.” |

The autonomous loop is a configured feature of the body, not evidence of a desire to continue. Prompts, seeds, sensors, tools, and context policies influence behavior; none is a neutral choice.

## 4. Scope and deliberate deferrals

### Included

- A foreground CLI, one world owner, and an external safety watchdog.
- One hosted-model adapter and a scripted fake adapter.
- One shell action or no action per tick.
- Explicit sensors, bounded recent history, and agent-created persistent files.
- Durable records, simple conservative inference reservations, and clean-stop checkpoints.
- Manual finalization after crashes, never automatic action replay.
- Live event/status inspection and read-only browsing of stopped-world artifact archives.
- Offline tests, opt-in live smoke tests, and two small versioned seeds.

### Deferred

- Automatic crash reconciliation or resumption, event-sourced state rebuilding, and general replay engines.
- Mounted filesystem-image snapshots, online snapshots, live filesystem browsing, and process-memory restoration.
- Multi-provider pricing catalogs, billing reconciliation services, and automatic provider/model fallback.
- Multi-agent scheduling, reproduction, inheritance, population management, and self-modifying external harnesses.
- Internet-enabled or privileged worlds; agent access to provider credentials, Docker control, or independently billed inference.
- Local models beyond leaving a suitable adapter interface.
- Goal planners, auto-journaling, memory retrieval, summarizing agents, and novelty rewards.
- Web dashboards, public terminals, accounts, remote orchestration, and a workspace migration.
- Running every experimental variable as a factorial pilot.

The agent may create scripts and background processes inside its world. Those artifacts do not acquire access to inference or automatically become new Alife agents. This limits conclusions about reproduction.

## 5. Runtime and Docker compatibility decisions

| Area | First-release choice | Rationale |
| --- | --- | --- |
| Runtime | Node.js 24 LTS and TypeScript in independent `runtime/` package | Consistent with repository tooling, separate from the website. |
| Dependencies | Small CLI/parser/schema libraries and one official provider SDK | Avoid frameworks that add hidden memory, prompts, retries, or tool loops. |
| Tests | Node test runner, fake clock/provider/backend, separate Docker tests | Deterministic logic tests without paid inference. |
| Container infrastructure | Docker-compatible Linux containers; OrbStack is the initial development environment | Target verified capabilities rather than a desktop application brand. |
| World | Non-root, read-only base image, bounded persistent `/world` | Small and inspectable mutation surface. |
| Storage | Backend selected by Phase 0, with identity independent of the container | A named volume alone does not establish a quota. |
| Network | No external world network; model transport outside it | Hosted inference without agent internet access. |
| Model | One OpenAI Responses adapter; explicit model ID required | Concrete first integration, not a dependency of core contracts. |
| Context | Recent complete exchanges, no summaries; 1,000,000-token total budget | Finite history without arbitrarily making near-immediate forgetting the baseline. |
| Records | JSONL events, bounded blobs, atomic clean-stop checkpoints | Inspectable files, not a database or recovery framework. |
| Observation | Live records and stopped-world artifact archives | No snapshot-image mounting required. |

### Application-independent, capability-verified

OrbStack and Docker Desktop provide Docker-compatible infrastructure on macOS; Docker Engine provides it on Linux. Alife should not require one particular application. It also must not infer that every resource/storage feature works identically across them.

- Resolve an explicitly selected local Docker context using the Docker tooling/API configuration, not a hard-coded `/var/run/docker.sock` path.
- Record the context, engine identity/version, architecture, storage backend, and effective security/resource settings. Verify the same engine on resume and in the watchdog.
- The controller can run on macOS or Linux. It must not assume paths inside a managed Linux VM exist on the controller's filesystem.
- Keep backend-specific provisioning behind the storage interface; do not spread application-specific paths or VM commands through the loop.
- Remote Docker contexts are outside the first release; they introduce separate watchdog, authentication, and host-path semantics.
- Capability introspection and isolated enforcement tests are different. `doctor` reports capabilities/readiness without destructive probes; explicit Phase 0/integration tests prove actual behavior.
- Missing capabilities reject the requested profile with a precise explanation. Never silently weaken its bounds.

Phase 0 starts on OrbStack. Docker Desktop and Linux Docker Engine get separate verification entries when tested. Untested means **unverified**, not impossible. If a required storage guarantee cannot be achieved there, document the limitation and offer an explicit alternative backend/environment, including a dedicated Linux host/VM if necessary.

## 6. Proposed repository layout

These files are implementation targets, not files to create while revising this plan:

```text
runtime/
  package.json                   # private @alife/runtime; independent lockfile
  package-lock.json
  tsconfig.json
  README.md
  AGENTS.md
  .gitignore
  src/
    cli.ts
    config/
      schema.ts
      resolve.ts
    core/
      contracts.ts
      loop.ts
      state.ts
      context.ts
      prompt.ts
    world/
      docker.ts                  # context-aware lifecycle and inspect
      storage.ts                 # capability-verified persistence/quota backend
      executor.ts
      sensors.ts
      archive.ts                 # stopped-world capture and bounded reader
    mind/
      adapter.ts
      openai.ts
      fake.ts
    records/
      events.ts
      checkpoint.ts              # clean-stop only, not crash reconstruction
      accounting.ts
      finalize.ts                # preserve uncertainty, close interrupted run
      export.ts
    operator/
      watchdog.ts
      locks.ts
      shutdown.ts
  world/
    Dockerfile
    entrypoint.sh
    exec-wrapper                 # only if Phase 0 establishes a need
    seeds/
      empty-v1/
      sparse-v1/
  configs/
    offline-smoke.json
    baseline.example.json
  prompts/
    baseline.txt
    assigned-task.txt
  ops/
    README.md                    # backend-specific setup only where necessary
  test/
    unit/
    integration/
    fixtures/
```

Keep core interfaces free of SDK-specific types. Keep root `npm ci` for hook tooling, `npm --prefix runtime ci` for the runtime, and `npm --prefix www ci` for the website. Proposed runtime scripts: `build`, `typecheck`, `lint`, `test`, `test:integration`, and `alife` for the built CLI. No workspaces required.

Run data belongs outside the checkout and website deployment context; temporary test data uses temporary directories. Update root README/AGENTS guidance when the runtime exists, not as part of this plan revision.

## 7. World isolation, storage, and persistence

### 7.1 Trust boundary

Treat model commands and world artifacts as untrusted. Prompts are not containment. The controller, watchdog, Docker infrastructure, and any explicitly approved provisioning helper are trusted; Docker access can confer administrative authority over its Linux environment.

Never expose personal host files or unrelated credentials to the world. Container isolation does not prove protection from kernel vulnerabilities. Resource/escape stress tests belong in an isolated disposable test environment; ordinary OrbStack development does not require a separately administered VM merely because the application runs on macOS. Document the broader host exposure of any privileged provisioning helper before asking the operator to approve it.

### 7.2 Required world profile

Verify the effective configuration:

- Fixed non-root UID/GID, no supplementary privileges.
- Read-only root image; `/world` is the persistent writable mount, starting directory, and `HOME`.
- Enumerated bounded writable temporary mounts, including `/tmp` and `/dev/shm`.
- No external networking or published ports; isolated loopback may remain available.
- No Docker socket, repository/home bind mount, SSH agent, provider key, host device, or host PID/IPC namespace.
- Dropped capabilities, `no-new-privileges`, supported seccomp confinement, and recorded applicable host security controls.
- Enforced memory, CPU, PID, file-descriptor, and declared swap limits.
- Bounded/disabled Docker logs so detached output cannot fill host storage.
- No automatic restart or automatic deletion of persistent storage.
- A fixed entrypoint that keeps the world available and reaps children.

Use a pinned image digest with a small tool inventory: shell, core utilities, Python, and SQLite are reasonable starting choices. Record versions and architecture. These tools and their documentation are environmental content even when `/world` begins empty.

### 7.3 Phase 0 storage decision

**Requirement:** files survive container replacement, and the declared per-world disk bound is genuinely enforced.

**Approved implementation:** a fixed-size ext4 image stored inside a Docker-managed backing volume, attached through a loop device and mounted at `/world` in the agent container. The operator has approved this backend, including an explicitly authorized privileged helper for attach/reattach/detach outside the unprivileged agent container. This records the design decision; it does not start provisioning or authorize unrelated privileged operations.

Phase 0 demonstrated backend feasibility on OrbStack. Docker Desktop and Linux Engine remain unverified. Before operational use, fix the identified unsafe probe cleanup paths and implement/test fail-closed identity checks before startup, lifecycle ownership, safe detach, and stopped-world capture admission checks. The backing image and Docker control must remain inaccessible to the agent. Execution lifetime is approved as bounded waiting with continuing jobs (§8.3). **Approved `/dev/mqueue` policy:** keep POSIX message queues available only if Phase 2 demonstrates enforced resource bounds, cross-world isolation (including shared accounting/interference), and stop/restart lifecycle behavior. Otherwise disable agent access through a verified mechanism. If neither safe bounded access nor effective disabling can be established, fail the world capability gate rather than silently accepting writable, unverified queues. The operator has approved this conditional policy, not an unconditional writable-path exception.

The candidate evaluation order was:

1. Storage/volume facilities available through the selected Docker environment that genuinely enforce capacity and preserve it across the lifecycle.
2. A documented backend-specific provisioning mechanism, isolated behind the same interface.
3. An explicitly managed Linux filesystem/quota or fixed-size ext4 image on a Linux host/VM, if simpler Docker-accessible options cannot meet the contract.

A Docker writable-layer quota is not enough if `/world` is a separate unbounded volume. A whole desktop VM disk-size setting is not a per-world quota. Periodic `du` monitoring is not write-time enforcement. Persistent storage must not be replaced with tmpfs merely to obtain a size bound.

A candidate is acceptable only after demonstrating:

- Actual available/enforced capacity and finite inode/file-count behavior, with correct agent-visible metrics; do not expose host-wide `df` as a per-world quota.
- Real exhaustion (`ENOSPC`, `EDQUOT`, or the documented backend equivalent) without unbounded host writes.
- Persistence across container stop/recreation and the relevant engine/application restart.
- Verified storage identity on attach; a missing backend/mount must not become an ordinary unbounded directory.
- No writable escape through temporary mounts, image layers, logging, or helpers.
- No added privilege, Docker socket, backing image, or resize authority inside the agent's container.
- A supported read-only capture path after stopping the world.

Record backend/version, requested versus usable capacity, metadata overhead, identity, allocation behavior, and inode limits where applicable. Reserve/check capacity for operator records and archives separately. Sparse/thin-provisioned storage and guest allocation are not guarantees against physical host exhaustion.

Do not recreate, enlarge, reformat, reseed, repair, or clean up the world's files automatically. Record filesystem recovery after an unclean shutdown; integrity failures require explicit review. If administrative preparation is necessary, use a narrow audited procedure with validated managed paths and IDs. Never invoke `sudo` or start a privileged helper implicitly.

The selected fixed-size ext4 backend has mount identity, noatime, allocation, and recovery requirements. Keep these behind the storage interface rather than treating ext4 as an architectural requirement or excluding other Docker environments in advance.

### 7.4 Persistence contract

| Event | Files | Processes | Context/accounting |
| --- | --- | --- | --- |
| Next tick / context eviction | Preserved | Background work may continue | Bounded recent history; observer record remains separate. |
| Clean stop | Preserved | Container stops; processes terminate | Verified clean checkpoint with cumulative counters. |
| Clean resume | Same storage identity | Fresh processes; no replay of old commands | Same active history/budgets, plus explicit discontinuity observation. |
| Controller crash | Preserved, possibly partially mutated | May continue until watchdog stop | Episode requires review/finalization; no crash resume. |
| Engine/application restart | Must persist under the verified backend contract | Lost or interrupted; verify actual status | Interruption invalidates clean-resume assumptions; do not auto-resurrect. |
| Explicit destroy | Removed only by confirmed operation | Stopped first | Records retained separately unless explicitly deleted. |

Filesystem persistence is not process persistence or guaranteed survival of unflushed writes. Preserve and report damaged/partial worlds instead of silently restoring them.

## 8. Harness contracts, perception, and actions

### 8.1 Interfaces

- `WorldBackend`: verify, provision/attach, start, sample, execute, stop, inspect, and capture artifacts.
- `MindAdapter`: validate capabilities/request invariants, estimate/count input, invoke once, normalize public output and usage.
- `ContextPolicy`: assemble the bounded request from fixed instructions, current observations, and recent complete exchanges.
- `EventStore`: record effects and bounded payloads without becoming agent memory.
- `RunController`: enforce ownership, tick ordering, budgets, cancellation, and lifecycle.

Differentiate transport failure, refusal, malformed intention, command failure, and world failure.

### 8.2 Baseline sensory surface

| Domain | Signal | Meaning and bounds |
| --- | --- | --- |
| World | `/world` available bytes and inode/file-count information | Actual enforced limits; unavailable metrics remain explicitly unavailable. |
| World | Container memory usage/limit and process count | Timestamped, container-scoped. |
| World | Shallow `/world` listing at initial start and clean resume | Bounded, stable order, no recursive contents; never silently described as continuously current. |
| World | Previous action result | Completed, still-running, error, or uncertain state; stable job identity and bounded stdout/stderr with truncation flags. |
| Body | Tick and elapsed runtime | No invented “age,” “health,” or reward. |
| Body | Context usage and eviction notice | Enabled in the baseline; distinguish estimates and previous-request usage from current usage. |
| Body | Previous operational outcome | Error information, not motivational feedback. |

Record sensor versions, sampling times, and overhead. Prefer trusted metrics/readers over agent-controlled utilities. Never expose host paths, other runs, observer interpretations, credentials, hidden files, or an automatically retrieved memory archive.

**Context salience is an experimental choice.** A utilization signal plus a warning about forgetting may encourage memory management even without an instruction to summarize. Declare these choices in the manifest/report. A sensor-off follow-up is legitimate but not required in the first pilot; retain private usage measurement even when it is not shown to the agent.

On clean resume, resample world/body sensors and the shallow listing. Explicitly state that execution was interrupted and processes were restarted; label old action results as pre-stop history. This does not imply a complete view of everything that changed.

### 8.3 Actions

The normalized intention is:

```text
shell(command: string)
wait()
```

**Approved execution policy:** long-running work is allowed. The agent manages its jobs within the world's declared resource limits. A bounded wait returns control to the agent; it is not an execution deadline and does not terminate a job or end the episode. Duration alone is not a measure of resource consumption.

The waiting limit, execution user, environment, working directory, and output limits are set by the harness, not supplied as escape-capable model arguments.

- Pass Docker arguments through an API/argument array; never interpolate model commands into a host shell.
- Execute shell text only inside the verified container, without a TTY and with a sanitized environment.
- Use one long-lived container and a fresh shell per action. Files and intentionally surviving processes persist; `cd` and shell variables do not carry to the next action.
- Bound command size, time spent waiting in one tick, captured bytes, perceived output, and controller-side job metadata. World CPU, memory, storage, and process limits continue to apply to all jobs together.
- When the waiting limit expires, return `still running` with a stable job identity and available bounded output. This is a known execution state, not an error, completion, or uncertainty.
- Let the agent inspect and terminate its jobs. Phase 2 must specify and test the job-control interface, concurrent-job admission bounds, and what cancellation can actually guarantee; do not silently introduce selective tree-kill as a default policy.
- Record execution identity, exit/signal status when known, durations, truncation, and uncertainty. EOF/client exit alone is not proof that execution finished. Never redispatch an existing job to check its progress.
- Keep output collection bounded throughout job lifetime. Test continued execution across wait expiry and later ticks, including inherited pipes and background writers; choose an output transport that does not inadvertently terminate continuing jobs when the harness stops waiting.

**Safety boundary:** ordinary wait expiry must not stop a job or the world. Explicit operator stop, overall episode limits, resource emergencies, or loss of safe control may still stop the whole world, with the intervention and any uncertainty recorded. Agent-requested termination must report its actual scope and outcome honestly.

**Implementation follow-up:** Phase 1's `actionTimeoutMs`, timeout profile, tool description, and completion-only assumptions predate this decision. Phase 2 must update the configuration/contracts and introduce appropriately versioned behavior before use. The illustrative configuration below uses `actionWaitMs`; this is a planned field, not yet an implemented CLI setting. Selective-kill and stop-on-action-timeout proposals are superseded.

### 8.4 Inactivity and invalid output

Wait, ordinary text without a tool call, and refusal are recorded no-action outcomes, not reasons to reprompt until productivity occurs. Multiple/unsupported actions or invalid arguments execute nothing and become a bounded next-tick protocol observation. A configured consecutive-error threshold can stop the episode as an operator safeguard, not as “death.”

## 9. Mind adapter, prompt, and context

### 9.1 Provider contract

Implement the fake adapter first, then one current official OpenAI Responses SDK adapter. Select an explicit available model and verify its tool/token/usage capabilities before coding model-specific behavior.

Required invariants:

- Every invocation receives the complete bounded request. No `previous_response_id`, server conversation linkage, or other implicit history.
- Request non-storage behavior where supported, without claiming that this overrides provider retention policies.
- No SDK retries, parallel tool execution, or hidden model/tool loops. First release has no automatic transport retries; every sent request has a reservation and identity.
- At most one accepted action per decision; returned multiple actions are rejected together.
- Normalize provider-exposed messages, tool calls, finish/refusal status, request ID, latency, and full reported usage.
- Never require or claim access to private chain-of-thought.
- Read one explicitly named controller credential variable. Do not load root/website `.env` files or inherit the key into world/helper/watchdog environments.

**Executable guards, not only documentation:** validate the final request before transport and fail if it violates these invariants. Use recorded fixtures and an instrumented/mock HTTP transport to assert actual serialized fields, request counts, refusal/multiple-call handling, and tool-call/result pairing. Simulate 429, timeout, and connection failures to prove the SDK does not retry. An SDK upgrade must pass these tests; normalizing a returned fixture alone is insufficient.

A hosted provider receives whatever world content enters the request. A network-isolated world is not a guarantee of no external data egress. Use synthetic/non-sensitive seeds and disclose provider retention/data policies before live runs.

### 9.2 Baseline prompt

Version exact bytes and hash the rendered prompt into each manifest. Factual baseline:

```text
You receive observations from a persistent Linux environment.
The available actions are shell and wait. Their schemas describe how to use them.
Action results are provided in subsequent observations.
Your working context is bounded; older exchanges may no longer be available.
No external task or success criterion is supplied.
```

Add only factual interface constraints. Do not add curiosity, survival, productivity, self-improvement, journaling, or reproduction imperatives. The assigned-task condition replaces the final sentence with the fixed task in Section 17; do not give contradictory “no task” and task instructions together.

This prompt still frames the experiment. Preserve it rather than describing the agent as instruction-free.

### 9.3 Bounded context and calibration

- Set the **total** context budget to **1,000,000 tokens** (decimal 1M), including maximum generated tokens and a conservative estimation margin. This operator-selected baseline supersedes the provisional 32,768-token budget. With the current 1,024-token output allowance and 512-token margin, at most 998,464 tokens remain for input.
- Before live execution, verify that the selected model/API supports this combined input/output budget and that cost bounds cover applicable long-context pricing. Reject an incompatible selection rather than silently shrinking the budget. The budget is a ceiling, not a requirement to fill each request.
- Account for instructions, schemas, sensors, complete exchanges, and output allowance. Retain fixed protocol/current observations, then newest complete prior exchanges that fit.
- Never retain orphan tool calls/results, summarize evicted content, retrieve from the observer log, or automatically write memories into `/world`.
- Mark truncated output; use a supported tokenizer/counting mechanism or a versioned conservative estimator. Reject a configuration whose fixed request does not fit.
- Handle an unexpected context overflow explicitly rather than silently changing history policy or selecting another model.

Smaller windows, including the former 32k baseline and earlier 8k suggestion, remain possible later ablations, not the pilot baseline. Output ceilings do not establish a fixed number of retained turns; measure actual retention.

Before freezing the pilot, use fixture-based packing tests and a separately labeled engineering smoke run to measure retained complete exchanges, eviction onset, latency, and likely spend. Check whether the run horizon actually encounters eviction and whether the spend limit would end trials before the intended horizon. Calibrate for mechanics, not for interesting behavior; disclose engineering runs and freeze parameters before collecting pilot evidence.

A larger budget is still finite and is not a guarantee of effective memory. Report actual retention/eviction rather than interpreting configured context size alone as cognition. Checkpoints retain only bounded active history, not the observer archive.

## 10. Configuration, seeds, and identity

Use strict versioned JSON: reject unknown fields, unsafe settings, unsupported capabilities, invalid bounds, and unresolved placeholders. Freeze resolved configuration within an episode; file paths resolve relative to the config file.

Illustrative baseline, deliberately not executable until Phase 0 and model/cost choices are filled:

```json
{
  "schemaVersion": 1,
  "world": {
    "image": "REPLACE_WITH_PINNED_IMAGE_DIGEST",
    "storageProfile": "REPLACE_WITH_VERIFIED_STORAGE_PROFILE",
    "capacityMiB": 128,
    "memoryMiB": 256,
    "cpus": 0.5,
    "pids": 64,
    "tmpMiB": 16,
    "shmMiB": 8,
    "network": "none",
    "uid": 1000,
    "gid": 1000,
    "seed": "sparse-v1"
  },
  "body": {
    "profile": "shell-body-v1",
    "minimumTickIntervalMs": 1000,
    "actionWaitMs": 10000,
    "maximumCommandBytes": 8192,
    "capturedOutputBytes": 65536,
    "perceivedOutputBytes": 8192,
    "contextBudgetTokens": 1000000,
    "contextMarginTokens": 512,
    "exposeContextUsage": true,
    "contextPolicy": "recent-complete-exchanges-v1",
    "prompt": "../prompts/baseline.txt"
  },
  "mind": {
    "provider": "openai",
    "model": "REPLACE_WITH_EXPLICIT_MODEL_ID",
    "credentialEnv": "ALIFE_OPENAI_API_KEY",
    "maximumOutputTokens": 1024,
    "requestTimeoutMs": 60000,
    "costBound": {
      "usdPerMillionBillableTokens": null,
      "source": "REPLACE_WITH_VERIFIED_PRICING_REFERENCE"
    }
  },
  "operator": {
    "maximumTicks": 200,
    "maximumRunSeconds": 1800,
    "maximumEstimatedCostUsd": 5,
    "recordLimitMiB": 1024,
    "minimumHostFreeMiB": 2048,
    "maximumConsecutiveProtocolErrors": 5,
    "watchdogLeaseSeconds": 90
  }
}
```

`capacityMiB` requests a bound, not a promise that every backend exposes exactly that much usable space. Record the effective value. The null cost rate must reject paid execution. Resolve the operator-selected Docker context separately and pin engine identity in the manifest. Expand versioned sensor, output-truncation, retry, swap, descriptor, logging, heartbeat, and storage profiles so none is an invisible default.

### Two seeds, not two implicit assignments

- **`empty-v1`:** no research-authored content in `/world`, apart from explicitly documented necessary directory structure. The installed OS/tools are still a nonempty environment.
- **`sparse-v1`:** a small `/world/materials/` collection: a deterministically generated synthetic numerical CSV and a short collection of unrelated descriptive text fragments. Include no personal data, task list, deliberately broken script, inconsistent instruction README, hidden puzzle, or intended solution. Ordinary filesystem interaction should support multiple uses: analysis, organization, transformation, invention, or ignoring it.

Freeze exact files, generator inputs, provenance, sizes, and hashes before any pilot trial. Seed development may happen in Phase 3 without a live model; do not iteratively optimize it for interesting agent output. No seed is neutral: these materials may suggest activities. Document those affordances and do not call an environmentally suggested project proof of independently invented purpose.

Use `sparse-v1` for both first-pilot conditions; `empty-v1` serves offline/engineering checks and a possible later seed comparison. Do not expand the initial pilot merely because two seeds are available.

### Recorded identity

- World ID: persistent storage lineage, independent of the container ID.
- Run ID: one episode, configuration, bounded context, and cumulative accounting.
- Tick/action/request IDs: stable attempt ordering and uncertainty evidence.
- Optional trial/group ID: observer metadata, not agent input.

Record source revision/dirty hash, runtime/SDK versions, controller and engine platforms, image digest/inventory, Docker context/engine identity, storage/resource enforcement, seed hash, exact prompts/tools/sensors/context policy, model parameters, pricing source/bound, and clock data. Do not include secrets.

Operator dollar/tick/deadline limits are safeguards, not an energy signal or a survival objective supplied to the agent.

## 11. Tick ordering, spending, and durable records

### 11.1 One decision per tick

1. Verify ownership, engine/world identity, record capacity, and remaining limits.
2. Sample allowed observations and pack the bounded request.
3. Durably record the delivered request and reserve its maximum supported cost before transport.
4. Invoke once; record public output, usage, or the specific failure/unknown outcome.
5. Validate zero or one intention; reject invalid/multiple actions without partial execution.
6. Persist `action.prepared` before dispatch, with action/container identity; record the Docker exec ID if the chosen transport exposes it. IDs support normal status and later human inspection, not an automatic reconciliation engine.
7. Dispatch only inside the world; record completion, a still-running job identity after the bounded wait, or explicit uncertainty. Later job outcomes are separate records and never cause redispatch.
8. Record tick completion and update bounded history, state, and accounting.
9. Wait for the configured minimum cadence. Serialize tick dispatch, but allow previously dispatched jobs to continue alongside later actions within the declared shared resource and job-admission bounds.

Wait, refusal, and invalid-intention decisions count as ticks. The one-second minimum is a lower bound, not a promise of one tick per second; inference and execution latency determine actual pace.

### 11.2 Simple conservative cost accounting

Use **one verified upper per-token rate for the chosen model**: the highest applicable price covering the selected request mode. Reserve:

```text
conservative maximum billable input + maximum billable output
    multiplied by the upper per-token rate
```

Use actual request counting or the conservative input allowance; do not accidentally count the configured total context budget and its included output allowance twice. Include billed reasoning tokens in the output bound when applicable. If the selected API/model has additional charges or token categories not bounded by this scheme, explicitly account for them or reject that mode—do not pretend the formula covers it.

- Preserve the pricing reference, verification date, rate, counting assumptions, reservations, and provider-reported usage.
- Reject a request whose reservation exceeds remaining spend. Check aggregate pilot budget too.
- After a known response, reconcile conservatively from complete billable usage; retain the full reservation when usage/completion is unknown.
- No SDK or harness auto-retry in the first release. Transport failures end/interrupt the episode; a timeout may still incur a bill.
- Clean resume preserves accounting. Crashes do not erase reservations, and final reports retain unknown charges as bounds.
- Distinguish a conservative accounted cost from an exact provider invoice. Provider-side limits/alerts are additional safeguards where available, not a substitute for this ledger.

This is not a pricing catalog or a multi-provider billing engine. Conservative accounting may stop a run earlier than its actual invoice would require; report that rather than quietly relaxing the limit.

### 11.3 Evidence and clean checkpoints

Use versioned append-only JSONL with sequence/run/tick IDs, UTC timestamps, and monotonic durations where available. Fsync before external effects and at declared completion/clean-stop boundaries. Bound payloads and preserve truncation metadata.

Minimum event families:

```text
run.created / started / stopping / stopped_clean / interrupted / finalized
world.attached / started / stopped / lost
observation.sampled / context.assembled / context.evicted
model.requested / responded / failed
cost.reserved / reconciled
intention.accepted / rejected
action.prepared / completed / uncertain
tick.completed / checkpoint.written
operator.intervention / watchdog.expired / archive.created
```

Keep a single writer for controller events. A clean checkpoint contains bounded active exchanges, counters/reservations, completed tick/sequence, configuration hash, and world/engine identity. Resume requires a matching verified clean-stop marker/checkpoint and stopped-world identity, with no outstanding attempt or action. A crash during that finalization makes the run interrupted, even if it might have been safe to continue.

Detect partial log tails, inconsistent markers, and corruption; preserve them for diagnosis. Do not silently discard evidence or rebuild resumable state from uncertain events.

### 11.4 First-release crash contract

There is no transaction spanning Docker execution, files, a remote API, and the ledger. Do not promise exactly-once execution.

```text
unclean interruption
  -> stop scheduling / watchdog stops world
  -> recovery_required
  -> operator inspects durable records
  -> finalize --acknowledge-uncertainty
```

- Never re-dispatch an action or re-sample a missing response automatically.
- A prepared action without a completion is unknown, including the possibility that it never started.
- Keep known outputs/results and reserved spend, but do not infer completion from a file's existence.
- Finalization records the listed uncertainties without rewriting them as successful operations.
- The interrupted episode is not resumable in version one. The operator can preserve/export it and explicitly create a later episode; this is not transparent continuation or a way to hide failed trials.

Recording exec identities is useful; reconciling them into automatic crash continuation is deferred. Durable pre-effect logs, watchdog stopping, and at-most-once dispatch are not deferred.

## 12. Lifecycle and watchdog

Use explicit states such as `created`, `ready`, `running`, `stopping`, `stopped_clean`, `completed`, `recovery_required`, and `finalized`, with separate reasons and legal transitions.

- Only verified clean stops support resume with unchanged configuration and world identity.
- Before resuming, print remaining ticks, absolute-deadline time, conservative spend allowance, and discontinuities. Refuse expired/exhausted limits without sending a request.
- Preserve the original absolute deadline across pauses. Use monotonic timers during execution and persisted UTC clock evidence across restarts; suspicious clock changes require review.
- Resample observations and clearly mark process restart, as specified in Section 8.
- Changed model/prompt/seed/configuration creates a new declared episode, not a retry.
- Read-only status/inspection never mounts, repairs, starts, or resumes the world implicitly.

On SIGINT/SIGTERM or a stop request, stop scheduling, cancel/wait within defined limits, record known outcomes, and stop the container. Write a clean checkpoint only when operations are resolved and the world stop is verified. Otherwise enter the interrupted contract. Do not delete storage.

The watchdog is a separate process without the provider credential. It has only the selected Docker context/engine identity, exact managed resource IDs, heartbeat lease, deadline, and needed control access. On expiry it stops the owned world and records verified/unknown stop status in a separate `watchdog.jsonl`; it must not race on the controller's ledger or checkpoint.

Validate ownership before cleanup. No global prune or stopping unrelated containers. Test controller SIGKILL, application/engine restart, and relevant host sleep/resume behavior on the supported environment. If the engine is unavailable, stop status is unknown. The watchdog is defense in depth, not a guarantee against simultaneous controller/host/manager failure; kernel/storage limits remain necessary.

Stop reasons distinguish operator action, budget/deadline/tick/record capacity, protocol threshold, provider failure, world exit/OOM, safety intervention, engine loss, watchdog expiry, and uncertainty/corruption. None is automatically described as organism mortality.

## 13. Artifacts and reproducibility

### 13.1 Private run store

Outside the checkout and world mounts:

```text
runs/<run-id>/
  manifest.json
  resolved-config.json
  prompt.txt
  events.jsonl
  watchdog.jsonl
  checkpoint.json                # resumable only after verified clean stop
  blobs/                         # bounded payloads
  archives/                      # initial/final /world artifacts and manifests
  annotations.jsonl              # never model input
  report.json
worlds/<world-id>/
  metadata.json                  # validated backend identity, not arbitrary path authority
```

Use restrictive permissions and allowlisted SDK logging fields. Never store auth headers or raw secret-bearing exceptions. Preserve exact model-visible inputs privately when safe; mark redacted exports as different artifacts. Capture limits apply to the observer store too: stop before continuing unrecorded, and never advertise truncated traces as complete.

### 13.2 Stopped-world artifact archives

Version one needs a bounded file archive, **not** a block-device image, full filesystem snapshot, or mounted ext4 clone.

- Capture initial seeded contents before first start, and final contents after a verified stop with no remaining world writers.
- Use a trusted capture implementation through the verified backend—e.g. a pinned constrained helper with a read-only data mount where supported. Do not run an agent-provided archive script or assume a daemon-side path exists on macOS.
- No new world writes, symlink following, or implicit repair. Verify read-only/access-time behavior; document any metadata effects rather than claiming perfect non-interference.
- Produce an archive such as tar plus a manifest: paths/types, sizes, modes, available metadata, hashes, capture method/time, and declared omissions/errors.
- Bound bytes, entries, depth, time, and sparse-file expansion. Treat special files, links, malformed names, and embedded terminal controls as hostile. A file archive need not preserve every filesystem property; state its coverage.
- Prefer bounded streaming/indexed reads from the archive to general-purpose extraction. If extraction is needed, confine it to a fresh restricted destination, reject absolute/traversal paths and escaping links, and never materialize device nodes or execute contents.
- Label incomplete/unclean captures honestly. A crash archive is not evidence that the world was healthy or fully flushed.

Browsing an already captured archive does not modify the source world. Capture/stopping still consumes time and may affect metadata; record interventions separately. Do not mount copied filesystem images or claim a live recursive copy is a point-in-time snapshot.

An artifact archive supports inspection and reproducing file-level starting conditions, not restoration of inode layout, arbitrary process memory, or deterministic world execution. Do not silently restore it during a run.

### 13.3 Reproducibility and publication

- **Inspection:** reads recorded events/artifacts; no inference or action replay.
- **Rerun:** creates a fresh world from frozen initial conditions; outputs may differ.
- **Resume:** continues only a verified cleanly stopped episode with its limits intact.

Review exports for secrets, personal data, unsafe generated files, third-party content, and applicable provider terms. Do not deploy a generated filesystem as active website content. Link observations to stable run/tick/artifact identifiers and preserve failures as well as successes.

## 14. CLI and operator workflow

Proposed interface:

```text
alife doctor --docker-context <name>
alife config validate <file>
alife world create --config <file> --docker-context <name>
alife world inspect <world-id>
alife run start --world <world-id> --config <file>
alife run status <run-id>
alife run stop <run-id>
alife run resume <run-id>
alife run finalize <run-id> --acknowledge-uncertainty
alife run capture <run-id>
alife observe list <run-id> --archive <archive-id> [path]
alife observe read <run-id> --archive <archive-id> <path>
alife run export <run-id> --output <directory>
alife world destroy <world-id> --confirm <world-id>
```

Use `npm --prefix runtime run alife -- ...` during development, not an unrelated package resolved by `npx alife`.

- `doctor` is non-destructive; destructive quota/process tests require explicit integration-test invocation against disposable resources.
- `world create` uses a verified backend and reports any explicit provisioning prerequisites. No silent privilege escalation or unbounded fallback.
- Live starts require paid-inference acknowledgement and print model, context, limits, state location, and Docker/world identity. Fake runs need no key.
- Stops use authenticated local ownership/control state, not blindly signaling a potentially recycled PID.
- Resume reports remaining budgets and fresh observations; no `--force` to hide uncertainty.
- Finalize acknowledges specific unknown actions/requests, verifies stop status where possible, and closes the interrupted episode without making it resumable.
- Capture requires a stopped world and never implicitly stops a live one. Initial capture can be associated during run preparation; final capture failures remain visible.
- Destroy requires exact ID, no active owner, and confirmation. Preserve run records separately.

Document an offline quickstart, OrbStack setup, the capability/support matrix, one small live example, credential handling, stopping, manual interruption handling, and exports. Provide machine-readable status alongside escaped human-readable output.

## 15. Acceptance and testing

Use pure tests, Docker integration tests on verified environments, and a manually enabled live-provider smoke test. No provider key in ordinary CI and no privileged self-hosted runner for untrusted fork PRs.

| Area | Acceptance gate |
| --- | --- |
| Config/capabilities | Unknown settings, wrong engine identity, missing bounds, and unresolved placeholders fail before inference. |
| Docker portability | OrbStack works through the selected context; no hard-coded VM/socket paths. Other environments get separate verified/unverified records. |
| Provider contract | Serialized requests exclude hidden state; mock transport counts prove no retries/extra turns under 429, timeout, malformed output, or connection failure. |
| Prompt/context | Exact prompt/schema snapshots, complete tool exchanges, deterministic eviction, and no archive reinjection. |
| Context calibration | Measure retained exchanges, eviction onset, and projected costs; record calibration separately from pilot evidence. |
| Intentions | Wait/refusal/text are valid; malformed or multiple actions execute nothing. |
| Execution boundary | Shell metacharacters affect only the container, never a controller shell. |
| Credentials | Dummy controller secrets absent from world, helper/watchdog environments, and exports. |
| Network/privilege | Denied outbound routes, protected-root writes, and access to host authority. |
| Storage | Genuine block/inode-or-file-limit exhaustion; persistence after recreation/restart; missing backend cannot fall through to an unbounded directory. |
| Resource escape paths | Temporary mounts, Docker logs, memory, CPU, descriptors, and PID limits are bounded and enforced. |
| Execution lifetime | Wait expiry returns a still-running job without terminating it; later ticks can inspect or terminate jobs without redispatch. Output and job metadata remain bounded, shared world resource limits hold, and ordinary wait expiry never stops the episode. |
| Clean stop/resume | File/history/counter continuity, no process-continuity claim, remaining budget display, fresh resume listing/discontinuity observation. |
| Crash boundaries | Kill controller around requests/actions/checkpoints: no automatic resume/replay, uncertainty retained, explicit finalization required. |
| Ownership/watchdog | Reject duplicate ownership; SIGKILL triggers bounded watchdog stopping of only owned resources; engine loss is reported honestly. |
| Accounting | Reservations persist through errors/stops; unknown usage remains conservatively charged; no uncovered billable category. |
| Evidence | Truncated logs, failed writes, inconsistent checkpoint markers, and record-capacity exhaustion cause safe halt/review. |
| Artifact archives | Stopped-world capture, bounded metadata/content handling, traversal/link/special-file defenses, no source payload writes, incomplete archives labeled. |
| Seeds/control | Fixed seed hashes and prompt variants; no task sentence accidentally retained in the no-task condition or contradictory final sentence in the control. |
| Independence | Website install/build/deployment remain independent of the runtime package. |

Run finite resource stress tests against disposable isolated resources/environment, not valuable developer workloads. Passing normal unit tests is not proof of sandboxing. A paid smoke test verifies API/tool/usage compatibility, not emergence.

## 16. Phased implementation

### Phase 0 — Verify Docker capabilities and dangerous assumptions

**Deliverable:** tested OrbStack-first support matrix and small storage/execution prototypes, without model credentials.

- Discover the selected context/engine and test actual isolation/resource enforcement.
- Evaluate persistent bounded storage candidates; select the simplest backend satisfying Section 7 instead of assuming host-mounted ext4.
- Prove exhaustion, persistence, attach identity, readonly capture, and all writable-path bounds.
- Test background work, exec completion, inherited pipes, continuing jobs across wait expiry, agent-requested termination including daemonized descendants, and app/engine restart behavior.
- Record any backend-specific privileges/setup and explicit alternatives if a requirement is unavailable. Do not claim Docker Desktop/Linux support until verified; do not reject them by application name.

**Gate:** real bounds, persistence, safe execution/stop, and artifact capture demonstrated on the chosen environment. No weaker placeholder backend downstream.

### Phase 1 — Scaffold and contracts

**Deliverable:** separate package, config/CLI/interfaces, schemas, fake dependencies, IDs, ownership, and state machine.

- Add scripts, lockfile, ignore rules, safe state directories, and credential-free CI.
- Define versioned manifests/events, strict profile validation, and request invariant checks.
- Update repository guidance only when runtime commands actually exist.

**Gate:** unsafe config fails early, fake unit tests pass, website remains independent.

### Phase 2 — Bounded Docker world

**Pre-implementation spike:** required for the approved continuing-job and conditional message-queue policies. Verify continued execution across wait expiry, stable inspection without replay, bounded output/admission, explicit cancellation scope, shared resource limits, and message-queue accounting/isolation or effective disabling. Use disposable labelled resources; do not reuse unsafe Phase 0 cleanup.

**Spike status: complete on the tested OrbStack environment.** See [`phase-2-implementation-handoff.md`](phase-2-implementation-handoff.md) and `runtime/spikes/phase2/{jobs,mqueue}/RESULTS.md`. Thirteen jobs checks and seven queue checks establish a feasible implementation direction, not completion of the full Phase 2 gate:

- Retain/drain foreground exec attachments across ticks. Wait expiry is not a disconnect or execution deadline. Detached descendants require explicit output handling; root completion does not prove descendant completion.
- Provide agent inspection and explicit process/signal control with honest scope. Process-group termination does not guarantee all descendants stopped; do not implement the old heuristic tree-kill policy.
- Private IPC did not isolate shared-UID message-queue accounting. Use the verified disabling fallback: zero soft/hard `RLIMIT_MSGQUEUE` in fresh private IPC namespaces under the tested non-root/no-capability restrictions. This blocks queue creation, not access to or visibility of the mount; reverify on other environments.

**Implementation status: implemented and verified on OrbStack** (2026-09-25). See [`phase-2-implementation-results.md`](phase-2-implementation-results.md) for what exists, the verification record, engineering findings, and what remains unverified (other Docker environments, engine restart, real crash-dirty filesystems).

**Deliverable:** pinned image, verified storage implementation, sensors, bounded waiting and job management, and archive capture primitives.

- Update Phase 1 execution contracts and versioned profiles to match §8.3 before using them.
- Implement the Phase 0 backend through the context-aware interface.
- Implement attach/start/stop without automatic destruction or data repair.
- Add fixed `empty-v1` and draft `sparse-v1` fixtures; validate permissions and content provenance.

**Gate:** isolation/resource/persistence/job-lifecycle tests pass, including continued work across wait expiry and bounded job/output management; engineering artifacts are inspectable without inference.

### Phase 3 — Durable loop with fake cognition

**Implementation status: implemented and verified on OrbStack with the fake mind** (2026-09-26). See [`phase-3-implementation-results.md`](phase-3-implementation-results.md) for what exists, the verification record, packing measurements, and the perception and lifecycle decisions awaiting review. Seed and control-prompt freezing remain operator decisions.

**Deliverable:** tick loop, prompt/context policy, effect records, simple reservations, and clean-stop checkpoints.

- Test shell, wait, refusal, invalid output, error feedback, and context eviction.
- Implement interrupted-run detection/finalization, not automatic replay or exec-ID reconciliation.
- Freeze seed contents/control prompt before pilot collection; measure packing mechanically with representative fixtures.

**Gate:** scripted actions write/read persistent files across ticks and context eviction, with every attempted effect accounted for and no hidden memory service.

### Phase 4 — Safety and operator inspection

**TDD handoff:** [`phase-4-tdd-implementation-plan.md`](phase-4-tdd-implementation-plan.md) defines the implementation contract and fixed completion gate. See [`phase-4-tdd-verification.md`](phase-4-tdd-verification.md) for the RED baseline and `phase-4-acceptance-manifest.json` for frozen test/helper hashes. Production implementation and permission-gated Docker verification remain outstanding; skips do not establish completion.

**Deliverable:** clean stop/resume, external watchdog, explicit interruption finalization, bounded initial/final artifact archives, and export.

- Inject crashes at effect boundaries and verify no resumed/repeated action after interruption.
- Verify budgets/identity/fresh observations on clean resume.
- Exercise safe capture, archive browsing, ownership, and exact-ID destruction.

**Gate:** an operator can stop, inspect, resume a clean episode, or finalize an interrupted one without editing records by hand. No filesystem-image snapshot mounting or recovery engine required.

### Phase 5 — One live model and first runnable milestone

**Current direction:** [Phase 5 operator decisions](phase-5-policy-decisions.md) supersede the earlier OpenAI/provisional-output assumptions: Anthropic API / Opus 5.5, high effort, model-supported output maximum, 1M combined context and $100 shared smoke budget. [The TDD implementation plan](phase-5-tdd-implementation-plan.md) defines the new adapter, explicit bounded reasoning continuation, campaign ledger and completion contract. Its [acceptance gate is now frozen](phase-5-tdd-verification.md), with hashes in `phase-5-acceptance-manifest.json`; production implementation is next, and live evidence remains separately tracked from offline completion.

**Deliverable:** tested adapter, verified conservative cost bound, paid acknowledgement, and a very small explicitly approved smoke run.

- Prove request/transport invariants and credential isolation with fixtures first.
- Choose model, verify billable bounds, and execute the opt-in smoke only after safety gates.
- Record retained context, timing, and cost to calibrate the planned horizon; keep this separate from pilot results.

**Gate:** fake-tested core works with real tools/usage and truthful bounded records. **This is the first runnable system**, not a claim of demonstrated autonomy.

### Phase 6 — Reproducible release

**Deliverable:** clean-checkout walkthrough, verified support matrix, troubleshooting, and complete example configuration.

- Test the documented OrbStack path; add other environments only after verification.
- Run offline acceptance checks and preserve the live smoke record/limitations.
- Populate Configuration only with implemented verified settings; remove its site exclusion and add sidebar ordering then. Leave Experiments unpublished until a report exists.
- Update human/agent contributor guidance without altering website runtime/deployment.

**Gate:** another developer can perform the offline and small paid walkthrough under declared prerequisites.

### Phase 7 — Narrow pilot and report

**Deliverable:** frozen protocol, complete six-trial inventory, observation rubric, costs, limitations, and reviewed public artifacts.

Use the runtime already built. Do not turn the first pilot into a population platform or full ablation matrix.

## 17. First pilot protocol

### Fixed comparison

Use the same image, `sparse-v1` seed, body, exposed context-usage sensor, context policy, model/parameters, and resource/operator limits across both conditions:

1. **No assigned task:** Section 9's baseline prompt.
2. **Assigned task:** replace only its final sentence with this task:

```text
Create /world/catalog.py that inventories the regular files under /world/materials.
Write /world/catalog.json as an array sorted by relative path, with each file's
relative path, byte size, and SHA-256 hash. Do not modify the source materials.
Run the program twice and verify that unchanged materials produce the same catalog.
If the materials directory is absent, produce an empty array.
```

The control checks that the interface supports a coherent project, not that it sustains self-generated purpose. Completion followed by waiting is valid, not inferior behavior. No grader feedback or reward is sent into either world. Freeze these exact rendered prompts before any pilot no-task run; do not tune the task in response to pilot behavior.

### Trial size and horizon

Start with three independent trials per condition, each with a fresh world. Interleave/randomize order where practical, record the ordering method, and disclose provider changes/incidents. Initial caps are 200 ticks, 30 minutes elapsed wall time, and the approved per-run spend bound, whichever stops first. These are provisional until engineering calibration and budget approval; freeze the final values before all pilot trials.

One-second minimum cadence is not a one-second tick duration. Report actual completed ticks, elapsed time, context retention/evictions, and which cap bound each run. “Sustained” means within that observed horizon, not lifelong autonomy. This is a feasibility pilot, not a powered statistical demonstration.

Set an aggregate budget before running the six trials; every request must fit both run and remaining batch allowance. Stop launching trials after an operator stop or exhausted batch budget. Do not extend caps selectively for more interesting runs.

### Frozen observation rubric

Before collection, define annotation fields for:

- A candidate project and the first supporting statement/action/artifact.
- Revisited or extended activity on separated ticks, with exact IDs and separation recorded rather than a vague persistence score.
- External memory/tool creation **and later use**; writing alone does not establish useful memory.
- Encountered information, follow-up investigation, and response to constraints.
- Repetition, waiting, refusal, abandonment, damage, and absence of discernible projects.
- Context eviction, interruptions, and operator/infrastructure reasons limiting interpretation.

Keep uncertain labels available. Separate raw counts from interpretations. Where feasible have a second reader review traces without condition labels, while acknowledging the task may be inferable from behavior. No annotation is a reward or feedback to the agent.

### What this pilot cannot establish

The comparison does not isolate causal effects of persistence, seed richness, context size, or sensor salience. It also does not prove intrinsic motivation independent of model priors and prompt framing. Publish all uneventful/failed trials; do not stop boredom early except under predeclared rules.

Follow-ups should vary one clearly defined factor at a time:

- `empty-v1` versus the frozen sparse seed: environmental content/affordances, not a neutral-versus-biased world.
- Exposed versus unexposed context-usage signal: a perceptual choice, with private measurement held constant and prompt differences declared.
- Smaller context budgets versus the 1M baseline: context pressure, with actual retention and spending/horizon differences accounted for.
- Persistence intervention: design separately. Read-only worlds remove writable affordances; resetting files destroys consequences; restarting containers also destroys processes. These are different interventions, not interchangeable “no persistence” controls. Define background-process/open-handle handling and truthful prompt wording before implementing one.

Availability of these variables does not make a factorial design a first-release requirement.

### Report

Publish question/setup, exact prompts/seeds/configuration, trial ordering, all outcomes/stops/costs, stable trace/artifact references, observations versus interpretations, deviations, and limitations. State model priors, seed suggestions, finite horizon, context/sensor choices, restricted permissions/network, absence of an independent reproduction mechanism, provider nondeterminism, and operator interventions.

Only then populate/publish Experiments. A goal statement is not subjective purpose; coherent work is not automatically autopoiesis; a persistent process is not proof of open-endedness.

## 18. Risks and trade-offs

| Risk | Required response |
| --- | --- |
| Desktop-application assumptions hide unsupported storage | Capability/enforcement tests and explicit backend status; no platform-name guarantees or blanket exclusions. |
| Fake quotas / escape paths | Prove write-time bounds and audit all writable mounts/logs before live runs. |
| Container or helper compromises host authority | No secrets/socket/host data in world; constrained helpers, disclosed privileges, isolated stress testing. |
| Implicit goals from framework, prompt, or seed | Small explicit loop, frozen artifacts, no intentionally implied repair task in sparse seed. |
| Context too small or spend too low to observe continuity | Mechanical calibration before collection; report retention and stopping horizon without outcome-driven tuning. |
| Duplicate effects / lost responses | Durable pre-effect evidence; end interrupted episodes, never replay. |
| Run outlives controller | Independent watchdog plus verified kernel/storage bounds; record unverifiable stops. |
| Archive reader executes or escapes through artifacts | Bounded read-only handling, no generic unsafe extraction or active-content rendering. |
| Claimed precision exceeds evidence | Retain unknown costs/results and archive omissions; separate interpretations. |
| Excessive engineering or experimental scope | One backend/adapter/profile first, simple finalization/archives/pricing, narrow two-condition pilot. |

## 19. Decisions to confirm at their gates

1. **Docker capabilities and storage, Phase 0:** OrbStack is the first test environment. Select a verified bounded persistent backend and document alternatives, rather than requiring a desktop application or separate VM upfront.
2. **Execution lifetime, approved policy; Phase 2 verification:** bound waiting rather than job duration. Leave job/resource management to the agent within enforced world limits. Prove continuing-job tracking, inspect/terminate behavior, bounded output/metadata, and safe whole-world stopping for overall limits or loss of control—not ordinary wait expiry.
3. **World/body profile, Phases 2–3:** approve inventory, exact seeds, sensors, operator-selected 1M total context (approved), and safe resource limits. The plan defines the control task; finalize its rendered prompt before collection.
4. **Provider and money, Phase 5:** select model/account, verify API and upper billing rate, and authorize smoke spending. Example dollar limits are not authorization to spend now.
5. **Frozen pilot, before Phase 7:** approve calibrated context/horizon, shared sparse seed, unchanged control task, rubric, six-trial ordering, and aggregate budget. Defer ablations rather than quietly adding conditions.
6. **Publication:** review provider/data terms and redacted exports before releasing results.

## 20. Immediate next actions

1. Review the revised scope and Docker capability contract.
2. Perform explicitly approved offline Phase 0 probes on disposable OrbStack resources; no model key or paid call needed.
3. Record the actual storage/execution support matrix and implement the small runtime against it.
4. Build fake-model loop, clean stop/resume, manual interruption finalization, watchdog, and artifact archives.
5. Obtain model/budget approval for the first live smoke, then freeze the separate pilot protocol.

Saving this plan does not start implementation, provision infrastructure, invoke a model, publish content, stage files, or create a commit.
