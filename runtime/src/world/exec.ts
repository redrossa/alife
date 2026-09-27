import type { Clock } from "../core/clock.ts";
import { bool, type DockerEngine, EngineResponseError, EngineUnavailableError, isNotFound, optionalNum, type RawStream, record } from "./engine.ts";
import { FrameDemuxer, HeadRetainer } from "./output.ts";

// Executions inside a running world. The transport is the only part that
// talks to the engine, so the job table can be tested with a fake one.

export interface ExecState {
  readonly running: boolean;
  /** Null until the process has exited; `running: false` with no code also appears before it starts. */
  readonly exitCode: number | null;
}

export interface ExecTransport {
  readonly containerId: string;
  /** Creates an execution without starting it. */
  create(cmd: readonly string[], workingDir: string): Promise<string>;
  /** Starts it once and returns its attached output stream. */
  start(execId: string): Promise<RawStream>;
  inspect(execId: string): Promise<ExecState>;
}

export class ExecGoneError extends Error {
  constructor(execId: string) {
    super(`execution ${execId} is no longer known to the engine`);
    this.name = "ExecGoneError";
  }
}

export function dockerExecTransport(engine: DockerEngine, containerId: string, user: string): ExecTransport {
  return {
    containerId,
    async create(cmd, workingDir) {
      const reply = record(
        await engine.post(`/containers/${containerId}/exec`, {
          body: {
            AttachStdin: false,
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
            Cmd: cmd,
            User: user,
            WorkingDir: workingDir,
            // Inherit only the container's declared environment.
            Env: [],
            Privileged: false,
          },
          timeoutMs: 15_000,
        }),
        "exec create",
      );
      const id = reply.Id;
      if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new TypeError("exec create returned no valid ID");
      return id;
    },
    start(execId) {
      return engine.hijack(`/exec/${execId}/start`, { Detach: false, Tty: false }, { timeoutMs: 15_000 });
    },
    async inspect(execId) {
      try {
        const info = record(await engine.get(`/exec/${execId}/json`, { timeoutMs: 10_000 }), "exec");
        return { running: bool(info.Running, "exec Running"), exitCode: optionalNum(info.ExitCode, "exec ExitCode") };
      } catch (error) {
        if (isNotFound(error)) throw new ExecGoneError(execId);
        throw error;
      }
    },
  };
}

/**
 * The control command certainly never started: its creation failed (so no
 * start was requested), or the engine refused the start request with an error
 * status. A lost or unreadable answer after the start request is not this.
 */
export class ControlNotStartedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlNotStartedError";
  }
}

export interface ControlResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  /** Output exceeded its bound or did not finish arriving; the retained part is not a complete reading. */
  readonly overflow: boolean;
  /** The command did not finish in time. It cannot be killed from outside and ends when the world stops. */
  readonly timedOut: boolean;
}

const CONTROL_POLL_MS = 25;
const CONTROL_DRAIN_MS = 2_000;

/**
 * Runs a fixed harness command (a reading or an explicit signal) to
 * completion with bounded output and time. These are not agent jobs and do
 * not count toward job admission, but they do share the world's limits.
 */
export async function runControl(
  transport: ExecTransport,
  clock: Clock,
  cmd: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly stdoutLimit: number;
    /**
     * For commands with effects: asked before the execution is created and
     * again immediately before its start, with nothing awaited between that
     * second check and the start request. A returned error is thrown and the
     * command never starts.
     */
    readonly admit?: () => Error | null;
  },
): Promise<ControlResult> {
  const early = options.admit?.() ?? null;
  if (early !== null) throw early;
  let execId: string;
  try {
    execId = await transport.create(cmd, "/");
  } catch (error) {
    // No start was requested, so nothing ran.
    throw new ControlNotStartedError(`the control command could not be created: ${(error as Error).message}`);
  }
  const denial = options.admit?.() ?? null;
  if (denial !== null) throw denial;
  const stdout = new HeadRetainer(options.stdoutLimit);
  const stderr = new HeadRetainer(4096);
  const demuxer = new FrameDemuxer((stream, bytes) => (stream === "stdout" ? stdout : stderr).add(bytes));
  let resolveEnded!: () => void;
  let drained = false;
  const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
  let stream: RawStream;
  try {
    stream = await transport.start(execId);
  } catch (error) {
    // An error status is the engine refusing the start: nothing ran. Anything else leaves it unknown.
    if (error instanceof EngineResponseError) throw new ControlNotStartedError(`the engine refused to start the control command: ${error.message}`);
    throw error;
  }
  stream.onData((chunk) => {
    try {
      demuxer.push(chunk);
    } catch {
      stream.destroy();
    }
  });
  stream.onEnd((reason) => {
    // Only end-of-file shows the whole reading arrived.
    drained = reason === "eof";
    resolveEnded();
  });

  try {
    const deadline = clock.monotonicMs() + options.timeoutMs;
    let state: ExecState;
    for (;;) {
      state = await transport.inspect(execId);
      if (!state.running && state.exitCode !== null) break;
      if (clock.monotonicMs() >= deadline) {
        return { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), overflow: false, timedOut: true };
      }
      await clock.sleep(CONTROL_POLL_MS);
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([ended, new Promise<void>((resolve) => (timer = setTimeout(resolve, CONTROL_DRAIN_MS)))]);
    clearTimeout(timer);
    const out = stdout.snapshot();
    return {
      exitCode: state.exitCode,
      stdout: Buffer.from(out.retained),
      stderr: Buffer.from(stderr.snapshot().retained),
      // A stream that did not end may still have held output: the reading is not complete.
      overflow: out.truncated || demuxer.midFrame || !drained,
      timedOut: false,
    };
  } finally {
    stream.destroy();
  }
}

/** Engine unavailability is distinct from a failed reading: the world's state is then unknown. */
export function isEngineUnavailable(error: unknown): boolean {
  return error instanceof EngineUnavailableError;
}
