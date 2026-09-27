import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { generateSparseV1 } from "../../world/seeds/sparse-v1/generate.ts";
import { captureInto, captureLimits } from "../../src/world/archive.ts";
import { containerViolations, runtimeSettings } from "../../src/world/backend.ts";
import { findMount, parseMountInfoLine } from "../../src/world/mountinfo.ts";
import type { WorldMetadata } from "../../src/world/metadata.ts";
import { FrameDemuxer, FrameError, HeadRetainer, LaunchMarkerFilter, perceiveHead } from "../../src/world/output.ts";
import { parseSensorReading, parseStartupFacts, startupViolations, type StartupFacts } from "../../src/world/probes.ts";
import { parseContainer, runHelper, type HelperResult } from "../../src/world/resources.ts";
import { loadSeed, SEED_MTIME_SECONDS, SEEDS_ROOT, SeedError } from "../../src/world/seeds.ts";
import { ext4Fsid, isClean, parseSuperblock } from "../../src/world/storage.ts";
import { TarFormatError, TarReader, writeTar } from "../../src/world/tar.ts";
import { fixtureConfig } from "../support/config.ts";
import { FakeEngine } from "../support/fake-engine.ts";
import { EXPECTED, goodFacts, MOUNTINFO } from "../support/startup-facts.ts";
import { frame } from "../support/fake-exec.ts";
import { configSchema } from "../../src/config/schema.ts";

describe("output", () => {
  it("demultiplexes frames split at any byte", () => {
    const bytes = Buffer.concat([frame("stdout", "hello "), frame("stderr", "warn"), frame("stdout", "world"), frame("stdout", "")]);
    for (let size = 1; size <= bytes.length; size++) {
      const out = { stdout: "", stderr: "" };
      const demuxer = new FrameDemuxer((stream, payload) => (out[stream] += payload.toString()));
      for (let offset = 0; offset < bytes.length; offset += size) demuxer.push(bytes.subarray(offset, offset + size));
      assert.deepEqual(out, { stdout: "hello world", stderr: "warn" }, `chunk size ${size}`);
      assert.equal(demuxer.midFrame, false);
    }
  });

  it("reports a stream that stops inside a frame and rejects invalid headers", () => {
    const demuxer = new FrameDemuxer(() => {});
    demuxer.push(frame("stdout", "abcdef").subarray(0, 10));
    assert.equal(demuxer.midFrame, true);
    const bad = new FrameDemuxer(() => {});
    assert.throws(() => bad.push(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0])), FrameError);
    assert.throws(() => bad.push(frame("stdout", "x")), FrameError);
  });

  it("retains only the head and counts everything", () => {
    const head = new HeadRetainer(4);
    head.add(Buffer.from("ab"));
    head.add(Buffer.from("cdef"));
    head.add(Buffer.from("gh"));
    const snapshot = head.snapshot();
    assert.equal(Buffer.from(snapshot.retained).toString(), "abcd");
    assert.equal(snapshot.totalBytes, 8);
    assert.equal(snapshot.truncated, true);
    assert.deepEqual(perceiveHead(snapshot, 4), { text: "ab", shownBytes: 2, truncated: true });
    assert.deepEqual(perceiveHead(new HeadRetainer(4).snapshot(), 4), { text: "", shownBytes: 0, truncated: false });
  });

  it("strips the launcher line even when it arrives in pieces", () => {
    const forwarded: string[] = [];
    const filter = new LaunchMarkerFilter((bytes) => forwarded.push(bytes.toString()));
    for (const piece of ["alife-", "job 4", "2 98765\nfirst", " line"]) filter.push(Buffer.from(piece));
    assert.deepEqual(filter.identity, { pid: 42, startTime: "98765" });
    assert.equal(forwarded.join(""), "first line");
  });

  it("passes anything that is not the launcher line through unchanged", () => {
    for (const text of ["error: nope\n", "alife-job 0 1\n", "alife-job 12 x\nmore", `${"a".repeat(80)}\n`, "no newline"]) {
      const forwarded: string[] = [];
      const filter = new LaunchMarkerFilter((bytes) => forwarded.push(bytes.toString()));
      filter.push(Buffer.from(text));
      filter.flush();
      assert.equal(filter.identity, null, text);
      assert.equal(forwarded.join(""), text);
    }
  });
});

describe("tar", () => {
  const files = [
    { path: "materials", type: "directory" as const, mode: 0o755 },
    { path: "materials/a.txt", type: "file" as const, mode: 0o644, content: Buffer.from("alpha\n") },
    { path: "materials/empty", type: "file" as const, mode: 0o600, content: Buffer.alloc(0) },
    { path: "materials/big.bin", type: "file" as const, mode: 0o644, content: Buffer.alloc(1300, 7) },
  ];

  it("writes deterministic archives that the reader indexes exactly", () => {
    const archive = writeTar(files, SEED_MTIME_SECONDS);
    assert.deepEqual(archive, writeTar(files, SEED_MTIME_SECONDS));
    assert.equal(archive.length % 512, 0);
    for (const size of [1, 7, 512, 100_000]) {
      const reader = new TarReader({ maximumEntries: 10, maximumNameBytes: 4096 });
      for (let offset = 0; offset < archive.length; offset += size) reader.push(archive.subarray(offset, offset + size));
      reader.end();
      assert.deepEqual(
        reader.entries.map((entry) => [entry.path.toString(), entry.type, entry.mode.toString(8), entry.size, entry.mtime]),
        [
          ["materials/", "directory", "755", 0, SEED_MTIME_SECONDS],
          ["materials/a.txt", "file", "644", 6, SEED_MTIME_SECONDS],
          ["materials/empty", "file", "600", 0, SEED_MTIME_SECONDS],
          ["materials/big.bin", "file", "644", 1300, SEED_MTIME_SECONDS],
        ],
      );
      assert.equal(reader.entries[1]!.sha256, createHash("sha256").update("alpha\n").digest("hex"));
      assert.equal(reader.entries[0]!.sha256, null);
    }
  });

  it("refuses unsafe paths when writing", () => {
    for (const bad of ["/abs", "../up", "a/../b", "a//b", "", "a/./b"]) {
      assert.throws(() => writeTar([{ path: bad, type: "file", mode: 0o644 }], 0), RangeError, bad);
    }
  });

  function header(name: string | Buffer, flag: string, size: number, link = ""): Buffer {
    const block = Buffer.alloc(512);
    Buffer.from(name).copy(block, 0, 0, 100);
    block.write("0000644\0", 100, "latin1");
    block.write("0000000\0", 108, "latin1");
    block.write("0000000\0", 116, "latin1");
    block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    block.write("00000000000\0", 136, "latin1");
    block.fill(0x20, 148, 156);
    block.write(flag, 156, "latin1");
    block.write(link, 157, "latin1");
    block.write("ustar  \0", 257, "latin1");
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    return block;
  }
  const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  const end = Buffer.alloc(1024);

  it("reads GNU long names, links, and raw name bytes without interpreting them", () => {
    const longName = Buffer.concat([Buffer.from("./"), Buffer.alloc(200, 0x61), Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xff])]);
    const archive = Buffer.concat([
      header("././@LongLink", "L", longName.length + 1),
      pad(Buffer.concat([longName, Buffer.from([0])])),
      header("truncated", "0", 3),
      pad(Buffer.from("abc")),
      header("./abs-link", "2", 0, "/etc/passwd"),
      header("./fifo", "6", 0),
      end,
    ]);
    const reader = new TarReader({ maximumEntries: 10, maximumNameBytes: 4096 });
    reader.push(archive);
    reader.end();
    assert.deepEqual(reader.entries[0]!.path, longName);
    assert.equal(reader.entries[0]!.size, 3);
    assert.equal(reader.entries[1]!.type, "symlink");
    assert.equal(reader.entries[1]!.linkTarget?.toString(), "/etc/passwd");
    assert.equal(reader.entries[1]!.sha256, null);
    assert.equal(reader.entries[2]!.type, "fifo");
  });

  function withMtime(name: string, mtime: Buffer): Buffer {
    const block = header(name, "0", 0);
    mtime.copy(block, 136);
    block.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    return block;
  }
  const base256 = (value: bigint): Buffer => {
    const field = Buffer.alloc(12);
    let twos = BigInt.asUintN(95, value);
    for (let index = 11; index >= 0; index--) {
      field[index] = Number(twos & 0xffn);
      twos >>= 8n;
    }
    field[0] = field[0]! | 0x80;
    return field;
  };

  it("reads negative, zero, and positive modification times and keeps indexing", () => {
    const archive = Buffer.concat([
      withMtime("./old", base256(-1n)),
      withMtime("./older", base256(-86_400n * 365n * 100n)),
      withMtime("./epoch", Buffer.from("00000000000\0", "latin1")),
      withMtime("./later", base256(4_102_444_800n)),
      header("./after", "0", 0),
      end,
    ]);
    const reader = new TarReader({ maximumEntries: 10, maximumNameBytes: 4096 });
    reader.push(archive);
    reader.end();
    assert.deepEqual(
      reader.entries.map((entry) => [entry.path.toString(), entry.mtime]),
      [
        ["./old", -1],
        ["./older", -3_153_600_000],
        ["./epoch", 0],
        ["./later", 4_102_444_800],
        ["./after", 0],
      ],
    );
  });

  it("still rejects negative sizes and out-of-range numbers", () => {
    const negativeSize = header("./x", "0", 0);
    base256(-1n).copy(negativeSize, 124);
    negativeSize.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of negativeSize) sum += byte;
    negativeSize.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    assert.throws(() => new TarReader({ maximumEntries: 10, maximumNameBytes: 4096 }).push(negativeSize), /negative size/);
    assert.throws(
      () => new TarReader({ maximumEntries: 10, maximumNameBytes: 4096 }).push(withMtime("./x", base256(-(2n ** 60n)))),
      /mtime out of range/,
    );
  });

  it("rejects corrupt, truncated, oversized, or overlong archives", () => {
    const good = writeTar(files, 0);
    const corrupt = Buffer.from(good);
    corrupt[0] = 0x7a;
    assert.throws(() => new TarReader({ maximumEntries: 10, maximumNameBytes: 4096 }).push(corrupt), /checksum/);

    const truncated = new TarReader({ maximumEntries: 10, maximumNameBytes: 4096 });
    truncated.push(good.subarray(0, 1100));
    assert.throws(() => truncated.end(), TarFormatError);

    assert.throws(() => new TarReader({ maximumEntries: 2, maximumNameBytes: 4096 }).push(good), /more than 2 entries/);
    assert.throws(() => new TarReader({ maximumEntries: 10, maximumNameBytes: 8 }).push(good), /exceeds 8/);

    const trailing = new TarReader({ maximumEntries: 10, maximumNameBytes: 4096 });
    assert.throws(() => trailing.push(Buffer.concat([good, writeTar(files, 0)])), /after the end-of-archive marker/);
  });
});

describe("seeds", () => {
  it("loads the empty seed with no entries", async () => {
    const seed = await loadSeed("empty-v1");
    assert.deepEqual(seed.entries, []);
    assert.equal(seed.bytes, 0);
    assert.equal(seed.archive.length, 1024);
    assert.match(seed.sha256, /^[a-f0-9]{64}$/);
  });

  it("loads the sparse seed exactly as its generator produces it", async () => {
    const seed = await loadSeed("sparse-v1");
    assert.equal(seed.status, "draft");
    const generated = generateSparseV1();
    const files = seed.entries.filter((entry) => entry.type === "file");
    assert.deepEqual(
      files.map((entry) => entry.path),
      [...generated.keys()],
    );
    for (const [relative, content] of generated) {
      assert.deepEqual(await readFile(path.join(SEEDS_ROOT, "sparse-v1", "files", relative)), content, relative);
    }
    const reader = new TarReader({ maximumEntries: 10, maximumNameBytes: 4096 });
    reader.push(seed.archive);
    reader.end();
    assert.deepEqual(
      reader.entries.map((entry) => [entry.path.toString(), entry.uid, entry.gid]),
      [
        ["materials/", 0, 0],
        ["materials/fragments.txt", 0, 0],
        ["materials/measurements.csv", 0, 0],
      ],
    );
    // No instructions or task framing in the materials.
    const text = [...generated.values()].map((content) => content.toString()).join("\n").toLowerCase();
    for (const word of ["task", "todo", "you should", "your goal", "instruction", "please"]) assert.ok(!text.includes(word), word);
  });

  async function copySeeds(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "alife-seeds-"));
    await cp(SEEDS_ROOT, root, { recursive: true });
    return root;
  }

  it("rejects seeds whose files differ from their manifest", async () => {
    let root = await copySeeds();
    await writeFile(path.join(root, "sparse-v1", "files", "materials", "extra.txt"), "x");
    await assert.rejects(loadSeed("sparse-v1", root), /not in seed\.json/);

    root = await copySeeds();
    await writeFile(path.join(root, "sparse-v1", "files", "materials", "fragments.txt"), "changed");
    await assert.rejects(loadSeed("sparse-v1", root), /does not match/);

    root = await copySeeds();
    await rm(path.join(root, "sparse-v1", "files", "materials", "measurements.csv"));
    await symlink("/etc/passwd", path.join(root, "sparse-v1", "files", "materials", "measurements.csv"));
    await assert.rejects(loadSeed("sparse-v1", root), SeedError);

    root = await copySeeds();
    await rm(path.join(root, "sparse-v1", "files", "materials", "measurements.csv"));
    await assert.rejects(loadSeed("sparse-v1", root), /missing on disk/);

    await assert.rejects(loadSeed("unknown-v9"), /unknown seed/);
  });
});

const DUMPE2FS = `Filesystem volume name:   alife-3f9a1c2b
Last mounted on:          <not available>
Filesystem UUID:          12345678-1234-4234-8234-123456789abc
Filesystem magic number:  0xEF53
Filesystem features:      has_journal ext_attr resize_inode dir_index orphan_file filetype extent 64bit flex_bg sparse_super large_file huge_file dir_nlink extra_isize metadata_csum
Filesystem state:         clean
Inode count:              256
Block count:              4096
Reserved block count:     0
Free blocks:              3011
Free inodes:              242
Block size:               4096
Mount count:              0
Last write time:          Fri Sep 25 21:14:19 2026
`;

describe("storage", () => {
  it("parses superblocks and requires every field", () => {
    const superblock = parseSuperblock(DUMPE2FS);
    assert.equal(superblock.uuid, "12345678-1234-4234-8234-123456789abc");
    assert.equal(superblock.label, "alife-3f9a1c2b");
    assert.equal(superblock.blockCount, 4096);
    assert.equal(superblock.freeInodes, 242);
    assert.ok(isClean(superblock));
    assert.ok(!isClean({ ...superblock, state: "not clean" }));
    assert.ok(!isClean({ ...superblock, features: [...superblock.features, "needs_recovery"] }));
    assert.throws(() => parseSuperblock(DUMPE2FS.replace(/^Free blocks.*$/m, "")), /Free blocks/);
    assert.throws(() => parseSuperblock(DUMPE2FS.replace("Free blocks:              3011", "Free blocks:              lots")), /not a count/);
  });

  it("derives the statfs filesystem ID ext4 reports for a UUID", () => {
    // Observed with os.statvfs on OrbStack for this UUID.
    assert.equal(ext4Fsid("12345678-1234-4234-8234-123456789abc"), "88d84c444c440090");
    assert.throws(() => ext4Fsid("not-a-uuid"), RangeError);
  });
});



describe("mountinfo", () => {
  it("parses mounts with and without optional fields, unescaping paths", () => {
    assert.deepEqual(parseMountInfoLine(MOUNTINFO.split("\n")[1]!), {
      mountPoint: "/world",
      options: ["rw", "nosuid", "nodev", "noatime"],
      fsType: "ext4",
      source: "/dev/loop0",
      superOptions: ["rw"],
    });
    assert.equal(findMount(MOUNTINFO, "/with space")?.fsType, "tmpfs");
    assert.equal(findMount(MOUNTINFO, "/missing"), null);
    assert.equal(parseMountInfoLine("garbage"), null);
  });
});



describe("startup verification", () => {
  it("accepts a world matching its profile", () => {
    assert.deepEqual(startupViolations(parseStartupFacts(JSON.stringify(goodFacts())), EXPECTED), []);
  });

  it("names every deviation", () => {
    const cases: [Partial<StartupFacts>, RegExp][] = [
      [{ uid: 0, euid: 0 }, /runs as 0/],
      [{ groups: [1000, 27] }, /supplementary/],
      [{ caps: ["0000000000000000", "0000000000000000", "00000000a80425fb", "0", "0"] }, /capabilities/],
      [{ noNewPrivs: "0" }, /no-new-privileges/],
      [{ seccomp: "0" }, /seccomp/],
      [{ limits: [["Max open files", ["256", "256"]], ["Max msgqueue size", ["819200", "819200"]]] }, /message queue limit/],
      [{ mqueue: { created: true, errno: 0 } }, /could be created/],
      [{ mqueueEntries: 1 }, /queues exist/],
      [{ mountinfo: MOUNTINFO.replace("/ / ro,", "/ / rw,") }, /root filesystem/],
      [{ mountinfo: MOUNTINFO.replace("/dev/loop0", "/dev/loop9") }, /not ext4 from \/dev\/loop0/],
      [{ mountinfo: MOUNTINFO.replace("rw,nosuid,nodev,noatime", "rw,nodev,noatime") }, /\/world mount options/],
      [{ mountinfo: MOUNTINFO.replace("size=16384k", "size=65536k") }, /\/tmp/],
      [{ worldFsid: "1" }, /filesystem ID/],
      [{ worldOwner: [0, 0] }, /owned by 0:0/],
      [{ net: ["eth0", "lo"] }, /network interfaces/],
      [{ sockets: ["/var/run/docker.sock"] }, /control sockets/],
      [{ pid1: "sleep" }, /PID 1/],
      [{ env: ["HOME", "HOSTNAME", "OPENAI_API_KEY", "PATH"] }, /environment/],
      [{ cgroup: ["max", "0", "50000 100000", "64"] }, /memory\.max/],
      [{ cgroup: [String(256 << 20), "max", "50000 100000", "64"] }, /memory\.swap\.max/],
      [{ cgroup: [String(256 << 20), "0", "max 100000", "64"] }, /cpu\.max/],
      [{ cgroup: [String(256 << 20), "0", "50000 100000", "max"] }, /pids\.max/],
    ];
    for (const [change, pattern] of cases) {
      const problems = startupViolations({ ...goodFacts(), ...change }, EXPECTED);
      assert.ok(problems.some((problem) => pattern.test(problem)), `${JSON.stringify(change)} -> ${JSON.stringify(problems)}`);
    }
  });

  it("rejects readings with unexpected fields", () => {
    assert.throws(() => parseStartupFacts(JSON.stringify({ ...goodFacts(), extra: 1 })));
  });
});

describe("sensor readings", () => {
  it("converts statvfs and listings, keeping raw names", () => {
    const hostile = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xff]);
    const reading = parseSensorReading(
      JSON.stringify({
        storage: [4096, 100, 40, 256, 200],
        storageError: null,
        listing: {
          entries: [
            [Buffer.from("materials").toString("base64"), "directory", null],
            [hostile.toString("base64"), "file", 3],
          ],
          truncated: true,
        },
        listingError: null,
      }),
      true,
    );
    assert.deepEqual(reading.storage, {
      available: true,
      value: { totalBytes: 409_600, availableBytes: 163_840, totalInodes: 256, availableInodes: 200 },
    });
    assert.ok(reading.listing?.available);
    assert.equal(reading.listing.value.truncated, true);
    assert.equal(reading.listing.value.entries[0]!.name, "materials");
    assert.equal(reading.listing.value.entries[1]!.name, null);
    assert.deepEqual(Buffer.from(reading.listing.value.entries[1]!.nameBase64, "base64"), hostile);
  });

  it("reports failed readings as unavailable", () => {
    const reading = parseSensorReading(JSON.stringify({ storage: null, storageError: "EIO", listing: null, listingError: "EACCES" }), true);
    assert.deepEqual(reading.storage, { available: false, reason: "statvfs failed: EIO" });
    assert.deepEqual(reading.listing, { available: false, reason: "listing failed: EACCES" });
    assert.equal(parseSensorReading(JSON.stringify({ storage: null, storageError: "EIO", listing: null, listingError: null }), false).listing, null);
  });
});

function helperResult(overrides: Partial<HelperResult> = {}): HelperResult {
  return {
    containerId: "c".repeat(64),
    name: "helper",
    exitCode: 0,
    stdout: Buffer.alloc(0),
    stdoutBytes: 0,
    stderr: Buffer.alloc(0),
    stderrBytes: 0,
    timedOut: false,
    stopped: false,
    streamProblem: null,
    ...overrides,
  };
}

describe("capture indexing", () => {
  const archive = writeTar(
    [
      { path: "notes", type: "directory", mode: 0o700 },
      { path: "notes/a.txt", type: "file", mode: 0o644, content: Buffer.from("hello") },
    ],
    0,
  );

  it("writes and indexes a complete archive", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alife-capture-"));
    const outcome = await captureInto(directory, captureLimits(16, 64), (sink) => {
      for (let offset = 0; offset < archive.length; offset += 700) sink(archive.subarray(offset, offset + 700));
      return Promise.resolve(helperResult());
    });
    assert.equal(outcome.complete, true);
    assert.deepEqual(outcome.omissions, []);
    assert.deepEqual(await readFile(outcome.file), archive);
    assert.deepEqual(
      outcome.entries.map((entry) => [entry.path, entry.type, entry.mode]),
      [
        ["notes", "directory", "0700"],
        ["notes/a.txt", "file", "0644"],
      ],
    );
    assert.equal(outcome.entries[1]!.sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("keeps a leading byte-order mark in decoded file names", async () => {
    const bom = writeTar(
      [
        { path: "\uFEFFname", type: "file", mode: 0o644, content: Buffer.from("a") },
        { path: "name", type: "file", mode: 0o644, content: Buffer.from("b") },
      ],
      0,
    );
    const outcome = await captureInto(await mkdtemp(path.join(tmpdir(), "alife-capture-")), captureLimits(16, 64), (sink) => {
      sink(bom);
      return Promise.resolve(helperResult());
    });
    assert.deepEqual(
      outcome.entries.map((entry) => [entry.path, entry.pathBase64]),
      [
        ["\uFEFFname", "77u/bmFtZQ=="],
        ["name", "bmFtZQ=="],
      ],
    );
    // Sensor listings decode names the same way.
    const reading = parseSensorReading(
      JSON.stringify({ storage: null, storageError: "x", listing: { entries: [["77u/bmFtZQ==", "file", 1]], truncated: false }, listingError: null }),
      true,
    );
    assert.ok(reading.listing?.available);
    assert.equal(reading.listing.value.entries[0]!.name, "\uFEFFname");
  });

  it("cuts off at the byte bound and labels the archive incomplete", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alife-capture-"));
    const limits = { maximumBytes: 1000, maximumEntries: 10, timeoutMs: 1000 };
    let accepted = true;
    const outcome = await captureInto(directory, limits, (sink) => {
      accepted = sink(archive);
      return Promise.resolve(helperResult({ stopped: true, exitCode: 137 }));
    });
    assert.equal(accepted, false);
    assert.equal(outcome.complete, false);
    assert.equal(outcome.bytes, 1000);
    assert.equal((await readFile(outcome.file)).length, 1000);
    assert.ok(outcome.omissions.some((omission) => /1000-byte bound/.test(omission)));
  });

  it("keeps what arrived when the helper fails or the archive is malformed", async () => {
    const failed = await captureInto(await mkdtemp(path.join(tmpdir(), "alife-capture-")), captureLimits(16, 64), (sink) => {
      sink(archive.subarray(0, 512));
      return Promise.reject(new Error("engine unavailable"));
    });
    assert.equal(failed.complete, false);
    assert.ok(failed.omissions.some((omission) => /engine unavailable/.test(omission)));

    const garbage = await captureInto(await mkdtemp(path.join(tmpdir(), "alife-capture-")), captureLimits(16, 64), (sink) => {
      sink(Buffer.alloc(512, 0x41));
      return Promise.resolve(helperResult({ stderr: Buffer.from("tar: ./sock: socket ignored\n") }));
    });
    assert.equal(garbage.complete, false);
    assert.ok(garbage.omissions.includes("tar: tar: ./sock: socket ignored"));
    assert.ok(garbage.omissions.some((omission) => /index incomplete/.test(omission)));
  });
});

describe("capture stream completion", () => {
  const tarBytes = writeTar([{ path: "a.txt", type: "file", mode: 0o644, content: Buffer.from("alpha") }], 0);

  async function capture(engine: FakeEngine) {
    const directory = await mkdtemp(path.join(tmpdir(), "alife-capture-"));
    return captureInto(directory, captureLimits(16, 64), (sink, timeoutMs) =>
      runHelper(engine, {
        worldId: "w-20260925T161449Z-abababab" as never,
        purpose: "capture",
        image: "sha256:" + "0".repeat(64),
        privileged: false,
        capAdd: ["DAC_READ_SEARCH"],
        user: "0:0",
        mounts: [],
        cmd: ["tar"],
        stdoutSink: sink,
        stdoutLimit: 0,
        stderrLimit: 4096,
        timeoutMs,
        memoryBytes: 1 << 20,
        pids: 4,
        drainAfterExitMs: 30,
      }),
    );
  }

  it("is complete when the stream ends normally at a frame boundary", async () => {
    const engine = new FakeEngine();
    engine.onStart = (stream) => {
      stream.emit(frame("stdout", tarBytes));
      stream.finish("eof");
    };
    const outcome = await capture(engine);
    assert.equal(outcome.complete, true, outcome.omissions.join("; "));
    assert.deepEqual(outcome.omissions, []);
    assert.ok([...engine.containers.values()].every((container) => container.removed));
  });

  it("is incomplete when the stream never ends, even with a whole archive and exit 0", async () => {
    const engine = new FakeEngine();
    engine.onStart = (stream) => stream.emit(frame("stdout", tarBytes));
    const outcome = await capture(engine);
    assert.equal(outcome.complete, false);
    assert.ok(outcome.omissions.some((omission) => /did not end within 30 ms/.test(omission)), outcome.omissions.join("; "));
    assert.equal(outcome.entries.length, 1);
  });

  it("is incomplete when the stream closes without end-of-file, even at a frame boundary", async () => {
    const engine = new FakeEngine();
    engine.onStart = (stream) => {
      stream.emit(frame("stdout", tarBytes));
      stream.finish("closed");
    };
    const outcome = await capture(engine);
    assert.equal(outcome.complete, false);
    assert.ok(outcome.omissions.some((omission) => /closed without end-of-file/.test(omission)), outcome.omissions.join("; "));
    assert.equal(outcome.entries.length, 1, "what arrived is still indexed");
  });

  it("is incomplete when the stream fails", async () => {
    const engine = new FakeEngine();
    engine.onStart = (stream) => {
      stream.emit(frame("stdout", tarBytes));
      stream.finish("error", new Error("connection reset"));
    };
    const outcome = await capture(engine);
    assert.equal(outcome.complete, false);
    assert.ok(outcome.omissions.some((omission) => /connection reset/.test(omission)), outcome.omissions.join("; "));
  });

  it("keeps stderr that arrives after the helper exits", async () => {
    const engine = new FakeEngine();
    engine.onStart = (stream) => {
      stream.emit(frame("stdout", tarBytes));
      setTimeout(() => {
        stream.emit(frame("stderr", "tar: ./sock: socket ignored\n"));
        stream.finish("eof");
      }, 5);
    };
    const outcome = await capture(engine);
    assert.ok(outcome.omissions.includes("tar: tar: ./sock: socket ignored"), outcome.omissions.join("; "));
    assert.equal(outcome.complete, true);
  });
});

describe("container verification", () => {
  const metadata = {
    images: { world: `sha256:${"a".repeat(64)}` },
    resources: { deviceVolume: "alife-w-x-world" },
  } as unknown as WorldMetadata;

  async function settings() {
    const config = configSchema.parse(await fixtureConfig());
    return runtimeSettings(config);
  }

  function inspected(overrides: { host?: Record<string, unknown>; config?: Record<string, unknown>; mounts?: unknown[] } = {}) {
    return parseContainer({
      Id: "b".repeat(64),
      Name: "/alife-w-x",
      Image: `sha256:${"a".repeat(64)}`,
      State: { Running: false, Status: "created", ExitCode: 0, OOMKilled: false, StartedAt: "", FinishedAt: "" },
      Config: { Labels: {}, User: "1000:1000", Env: ["HOME=/world", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"], ...overrides.config },
      Mounts: overrides.mounts ?? [{ Type: "volume", Name: "alife-w-x-world", Destination: "/world", RW: true }],
      HostConfig: {
        Privileged: false,
        CapDrop: ["ALL"],
        CapAdd: null,
        SecurityOpt: ["no-new-privileges"],
        ReadonlyRootfs: true,
        NetworkMode: "none",
        IpcMode: "private",
        PidMode: "",
        UsernsMode: "",
        Binds: null,
        Devices: [],
        PublishAllPorts: false,
        PortBindings: {},
        Memory: 256 << 20,
        MemorySwap: 256 << 20,
        NanoCpus: 500_000_000,
        PidsLimit: 64,
        ShmSize: 8 << 20,
        Ulimits: [
          { Name: "nofile", Soft: 256, Hard: 256 },
          { Name: "msgqueue", Soft: 0, Hard: 0 },
        ],
        LogConfig: { Type: "none", Config: {} },
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        AutoRemove: false,
        Tmpfs: { "/tmp": "rw,nosuid,nodev,size=16m,mode=1777" },
        ...overrides.host,
      },
    });
  }

  it("accepts the declared profile", async () => {
    assert.deepEqual(containerViolations(inspected(), metadata, await settings()), []);
  });

  it("names every weakened setting", async () => {
    const s = await settings();
    const cases: [Parameters<typeof inspected>[0], RegExp][] = [
      [{ host: { Privileged: true } }, /privileged/],
      [{ host: { CapAdd: ["SYS_ADMIN"] } }, /capabilities are added/],
      [{ host: { SecurityOpt: ["no-new-privileges", "seccomp=unconfined"] } }, /change confinement/],
      [{ host: { SecurityOpt: ["no-new-privileges", "seccomp={\"defaultAction\":\"SCMP_ACT_ALLOW\"}"] } }, /change confinement/],
      [{ host: { ReadonlyRootfs: false } }, /writable/],
      [{ host: { NetworkMode: "bridge" } }, /network/],
      [{ host: { IpcMode: "shareable" } }, /IPC/],
      [{ host: { PidMode: "host" } }, /PID mode/],
      [{ host: { Binds: ["/Users:/host"] } }, /host paths/],
      [{ host: { Memory: 0 } }, /memory limit/],
      [{ host: { PidsLimit: -1 } }, /PID limit/],
      [{ host: { Ulimits: [{ Name: "nofile", Soft: 256, Hard: 256 }] } }, /message queue/],
      [{ host: { LogConfig: { Type: "json-file", Config: {} } } }, /log driver/],
      [{ host: { RestartPolicy: { Name: "always" } } }, /restart/],
      [{ host: { Tmpfs: { "/tmp": "rw,size=1g", "/run": "rw" } } }, /temporary mounts/],
      [{ mounts: [] }, /mounts/],
      [{ config: { Env: ["HOME=/world", "PATH=/bin", "ALIFE_OPENAI_API_KEY=secret"] } }, /environment/],
      [{ config: { User: "0:0" } }, /user/],
    ];
    for (const [overrides, pattern] of cases) {
      const problems = containerViolations(inspected(overrides), metadata, s);
      assert.ok(problems.some((problem) => pattern.test(problem)), `${JSON.stringify(overrides)} -> ${JSON.stringify(problems)}`);
    }
  });
});
