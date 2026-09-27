// Real production wiring only. No injected mind, engine, world, or watchdog.
// Frozen awaited hook semantics:
// after_model_requested: durable request, before invocation;
// after_model_responded: durable response;
// after_action_prepared: durable preparation, before shell transport commit;
// after_action_commit: transport committed (outcome may still be unrecorded);
// after_world_stop: verified physical stop, before checkpoint;
// after_checkpoint_file: durable checkpoint, before checkpoint/terminal events;
// after_terminal_record: all clean evidence AND watchdog release durable,
// before controller exit. onTick below ensures stopped_clean, not tick_limit.
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/resolve.ts";
import { systemClock } from "../../src/core/clock.ts";
import { parseWorldId, type RunId, type WorldId } from "../../src/core/ids.ts";
import type { RunResult, StartRunOptions } from "../../src/operator/run.ts";
import { prepareStateDir } from "../../src/operator/state-dir.ts";

const [root, file, world, target] = process.argv.slice(2);
assert.ok(root && file && world && target);
assert.equal(typeof process.send, "function");
assert.equal(process.env.ALIFE_TEST_PHASE4_DOCKER, "1");
assert.equal(process.env.ALIFE_TEST_ALLOW_PRIVILEGED_HELPER, "1");
for (const name of ["ALIFE_TEST_DOCKER_CONTEXT", "ALIFE_TEST_WORLD_IMAGE", "ALIFE_TEST_HELPER_IMAGE"]) assert.ok(process.env[name]);
const loaded = await loadConfig(file);
assert.ok(loaded.ok);
assert.equal(loaded.resolved.config.mind.provider, "fake", "never call a provider");
const url = new URL("../../src/operator/managed-run.ts", import.meta.url);
type ManagedOptions = StartRunOptions & {
  onBoundary?: (name: string, identity: { runId: RunId; worldId: WorldId }) => Promise<void>;
};
const api = await import(url.href) as { startManagedRun: (options: ManagedOptions) => Promise<RunResult> };
assert.equal(typeof api.startManagedRun, "function", "Phase 4 requires startManagedRun");
const stop = new AbortController();
// A referenced timer keeps the exact async barrier alive even after all other
// production handles close at after_terminal_record. Only the parent kills it.
const keepAlive = setInterval(() => undefined, 1000);
try {
  const result = await api.startManagedRun({
    layout: await prepareStateDir(root), resolved: loaded.resolved,
    worldId: parseWorldId(world), clock: systemClock, signal: stop.signal,
    allowPrivilegedHelper: true,
    onCreated(runId) { process.send!({ type: "created", runId }); },
    onTick() { stop.abort("acceptance operator stop after first tick"); },
    async onBoundary(name, identity) {
      if (name !== target) return;
      await new Promise<void>((resolve, reject) => {
        process.send!({ type: "boundary", name, ...identity }, (error) => error ? reject(error) : resolve());
      });
      await new Promise<void>(() => { /* Intentional controlled SIGKILL barrier. */ });
    },
  });
  throw new Error(`managed run exited without reaching ${target}: ${JSON.stringify(result)}`);
} finally { clearInterval(keepAlive); }
