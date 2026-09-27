# Phase 2 implementation handoff

## Status and scope

**The targeted pre-implementation spike is complete. Proceed with Phase 2
implementation, not with paid inference or the pilot.** The complete Phase 2
isolation/storage/job/capture gate is not yet passed.

The operator requested this spike in the current session and will hand production
implementation to another agent session. This session added standalone probes,
reports, and planning updates only; it did not implement a runtime backend.

Read first:

- `AGENTS.md` and `runtime/AGENTS.md`.
- `.plans/first-runnable-system.md`, especially §§7.3, 8.3, and Phase 2.
- `runtime/spikes/phase2/jobs/{README,RESULTS}.md`.
- `runtime/spikes/phase2/mqueue/{README,RESULTS}.md`.

The original seven Phase 1 findings and the subsequent `__proto__` evidence-loss
case were fixed and verified before this spike. `.plans/phase-1-implementation-findings.md`
is the historical finding list, not the current unresolved backlog.

## Approved user intent — do not undo these decisions

1. **Docker is the world runtime, not a particular desktop application.** OrbStack
   is the tested environment; other implementations need capability verification.
2. **Persistent bounded storage:** fixed-size ext4 image in a Docker-managed volume,
   attached through a privileged helper outside the unprivileged agent container.
   Keep agent access to the backing image, Docker control, host files, and helper
   authority impossible. Privileged execution must remain explicit, never implicit.
3. **Long-running work belongs to the agent.** Bound the harness's waiting time,
   not job execution duration. Return control with a stable job identity and a
   still-running status; do not kill work or end an episode merely because a wait
   expired. Jobs compete within shared world resource limits. The agent may inspect
   and terminate processes/jobs. Overall episode limits, operator stop, emergencies,
   and loss of safe control can still stop the world.
4. **POSIX message queues:** allow only if safe resource bounds and cross-world
   isolation are verified; otherwise disable. The spike found shared-UID accounting
   interference, so use the verified zero-budget creation-denial path below.

## Spike results and selected engineering direction

### Continuing jobs: retain the exec attachment across ticks

The final jobs run passed 13 checks. Two foreground execs continued independently
of the waiting limit, consumed one shared memory/CPU/PID budget, and were later
observed by their original exec IDs without replay. Output flooding was drained
with bounded retained payload. New-job admission was rejected before dispatch
when the prototype's two-job capacity was occupied.

Recommended backend primitive: create and durably identify an exec, start it once,
keep draining its output asynchronously, return running/completed/uncertain state
after a bounded wait, and later inspect the same identity. Do not close an exec's
attachment just to return from a tick.

Important constraints:

- Container exec root completion is not descendant completion. A background writer
  inheriting pipes after the shell exits can lose output or block; the observed
  writer remained alive in `anon_pipe_write`. This was not a wait-expiry kill.
- Launch ordinary long jobs as foreground commands through the asynchronous body;
  `&` is unnecessary. Deliberately detached work should redirect output into the
  bounded world filesystem or another declared supported endpoint.
- Signal scope must be honest. A process-group SIGTERM killed the root group but
  not a `setsid` descendant. The agent UID could separately signal that survivor
  via a pidfd, and init reaped it. Do not promise an all-descendants kill or revive
  heuristic tree killing. A stronger cancellation contract requires further proof.
- Spike limits (two tracked jobs, 4 KiB output tails per stream, 96 MiB memory) are
  engineering test values, not frozen world/pilot settings. The existing head-output
  profile must not silently become a tail-output profile.
- Specify bounded completed-job retention, collector count, output accounting,
  inspection responses, and observer evidence. Root job-slot release does not
  remove detached processes: world PID/memory/CPU limits still constrain them.

### Message queues: disable creation with a zero hard limit

Private IPC isolated queue names but not real-UID accounting. Filling a tiny queue
budget in one UID-1000 world blocked creation in another; unlinking the first
world's queues immediately restored the peer's ability to create a queue.

Use a fresh private IPC namespace with `--ulimit msgqueue=0:0`, non-root UID,
all capabilities dropped, and no-new-privileges. The strengthened final spike
verified denial for normal and minimal-size `mq_open`, ordinary filesystem
creation in `/dev/mqueue`, and attempts to raise the limit. The namespace stayed
empty. The test's errno was EMFILE, not necessarily EACCES.

**Do not call this a read-only or removed mount.** `/dev/mqueue` still reports
writable; the actual queue-creation paths fail. No preexisting queues, passed file
descriptors, shared namespaces, or privileged bypass are supported by this result.
Keep those excluded and verify the effective limit on every supported backend.

## Suggested implementation order

1. **Update contracts/configuration before implementing execution.** Review
   `src/core/contracts.ts`, `src/config/schema.ts`, `src/config/profiles.ts`,
   `src/core/tools.ts`, fixtures, prompts, and tests. Replace action-execution
   timeout semantics with waiting semantics and explicit job lifecycle states.
   Add/version behavior rather than silently editing an established profile.
   Provider request timeouts are separate and unchanged by this decision.
2. **Build the pinned world image and explicit engineering profile.** Select tools,
   non-root identity, init/reaper, resource ceilings, and seeds. Explain which
   settings are provisional; do not represent them as a frozen research baseline.
3. **Implement storage lifecycle under ownership.** Provision only on explicit
   creation. Verify engine, backend, mount identity, and safe options before start.
   Reattach after restart without reformatting/reseeding. Fail closed when ownership,
   stop, unmount, or detach cannot be established; preserve backing storage.
4. **Implement asynchronous job primitives.** Durable pre-dispatch records, stable
   identity, bounded wait, continuous bounded collectors, admission control,
   status/output inspection, truthful explicit signalling, and lifecycle cleanup.
   No implicit command retries, replay, or cognition.
5. **Implement sensors and seeds.** Include job/process state as an explicitly
   versioned observation choice. Keep `empty-v1` and draft multi-use `sparse-v1`;
   do not introduce implied tasks. Model-facing tools/observation packing are
   integrated in Phase 3, not an excuse to hide behavior now.
6. **Implement bounded stopped-world capture.** Stop/identity checks are admission
   conditions under lifecycle ownership, not postconditions. Bound helper lifetime,
   memory, archive bytes, and output backpressure; killing a Docker CLI alone does
   not prove its container stopped. For dirty ext4, explicitly reject or use a
   separately reviewed immutable capture/recovery procedure: `ro` alone does not
   promise no journal replay.
7. **Run disposable integration tests for the full Phase 2 gate.** Cover block/inode
   exhaustion, persistence, mount mismatch/refusal, restart/reattach, all writable
   surfaces including queue-creation denial, concurrent jobs, output floods,
   cancellation scope, init/reaping, and safe capture. Approval for a backend does
   not authorize restarting the user's Docker environment or unrelated workloads.

## Phase 3 interface considerations

A shell call can return a complete tool result saying “still running” with a job
identity. Later status/output belongs in explicitly defined subsequent observations
or inspection results, not a second orphan tool result or a rewritten earlier tick.
Observer records should distinguish submission, ongoing execution, and eventual
completion. Ticks may continue while jobs live; model invocations themselves remain
serial. Agent-visible inspection/termination must be usable through declared tools
or shell facilities, not an observer-only operator API.

## Known work not solved by this spike

- The old Phase 0 probe has unsafe cleanup paths. **Do not rerun or copy that cleanup
  without fixes.** These new probes use independent, exact-ID/label-checked cleanup;
  they do not remediate the old probe.
- Phase 0 wrong-backend detection is not proof of integrated start refusal.
- No privileged storage helper was run in this spike. Persistent storage integration
  remains Phase 2 work; the jobs fixture used bounded, disposable tmpfs only.
- No controller SIGKILL, watchdog, forced engine loss, or output-recovery guarantee
  was tested. Those need their declared integration/Phase 4 work.
- Other Docker environments, arbitrary job scales, full controller-resource bounds,
  provider adapters, and paid runs remain unverified.

## Evidence and reproduction

From repository root, with the recorded local image available:

```sh
node runtime/spikes/phase2/jobs/probe.mjs
python3 runtime/spikes/phase2/mqueue/probe.py
```

Each command creates bounded labelled disposable containers, writes raw results
outside the checkout, and removes only its own verified resources. No model key,
network pull, host bind, privileged helper, or daemon restart is needed.

The reviewed session evidence is preserved in the private local directory:

`~/.local/state/alife-spikes/phase2-6oam3ilp/`

`manifest.json` contains hashes for final/prior/failed-expectation results and
snapshots of both final probe sources. These local files are not committed or
published. The final jobs evidence is `jobs-final.json` (13 checks); final queue
evidence is `mqueue-final.json` (7 checks, including the measured isolation failure
and successful disabling fallback). A passing negative-control check does not
mean the unsafe behavior is supported.

## Verification completed in this session

- Final jobs spike: 13/13 checks; final message-queue spike: 7/7 checks.
- Archived evidence hashes and both current probe-source identities verified.
- `docker ps --all` filtered by each Phase 2 probe label returned no containers.
- On Node.js 24.14.0: runtime typecheck, lint, all 80 unit tests, build, and compiled
  fake-configuration CLI validation passed. These checks do not include the
  standalone spike sources; their syntax and actual execution were checked separately.
- No website source changed; website build and UI checks were not run.

## Handoff boundary

No production runtime implementation, live agent experiment, model call, staging,
or commit was performed. Preserve the operator's job-management policy and do
not infer spending or disruptive-infrastructure approval from this handoff.
