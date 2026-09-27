# Phase 0 results

**Run:** `results/20260925161449-5d99.json`, recorded 2026-09-25 with
`--allow-privileged-helper --allow-engine-restart`.
**Result:** 50 checks passed, 1 warning, 0 failures. Seven more entries are
informational.
**Environment:** OrbStack 2.2.3 on macOS 26 (Darwin 25.6, Apple silicon);
Docker Engine 29.4.0 (API 1.54); kernel `7.0.14-orbstack`; aarch64. The engine
uses cgroup v2, the containerd overlayfs snapshotter, and the builtin seccomp
profile. OrbStack stores Docker data on btrfs (`nodatacow`).

Check IDs (`S4`, `E8`, and so on) refer to the entries in the JSON report and
`probe.mjs`.

## Support matrix

| Environment | Status | Notes |
| --- | --- | --- |
| OrbStack 2.2.3 / Engine 29.4.0 / arm64 | **Verified** by this run | The privileged helper is needed to attach loop devices. |
| Docker Desktop (`desktop-linux` context present) | Unverified | Not run. The same design is plausible, but nothing has been tested. |
| Linux Docker Engine | Unverified | Not run. The same design is plausible, and `losetup` can run through a helper or explicit `sudo`. |
| Remote contexts | Out of scope | The probes reject non-unix endpoints. |

## Decision 1: storage backend

**Selected: a loop-mounted ext4 image stored inside a Docker named volume.**

1. **Provision (unprivileged).** Create a backing volume
   `…-backing`. A `--cap-drop ALL` tools container runs
   `truncate` and `mkfs.ext4 -b 4096 -N <inodes> -m 0 -J size=4 -U <uuid> -E root_owner=1000:1000`
   to create `world.ext4` in it.
2. **Attach (privileged helper).** Run
   `losetup --find --show --nooverlap` and probe the device's UUID and type
   with `blkid -p`.
3. **Mount (Docker-native).** Create a `local` volume with
   `type=ext4, device=/dev/loopN, o=noatime,nodev,nosuid`. Docker mounts it
   when the world starts and unmounts it when the world stops.
4. **Verify identity (unprivileged) before every start.** A read-only
   container runs `stat -f -c %i /world` on the volume. The result must equal
   the ext4 fsid derived from the recorded UUID.

The contract from plan §7.3 against this run:

| Requirement | Evidence |
| --- | --- |
| Enforced capacity | 128 MiB requested, 120.2 MiB usable (`S3`). The rest is metadata (1,299 blocks, with a 4 MiB journal). `dd` stops with `ENOSPC` at 120.0 MiB (`S4`). |
| Finite inodes | 4,096 inodes, 12 used by the filesystem. Creating files stops with `ENOSPC` after 4,083 files (`S6`). |
| Agent-visible metrics are per-world | Inside the world, `df` and `statfs` report the loop filesystem, not the VM's 165 GiB disk (`S3`). |
| No unbounded host writes | After exhaustion the backing file is 131,072 KiB apparent size and at most that much allocated (`S5`). |
| Survives container recreation | The marker file and an SQLite row survive `rm` and recreation; processes do not (`P1`). |
| Survives application restart | After `orbctl stop` and `orbctl start`, the world stays stopped, the engine ID is unchanged, the filesystem is `clean`, and data survives reattachment (`P3a`–`P3d`). |
| Missing backend fails closed | With the loop device detached, the world does not start (`F1`). The same happens after a restart until reattachment (`P3b`), and for a nonexistent device (`F3`). No ordinary directory is used instead. |
| Identity on attach | If a loop number is reused by another image, the fsid check rejects it (`F2`). |
| Removing the volume keeps data | Removing and recreating the device volume keeps the data (`P-after detach`). |
| No authority inside the world | No loop devices, backing mount, Docker socket, or capabilities are visible to the world (`I4`, `I6`, `I11`). |
| Read-only capture | See Decision 2 and the capture section. |

### Findings that shape Phase 2

- **The `local` driver cannot mount an image file with `o=loop` (`D4`).** The
  kernel `mount(2)` has no loop option, so either a helper or the operator
  must attach a loop device. This is the only privileged step.
- **Loop devices do not survive an OrbStack restart, and numbers are reused.**
  After every attach, the device volume has to be recreated with the current
  `/dev/loopN`. The fsid identity check is **mandatory before each start**,
  not only at creation. The window between checking and starting must be
  covered by the single-owner lock.
- **Capture and the running world must not overlap.** Docker lets a
  read-only capture volume and the world's read-write volume mount the same
  device at once. The runtime has to enforce that the world is stopped
  first.
- **Recreate the image with the pilot's final parameters.** The journal was set
  to 4 MiB because the default for this size was 16 MiB and reduced usable
  space to 108 MiB. Record the usable capacity as the effective bound.
- **`lost+found` is research-visible content.** It is owned by root with mode
  700, sits inside a world root owned by `1000:1000`, and the agent can remove
  it while it is empty. Document it in `empty-v1` as filesystem structure.
- **Host free space.** Volumes live on the OrbStack VM's btrfs disk. That disk
  is itself stored on the macOS disk. `minimumHostFreeMiB` should check both:
  the volume filesystem (`df` from a helper) and the macOS volume that holds
  OrbStack's data. Sparse backing files do not reserve physical space.

### Alternatives not selected

| Candidate | Reason |
| --- | --- |
| Named volume on the VM's btrfs | Unbounded (165 GiB shared) with no inode limit. |
| btrfs qgroups | They must be enabled for the whole engine filesystem, do not change the agent-visible `df`, and do not bound inodes. Not probed. |
| `--storage-opt size` | This bounds only the container's writable layer, which is read-only here and not kept across recreation. Not probed. |
| tmpfs | Not persistent. The plan rules it out. |
| macOS disk image through file sharing | Widens the macOS host-sharing surface and has weaker POSIX semantics. Not probed. |
| ext4 image on a separate Linux host or VM | Still a valid fallback, but unnecessary on OrbStack. |

## World profile

The world ran with these settings:

```text
--init --user 1000:1000 --read-only
--mount type=volume,src=<world>,dst=/world
--tmpfs /tmp:rw,nosuid,nodev,size=16m,mode=1777 --shm-size 8m
--network none --cap-drop ALL --security-opt no-new-privileges
--memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 64
--ulimit nofile=256:256 --log-driver none --restart no
--env HOME=/world --workdir /world
```

Every setting was checked in `docker inspect` and from inside the world
(`I1`–`I14`). Each limit was also enforced:

- `/tmp` and `/dev/shm` stop with `ENOSPC` at 16 MiB and 8 MiB (`I15`, `I16`).
- A 400 MiB allocation is OOM-killed with exit status 137. The world keeps
  running, and `memory.events` records `oom_kill 1` (`I17`).
- `fork` fails with `EAGAIN` below 64 processes (`I18`).
- `open` fails with `EMFILE` at 256 descriptors (`I19`).
- Two busy processes are held to 0.49 CPU (`I20`).
- Swap is 0.
- There is no log file, and `docker logs` is refused (`I21`).
- The only interface is loopback. IPv4, IPv6, and DNS all fail (`I10`).
- The exec environment contains only `HOME`, `HOSTNAME`, and `PATH` (`I12`).

**Warning (`I7a`):** `/dev/mqueue` is writable. POSIX message queues are bounded
by `RLIMIT_MSGQUEUE`, live in the container's IPC namespace, and disappear on
stop. Accept this and document it; Docker has no simple option to remove the
mount.

**Minor information leak:** `/proc/self/mountinfo` shows VM-internal snapshot
and volume paths. It does not show host paths, credentials, or other runs.

## Decision 2: execution lifetime

Actions ran through the Engine API (`POST /containers/{id}/exec` with no TTY)
as fresh `/bin/sh -c` processes.

| Behavior | Finding |
| --- | --- |
| Exit status and streams | The exit code is reported, stdout and stderr are demultiplexed, and signal exits are reported as 128+n (`E1`, `E2`). |
| Exec processes | Each exec is a session leader (pid = pgid = sid, ppid 0). |
| Before start | `Running=false` with `ExitCode=null` also appears **before** the process starts. Exit must be detected from a non-null `ExitCode`. |
| Fully redirected background work | It returns immediately and keeps running across later execs (`E3`). |
| Inherited stdout | The engine closes the stream and reports exit about **2 s** after the main process exits, even when a descendant still holds the pipe. It does not wait for the descendant (`E4`). A client drain limit is still useful as a guard across engine versions. |
| Background writers on inherited stdout | They **die with EPIPE/SIGPIPE** once the engine closes the pipe, about 2 s after the action (`E5`). Only redirected background work survives. This is a real property of the world that an agent can discover. |
| Client disconnect | Closing the attach stream **does not stop** the command (`E6`). Timeouts need an in-world kill. |
| Output flood | 50 MB was streamed, counted, and discarded beyond the 64 KiB capture limit (`E9`). |

### Timeout termination

Killing only the action's session ends the command and its ordinary children.
A `setsid` + `env -i` daemon escapes (`E7`).

The **tree** strategy ends every process that was created after a snapshot
taken just before dispatch and is not descended from any process that existed
before it, apart from init (`E8`). It killed the escaped daemon and left
earlier background work alone. It runs as uid 1000 with the image's read-only
`python3 -I`, and checks each process's start time to avoid reused PIDs.

Recommended Phase 2/3 policy:

1. Snapshot the process table before each action.
2. On timeout, apply the tree kill for up to 10 rounds. Then require the exec to
   report exit and no remaining targets.
3. Record the killed processes as an operator intervention on the action.
4. If the exec still runs or targets remain, stop the whole container and mark
   the episode interrupted, as plan §8.3 requires.

**Known limitation:** if an earlier background process double-forks during a
timed-out action, the new process is attributed to the action and killed.
This is rare, but it must be recorded, not hidden.

## Artifact capture

The capture ran only after the world stopped:

- A second `local` volume on the same loop device mounts it with
  `o=ro,noatime,nodev,nosuid,noexec`.
- `tar --numeric-owner --one-file-system` runs as root in a container with
  `--cap-drop ALL --cap-add DAC_READ_SEARCH --read-only --network none`, and
  streams to the host with a byte limit.

Results:

- Writes fail with `EROFS` (`C1`).
- The backing image is **byte-identical** before and after capture, including
  the mount count (`C3`).
- Symbolic links are stored as links and not followed. FIFOs are stored as
  FIFOs. Mode-000 directories are read through `DAC_READ_SEARCH` (`C4`).
- File names keep raw terminal control bytes (`C5`). Phase 4 readers must
  escape names and reject path traversal.

## Not yet verified

- Host sleep/resume, and a forced VM kill while the world is writing. The
  restart test used a graceful `orbctl stop`, and the filesystem stayed
  `clean`.
- Controller SIGKILL and watchdog behavior. These belong to Phase 4.
- Docker Desktop and Linux Engine.
- Kernel or escape stress testing. Per plan §7.1, run it only in a disposable
  isolated environment.
- Whether OrbStack's `machine.docker.isolated` setting removes the macOS file
  share from the engine VM. This would reduce exposure from the helper and
  from any escape. The setting was not changed.

## Gate assessment

On OrbStack, the Phase 0 gate is met: bounds are real and enforced,
persistence holds across container recreation and application restart, a
missing or wrong backend fails closed, timeouts can be enforced safely with a
whole-world stop as fallback, and read-only capture works.

Before Phase 2, confirm these three points:

1. The loop-ext4 backend is acceptable, including a privileged helper for
   attach, reattach after restart, and detach.
2. The timeout policy above is acceptable, including the tree-kill limitation.
3. `/dev/mqueue` can remain writable.
