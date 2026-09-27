import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { LoopState } from "../core/loop.ts";
import type { StopSafetyAssessment } from "../core/execution-safety.ts";
import type { LedgerState } from "./accounting.ts";
import { STOP_REASONS } from "../core/state.ts";
import type { RunPaths } from "./run-store.ts";

// Clean-stop checkpoints (plan §11.3). Written only after every operation has
// a recorded outcome and the world stop is verified, and never overwritten:
// each is stored under its own hash and named by the event that follows it.
// A checkpoint is what a clean resume would continue from; it holds the
// bounded active history, not the observer's record.

// Version 4 records the world's history fence: where the world's own log
// stood when the checkpoint was written, so a resume can tell that no other
// execution used the world since (Phase 4 plan §4.1). Version 5 (Phase 5)
// lets a retained reply carry its provider continuation (`anthropic-thinking-v1`)
// and binds the checkpoint to the shared spending campaign its calls were
// admitted against; version 4 is still read and resumed under its own
// policies, with no continuation or campaign invented for it. Version 3 embeds the
// sealed, review-free safety assessment of the run's execution epoch and the
// stop it came from (Phase 3 lifecycle plan §7.4); it is still read, as
// evidence, but it cannot be resumed from. Version 2 separated attempted from
// answered model calls. Earlier versions were only ever written by tests and
// are never read as clean.
export const CHECKPOINT_SCHEMA_VERSION = 5;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.int().min(0);

const toolCall = z.strictObject({ callId: z.string(), name: z.string(), arguments: z.string() });
const reply = { text: z.string().nullable(), refusal: z.string().nullable(), toolCalls: z.array(toolCall) };
const results = z.array(z.strictObject({ callId: z.string(), output: z.string() }));
/** Exchanges before version 5 carry no provider state. */
const plainExchange = z.strictObject({ tick: z.int().min(1), observation: z.string(), reply: z.strictObject(reply), results });
const continuation = z.strictObject({
  profile: z.literal("anthropic-thinking-v1"),
  data: z.string(),
  inputTokenBound: z.int().min(0).max(128_000),
});
const exchange = z.strictObject({
  tick: z.int().min(1),
  observation: z.string(),
  reply: z.strictObject({ ...reply, continuation: continuation.exactOptional() }),
  results,
});

const jobState = z.enum(["unconfirmed", "running", "exited", "uncertain", "ended_with_world"]);
const outcome = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("shell"), jobId: z.string(), state: jobState, exitCode: z.int().nullable() }),
  z.strictObject({ kind: z.literal("not_dispatched"), detail: z.string() }),
  z.strictObject({ kind: z.literal("wait") }),
  z.strictObject({ kind: z.literal("no_action"), reason: z.enum(["text", "refusal", "empty"]) }),
  z.strictObject({
    kind: z.literal("invalid"),
    reason: z.enum(["multiple_actions", "unknown_tool", "invalid_arguments", "command_too_large", "incomplete_response"]),
    detail: z.string(),
  }),
  z.strictObject({
    kind: z.literal("model_failed"),
    failure: z.enum(["connection", "timeout", "rate_limited", "authentication", "server", "invalid_response", "unavailable", "aborted", "adapter_error"]),
  }),
  z.strictObject({
    kind: z.literal("request_not_sent"),
    reason: z.enum(["operator_stop", "spend_limit", "request_invalid", "context_overflow", "review_required"]),
  }),
]);

const reservation = z.strictObject({ requestId: z.string(), inputTokens: count, outputTokens: count, microUsd: count });

function loopSchema<T extends z.ZodType>(history: T) {
  return z.strictObject({
    completedTicks: count,
    attemptedCalls: count,
    respondedCalls: count,
    elapsedMs: z.number().min(0),
    history: z.array(history),
    evictedCount: count,
    previousOutcome: outcome.nullable(),
    previousInputTokens: count.nullable(),
    protocolErrorStreak: count,
  });
}

const fields = {
  runId: z.string(),
  worldId: z.string(),
  writtenAt: z.iso.datetime(),
  state: z.enum(["stopped_clean", "completed"]),
  stopReason: z.enum(STOP_REASONS),
  configSha256: sha256,
  world: z.strictObject({ engineId: z.string(), storageUuid: z.string(), image: z.string() }),
  deadline: z.iso.datetime(),
  /** Sequence of the last run event before the checkpoint was written. */
  lastEventSequence: z.int().min(1),
  loop: loopSchema(plainExchange),
  ledger: z.strictObject({ limitMicroUsd: count, accountedMicroUsd: count, outstanding: z.array(reservation) }),
  /** The verified, fully recorded stop this checkpoint follows. */
  worldStop: z.strictObject({ verified: z.literal(true), recorded: z.literal(true), detail: z.string() }),
  /**
   * The sealed assessment of the run's execution epoch. Only a review-free one
   * is accepted: anything uncertain or incompletely evidenced can never be
   * written or read as a clean checkpoint.
   */
  safety: z.strictObject({
    epochId: z.string().min(1),
    admission: z.literal("closed"),
    reviewRequired: z.literal(false),
    uncertainEffects: z.array(z.never()).length(0),
    reviewCauses: z.array(z.never()).length(0),
    requiredEvidenceFailed: z.literal(false),
    committedEffects: count,
    sealed: z.literal(true),
  }),
};

/**
 * The world's own log at the checkpoint: its last sequence and the hash of its
 * bytes up to that point. Null for a world without a log of its own (a test
 * double); a Docker world always has one.
 */
export const worldFenceSchema = z.strictObject({ sequence: z.int().min(0), bytes: count, sha256 }).nullable();

/** The shared spending campaign a paid run's calls were admitted against; null for a run without one. */
export const campaignBindingSchema = z.strictObject({ campaignId: z.string().min(1), directory: z.string().startsWith("/") }).nullable();

export const checkpointSchema = z.strictObject({
  schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
  ...fields,
  loop: loopSchema(exchange),
  worldFence: worldFenceSchema,
  campaign: campaignBindingSchema,
});
const version4Schema = z.strictObject({ schemaVersion: z.literal(4), ...fields, worldFence: worldFenceSchema });
const legacyCheckpointSchema = z.strictObject({ schemaVersion: z.literal(3), ...fields });

export type Checkpoint = z.infer<typeof checkpointSchema>;
/** Resumable under the policies it was written with; no continuation or campaign. */
export type CheckpointV4 = z.infer<typeof version4Schema>;
export type LegacyCheckpoint = z.infer<typeof legacyCheckpointSchema>;
export type WorldFence = NonNullable<Checkpoint["worldFence"]>;

/** What the controller supplies; the schema check copies it into a `Checkpoint`. */
export type CheckpointInput = Omit<Checkpoint, "loop" | "ledger" | "safety"> & {
  readonly loop: LoopState;
  readonly ledger: LedgerState;
  /** Checked by the schema: anything but a sealed, review-free assessment is refused. */
  readonly safety: StopSafetyAssessment;
};

// A stored checkpoint must be usable as loop state again (clean resume).
const _resumable = (loop: Checkpoint["loop"]): LoopState => loop;
void _resumable;

export interface CheckpointRef {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Writes a checkpoint through `write`, which must refuse to replace a file and count it against the record limit. */
export async function writeCheckpoint(paths: RunPaths, checkpoint: CheckpointInput, write: (file: string, bytes: Uint8Array) => Promise<void>): Promise<CheckpointRef> {
  const checked = checkpointSchema.parse(checkpoint);
  if (checked.loop.completedTicks === 0 && checked.loop.history.length > 0) throw new Error("checkpoint history without completed ticks");
  if (checked.ledger.outstanding.length > 0) throw new Error("a clean checkpoint cannot have outstanding reservations");
  const bytes = Buffer.from(`${JSON.stringify(checked, null, 2)}\n`, "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const file = path.join(paths.checkpoints, `${hash}.json`);
  await write(file, bytes);
  return { file, sha256: hash, bytes: bytes.length };
}

/** Reads a checkpoint by hash, verifying its bytes and schema. A version 3 checkpoint is read as it was written. */
export async function readCheckpoint(paths: RunPaths, hash: string): Promise<Checkpoint | CheckpointV4 | LegacyCheckpoint> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new RangeError(`not a checkpoint hash: ${JSON.stringify(hash)}`);
  const bytes = await readFile(path.join(paths.checkpoints, `${hash}.json`));
  if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error(`checkpoint ${hash} does not match its hash`);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const version = typeof value === "object" && value !== null ? (value as { schemaVersion?: unknown }).schemaVersion : undefined;
  return version === 3 ? legacyCheckpointSchema.parse(value) : version === 4 ? version4Schema.parse(value) : checkpointSchema.parse(value);
}
