# Phase 2 continuing-job spike

Standalone engineering prototype, not a runtime backend or an agent loop.

```sh
node runtime/spikes/phase2/jobs/probe.mjs
```

Requires the explicit local `orbstack` Docker context and the already-local image
`sha256:4071ad814ce2464e271f2fb26f2beb0115c35495bc5635dcdc253cbdf7cbb64f`.
No image pull/build, provider call, privileged helper, host bind mount, daemon
restart, or Phase 0 helper is used. Docker subprocesses receive only PATH/HOME.

## Scope and safety

Each execution creates one uniquely named, labelled disposable container:

- UID/GID 1000, all capabilities dropped, no-new-privileges, read-only root.
- No network, Docker logging disabled, no restart policy, private IPC.
- 96 MiB memory with no additional swap, 0.5 CPU, 64 PIDs, 128 descriptors.
- 16 MiB `/world` tmpfs, 8 MiB `/tmp`, 4 MiB shared memory; msgqueue soft/hard zero.
- Docker `--init` reaps orphan processes. This is an explicit tested profile choice.

**This tmpfs is only an erasable test fixture. It is not the persistent storage
backend or a fallback for it.** No storage quota/persistence claim is made here.

Two tracked root exec jobs are admitted concurrently. A third request is rejected
before exec creation. The two-job cap is a test setting, not a proposed pilot
setting. Normal wait expiry never terminates a job. Explicit cancellation tests
send signals inside the disposable container only.

Engine API calls have deadlines and bounded JSON replies. Stream demultiplexing
is incremental: no entire Docker frame is buffered. Each stdout/stderr stream
retains its latest 4096 bytes and counts/discards the rest. Retained payload bounds
are not a claim about fixed total Node.js RSS or CPU overhead. The tail policy is
an engineering choice, not approval to silently change the runtime's head profile.

The whole spike has a 120-second safety deadline, distinct from the proposed
agent execution semantics. Cleanup verifies the exact container name, full ID,
and this run's label before force-removing it, including after partial setup.
Cleanup failures are reported; unrelated resources and host paths are not removed.

Raw evidence and a pre-dispatch fsynced exec journal are written to a new OS
temporary directory outside the repository. stdout prints the result path/hash.
See `RESULTS.md` for preserved evidence and caveats. No runtime source imports.

## Checks

1. A bounded wait returns while the same exec remains running.
2. Later inspection observes completion without replay (a counter stays at one).
3. Concurrent jobs consume one shared world budget.
4. CPU throttling is observed and admission prevents a third dispatch.
5. Output production after wait expiry does not stop the job.
6. An 8 MiB stdout / 4 MiB stderr flood is drained with at most 8 KiB retained.
7. Negative control: inherited output after the root shell exits is not reliable.
8. Background work with redirected output survives root-shell exit.
9. Disconnecting an attach stream is not cancellation.
10. A disconnected job can still be inspected without replay.
11. Process-group cancellation does not kill an escaped `setsid` descendant.
12. The agent UID can explicitly signal that descendant using a pidfd; init reaps it.
13. The world remains running after the wait and cancellation cases.

The probe is intentionally not a durable controller, watchdog, recovery system,
provider adapter, generic kill-tree implementation, or job-control tool API.
