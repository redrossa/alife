import assert from "node:assert/strict";
import { fork, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DockerEngine } from "../../src/world/engine.ts";

const moduleFile = fileURLToPath(new URL("../../src/operator/watchdog.ts", import.meta.url));
const controllerFile = fileURLToPath(new URL("../support/phase4-controller-child.ts", import.meta.url));
const WORLD = "w-20260925T161449Z-00000000";
const RUN = "r-20260925T161449Z-00000000";
const CONTAINER = "a".repeat(64);
const FOREIGN = "b".repeat(64);

async function implemented() {
  assert.equal(await access(moduleFile).then(() => true, () => false), true,
    "Phase 4 must implement src/operator/watchdog.ts (no stub or skipped acceptance)");
  const module = await import(pathToFileURL(moduleFile).href) as { startWatchdog?: unknown };
  assert.equal(typeof module.startWatchdog, "function", "Phase 4 must export startWatchdog; it resolves only after child readiness");
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 12_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(deadlineMs = 30_000) {
  // Short Unix socket path works on macOS as well as Linux.
  const root = await mkdtemp(path.join(tmpdir(), "p4-wd-"));
  const socket = path.join(root, "e.sock");
  const calls: string[] = [];
  let running = true;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const server = http.createServer((request, response) => {
    const route = (request.url ?? "").replace(/^\/v\d+\.\d+/, "").split("?")[0]!;
    calls.push(`${request.method} ${route}`);
    response.setHeader("Content-Type", "application/json");
    if (route === "/info") { response.end(JSON.stringify({ ID: "phase4-offline-engine" })); return; }
    if (route === "/version") { response.end(JSON.stringify({ ApiVersion: "1.44", Version: "25.0.0" })); return; }
    if (route === `/_ping`) { response.end("OK"); return; }
    if (route === `/containers/${CONTAINER}/json` || route === `/containers/${FOREIGN}/json`) {
      const own = route.includes(CONTAINER);
      response.end(JSON.stringify({ Id: own ? CONTAINER : FOREIGN,
        Name: own ? `/alife-${WORLD}` : "/unrelated-world",
        Config: { Labels: { "sh.alife.world": own ? WORLD : "w-20260925T161449Z-11111111", "sh.alife.role": "world" } },
        State: { Running: own ? running : true, Status: own && !running ? "exited" : "running", ExitCode: 0, OOMKilled: false } }));
      return;
    }
    if (request.method === "POST" && route === `/containers/${CONTAINER}/stop`) {
      running = false; response.statusCode = 204; response.end(); resolveStopped(); return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ message: "offline fixture refuses this route" }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  const events = path.join(root, "events.jsonl");
  const checkpoint = path.join(root, "checkpoint.json");
  await writeFile(events, "controller ledger sentinel\n", { mode: 0o600 });
  await writeFile(checkpoint, "controller checkpoint sentinel\n", { mode: 0o600 });
  const envLeak = path.join(root, "inherited-node-options.txt");
  const sentinel = path.join(root, "preload.mjs");
  await writeFile(sentinel, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(envLeak)}, 'unsafe NODE_OPTIONS inheritance');\n`, { mode: 0o600 });
  const journal = path.join(root, "watchdog.jsonl");
  const packet = { module: moduleFile, sentinel, options: {
    leaseFile: path.join(root, "lease.json"), journalFile: journal,
    binding: { schemaVersion: 1, runId: RUN, worldId: WORLD, epochId: "00000000-0000-4000-8000-000000000001", controllerToken: "c".repeat(32),
      engineId: "phase4-offline-engine", containerId: CONTAINER,
      deadline: new Date(Date.now() + deadlineMs).toISOString(), leaseMs: 1000 },
    context: { name: "phase4-offline", endpoint: `unix://${socket}`, socketPath: socket },
    pollIntervalMs: 50, maximumJournalBytes: 64 << 10,
  } };
  const packetFile = path.join(root, "packet.json");
  await writeFile(packetFile, JSON.stringify(packet), { mode: 0o600 });
  let controller: ChildProcess | undefined;
  let watchdogPid: number | undefined;
  let errors = "";
  async function launch() {
    controller = fork(controllerFile, [packetFile], { execArgv: [],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
      stdio: ["ignore", "ignore", "pipe", "ipc"] });
    controller.stderr?.on("data", (bytes: Buffer) => { errors += bytes.toString().slice(0, 8192); });
    const message = await within(new Promise<unknown>((resolve, reject) => {
      controller!.once("message", resolve);
      controller!.once("error", reject);
      controller!.once("exit", (code) => reject(new Error(`controller exited before watchdog ready (${code}): ${errors}`)));
    }), "watchdog child never acknowledged readiness");
    assert.ok(typeof message === "object" && message !== null && "watchdogPid" in message);
    const candidate = (message as { watchdogPid: number }).watchdogPid;
    assert.ok(Number.isSafeInteger(candidate) && candidate > 1);
    assert.notEqual(candidate, controller.pid, "the watchdog must not share the controller process");
    assert.notEqual(candidate, process.pid);
    const parentPid = await new Promise<string>((resolve, reject) => {
      execFile("ps", ["-p", String(candidate), "-o", "ppid="], { encoding: "utf8", timeout: 5000 },
        (error, stdout) => error ? reject(new Error(error.message)) : resolve(stdout));
    });
    assert.equal(Number(parentPid.trim()), controller.pid, "only adopt cleanup authority over our controller's own child");
    watchdogPid = candidate;
    const records = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    assert.ok(records.some((event) => event.type === "watchdog.armed"), "ready must follow durable arming evidence");
    return controller;
  }
  async function verifyStopped() {
    await within(stopped, "independent watchdog did not stop its bound container after lost lease/deadline");
    assert.equal(running, false);
    assert.deepEqual(calls.filter((call) => call.startsWith("POST ")), [`POST /containers/${CONTAINER}/stop`]);
    assert.equal(await readFile(events, "utf8"), "controller ledger sentinel\n");
    assert.equal(await readFile(checkpoint, "utf8"), "controller checkpoint sentinel\n");
    assert.equal(await access(envLeak).then(() => true, () => false), false, "watchdog must strip NODE_OPTIONS");
    if (watchdogPid !== undefined) {
      await within((async () => {
        for (;;) {
          const state = await new Promise<string>((resolve) => {
            execFile("ps", ["-p", String(watchdogPid), "-o", "stat="], { encoding: "utf8", timeout: 1000 },
              (error, stdout) => resolve(error ? "" : stdout.trim()));
          });
          if (state === "" || state.startsWith("Z")) break;
          await delay(50);
        }
      })(), "watchdog leaked a running process after its verified stop");
      watchdogPid = undefined;
    }
  }
  async function dispose() {
    if (controller?.pid !== undefined && controller.exitCode === null && controller.signalCode === null) {
      controller.kill("SIGCONT");
      const exited = once(controller, "exit");
      controller.kill("SIGKILL"); // This is only our offline Node fixture, never a Docker/world process.
      await within(exited, "fixture controller did not exit");
    }
    if (watchdogPid !== undefined) {
      try { process.kill(watchdogPid, "SIGTERM"); } catch { /* already exited */ }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  return { launch, verifyStopped, dispose, calls, context: packet.options.context, pid: () => watchdogPid! };
}

describe("P4-WP real process independence over an offline Unix-socket engine", () => {
  it("socket fixture exercises real Docker HTTP transport without Docker resources", async () => {
    const f = await fixture();
    try {
      const engine = new DockerEngine(f.context);
      assert.deepEqual(await engine.get("/info"), { ID: "phase4-offline-engine" });
      await engine.post(`/containers/${CONTAINER}/stop`);
      await f.verifyStopped();
    } finally { await f.dispose(); }
  });

  it("refreshes beyond the original lease, then survives controller SIGKILL and stops only its exact container", async () => {
    await implemented();
    const f = await fixture();
    try {
      const controller = await f.launch();
      await delay(1300); // Deliberately real elapsed lease evidence, not a race-arrangement sleep.
      assert.equal(f.calls.some((call) => call.startsWith("POST ")), false, "healthy heartbeat must keep the run alive");
      const exited = once(controller, "exit");
      controller.kill("SIGKILL");
      await within(exited, "controller SIGKILL did not complete");
      await f.verifyStopped();
    } finally { await f.dispose(); }
  });

  it("stops a world when the controller is hung, not merely when its PID exits", async () => {
    await implemented();
    const f = await fixture();
    try {
      const controller = await f.launch();
      assert.equal(controller.kill("SIGSTOP"), true);
      await f.verifyStopped();
      assert.equal(controller.exitCode, null);
      assert.equal(controller.signalCode, null);
    } finally { await f.dispose(); }
  });

  it("enforces the original deadline even while heartbeat renewal continues", async () => {
    await implemented();
    const f = await fixture(3000);
    try { await f.launch(); await f.verifyStopped(); }
    finally { await f.dispose(); }
  });

  it("does not inherit provider secrets, unrelated secrets, or runtime preload injection", async () => {
    await implemented();
    const f = await fixture();
    try {
      const controller = await f.launch();
      const environment = await new Promise<string>((resolve, reject) => {
        execFile("ps", ["eww", "-p", String(f.pid()), "-o", "command="], { encoding: "utf8", timeout: 5000 },
          (error, stdout) => error ? reject(new Error(error.message)) : resolve(stdout));
      });
      assert.ok(environment.length > 0, "inspect the actual child, not a claimed environment descriptor");
      assert.equal(environment.includes("phase4-dummy-provider-secret-not-a-real-key"), false);
      assert.equal(environment.includes("phase4-dummy-unrelated-secret"), false);
      assert.equal(environment.includes("--import="), false);
      controller.kill("SIGKILL");
      await f.verifyStopped();
    } finally { await f.dispose(); }
  });
});
