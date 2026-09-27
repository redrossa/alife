# Observed results

## Decision

**Do not leave POSIX queue creation enabled for shared-UID worlds.** Private IPC
isolates queue names, but does not isolate this configuration's real-UID resource
accounting. Recommend `--ulimit msgqueue=0:0` for fresh private-IPC worlds under
the tested capability/user restrictions. This spike makes no production change.

## Execution

Explicit Docker context: `orbstack`; server version: 29.4.0. Local image:
`sha256:4071ad814ce2464e271f2fb26f2beb0115c35495bc5635dcdc253cbdf7cbb64f`,
Linux/arm64. Latest run `dd25a9550c131977` took 3.28 seconds, using the same
bounded nonprivileged configuration as the previous runs.

Seven checks completed successfully (including confirmation of the isolation
failure):

1. UID 1000 created a fresh queue with an 8192-byte soft/hard budget.
2. Four 128-byte sends succeeded; the fifth failed with EAGAIN.
3. Two private IPC namespaces independently created `/same-name`; the second
   namespace initially listed no queues from the first.
4. Seven additional queues succeeded, then allocation failed with EMFILE. At
   that point there were nine queues across the pair. Loads stayed deliberately
   small; this was not host stress testing.
5. The peer could not create `/peer-probe` while the first world held its queues
   (EMFILE). Unlinking the first world's queues immediately let the peer create
   that same name. This demonstrates cross-world shared-real-UID interference.
6. Stop/start of the same container ID removed both of its queues: they did not
   persist across this lifecycle transition.
7. In a fresh zero-budget container, actual mq_open failed with errno 24
   (EMFILE) for both 4-message/128-byte and minimal 1-message/1-byte attributes.
   Ordinary `os.open('/dev/mqueue/zero-file', O_CREAT|O_EXCL|O_WRONLY, 0600)`
   also failed with errno 24 (EMFILE). Any successful FD would be closed.
   Raising the soft/hard limits to 8192 was rejected; limits stayed zero and
   subsequent mq_open also failed with EMFILE. The queue namespace was empty
   before and after all attempts; the check asserts these creation failures
   and namespace emptiness. `/dev/mqueue` nevertheless reported `rw`, and UID 1000's
   `os.access(..., W_OK)` was true. This is enforced queue-creation denial, **not
   a read-only mount or blanket syscall/access denial**. Masking was unnecessary.

All three disposable containers were removed with verified IDs and run labels.
Final run-labelled `docker ps --all` returned no containers; no known resources
remain. No stronger privileges were required.

## Evidence and reproduction

Run from repository root:

```sh
python3 runtime/spikes/phase2/mqueue/probe.py
```

Latest historical raw JSON (private local artifact, outside the repository;
`<OS_TEMP>` replaces the machine-specific temporary-directory prefix):

`<OS_TEMP>/alife-phase2-mqueue-hjc63syi/evidence.json`

SHA-256: `379f215b40644e60ef2405f6a10ed77e99387dd0bf43c2ebd7e34faaefeffbc3`

Probe source SHA-256 (also stored in the raw evidence):
`7de56e817aebf21f8c9bc04f968e405b2a2367e0deee8685a2eeb62cc03069a9`

Previous run `f1ef1300b78e891f` completed seven checks in 3.25 seconds with
no remaining labelled containers, before adding the minimal and ordinary-open
cases and source hash:

`<OS_TEMP>/alife-phase2-mqueue-1wac_k24/evidence.json`

SHA-256: `1ce5d46385a2c88fea4c98f056f168d408733ccc32c3d211d0dd9a81b2bd8155`

An initial execution before strengthening final cleanup verification also
completed seven checks in 3.35 seconds with no cleanup errors:

`<OS_TEMP>/alife-phase2-mqueue-xf9107d8/evidence.json`

SHA-256: `f785cb5414922564ee733d6f444fc9cd90dc914d7ac4ac2a19a6798da6aa04bd`

Total: three executions, twenty-one check observations; seven check groups,
with the latest zero-budget group strengthened by two alternate creation paths.

## Preserved session evidence

The parent verification session copied all three executions and the final probe
source into the private directory `~/.local/state/alife-spikes/phase2-6oam3ilp/`.
The strengthened result is `mqueue-final.json`; `manifest.json` records file hashes.
These copies avoid reliance on OS temporary-file retention and remain outside the
checkout. See `.plans/phase-2-implementation-handoff.md` for combined conclusions.

## Limitations

These findings cover this image, engine/context, UID and container restrictions,
not all kernels, user-namespace configurations, or queue attribute combinations.
Zero budget was tested using four-slot/128-byte and one-slot/one-byte queues,
and ordinary file creation on mqueuefs, in a fresh empty IPC namespace. This is
not blanket filesystem or syscall denial. It does not claim to block operations
on preexisting queues or passed
file descriptors; no IPC sharing or external namespace holder was tested.
Stop/start was tested without an external namespace holder. No daemon restart,
production resources, host-pressure workload or privileged bypass was attempted.
Shared UID budget interference was confined to the disposable pair in the test;
private IPC alone cannot guarantee its accounting will not affect other same-UID
workloads in the VM. No exhaustive host-wide impact audit was performed.

Only this standalone Python spike was exercised. Runtime npm typecheck, lint and
unit tests were not run; no production TypeScript or package files were changed.
Evidence lives in OS temporary storage and may be removed by OS housekeeping.
