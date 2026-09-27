import { execFile } from "node:child_process";
import http from "node:http";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";

// Docker Engine API client over an explicitly selected local context
// (plan §5). Requests go to the context's unix socket as argument data, never
// through a shell. Every request has a deadline and a response-size bound.
// The engine is trusted infrastructure, but responses can carry world
// content (names, paths), so callers read fields defensively.

/** The API version every request is pinned to (Docker Engine 25 and later). */
export const API_VERSION = "1.44";

const CONTEXT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1 << 20;

export interface DockerContext {
  readonly name: string;
  /** `unix://…` endpoint as configured. */
  readonly endpoint: string;
  readonly socketPath: string;
}

/** The engine could not be reached or did not answer in time; a mutating call's outcome is unknown. */
export class EngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

/** The engine answered with an error status: the request was refused, not partly applied. */
export class EngineResponseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "EngineResponseError";
    this.status = status;
  }
}

/** Environment for the Docker CLI: nothing from the controller's credentials. */
function cliEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" };
  if (process.env.DOCKER_CONFIG !== undefined) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  return env;
}

/**
 * Resolves a named Docker context through the Docker CLI's own configuration,
 * so no socket path is hard-coded. Only local unix-socket contexts are
 * supported; remote contexts are out of scope for the first release.
 */
export async function resolveDockerContext(name: string): Promise<DockerContext> {
  if (!CONTEXT_NAME.test(name)) throw new RangeError(`invalid Docker context name ${JSON.stringify(name)}`);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "docker",
      ["context", "inspect", name, "--format", "{{json .Endpoints.docker.Host}}"],
      { env: cliEnvironment(), timeout: 15_000, maxBuffer: 64 << 10, encoding: "utf8" },
      (error, out, err) => {
        if (error) reject(new Error(`cannot inspect Docker context ${name}: ${(err || error.message).trim()}`));
        else resolve(out);
      },
    );
  });
  const endpoint = JSON.parse(stdout) as unknown;
  if (typeof endpoint !== "string" || !endpoint.startsWith("unix://") || endpoint.length <= "unix://".length) {
    throw new Error(`Docker context ${name} is not a local unix-socket context; remote contexts are not supported`);
  }
  return { name, endpoint, socketPath: endpoint.slice("unix://".length) };
}

export interface RequestOptions {
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Omit the API version prefix (only for version discovery). */
  readonly unversioned?: boolean;
}

export interface EngineReply {
  readonly status: number;
  readonly json: unknown;
}

function engineMessage(json: unknown, fallback: string): string {
  if (typeof json === "object" && json !== null && typeof (json as { message?: unknown }).message === "string") {
    return (json as { message: string }).message;
  }
  return fallback;
}

/**
 * A hijacked attach or exec stream. Data arrives multiplexed (no TTY);
 * `end()` half-closes the connection, which closes the process's stdin.
 */
export interface RawStream {
  onData(listener: (chunk: Buffer) => void): void;
  /** Called once, with why the stream ended. */
  onEnd(listener: (reason: "eof" | "closed" | "error", error?: Error) => void): void;
  write(chunk: Buffer): Promise<void>;
  end(): void;
  destroy(): void;
}

function streamFrom(readable: Readable, writable: Socket | null): RawStream {
  let ended = false;
  const endListeners: ((reason: "eof" | "closed" | "error", error?: Error) => void)[] = [];
  const finish = (reason: "eof" | "closed" | "error", error?: Error) => {
    if (ended) return;
    ended = true;
    for (const listener of endListeners) listener(reason, error);
  };
  readable.on("end", () => finish("eof"));
  readable.on("close", () => finish("closed"));
  readable.on("error", (error) => finish("error", error));
  return {
    onData: (listener) => readable.on("data", listener),
    onEnd: (listener) => {
      endListeners.push(listener);
    },
    write: (chunk) =>
      new Promise((resolve, reject) => {
        if (writable === null) {
          reject(new Error("this stream cannot accept input"));
          return;
        }
        writable.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
    end: () => writable?.end(),
    destroy: () => {
      readable.destroy();
      writable?.destroy();
    },
  };
}

export class DockerEngine {
  readonly context: DockerContext;

  constructor(context: DockerContext) {
    this.context = context;
  }

  #path(route: string, options: RequestOptions): string {
    const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
    return `${options.unversioned === true ? "" : `/v${API_VERSION}`}${route}${query}`;
  }

  /** One request with a deadline and a bounded response. Never retried. */
  request(method: string, route: string, options: RequestOptions = {}): Promise<EngineReply> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), "utf8");
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.destroy();
        reject(error);
      };
      const request = http.request(
        {
          socketPath: this.context.socketPath,
          method,
          path: this.#path(route, options),
          agent: false,
          headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) fail(new EngineUnavailableError(`${method} ${route}: response exceeds ${maxBytes} bytes`));
            else chunks.push(chunk);
          });
          response.on("error", (error) => fail(new EngineUnavailableError(`${method} ${route}: ${error.message}`)));
          response.on("end", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown = null;
            if (text.length > 0) {
              try {
                json = JSON.parse(text);
              } catch {
                json = null;
              }
            }
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new EngineResponseError(status, `${method} ${route}: ${status} ${engineMessage(json, text.slice(0, 512))}`));
            } else {
              resolve({ status, json });
            }
          });
        },
      );
      const timer = setTimeout(() => fail(new EngineUnavailableError(`${method} ${route}: no answer within ${timeoutMs} ms`)), timeoutMs);
      request.on("error", (error) => fail(new EngineUnavailableError(`${method} ${route}: ${error.message}`)));
      request.end(payload);
    });
  }

  async get(route: string, options: RequestOptions = {}): Promise<unknown> {
    return (await this.request("GET", route, options)).json;
  }

  async post(route: string, options: RequestOptions = {}): Promise<unknown> {
    return (await this.request("POST", route, options)).json;
  }

  async delete(route: string, options: RequestOptions = {}): Promise<unknown> {
    return (await this.request("DELETE", route, options)).json;
  }

  /**
   * Upgrades a POST to a raw multiplexed stream (exec start, container attach).
   * An error status means the engine refused before anything started; a
   * connection failure or missing handshake leaves the outcome unknown.
   *
   * `body` is only for endpoints that read one (exec start). Container attach
   * does not, and unread body bytes would reach the process as input.
   */
  hijack(route: string, body: unknown, options: RequestOptions & { readonly writable?: boolean } = {}): Promise<RawStream> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        action();
        return true;
      };
      const request = http.request({
        socketPath: this.context.socketPath,
        method: "POST",
        path: this.#path(route, options),
        agent: false,
        headers: {
          ...(payload.length > 0 ? { "Content-Type": "application/json" } : {}),
          "Content-Length": payload.length,
          Connection: "Upgrade",
          Upgrade: "tcp",
        },
      });
      const timer = setTimeout(() => {
        settle(() => {
          request.destroy();
          reject(new EngineUnavailableError(`POST ${route}: no stream handshake within ${timeoutMs} ms`));
        });
      }, timeoutMs);
      request.on("upgrade", (response, socket, head) => {
        if (response.statusCode !== 101) {
          socket.destroy();
          settle(() => reject(new EngineUnavailableError(`POST ${route}: unexpected upgrade status ${response.statusCode}`)));
          return;
        }
        // Bytes that arrived with the handshake go back into the socket, which
        // stays paused until the caller attaches a data listener.
        if (head.length > 0) socket.unshift(head);
        const stream = streamFrom(socket, socket);
        if (!settle(() => resolve(stream))) socket.destroy();
      });
      request.on("response", (response) => {
        const status = response.statusCode ?? 0;
        if (status === 200 && options.writable !== true) {
          // Engines that answer without upgrading still stream output this way.
          settle(() => resolve(streamFrom(response, null)));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 64 << 10) chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          settle(() => reject(new EngineResponseError(status, `POST ${route}: ${status} ${engineMessage(json, text.slice(0, 512))}`)));
        });
        response.on("error", (error) =>
          settle(() => reject(new EngineUnavailableError(`POST ${route}: ${error.message}`))),
        );
      });
      request.on("error", (error) => settle(() => reject(new EngineUnavailableError(`POST ${route}: ${error.message}`))));
      request.end(payload);
    });
  }
}

// ---------------------------------------------------------------------------
// Defensive field access for engine responses.

export function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${what}: expected an object from the engine`);
  }
  return value as Record<string, unknown>;
}

export function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new TypeError(`${what}: expected a string from the engine`);
  return value;
}

export function num(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${what}: expected a number from the engine`);
  return value;
}

export function optionalNum(value: unknown, what: string): number | null {
  return value === null || value === undefined ? null : num(value, what);
}

export function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${what}: expected a boolean from the engine`);
  return value;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof EngineResponseError && error.status === 404;
}
