import assert from "node:assert/strict";
import { appendFile, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { main } from "../../src/cli.ts";
import { acquireOwnership } from "../../src/operator/locks.ts";
import { REPOSITORY_ROOT } from "../../src/operator/state-dir.ts";
import { analyzeRun, finalizeRun } from "../../src/records/finalize.ts";
import { RunRecorder } from "../../src/records/run-store.ts";
import { FakeClock } from "../support/fake-clock.ts";
import { FAKE_IDENTITY } from "../support/fake-world.ts";
import {
  archiveFixture, archiveId, bytes, digest, encoded, exporter, headerTar, inspection,
  limits, regularTar, runFixture, scratch, snapshot, verifyExport,
} from "../support/phase4-artifacts.ts";

// Every test resolves the real future module BEFORE assert.rejects/cap fallbacks:
// absent APIs must produce an assertion RED, never a false-positive refusal.
// Inspection never extracts. Export is private evidence copying, not restoration.
async function associateArchive(fixture: Awaited<ReturnType<typeof runFixture>>, tar = regularTar(), incomplete = false) {
  const archive = await archiveFixture(path.join(fixture.paths.directory, "archives"), tar, incomplete);
  const recorder = await RunRecorder.open({ paths: fixture.paths, runId: fixture.runId, clock: new FakeClock(), limitBytes: 64 << 20 });
  try {
    await recorder.append("archive.created", { phase: "manual", archiveId, worldId: FAKE_IDENTITY.worldId,
      complete: archive.manifest.complete, omissions: archive.manifest.omissions }, { durable: true });
  } finally { await recorder.close(); }
  return archive;
}

describe("phase 4 artifact inspection contract", () => {
  it("fixtures produce a valid real run with a blob and a complete indexed archive", async (t) => {
    const f = await runFixture(t);
    assert.equal((await analyzeRun(f.paths, f.runId)).state, "completed");
    assert.ok((await readdir(f.paths.blobs)).length > 0, "export fixture must actually contain referenced blob data");
    const archive = await archiveFixture(f.root);
    assert.equal(archive.manifest.complete, true);
    assert.equal(archive.manifest.entries.length, 1);
    assert.equal(archive.manifest.entries[0]!.sha256, digest(bytes));
    assert.equal(archive.manifest.archive.sha256, digest(await readFile(path.join(archive.directory, "archive.tar"))));
  });

  it("lists the actual capture index without changing or materializing source contents", async (t) => {
    const api = await inspection();
    const fixture = await archiveFixture(await scratch(t));
    const before = await snapshot(fixture.directory);
    const result = await api.listArchive({ directory: fixture.directory, limits });
    assert.deepEqual(result, { entries: fixture.manifest.entries, complete: true, omissions: [] });
    assert.deepEqual(await snapshot(fixture.directory), before);
  });

  it("preserves Unicode, normalization distinctions, and a leading filename BOM", async (t) => {
    const api = await inspection();
    const names = ["é.txt", "e\u0301.txt", "\ufeffé.txt", "世界.txt"];
    const fixture = await archiveFixture(await scratch(t), regularTar(names));
    const listed = await api.listArchive({ directory: fixture.directory, limits });
    assert.deepEqual(listed.entries.map((entry) => [entry.path, entry.pathBase64]), names.map((name) => [name, encoded(name)]));
    for (const name of names) {
      const result = await api.readArchiveFile({ directory: fixture.directory, pathBase64: encoded(name), offset: 0, length: bytes.length, limits });
      assert.deepEqual(Buffer.from(result.data), bytes);
      assert.equal(result.truncated, false);
    }
  });

  it("addresses invalid UTF-8 names byte-exactly without replacement-character aliasing", async (t) => {
    const api = await inspection();
    const raw = Buffer.from([0xff, 0x61]);
    const fixture = await archiveFixture(await scratch(t), headerTar(raw));
    const listed = await api.listArchive({ directory: fixture.directory, limits });
    assert.equal(listed.entries[0]!.path, null);
    assert.equal(listed.entries[0]!.pathBase64, encoded(raw));
    const result = await api.readArchiveFile({ directory: fixture.directory, pathBase64: encoded(raw), offset: 0, length: 10, limits });
    assert.equal(result.data.length, 0);
    assert.equal(result.totalBytes, 0);
    await assert.rejects(() => api.readArchiveFile({ directory: fixture.directory, pathBase64: encoded("�a"), offset: 0, length: 10, limits }));
  });

  it("reads binary bounded ranges without decoding BOM, NUL, or invalid UTF-8", async (t) => {
    const api = await inspection();
    const fixture = await archiveFixture(await scratch(t));
    const result = await api.readArchiveFile({ directory: fixture.directory, pathBase64: encoded("artifact.bin"), offset: 2, length: 4, limits });
    assert.deepEqual(Buffer.from(result.data), bytes.subarray(2, 6));
    assert.equal(result.totalBytes, bytes.length);
    assert.equal(result.offset, 2);
    assert.equal(result.truncated, true); // Remaining bytes after the returned window.
    assert.equal(result.complete, true); // Capture completeness is independent of range truncation.
    assert.deepEqual(result.omissions, []);
  });

  it("handles zero-length ranges, crossing EOF, and exact EOF without padding", async (t) => {
    const api = await inspection();
    const fixture = await archiveFixture(await scratch(t));
    for (const [offset, length] of [[0, 0], [bytes.length - 2, 100], [bytes.length, 10]] as const) {
      const result = await api.readArchiveFile({ directory: fixture.directory, pathBase64: encoded("artifact.bin"), offset, length, limits });
      assert.deepEqual(Buffer.from(result.data), bytes.subarray(offset, offset + length));
      assert.equal(result.offset, offset);
      assert.equal(result.totalBytes, bytes.length);
      assert.equal(result.truncated, offset + result.data.length < bytes.length);
    }
  });

  it("retains incomplete capture labels on both listing and successful reads", async (t) => {
    const api = await inspection();
    const fixture = await archiveFixture(await scratch(t), regularTar(), true);
    const options = { directory: fixture.directory, limits };
    for (const result of [await api.listArchive(options), await api.readArchiveFile({ ...options, pathBase64: encoded("artifact.bin"), offset: 0, length: 20 })]) {
      assert.equal(result.complete, false);
      for (const omission of fixture.manifest.omissions) assert.ok(result.omissions.includes(omission));
    }
  });

  it("lists duplicate names but refuses to choose one for a read", async (t) => {
    const api = await inspection();
    const fixture = await archiveFixture(await scratch(t), regularTar(["duplicate", "duplicate"]));
    assert.equal((await api.listArchive({ directory: fixture.directory, limits })).entries.length, 2);
    await assert.rejects(() => api.readArchiveFile({ directory: fixture.directory, pathBase64: encoded("duplicate"), offset: 0, length: 1, limits }));
  });

  it("treats hostile traversal/absolute/control-byte entry names only as data", async (t) => {
    const api = await inspection();
    const root = await scratch(t);
    for (const [i, name] of ["../escape", "/absolute", "$(touch owned)\n\u001b[31m"].entries()) {
      const fixture = await archiveFixture(path.join(root, String(i)), headerTar(Buffer.from(name)));
      const before = await snapshot(root);
      const listed = await api.listArchive({ directory: fixture.directory, limits });
      assert.equal(listed.entries[0]!.pathBase64, encoded(name));
      assert.deepEqual(await snapshot(root), before);
    }
  });

  it("describes links and special entries but never reads through them", async (t) => {
    const api = await inspection();
    const root = await scratch(t);
    for (const [flag, type] of [["1", "hardlink"], ["2", "symlink"], ["3", "character"], ["4", "block"], ["5", "directory"], ["6", "fifo"], ["X", "other"]]) {
      const fixture = await archiveFixture(path.join(root, flag!), headerTar(Buffer.from("entry"), flag, "../../secret"));
      const before = await snapshot(root);
      const listed = await api.listArchive({ directory: fixture.directory, limits });
      assert.equal(listed.entries[0]!.type, type);
      await assert.rejects(() => api.readArchiveFile({ directory: fixture.directory, pathBase64: encoded("entry"), offset: 0, length: 10, limits }));
      assert.deepEqual(await snapshot(root), before);
    }
  });

  for (const damage of ["archive hash", "archive size", "tar structure", "index content", "index path", "index count", "manifest JSON"] as const) {
    it(`refuses inconsistent ${damage} for listing and reading`, async (t) => {
      const api = await inspection();
      const fixture = await archiveFixture(await scratch(t));
      if (damage === "archive hash") {
        const file = path.join(fixture.directory, "archive.tar");
        const content = await readFile(file);
        content[512] = content[512]! ^ 1;
        await writeFile(file, content);
      } else if (damage === "archive size") fixture.manifest.archive.bytes++;
      else if (damage === "tar structure") {
        const file = path.join(fixture.directory, "archive.tar");
        const content = await readFile(file);
        content[148] = 0x39; // Invalid octal checksum; outer size/hash still agree.
        await writeFile(file, content);
        fixture.manifest.archive.sha256 = digest(content);
      } else if (damage === "index content") fixture.manifest.entries[0]!.sha256 = "0".repeat(64);
      else if (damage === "index path") {
        fixture.manifest.entries[0]!.path = "../../outside";
        fixture.manifest.entries[0]!.pathBase64 = encoded("../../outside");
      } else if (damage === "index count") fixture.manifest.entryCount++;
      if (damage === "manifest JSON") await writeFile(fixture.manifestFile, '{"schemaVersion":1,');
      else await fixture.save();
      const options = { directory: fixture.directory, limits };
      await assert.rejects(() => api.listArchive(options));
      await assert.rejects(() => api.readArchiveFile({ ...options, pathBase64: encoded("artifact.bin"), offset: 0, length: 1 }));
    });
  }

  it("refuses traversal and absolute archive filenames in an otherwise valid manifest", async (t) => {
    const api = await inspection();
    const root = await scratch(t);
    const fixture = await archiveFixture(root);
    const outside = path.join(root, "outside.tar");
    await writeFile(outside, regularTar());
    for (const file of ["../outside.tar", outside]) {
      fixture.manifest.archive.file = file;
      await fixture.save();
      await assert.rejects(() => api.listArchive({ directory: fixture.directory, limits }));
      await assert.rejects(() => api.readArchiveFile({ directory: fixture.directory, pathBase64: encoded("artifact.bin"), offset: 0, length: 1, limits }));
    }
  });

  it("refuses symlinked archive or manifest files even when target bytes match", async (t) => {
    const api = await inspection();
    const root = await scratch(t);
    for (const name of ["archive.tar", "manifest.json"]) {
      const fixture = await archiveFixture(path.join(root, name));
      const source = path.join(fixture.directory, name);
      const outside = path.join(root, `outside-${name}`);
      await rename(source, outside);
      await symlink(outside, source);
      await assert.rejects(() => api.listArchive({ directory: fixture.directory, limits }));
      await assert.rejects(() => api.readArchiveFile({ directory: fixture.directory, pathBase64: encoded("artifact.bin"), offset: 0, length: 1, limits }));
    }
  });

  it("rejects unsafe range arithmetic, malformed base64, and absent entries", async (t) => {
    const api = await inspection();
    const fixture = await archiveFixture(await scratch(t));
    const options = { directory: fixture.directory, pathBase64: encoded("artifact.bin"), offset: 0, length: 1, limits };
    for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(() => api.readArchiveFile({ ...options, offset: bad }));
      await assert.rejects(() => api.readArchiveFile({ ...options, length: bad }));
    }
    await assert.rejects(() => api.readArchiveFile({ ...options, offset: Number.MAX_SAFE_INTEGER, length: 2 }));
    for (const pathBase64 of ["%%%", "YQ===", encoded("absent")]) await assert.rejects(() => api.readArchiveFile({ ...options, pathBase64 }));
  });

  it("enforces archive, entry and read caps and rejects invalid limits", async (t) => {
    const api = await inspection();
    const fixture = await archiveFixture(await scratch(t), regularTar(["artifact.bin", "second"]));
    for (const bounded of [{ ...limits, maximumArchiveBytes: 512 }, { ...limits, maximumEntries: 1 }]) {
      await assert.rejects(() => api.listArchive({ directory: fixture.directory, limits: bounded }));
      await assert.rejects(() => api.readArchiveFile({ directory: fixture.directory, pathBase64: encoded("artifact.bin"), offset: 0, length: 1, limits: bounded }));
    }
    await assert.rejects(() => api.readArchiveFile({ directory: fixture.directory, pathBase64: encoded("artifact.bin"), offset: 0, length: 10, limits: { ...limits, maximumReadBytes: 2 } }));
    for (const key of Object.keys(limits)) {
      await assert.rejects(() => api.listArchive({ directory: fixture.directory, limits: { ...limits, [key]: -1 } }));
    }
  });
});

describe("phase 4 artifact CLI wiring", () => {
  it("observe list escapes hostile names and never touches the source world", async (t) => {
    await inspection();
    const fixture = await runFixture(t);
    const archive = await associateArchive(fixture, headerTar(Buffer.from("evil\u001b[31m\n$(touch escaped)")));
    const before = await snapshot(fixture.layout.root);
    const calls = [...fixture.world.calls];
    const out: string[] = [], err: string[] = [];
    const code = await main(["observe", "list", fixture.runId, "--archive", archiveId, "--state-dir", fixture.layout.root],
      (s) => out.push(s), (s) => err.push(s));
    assert.equal(code, 0, err.join("\n"));
    assert.match(out.join("\n"), /evil/);
    assert.equal(out.join("\n").includes("\u001b"), false, "terminal escape is data, never a live terminal command");
    assert.deepEqual(await snapshot(fixture.layout.root), before);
    assert.deepEqual(fixture.world.calls, calls);
    assert.equal(archive.manifest.entries.length, 1);
  });

  it("observe read --json returns byte-exact bounded content and completeness metadata", async (t) => {
    await inspection();
    const fixture = await runFixture(t);
    await associateArchive(fixture);
    const out: string[] = [], err: string[] = [];
    const code = await main(["observe", "read", fixture.runId, "--archive", archiveId, "artifact.bin", "--offset", "2", "--length", "4", "--json", "--state-dir", fixture.layout.root],
      (s) => out.push(s), (s) => err.push(s));
    assert.equal(code, 0, err.join("\n"));
    const value = JSON.parse(out.join("\n")) as { dataBase64: string; offset: number; totalBytes: number; truncated: boolean; complete: boolean };
    assert.deepEqual(Buffer.from(value.dataBase64, "base64"), bytes.subarray(2, 6));
    assert.deepEqual([value.offset, value.totalBytes, value.truncated, value.complete], [2, bytes.length, true, true]);
  });

  it("run export CLI invokes the private evidence exporter", async (t) => {
    await exporter();
    const fixture = await runFixture(t);
    const out: string[] = [], err: string[] = [];
    const code = await main(["run", "export", fixture.runId, "--output", fixture.options.outputDirectory, "--state-dir", fixture.layout.root, "--json"],
      (s) => out.push(s), (s) => err.push(s));
    assert.equal(code, 0, err.join("\n"));
    assert.ok(JSON.parse(out.join("\n")));
    assert.deepEqual(await readFile(path.join(fixture.options.outputDirectory, "run", "events.jsonl")), await readFile(fixture.paths.events));
    const manifest = JSON.parse(await readFile(path.join(fixture.options.outputDirectory, "export-manifest.json"), "utf8")) as { complete: boolean };
    assert.equal(manifest.complete, true);
  });
});

describe("phase 4 private evidence export contract", () => {
  it("roundtrips every allowlisted real run file and verifies the separate hashed inventory", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t);
    const before = await snapshot(fixture.paths.directory);
    assert.ok(Object.keys(before).some((name) => name.startsWith("blobs/")), "fixture includes a real referenced blob");
    assert.ok(Object.keys(before).some((name) => name.startsWith("checkpoints/")));
    const result = await api.exportRun(fixture.options);
    await verifyExport(result, fixture.options);
    assert.equal(result.complete, true);
    assert.deepEqual(result.omissions, []);
    for (const [name, hash] of Object.entries(before)) {
      assert.equal(digest(await readFile(path.join(result.directory, "run", name))), hash, name);
    }
    assert.deepEqual(await snapshot(fixture.paths.directory), before);
  });

  it("creates only private 0700 directories and 0600 files recursively", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t);
    const result = await api.exportRun(fixture.options);
    async function check(file: string): Promise<void> {
      const info = await lstat(file);
      assert.equal(info.isSymbolicLink(), false);
      assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600, file);
      if (info.isDirectory()) for (const name of await readdir(file)) await check(path.join(file, name));
    }
    await check(result.directory);
  });

  it("includes associated archive bytes and manifests without inspecting or extracting contents", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t);
    const archive = await associateArchive(fixture, regularTar(["\ufeff世界.bin"]));
    // A same-world capture is not implicitly an artifact of this run. Even an
    // ID collision in unassociated storage must not override the run-owned copy.
    await archiveFixture(path.join(fixture.layout.worlds, FAKE_IDENTITY.worldId, "archives"), regularTar(["other-run-only.bin"]));
    const before = await snapshot(fixture.layout.root);
    const result = await api.exportRun(fixture.options);
    await verifyExport(result, fixture.options);
    for (const name of ["archive.tar", "manifest.json"]) {
      const matches = result.files.filter((file) => file.path.startsWith("archives/") && file.path.endsWith(`${archiveId}/${name}`));
      assert.equal(matches.length, 1, name);
      assert.deepEqual(await readFile(path.join(result.directory, matches[0]!.path)), await readFile(path.join(archive.directory, name)));
    }
    assert.deepEqual(await snapshot(fixture.layout.root), before);
  });

  it("propagates incomplete associated capture evidence without inventing completeness", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t);
    const archive = await associateArchive(fixture, regularTar(), true);
    const result = await api.exportRun(fixture.options);
    assert.equal(result.complete, false);
    assert.ok(result.omissions.length > 0);
    const file = result.files.find((entry) => entry.path.startsWith("archives/") && entry.path.endsWith("/manifest.json"));
    assert.ok(file);
    assert.deepEqual(await readFile(path.join(result.directory, file.path)), await readFile(archive.manifestFile));
    await verifyExport(result, fixture.options);
  });

  it("excludes unrecognized files, .env and ownership/control credentials, not evidence strings", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t);
    const secret = "PHASE4-CONTROLLER-SECRET-DO-NOT-EXPORT";
    for (const name of [".env", "owner.json", "control.token", "notes.txt"]) await writeFile(path.join(fixture.paths.directory, name), secret);
    await writeFile(path.join(fixture.paths.blobs, ".env"), secret);
    await writeFile(path.join(fixture.layout.locks, "control.token"), secret);
    // A value already in allowlisted evidence must not be silently redacted.
    await appendFile(fixture.paths.prompt, "\nALIFE_EXAMPLE_TOKEN=literal-recorded-evidence\n");
    const result = await api.exportRun(fixture.options);
    for (const name of Object.keys(await snapshot(result.directory))) {
      assert.ok(!(await readFile(path.join(result.directory, name), "utf8")).includes(secret), name);
    }
    assert.deepEqual(await readFile(path.join(result.directory, "run/prompt.txt")), await readFile(fixture.paths.prompt));
  });

  it("never copies synthetic parent environment credentials into evidence", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t);
    const key = "ALIFE_PHASE4_EXPORT_SECRET";
    const previous = process.env[key];
    const sentinel = "synthetic-parent-secret-4ac9e05f";
    process.env[key] = sentinel;
    try {
      const result = await api.exportRun(fixture.options);
      for (const name of Object.keys(await snapshot(result.directory))) assert.ok(!(await readFile(path.join(result.directory, name), "utf8")).includes(sentinel));
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("refuses any pre-existing output without overwriting its contents", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t);
    await mkdir(fixture.options.outputDirectory);
    await assert.rejects(() => api.exportRun(fixture.options));
    await writeFile(path.join(fixture.options.outputDirectory, "sentinel"), "untouched");
    const before = await snapshot(fixture.options.outputDirectory);
    await assert.rejects(() => api.exportRun(fixture.options));
    assert.deepEqual(await snapshot(fixture.options.outputDirectory), before);
  });

  it("refuses output inside the source or repository", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t);
    for (const outputDirectory of [path.join(fixture.paths.directory, "export"), path.join(fixture.layout.root, "export"), path.join(REPOSITORY_ROOT, ".phase4-forbidden-export")]) {
      await assert.rejects(() => api.exportRun({ ...fixture.options, outputDirectory }));
      await assert.rejects(() => lstat(outputDirectory), { code: "ENOENT" });
    }
  });

  it("refuses source-file and output-parent symlink traversal", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t);
    const outside = path.join(fixture.root, "outside-prompt");
    await rename(fixture.paths.prompt, outside);
    await symlink(outside, fixture.paths.prompt);
    const before = await snapshot(fixture.layout.root);
    await assert.rejects(() => api.exportRun(fixture.options));
    assert.deepEqual(await snapshot(fixture.layout.root), before);
    const other = await runFixture(t);
    const alias = path.join(other.root, "alias");
    await symlink(other.layout.root, alias);
    await assert.rejects(() => api.exportRun({ ...other.options, outputDirectory: path.join(alias, "escaped-export") }));
    await assert.rejects(() => lstat(path.join(other.layout.root, "escaped-export")), { code: "ENOENT" });
  });

  it("refuses an actively owned run without releasing its lock or changing evidence", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t);
    const owner = await acquireOwnership(fixture.layout.locks, "run", fixture.runId, new FakeClock());
    try {
      const before = await snapshot(fixture.layout.root);
      await assert.rejects(() => api.exportRun(fixture.options));
      assert.deepEqual(await snapshot(fixture.layout.root), before);
    } finally { await owner.release(); }
  });

  it("exports damaged/interrupted events verbatim, incomplete, without repairing or replaying", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t, true);
    await appendFile(fixture.paths.events, Buffer.from([0x7b, 0x22, 0xff]));
    const before = await snapshot(fixture.layout.root);
    const calls = [...fixture.world.calls];
    const result = await api.exportRun(fixture.options);
    assert.equal(result.complete, false);
    assert.ok(result.omissions.length > 0);
    assert.deepEqual(await readFile(path.join(result.directory, "run/events.jsonl")), await readFile(fixture.paths.events));
    assert.deepEqual(await snapshot(fixture.layout.root), before);
    assert.deepEqual(fixture.world.calls, calls);
    await verifyExport(result, fixture.options);
  });

  it("includes real damaged-log finalization and future watchdog JSONL evidence verbatim", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t, true);
    await appendFile(fixture.paths.events, '{"interrupted":');
    await finalizeRun({ paths: fixture.paths, runId: fixture.runId, clock: new FakeClock(), analysis: await analyzeRun(fixture.paths, fixture.runId), world: { container: "stopped", detail: "offline fixture" }, limitBytes: null });
    // Deliberately incomplete watchdog evidence is copied, not rewritten into
    // a falsely complete record. Envelope uses the real event-store fields.
    const watchdog = `${JSON.stringify({ v: 1, runId: fixture.runId, seq: 1, session: "00000000-0000-4000-8000-000000000004", time: "2026-09-25T16:14:49.000Z", monotonicMs: 0, type: "watchdog.expired", data: { verified: true, reason: "deadline" } })}\n`;
    await writeFile(path.join(fixture.paths.directory, "watchdog.jsonl"), watchdog);
    const before = await snapshot(fixture.layout.root);
    const result = await api.exportRun(fixture.options);
    for (const name of ["finalization.json", "watchdog.jsonl", "events.jsonl"]) assert.deepEqual(await readFile(path.join(result.directory, "run", name)), await readFile(path.join(fixture.paths.directory, name)));
    assert.equal(result.complete, false);
    assert.ok(result.omissions.length > 0);
    assert.deepEqual(await snapshot(fixture.layout.root), before);
    await verifyExport(result, fixture.options);
  });

  it("enforces byte/file caps even on partial results or refusal and never labels truncation complete", async (t) => {
    const api = await exporter();
    for (const cap of [{ maximumBytes: 2048, maximumFiles: 100 }, { maximumBytes: 8 << 20, maximumFiles: 2 }]) {
      const fixture = await runFixture(t);
      const options = { ...fixture.options, ...cap };
      const before = await snapshot(fixture.layout.root);
      // Only the operation is caught, never assertions validating its result.
      const attempt = await api.exportRun(options).then((result) => ({ result }), (error: unknown) => ({ error }));
      if ("result" in attempt) {
        assert.equal(attempt.result.complete, false);
        assert.ok(attempt.result.omissions.length > 0);
        await verifyExport(attempt.result, options);
      } else assert.ok(attempt.error instanceof Error);
      // A failed export may leave bounded partial evidence, but no excess bytes.
      const present = await lstat(options.outputDirectory).then(() => true, (error: NodeJS.ErrnoException) => { assert.equal(error.code, "ENOENT"); return false; });
      if (present) {
        const files = Object.keys(await snapshot(options.outputDirectory));
        assert.ok(files.length <= options.maximumFiles);
        let total = 0;
        for (const file of files) total += (await lstat(path.join(options.outputDirectory, file))).size;
        assert.ok(total <= options.maximumBytes);
      }
      assert.deepEqual(await snapshot(fixture.layout.root), before);
    }
  });

  it("exports records with a missing referenced blob as explicitly incomplete evidence", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t);
    const blobs = await readdir(fixture.paths.blobs);
    assert.ok(blobs.length > 0);
    await rename(path.join(fixture.paths.blobs, blobs[0]!), path.join(fixture.root, "withheld-blob"));
    const before = await snapshot(fixture.layout.root);
    const result = await api.exportRun(fixture.options);
    assert.equal(result.complete, false);
    assert.ok(result.omissions.length > 0);
    assert.deepEqual(await readFile(path.join(result.directory, "run/events.jsonl")), await readFile(fixture.paths.events));
    assert.deepEqual(await snapshot(fixture.layout.root), before);
    await verifyExport(result, fixture.options);
  });

  it("rejects unsafe export limits before emitting files", async (t) => {
    const api = await exporter();
    const fixture = await runFixture(t);
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      for (const key of ["maximumBytes", "maximumFiles"]) await assert.rejects(() => api.exportRun({ ...fixture.options, [key]: value }));
    }
    await assert.rejects(() => lstat(fixture.options.outputDirectory), { code: "ENOENT" });
  });
});
