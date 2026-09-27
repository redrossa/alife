import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { BODY_PROFILES, SENSOR_PROFILES, CONTEXT_POLICIES, TOKEN_ESTIMATORS } from "../../src/config/profiles.ts";
import { loadConfig, paidExecutionBlockers, type ResolvedConfig } from "../../src/config/resolve.ts";
import * as factory from "../../src/mind/create.ts";
import { fixtureConfig, writeConfig, type Json } from "../support/config.ts";
import { KEY, sse, transport } from "../support/phase5-contract.ts";

type Draft = Json & { body: Json; mind: Json; operator: Json };
async function draft(): Promise<Draft> {
  const c = await fixtureConfig() as Draft;
  c.body.contextBudgetTokens = 1_000_000;
  c.body.tokenEstimator = "anthropic-wire-bound-v1";
  c.body.contextPolicy = "recent-complete-exchanges-v3";
  c.mind = { provider: "anthropic", model: "claude-opus-5-5", credentialEnv: "ALIFE_PHASE5_TEST_KEY", maximumOutputTokens: 128_000,
    requestTimeoutMs: 1_000, retryProfile: "none-v1", reasoningEffort: "high",
    costBound: { inputUsdPerMillionTokens: 4, outputUsdPerMillionTokens: 20, source: "offline fixture standard uncached rates", verifiedOn: "2026-09-27" } };
  c.operator.maximumEstimatedCostUsd = 20;
  c.operator.campaignDirectory = "/tmp/alife-phase5-config-only-unused-campaign";
  c.operator.recordLimitMiB = 128;
  return c;
}
async function load(t: TestContext, c: Draft) {
  const file = await writeConfig(c);
  t.after(() => rm(path.dirname(file), { recursive: true, force: true }));
  return loadConfig(file);
}
async function valid(t: TestContext) {
  const c = await draft();
  const loaded = await load(t, c);
  assert.ok(loaded.ok, `Phase 5 Anthropic config must load: ${JSON.stringify(loaded.ok ? [] : loaded.issues)}`);
  return { c, resolved: loaded.resolved };
}
const create = factory.createMind as unknown as (resolved: ResolvedConfig, options: {
  env: Readonly<Record<string, string | undefined>>; fetch: typeof globalThis.fetch;
}) => ReturnType<typeof factory.createMind>;

describe("Phase 5 config and production factory", () => {
  it("fixture control: existing fake config still resolves without credentials or campaign", async (t) => {
    const c = await fixtureConfig() as Draft;
    const result = await load(t, c);
    assert.ok(result.ok);
    assert.deepEqual(paidExecutionBlockers(result.resolved.config), []);
    assert.equal(factory.createMind(result.resolved).mind.id, "fake-v1");
  });
  it("accepts the selected 1M/high/128000 profile without reading credentials or creating campaign files", async (t) => {
    const { resolved } = await valid(t);
    assert.equal(resolved.config.body.contextBudgetTokens, 1_000_000);
    assert.equal(resolved.config.mind.maximumOutputTokens, 128_000);
    assert.ok(resolved.fixedRequestTokens + 128_000 + resolved.config.body.contextMarginTokens <= 1_000_000);
    assert.equal(resolved.fakeScript, null);
    assert.deepEqual(paidExecutionBlockers(resolved.config), []);
  });
  it("registers additive versioned context and estimator profiles without changing the body or sensors", () => {
    assert.ok("recent-complete-exchanges-v3" in CONTEXT_POLICIES, "Phase 5 continuation-aware context profile missing");
    assert.ok("anthropic-wire-bound-v1" in TOKEN_ESTIMATORS, "Phase 5 wire estimator missing");
    assert.ok("recent-complete-exchanges-v2" in CONTEXT_POLICIES);
    assert.deepEqual(Object.keys(BODY_PROFILES), ["shell-body-v5"]);
    assert.deepEqual(Object.keys(SENSOR_PROFILES), ["baseline-sensors-v4"]);
  });
  const invalid: [string, (c: Draft) => void][] = [
    ["generic credential variable", (c) => { c.mind.credentialEnv = "ANTHROPIC_API_KEY"; }],
    ["retry profile", (c) => { c.mind.retryProfile = "automatic"; }],
    ["unsupported effort", (c) => { c.mind.reasoningEffort = "imaginary"; }],
    ["unsupported model", (c) => { c.mind.model = "claude-unverified-model"; }],
    ["output over model limit", (c) => { c.mind.maximumOutputTokens = 128_001; }],
    ["context over model limit", (c) => { c.body.contextBudgetTokens = 1_000_001; }],
    ["old estimator for opaque reasoning", (c) => { c.body.tokenEstimator = "utf8-bytes-v1"; }],
    ["old context profile for live reasoning", (c) => { c.body.contextPolicy = "recent-complete-exchanges-v2"; }],
    ["missing campaign", (c) => { delete c.operator.campaignDirectory; }],
    ["relative campaign", (c) => { c.operator.campaignDirectory = "./campaign"; }],
    ["nonpositive paid run limit", (c) => { c.operator.maximumEstimatedCostUsd = 0; }],
    ["hidden server conversation", (c) => { c.mind.conversationId = "hidden"; }],
    ["unknown cache mode", (c) => { c.mind.cacheMode = "1h"; }],
    ["request timeout not covered by lease", (c) => { c.mind.requestTimeoutMs = 600_000; }],
  ];
  for (const [label, mutate] of invalid) it(`refuses ${label} after proving valid base`, async (t) => {
    const { c } = await valid(t);
    mutate(c);
    assert.equal((await load(t, c)).ok, false, label);
  });
  for (const field of ["inputUsdPerMillionTokens", "outputUsdPerMillionTokens", "verifiedOn"] as const) {
    it(`null ${field} remains inspectable but blocks paid execution`, async (t) => {
      const { c } = await valid(t);
      (c.mind.costBound as Json)[field] = null;
      const loaded = await load(t, c);
      assert.ok(loaded.ok, "unknown pricing is inspectable configuration, never spending permission");
      assert.ok(paidExecutionBlockers(loaded.resolved.config).some((s) => s.includes(field)));
    });
  }
  it("a declared rate below the selected endpoint's known bound cannot unblock paid calls", async (t) => {
    const { c } = await valid(t);
    (c.mind.costBound as Json).outputUsdPerMillionTokens = 1;
    const loaded = await load(t, c);
    if (loaded.ok) assert.ok(paidExecutionBlockers(loaded.resolved.config).length > 0);
  });
  it("production createMind selects the real adapter, passes exact tools and uses only injected credentials", async (t) => {
    const { resolved } = await valid(t);
    const io = transport([sse()]);
    const built = create(resolved, { fetch: io.fetch, env: { ALIFE_PHASE5_TEST_KEY: KEY } });
    assert.equal(built.mind.id, "anthropic-messages-v1");
    assert.equal(built.mind.capabilities.maximumOutputTokens, 128_000);
    const outcome = await built.mind.invoke({ requestId: "factory-1", tick: 1, instructions: resolved.prompt.text, tools: resolved.tools,
      history: [], observation: "Synthetic observation.", maximumOutputTokens: 128_000 }, new AbortController().signal);
    assert.equal(outcome.outcome, "responded");
    assert.equal(io.calls.length, 1);
    assert.equal(io.calls[0]!.headers.get("x-api-key"), KEY);
    assert.equal(built.rates.inputUsdPerMillionTokens, 4);
    assert.equal(built.rates.outputUsdPerMillionTokens, 20);
  });
  it("factory refuses missing configured credentials without generic fallback or a provider request", async (t) => {
    const { resolved } = await valid(t);
    const io = transport();
    assert.throws(() => create(resolved, { fetch: io.fetch, env: { ANTHROPIC_API_KEY: KEY } }), /credential|ALIFE_|key/i);
    assert.equal(io.calls.length, 0);
  });
});
