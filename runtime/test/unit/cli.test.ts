import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { main } from "../../src/cli.ts";
import { parseRunId } from "../../src/core/ids.ts";
import { acquireOwnership } from "../../src/operator/locks.ts";
import { prepareStateDir } from "../../src/operator/state-dir.ts";
import { createRunDirectory, RunRecorder, runPaths } from "../../src/records/run-store.ts";
import { FIXTURES } from "../support/config.ts";
import { FakeClock } from "../support/fake-clock.ts";

const CLI = path.resolve(import.meta.dirname, "../../src/cli.ts");
const EXAMPLE = path.resolve(import.meta.dirname, "../../configs/baseline.example.json");

async function invoke(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, (line) => out.push(line), (line) => err.push(line));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("cli", () => {
  it("validates a configuration", async () => {
    const result = await invoke("config", "validate", path.join(FIXTURES, "fake.config.json"));
    assert.equal(result.code, 0);
    assert.match(result.out, /^valid: /);
    assert.match(result.out, /mind: fake/);
  });

  it("reports every issue and exits 1 for an invalid configuration", async () => {
    const result = await invoke("config", "validate", EXAMPLE);
    assert.equal(result.code, 1);
    assert.match(result.out, /world\.image: unresolved placeholder/);
    assert.match(result.out, /mind\.model: unresolved placeholder/);
  });

  it("produces machine-readable output", async () => {
    const result = await invoke("config", "validate", "--json", EXAMPLE);
    const report = JSON.parse(result.out) as { valid: boolean; issues: unknown[] };
    assert.equal(report.valid, false);
    assert.equal(report.issues.length, 4);
  });

  it("rejects unknown commands and options with usage", async () => {
    assert.equal((await invoke("run", "start")).code, 2);
    assert.equal((await invoke("config", "validate")).code, 2);
    const unknownOption = await invoke("config", "validate", "--force", EXAMPLE);
    assert.equal(unknownOption.code, 2);
    assert.match(unknownOption.err, /Usage:/);
  });

  it("requires explicit world IDs, contexts, and confirmation before touching Docker", async () => {
    const WORLD = "w-20260925T161449Z-abababab";
    const usage = async (...argv: string[]) => {
      const result = await invoke(...argv);
      assert.equal(result.code, 2, `${argv.join(" ")}: ${result.err}`);
      return result.err;
    };
    assert.match(await usage("doctor"), /--docker-context/);
    assert.match(await usage("world", "create", "--config", EXAMPLE), /--docker-context/);
    assert.match(await usage("world", "inspect", "latest"), /not a world ID/);
    assert.match(await usage("world", "inspect"), /exactly one world ID/);
    assert.match(await usage("world", "destroy", WORLD), /--confirm/);
    assert.match(await usage("world", "destroy", WORLD, "--confirm", "w-20260925T161449Z-cdcdcdcd"), /--confirm/);
    assert.match(await usage("world", "capture", WORLD), /--label/);
    assert.match(await usage("world", "prune"), /unknown world command/);
    await usage("world", "attach", WORLD, "--privileged");
  });

  it("requires explicit run IDs, worlds, and acknowledgement", async () => {
    const usage = async (...argv: string[]) => {
      const result = await invoke(...argv);
      assert.equal(result.code, 2, `${argv.join(" ")}: ${result.err}`);
      return result.err;
    };
    assert.match(await usage("run", "start", "--config", EXAMPLE), /--world and --config/);
    assert.match(await usage("run", "start", "--world", "latest", "--config", EXAMPLE), /not a world ID/);
    assert.match(await usage("run", "status", "latest"), /not a run ID/);
    // Phase 4 added resume, stop, capture, and export; each still names its run by exact ID.
    assert.match(await usage("run", "resume", "latest"), /not a run ID/);
    assert.match(await usage("run", "stop", "latest"), /not a run ID/);
    assert.match(await usage("run", "capture", "r-20260925T161449Z-abababab"), /--label/);
    assert.match(await usage("run", "export", "r-20260925T161449Z-abababab"), /--output/);
    assert.match(await usage("observe", "list", "r-20260925T161449Z-abababab"), /--archive/);
    assert.match(await usage("run", "replay", "r-20260925T161449Z-abababab"), /unknown run command/);
    assert.match(await usage("lock", "release", "world", "w-20260925T161449Z-abababab"), /--token/);
    assert.match(await usage("lock", "status", "world", "r-20260925T161449Z-abababab"), /not a world ID/);
  });

  it("shows an interrupted run and finalizes it only with acknowledgement", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "alife-cli-"));
    const runId = parseRunId("r-20260925T161449Z-0000cafe");
    const layout = await prepareStateDir(state);
    const paths = runPaths(layout, runId);
    await createRunDirectory(paths);
    const config = JSON.parse(await readFile(path.join(FIXTURES, "fake.config.json"), "utf8")) as Record<string, unknown>;
    await writeFile(paths.config, JSON.stringify(config));
    const records = await RunRecorder.open({ paths, runId, clock: new FakeClock(), limitBytes: 1 << 20 });
    await records.append("run.created", { worldId: "not-a-world" }, { durable: true });
    await records.append("run.ready", {}, { durable: true });
    await records.append("run.started", {}, { durable: true });
    await records.append("action.prepared", { actionId: `${runId}.t000001.action`, execId: "exec-\u001b" }, { tick: 1, durable: true });
    await records.close();

    const missing = await invoke("run", "status", "r-20260925T161449Z-00000000", "--state-dir", state);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /there is no run r-20260925T161449Z-00000000/);
    const status = await invoke("run", "status", runId, "--state-dir", state);
    assert.equal(status.code, 0);
    assert.match(status.out, /running \(INTERRUPTED: no live owner\)/);
    assert.match(status.out, /unknown outcome: action r-20260925T161449Z-0000cafe\.t000001\.action \(prepared; it may or may not have started/);
    assert.ok(!status.out.includes("\u001b"));
    assert.match(status.out, /exec exec-\\x1b/);

    const preview = await invoke("run", "finalize", runId, "--state-dir", state);
    assert.equal(preview.code, 1);
    assert.match(preview.out, /1 action\(s\)/);
    assert.match(preview.out, /nothing was changed/);
    assert.match((await invoke("run", "status", runId, "--state-dir", state)).out, /INTERRUPTED/);

    const finalized = await invoke("run", "finalize", runId, "--acknowledge-uncertainty", "--state-dir", state, "--json");
    assert.equal(finalized.code, 0, finalized.err);
    const record = JSON.parse(finalized.out) as { world: { container: string }; acknowledged: { actions: unknown[] } };
    assert.equal(record.world.container, "unknown");
    assert.equal(record.acknowledged.actions.length, 1);
    assert.match((await invoke("run", "status", runId, "--state-dir", state)).out, /: finalized/);
    const again = await invoke("run", "finalize", runId, "--acknowledge-uncertainty", "--state-dir", state);
    assert.equal(again.code, 1);
    assert.match(again.err, /already finalized/);
  });

  it("reports and releases only abandoned locks, by exact token", async () => {
    const state = await mkdtemp(path.join(tmpdir(), "alife-cli-"));
    const layout = await prepareStateDir(state);
    const WORLD = "w-20260925T161449Z-abababab";
    const lock = await acquireOwnership(layout.locks, "world", WORLD, new FakeClock());
    const shown = await invoke("lock", "status", "world", WORLD, "--state-dir", state);
    assert.match(shown.out, /appears alive/);
    assert.match(shown.out, new RegExp(`token ${lock.record.token}`));
    const refused = await invoke("lock", "release", "world", WORLD, "--token", lock.record.token, "--state-dir", state);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /already owned/);
    const wrong = await invoke("lock", "release", "world", WORLD, "--token", "0".repeat(32), "--state-dir", state);
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /token does not match/);
    await lock.release();
    assert.match((await invoke("lock", "status", "world", WORLD, "--state-dir", state)).out, /not locked/);
  });

  it("escapes untrusted text in human output", async () => {
    const result = await invoke("config", "validate", "/nonexistent/\u001b[2J.json");
    assert.equal(result.code, 1);
    assert.ok(!result.out.includes("\u001b"));
    assert.match(result.out, /\\x1b\[2J/);
  });

  it("reports unexpected failures as internal errors", async () => {
    const err: string[] = [];
    const code = await main(["version"], () => {
      throw new Error("boom\u001b[2J");
    }, (line) => err.push(line));
    assert.equal(code, 3);
    assert.deepEqual(err, ["alife: internal error: boom\\x1b[2J"]);
  });

  it("runs as a standalone process without credentials", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, "version"], { env: { PATH: process.env.PATH } });
    assert.match(stdout, /^@alife\/runtime \d+\.\d+\.\d+ \(Node\.js v/);
  });
});
