import type { RawStream } from "../../src/world/engine.ts";
import type { ExecState, ExecTransport } from "../../src/world/exec.ts";

/** One multiplexed Docker stream frame. */
export function frame(stream: "stdout" | "stderr", payload: string | Buffer): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const header = Buffer.alloc(8);
  header[0] = stream === "stdout" ? 1 : 2;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/**
 * A stream the test drives: `emit` delivers bytes, `finish` ends it. Like a
 * paused socket, it holds data and its end until listeners are attached.
 */
export class FakeStream implements RawStream {
  readonly #data: ((chunk: Buffer) => void)[] = [];
  readonly #end: ((reason: "eof" | "closed" | "error", error?: Error) => void)[] = [];
  readonly #pending: Buffer[] = [];
  #pendingEnd: { reason: "eof" | "closed" | "error"; error?: Error } | null = null;
  ended = false;
  destroyed = false;

  onData(listener: (chunk: Buffer) => void): void {
    this.#data.push(listener);
    for (const chunk of this.#pending.splice(0)) listener(chunk);
  }

  onEnd(listener: (reason: "eof" | "closed" | "error", error?: Error) => void): void {
    this.#end.push(listener);
    if (this.#pendingEnd !== null) {
      const { reason, error } = this.#pendingEnd;
      this.#pendingEnd = null;
      listener(reason, error);
    }
  }

  write(): Promise<void> {
    return Promise.reject(new Error("fake stream accepts no input"));
  }

  end(): void {}

  destroy(): void {
    this.destroyed = true;
    this.finish("closed");
  }

  emit(chunk: Buffer): void {
    if (this.ended) return;
    if (this.#data.length === 0) this.#pending.push(chunk);
    for (const listener of this.#data) listener(chunk);
  }

  finish(reason: "eof" | "closed" | "error" = "eof", error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    if (this.#end.length === 0) this.#pendingEnd = error === undefined ? { reason } : { reason, error };
    for (const listener of this.#end) listener(reason, error);
  }
}

interface FakeExec {
  readonly cmd: readonly string[];
  readonly workingDir: string;
  starts: number;
  state: ExecState;
  stream: FakeStream | null;
}

/**
 * Scriptable executions. Each created execution starts unconfirmed; tests set
 * `state`, emit output, and end streams. Counts show nothing ran twice.
 */
export class FakeTransport implements ExecTransport {
  readonly containerId = "c".repeat(64);
  readonly execs = new Map<string, FakeExec>();
  created = 0;
  /** Throws from the next `start` call, then clears. */
  failNextStart: Error | null = null;
  /** Applied to each started execution. */
  onStart: (id: string, exec: FakeExec) => void = (_id, exec) => {
    exec.state = { running: true, exitCode: null };
  };
  inspections = 0;

  /** While set, `create` waits for it before answering (an awaited exec creation). */
  createGate: Promise<void> | null = null;
  /** While set, `start` counts the start at once but answers only when it resolves (a request in flight). */
  startGate: Promise<void> | null = null;

  async create(cmd: readonly string[], workingDir: string): Promise<string> {
    this.created += 1;
    const id = String(this.created).padStart(64, "0");
    this.execs.set(id, { cmd, workingDir, starts: 0, state: { running: false, exitCode: null }, stream: null });
    if (this.createGate !== null) await this.createGate;
    return id;
  }

  start(execId: string): Promise<RawStream> {
    // Counted synchronously: calling `start` is the commitment point.
    const exec = this.execs.get(execId)!;
    exec.starts += 1;
    const failure = this.failNextStart;
    if (failure !== null) {
      this.failNextStart = null;
      return Promise.reject(failure);
    }
    exec.stream = new FakeStream();
    this.onStart(execId, exec);
    const stream = exec.stream;
    return this.startGate === null ? Promise.resolve(stream) : this.startGate.then(() => stream);
  }

  /** While set, every inspection fails with this error. */
  failInspect: Error | null = null;

  inspect(execId: string): Promise<ExecState> {
    this.inspections += 1;
    if (this.failInspect !== null) return Promise.reject(this.failInspect);
    return Promise.resolve(this.execs.get(execId)!.state);
  }

  /** The execution created by the Nth `create` call (1-based). */
  exec(n: number): FakeExec {
    return this.execs.get(String(n).padStart(64, "0"))!;
  }
}
