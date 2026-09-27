# Phase 2 POSIX message queue spike

Standalone prototype only. No production runtime imports or changes.

From the repository root:

```sh
python3 runtime/spikes/phase2/mqueue/probe.py
```

Requires Python 3, Docker CLI, the explicit `orbstack` context, and the already-local
Linux/arm64 image `sha256:4071ad814ce2464e271f2fb26f2beb0115c35495bc5635dcdc253cbdf7cbb64f`.
It never pulls an image. Docker subprocesses receive only PATH/HOME and argument
arrays. No host binds, credentials, network, helper privileges, or model APIs.

Each run creates unique labelled disposable containers, at most two concurrently.
They run as 1000:1000 with all capabilities dropped, no-new-privileges, read-only
root, network none, log-driver none, restart no, private IPC, 64 PIDs, 0.5 CPU,
64 MiB memory and equal memory-swap. No tmpfs is needed. Message queue soft/hard
limits are 8192 bytes for observation and zero for denial verification.

Python ctypes calls actual mq_open/mq_send. Allocation tests use four 128-byte
message slots; nonblocking sends and at most 16 attempts prevent unbounded loads.
The zero-budget case tests both 4x128 and minimal valid 1x1 attributes, plus
ordinary `os.open('/dev/mqueue/zero-file', O_CREAT|O_EXCL|O_WRONLY, 0600)`.
It records exact errno, closes any successful FD, and requires all creation
attempts to fail with the queue namespace still empty. Seven checks cover creation, message capacity, namespace separation,
allocation exhaustion, shared-real-UID interference, stop/start loss, and zero
budget plus attempted limit raise. A passing interference check means isolation
**failed**, not that the usable-queue policy passed.

Docker commands have a 12-second deadline, a 128 KiB combined output threshold
(polled every 30 ms; a producer may briefly overshoot), and bounded captured
output. Work has a 95-second budget, with cleanup through 115 seconds. Containers
also have a 180-second idle-process lifetime. Finally cleanup verifies exact
container ID and this run's label before removal, including partially completed
setup. Cleanup failures are reported rather than deleting unverified resources.
A final label-filtered listing verifies no resources from this run remain.

Evidence is JSON in a newly allocated OS temporary directory outside the repo;
stdout prints its path and SHA-256. Evidence also records the probe source
SHA-256. It includes raw bounded Docker outputs,
selected server/image metadata and these newly created containers' HostConfig,
not daemon-wide inspection or image environment/config secrets. See RESULTS.md
for the observed runs, evidence hashes, scope and limitations. Latest run:
`dd25a9550c131977`, seven checks in 3.28 seconds, no remaining containers.

Historical raw evidence (private local artifact, not a published download;
`<OS_TEMP>` replaces the machine-specific temporary-directory prefix):
`<OS_TEMP>/alife-phase2-mqueue-hjc63syi/evidence.json`

SHA-256: `379f215b40644e60ef2405f6a10ed77e99387dd0bf43c2ebd7e34faaefeffbc3`

Zero budget denied the tested creation paths despite a writable-looking mount;
this does not establish blanket filesystem/syscall denial or cover preexisting
queues, inherited descriptors, other privilege models, or every kernel.
