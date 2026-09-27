import { z } from "zod";

import {
  BODY_PROFILES,
  CAPTURE_PROFILES,
  CONTAINER_PROFILES,
  CONTEXT_POLICIES,
  IPC_PROFILES,
  JOB_POLICIES,
  LOGGING_PROFILES,
  NETWORK_PROFILES,
  OUTPUT_TRUNCATION,
  RETRY_PROFILES,
  SEEDS,
  SENSOR_PROFILES,
  STORAGE_PROFILES,
  TOKEN_ESTIMATORS,
  names,
} from "./profiles.ts";

export const CONFIG_SCHEMA_VERSION = 2;

/** Controller memory for retained job output: every tracked job keeps up to capturedOutputBytes per stream. */
export const MAXIMUM_RETAINED_OUTPUT_BYTES = 256 << 20;

// Configuration schema version 2 (plan §10). Version 1 described action
// timeouts, which bounded waiting with continuing jobs superseded (plan §8.3). Every object is strict: unknown
// fields are errors, so a typo or an unsupported safety setting such as
// `privileged` can never be silently ignored. Numeric ceilings are sanity
// bounds that catch unit mistakes, not recommendations.

const int = (min: number, max: number) => z.int().min(min).max(max);

/** A digest-pinned reference (`name@sha256:…`) or a local image ID (`sha256:…`). */
const pinnedImage = z
  .string()
  .regex(/^(?:[a-z0-9][a-z0-9._\-/:]*@)?sha256:[a-f0-9]{64}$/, "must be pinned by digest (name@sha256:… or sha256:…)");

const worldSchema = z.strictObject({
  image: pinnedImage,
  container: z.enum(names(CONTAINER_PROFILES)),
  storage: z.strictObject({
    profile: z.enum(names(STORAGE_PROFILES)),
    /** Provisioning, attach, and capture tools; never runs agent code. */
    helperImage: pinnedImage,
    capacityMiB: int(16, 16_384),
    inodes: int(64, 4_194_304),
    capture: z.enum(names(CAPTURE_PROFILES)),
  }),
  memoryMiB: int(64, 16_384),
  swapMiB: int(0, 16_384),
  cpus: z.number().min(0.05).max(16),
  pids: int(8, 4096),
  fileDescriptors: int(32, 65_536),
  tmpMiB: int(1, 1024),
  shmMiB: int(1, 1024),
  network: z.enum(names(NETWORK_PROFILES)),
  ipc: z.enum(names(IPC_PROFILES)),
  logging: z.enum(names(LOGGING_PROFILES)),
  uid: int(1, 65_534),
  gid: int(1, 65_534),
  seed: z.enum(names(SEEDS)),
});

const bodySchema = z.strictObject({
  profile: z.enum(names(BODY_PROFILES)),
  sensors: z.enum(names(SENSOR_PROFILES)),
  minimumTickIntervalMs: int(0, 3_600_000),
  /** How long one tick waits for a shell action; not an execution deadline. */
  actionWaitMs: int(100, 600_000),
  jobPolicy: z.enum(names(JOB_POLICIES)),
  maximumConcurrentJobs: int(1, 64),
  retainedFinishedJobs: int(0, 1024),
  maximumCommandBytes: int(1, 65_536),
  capturedOutputBytes: int(1, 16_777_216),
  perceivedOutputBytes: int(2, 1_048_576),
  outputTruncation: z.enum(names(OUTPUT_TRUNCATION)),
  contextBudgetTokens: int(1024, 2_000_000),
  contextMarginTokens: int(0, 100_000),
  tokenEstimator: z.enum(names(TOKEN_ESTIMATORS)),
  exposeContextUsage: z.boolean(),
  contextPolicy: z.enum(names(CONTEXT_POLICIES)),
  /** Path relative to the configuration file. */
  prompt: z.string().min(1),
});

const mindShared = {
  maximumOutputTokens: int(1, 131_072),
  requestTimeoutMs: int(1000, 600_000),
  retryProfile: z.enum(names(RETRY_PROFILES)),
};

const fakeMindSchema = z.strictObject({
  provider: z.literal("fake"),
  /** Path relative to the configuration file. */
  script: z.string().min(1),
  ...mindShared,
});

const usdPerMillion = z.number().positive().max(10_000).nullable();

const openaiMindSchema = z.strictObject({
  provider: z.literal("openai"),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be an explicit model ID"),
  // Only an ALIFE_-prefixed variable, so a website deployment key or a
  // generically named key in the operator's shell is never picked up by accident.
  credentialEnv: z.string().regex(/^ALIFE_[A-Z0-9_]+$/, "must be an ALIFE_-prefixed environment variable name"),
  ...mindShared,
  // Upper per-token rates for the selected model and request mode. Null rates
  // are valid configuration but block paid execution.
  costBound: z.strictObject({
    inputUsdPerMillionTokens: usdPerMillion,
    outputUsdPerMillionTokens: usdPerMillion,
    source: z.string().min(1),
    verifiedOn: z.iso.date().nullable(),
  }),
});

/** Models an adapter supports, with their verified limits (Phase 5). */
export const ANTHROPIC_MODELS = {
  "claude-opus-5-5": {
    contextTokens: 1_000_000,
    maximumOutputTokens: 128_000,
    // Standard, uncached published rates at selection (2026-09-27); configured rates may be higher, never lower.
    minimumInputUsdPerMillionTokens: 4,
    minimumOutputUsdPerMillionTokens: 20,
  },
} as const;

const anthropicMindSchema = z.strictObject({
  provider: z.literal("anthropic"),
  model: z.enum(Object.keys(ANTHROPIC_MODELS) as [keyof typeof ANTHROPIC_MODELS]),
  // Only an ALIFE_-prefixed variable, never a generic provider key from the operator's shell.
  credentialEnv: z.string().regex(/^ALIFE_[A-Z0-9_]+$/, "must be an ALIFE_-prefixed environment variable name"),
  ...mindShared,
  /** Mapped to output_config.effort; adaptive thinking is always on for the selected model. */
  reasoningEffort: z.literal("high"),
  costBound: z.strictObject({
    inputUsdPerMillionTokens: usdPerMillion,
    outputUsdPerMillionTokens: usdPerMillion,
    source: z.string().min(1),
    verifiedOn: z.iso.date().nullable(),
  }),
});

const operatorSchema = z.strictObject({
  /** Attempted model calls, failed ones included (Phase 3 operator decision 3). */
  maximumTicks: int(1, 1_000_000),
  maximumRunSeconds: int(1, 2_592_000),
  maximumEstimatedCostUsd: z.number().min(0).max(100_000),
  recordLimitMiB: int(16, 1_048_576),
  minimumHostFreeMiB: int(0, 1_048_576),
  maximumConsecutiveProtocolErrors: int(1, 1000),
  watchdogLeaseSeconds: int(10, 3600),
  heartbeatIntervalSeconds: int(1, 1200),
  /**
   * The shared spending campaign every paid call is admitted against (Phase 5): an absolute path to a
   * campaign created explicitly with `campaign create`. Required for a paid provider.
   */
  campaignDirectory: z.string().refine((value) => value.startsWith("/"), "must be an absolute path").optional(),
});

export const configSchema = z
  .strictObject({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    world: worldSchema,
    body: bodySchema,
    mind: z.discriminatedUnion("provider", [fakeMindSchema, openaiMindSchema, anthropicMindSchema]),
    operator: operatorSchema,
  })
  .superRefine((config, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const { world, body, mind, operator } = config;

    // ext4 needs at least one block per inode; 4 KiB blocks give 256 per MiB.
    if (world.storage.inodes > world.storage.capacityMiB * 256) {
      issue(["world", "storage", "inodes"], `cannot exceed ${world.storage.capacityMiB * 256} for ${world.storage.capacityMiB} MiB`);
    }
    if (world.swapMiB > world.memoryMiB) {
      issue(["world", "swapMiB"], "cannot exceed memoryMiB");
    }
    // Jobs share the world's PID limit with init and the harness's own readings.
    if (body.maximumConcurrentJobs >= world.pids) {
      issue(["body", "maximumConcurrentJobs"], "must be less than world.pids");
    }
    const retained = trackedJobBound(body) * 2 * body.capturedOutputBytes;
    if (retained > MAXIMUM_RETAINED_OUTPUT_BYTES) {
      issue(
        ["body", "retainedFinishedJobs"],
        `tracked jobs could retain ${retained} bytes of output; the limit is ${MAXIMUM_RETAINED_OUTPUT_BYTES}`,
      );
    }
    if (body.perceivedOutputBytes > body.capturedOutputBytes) {
      issue(["body", "perceivedOutputBytes"], "cannot exceed capturedOutputBytes");
    }
    if (mind.maximumOutputTokens + body.contextMarginTokens >= body.contextBudgetTokens) {
      issue(["mind", "maximumOutputTokens"], "output allowance plus margin must leave room for input in contextBudgetTokens");
    }

    // The watchdog must be able to tell a slow tick from a dead controller.
    const leaseMs = operator.watchdogLeaseSeconds * 1000;
    if (operator.heartbeatIntervalSeconds * 3 > operator.watchdogLeaseSeconds) {
      issue(["operator", "heartbeatIntervalSeconds"], "must be at most a third of watchdogLeaseSeconds");
    }
    if (mind.requestTimeoutMs >= leaseMs) {
      issue(["mind", "requestTimeoutMs"], "must be shorter than watchdogLeaseSeconds");
    }
    if (body.actionWaitMs >= leaseMs) {
      issue(["body", "actionWaitMs"], "must be shorter than watchdogLeaseSeconds");
    }
    const runMs = operator.maximumRunSeconds * 1000;
    if (body.actionWaitMs > runMs) issue(["body", "actionWaitMs"], "cannot exceed maximumRunSeconds");
    if (mind.requestTimeoutMs > runMs) issue(["mind", "requestTimeoutMs"], "cannot exceed maximumRunSeconds");

    if (mind.provider !== "fake" && operator.maximumEstimatedCostUsd <= 0) {
      issue(["operator", "maximumEstimatedCostUsd"], "must be positive for a paid provider");
    }
    if (mind.provider === "anthropic") {
      const model = ANTHROPIC_MODELS[mind.model];
      if (mind.maximumOutputTokens > model.maximumOutputTokens) {
        issue(["mind", "maximumOutputTokens"], `cannot exceed ${model.maximumOutputTokens} for ${mind.model}`);
      }
      if (body.contextBudgetTokens > model.contextTokens) {
        issue(["body", "contextBudgetTokens"], `cannot exceed the ${model.contextTokens}-token context of ${mind.model}`);
      }
      // Retained provider reasoning is only accounted for by the continuation-aware profiles.
      if (body.tokenEstimator !== "anthropic-wire-bound-v1") issue(["body", "tokenEstimator"], "must be anthropic-wire-bound-v1 for the anthropic provider");
      if (body.contextPolicy !== "recent-complete-exchanges-v3") issue(["body", "contextPolicy"], "must be recent-complete-exchanges-v3 for the anthropic provider");
      if (operator.campaignDirectory === undefined) issue(["operator", "campaignDirectory"], "is required for a paid provider");
    }
  });

export type Config = z.infer<typeof configSchema>;

/**
 * Jobs the harness may track at once: those holding admission slots (active,
 * or finished but not yet reported) and the reported finished jobs it retains.
 */
export function trackedJobBound(body: { readonly maximumConcurrentJobs: number; readonly retainedFinishedJobs: number }): number {
  return body.maximumConcurrentJobs + body.retainedFinishedJobs;
}
