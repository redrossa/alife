import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { main } from "../../src/cli.ts";

import { findPlaceholders, loadConfig, paidExecutionBlockers, type ConfigIssue } from "../../src/config/resolve.ts";
import { FIXTURES, variant, writeConfig } from "../support/config.ts";

const EXAMPLE = path.resolve(import.meta.dirname, "../../configs/baseline.example.json");

async function issuesFor(file: string): Promise<readonly ConfigIssue[]> {
  const result = await loadConfig(file);
  assert.equal(result.ok, false, "expected the configuration to be rejected");
  return result.ok ? [] : result.issues;
}

function hasIssue(issues: readonly ConfigIssue[], at: string, pattern?: RegExp): void {
  const match = issues.find((issue) => issue.path === at && (pattern === undefined || pattern.test(issue.message)));
  assert.ok(match, `expected an issue at ${at}${pattern ? ` matching ${pattern}` : ""}; got ${JSON.stringify(issues)}`);
}

describe("loadConfig", () => {
  it("resolves the fake fixture relative to the configuration file", async () => {
    const result = await loadConfig(path.join(FIXTURES, "fake.config.json"));
    assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
    const { resolved } = result;
    assert.equal(resolved.prompt.path, path.resolve(FIXTURES, "../../prompts/baseline.txt"));
    assert.equal(resolved.fakeScript?.path, path.join(FIXTURES, "fake-script.json"));
    assert.match(resolved.configSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      resolved.tools.map((tool) => tool.name),
      ["shell", "wait"],
    );
    assert.ok(resolved.fixedRequestTokens > resolved.config.body.perceivedOutputBytes);
  });

  it("freezes the resolved configuration", async () => {
    const result = await loadConfig(path.join(FIXTURES, "fake.config.json"));
    assert.ok(result.ok);
    assert.throws(() => {
      (result.resolved.config.world as { memoryMiB: number }).memoryMiB = 1 << 20;
    }, TypeError);
  });

  it("hashes identical configurations identically, independent of formatting", async () => {
    const a = await loadConfig(path.join(FIXTURES, "fake.config.json"));
    const b = await loadConfig(await variant(() => {}));
    assert.ok(a.ok && b.ok);
    assert.equal(a.resolved.prompt.sha256, b.resolved.prompt.sha256);
    // The copy rewrites only the prompt path, which is part of the configuration as written.
    assert.notEqual(a.resolved.configSha256, b.resolved.configSha256);
    const c = await loadConfig(await variant(() => {}));
    assert.ok(c.ok);
    assert.equal(b.resolved.configSha256, c.resolved.configSha256);
  });

  it("rejects the illustrative baseline until its placeholders are filled", async () => {
    const issues = await issuesFor(EXAMPLE);
    assert.deepEqual(
      issues.map((issue) => `${issue.path}: ${issue.message}`),
      [
        "world.image: unresolved placeholder",
        "world.storage.helperImage: unresolved placeholder",
        "mind.model: unresolved placeholder",
        "mind.costBound.source: unresolved placeholder",
      ],
    );
  });

  it("rejects unknown fields at every level", async () => {
    hasIssue(await issuesFor(await variant((c) => (c.extra = true))), "(root)", /unrecognized key/i);
    hasIssue(await issuesFor(await variant((c) => (c.world.privileged = true))), "world", /privileged/);
    hasIssue(
      await issuesFor(await variant((c) => ((c.world.storage as Record<string, unknown>).quota = "none"))),
      "world.storage",
      /quota/,
    );
    hasIssue(await issuesFor(await variant((c) => (c.mind.previousResponseId = "x"))), "mind", /previousResponseId/);
  });

  it("rejects unsafe or unsupported settings", async () => {
    hasIssue(await issuesFor(await variant((c) => (c.world.network = "bridge"))), "world.network");
    hasIssue(await issuesFor(await variant((c) => (c.world.logging = "json-file"))), "world.logging");
    hasIssue(await issuesFor(await variant((c) => (c.world.uid = 0))), "world.uid");
    hasIssue(await issuesFor(await variant((c) => (c.world.image = "debian:bookworm"))), "world.image", /digest/);
    hasIssue(
      await issuesFor(await variant((c) => ((c.world.storage as Record<string, unknown>).profile = "named-volume"))),
      "world.storage.profile",
    );
    hasIssue(await issuesFor(await variant((c) => (c.mind.retryProfile = "exponential"))), "mind.retryProfile");
  });

  it("requires every bound to be present and finite", async () => {
    hasIssue(await issuesFor(await variant((c) => delete c.world.pids)), "world.pids");
    hasIssue(await issuesFor(await variant((c) => (c.world.memoryMiB = 1e9))), "world.memoryMiB");
    hasIssue(await issuesFor(await variant((c) => (c.operator.maximumTicks = 1.5))), "operator.maximumTicks");
    hasIssue(await issuesFor(await variant((c) => (c.operator.maximumTicks = -1))), "operator.maximumTicks");
  });

  it("checks relationships between settings", async () => {
    hasIssue(
      await issuesFor(await variant((c) => (c.body.perceivedOutputBytes = 1 << 20))),
      "body.perceivedOutputBytes",
      /capturedOutputBytes/,
    );
    hasIssue(
      await issuesFor(await variant((c) => ((c.world.storage as Record<string, unknown>).inodes = 1 << 20))),
      "world.storage.inodes",
    );
    hasIssue(await issuesFor(await variant((c) => (c.world.swapMiB = 1024))), "world.swapMiB");
    hasIssue(
      await issuesFor(await variant((c) => (c.operator.heartbeatIntervalSeconds = 60))),
      "operator.heartbeatIntervalSeconds",
    );
    hasIssue(await issuesFor(await variant((c) => (c.mind.requestTimeoutMs = 120_000))), "mind.requestTimeoutMs");
    hasIssue(
      await issuesFor(
        await variant((c) => {
          c.mind.maximumOutputTokens = 131_072;
          c.body.contextBudgetTokens = 131_072;
        }),
      ),
      "mind.maximumOutputTokens",
    );
  });

  it("rejects profile versions retired before any recorded run used them", async () => {
    const retired = await issuesFor(
      await variant((c) => {
        c.body.profile = "shell-body-v2";
        c.body.sensors = "baseline-sensors-v2";
        c.body.jobPolicy = "continuing-jobs-v1";
        c.body.contextPolicy = "recent-complete-exchanges-v1";
      }),
    );
    for (const field of ["profile", "sensors", "jobPolicy", "contextPolicy"]) hasIssue(retired, `body.${field}`);
    const phase3 = await issuesFor(
      await variant((c) => {
        c.body.profile = "shell-body-v3";
        c.body.sensors = "baseline-sensors-v3";
      }),
    );
    for (const field of ["profile", "sensors"]) hasIssue(phase3, `body.${field}`);
    const lifecycle = await issuesFor(
      await variant((c) => {
        c.body.profile = "shell-body-v4";
        c.body.jobPolicy = "continuing-jobs-v2";
      }),
    );
    for (const field of ["profile", "jobPolicy"]) hasIssue(lifecycle, `body.${field}`);
    hasIssue(await issuesFor(await variant((c) => (c.body.jobPolicy = "continuing-jobs-v3"))), "body.jobPolicy");
  });

  it("rejects schema version 1 and its retired timeout settings", async () => {
    hasIssue(await issuesFor(await variant((c) => (c.schemaVersion = 1))), "schemaVersion");
    const retired = await issuesFor(
      await variant((c) => {
        c.body.actionTimeoutMs = 10_000;
        c.body.timeoutPolicy = "tree-kill-then-stop-v1";
      }),
    );
    hasIssue(retired, "body", /actionTimeoutMs/);
    hasIssue(retired, "body", /timeoutPolicy/);
    hasIssue(await issuesFor(await variant((c) => (c.body.profile = "shell-body-v1"))), "body.profile");
    hasIssue(await issuesFor(await variant((c) => (c.body.sensors = "baseline-sensors-v1"))), "body.sensors");
  });

  it("requires the job policy, IPC, container, and capture profiles and a pinned helper image", async () => {
    hasIssue(await issuesFor(await variant((c) => delete c.body.jobPolicy)), "body.jobPolicy");
    hasIssue(await issuesFor(await variant((c) => delete c.body.actionWaitMs)), "body.actionWaitMs");
    hasIssue(await issuesFor(await variant((c) => (c.world.ipc = "shareable"))), "world.ipc");
    hasIssue(await issuesFor(await variant((c) => (c.world.container = "privileged"))), "world.container");
    const storage = (mutate: (storage: Record<string, unknown>) => void) =>
      variant((c) => mutate(c.world.storage as Record<string, unknown>));
    hasIssue(await issuesFor(await storage((s) => (s.helperImage = "alpine:3.22"))), "world.storage.helperImage", /digest/);
    hasIssue(await issuesFor(await storage((s) => (s.capture = "rsync"))), "world.storage.capture");
  });

  it("bounds jobs by the world's PIDs and the controller's retained output", async () => {
    hasIssue(
      await issuesFor(await variant((c) => (c.body.maximumConcurrentJobs = 64))),
      "body.maximumConcurrentJobs",
      /world\.pids/,
    );
    hasIssue(
      await issuesFor(
        await variant((c) => {
          c.body.capturedOutputBytes = 16 << 20;
          c.body.retainedFinishedJobs = 16;
        }),
      ),
      "body.retainedFinishedJobs",
      /retain/,
    );
    hasIssue(await issuesFor(await variant((c) => (c.body.actionWaitMs = 90_000))), "body.actionWaitMs", /watchdogLeaseSeconds/);
  });

  it("rejects a context budget that cannot hold the request without history", async () => {
    hasIssue(
      await issuesFor(await variant((c) => (c.body.contextBudgetTokens = 8192))),
      "body.contextBudgetTokens",
      /largest possible observation/,
    );
    // The largest observation grows with the jobs it can list.
    const jobs = await issuesFor(
      await variant((c) => {
        c.body.contextBudgetTokens = 131_072;
        c.body.retainedFinishedJobs = 1024;
        c.body.capturedOutputBytes = 8192;
        c.body.perceivedOutputBytes = 4096;
      }),
    );
    hasIssue(jobs, "body.contextBudgetTokens", /largest possible observation/);
  });

  it("reports missing or invalid referenced files", async () => {
    hasIssue(await issuesFor(await variant((c) => (c.body.prompt = "missing.txt"))), "body.prompt", /ENOENT/);
    const file = await variant(() => {});
    await writeFile(path.join(path.dirname(file), "fake-script.json"), JSON.stringify({ schemaVersion: 1, turns: [{ type: "dance" }] }));
    hasIssue(await issuesFor(file), "mind.script:turns[0].type");
  });

  it("reports unreadable files as file problems", async () => {
    const file = await writeConfig({});
    await writeFile(file, "{ not json");
    hasIssue(await issuesFor(file), "(file)", /not valid JSON/);
    await writeFile(file, Buffer.from([0x7b, 0xff, 0x7d]));
    hasIssue(await issuesFor(file), "(file)", /UTF-8/);
  });

  const asRoot = process.getuid?.() === 0;

  it("reports unreadable configuration, prompt, and script files as issues", { skip: asRoot && "root ignores file modes" }, async () => {
    const cases: [string, string][] = [
      ["config.json", "(file)"],
      ["prompt.txt", "body.prompt"],
      ["fake-script.json", "mind.script"],
    ];
    for (const [name, at] of cases) {
      const file = await variant(() => {});
      await chmod(path.join(path.dirname(file), name), 0o000);
      hasIssue(await issuesFor(file), at, /cannot read .*: EACCES/);
    }

    const file = await variant(() => {});
    await chmod(path.join(path.dirname(file), "prompt.txt"), 0o000);
    const out: string[] = [];
    assert.equal(await main(["config", "validate", "--json", file], (line) => out.push(line), () => {}), 1);
    const report = JSON.parse(out.join("\n")) as { valid: boolean; issues: { path: string; message: string }[] };
    assert.equal(report.valid, false);
    assert.deepEqual(report.issues, [{ path: "body.prompt", message: "cannot read prompt: EACCES" }]);
  });

  it("refuses special files without blocking on them", async () => {
    const file = await variant(() => {});
    const fifo = path.join(path.dirname(file), "fifo");
    await promisify(execFile)("mkfifo", [fifo]);
    hasIssue(await issuesFor(fifo), "(file)", /not a regular file/);
    hasIssue(await issuesFor(path.dirname(file)), "(file)", /not a regular file/);
  });

  it("accepts a paid provider only with an ALIFE_-prefixed credential variable", async () => {
    const paid = (credentialEnv: string) =>
      variant((c) => {
        c.mind = {
          provider: "openai",
          model: "example-model-1",
          credentialEnv,
          maximumOutputTokens: 1024,
          requestTimeoutMs: 60_000,
          retryProfile: "none-v1",
          costBound: { inputUsdPerMillionTokens: null, outputUsdPerMillionTokens: null, source: "pricing page", verifiedOn: null },
        };
        c.operator.maximumEstimatedCostUsd = 5;
      });
    hasIssue(await issuesFor(await paid("OPENAI_API_KEY")), "mind.credentialEnv");

    const result = await loadConfig(await paid("ALIFE_OPENAI_API_KEY"));
    assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
    const blockers = paidExecutionBlockers(result.resolved.config);
    assert.ok(blockers.some((b) => b.includes("inputUsdPerMillionTokens is null")));
    assert.ok(blockers.some((b) => b.includes("verifiedOn is null")));
  });

  it("reports no paid-execution blockers for the fake mind", async () => {
    const result = await loadConfig(path.join(FIXTURES, "fake.config.json"));
    assert.ok(result.ok);
    assert.deepEqual(paidExecutionBlockers(result.resolved.config), []);
  });
});

describe("findPlaceholders", () => {
  it("finds placeholders anywhere in the document", () => {
    assert.deepEqual(findPlaceholders({ a: [{ b: "x REPLACE_WITH_Y" }], c: "ok", d: 1 }), ["a[0].b"]);
  });
});
