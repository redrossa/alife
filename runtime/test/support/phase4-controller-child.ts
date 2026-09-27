// Offline process fixture: this controller owns no real Docker resources.
// It launches the production watchdog against the test's Unix-socket engine.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

interface Packet {
  readonly module: string;
  readonly sentinel: string;
  readonly options: {
    readonly leaseFile: string;
    readonly journalFile: string;
    readonly context: { name: string; endpoint: string; socketPath: string };
    readonly binding: {
      schemaVersion: 1; runId: string; worldId: string; epochId: string;
      controllerToken: string; engineId: string; containerId: string;
      deadline: string; leaseMs: number;
    };
    readonly pollIntervalMs: number;
    readonly maximumJournalBytes: number;
  };
}
const packet = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Packet;
const module = await import(pathToFileURL(packet.module).href) as {
  startWatchdog(options: Packet["options"]): Promise<{ pid: number; heartbeat(): Promise<void> }>;
};
// Set AFTER this fixture was launched. Only an improperly inherited watchdog
// environment could execute the preload or carry these dummy provider secrets.
process.env.NODE_OPTIONS = `--import=${packet.sentinel}`;
process.env.ALIFE_OPENAI_API_KEY = "phase4-dummy-provider-secret-not-a-real-key";
process.env.UNRELATED_SECRET = "phase4-dummy-unrelated-secret";
// Production launch initializes its own private lease before awaiting readiness.
// Renew only through the public production handle, not a test implementation.
const watchdog = await module.startWatchdog(packet.options);
assert.equal(typeof watchdog.heartbeat, "function");
await watchdog.heartbeat();
let writing = false;
const timer = setInterval(() => {
  if (writing) return;
  writing = true;
  void watchdog.heartbeat().catch((error: unknown) => {
    clearInterval(timer);
    process.stderr.write(`heartbeat failed: ${String(error)}\n`);
    process.exitCode = 1;
  }).finally(() => { writing = false; });
}, 100);
process.send?.({ watchdogPid: watchdog.pid });
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
