# Continuing-job spike results

## Verdict

Bounded waiting with continuing foreground exec jobs is feasible on the tested
OrbStack engine. Keep the exec attachment draining across ticks; do not disconnect
it merely because a tick's waiting interval expires. Inspect the recorded exec
ID for completion, never rerun the command to learn its status.

This is a capability spike, not a production backend or the complete Phase 2 gate.

## Environment and evidence

- OrbStack Docker Engine 29.4.0, Linux arm64, API as returned in raw `/version`.
- Local image: `sha256:4071ad814ce2464e271f2fb26f2beb0115c35495bc5635dcdc253cbdf7cbb64f`.
- Node.js 25.8.1; container restrictions and exact flags recorded in evidence.
- Final run: `280cb45bcefdd99f`; **13 checks passed**; exact container removed.
- Final source SHA-256: `00dea1fd9f17136d1b7c5e424865f9068ae0b0c019154f745475e135f754347f`.

Raw evidence is preserved outside the checkout in:

`~/.local/state/alife-spikes/phase2-6oam3ilp/`

| File | SHA-256 |
| --- | --- |
| `jobs-final.json` | `5c2d1b5aab1a34bc39eefe3cf747ee67de676d06e48b86e5bc4b540c7d0f7335` |
| `jobs-final-dispatch.jsonl` | `e4d3d2219648a2978d45bbc79797aa05c26d25d1589421da54f71678b124d6d0` |
| `jobs-prior-pass.json` | `0876da4986d2c00916c829ae59280059fef5367ef4574433f5d19f38288b157e` |
| `jobs-initial-failed-expectation.json` | `2aacbd028e9d31d23bd8aa1f8df6cd3e97faa28524bb74606cdb1caea64eadc7` |

`manifest.json` also hashes the copied probe sources and message-queue evidence.
This is a local evidence archive, not a published or portable artifact. Reproduction
needs the recorded local image; a mutable `:dev` tag is not equivalent.

## Observations

| Check | Observed result |
| --- | --- |
| J1–J2: wait and later inspection | After a 200 ms wait, the job was running. The same exec subsequently completed with exit 0; a counter remained exactly 1. |
| J3: shared world resources | Two jobs each allocated 12 MiB. Cgroup memory rose from 6,008,832 to 37,093,376 bytes, under the same 96 MiB ceiling. Both remained running; PID ceiling 64 and CPU quota `50000 100000` were visible. |
| J4: CPU/admission | Throttled periods increased from 0 to 26; both jobs exited 0. A third request was rejected before exec creation and its sentinel file was absent. |
| J5–J6: later output | A job continued after a 100 ms wait, then emitted 8,388,631 stdout bytes and 4,194,304 stderr bytes. All were counted/drained; retained payload never exceeded 8,192 bytes. The final output marker was present. |
| J7: inherited-pipe negative control | The shell exited 0 and capture ended after 87,052 stdout bytes. Its background writer later remained alive at count 214/250, sleeping in `anon_pipe_write`, with no caught BrokenPipeError. Root exit/stream EOF did not mean the background work had completed. |
| J8: redirected background output | After its shell exited, the redirected writer finished all 80 writes, producing 81,920 bytes inside bounded `/world`. |
| J9–J10: intentional disconnect | Destroying the attachment did not stop the command. The same exec remained running, then exited 0 and wrote its completion marker. Output continuity must not be assumed after disconnection. |
| J11: process-group cancellation | Explicit SIGTERM ended the root group (exit 143); a `setsid` descendant survived. We did not label this whole-tree termination. |
| J12: explicit survivor control | The same agent UID opened a pidfd for the known survivor, checked its start identity, signalled it, and init reaped it. The process disappeared. |
| J13: world lifetime | The world stayed running throughout ordinary wait expiry and explicit process cancellation, until probe cleanup. |

### Initial failed expectation, retained rather than hidden

The first run passed J1–J6 but failed an assertion that the inherited-pipe writer
must encounter EPIPE. That assumption was too narrow: this Python writer could
remain blocked instead. The negative control was changed to measure lost output
continuity and record process state, rather than require one engine-specific
failure mode. Two subsequent full runs passed all 13 checks.

The Phase 0 report's EPIPE observation remains evidence for its particular
workload. It must not be generalized to every background writer.

## Implementation implications

1. A waiting deadline is not an execution deadline. Keep one attachment/collector
   alive per tracked exec until completion or a separately reported transport
   failure. Recheck actual exec status, including non-null exit code.
2. Normal long jobs should be launched in the foreground through the asynchronous
   body interface; the agent need not append `&` to obtain another cognitive tick.
3. If the agent deliberately backgrounds work and lets its shell exit, stdout and
   stderr should be redirected to the bounded world filesystem (or another
   explicitly supported endpoint). Document inherited-pipe behavior truthfully.
   Do not promise lossless descendant output after root exit.
4. Expose live process/job inspection and explicit signal scope. A root exec or
   process group is not an inescapable descendant boundary. Do not resurrect the
   process-snapshot heuristic or claim `cancel(job)` killed every descendant.
   Stronger whole-tree guarantees would require another containment spike.
5. Bound live-job admission, collection buffers, completed-job retention, observer
   records, and output supplied to the mind. The spike used two jobs and 4 KiB
   tails per stream, not approved production defaults or a fixed-RSS guarantee.
6. Include an init/reaper (or prove an equivalent lifecycle implementation), and
   account for its process footprint in the world profile.

## Not demonstrated

Persistent ext4 integration, production stopped-world capture, watchdog/crash
handling, reconnection with output recovery, forced engine loss, other Docker
implementations/architectures, exact descendant-tree cancellation, arbitrary job
scales, a model-facing job tool API, and total controller memory/CPU bounds under
adversarial workloads remain implementation/integration work. The capped tmpfs
fixture is not an approved persistent storage substitute.
