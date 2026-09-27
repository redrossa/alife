import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { syncDirectory } from "./files.ts";

// The shared spending campaign (Phase 5 plan §5): one durable, bounded ledger
// that every paid model call across runs, processes, and attempts is admitted
// against, on top of each run's own ledger. It is created once, explicitly;
// nothing opens it into existence, resets it, or raises its limit. Each
// reservation's full maximum is journaled durably before the provider can be
// contacted; an unknown outcome keeps it all, and only trustworthy evidence
// (reported usage, or certainty that nothing was processed) releases any.
//
// Layout (private directory, mode 700; files mode 600):
//   metadata.json   immutable: schema, campaign ID, limit, store bound, creation time
//   journal.jsonl   append-only: `reserve` and `settle` records with a contiguous `seq`
//   owner.lock      present while a process owns the campaign; a crashed owner leaves it,
//                   and only an operator who has reviewed the journal removes it
// Every regular file counts against the store bound, which always leaves room
// to settle every outstanding reservation.

export const CAMPAIGN_SCHEMA_VERSION = 1;
/** The one campaign every Phase 5 smoke run and probe is admitted against. */
export const SMOKE_CAMPAIGN_ID = "phase5-smoke-v1";
const METADATA = "metadata.json";
const JOURNAL = "journal.jsonl";
const LOCK = "owner.lock";
const MAXIMUM_ID = 256;

export class CampaignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignError";
  }
}

export interface CampaignReservation {
  readonly runId: string;
  readonly requestId: string;
  readonly maximumMicroUsd: number;
}

export type CampaignSettlement = { readonly runId: string; readonly requestId: string } & (
  | { readonly basis: "usage"; readonly chargedMicroUsd: number }
  | { readonly basis: "unknown" | "not_processed" }
);

export interface CampaignSnapshot {
  readonly campaignId: string;
  readonly limitMicroUsd: number;
  /** Settled charges: reported usage, and whole reservations whose outcome is unknown. */
  readonly accountedMicroUsd: number;
  readonly outstanding: readonly CampaignReservation[];
  readonly remainingMicroUsd: number;
  /** A settlement exceeded its reservation: nothing more is admitted until reviewed. */
  readonly reviewRequired: boolean;
}

export interface CampaignLocation {
  readonly directory: string;
  readonly campaignId: string;
}

export interface CreateCampaignOptions extends CampaignLocation {
  readonly limitMicroUsd: number;
  /** Bound on every file in the campaign directory together. */
  readonly maximumBytes: number;
}

const positive = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const amount = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(MAXIMUM_ID);
const campaignIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "campaign IDs are 1-64 lowercase letters, digits, and hyphens");

const metadataSchema = z.strictObject({
  schemaVersion: z.literal(CAMPAIGN_SCHEMA_VERSION),
  campaignId: campaignIdSchema,
  limitMicroUsd: positive,
  maximumBytes: positive,
  createdAt: z.iso.datetime(),
});

type Metadata = z.infer<typeof metadataSchema>;

const recordSchema = z.discriminatedUnion("type", [
  z.strictObject({ seq: positive, type: z.literal("reserve"), runId: identifier, requestId: identifier, maximumMicroUsd: positive, at: z.iso.datetime() }),
  z.strictObject({
    seq: positive,
    type: z.literal("settle"),
    runId: identifier,
    requestId: identifier,
    basis: z.enum(["usage", "unknown", "not_processed"]),
    chargedMicroUsd: amount,
    at: z.iso.datetime(),
  }),
]);

type JournalRecord = z.infer<typeof recordSchema>;

/** The ledger's state, derived only from the journal. */
interface State {
  seq: number;
  accounted: number;
  reviewRequired: boolean;
  readonly outstanding: Map<string, CampaignReservation>;
  /** Every reservation identity ever used: spent for good, settled or not. */
  readonly spent: Set<string>;
}

const key = (runId: string, requestId: string) => `${runId}\u0000${requestId}`;

function apply(state: State, record: JournalRecord, limit: number): void {
  if (record.seq !== state.seq + 1) throw new CampaignError(`journal record ${record.seq} does not follow ${state.seq}`);
  state.seq = record.seq;
  const id = key(record.runId, record.requestId);
  if (record.type === "reserve") {
    if (state.spent.has(id)) throw new CampaignError(`journal record ${record.seq} reuses a reservation identity`);
    state.spent.add(id);
    state.outstanding.set(id, { runId: record.runId, requestId: record.requestId, maximumMicroUsd: record.maximumMicroUsd });
    return;
  }
  const reservation = state.outstanding.get(id);
  if (reservation === undefined) throw new CampaignError(`journal record ${record.seq} settles a reservation that is not outstanding`);
  const expected = record.basis === "unknown" ? reservation.maximumMicroUsd : record.basis === "not_processed" ? 0 : record.chargedMicroUsd;
  if (record.chargedMicroUsd !== expected) throw new CampaignError(`journal record ${record.seq} charges an amount its basis does not allow`);
  state.outstanding.delete(id);
  state.accounted += record.chargedMicroUsd;
  if (record.chargedMicroUsd > reservation.maximumMicroUsd) state.reviewRequired = true;
  if (!Number.isSafeInteger(state.accounted) || state.accounted > Number.MAX_SAFE_INTEGER - limit) throw new CampaignError("the journal's charges overflow");
}

function outstandingTotal(state: State): number {
  let total = 0;
  for (const reservation of state.outstanding.values()) total += reservation.maximumMicroUsd;
  return total;
}

/** A private regular file, never a link; returns its size. */
async function privateFile(file: string, what: string): Promise<number> {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    throw new CampaignError(`the campaign's ${what} is missing or unreadable (${(error as NodeJS.ErrnoException).code ?? String(error)}); missing evidence is never read as zero spending`);
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new CampaignError(`the campaign's ${what} is not a regular file`);
  if ((info.mode & 0o077) !== 0) throw new CampaignError(`the campaign's ${what} is readable or writable by others (mode ${(info.mode & 0o777).toString(8)})`);
  return info.size;
}

async function privateDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new CampaignError("the campaign directory must be an absolute path");
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    throw new CampaignError(`there is no campaign at ${directory} (${(error as NodeJS.ErrnoException).code ?? String(error)}); campaigns are created only explicitly`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new CampaignError(`the campaign path ${directory} is not a real directory`);
  if ((info.mode & 0o077) !== 0) throw new CampaignError(`the campaign directory is accessible to others (mode ${(info.mode & 0o777).toString(8)})`);
}

interface Loaded {
  readonly metadata: Metadata;
  readonly state: State;
  /** Bytes of the metadata and journal. */
  readonly bytes: number;
}

/** Reads and replays a campaign; any damage fails closed. */
async function load(location: CampaignLocation): Promise<Loaded> {
  const directory = location.directory;
  const metadataBytes = await privateFile(path.join(directory, METADATA), "metadata");
  const journalBytes = await privateFile(path.join(directory, JOURNAL), "journal");
  let metadata: Metadata;
  try {
    const parsed = metadataSchema.safeParse(JSON.parse(await readFile(path.join(directory, METADATA), "utf8")));
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "invalid");
    metadata = parsed.data;
  } catch (error) {
    throw new CampaignError(`the campaign's metadata is corrupt: ${(error as Error).message}`);
  }
  if (metadata.campaignId !== location.campaignId) {
    throw new CampaignError(`the campaign at ${directory} is ${metadata.campaignId}, not ${location.campaignId}; another campaign's identity is never adopted`);
  }
  const text = await readFile(path.join(directory, JOURNAL), "utf8");
  if (text.length > 0 && !text.endsWith("\n")) throw new CampaignError("the campaign's journal ends with a partial record");
  const state: State = { seq: 0, accounted: 0, reviewRequired: false, outstanding: new Map(), spent: new Set() };
  const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
  for (const [index, line] of lines.entries()) {
    let record: JournalRecord;
    try {
      const parsed = recordSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "invalid");
      record = parsed.data;
    } catch (error) {
      throw new CampaignError(`the campaign's journal is corrupt at line ${index + 1}: ${(error as Error).message}`);
    }
    apply(state, record, metadata.limitMicroUsd);
  }
  return { metadata, state, bytes: metadataBytes + journalBytes };
}

function snapshotOf(metadata: Metadata, state: State): CampaignSnapshot {
  return {
    campaignId: metadata.campaignId,
    limitMicroUsd: metadata.limitMicroUsd,
    accountedMicroUsd: state.accounted,
    outstanding: [...state.outstanding.values()].map((reservation) => ({ ...reservation })),
    remainingMicroUsd: metadata.limitMicroUsd - state.accounted - outstandingTotal(state),
    reviewRequired: state.reviewRequired,
  };
}

/** Creates the lock exclusively; a lock that exists (a live or crashed owner) is never broken here. */
async function takeLock(directory: string): Promise<{ readonly token: string; readonly bytes: number }> {
  const token = randomBytes(16).toString("hex");
  const content = `${JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() })}\n`;
  let handle: FileHandle;
  try {
    handle = await open(path.join(directory, LOCK), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CampaignError(
        `the campaign at ${directory} is owned by another process, or by one that crashed; review its journal and remove ${LOCK} explicitly only once no owner is running`,
      );
    }
    throw error;
  }
  try {
    // Not synced: ownership only matters while its owner lives; the journal is what must survive a host crash.
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return { token, bytes: Buffer.byteLength(content) };
}

async function releaseLock(directory: string, token: string): Promise<void> {
  const file = path.join(directory, LOCK);
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return;
  const held = (JSON.parse(text) as { token?: unknown }).token;
  if (held !== token) throw new CampaignError("the campaign lock no longer carries this owner's token; leaving it in place");
  await unlink(file);
}

function checkAmount(value: number, what: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new RangeError(`${what} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
}

function checkIdentity(runId: unknown, requestId: unknown): void {
  for (const [name, value] of [["runId", runId], ["requestId", requestId]] as const) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_ID || [...value].some((char) => char.charCodeAt(0) < 0x20)) {
      throw new RangeError(`${name} must be a printable string of at most ${MAXIMUM_ID} characters`);
    }
  }
}

/** One process's exclusive handle on a campaign, from open (or creation) until `close`. */
export class Campaign {
  readonly directory: string;
  readonly #metadata: Metadata;
  readonly #state: State;
  readonly #token: string;
  #bytes: number;
  #journal: FileHandle;
  #closed = false;
  #unsynced = false;
  #failed: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(directory: string, metadata: Metadata, state: State, token: string, bytes: number, journal: FileHandle) {
    this.directory = directory;
    this.#metadata = metadata;
    this.#state = state;
    this.#token = token;
    this.#bytes = bytes;
    this.#journal = journal;
  }

  static async attach(directory: string, loaded: Loaded, lock: { readonly token: string; readonly bytes: number }): Promise<Campaign> {
    const journal = await open(path.join(directory, JOURNAL), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    return new Campaign(directory, loaded.metadata, loaded.state, lock.token, loaded.bytes + lock.bytes, journal);
  }

  get campaignId(): string {
    return this.#metadata.campaignId;
  }

  snapshot(): Promise<CampaignSnapshot> {
    return Promise.resolve(snapshotOf(this.#metadata, this.#state));
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #usable(): void {
    if (this.#closed) throw new CampaignError("the campaign handle is closed");
    if (this.#failed !== null) throw new CampaignError(`the campaign journal failed earlier (${this.#failed}); nothing more is admitted`);
  }

  /** Bytes a settlement of `reservation` can take: kept free for as long as it is outstanding. */
  #settlementBytes(reservation: CampaignReservation): number {
    return Buffer.byteLength(
      `${JSON.stringify({ seq: Number.MAX_SAFE_INTEGER, type: "settle", runId: reservation.runId, requestId: reservation.requestId, basis: "not_processed", chargedMicroUsd: Number.MAX_SAFE_INTEGER, at: "+275760-09-13T00:00:00.000Z" })}\n`,
    );
  }

  /**
   * Appends one record. A reservation is durable before it returns. A
   * settlement is made durable by the next reservation or by `close`: losing it
   * to a host crash only leaves the whole reservation held.
   */
  async #append(record: JournalRecord): Promise<void> {
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    try {
      let offset = 0;
      while (offset < line.length) offset += (await this.#journal.write(line, offset)).bytesWritten;
      this.#unsynced = true;
      if (record.type === "reserve") {
        await this.#journal.datasync();
        this.#unsynced = false;
      }
    } catch (error) {
      this.#failed = (error as Error).message;
      throw error;
    }
    this.#bytes += line.length;
  }

  /**
   * Durably holds `maximumMicroUsd` for one request before it is sent, or
   * returns null (holding nothing) when it does not fit or review is required.
   * An identity is spent once reserved, whatever happens to it.
   */
  reserve(reservation: CampaignReservation): Promise<CampaignReservation | null> {
    return this.#serial(async () => {
      this.#usable();
      checkIdentity(reservation.runId, reservation.requestId);
      checkAmount(reservation.maximumMicroUsd, "maximumMicroUsd");
      const id = key(reservation.runId, reservation.requestId);
      if (this.#state.spent.has(id)) throw new CampaignError(`request ${reservation.requestId} of run ${reservation.runId} was already reserved; it is never admitted again`);
      if (this.#state.reviewRequired) return null;
      const snapshot = snapshotOf(this.#metadata, this.#state);
      if (reservation.maximumMicroUsd > snapshot.remainingMicroUsd) return null;
      const record: JournalRecord = { seq: this.#state.seq + 1, type: "reserve", runId: reservation.runId, requestId: reservation.requestId, maximumMicroUsd: reservation.maximumMicroUsd, at: new Date().toISOString() };
      const held = { runId: reservation.runId, requestId: reservation.requestId, maximumMicroUsd: reservation.maximumMicroUsd };
      let settlements = this.#settlementBytes(held);
      for (const pending of this.#state.outstanding.values()) settlements += this.#settlementBytes(pending);
      const needed = this.#bytes + Buffer.byteLength(`${JSON.stringify(record)}\n`) + settlements;
      if (needed > this.#metadata.maximumBytes) {
        throw new CampaignError(`the campaign store is at capacity (${this.#metadata.maximumBytes} bytes, room kept to settle what is outstanding); nothing more is admitted`);
      }
      await this.#append(record);
      apply(this.#state, record, this.#metadata.limitMicroUsd);
      return held;
    });
  }

  /** Settles an outstanding reservation once: reported usage, unknown (keeps it all), or certainly not processed. */
  settle(settlement: CampaignSettlement): Promise<void> {
    return this.#serial(async () => {
      this.#usable();
      checkIdentity(settlement.runId, settlement.requestId);
      const reservation = this.#state.outstanding.get(key(settlement.runId, settlement.requestId));
      if (settlement.basis === "usage") checkAmount(settlement.chargedMicroUsd, "chargedMicroUsd", true);
      else if (settlement.basis !== "unknown" && settlement.basis !== "not_processed") throw new RangeError("unknown settlement basis");
      if (reservation === undefined) throw new CampaignError(`request ${settlement.requestId} of run ${settlement.runId} has no outstanding reservation; nothing is refunded`);
      const charged = settlement.basis === "usage" ? settlement.chargedMicroUsd : settlement.basis === "unknown" ? reservation.maximumMicroUsd : 0;
      const record: JournalRecord = { seq: this.#state.seq + 1, type: "settle", runId: settlement.runId, requestId: settlement.requestId, basis: settlement.basis, chargedMicroUsd: charged, at: new Date().toISOString() };
      await this.#append(record);
      apply(this.#state, record, this.#metadata.limitMicroUsd);
    });
  }

  /** Ends ownership. Outstanding reservations stay held in the journal for whoever opens it next. */
  close(): Promise<void> {
    return this.#serial(async () => {
      if (this.#closed) return;
      this.#closed = true;
      if (this.#unsynced && this.#failed === null) await this.#journal.datasync();
      await this.#journal.close();
      await releaseLock(this.directory, this.#token);
    });
  }
}

/** Creates a new campaign and returns the handle that owns it. Never touches an existing directory. */
export async function createCampaign(options: CreateCampaignOptions): Promise<Campaign> {
  const campaignId = campaignIdSchema.safeParse(options.campaignId);
  if (!campaignId.success) throw new RangeError(campaignId.error.issues[0]?.message ?? "invalid campaign ID");
  checkAmount(options.limitMicroUsd, "limitMicroUsd");
  checkAmount(options.maximumBytes, "maximumBytes");
  const directory = options.directory;
  if (!path.isAbsolute(directory)) throw new CampaignError("the campaign directory must be an absolute path");
  const metadata: Metadata = {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    campaignId: campaignId.data,
    limitMicroUsd: options.limitMicroUsd,
    maximumBytes: options.maximumBytes,
    createdAt: new Date().toISOString(),
  };
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  if (Buffer.byteLength(metadataText) + 256 > options.maximumBytes) throw new RangeError("maximumBytes cannot hold even the campaign's metadata");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CampaignError(`${directory} already exists; a campaign is created only once and is never reset or replaced`);
    }
    throw error;
  }
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
  const lock = await takeLock(directory);
  for (const [name, content] of [[METADATA, metadataText], [JOURNAL, ""]] as const) {
    const file = await open(path.join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(content);
      await file.chmod(0o600);
      // The empty journal has no contents to flush; its name is made durable with the directory.
      if (content.length > 0) await file.sync();
    } finally {
      await file.close();
    }
  }
  await Promise.all([syncDirectory(directory), syncDirectory(path.dirname(directory))]);
  return Campaign.attach(directory, await load({ directory, campaignId: metadata.campaignId }), lock);
}

/** Opens an existing campaign exclusively. Missing, damaged, or foreign evidence refuses; nothing is created or repaired. */
export async function openCampaign(location: CampaignLocation): Promise<Campaign> {
  await privateDirectory(location.directory);
  const lock = await takeLock(location.directory);
  try {
    return await Campaign.attach(location.directory, await load(location), lock);
  } catch (error) {
    await releaseLock(location.directory, lock.token).catch(() => undefined);
    throw error;
  }
}

/** Reads a campaign's state without owning it (for status); refuses anything `openCampaign` would. */
export async function readCampaign(location: CampaignLocation): Promise<CampaignSnapshot & { readonly owned: boolean }> {
  await privateDirectory(location.directory);
  const loaded = await load(location);
  const owned = await lstat(path.join(location.directory, LOCK)).then(() => true, () => false);
  return { ...snapshotOf(loaded.metadata, loaded.state), owned };
}
