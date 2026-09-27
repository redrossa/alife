import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import { loadConfig } from "../../src/config/resolve.ts";
import { parseWorldId, type RunId } from "../../src/core/ids.ts";
import { startRun } from "../../src/operator/run.ts";
import { prepareStateDir, type StateLayout } from "../../src/operator/state-dir.ts";
import { runPaths } from "../../src/records/run-store.ts";
import { CAPTURE_COVERAGE, captureInto, type ArchiveEntryRecord } from "../../src/world/archive.ts";
import { writeTar } from "../../src/world/tar.ts";
import { variant } from "./config.ts";
import { FakeClock } from "./fake-clock.ts";
import { FAKE_IDENTITY, FakeWorld } from "./fake-world.ts";

// Test-local forward contracts: no production stubs or static missing imports.
export interface ArchiveLimits {
  maximumArchiveBytes: number;
  maximumEntries: number;
  maximumReadBytes: number;
}
interface Completeness { complete: boolean; omissions: readonly string[] }
interface Inspection {
  listArchive(options: { directory: string; limits: ArchiveLimits }): Promise<Completeness & { entries: readonly ArchiveEntryRecord[] }>;
  readArchiveFile(options: { directory: string; pathBase64: string; offset: number; length: number; limits: ArchiveLimits }): Promise<Completeness & {
    data: Uint8Array; totalBytes: number; offset: number; truncated: boolean;
  }>;
}
export interface InventoryFile { path: string; bytes: number; sha256: string }
export interface ExportResult extends Completeness {
  directory: string; manifestFile: string; files: readonly InventoryFile[];
}
export interface ExportOptions {
  layout: StateLayout; runId: RunId; outputDirectory: string; maximumBytes: number; maximumFiles: number;
}
interface Exporter { exportRun(options: ExportOptions): Promise<ExportResult> }

async function feature(name: string, functions: readonly string[]): Promise<unknown> {
  const url = new URL(`../../src/records/${name}.ts`, import.meta.url);
  assert.ok(existsSync(url), `phase 4 contract: missing src/records/${name}.ts`);
  const loaded = await import(url.href) as Record<string, unknown>;
  for (const key of functions) assert.equal(typeof loaded[key], "function", `phase 4 contract: ${name}.ts must export ${key}()`);
  return loaded;
}
export async function inspection(): Promise<Inspection> {
  return await feature("inspection", ["listArchive", "readArchiveFile"]) as Inspection;
}
export async function exporter(): Promise<Exporter> {
  return await feature("export", ["exportRun"]) as Exporter;
}
export const limits: ArchiveLimits = { maximumArchiveBytes: 1 << 20, maximumEntries: 100, maximumReadBytes: 4096 };
export const archiveId = "a-20260925T161449Z-0c7e55d2";
export const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0, 0xff, 0x61, 0x0a, 0xc3, 0xa9]);
export const encoded = (name: string | Uint8Array): string => Buffer.from(name).toString("base64");
export const digest = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
export const regularTar = (names = ["artifact.bin"]): Buffer => writeTar(names.map((name) => ({ path: name, type: "file", mode: 0o700, content: bytes })), 0);

/** Mutates only a ustar header, recalculating its checksum. The production
 * TarReader inside captureInto, not a fixture parser, builds the index.
 * Empty bodies make link/device fixtures valid without pretending to follow them. */
export function headerTar(name: Buffer, flag = "0", target = ""): Buffer {
  const tar = writeTar([{ path: "placeholder", type: "file", mode: 0o600 }], 0);
  tar.fill(0, 0, 100);
  name.copy(tar, 0);
  tar.write(flag, 156, 1, "latin1");
  tar.write(target, 157, 100, "utf8");
  tar.fill(0x20, 148, 156);
  const sum = tar.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return tar;
}
export async function scratch(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "alife-phase4-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Mirrors backend.ts's schemaVersion 1 manifest. UUID/source facts are
 * inert synthetic stopped-filesystem evidence; tar bytes/index/hash are real. */
export async function archiveFixture(root: string, tar = regularTar(), incomplete = false) {
  const directory = path.join(root, archiveId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const captureLimits = { maximumBytes: 1 << 20, maximumEntries: 100, timeoutMs: 300_000 };
  const outcome = await captureInto(directory, captureLimits, (sink) => {
    sink(tar);
    return Promise.resolve({ containerId: "offline-fixture", name: "offline-fixture", exitCode: 0, timedOut: false, stopped: false, stdout: Buffer.alloc(0), stdoutBytes: tar.length, stderr: Buffer.alloc(0), stderrBytes: 0, streamProblem: null });
  });
  const sourceState = { state: "clean", mountCount: 1, lastWriteTime: "2026-09-25T16:14:49.000Z" };
  const manifest = {
    schemaVersion: 1, archiveId, worldId: FAKE_IDENTITY.worldId, label: "manual", capture: "tar-capture-v1",
    createdAt: "2026-09-25T16:14:49.000Z", completedAt: "2026-09-25T16:14:49.000Z",
    complete: outcome.complete && !incomplete,
    omissions: incomplete ? [...outcome.omissions, "fixture: socket not captured"] : [...outcome.omissions],
    coverage: CAPTURE_COVERAGE, limits: captureLimits,
    archive: { file: "archive.tar", bytes: outcome.bytes, sha256: outcome.sha256 },
    source: { uuid: FAKE_IDENTITY.storageIdentity, device: "/dev/loop7", before: sourceState, after: sourceState, unchanged: true },
    helper: outcome.helper, entryCount: outcome.entries.length, entries: outcome.entries.map((entry) => ({ ...entry })),
  };
  const manifestFile = path.join(directory, "manifest.json");
  const save = () => writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await save();
  return { directory, manifest, manifestFile, save };
}

/** Real offline run, fake mind and FakeWorld only; a large output creates a
 * genuine referenced content-addressed blob. No Docker/provider interfaces. */
export async function runFixture(t: TestContext, damagedStop = false) {
  const root = await scratch(t);
  const layout = await prepareStateDir(path.join(root, "state"));
  const config = await variant((c) => {
    c.operator.maximumTicks = 1;
    c.body.perceivedOutputBytes = 32768;
    c.body.contextBudgetTokens = 262144; // Accommodate the declared worst-case perception bound.
  });
  t.after(() => rm(path.dirname(config), { recursive: true, force: true }));
  await writeFile(path.join(path.dirname(config), "fake-script.json"), JSON.stringify({ schemaVersion: 1, turns: [{ type: "shell", command: "fixture-only" }] }));
  const loaded = await loadConfig(config);
  assert.ok(loaded.ok, "valid fake fixture configuration");
  const world = new FakeWorld(() => ({ stdout: "evidence\n".repeat(3000) }));
  if (damagedStop) world.stopResult = { verified: false, recorded: true, detail: "fixture stop unknown" };
  const result = await startRun({
    layout, resolved: loaded.resolved, worldId: parseWorldId(FAKE_IDENTITY.worldId), clock: new FakeClock(),
    signal: new AbortController().signal, allowPrivilegedHelper: false,
    openWorld: () => Promise.resolve(world), hostFreeMiB: () => Promise.resolve(1_000_000),
  });
  assert.ok(result.recorded);
  return {
    root, layout, world, runId: result.runId, paths: runPaths(layout, result.runId),
    options: { layout, runId: result.runId, outputDirectory: path.join(root, "export"), maximumBytes: 8 << 20, maximumFiles: 100 } satisfies ExportOptions,
  };
}

/** Snapshot does not follow symlinks; compare before/after to catch mutation or extraction. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const info = await lstat(file);
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (info.isSymbolicLink()) result[relative] = "symlink";
      else if (info.isDirectory()) await visit(file);
      else result[relative] = digest(await readFile(file));
    }
  }
  await visit(root);
  return result;
}

export async function verifyExport(result: ExportResult, options: ExportOptions): Promise<void> {
  assert.equal(result.directory, options.outputDirectory);
  assert.equal(result.manifestFile, path.join(result.directory, "export-manifest.json"));
  const inventory = JSON.parse(await readFile(result.manifestFile, "utf8")) as {
    files: InventoryFile[]; complete: boolean; omissions: string[];
  };
  assert.deepEqual(inventory.files, result.files);
  assert.equal(inventory.complete, result.complete);
  assert.deepEqual(inventory.omissions, result.omissions);
  assert.equal(new Set(result.files.map((file) => file.path)).size, result.files.length);
  const actual = await snapshot(result.directory);
  assert.deepEqual(Object.keys(actual).sort(), [...result.files.map((file) => file.path), "export-manifest.json"].sort());
  for (const file of result.files) {
    assert.ok(!path.isAbsolute(file.path) && !file.path.split("/").includes(".."));
    assert.match(file.path, /^(run|archives)\//);
    const content = await readFile(path.join(result.directory, file.path));
    assert.equal(content.length, file.bytes);
    assert.equal(digest(content), file.sha256);
  }
  // Caps cover ALL emitted bytes/files, including the separate export manifest.
  const emitted = await Promise.all(Object.keys(actual).map((file) => readFile(path.join(result.directory, file))));
  assert.ok(emitted.reduce((sum, data) => sum + data.length, 0) <= options.maximumBytes);
  assert.ok(emitted.length <= options.maximumFiles);
}
