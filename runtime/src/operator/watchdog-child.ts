import { systemClock } from "../core/clock.ts";
import { DockerEngine } from "../world/engine.ts";
import { launchOptionsSchema, runWatchdog, type WatchdogResult } from "./watchdog.ts";

// The watchdog process's entry: it reads its launch options from standard
// input and runs the same state machine the controller's tests exercise. Its
// reports on standard output are a convenience for the launching controller;
// the durable evidence is its journal. Losing the controller never ends it.

const MAXIMUM_INPUT_BYTES = 64 << 10;

function report(message: object): Promise<void> {
  return new Promise((resolve) => {
    try {
      process.stdout.write(`${JSON.stringify(message)}\n`, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function readInput(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > MAXIMUM_INPUT_BYTES) throw new Error("launch options too large");
  }
  return text;
}

// A controller that exits closes these pipes; that must not end the watch.
process.stdout.on("error", () => undefined);
process.stdin.on("error", () => undefined);

const abort = new AbortController();
for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(name, () => abort.abort(name));

let result: WatchdogResult;
try {
  const options = launchOptionsSchema.parse(JSON.parse(await readInput()));
  result = await runWatchdog({
    ...options,
    clock: systemClock,
    engine: new DockerEngine(options.context),
    signal: abort.signal,
    onReady: () => void report({ type: "ready", pid: process.pid }),
  });
} catch (error) {
  result = { outcome: "unknown", verified: false, reason: `the watchdog failed: ${error instanceof Error ? error.message : String(error)}`, containerId: null };
}
await report({ type: "result", result });
process.exit(result.outcome === "released" || result.outcome === "stopped" ? 0 : 1);
