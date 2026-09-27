// Phase 2 gate on a real Docker engine (plan §15, handoff step 7). Opt-in and
// explicit: it creates disposable, labelled worlds, runs the explicitly
// authorized privileged storage helper, and removes exactly what it created.
// It never restarts the engine or touches unrelated containers or volumes.
//
//   ALIFE_TEST_DOCKER_CONTEXT=orbstack \
//   ALIFE_TEST_ALLOW_PRIVILEGED_HELPER=1 \
//   ALIFE_TEST_WORLD_IMAGE=sha256:… ALIFE_TEST_HELPER_IMAGE=sha256:… \
//   npm run test:integration

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { loadConfig, type ResolvedConfig } from "../../src/config/resolve.ts";
import { systemClock } from "../../src/core/clock.ts";
import type { DispatchHooks, DispatchIdentity, JobSnapshot } from "../../src/core/contracts.ts";
import { newWorldId, type WorldId } from "../../src/core/ids.ts";
import { acquireOwnership, type Ownership } from "../../src/operator/locks.ts";
import { prepareStateDir, type StateLayout } from "../../src/operator/state-dir.ts";
import { readEventLog } from "../../src/records/events.ts";
import {
  CaptureRefusedError,
  createWorld,
  openWorld,
  openWorldForDestruction,
  runtimeSettings,
  type DockerWorld,
  type WorldAccess,
} from "../../src/world/backend.ts";
import { DockerEngine, resolveDockerContext } from "../../src/world/engine.ts";
import { DispatchRefusedError, JobAdmissionError } from "../../src/world/jobs.ts";
import { createVolume, inspectVolume, removeVolume, resourceNames, runHelper, WORLD_LABEL } from "../../src/world/resources.ts";
import { PrivilegeRequiredError } from "../../src/world/storage.ts";

const CONTEXT = process.env.ALIFE_TEST_DOCKER_CONTEXT;
const WORLD_IMAGE = process.env.ALIFE_TEST_WORLD_IMAGE;
const HELPER_IMAGE = process.env.ALIFE_TEST_HELPER_IMAGE;
if (!CONTEXT || !WORLD_IMAGE || !HELPER_IMAGE || process.env.ALIFE_TEST_ALLOW_PRIVILEGED_HELPER !== "1") {
  throw new Error(
    "integration tests need ALIFE_TEST_DOCKER_CONTEXT, ALIFE_TEST_WORLD_IMAGE, ALIFE_TEST_HELPER_IMAGE, and " +
      "ALIFE_TEST_ALLOW_PRIVILEGED_HELPER=1 (explicit authorization for the privileged storage helper)",
  );
}

const RUNTIME = path.resolve(import.meta.dirname, "../..");
/** Must never reach the world, a helper, or a record. */
const CONTROLLER_SECRET_NAME = "ALIFE_TEST_CONTROLLER_SECRET";
process.env[CONTROLLER_SECRET_NAME] = "controller-secret-f00d";

let root: string;
let layout: StateLayout;
let engine: DockerEngine;
const locks: Ownership[] = [];
const created: WorldId[] = [];
let sequence = 0;

async function configFor(seed: string): Promise<ResolvedConfig> {
  const config = JSON.parse(await readFile(path.join(RUNTIME, "test/fixtures/fake.config.json"), "utf8")) as Record<string, Record<string, unknown>>;
  const world = config.world!;
  world.image = WORLD_IMAGE;
  world.storage = { ...(world.storage as object), helperImage: HELPER_IMAGE, capacityMiB: 32, inodes: 1024 };
  Object.assign(world, { seed, memoryMiB: 128, pids: 64, fileDescriptors: 128, tmpMiB: 8, shmMiB: 4 });
  Object.assign(config.body!, { actionWaitMs: 500, maximumConcurrentJobs: 2, retainedFinishedJobs: 8, capturedOutputBytes: 8192, perceivedOutputBytes: 4096, prompt: "prompt.txt" });
  const directory = await mkdtemp(path.join(root, "config-"));
  await copyFile(path.join(RUNTIME, "prompts/baseline.txt"), path.join(directory, "prompt.txt"));
  await copyFile(path.join(RUNTIME, "test/fixtures/fake-script.json"), path.join(directory, "fake-script.json"));
  await writeFile(path.join(directory, "config.json"), JSON.stringify(config));
  const result = await loadConfig(path.join(directory, "config.json"));
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.resolved;
}

async function access(worldId: WorldId, allowPrivilegedHelper: boolean): Promise<WorldAccess> {
  let lock = locks.find((owned) => owned.record.id === worldId);
  if (lock === undefined) {
    lock = await acquireOwnership(layout.locks, "world", worldId, systemClock);
    locks.push(lock);
  }
  return { layout, worldId, ownership: lock, clock: systemClock, allowPrivilegedHelper };
}

async function newWorld(seed: string): Promise<{ worldId: WorldId; resolved: ResolvedConfig }> {
  const resolved = await configFor(seed);
  const worldId = newWorldId(new Date());
  created.push(worldId);
  const world = await createWorld(await access(worldId, true), { dockerContext: CONTEXT!, resolved, minimumHostFreeMiB: 64 });
  await world.close();
  return { worldId, resolved };
}

const recorded: DispatchIdentity[] = [];
const hooks: DispatchHooks = {
  prepared: (identity) => {
    recorded.push(identity);
    return Promise.resolve();
  },
};

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

async function submit(world: DockerWorld, command: string): Promise<JobSnapshot> {
  sequence += 1;
  return world.submit({ actionId: `job-${sequence}`, command }, hooks);
}

/**
 * Polls the same job until its root has exited and its output is final. Never resubmits.
 * The test has then seen the job finished, as an observation would report it, so it
 * acknowledges it and the job releases its admission slot.
 */
async function settle(world: DockerWorld, jobId: string, timeoutMs = 60_000): Promise<JobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await world.inspectJob(jobId);
    if (job.state !== "running" && job.state !== "unconfirmed" && job.output !== "open") {
      world.acknowledgeJobs([jobId]);
      return job;
    }
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle: ${JSON.stringify({ state: job.state, output: job.output })}`);
    await delay(100);
  }
}

async function run(world: DockerWorld, command: string, timeoutMs?: number): Promise<{ exitCode: number | null; stdout: string; stderr: string; job: JobSnapshot }> {
  const job = await settle(world, (await submit(world, command)).jobId, timeoutMs);
  return { exitCode: job.exitCode, stdout: text(job.stdout.retained), stderr: text(job.stderr.retained), job };
}

async function labelled(kind: "containers" | "volumes", worldId: WorldId): Promise<string[]> {
  const filters = JSON.stringify({ label: [`${WORLD_LABEL}=${worldId}`] });
  if (kind === "containers") {
    const list = (await engine.get("/containers/json", { query: { all: "true", filters } })) as { Id: string }[];
    return list.map((item) => item.Id);
  }
  const reply = (await engine.get("/volumes", { query: { filters } })) as { Volumes: { Name: string }[] | null };
  return (reply.Volumes ?? []).map((volume) => volume.Name);
}

describe("Docker world (Phase 2 gate)", { timeout: 600_000 }, () => {
  let main: { worldId: WorldId; resolved: ResolvedConfig };
  let world: DockerWorld;

  /** Closes the current handle (never stopping the world) and opens the main world again. */
  async function reopen(allowPrivilegedHelper: boolean): Promise<DockerWorld> {
    await world.close().catch(() => undefined);
    world = await openWorld(await access(main.worldId, allowPrivilegedHelper), runtimeSettings(main.resolved.config));
    return world;
  }

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "alife-integration-"));
    layout = await prepareStateDir(path.join(root, "state"));
    engine = new DockerEngine(await resolveDockerContext(CONTEXT));
    main = await newWorld("sparse-v1");
    world = await openWorld(await access(main.worldId, true), runtimeSettings(main.resolved.config));
    await world.start();
  });

  after(async () => {
    await world?.close().catch(() => undefined);
    const failures: string[] = [];
    for (const worldId of created) {
      try {
        const doomed = await openWorldForDestruction(await access(worldId, true));
        await doomed.stop("operator_stop");
        const result = await doomed.destroy();
        await doomed.close();
        if (!result.verified) failures.push(`${worldId}: ${result.detail}`);
        const leftovers = [...(await labelled("containers", worldId)), ...(await labelled("volumes", worldId))];
        if (leftovers.length > 0) failures.push(`${worldId} left ${leftovers.join(", ")}`);
      } catch (error) {
        failures.push(`${worldId}: ${(error as Error).message}`);
      }
    }
    for (const lock of locks) await lock.release();
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(failures, [], "every test world must be destroyed exactly");
  });

  it("verifies the effective profile before any action and senses bounded storage", async () => {
    const log = await readEventLog(world.paths.events);
    assert.deepEqual(log.issues, []);
    const types = log.events.map((event) => event.type);
    assert.ok(types.indexOf("world.verified") > types.indexOf("world.started"));
    assert.ok(!types.includes("job.prepared"), "no job before verification");
    const verified = log.events.find((event) => event.type === "world.verified")!.data;
    assert.equal(verified.pid1, "/usr/bin/tini");
    assert.equal(verified.seccomp, "2");

    const sample = await world.sample({ listing: true });
    assert.ok(sample.storage.available);
    const storage = sample.storage.value;
    assert.ok(storage.totalBytes <= 32 << 20 && storage.totalBytes > 24 << 20, `total ${storage.totalBytes}`);
    assert.equal(storage.totalInodes, 1024);
    assert.ok(sample.memory.available && sample.memory.value.limitBytes === 128 << 20);
    assert.ok(sample.processes.available && sample.processes.value.limit === 64);
    assert.ok(sample.listing?.available);
    assert.deepEqual(
      sample.listing.value.entries.map((entry) => [entry.name, entry.type]),
      [
        ["lost+found", "directory"],
        ["materials", "directory"],
      ],
    );
  });

  it("seeds files owned by the world user that match the seed manifest", async () => {
    const result = await run(world, "sha256sum materials/*; stat -c '%u:%g %a %n' /world /world/materials /world/materials/*");
    assert.equal(result.exitCode, 0, result.stderr);
    const manifest = JSON.parse(await readFile(path.join(RUNTIME, "world/seeds/sparse-v1/seed.json"), "utf8")) as {
      entries: { path: string; sha256?: string }[];
    };
    for (const entry of manifest.entries.filter((item) => item.sha256)) {
      assert.ok(result.stdout.includes(`${entry.sha256}  ${entry.path}`), entry.path);
    }
    assert.match(result.stdout, /^1000:1000 755 \/world$/m);
    assert.match(result.stdout, /^1000:1000 644 \/world\/materials\/measurements.csv$/m);
  });

  it("returns a still-running job at wait expiry and later observes its completion without replay", async () => {
    const script = "p=/world/once; n=$(cat $p 2>/dev/null || echo 0); echo $((n+1)) > $p; echo started; sleep 2; echo finished";
    const first = await submit(world, script);
    assert.equal(first.state, "running");
    assert.equal(first.exitCode, null);
    assert.ok(first.rootPid !== null && first.rootPid > 1);
    const done = await settle(world, first.jobId);
    assert.equal(done.state, "exited");
    assert.equal(done.exitCode, 0);
    assert.equal(done.execId, first.execId);
    assert.match(text(done.stdout.retained), /started\nfinished/);
    assert.equal((await run(world, "cat /world/once")).stdout.trim(), "1");
    assert.equal(recorded.filter((identity) => identity.jobId === first.jobId).length, 1);
  });

  it("admits at most the configured jobs, which share the world's limits; a rejected job creates nothing", async () => {
    const busy = "python3 -c \"import time; x=bytearray(24<<20); end=time.monotonic()+2.5\nwhile time.monotonic()<end: pass\"";
    const before = await world.sample({ listing: false });
    const a = await submit(world, busy);
    const b = await submit(world, busy);
    assert.equal(a.state, "running");
    assert.equal(b.state, "running");
    await delay(800);
    const during = await world.sample({ listing: false });
    assert.ok(before.memory.available && during.memory.available);
    assert.ok(during.memory.value.usageBytes > before.memory.value.usageBytes + (40 << 20), "both allocations count against one limit");
    assert.equal(during.jobs.filter((job) => job.state === "running").length, 2);
    await assert.rejects(submit(world, "touch /world/third-job"), JobAdmissionError);
    for (const job of [a, b]) assert.equal((await settle(world, job.jobId)).exitCode, 0);
    const after = await run(world, "test -e /world/third-job; echo $?; cat /sys/fs/cgroup/cpu.max; grep nr_throttled /sys/fs/cgroup/cpu.stat");
    assert.match(after.stdout, /^1\n50000 100000\nnr_throttled [1-9]/);
  });

  it("drains an output flood while retaining only a bounded head", async () => {
    const result = await run(world, "python3 -c \"import os\nfor i in range(1024): os.write(1, b'x'*4096)\nfor i in range(256): os.write(2, b'y'*4096)\nos.write(1, b'END')\"");
    assert.equal(result.exitCode, 0);
    assert.equal(result.job.stdout.totalBytes, 4 * 1024 * 1024 + 3);
    assert.equal(result.job.stderr.totalBytes, 1024 * 1024);
    assert.equal(result.job.stdout.retained.length, 8192);
    assert.equal(result.job.stderr.retained.length, 8192);
    assert.equal(result.job.output, "complete");
  });

  it("does not treat inherited output after the root exits as job lifetime (negative control)", async () => {
    const writer = "import os,time,pathlib\nfor i in range(250):\n try: os.write(1,b'z'*1024)\n except BrokenPipeError: break\n pathlib.Path('/world/inherited-count').write_text(str(i+1)); time.sleep(.02)";
    const job = await submit(world, `python3 -I -c "${writer}" & echo root-exited`);
    const done = await settle(world, job.jobId, 20_000);
    assert.equal(done.exitCode, 0);
    assert.ok(["complete", "closed_after_exit"].includes(done.output), done.output);
    await delay(6_000);
    const count = Number((await run(world, "cat /world/inherited-count")).stdout.trim());
    assert.ok(done.stdout.totalBytes < 250 * 1024, `collected ${done.stdout.totalBytes} bytes after the root exited`);
    assert.ok(count >= 1);
    // The bracket keeps pkill from matching this job's own command line.
    await run(world, "pkill -f 'inherited-coun[t]'; rm -f /world/inherited-count");
  });

  it("keeps redirected background work running after its shell exits", async () => {
    const started = await run(world, "(for i in 1 2 3 4 5 6 7 8 9 10; do echo $i >> /world/bg.txt; sleep 0.1; done) >/dev/null 2>&1 & echo started");
    assert.equal(started.exitCode, 0);
    await delay(1_800);
    assert.equal((await run(world, "wc -l < /world/bg.txt")).stdout.trim(), "10");
  });

  it("signals a job's process group without claiming descendants that left it", async () => {
    const code = "import subprocess,time\nc=subprocess.Popen(['sleep','300'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nprint(c.pid,flush=True)\ntime.sleep(300)";
    const job = await submit(world, `exec python3 -I -c "${code}"`);
    assert.equal(job.state, "running");
    let escaped = Number.NaN;
    for (let attempt = 0; attempt < 50 && Number.isNaN(escaped); attempt++) {
      escaped = Number.parseInt(text((await world.inspectJob(job.jobId)).stdout.retained), 10);
      if (Number.isNaN(escaped)) await delay(100);
    }
    assert.ok(escaped > 1);
    const result = await world.signalJob(job.jobId, "TERM", "agent");
    assert.equal(result.delivered, true, result.detail);
    const ended = await settle(world, job.jobId);
    assert.equal(ended.exitCode, 143);
    assert.equal((await world.signalJob(job.jobId, "KILL", "agent")).delivered, false);

    // The escaped session survives; the agent can signal it itself, and init reaps it.
    assert.equal((await run(world, `kill -0 ${escaped} && echo alive`)).stdout.trim(), "alive");
    assert.equal((await run(world, `kill -TERM ${escaped}`)).exitCode, 0);
    await delay(300);
    assert.equal((await run(world, `test -e /proc/${escaped}; echo $?`)).stdout.trim(), "1");
  });

  it("enforces the block and inode bounds of /world with ENOSPC", async () => {
    const fill = await run(world, "dd if=/dev/zero of=/world/fill bs=1M 2>&1; echo exit=$?; sync");
    assert.match(fill.stdout, /No space left on device/);
    const full = await world.sample({ listing: false });
    assert.ok(full.storage.available && full.storage.value.availableBytes < 1 << 20);
    await run(world, "rm /world/fill");

    const inodes = await run(
      world,
      "python3 -I -c \"import os,errno\nos.mkdir('/world/many')\nn=0\ntry:\n  while True: open('/world/many/%d'%n,'w').close(); n+=1\nexcept OSError as e: print(n, errno.errorcode[e.errno])\"",
    );
    const [count, code] = inodes.stdout.trim().split(" ");
    assert.equal(code, "ENOSPC");
    assert.ok(Number(count) > 900 && Number(count) < 1024, count);
    const exhausted = await world.sample({ listing: false });
    assert.ok(exhausted.storage.available && exhausted.storage.value.availableInodes === 0);
    await run(world, "rm -rf /world/many");
  });

  it("keeps every other writable surface bounded or closed", async () => {
    const surfaces = await run(
      world,
      [
        "touch /etc/x 2>&1 | grep -c 'Read-only file system'",
        "dd if=/dev/zero of=/tmp/fill bs=1M 2>&1 | grep -c 'No space left'; rm -f /tmp/fill",
        "dd if=/dev/zero of=/dev/shm/fill bs=1M 2>&1 | grep -c 'No space left'; rm -f /dev/shm/fill",
      ].join("; "),
    );
    assert.equal(surfaces.stdout, "1\n1\n1\n");

    const probes = await run(
      world,
      `python3 -I -c "
import ctypes, errno, os, socket
libc = ctypes.CDLL(None, use_errno=True)
libc.mq_open.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
class A(ctypes.Structure): _fields_ = [('f', ctypes.c_long), ('m', ctypes.c_long), ('s', ctypes.c_long), ('c', ctypes.c_long), ('p', ctypes.c_long * 4)]
for m, s in ((4, 128), (1, 1)):
    fd = libc.mq_open(b'/probe', os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600, ctypes.byref(A(0, m, s, 0)))
    print('mq', fd, errno.errorcode.get(ctypes.get_errno()))
try: os.open('/dev/mqueue/f', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600); print('mqfile created')
except OSError as e: print('mqfile', errno.errorcode[e.errno])
print('mqueues', len(os.listdir('/dev/mqueue')))
try:
    socket.create_connection(('1.1.1.1', 53), timeout=2); print('net connected')
except OSError as e: print('net', type(e).__name__)
files = []
try:
    while True: files.append(os.open('/dev/null', os.O_RDONLY))
except OSError as e: print('nofile', len(files), errno.errorcode[e.errno])
"`,
    );
    const lines = probes.stdout.trim().split("\n");
    assert.deepEqual(lines.slice(0, 4), ["mq -1 EMFILE", "mq -1 EMFILE", "mqfile EMFILE", "mqueues 0"], probes.stdout + probes.stderr);
    assert.match(lines[4]!, /^net (OSError|gaierror|TimeoutError)/);
    assert.match(lines[5]!, /^nofile 12\d EMFILE$/);

    const pids = await run(
      world,
      "python3 -I -c \"import os,subprocess\nkids=[]\ntry:\n  while True: kids.append(subprocess.Popen(['sleep','30']))\nexcept OSError as e: print(len(kids), e.errno)\nfor k in kids: k.kill(); k.wait()\"",
    );
    const [forked, errnoValue] = pids.stdout.trim().split(" ");
    assert.equal(errnoValue, "11", pids.stdout + pids.stderr);
    assert.ok(Number(forked) < 64, forked);

    const oom = await run(world, "python3 -I -c \"x = bytearray(200 << 20); print('allocated')\"");
    assert.equal(oom.exitCode, 137);
    assert.equal((await run(world, "echo alive")).stdout, "alive\n");
  });

  it("keeps controller credentials out of the world and its records", async () => {
    const env = await run(world, "env; cat /proc/1/environ | tr '\\0' '\\n'");
    assert.ok(!env.stdout.includes(CONTROLLER_SECRET_NAME));
    assert.ok(!env.stdout.includes("controller-secret"));
    const events = await readFile(world.paths.events, "utf8");
    assert.ok(!events.includes("controller-secret"));
  });

  it("ends jobs with a verified stop and keeps files, not processes, across a restart", async () => {
    await run(world, "echo persisted > /world/marker; sqlite3 /world/state.db 'create table t(v); insert into t values (42);'");
    const lingering = await submit(world, "sleep 1000");
    assert.equal(lingering.state, "running");
    const stop = await world.stop("operator_stop");
    assert.equal(stop.verified, true, stop.detail);
    await reopen(false);
    await world.start();
    const after = await run(world, "cat marker; sqlite3 state.db 'select v from t'; pgrep -f 'sleep 100[0]' || echo no-sleep");
    const [marker, row, sleeping] = after.stdout.split("\n");
    assert.deepEqual([marker, row, sleeping], ["persisted", "42", "no-sleep"]);
    const log = await readEventLog(world.paths.events);
    const ended = log.events.find((event) => event.type === "job.state" && event.data.jobId === lingering.jobId && event.data.to === "ended_with_world");
    assert.ok(ended, "the running job was recorded as ending with the world");
    assert.ok(!log.events.some((event) => event.type === "job.state" && event.data.jobId === lingering.jobId && event.data.to === "exited"));
    assert.equal(log.events.filter((event) => event.type === "world.provisioned").length, 1, "never reprovisioned or reseeded");
  });

  it("coordinates a stop with a submission in progress: never started, or tracked and ended with the world", async (t) => {
    const pending = submit(world, "echo started > /world/raced; sleep 1000").then(
      (job) => job,
      (error: unknown) => error as Error,
    );
    const stop = await world.stop("operator_stop");
    assert.equal(stop.verified, true, stop.detail);
    const outcome = await pending;
    const log = await readEventLog(world.paths.events);
    assert.deepEqual(log.issues, []);
    await reopen(false);
    await world.start();
    const raced = (await run(world, "test -e /world/raced; echo $?")).stdout.trim();
    t.diagnostic(outcome instanceof Error ? "the submission was refused before starting" : "the submission started and ended with the world");
    if (outcome instanceof Error) {
      assert.ok(outcome instanceof DispatchRefusedError, outcome.message);
      assert.equal(raced, "1", "a refused submission never ran");
    } else {
      const states = log.events.filter((event) => event.type === "job.state" && event.data.jobId === outcome.jobId).map((event) => event.data.to);
      assert.equal(states.at(-1), "ended_with_world", JSON.stringify(states));
      const stopping = log.events.findIndex((event) => event.type === "world.stopping");
      const prepared = log.events.findIndex((event) => event.type === "job.prepared" && event.data.jobId === outcome.jobId);
      assert.ok(prepared !== -1 && prepared < log.events.findIndex((event, index) => index > stopping && event.type === "world.stopped"));
    }
  });

  it("refuses to capture a running world", async () => {
    await assert.rejects(world.captureArtifacts("live"), CaptureRefusedError);
  });

  it("captures a stopped world read-only, indexing hostile entries without following them", async () => {
    await run(world, "ln -s /etc/passwd abs-link; mkfifo fifo; printf x > \"$(printf 'esc\\033[31mname')\"; mkdir -p locked/inner; echo secret > locked/inner/f; chmod 000 locked");
    assert.equal((await world.stop("operator_stop")).verified, true);
    const archive = await world.captureArtifacts("final");
    assert.equal(archive.complete, true, archive.omissions.join("; "));
    const manifest = JSON.parse(await readFile(path.join(world.paths.archives, archive.archiveId, "manifest.json"), "utf8")) as {
      source: { unchanged: boolean };
      entries: { path: string | null; pathBase64: string; type: string; linkTargetBase64: string | null; sha256: string | null; mode: string }[];
    };
    assert.equal(manifest.source.unchanged, true);
    const find = (name: string) => manifest.entries.find((entry) => entry.path === name);
    assert.equal(find("abs-link")?.type, "symlink");
    assert.equal(Buffer.from(find("abs-link")!.linkTargetBase64!, "base64").toString(), "/etc/passwd");
    assert.equal(find("fifo")?.type, "fifo");
    assert.equal(find("marker")?.sha256, createHash("sha256").update("persisted\n").digest("hex"));
    assert.equal(find("locked")?.mode, "0000");
    assert.ok(find("locked/inner/f")?.sha256, "unreadable directories are read with DAC_READ_SEARCH");
    assert.ok(manifest.entries.some((entry) => Buffer.from(entry.pathBase64, "base64").includes(0x1b)), "raw control bytes are kept");
    assert.equal(find("materials/measurements.csv")?.sha256, "190af07c38bad47a2205f4009219bcb074a9468829e7f16ffc7da0959ad12ad2");
  });

  it("fails closed when the world volume names another world's filesystem", async () => {
    const decoy = await newWorld("empty-v1");
    const decoyWorld = await openWorld(await access(decoy.worldId, true));
    await decoyWorld.attach();
    const decoyDevice = (await inspectVolume(engine, resourceNames(decoy.worldId).deviceVolume))!.options.device!;
    await decoyWorld.close();

    // Simulate a stale reference: this world's volume now names the decoy's loop device.
    const names = resourceNames(main.worldId);
    const ownDevice = (await inspectVolume(engine, names.deviceVolume))!.options.device!;
    assert.notEqual(ownDevice, decoyDevice);
    await removeVolume(engine, names.deviceVolume, main.worldId, "device");
    await createVolume(engine, names.deviceVolume, main.worldId, "device", { type: "ext4", device: decoyDevice, o: "noatime,nodev,nosuid" });

    await reopen(false);
    await assert.rejects(world.start(), (error: Error) => error instanceof PrivilegeRequiredError && /filesystem ID/.test(error.message));
    await reopen(true);
    await world.attach();
    assert.equal((await inspectVolume(engine, names.deviceVolume))!.options.device, ownDevice);
  });

  it("refuses to start detached storage without authorization, then reattaches it without reformatting", async () => {
    const detached = await world.detach();
    assert.equal(detached.verified, true);
    await reopen(false);
    await assert.rejects(world.start(), (error: Error) => error instanceof PrivilegeRequiredError && /could not be mounted|does not exist/.test(error.message));
    await reopen(true);
    await world.start();
    assert.equal((await run(world, "cat marker")).stdout, "persisted\n");
    assert.equal((await world.stop("operator_stop")).verified, true);
  });

  it("refuses to capture a filesystem that is not clean", async () => {
    const decoy = created.at(-1)!;
    const decoyWorld = await openWorld(await access(decoy, true));
    assert.equal((await decoyWorld.detach()).verified, true);
    const metadata = decoyWorld.metadata;
    const marked = await runHelper(engine, {
      worldId: decoy,
      purpose: "test-mark-dirty",
      image: metadata.images.helper,
      privileged: false,
      capAdd: [],
      user: "0:0",
      mounts: [{ volume: metadata.resources.backingVolume, target: "/backing", readOnly: false }],
      cmd: ["debugfs", "-w", "-R", "ssv state 0", "/backing/world.ext4"],
      stdoutLimit: 4096,
      stderrLimit: 4096,
      timeoutMs: 30_000,
      memoryBytes: 64 << 20,
      pids: 8,
    });
    assert.equal(marked.exitCode, 0, marked.stderr.toString());
    await assert.rejects(decoyWorld.captureArtifacts("dirty"), (error: Error) => error instanceof CaptureRefusedError && /not clean/.test(error.message));
    await decoyWorld.close();
  });
});
