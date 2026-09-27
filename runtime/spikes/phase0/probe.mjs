#!/usr/bin/env node
// Phase 0 capability probes for the first runnable Alife system.
//
// Creates only disposable, labelled resources on an explicitly selected local
// Docker context, records results as JSON, and removes what it created.
// See README.md for what each flag permits.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Docker, LABEL, Recorder, ext4Fsid, run, sleep } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const opts = { context: null, privileged: false, engineRestart: false, keep: false, out: join(HERE, "results"), cleanup: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--docker-context") opts.context = argv[++i];
    else if (a === "--allow-privileged-helper") opts.privileged = true;
    else if (a === "--allow-engine-restart") opts.engineRestart = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--out") opts.out = resolve(argv[++i]);
    else if (a === "--cleanup") opts.cleanup = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: probe.mjs --docker-context <name> [--allow-privileged-helper] [--allow-engine-restart] [--keep] [--out dir]\n" +
          "       probe.mjs --docker-context <name> [--allow-privileged-helper] --cleanup <run-id>",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.context) throw new Error("--docker-context is required; no implicit context is used");
  return opts;
}

// ---------------------------------------------------------------------------
// Probe profile (mirrors the plan's illustrative baseline)

const PROFILE = {
  uid: 1000,
  gid: 1000,
  capacityMiB: 128,
  inodes: 4096,
  memoryMiB: 256,
  cpus: 0.5,
  pids: 64,
  nofile: 256,
  tmpMiB: 16,
  shmMiB: 8,
  drainMs: 1000,
  captureBytes: 65536,
  archiveLimitBytes: 256 << 20,
};

const WORLD_IMAGE = "alife-p0-world:dev";
const TOOLS_IMAGE = "alife-p0-tools:dev";

// ---------------------------------------------------------------------------
// In-world probe scripts (run with the image's read-only python3 -I)

const PY_ISOLATION = String.raw`
import os, json, socket, errno, resource
r = {}
r['uid'] = os.getuid(); r['gid'] = os.getgid(); r['groups'] = os.getgroups()
st = {}
for line in open('/proc/self/status'):
    k, _, v = line.partition(':')
    if k in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb','NoNewPrivs','Seccomp'):
        st[k] = v.strip()
r['status'] = st
mounts = []
for line in open('/proc/self/mountinfo'):
    p = line.split(); s = p.index('-')
    mounts.append({'mountpoint': p[4], 'opts': p[5], 'fstype': p[s+1], 'source': p[s+2], 'superopts': p[s+3]})
r['mounts'] = mounts
def create(path):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.close(fd); os.unlink(path); return 'ok'
    except OSError as e: return errno.errorcode.get(e.errno, str(e.errno))
def openw(path):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND); os.close(fd); return 'ok'
    except OSError as e: return errno.errorcode.get(e.errno, str(e.errno))
r['create'] = {p: create(p) for p in ['/probe','/etc/probe','/usr/probe','/var/probe','/var/tmp/probe','/root/probe','/run/probe','/dev/probe','/home/probe','/world/.probe','/tmp/.probe','/dev/shm/.probe','/dev/mqueue/probe']}
r['openw'] = {p: openw(p) for p in ['/etc/hosts','/etc/resolv.conf','/etc/hostname','/etc/passwd']}
writable = []
skip = ('/proc', '/sys', '/world', '/tmp', '/dev/shm')
for root, dirs, files in os.walk('/', topdown=True):
    dirs[:] = [d for d in dirs if os.path.join(root, d) not in skip]
    if os.access(root, os.W_OK) and root not in skip:
        writable.append(root)
    for f in files:
        p = os.path.join(root, f)
        if not os.path.islink(p) and os.access(p, os.W_OK):
            writable.append(p)
    if len(writable) > 60: break
r['writable_outside_expected'] = writable
r['net_interfaces'] = [l.split(':')[0].strip() for l in open('/proc/net/dev').read().splitlines()[2:]]
def conn(host, port, fam=socket.AF_INET):
    s = socket.socket(fam, socket.SOCK_STREAM); s.settimeout(2)
    try:
        s.connect((host, port)); return 'connected'
    except OSError as e: return errno.errorcode.get(e.errno, type(e).__name__) if e.errno else type(e).__name__
    finally: s.close()
r['connect'] = {'1.1.1.1:443': conn('1.1.1.1', 443), '192.168.138.1:22': conn('192.168.138.1', 22), '[2606:4700:4700::1111]:443': conn('2606:4700:4700::1111', 443, socket.AF_INET6)}
try:
    socket.getaddrinfo('example.com', 443); r['dns'] = 'resolved'
except OSError as e: r['dns'] = type(e).__name__
r['docker_socket'] = [p for p in ['/var/run/docker.sock','/run/docker.sock','/run/containerd/containerd.sock'] if os.path.exists(p)]
r['env_keys'] = sorted(os.environ.keys())
cg = {}
for f in ['memory.max','memory.swap.max','memory.high','pids.max','cpu.max','io.max']:
    try: cg[f] = open('/sys/fs/cgroup/' + f).read().strip()
    except OSError as e: cg[f] = 'unavailable'
r['cgroup'] = cg
r['rlimit_nofile'] = resource.getrlimit(resource.RLIMIT_NOFILE)
r['rlimit_nproc'] = resource.getrlimit(resource.RLIMIT_NPROC)
r['dev'] = sorted(os.listdir('/dev'))
r['hostname'] = socket.gethostname()
print(json.dumps(r))
`;

const PY_FORK = String.raw`
import os, time, signal, json
kids = []; err = None
for i in range(200):
    try: pid = os.fork()
    except OSError as e: err = e.errno; break
    if pid == 0:
        time.sleep(30); os._exit(0)
    kids.append(pid)
for k in kids: os.kill(k, signal.SIGKILL)
for k in kids: os.waitpid(k, 0)
print(json.dumps({'forked': len(kids), 'errno': err}))
`;

const PY_NOFILE = String.raw`
import os, json, errno
fds = []; err = None
try:
    while len(fds) < 5000: fds.append(os.open('/dev/null', os.O_RDONLY))
except OSError as e: err = errno.errorcode.get(e.errno)
print(json.dumps({'opened': len(fds), 'error': err}))
`;

const PY_MEMORY = String.raw`
b = bytearray(400 * 1024 * 1024)
for i in range(0, len(b), 4096): b[i] = 1
print('survived')
`;

const PY_CPU = String.raw`
import os, time, json
def usage():
    for l in open('/sys/fs/cgroup/cpu.stat'):
        k, v = l.split()
        if k == 'usage_usec': return int(v)
u0 = usage(); t0 = time.monotonic(); kids = []
for _ in range(2):
    pid = os.fork()
    if pid == 0:
        end = time.monotonic() + 3
        while time.monotonic() < end: pass
        os._exit(0)
    kids.append(pid)
for k in kids: os.waitpid(k, 0)
wall = time.monotonic() - t0; used = (usage() - u0) / 1e6
print(json.dumps({'wall_s': round(wall, 3), 'cpu_s': round(used, 3), 'cpus': round(used / wall, 3)}))
`;

const PY_INODES = String.raw`
import os, json, errno, shutil
os.makedirs('/world/inode-probe', exist_ok=True)
n = 0; err = None
try:
    while n < 100000:
        open('/world/inode-probe/%d' % n, 'w').close(); n += 1
except OSError as e: err = errno.errorcode.get(e.errno)
st = os.statvfs('/world')
out = {'created': n, 'error': err, 'files_free_at_limit': st.f_ffree, 'files_total': st.f_files}
shutil.rmtree('/world/inode-probe')
print(json.dumps(out))
`;

// Snapshot of processes: [pid, starttime, ppid, sid]
const PY_PS = String.raw`
import os, json
out = []
for d in os.listdir('/proc'):
    if not d.isdigit(): continue
    try: s = open('/proc/%s/stat' % d).read()
    except OSError: continue
    rest = s[s.rindex(')') + 2:].split()
    out.append([int(d), int(rest[19]), int(rest[1]), int(rest[3]), s[s.index('(')+1:s.rindex(')')]])
print(json.dumps(out))
`;

// Terminate an action after timeout.
//   argv[1] = mode: "session" (kill the action's session only) or "tree"
//             (also kill processes started after the snapshot that do not
//             descend from any pre-existing process other than init)
//   argv[2] = JSON snapshot [[pid, starttime], ...] taken before dispatch
const PY_TERMINATE = String.raw`
import os, sys, json, signal, time
mode = sys.argv[1]
before = {(p, t) for p, t in json.loads(sys.argv[2])}
me = os.getpid(); my_sid = os.getsid(0)
def table():
    t = {}
    for d in os.listdir('/proc'):
        if not d.isdigit(): continue
        try: s = open('/proc/%s/stat' % d).read()
        except OSError: continue
        rest = s[s.rindex(')') + 2:].split()
        t[int(d)] = {'start': int(rest[19]), 'ppid': int(rest[1]), 'sid': int(rest[3]), 'comm': s[s.index('(')+1:s.rindex(')')]}
    return t
def targets(t):
    new = {p for p, v in t.items() if (p, v['start']) not in before and v['sid'] != my_sid and p not in (me, 1)}
    # the action's session leaders: new processes exec'd directly by the engine (ppid 0)
    sessions = {p for p in new if t[p]['ppid'] == 0}
    chosen = {p for p in new if t[p]['sid'] in sessions}
    if mode == 'tree':
        pre = {p for p, v in t.items() if (p, v['start']) in before and p != 1}
        for p in new:
            q, ok = p, True
            seen = set()
            while q in t and q not in seen:
                seen.add(q)
                if q in pre: ok = False; break
                q = t[q]['ppid']
            if ok: chosen.add(p)
    return chosen
killed = []
for _ in range(10):
    t = table(); ts = targets(t)
    if not ts: break
    for p in ts:
        try: os.kill(p, signal.SIGKILL); killed.append([p, t[p]['comm']])
        except ProcessLookupError: pass
    time.sleep(0.1)
t = table()
print(json.dumps({'mode': mode, 'killed': killed, 'remaining': [[p, t[p]['comm']] for p in targets(t)]}))
`;

// ---------------------------------------------------------------------------

class Probe {
  constructor(opts) {
    this.opts = opts;
    this.docker = new Docker(opts.context);
    this.rec = new Recorder();
    this.runId = opts.cleanup ?? `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`;
    this.prefix = `alife-p0-${this.runId}`;
    this.names = {
      backing: `${this.prefix}-backing`,
      decoyBacking: `${this.prefix}-decoy-backing`,
      world: `${this.prefix}-world`,
      capture: `${this.prefix}-capture`,
      stale: `${this.prefix}-stale`,
      bogus: `${this.prefix}-bogus`,
      container: `${this.prefix}-world`,
    };
    this.worldUuid = randomUUID();
    this.decoyUuid = randomUUID();
    this.device = null;
  }

  label() {
    return ["--label", `${LABEL}=${this.runId}`];
  }

  // ----- infrastructure -------------------------------------------------

  async tools(script, { args = [], volumes = [], privileged = false, extra = [] } = {}) {
    const flags = ["run", "--rm", "--network", "none", "--read-only", ...this.label()];
    if (privileged) {
      if (!this.opts.privileged) throw new Error("privileged helper not permitted (--allow-privileged-helper)");
      flags.push("--privileged");
    } else {
      flags.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
    }
    for (const v of volumes) flags.push("--mount", v);
    flags.push(...extra, TOOLS_IMAGE, "sh", "-c", script, "sh", ...args);
    return this.docker.cli(flags);
  }

  async buildImages() {
    for (const [tag, dir] of [
      [WORLD_IMAGE, "images/world"],
      [TOOLS_IMAGE, "images/tools"],
    ]) {
      const r = await this.docker.cli(["build", "-q", ...this.label(), "--label", "sh.alife.phase0.image=1", "-t", tag, join(HERE, dir)], {
        timeoutMs: 600_000,
      });
      if (r.code !== 0) throw new Error(`image build failed for ${tag}: ${r.stderr}`);
      const inspect = JSON.parse(await this.docker.cliOk(["image", "inspect", tag, "--format", "{{json .}}"]));
      this.rec.fact(`image.${tag}`, { id: inspect.Id, architecture: inspect.Architecture, os: inspect.Os });
    }
  }

  async provision(backing, uuid, label) {
    await this.docker.cliOk(["volume", "create", ...this.label(), backing]);
    const script = `set -eu
truncate -s "$1M" /backing/world.ext4
mkfs.ext4 -q -F -b 4096 -N "$2" -m 0 -J size=4 -U "$3" -L "$4" -E root_owner=${PROFILE.uid}:${PROFILE.gid},lazy_itable_init=0,lazy_journal_init=0 /backing/world.ext4
dumpe2fs -h /backing/world.ext4 2>/dev/null`;
    const r = await this.tools(script, {
      args: [String(PROFILE.capacityMiB), String(PROFILE.inodes), uuid, label],
      volumes: [`type=volume,src=${backing},dst=/backing`],
    });
    if (r.code !== 0) throw new Error(`provision failed: ${r.stderr}`);
    return parseDumpe2fs(r.stdout);
  }

  /** Privileged: attach (or reuse) a loop device for the image and report its probed UUID. */
  async attach(backing) {
    const script = `set -eu
f=/backing/world.ext4
d=$(losetup --find --show --nooverlap "$f")
printf '%s %s %s\n' "$d" "$(blkid -p -s UUID -o value "$d")" "$(blkid -p -s TYPE -o value "$d")"`;
    const r = await this.tools(script, { volumes: [`type=volume,src=${backing},dst=/backing`], privileged: true });
    if (r.code !== 0) throw new Error(`attach failed: ${r.stderr}`);
    const [device, uuid, type] = r.stdout.trim().split(/\s+/);
    return { device, uuid, type };
  }

  /** Privileged: detach every loop device backed by this image. */
  async detach(backing) {
    const script = `set -eu
for d in $(losetup -j /backing/world.ext4 -n -O NAME); do losetup -d "$d"; echo "$d"; done`;
    const r = await this.tools(script, { volumes: [`type=volume,src=${backing},dst=/backing,readonly`], privileged: true });
    if (r.code !== 0) throw new Error(`detach failed: ${r.stderr}`);
    return r.stdout.trim().split(/\s+/).filter(Boolean);
  }

  async deviceVolume(name, device, options) {
    await this.docker.cliOk([
      "volume", "create", ...this.label(), "--driver", "local",
      "--opt", "type=ext4", "--opt", `device=${device}`, "--opt", `o=${options}`, name,
    ]);
  }

  /** Unprivileged identity check: the mounted filesystem's statfs id must match the recorded UUID. */
  async verifyIdentity(volume, uuid) {
    const r = await this.docker.cli([
      "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", `${PROFILE.uid}:${PROFILE.gid}`, ...this.label(),
      "--mount", `type=volume,src=${volume},dst=/world,readonly`,
      WORLD_IMAGE, "stat", "-f", "-c", "%i %T", "/world",
    ]);
    if (r.code !== 0) return { ok: false, reason: "mount-or-stat-failed", stderr: r.stderr.trim() };
    const [fsid] = r.stdout.trim().split(/\s+/);
    const f = ext4Fsid(uuid);
    const expected = ((BigInt(f.lo) << 32n) | BigInt(f.hi)).toString(16);
    return { ok: fsid === expected, fsid, expected };
  }

  worldRunArgs(volume) {
    return [
      "run", "-d", "--name", this.names.container, ...this.label(),
      "--init", "--user", `${PROFILE.uid}:${PROFILE.gid}`, "--read-only",
      "--mount", `type=volume,src=${volume},dst=/world`,
      "--tmpfs", `/tmp:rw,nosuid,nodev,size=${PROFILE.tmpMiB}m,mode=1777`,
      "--shm-size", `${PROFILE.shmMiB}m`,
      "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--memory", `${PROFILE.memoryMiB}m`, "--memory-swap", `${PROFILE.memoryMiB}m`,
      "--cpus", String(PROFILE.cpus), "--pids-limit", String(PROFILE.pids),
      "--ulimit", `nofile=${PROFILE.nofile}:${PROFILE.nofile}`,
      "--log-driver", "none", "--restart", "no", "--stop-timeout", "5",
      "--hostname", "world", "--env", "HOME=/world", "--workdir", "/world",
      WORLD_IMAGE, "sleep", "infinity",
    ];
  }

  async startWorld(volume) {
    const r = await this.docker.cli(this.worldRunArgs(volume));
    return r;
  }

  async removeWorld() {
    await this.docker.cli(["stop", "-t", "5", this.names.container]);
    await this.docker.cli(["rm", "-f", this.names.container]);
  }

  sh(cmd, opts) {
    return this.docker.exec(this.names.container, ["/bin/sh", "-c", cmd], opts);
  }

  py(script, args = [], opts) {
    return this.docker.exec(this.names.container, ["/usr/bin/python3", "-I", "-c", script, ...args], opts);
  }

  async backingStat() {
    const r = await this.tools(`set -eu; du -k --apparent-size /backing/world.ext4; du -k /backing/world.ext4; sha256sum /backing/world.ext4; dumpe2fs -h /backing/world.ext4 2>/dev/null`, {
      volumes: [`type=volume,src=${this.names.backing},dst=/backing,readonly`],
    });
    if (r.code !== 0) throw new Error(`backing stat failed: ${r.stderr}`);
    const lines = r.stdout.split("\n");
    return {
      apparentKiB: Number(lines[0].split(/\s+/)[0]),
      allocatedKiB: Number(lines[1].split(/\s+/)[0]),
      sha256: lines[2].split(/\s+/)[0],
      superblock: parseDumpe2fs(lines.slice(3).join("\n")),
    };
  }

  // ----- sections --------------------------------------------------------

  async discover() {
    const R = this.rec;
    const ctx = await this.docker.resolve();
    const home = homedir();
    R.fact("docker.context", { name: this.opts.context, endpoint: this.docker.endpoint.replace(home, "~") , description: ctx.Metadata?.Description ?? null });
    const info = JSON.parse(await this.docker.cliOk(["info", "--format", "{{json .}}"]));
    const version = JSON.parse(await this.docker.cliOk(["version", "--format", "{{json .}}"]));
    R.fact("engine", {
      id: info.ID,
      name: info.Name,
      operatingSystem: info.OperatingSystem,
      serverVersion: info.ServerVersion,
      apiVersion: version.Server?.ApiVersion,
      clientVersion: version.Client?.Version,
      kernel: info.KernelVersion,
      architecture: info.Architecture,
      ncpu: info.NCPU,
      memTotal: info.MemTotal,
      storageDriver: info.Driver,
      driverStatus: info.DriverStatus,
      dockerRootDir: info.DockerRootDir,
      cgroupDriver: info.CgroupDriver,
      cgroupVersion: info.CgroupVersion,
      securityOptions: info.SecurityOptions,
      defaultRuntime: info.DefaultRuntime,
      initBinary: info.InitBinary,
      loggingDriver: info.LoggingDriver,
      volumePlugins: info.Plugins?.Volume,
      limits: { memory: info.MemoryLimit, swap: info.SwapLimit, cpuCfsQuota: info.CpuCfsQuota, pids: info.PidsLimit, oomKillDisable: info.OomKillDisable },
    });
    const orb = await run("orbctl", ["version"]);
    if (orb.code === 0) {
      R.fact("orbstack.version", orb.stdout.trim().split("\n")[0]);
      const cfg = await run("orbctl", ["config", "show"]);
      const keep = ["machine.docker.isolated", "machine.docker.mounts", "memory_mib", "cpu", "power.pause_in_sleep", "mount_hide_shared"];
      R.fact(
        "orbstack.config",
        Object.fromEntries(cfg.stdout.split("\n").map((l) => l.split(": ")).filter(([k]) => keep.includes(k))),
      );
    }
    const backing = await this.docker.cli(["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", ...this.label(),
      "--mount", `type=volume,src=${this.prefix}-fsprobe,dst=/v`, TOOLS_IMAGE, "sh", "-c", "grep ' /v ' /proc/mounts; df -k /v | tail -1"]);
    R.fact("engine.volumeFilesystem", backing.stdout.trim());
    await this.docker.cli(["volume", "rm", `${this.prefix}-fsprobe`]);
    R.record("D1", "discovery", "info", `context ${this.opts.context} → ${info.OperatingSystem} ${info.ServerVersion} ${info.Architecture}`, {
      engine: info.ID,
    });
    R.check("D2", "discovery", info.CgroupVersion === "2" && info.MemoryLimit && info.SwapLimit && info.PidsLimit && info.CpuCfsQuota,
      "engine reports cgroup v2 memory/swap/pids/cpu limit support", { cgroup: info.CgroupVersion });
    R.check("D3", "discovery", (info.SecurityOptions ?? []).some((s) => s.includes("seccomp")), "engine reports seccomp", { securityOptions: info.SecurityOptions });

    // A loop mount through the local volume driver alone (no privileged helper).
    await this.docker.cliOk(["volume", "create", ...this.label(), `${this.prefix}-loopprobe-backing`]);
    await this.tools("truncate -s 8M /b/img && mkfs.ext4 -q -F /b/img", { volumes: [`type=volume,src=${this.prefix}-loopprobe-backing,dst=/b`] });
    const mp = (await this.docker.cliOk(["volume", "inspect", `${this.prefix}-loopprobe-backing`, "--format", "{{.Mountpoint}}"])).trim();
    await this.docker.cliOk(["volume", "create", ...this.label(), "--driver", "local", "--opt", "type=ext4", "--opt", `device=${mp}/img`, "--opt", "o=loop", `${this.prefix}-loopprobe`]);
    const lr = await this.docker.cli(["run", "--rm", "--network", "none", ...this.label(), "--mount", `type=volume,src=${this.prefix}-loopprobe,dst=/w`, TOOLS_IMAGE, "true"]);
    R.record("D4", "storage", lr.code === 0 ? "warn" : "info",
      lr.code === 0 ? "local volume driver mounted o=loop without a helper (unexpected; re-evaluate backend)" : "local volume driver cannot mount an image file with o=loop (kernel mount has no loop option); a loop device must be attached separately",
      { stderr: lr.stderr.trim().slice(0, 300) });
    await this.docker.cli(["volume", "rm", `${this.prefix}-loopprobe`]);
    await this.docker.cli(["volume", "rm", `${this.prefix}-loopprobe-backing`]);
  }

  async storageSetup() {
    const R = this.rec;
    const sb = await this.provision(this.names.backing, this.worldUuid, "alife-p0-world");
    R.fact("storage.requested", { capacityMiB: PROFILE.capacityMiB, inodes: PROFILE.inodes });
    R.fact("storage.superblock.initial", sb);
    R.record("S0", "storage", "info", `ext4 image provisioned unprivileged: ${sb["Block count"]} × ${sb["Block size"]} B blocks, ${sb["Inode count"]} inodes, journal ${sb["Total journal size"] ?? sb["Journal size"] ?? "?"}, overhead ${sb["Overhead clusters"] ?? "?"} blocks`);
    const a = await this.attach(this.names.backing);
    this.device = a.device;
    R.fact("storage.attach", a);
    R.check("S1", "storage", a.uuid === this.worldUuid && a.type === "ext4", "privileged helper attached loop device and probed matching UUID", a);
    await this.deviceVolume(this.names.world, this.device, "noatime,nodev,nosuid");
    const id = await this.verifyIdentity(this.names.world, this.worldUuid);
    R.check("S2", "storage", id.ok, "unprivileged statfs identity check matches recorded UUID", id);
  }

  async isolation() {
    const R = this.rec;
    const started = await this.startWorld(this.names.world);
    if (!R.check("I0", "isolation", started.code === 0, "world container starts with the hardened profile", { stderr: started.stderr.trim() })) {
      throw new Error("world did not start");
    }
    const inspect = JSON.parse(await this.docker.cliOk(["inspect", this.names.container, "--format", "{{json .}}"]));
    const hc = inspect.HostConfig;
    const effective = {
      user: inspect.Config.User,
      readonlyRootfs: hc.ReadonlyRootfs,
      privileged: hc.Privileged,
      capAdd: hc.CapAdd,
      capDrop: hc.CapDrop,
      securityOpt: hc.SecurityOpt,
      networkMode: hc.NetworkMode,
      portBindings: hc.PortBindings,
      publishAllPorts: hc.PublishAllPorts,
      pidMode: hc.PidMode,
      ipcMode: hc.IpcMode,
      memory: hc.Memory,
      memorySwap: hc.MemorySwap,
      nanoCpus: hc.NanoCpus,
      pidsLimit: hc.PidsLimit,
      ulimits: hc.Ulimits,
      tmpfs: hc.Tmpfs,
      shmSize: hc.ShmSize,
      logConfig: hc.LogConfig,
      logPath: inspect.LogPath,
      restartPolicy: hc.RestartPolicy,
      autoRemove: hc.AutoRemove,
      init: hc.Init,
      devices: hc.Devices,
      binds: hc.Binds,
      mounts: inspect.Mounts.map((m) => ({ type: m.Type, name: m.Name, destination: m.Destination, rw: m.RW, driver: m.Driver })),
      appArmorProfile: inspect.AppArmorProfile,
    };
    R.fact("world.effectiveConfig", effective);
    R.check("I1", "isolation", !hc.Privileged && hc.ReadonlyRootfs && hc.CapDrop?.includes("ALL") && !hc.CapAdd?.length && hc.SecurityOpt?.includes("no-new-privileges"),
      "inspect: unprivileged, read-only root, all capabilities dropped, no-new-privileges", effective);
    R.check("I2", "isolation", hc.NetworkMode === "none" && !Object.keys(hc.PortBindings ?? {}).length, "inspect: network none, no published ports");
    R.check("I3", "isolation", hc.LogConfig.Type === "none" && !inspect.LogPath && hc.RestartPolicy.Name === "no" && !hc.AutoRemove,
      "inspect: logging disabled (no log file), no restart policy, no auto-remove", { log: hc.LogConfig, logPath: inspect.LogPath, restart: hc.RestartPolicy });
    R.check("I4", "isolation", inspect.Mounts.length === 1 && inspect.Mounts[0].Destination === "/world" && !(hc.Binds ?? []).length && !(hc.Devices ?? []).length,
      "inspect: /world is the only volume; no bind mounts or devices", { mounts: effective.mounts });

    const iso = await this.py(PY_ISOLATION);
    if (iso.exitCode !== 0) throw new Error(`isolation script failed: ${iso.stderr}`);
    const r = JSON.parse(iso.stdout);
    R.fact("world.observed", r);
    R.check("I5", "isolation", r.uid === PROFILE.uid && r.gid === PROFILE.gid && r.groups.length <= 1 && r.groups.every((g) => g === PROFILE.gid),
      "process runs as 1000:1000 without supplementary groups", { uid: r.uid, gid: r.gid, groups: r.groups });
    const zero = "0000000000000000";
    R.check("I6", "isolation", ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every((k) => r.status[k] === zero) && r.status.NoNewPrivs === "1" && r.status.Seccomp === "2",
      "empty capability sets, NoNewPrivs=1, seccomp filter mode", r.status);
    const expectedCreate = { "/world/.probe": "ok", "/tmp/.probe": "ok", "/dev/shm/.probe": "ok" };
    const unexpectedWrites = Object.entries(r.create).filter(([p, v]) => (expectedCreate[p] ?? "denied") === "ok" ? v !== "ok" : v === "ok");
    R.check("I7", "isolation", unexpectedWrites.length === 0 || unexpectedWrites.every(([p]) => p === "/dev/mqueue/probe"),
      "file creation succeeds only in /world, /tmp, /dev/shm", { create: r.create });
    R.record("I7a", "isolation", r.create["/dev/mqueue/probe"] === "ok" ? "warn" : "pass",
      r.create["/dev/mqueue/probe"] === "ok" ? "/dev/mqueue is writable (POSIX message queues; bounded by RLIMIT_MSGQUEUE, lost on stop)" : "/dev/mqueue not writable",
      { mqueue: r.create["/dev/mqueue/probe"] });
    R.check("I8", "isolation", Object.values(r.openw).every((v) => v !== "ok"), "cannot open /etc/hosts, resolv.conf, hostname, passwd, or pid 1 stdout for writing", r.openw);
    R.check("I9", "isolation", r.writable_outside_expected.filter((p) => !p.startsWith("/dev/mqueue")).every((p) => /^\/dev\/(null|zero|full|random|urandom|tty|ptmx|pts(\/ptmx)?)$/.test(p)),
      "no writable paths outside /world, /tmp, /dev/shm except standard character devices", { writable: r.writable_outside_expected });
    R.check("I10", "isolation", r.net_interfaces.length === 1 && r.net_interfaces[0] === "lo" && Object.values(r.connect).every((v) => v !== "connected") && r.dns !== "resolved",
      "only loopback; outbound IPv4/IPv6 and DNS fail", { interfaces: r.net_interfaces, connect: r.connect, dns: r.dns });
    R.check("I11", "isolation", r.docker_socket.length === 0 && !r.dev.some((d) => d.startsWith("loop")), "no Docker/containerd socket or loop devices visible", { dev: r.dev });
    R.check("I12", "isolation", r.env_keys.every((k) => ["HOME", "HOSTNAME", "PATH", "PWD", "LC_CTYPE", "SHLVL", "_"].includes(k)),
      "exec environment contains no inherited credentials", { env: r.env_keys });
    const cg = r.cgroup;
    R.check("I13", "isolation",
      cg["memory.max"] === String(PROFILE.memoryMiB * 1048576) && cg["memory.swap.max"] === "0" && cg["pids.max"] === String(PROFILE.pids) && cg["cpu.max"] === `${PROFILE.cpus * 100000} 100000` &&
        r.rlimit_nofile[0] === PROFILE.nofile && r.rlimit_nofile[1] === PROFILE.nofile,
      "cgroup memory/swap/pids/cpu and nofile limits visible as configured", { cgroup: cg, nofile: r.rlimit_nofile });
    const tmpMount = r.mounts.find((m) => m.mountpoint === "/tmp");
    const shmMount = r.mounts.find((m) => m.mountpoint === "/dev/shm");
    const worldMount = r.mounts.find((m) => m.mountpoint === "/world");
    R.record("I14", "isolation", "info", "writable mounts", { tmp: tmpMount, shm: shmMount, world: worldMount, mqueue: r.mounts.find((m) => m.mountpoint === "/dev/mqueue") });

    // Enforcement, not just configuration.
    for (const [id, path, mib] of [["I15", "/tmp", PROFILE.tmpMiB], ["I16", "/dev/shm", PROFILE.shmMiB]]) {
      const x = await this.sh(`dd if=/dev/zero of=${path}/fill bs=1M count=${mib * 4} 2>&1; echo "exit=$?"; stat -c %s ${path}/fill; rm -f ${path}/fill`);
      const size = Number(x.stdout.trim().split("\n").pop());
      R.check(id, "resources", /No space left/.test(x.stdout) && size <= mib * 1048576, `${path} writes stop at ${mib} MiB with ENOSPC`, { bytes: size, out: x.stdout.slice(-300) });
    }
    const mem = await this.py(PY_MEMORY, [], { timeoutMs: 60_000 });
    const after = JSON.parse(await this.docker.cliOk(["inspect", this.names.container, "--format", "{{json .State}}"]));
    const events = await this.sh("cat /sys/fs/cgroup/memory.events");
    R.check("I17", "resources", mem.exitCode === 137 && !mem.stdout.includes("survived") && after.Running,
      "400 MiB allocation is OOM-killed (exit 137); world keeps running", { exit: mem.exitCode, running: after.Running, oomKilledFlag: after.OOMKilled, events: events.stdout.trim() });
    const fork = JSON.parse((await this.py(PY_FORK)).stdout);
    R.check("I18", "resources", fork.forked < PROFILE.pids && fork.errno === 11, `fork stops below pids.max=${PROFILE.pids} with EAGAIN`, fork);
    const nofile = JSON.parse((await this.py(PY_NOFILE)).stdout);
    R.check("I19", "resources", nofile.error === "EMFILE" && nofile.opened <= PROFILE.nofile, `open() stops at nofile=${PROFILE.nofile} with EMFILE`, nofile);
    const cpu = JSON.parse((await this.py(PY_CPU, [], { timeoutMs: 30_000 })).stdout);
    R.check("I20", "resources", cpu.cpus <= PROFILE.cpus * 1.15, `two busy processes are throttled to ~${PROFILE.cpus} CPU`, cpu);
    const logw = await this.sh("head -c 4194304 /dev/zero > /proc/1/fd/1; echo $?");
    const logs = await this.docker.cli(["logs", this.names.container]);
    R.check("I21", "resources", logs.code !== 0 && !inspect.LogPath,
      "container stdout cannot accumulate a host-side log", { writeToPid1Stdout: logw.stdout.trim() || logw.stderr.trim(), logs: logs.stderr.trim() });
  }

  async storageEnforcement() {
    const R = this.rec;
    const m = await this.sh("stat -f -c '%i %b %f %a %S %c %d' /world; df -k /world | tail -1; df -i /world | tail -1");
    const [fsid, blocks, bfree, bavail, bsize, files, ffree] = m.stdout.split("\n")[0].split(" ");
    const usableMiB = (Number(bavail) * Number(bsize)) / 1048576;
    R.fact("storage.agentVisible", { fsid, blocks: +blocks, bfree: +bfree, bavail: +bavail, bsize: +bsize, files: +files, ffree: +ffree, usableMiB, df: m.stdout.split("\n").slice(1, 3) });
    R.check("S3", "storage", Number(files) === PROFILE.inodes && Number(blocks) * Number(bsize) <= PROFILE.capacityMiB * 1048576,
      `agent-visible statfs is per-world: ${usableMiB.toFixed(1)} MiB usable of ${PROFILE.capacityMiB} MiB requested, ${files} inodes`, { df: m.stdout.trim() });

    const fill = await this.sh("dd if=/dev/zero of=/world/fill bs=1M 2>&1; echo \"exit=$?\"; sync; stat -c %s /world/fill; stat -f -c %a /world", { timeoutMs: 120_000 });
    const lines = fill.stdout.trim().split("\n");
    const written = Number(lines.at(-2));
    const bs = await this.backingStat();
    R.fact("storage.exhaustion", { written, afterAvailBlocks: Number(lines.at(-1)), backing: { apparentKiB: bs.apparentKiB, allocatedKiB: bs.allocatedKiB } });
    R.check("S4", "storage", /No space left/.test(fill.stdout) && written <= PROFILE.capacityMiB * 1048576,
      `block exhaustion returns ENOSPC after ${(written / 1048576).toFixed(1)} MiB`, { tail: lines.slice(-4) });
    R.check("S5", "storage", bs.apparentKiB === PROFILE.capacityMiB * 1024 && bs.allocatedKiB <= PROFILE.capacityMiB * 1024,
      "backing image did not grow beyond requested size at exhaustion", { apparentKiB: bs.apparentKiB, allocatedKiB: bs.allocatedKiB });
    await this.sh("rm -f /world/fill");
    const ino = JSON.parse((await this.py(PY_INODES, [], { timeoutMs: 120_000 })).stdout);
    R.check("S6", "storage", ino.error === "ENOSPC" && ino.created < PROFILE.inodes, `inode exhaustion returns ENOSPC after ${ino.created} files`, ino);
  }

  async execution() {
    const R = this.rec;
    const d = this.docker;
    const C = this.names.container;

    // E1: ordinary completion with demultiplexed streams.
    const e1 = await this.sh("echo out; echo err >&2; exit 7");
    R.check("E1", "execution", e1.exitCode === 7 && e1.stdout === "out\n" && e1.stderr === "err\n" && e1.running === false,
      "exec reports exit status and separate stdout/stderr", e1);
    const e2 = await this.sh("kill -TERM $$");
    R.check("E2", "execution", e2.exitCode === 143, "termination by signal is reported (128+SIGTERM)", { exit: e2.exitCode });

    // E3: background work survives the tick that started it.
    const t0 = Date.now();
    const e3 = await this.sh("nohup sh -c 'while :; do date +%s >> /world/bg.log; sleep 1; done' >/dev/null 2>&1 & echo $!");
    const e3ms = Date.now() - t0;
    await sleep(3500);
    const bg = await this.sh("wc -l < /world/bg.log; pgrep -f 'date \\+%s' >/dev/null && echo alive");
    const bgLines = Number(bg.stdout.split("\n")[0]);
    R.check("E3", "execution", e3.exitCode === 0 && e3ms < 3000 && bgLines >= 3 && bg.stdout.includes("alive"),
      "fully redirected background process returns promptly and keeps running across later execs", { returnMs: e3ms, lines: bgLines });

    // E4: inherited stdout keeps the stream open after the command exits.
    const r4 = await this.timedExec(["/bin/sh", "-c", "sleep 15 & echo started"], { deadlineMs: 20_000 });
    const sleepAlive = (await this.sh("pgrep -x sleep -a | grep -c 'sleep 15'")).stdout.trim();
    R.check("E4", "execution", r4.exitMs !== null && r4.exitMs < 5000 && sleepAlive === "1",
      `inherited stdout does not hold the exec open for the descendant's lifetime (exit ${r4.exitMs} ms, stream ${r4.endedBy} at ${r4.eofMs ?? "-"} ms)`, { ...r4, sleep15Alive: sleepAlive });

    // E5: what happens to a background writer on an inherited pipe after detach.
    await this.sh("rm -f /tmp/writer.count");
    const r5 = await this.timedExec(["/bin/sh", "-c",
      "(i=0; while [ $i -lt 600 ]; do head -c 1024 /dev/zero || exit 9; i=$((i+1)); echo $i > /tmp/writer.count; sleep 0.01; done) & echo started"], { deadlineMs: 20_000 });
    await sleep(12_000);
    const wc = await this.sh("cat /tmp/writer.count; pgrep -f 'while \\[' >/dev/null && echo alive || echo gone");
    const [count, state] = wc.stdout.trim().split("\n");
    R.record("E5", "execution", "info",
      `background writer on the inherited stdout ${Number(count) >= 600 ? "ran to completion (engine kept draining)" : state === "alive" ? "is blocked on a full pipe" : "died once the stream closed (EPIPE/SIGPIPE)"} (${count}/600 KiB written)`,
      { ...r5, count: Number(count), state });

    // E6: client disconnect does not terminate the command.
    const snap6 = JSON.parse((await this.py(PY_PS)).stdout).map(([p, t]) => [p, t]);
    const id6 = await d.execCreate(C, ["/bin/sh", "-c", "sleep 30"]);
    const h6 = d.execStart(id6);
    await sleep(1000);
    h6.destroy();
    await sleep(1500);
    const i6 = await d.execInspect(id6);
    const s6 = await this.sh("pgrep -x sleep -a | grep -c 'sleep 30' || true");
    R.check("E6", "execution", i6.Running === true && s6.stdout.trim() === "1",
      "closing the attach stream does NOT stop the command (exec keeps running)", { running: i6.Running, pid: i6.Pid });
    await this.py(PY_TERMINATE, ["session", JSON.stringify(snap6)]);
    await sleep(300);

    // E7/E8: timeout termination, ordinary and daemonized descendants.
    const action = "sleep 300 & ( setsid sh -c 'exec env -i /bin/sleep 301' </dev/null >/dev/null 2>&1 & ) ; sleep 302";
    for (const [id, mode] of [["E7", "session"], ["E8", "tree"]]) {
      const snap = JSON.parse((await this.py(PY_PS)).stdout).map(([p, t]) => [p, t]);
      const execId = await d.execCreate(C, ["/bin/sh", "-c", action]);
      const h = d.execStart(execId);
      await sleep(2000); // the action's timeout
      const term = JSON.parse((await this.py(PY_TERMINATE, [mode, JSON.stringify(snap)])).stdout);
      await sleep(500);
      const info = await d.execInspect(execId);
      h.destroy();
      const left = (await this.sh("pgrep -a -x sleep | grep -E 'sleep 30[012]' || true")).stdout.trim();
      const bgAlive = (await this.sh("pgrep -f 'date \\+%s' >/dev/null && echo alive || echo gone")).stdout.trim();
      if (mode === "session") {
        R.check(id, "execution", !info.Running && /sleep 301/.test(left) && !/sleep 30[02]/.test(left) && bgAlive === "alive",
          "session kill ends the timed-out command and its ordinary children, but a setsid+env -i daemon escapes", { term, running: info.Running, exitCode: info.ExitCode, survivors: left, backgroundLoop: bgAlive });
        await this.py(PY_TERMINATE, ["tree", JSON.stringify(snap)]);
      } else {
        R.check(id, "execution", !info.Running && left === "" && bgAlive === "alive",
          "tree kill (new processes not descended from pre-existing ones) also ends escaped daemons, sparing earlier background work", { term, running: info.Running, exitCode: info.ExitCode, survivors: left, backgroundLoop: bgAlive });
      }
    }

    // E9: output flood is counted and discarded beyond the capture bound.
    const t9 = Date.now();
    const e9 = await d.exec(C, ["/bin/sh", "-c", "head -c 50000000 /dev/zero; echo done >&2"], { captureBytes: PROFILE.captureBytes, timeoutMs: 60_000 });
    R.check("E9", "execution", e9.total.stdout === 50_000_000 && Buffer.byteLength(e9.stdout) === PROFILE.captureBytes && e9.exitCode === 0,
      "50 MB of output is streamed, counted, and truncated to the capture bound", { totalStdout: e9.total.stdout, kept: Buffer.byteLength(e9.stdout), ms: Date.now() - t9 });
  }

  /** Start an exec, poll inspect for exit, then allow a bounded drain before detaching. */
  async timedExec(cmd, { deadlineMs }) {
    const d = this.docker;
    const id = await d.execCreate(this.names.container, cmd);
    const start = Date.now();
    const h = d.execStart(id);
    let exitMs = null;
    let exitCode = null;
    let endedBy = null;
    let eofMs = null;
    h.done.then((how) => {
      if (how !== "destroyed") eofMs = Date.now() - start;
    });
    while (Date.now() - start < deadlineMs) {
      const info = await d.execInspect(id);
      // Running is also false before the process has started; require an exit code.
      if (!info.Running && info.ExitCode !== null && exitMs === null) {
        exitMs = Date.now() - start;
        exitCode = info.ExitCode;
        const how = await Promise.race([h.done, sleep(PROFILE.drainMs).then(() => "drain-timeout")]);
        if (how === "drain-timeout") h.destroy();
        endedBy = how === "drain-timeout" ? "drain-timeout" : "stream-eof";
        break;
      }
      await sleep(100);
    }
    if (endedBy === null) {
      h.destroy();
      endedBy = "deadline";
    }
    return { exitMs, exitCode, endedBy, eofMs, totalMs: Date.now() - start, stdoutBytes: h.output.total.stdout, stdoutHead: h.text("stdout").slice(0, 40) };
  }

  async persistenceAndCapture() {
    const R = this.rec;
    const token = randomBytes(12).toString("hex");
    this.token = token;
    await this.sh(`printf '%s' ${token} > /world/marker && sqlite3 /world/state.db "create table t(v text); insert into t values('${token}');" && sync`);
    // Hostile-looking artifacts for the capture path.
    await this.sh("ln -s /etc/passwd /world/abs-link; ln -s ../../../../etc /world/rel-link; mkfifo /world/fifo; printf x > \"$(printf '/world/esc\\033[31mname')\"; mkdir -p /world/deep/a/b/c; chmod 000 /world/deep");

    await this.removeWorld();
    const recreate = await this.startWorld(this.names.world);
    const p1 = await this.sh(`cat /world/marker; echo; sqlite3 /world/state.db 'select v from t'; pgrep -f 'date \\+%s' >/dev/null && echo bg-alive || echo bg-gone; wc -l < /world/bg.log`);
    const [marker, row, bgState] = p1.stdout.split("\n");
    R.check("P1", "persistence", recreate.code === 0 && marker === token && row === token && bgState === "bg-gone",
      "files and SQLite data survive container removal and recreation; processes do not", { marker: marker === token, sqlite: row === token, background: bgState });

    // Stop the world, then capture read-only.
    await this.docker.cli(["stop", "-t", "5", this.names.container]);
    const state = JSON.parse(await this.docker.cliOk(["inspect", this.names.container, "--format", "{{json .State}}"]));
    const before = await this.backingStat();
    await this.deviceVolume(this.names.capture, this.device, "ro,noatime,nodev,nosuid,noexec");
    const capArgs = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH",
      "--security-opt", "no-new-privileges", "--user", "0:0", ...this.label(),
      "--mount", `type=volume,src=${this.names.capture},dst=/src,readonly`, TOOLS_IMAGE];
    const roCheck = await this.docker.cli([...capArgs, "sh", "-c", "grep ' /src ' /proc/mounts; touch /src/x 2>&1; true"]);
    const dir = join(tmpdir(), `${this.prefix}-capture`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const archive = join(dir, "final.tar");
    const cap = await this.docker.runToFile([...capArgs, "tar", "-C", "/src", "--numeric-owner", "--one-file-system", "-cf", "-", "."], archive, PROFILE.archiveLimitBytes);
    const after = await this.backingStat();
    const list = await run("tar", ["-tvf", archive]);
    const entries = list.stdout.split("\n").filter(Boolean);
    R.check("C1", "capture", !state.Running && roCheck.stdout.includes(" ro,") && /Read-only file system/.test(roCheck.stdout),
      "capture mounts the stopped world's filesystem read-only (EROFS on write)", { mount: roCheck.stdout.split("\n")[0], running: state.Running });
    R.check("C2", "capture", cap.code === 0 && !cap.truncated && entries.some((e) => e.endsWith("./marker")),
      `bounded tar stream captured (${cap.bytes} bytes, ${entries.length} entries, sha256 ${cap.sha256.slice(0, 12)}…)`, { stderr: cap.stderr.trim() });
    R.check("C3", "capture", before.sha256 === after.sha256 && before.superblock["Mount count"] === after.superblock["Mount count"],
      "backing image is byte-identical before and after capture (no metadata writes)", { before: before.sha256, after: after.sha256, mountCount: [before.superblock["Mount count"], after.superblock["Mount count"]] });
    const abs = entries.find((e) => e.includes("./abs-link"));
    const fifo = entries.find((e) => e.includes("./fifo"));
    R.check("C4", "capture", abs?.startsWith("l") && abs.includes("-> /etc/passwd") && fifo?.startsWith("p") && entries.some((e) => e.includes("./deep")),
      "links are archived as links (not followed), FIFOs as FIFOs, unreadable dirs via DAC_READ_SEARCH", { abs, fifo, sample: entries.filter((e) => /esc|deep|rel-link/.test(e)) });
    R.record("C5", "capture", "info", "archive names can carry terminal control bytes; readers must escape them", { escapedName: JSON.stringify(entries.find((e) => e.includes("esc")) ?? "") });
    await this.docker.cli(["volume", "rm", this.names.capture]);
    R.fact("capture.archive", { bytes: cap.bytes, sha256: cap.sha256, entries: entries.length, listing: entries });
  }

  async failClosed() {
    const R = this.rec;
    await this.docker.cli(["rm", "-f", this.names.container]);
    const detached = await this.detach(this.names.backing);
    const f1 = await this.startWorld(this.names.world);
    R.check("F1", "storage", f1.code !== 0 && /mount/.test(f1.stderr),
      "with the loop device detached, starting the world fails instead of using an unbounded directory", { detached, stderr: f1.stderr.trim().slice(0, 300) });
    await this.docker.cli(["rm", "-f", this.names.container]);

    await this.provision(this.names.decoyBacking, this.decoyUuid, "alife-p0-decoy");
    const decoy = await this.attach(this.names.decoyBacking);
    await this.deviceVolume(this.names.stale, decoy.device, "noatime,nodev,nosuid");
    // If the decoy reused the world's loop number, the world volume itself is now stale.
    const staleVol = decoy.device === this.device ? this.names.world : this.names.stale;
    const f2 = await this.verifyIdentity(staleVol, this.worldUuid);
    R.check("F2", "storage", !f2.ok && Boolean(f2.fsid), `a stale device reference (${decoy.device} now holds a decoy image) fails the identity check`, { ...f2, volume: staleVol, decoyDevice: decoy.device, originalDevice: this.device });
    await this.docker.cli(["volume", "rm", this.names.stale]);
    await this.detach(this.names.decoyBacking);

    await this.docker.cliOk(["volume", "create", ...this.label(), "--driver", "local", "--opt", "type=ext4", "--opt", "device=/dev/alife-missing", "--opt", "o=noatime", this.names.bogus]);
    const f3 = await this.docker.cli(["run", "--rm", "--network", "none", ...this.label(), "--mount", `type=volume,src=${this.names.bogus},dst=/world`, WORLD_IMAGE, "true"]);
    R.check("F3", "storage", f3.code !== 0, "a volume naming a nonexistent device fails to mount", { stderr: f3.stderr.trim().slice(0, 200) });
    await this.docker.cli(["volume", "rm", this.names.bogus]);

    // Reattach and recreate the device volume; data must survive `volume rm`.
    await this.reattach("after detach");
  }

  async reattach(when) {
    const R = this.rec;
    const a = await this.attach(this.names.backing);
    await this.docker.cli(["rm", "-f", this.names.container]);
    const rm = await this.docker.cli(["volume", "rm", this.names.world]);
    if (rm.code !== 0) throw new Error(`volume rm failed: ${rm.stderr}`);
    this.device = a.device;
    await this.deviceVolume(this.names.world, a.device, "noatime,nodev,nosuid");
    const id = await this.verifyIdentity(this.names.world, this.worldUuid);
    const s = await this.startWorld(this.names.world);
    const m = s.code === 0 ? await this.sh("cat /world/marker") : { stdout: "" };
    const sb = await this.backingStat().catch(() => null);
    R.check(`P-${when}`, "persistence", id.ok && m.stdout === this.token,
      `${when}: reattach (${a.device}), recreate device volume, identity verified, marker intact`, { attach: a, identity: id, fsState: sb?.superblock["Filesystem state"] });
  }

  async engineRestart() {
    const R = this.rec;
    if (!this.opts.engineRestart) {
      R.record("P3", "persistence", "skip", "engine/application restart not exercised (needs --allow-engine-restart)");
      return;
    }
    const orb = (await this.docker.cliOk(["info", "--format", "{{.OperatingSystem}}"])).trim();
    if (orb !== "OrbStack") {
      R.record("P3", "persistence", "skip", `automatic restart only implemented for OrbStack (engine: ${orb})`);
      return;
    }
    const idBefore = (await this.docker.cliOk(["info", "--format", "{{.ID}}"])).trim();
    await this.sh("nohup sh -c 'while :; do date +%s >> /world/bg.log; sleep 1; done' >/dev/null 2>&1 &");
    await this.sh(`printf '%s' ${this.token}-restart > /world/marker2 && sync`);
    const stop = await run("orbctl", ["stop"], { timeoutMs: 120_000 });
    const start = await run("orbctl", ["start"], { timeoutMs: 180_000 });
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      up = (await this.docker.cli(["info", "--format", "{{.ID}}"])).code === 0;
      if (!up) await sleep(2000);
    }
    const idAfter = (await this.docker.cliOk(["info", "--format", "{{.ID}}"])).trim();
    const state = JSON.parse(await this.docker.cliOk(["inspect", this.names.container, "--format", "{{json .State}}"]));
    R.check("P3a", "persistence", !state.Running && idAfter === idBefore,
      "after OrbStack stop/start the world stays stopped (no auto-restart) and engine ID is stable", { stop: stop.code, start: start.code, state: { Status: state.Status, ExitCode: state.ExitCode }, idBefore, idAfter });
    await this.docker.cli(["rm", "-f", this.names.container]);
    const f = await this.startWorld(this.names.world);
    const identity = f.code === 0 ? null : await this.verifyIdentity(this.names.world, this.worldUuid);
    R.record("P3b", "persistence", f.code === 0 ? "warn" : "pass",
      f.code === 0 ? "world volume still mounted after restart (loop device survived); identity must still be verified" : "after restart the device volume fails closed until reattached",
      { stderr: f.stderr.trim().slice(0, 200), identity });
    const sb = await this.backingStat();
    R.record("P3c", "persistence", "info", `filesystem state after restart: ${sb.superblock["Filesystem state"]}`, { features: sb.superblock["Filesystem features"] });
    await this.reattach("after engine restart");
    const m2 = await this.sh("cat /world/marker2; pgrep -f 'date \\+%s' >/dev/null && echo ' bg-alive' || echo ' bg-gone'");
    R.check("P3d", "persistence", m2.stdout.startsWith(`${this.token}-restart`) && m2.stdout.includes("bg-gone"),
      "data written before the restart persists; processes do not", { out: m2.stdout.trim() });
  }

  async cleanup() {
    const L = `label=${LABEL}=${this.runId}`;
    const containers = (await this.docker.cli(["ps", "-aq", "--filter", L])).stdout.split("\n").filter(Boolean);
    if (containers.length) await this.docker.cli(["rm", "-f", ...containers]);
    const volumes = (await this.docker.cli(["volume", "ls", "-q", "--filter", L])).stdout.split("\n").filter(Boolean);
    // Device volumes first, then detach loops, then backing volumes.
    const backing = volumes.filter((v) => v.endsWith("-backing"));
    const others = volumes.filter((v) => !v.endsWith("-backing"));
    if (others.length) await this.docker.cli(["volume", "rm", ...others]);
    for (const b of backing) {
      if (this.opts.privileged) await this.detach(b).catch((e) => console.error(`detach ${b}: ${e.message}`));
      else console.error(`not detaching loop devices for ${b} (no --allow-privileged-helper); volume kept`);
    }
    if (this.opts.privileged && backing.length) await this.docker.cli(["volume", "rm", ...backing]);
    rmSync(join(tmpdir(), `${this.prefix}-capture`), { recursive: true, force: true });
    console.log(`cleanup ${this.runId}: ${containers.length} containers, ${volumes.length} volumes`);
  }

  async main() {
    const started = new Date().toISOString();
    if (this.opts.cleanup) {
      await this.docker.resolve();
      await this.cleanup();
      return;
    }
    let error = null;
    try {
      await this.docker.resolve();
      await this.buildImages();
      await this.discover();
      if (!this.opts.privileged) {
        this.rec.record("S*", "storage", "skip", "loop-ext4 backend requires --allow-privileged-helper; storage, isolation, execution, capture not exercised");
      } else {
        await this.storageSetup();
        await this.isolation();
        await this.storageEnforcement();
        await this.execution();
        await this.persistenceAndCapture();
        await this.failClosed();
        await this.engineRestart();
      }
    } catch (e) {
      error = e.stack ?? String(e);
      console.error(error);
      this.rec.record("X", "harness", "fail", `probe aborted: ${e.message}`);
    } finally {
      if (!this.opts.keep) await this.cleanup().catch((e) => console.error(`cleanup failed: ${e.message}`));
    }
    mkdirSync(this.opts.out, { recursive: true });
    const file = join(this.opts.out, `${this.runId}.json`);
    const report = {
      schema: "alife.phase0.probe/1",
      runId: this.runId,
      started,
      finished: new Date().toISOString(),
      host: { platform: process.platform, arch: process.arch, node: process.version },
      flags: { privilegedHelper: this.opts.privileged, engineRestart: this.opts.engineRestart },
      profile: PROFILE,
      facts: this.rec.facts,
      results: this.rec.results,
      summary: this.rec.summary(),
      error,
    };
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${JSON.stringify(report.summary)} → ${file.replace(homedir(), "~")}`);
    process.exitCode = error || this.rec.results.some((r) => r.status === "fail") ? 1 : 0;
  }
}

function parseDumpe2fs(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z][A-Za-z /#_-]*):\s+(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

new Probe(parseArgs(process.argv.slice(2))).main();
