import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { z } from "zod";

import type { Clock } from "../core/clock.ts";
import { isRunId, isWorldId } from "../core/ids.ts";

// Single-owner locks for worlds and runs (plan §12). A lock is an exclusively
// created file holding a random token. Control operations present the token;
// nothing signals or breaks a lock based on a PID alone, because PIDs are
// recycled. Staleness is reported to the operator, never assumed.
//
// Checking a token and unlinking the file are separate steps, so every removal
// holds a per-lock release guard and checks the token while holding it. A
// second remover then sees the replacement owner's token and refuses. Acquiring
// needs no guard: O_EXCL creation is already atomic.

export type OwnedKind = "world" | "run";

const ownerRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.enum(["world", "run"]),
  id: z.string(),
  token: z.string().regex(/^[a-f0-9]{32}$/),
  pid: z.int().min(1),
  hostname: z.string(),
  acquiredAt: z.iso.datetime(),
});

export type OwnerRecord = z.infer<typeof ownerRecordSchema>;

export interface HolderStatus {
  readonly holder: OwnerRecord | null;
  /** Null when the lock file is unreadable or the holder is on another host. PID reuse makes `true` advisory. */
  readonly appearsAlive: boolean | null;
}

export class ReleaseInProgressError extends Error {
  readonly guard: string;

  constructor(guard: string) {
    super(`another release of this lock is in progress; if none is running, remove ${guard}`);
    this.name = "ReleaseInProgressError";
    this.guard = guard;
  }
}

/** The lock does not carry the token presented; it is left in place. */
export class LockTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockTokenError";
  }
}

export class OwnershipConflictError extends Error {
  readonly status: HolderStatus;

  constructor(kind: OwnedKind, id: string, status: HolderStatus) {
    const who = status.holder ? `pid ${status.holder.pid} on ${status.holder.hostname} since ${status.holder.acquiredAt}` : "an unreadable lock";
    super(`${kind} ${id} is already owned by ${who}`);
    this.name = "OwnershipConflictError";
    this.status = status;
  }
}

function lockPath(locksDir: string, kind: OwnedKind, id: string): string {
  const valid = kind === "world" ? isWorldId(id) : isRunId(id);
  if (!valid) throw new RangeError(`not a ${kind} ID: ${JSON.stringify(id)}`);
  return path.join(locksDir, `${kind}-${id}.lock`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readHolder(file: string): Promise<HolderStatus | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let holder: OwnerRecord | null = null;
  try {
    const parsed = ownerRecordSchema.safeParse(JSON.parse(text));
    if (parsed.success) holder = parsed.data;
  } catch {
    // Unreadable lock (for example, a crash mid-write): report it, do not remove it.
  }
  const appearsAlive = holder !== null && holder.hostname === hostname() ? processAlive(holder.pid) : null;
  return { holder, appearsAlive };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function releaseGuardPath(lockFile: string): string {
  return lockFile.replace(/\.lock$/, ".release");
}

/**
 * Removes `file` only if, while holding the release guard, it still carries
 * `token` and `permit` accepts its holder. Never waits: a held guard is
 * reported, since a crashed remover can leave one behind.
 */
async function removeLock(file: string, token: string, permit: (status: HolderStatus | null) => void): Promise<void> {
  const guard = releaseGuardPath(file);
  let handle;
  try {
    handle = await open(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ReleaseInProgressError(guard);
    throw error;
  }
  try {
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, hostname: hostname() })}\n`);
    } finally {
      await handle.close();
    }
    const status = await readHolder(file);
    permit(status);
    if (status?.holder?.token !== token) throw new LockTokenError(`lock ${file} does not carry the expected token; leaving it in place`);
    // Not synced: if a host crash undoes the removal, the lock reappears with a holder that is gone,
    // which only ever blocks until an operator releases it explicitly.
    await unlink(file);
  } finally {
    await unlink(guard);
  }
}

export class Ownership {
  readonly path: string;
  readonly record: OwnerRecord;
  #release: Promise<void> | null = null;

  constructor(file: string, record: OwnerRecord) {
    this.path = file;
    this.record = record;
  }

  /**
   * Removes the lock only if it still carries this owner's token. Concurrent
   * and repeated calls share one attempt; a failed attempt may be retried.
   */
  release(): Promise<void> {
    this.#release ??= removeLock(this.path, this.record.token, (status) => {
      if (status?.holder?.token !== this.record.token) {
        throw new LockTokenError(`lock ${this.path} is no longer held by this owner; leaving it in place`);
      }
    }).catch((error: unknown) => {
      this.#release = null;
      throw error;
    });
    return this.#release;
  }
}

export async function acquireOwnership(
  locksDir: string,
  kind: OwnedKind,
  id: string,
  clock: Clock,
): Promise<Ownership> {
  const owned = await createLock(locksDir, kind, id, clock);
  await syncDirectory(locksDir);
  return owned;
}

/**
 * Takes several locks together: none is kept if any cannot be taken. Each
 * record is durable before the directory sync that makes all their names
 * durable at once.
 */
export async function acquireOwnerships(
  locksDir: string,
  wanted: readonly { readonly kind: OwnedKind; readonly id: string }[],
  clock: Clock,
): Promise<Ownership[]> {
  const results = await Promise.allSettled(wanted.map(({ kind, id }) => createLock(locksDir, kind, id, clock)));
  const held = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failure = results.find((result) => result.status === "rejected");
  try {
    if (failure !== undefined) throw failure.reason;
    await syncDirectory(locksDir);
  } catch (error) {
    await Promise.all(held.map((owned) => owned.release().catch(() => undefined)));
    throw error;
  }
  return held;
}

/** Creates a lock file exclusively with a durable record; the caller makes its name durable. */
async function createLock(locksDir: string, kind: OwnedKind, id: string, clock: Clock): Promise<Ownership> {
  const file = lockPath(locksDir, kind, id);
  const record: OwnerRecord = {
    schemaVersion: 1,
    kind,
    id,
    token: randomBytes(16).toString("hex"),
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: clock.now().toISOString(),
  };

  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new OwnershipConflictError(kind, id, (await readHolder(file)) ?? { holder: null, appearsAlive: null });
  }
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return new Ownership(file, record);
}

export async function inspectOwnership(locksDir: string, kind: OwnedKind, id: string): Promise<HolderStatus | null> {
  return readHolder(lockPath(locksDir, kind, id));
}

/**
 * Explicit operator action for a lock left by a dead controller. Requires the
 * exact token from the lock file and refuses while the holder appears alive.
 */
export async function releaseAbandonedOwnership(
  locksDir: string,
  kind: OwnedKind,
  id: string,
  token: string,
): Promise<void> {
  const file = lockPath(locksDir, kind, id);
  if ((await readHolder(file)) === null) return;
  await removeLock(file, token, (status) => {
    if (status === null) throw new LockTokenError(`the lock for ${kind} ${id} was removed during release`);
    if (status.holder?.token !== token) throw new LockTokenError(`token does not match the lock for ${kind} ${id}`);
    if (status.appearsAlive !== false) throw new OwnershipConflictError(kind, id, status);
  });
}
