// Versioned profiles named in configuration. Each name stands for fixed
// behavior so that nothing about the world, body, or records is an invisible
// default (plan §10). Changing behavior means adding a new version, not
// editing an existing one.
//
// Configuration schema 2 retired `shell-body-v1`, `baseline-sensors-v1`, and
// the `tree-kill-then-stop-v1` timeout policy: their action-timeout semantics
// were superseded by bounded waiting with continuing jobs (plan §8.3). No run
// used them, and no current version accepts them.
//
// Phase 3 retired `shell-body-v2`, `baseline-sensors-v2`, `continuing-jobs-v1`,
// and `recent-complete-exchanges-v1` before any recorded run used them: the
// tick loop made their rendering, stop, uncertainty, eviction, and job
// reporting behavior observable, so that behavior is defined in new versions.
//
// The Phase 3 operator decisions (.plans/phase-3-policy-decisions.md) then
// retired `baseline-sensors-v3` (it listed /world automatically) and
// `shell-body-v3` (its tool text left later output ambiguous), also before
// any recorded run used them.
//
// The Phase 3 lifecycle plan retired `continuing-jobs-v2` and `shell-body-v4`,
// also unused by any recorded run: uncertainty became a lasting condition of
// the execution epoch, enforced at every effect's commitment point and at
// finalization, rather than a job state checked at particular moments.
//
// The final lifecycle gate retired `continuing-jobs-v3`, unused by any recorded
// run: signals became owned operations whose evidence a stop settles, with
// shutdown closing them for either origin and unknown delivery requiring review.

export const STORAGE_PROFILES = {
  "loop-ext4-volume-v1":
    "Fixed-size ext4 image in a Docker volume, attached as a loop device by a privileged helper and mounted " +
    "with noatime,nodev,nosuid through the local driver. 4 KiB blocks, 4 MiB journal, no reserved blocks. " +
    "Filesystem identity is verified before every start (Phase 0, Decision 1). The image is created and seeded " +
    "unprivileged (mkfs.ext4 -d with the seed's files owned by the world user) with world.storage.inodes inodes " +
    "and a recorded UUID. Before every start, a read-only norecovery mount of the device must report the " +
    "recorded filesystem ID; inside the started world, /world must again report it with the required options. " +
    "Nothing is ever reformatted, resized, reseeded, or repaired.",
} as const;

export const CONTAINER_PROFILES = {
  "restricted-container-v1":
    "The image's fixed entrypoint (tini as PID 1, reaping orphans) keeps the world available. Runs as " +
    "world.uid:world.gid with every capability dropped, no-new-privileges, the engine's default seccomp " +
    "profile, and a read-only root filesystem. /world is the only persistent writable mount, the working " +
    "directory, and HOME; /tmp (world.tmpMiB, mode 1777) and /dev/shm (world.shmMiB) are bounded tmpfs. " +
    "Environment: HOME and PATH only (the engine adds HOSTNAME). No devices, bind mounts, published ports, " +
    "host namespaces, restart policy, or automatic removal. Memory, swap, CPU, PID, and open-file limits " +
    "come from configuration; the effective settings are verified from the engine and from inside the world " +
    "before any action.",
} as const;

export const IPC_PROFILES = {
  "private-no-mqueue-v1":
    "A fresh private IPC namespace with RLIMIT_MSGQUEUE 0:0, so creating a POSIX message queue fails. " +
    "Queue accounting is shared per real UID across worlds (Phase 2 spike), so queues are disabled rather " +
    "than bounded. /dev/mqueue stays mounted and reports writable; only creation is denied, verified by an " +
    "mq_open attempt at every start.",
} as const;

export const CAPTURE_PROFILES = {
  "tar-capture-v1":
    "After a verified stop, and only if the ext4 superblock is clean, the device is mounted " +
    "ro,norecovery,noatime,nodev,nosuid,noexec for a helper that streams GNU tar " +
    "(--numeric-owner --one-file-system, links not followed, no sparse detection) with only " +
    "CAP_DAC_READ_SEARCH. Bounded to the filesystem's capacity plus 1536 bytes per inode (plus one 10 KiB " +
    "tar record) of archive, one entry per 512 archive bytes, and 300 s; an exceeded bound yields an archive " +
    "labelled incomplete. " +
    "Contents are indexed and hashed, never extracted or executed. Superblock mount count and write time " +
    "are compared before and after.",
} as const;

export const BODY_PROFILES = {
  "shell-body-v5":
    "One shell or wait action per tick. Each shell action starts a fresh /bin/sh in /world with HOME=/world " +
    "as a job under body.jobPolicy; the working directory and shell variables do not carry over. The call's " +
    "result gives the job ID, its state after the wait (exit status, still running, or unconfirmed/unknown), " +
    "the root process ID, the output collection state, and each stream's byte count with its perceived head " +
    "(body.outputTruncation; invalid UTF-8 shown as U+FFFD). Wait returns 'No action was taken.' A reply " +
    "with no call, or a refusal, is a no-action tick and is never reprompted. Multiple calls, an unknown tool, " +
    "invalid arguments, a command over body.maximumCommandBytes, or an incomplete response execute nothing; " +
    "every call in the reply gets a 'Not executed:' result with the reason, and the next observation reports it. " +
    "Once the outcome of any dispatched command is uncertain (unconfirmed after the wait, or an execution the " +
    "engine no longer knows), at whatever point that is established, no further model request or command is " +
    "issued and the run ends for review; a failed inspection alone only marks the job's last known state as " +
    "stale. A run ends cleanly, with a checkpoint, only if the world's stop assessment is sealed, reports nothing " +
    "uncertain, and all required evidence was recorded. A stop request " +
    "withdraws a command not yet started; one already started finishes its wait. The shell tool's description " +
    "states that for a command still running after the wait, later observations report its status and output " +
    "byte counts but not the output itself; it gives no advice on managing output.",
} as const;

export const JOB_POLICIES = {
  "continuing-jobs-v4":
    "Each shell action is one Docker exec without a TTY, run through a fixed launcher that reports the root " +
    "shell's PID (also its process group and session) before replacing itself with /bin/sh -c. The harness " +
    "waits up to body.actionWaitMs for the root to exit and then returns: exited with its status, still " +
    "running with the job ID, or unconfirmed/uncertain when the engine cannot say. Waiting never terminates " +
    "a job, and a job is never dispatched twice: a job ID already prepared in the world, under any controller, is " +
    "refused, and after a pre-dispatch record fails no further job is dispatched. Stopping or releasing the " +
    "world first lets a submission in progress finish, so it is either never started or tracked; the submitter " +
    "can also withdraw a dispatch at the last moment before the start request, and a withdrawn job is never " +
    "started. Unsettled jobs are inspected every second, independently of ticks; when an inspection fails, the " +
    "last established state is kept, marked with its time and the failure, until an inspection succeeds. One " +
    "collector per job drains stdout and stderr under body.outputTruncation; a collector still open 5 s after " +
    "the root's exit was seen (descendants holding the stream) is closed and the output marked as closed after " +
    "exit. A job holds one of body.maximumConcurrentJobs admission slots while it is running, unconfirmed, " +
    "uncertain, or collecting, and after it finishes until an observation reporting it finished has been " +
    "answered by the mind (acknowledged once a response to the request carrying it is received; a failed or " +
    "unsent request acknowledges nothing); with every slot held, another action is " +
    "rejected before dispatch. The execution epoch's safety condition, shared with the world controller, latches " +
    "each job whose outcome becomes uncertain (an execution the engine no longer knows, or a start unconfirmed " +
    "after the wait) before anything is recorded, and a failed required record likewise; from then on nothing " +
    "more is admitted in the epoch. Every submission and agent-requested signal is admitted at its commitment " +
    "point, the start request, with nothing awaited after the final check; a command refused there stays spent, " +
    "is recorded as refused, and is never started or retried. An uncertain job stays uncertain through " +
    "shutdown. A stop closes admission at once, lets submissions in progress settle, commits the engine stop " +
    "with no await between advancing the inspection epoch and the request, and returns the epoch's assessment, " +
    "sealed only after shutdown processing. Only acknowledged finished jobs are dropped: up to body.retainedFinishedJobs stay " +
    "inspectable, oldest dropped first, so at most maximumConcurrentJobs + retainedFinishedJobs are tracked. An explicit " +
    "signal goes to a job's process group only after checking the root's PID and start time in the world; " +
    "descendants that left the group are not signalled. Each signal is one operation owned until it settles: " +
    "once a stop begins, no new signal of either origin is admitted and one not yet started is withdrawn; in a " +
    "review-required epoch agent signals are refused and operator signals remain available. Every admitted " +
    "request ends with one recorded outcome: delivered, known not delivered (withdrawn, refused by the engine, " +
    "or found unnecessary), or unknown, which requires review. A stop commits the engine stop first, then " +
    "settles admitted signals before sealing its assessment. Stopping the world ends every job.",
} as const;

export const SENSOR_PROFILES = {
  "baseline-sensors-v4":
    "World: /world bytes and inodes (statvfs), container memory usage/limit and PID count/limit (engine " +
    "statistics), and the tracked jobs with state, exit status, and output byte counts. No directory listing: " +
    "the agent inspects the filesystem with its own actions. Body: tick, elapsed runtime, previous operational " +
    "outcome, and context usage with eviction notices when exposeContextUsage is true. In-world readings run " +
    "as the world user from the image's Python; unavailable readings are reported as unavailable. Rendered as " +
    "plain text in that order: tick and run time; previous outcome; World (storage, memory, processes); Jobs, " +
    "one line each; then the context line, which states an upper-bound estimate for this request, the " +
    "provider-reported input tokens of the previous one, which prior ticks are included, and how many " +
    "exchanges are no longer included. Harness and engine detail text is clipped to 512 bytes. A job whose " +
    "latest inspection failed is shown with the time its state was last established and the failure. Every " +
    "job that finishes is shown finished in an observation the mind responded to before it can be dropped " +
    "(body.jobPolicy). A " +
    "job's output after its wait is never shown, only its byte counts. Every section has a computed size " +
    "bound, checked against the context budget.",
} as const;

export const OUTPUT_TRUNCATION = {
  "head-v1":
    "Stdout and stderr each deliver their first bytes, splitting perceivedOutputBytes evenly; excess output " +
    "is counted and discarded up to capturedOutputBytes per stream, and both totals and truncation flags are reported.",
} as const;

export const CONTEXT_POLICIES = {
  "recent-complete-exchanges-v3":
    "recent-complete-exchanges-v2 with continuation-aware sizing: each retained exchange is sized with its " +
    "provider continuation state (anthropic-wire-bound-v1), and that state is kept or evicted together with its " +
    "exchange. The context line is reserved at its worst-case wire size before history is chosen. Nothing is " +
    "summarized, retrieved, or reinjected, and the output allowance is never reduced to make a request fit.",
  "recent-complete-exchanges-v2":
    "Fixed instructions, tools, and the current observation, then the newest complete prior exchanges that fit. " +
    "No summaries, retrieval, or reinjection of evicted content. An exchange is one tick's observation, reply, " +
    "and a result for every call in it, kept or dropped whole. The kept exchanges are always the newest " +
    "contiguous run; an exchange once dropped is gone from the harness and never offered again. Room for the " +
    "context line is reserved before history is chosen, so what it reports cannot change what fits. If the " +
    "request without history does not fit, nothing is sent and the run ends (context_overflow).",
} as const;

/** What the mind is told on the first tick after a clean resume (Phase 4). Recorded in each `run.resumed` event. */
export const RESUME_PROFILES = {
  "resume-discontinuity-v1":
    "On the first tick after a clean resume, the observation's previous-outcome line is replaced by a neutral " +
    "disclosure: execution resumed, every process in the world ended at the stop, the world was restarted as a new " +
    "process epoch, jobs from before the stop no longer exist, and earlier exchanges describe the world before the " +
    "stop. The sensors are fresh; retained exchanges are unchanged, including their original tool results. No " +
    "listing, summary, retrieval, or advice is added. Later ticks render the previous outcome as usual.",
} as const;

/** Independent supervision of an episode's execution (Phase 4), declared in `run.created` and `run.resumed`. */
export const SUPERVISION_PROFILES = {
  "watchdog-v1":
    "Before the world container starts, a separate watchdog process is bound to the exact new container, engine, " +
    "world, epoch, controller token, and the run's original deadline, and durably records that it is armed. The " +
    "controller renews a private lease at operator.heartbeatIntervalSeconds, independently of ticks; the lease is " +
    "valid for operator.watchdogLeaseSeconds. No model call, command, or agent signal is admitted once the lease " +
    "expired locally, a renewal failed, or the watchdog ended unexpectedly, and the run then ends for review. The " +
    "watchdog stops only its bound container, after verifying its identity again, when the lease expires, the " +
    "deadline passes, or a clock discontinuity is seen; it verifies the stop by inspection and records it in its " +
    "own journal, never in the controller's records. After a verified stop the controller releases it, and the " +
    "watchdog records the release only after verifying the container stopped. An expiry always requires review. " +
    "Because the deadline is enforced at its instant, a supervised run starts a tick only while the longest bounded " +
    "tick (mind.requestTimeoutMs plus body.actionWaitMs plus 30 s of readings and records) and 30 s for the stop " +
    "fit before it; otherwise it stops cleanly for its deadline.",
} as const;

export const TOKEN_ESTIMATORS = {
  "utf8-bytes-v1": "UTF-8 byte count plus a fixed per-item overhead; an upper bound for byte-level BPE tokenizers.",
  "anthropic-wire-bound-v1":
    "An upper bound on Anthropic Messages input: the UTF-8 bytes of every text as JSON-escaped on the wire " +
    "(instructions, tool definitions, observations, replies, tool calls and results), a fixed per-item " +
    "framing allowance, and, for each retained reply carrying provider continuation state " +
    "(`anthropic-thinking-v1`), the serialized bytes of that state plus its declared reasoning-token bound " +
    "(at most the 128,000-token generated ceiling). Encrypted signature length is never taken as the " +
    "reasoning size. Malformed or out-of-range continuation state is refused, not estimated.",
} as const;

/** Provider state a retained reply may carry back to the provider (Phase 5). */
export const CONTINUATION_PROFILES = {
  "anthropic-thinking-v1":
    "The complete Anthropic assistant content array of a reply (thinking with its signature, redacted " +
    "thinking, text, and tool use), stored as JSON with the reply and sent back unchanged while that reply's " +
    "exchange is retained. Its public projection (text and tool calls) must match the reply exactly; anything " +
    "else is refused. It is evicted with its exchange and never restored. With the thinking-binding beta and " +
    "`prefix_mismatch_behavior: drop_block`, the provider may discard retained reasoning that a changed " +
    "prefix invalidates; the input transformations it reports are recorded as observer evidence only.",
} as const;

/** Provider adapters (Phase 5); each name stands for fixed request construction and parsing. */
export const MIND_ADAPTERS = {
  "anthropic-messages-v1":
    "One streaming POST to https://api.anthropic.com/v1/messages per model call (anthropic-version 2023-06-01, " +
    "beta thinking-binding-controls-2026-08-01), with no retries at any layer. The request carries the " +
    "configured model, max_tokens, adaptive thinking bound with drop_block, output_config.effort, the " +
    "instructions as system text, the body's tools as native tool definitions (no forced tool choice), and " +
    "the retained exchanges as alternating user and assistant messages: each observation as user text, each " +
    "reply as its recorded content, each tool result paired by ID in the next user message. No caching, " +
    "server tools, service modifiers, or provider conversation state. The stream is bounded in bytes and " +
    "must end with a complete message; anything else is a failed call whose processing is unknown.",
} as const;

export const RETRY_PROFILES = {
  "none-v1": "No SDK or harness retries. A failed request ends the episode.",
} as const;

export const LOGGING_PROFILES = {
  none: "Docker log driver `none`: detached output cannot accumulate on the host.",
} as const;

export const NETWORK_PROFILES = {
  none: "No network interfaces except loopback.",
} as const;

export const SEEDS = {
  "empty-v1": "No research-authored content in /world apart from filesystem structure such as lost+found.",
  "sparse-v1": "A synthetic numerical CSV and unrelated text fragments under /world/materials.",
} as const;

export function names<T extends object>(profiles: T): [keyof T & string, ...(keyof T & string)[]] {
  return Object.keys(profiles) as [keyof T & string, ...(keyof T & string)[]];
}
