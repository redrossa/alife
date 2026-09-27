import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { main } from "../../src/cli.ts";

async function invoke(...argv: string[]) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join("\n"), err: err.join("\n") };
}
async function root(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "alife-p5-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function present() {
  const help = await invoke("help");
  assert.equal(help.code, 0);
  assert.match(help.out, /campaign create/, "Phase 5 campaign CLI missing");
  assert.match(help.out, /campaign status/, "Phase 5 campaign CLI missing");
}
async function contents(directory: string) {
  const files = (await readdir(directory)).filter((s) => s.endsWith(".json") || s.endsWith(".jsonl")).sort();
  return Promise.all(files.map(async (name) => [name, (await readFile(path.join(directory, name))).toString("base64")]));
}

describe("Phase 5 offline campaign CLI", () => {
  it("documents explicit campaign creation and status", present);
  it("creates the single smoke authorization explicitly and reports integer micro-USD", async (t) => {
    await present();
    const directory = path.join(await root(t), "campaign");
    const created = await invoke("campaign", "create", "--directory", directory, "--limit-usd", "100", "--json");
    assert.equal(created.code, 0, created.err);
    const status = await invoke("campaign", "status", "--directory", directory, "--json");
    assert.equal(status.code, 0, status.err);
    const report = JSON.parse(status.out) as Record<string, unknown>;
    assert.equal(report.campaignId, "phase5-smoke-v1");
    assert.equal(report.limitMicroUsd, 100_000_000);
    assert.equal(report.accountedMicroUsd, 0);
    assert.equal(report.remainingMicroUsd, 100_000_000);
    assert.deepEqual(report.outstanding, []);
  });
  it("cannot reset or raise an existing campaign with another create command", async (t) => {
    await present();
    const directory = path.join(await root(t), "campaign");
    assert.equal((await invoke("campaign", "create", "--directory", directory, "--limit-usd", "20", "--json")).code, 0);
    const before = await contents(directory);
    assert.notEqual((await invoke("campaign", "create", "--directory", directory, "--limit-usd", "100", "--json")).code, 0);
    assert.deepEqual(await contents(directory), before);
  });
  it("status of missing evidence does not silently initialize a zero-spend ledger", async (t) => {
    await present();
    const directory = await root(t);
    assert.notEqual((await invoke("campaign", "status", "--directory", path.join(directory, "missing"), "--json")).code, 0);
    assert.deepEqual(await readdir(directory), []);
  });
  for (const limit of ["100.01", "NaN", "-1", "0", "0.0000001"]) it(`refuses unapproved or unrepresentable campaign cap ${limit}`, async (t) => {
    await present();
    const directory = await root(t);
    const result = await invoke("campaign", "create", "--directory", path.join(directory, "campaign"), "--limit-usd", limit, "--json");
    assert.notEqual(result.code, 0);
    assert.deepEqual(await readdir(directory), []);
  });
});
