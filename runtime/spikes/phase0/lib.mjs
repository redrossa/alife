// Phase 0 probe helpers. Standard library only; not part of the runtime API.
//
// Every Docker invocation uses an argument array against an explicitly selected
// context. Nothing here interpolates text into a host shell.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import http from "node:http";

export const LABEL = "sh.alife.phase0.run";

/** Minimal environment for docker CLI calls: no inherited credentials. */
function cliEnv() {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" };
  if (process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  return env;
}

export function run(file, args, { input, timeoutMs = 120_000, maxBuffer = 16 << 20 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { env: cliEnv(), timeout: timeoutMs, maxBuffer, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          signal: error?.signal ?? null,
          stdout,
          stderr,
        });
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

export class Docker {
  constructor(context) {
    this.context = context;
    this.socketPath = null;
  }

  async resolve() {
    const r = await run("docker", ["context", "inspect", this.context, "--format", "{{json .}}"]);
    if (r.code !== 0) throw new Error(`cannot inspect Docker context ${this.context}: ${r.stderr.trim()}`);
    const info = JSON.parse(r.stdout);
    const host = info.Endpoints?.docker?.Host ?? "";
    if (!host.startsWith("unix://")) {
      throw new Error(`context ${this.context} is not a local unix socket (${host}); remote contexts are out of scope`);
    }
    this.socketPath = host.slice("unix://".length);
    this.endpoint = host;
    return info;
  }

  cli(args, opts) {
    return run("docker", ["--context", this.context, ...args], opts);
  }

  async cliOk(args, opts) {
    const r = await this.cli(args, opts);
    if (r.code !== 0) throw new Error(`docker ${args.join(" ")} failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  /** JSON request against the Engine API over the context's unix socket. */
  api(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              /* non-JSON body */
            }
            resolve({ status: res.statusCode, json, text });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  }

  async execCreate(container, cmd, { user = "1000:1000", env = [], workdir = "/world" } = {}) {
    const r = await this.api("POST", `/containers/${encodeURIComponent(container)}/exec`, {
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: cmd,
      User: user,
      Env: env,
      WorkingDir: workdir,
    });
    if (r.status !== 201) throw new Error(`exec create failed ${r.status}: ${r.text}`);
    return r.json.Id;
  }

  async execInspect(id) {
    const r = await this.api("GET", `/exec/${id}/json`);
    if (r.status !== 200) throw new Error(`exec inspect failed ${r.status}: ${r.text}`);
    return r.json;
  }

  /**
   * Start an exec and demultiplex its stream, keeping at most `captureBytes`
   * per stream while counting (and discarding) everything else.
   * Returns a handle; `done` resolves when the stream ends or is destroyed.
   */
  execStart(id, { captureBytes = 65536 } = {}) {
    const body = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
    const out = { stdout: [], stderr: [], kept: { stdout: 0, stderr: 0 }, total: { stdout: 0, stderr: 0 } };
    let socket = null;
    let ended = false;
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const finish = (how) => {
      if (ended) return;
      ended = true;
      resolveDone(how);
    };
    let pending = Buffer.alloc(0);
    const onData = (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 8) {
        const stream = pending[0] === 2 ? "stderr" : "stdout";
        const size = pending.readUInt32BE(4);
        if (pending.length < 8 + size) break;
        const frame = pending.subarray(8, 8 + size);
        out.total[stream] += size;
        const room = captureBytes - out.kept[stream];
        if (room > 0) {
          const keep = frame.subarray(0, room);
          out[stream].push(Buffer.from(keep));
          out.kept[stream] += keep.length;
        }
        pending = pending.subarray(8 + size);
      }
    };
    const req = http.request({
      socketPath: this.socketPath,
      method: "POST",
      path: `/exec/${id}/start`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        Connection: "Upgrade",
        Upgrade: "tcp",
      },
    });
    req.on("upgrade", (_res, sock, head) => {
      socket = sock;
      if (head?.length) onData(head);
      sock.on("data", onData);
      sock.on("end", () => finish("eof"));
      sock.on("close", () => finish("closed"));
      sock.on("error", () => finish("error"));
    });
    req.on("response", (res) => {
      // Older engines may answer 200 without upgrading.
      res.on("data", onData);
      res.on("end", () => finish("eof"));
    });
    req.on("error", () => finish("error"));
    req.end(body);
    return {
      done,
      output: out,
      get ended() {
        return ended;
      },
      destroy() {
        if (socket) socket.destroy();
        else req.destroy();
        finish("destroyed");
      },
      text(stream) {
        return Buffer.concat(out[stream]).toString("utf8");
      },
    };
  }

  /** Convenience: run a command to completion via the API (for probes, not actions). */
  async exec(container, cmd, opts = {}) {
    const id = await this.execCreate(container, cmd, opts);
    const h = this.execStart(id, opts);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const timer = setTimeout(() => h.destroy(), timeoutMs);
    await h.done;
    clearTimeout(timer);
    // Stream EOF is not proof of exit; poll inspect briefly.
    let info = await this.execInspect(id);
    for (let i = 0; i < 40 && info.Running; i++) {
      await sleep(50);
      info = await this.execInspect(id);
    }
    return { id, exitCode: info.ExitCode, running: info.Running, stdout: h.text("stdout"), stderr: h.text("stderr"), total: h.output.total };
  }

  /** Stream `docker run` stdout into a file with a byte ceiling. */
  runToFile(args, file, maxBytes) {
    return new Promise((resolve) => {
      const child = spawn("docker", ["--context", this.context, ...args], { env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
      const sink = createWriteStream(file, { mode: 0o600 });
      const hash = createHash("sha256");
      let bytes = 0;
      let truncated = false;
      let stderr = "";
      child.stdout.on("data", (c) => {
        if (truncated) return;
        if (bytes + c.length > maxBytes) {
          c = c.subarray(0, maxBytes - bytes);
          truncated = true;
          child.kill("SIGKILL");
        }
        bytes += c.length;
        hash.update(c);
        sink.write(c);
      });
      child.stderr.on("data", (c) => {
        if (stderr.length < 8192) stderr += c.toString("utf8");
      });
      child.on("close", (code) => {
        sink.end(() => resolve({ code, bytes, truncated, sha256: hash.digest("hex"), stderr }));
      });
    });
  }
}

export class Recorder {
  constructor() {
    this.results = [];
    this.facts = {};
  }

  record(id, area, status, title, detail = {}) {
    this.results.push({ id, area, status, title, detail });
    const mark = { pass: "PASS", fail: "FAIL", info: "INFO", skip: "SKIP", warn: "WARN" }[status] ?? status;
    console.log(`[${mark}] ${id} ${title}`);
    if (status === "fail" || status === "warn") console.log(`       ${JSON.stringify(detail).slice(0, 600)}`);
  }

  check(id, area, ok, title, detail) {
    this.record(id, area, ok ? "pass" : "fail", title, detail);
    return ok;
  }

  fact(key, value) {
    this.facts[key] = value;
  }

  summary() {
    const counts = {};
    for (const r of this.results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return counts;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ext4 statfs f_fsid for a filesystem UUID, as `stat -f -c %i` prints it.
 * The kernel computes two 32-bit words by XOR-ing the UUID halves (little-endian).
 */
export function ext4Fsid(uuid) {
  const b = Buffer.from(uuid.replace(/-/g, ""), "hex");
  const lo = (b.readUInt32LE(0) ^ b.readUInt32LE(8)) >>> 0;
  const hi = (b.readUInt32LE(4) ^ b.readUInt32LE(12)) >>> 0;
  return { lo, hi };
}
