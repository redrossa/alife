import { randomBytes } from "node:crypto";

import type { RandomBytes } from "./clock.ts";

// Identifiers are used as directory names, Docker resource-name components,
// and exact-match arguments for destructive operations, so each kind has one
// strict, path-safe format.
//
//   world:  w-20260925T161449Z-3f9a1c2b   persistent storage lineage
//   run:    r-20260925T161449Z-8d04e6a1   one episode
//   archive: a-20260925T161449Z-0c7e55d2  one stopped-world capture
//   tick:   1-based decision index within a run
//   request/action: <run>.t000042.request / <run>.t000042.action

const STAMP = /^\d{8}T\d{6}Z$/;
const WORLD_ID = /^w-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const RUN_ID = /^r-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const ARCHIVE_ID = /^a-\d{8}T\d{6}Z-[0-9a-f]{8}$/;

export type WorldId = string & { readonly __brand: "WorldId" };
export type RunId = string & { readonly __brand: "RunId" };
export type ArchiveId = string & { readonly __brand: "ArchiveId" };

function stamp(date: Date): string {
  const value = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  if (!STAMP.test(value)) throw new RangeError(`cannot format identifier time from ${date.toISOString()}`);
  return value;
}

function suffix(random: RandomBytes): string {
  const bytes = random(4);
  if (bytes.length !== 4) throw new RangeError("random source returned the wrong number of bytes");
  return Buffer.from(bytes).toString("hex");
}

export function newWorldId(now: Date, random: RandomBytes = randomBytes): WorldId {
  return `w-${stamp(now)}-${suffix(random)}` as WorldId;
}

export function newRunId(now: Date, random: RandomBytes = randomBytes): RunId {
  return `r-${stamp(now)}-${suffix(random)}` as RunId;
}

export function newArchiveId(now: Date, random: RandomBytes = randomBytes): ArchiveId {
  return `a-${stamp(now)}-${suffix(random)}` as ArchiveId;
}

export function isArchiveId(value: string): value is ArchiveId {
  return ARCHIVE_ID.test(value);
}

export function isWorldId(value: string): value is WorldId {
  return WORLD_ID.test(value);
}

export function isRunId(value: string): value is RunId {
  return RUN_ID.test(value);
}

export function parseWorldId(value: string): WorldId {
  if (!isWorldId(value)) throw new RangeError(`not a world ID: ${JSON.stringify(value)}`);
  return value;
}

export function parseRunId(value: string): RunId {
  if (!isRunId(value)) throw new RangeError(`not a run ID: ${JSON.stringify(value)}`);
  return value;
}

function tickPart(tick: number): string {
  if (!Number.isSafeInteger(tick) || tick < 1) throw new RangeError(`invalid tick ${tick}`);
  return `t${String(tick).padStart(6, "0")}`;
}

/** The single model request of a tick. There are no retries, so one per tick suffices. */
export function requestId(run: RunId, tick: number): string {
  return `${run}.${tickPart(tick)}.request`;
}

/** The single action dispatched in a tick, if any. */
export function actionId(run: RunId, tick: number): string {
  return `${run}.${tickPart(tick)}.action`;
}
