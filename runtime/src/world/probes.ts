import { z } from "zod";

import type { ListingEntry, Metric, StorageMetrics } from "../core/contracts.ts";
import { findMount } from "./mountinfo.ts";

// Fixed harness readings taken inside a running world. They run as the world
// user with the image's own Python (read-only root), before any agent action
// for verification and between actions for sensors. Their output is parsed
// strictly; anything unexpected is a failed reading, not a default.

/** Facts about the effective world profile, gathered before the first action. */
export const STARTUP_SCRIPT = `import ctypes, json, os, secrets
def table(path):
    out = {}
    for line in open(path):
        key, _, value = line.partition(":")
        out[key] = value.strip()
    return out
def limits():
    return [[line[:26].strip(), line[26:].split()[:2]] for line in list(open("/proc/self/limits"))[1:]]
status = table("/proc/self/status")
facts = {
    "uid": os.getuid(), "euid": os.geteuid(), "gid": os.getgid(), "egid": os.getegid(),
    "groups": sorted(os.getgroups()),
    "caps": [status.get(k) for k in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")],
    "noNewPrivs": status.get("NoNewPrivs"), "seccomp": status.get("Seccomp"),
    "limits": limits(),
    "mountinfo": open("/proc/self/mountinfo").read(),
    "worldFsid": format(os.statvfs("/world").f_fsid, "x"),
    "worldWritable": os.access("/world", os.W_OK),
    "worldOwner": [os.stat("/world").st_uid, os.stat("/world").st_gid],
    "net": sorted(os.listdir("/sys/class/net")),
    "sockets": [p for p in ("/var/run/docker.sock", "/run/docker.sock", "/run/containerd/containerd.sock") if os.path.exists(p)],
    "pid1": open("/proc/1/cmdline", "rb").read().split(b"\\0")[0].decode("utf-8", "replace"),
    # The environment the execution received; Python's locale coercion may add LC_CTYPE to os.environ.
    "cgroup": [open("/sys/fs/cgroup/" + n).read().strip() for n in ("memory.max", "memory.swap.max", "cpu.max", "pids.max")],
    "env": sorted(e.split(b"=", 1)[0].decode("utf-8", "replace") for e in open("/proc/self/environ", "rb").read().split(b"\\0") if e),
}
libc = ctypes.CDLL(None, use_errno=True)
libc.mq_open.restype = ctypes.c_int
libc.mq_open.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
libc.mq_unlink.argtypes = [ctypes.c_char_p]
class Attr(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_long), ("maxmsg", ctypes.c_long), ("msgsize", ctypes.c_long), ("curmsgs", ctypes.c_long), ("pad", ctypes.c_long * 4)]
name = ("/alife-verify-" + secrets.token_hex(8)).encode()
fd = libc.mq_open(name, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600, ctypes.byref(Attr(0, 1, 1, 0)))
if fd >= 0:
    os.close(fd)
    libc.mq_unlink(name)
    facts["mqueue"] = {"created": True, "errno": 0}
else:
    facts["mqueue"] = {"created": False, "errno": ctypes.get_errno()}
facts["mqueueEntries"] = len(os.listdir("/dev/mqueue"))
print(json.dumps(facts))
`;

const startupSchema = z.strictObject({
  uid: z.int(),
  euid: z.int(),
  gid: z.int(),
  egid: z.int(),
  groups: z.array(z.int()),
  caps: z.array(z.string().nullable()),
  noNewPrivs: z.string().nullable(),
  seccomp: z.string().nullable(),
  limits: z.array(z.tuple([z.string(), z.array(z.string())])),
  mountinfo: z.string(),
  worldFsid: z.string(),
  worldWritable: z.boolean(),
  worldOwner: z.tuple([z.int(), z.int()]),
  net: z.array(z.string()),
  sockets: z.array(z.string()),
  pid1: z.string(),
  cgroup: z.tuple([z.string(), z.string(), z.string(), z.string()]),
  env: z.array(z.string()),
  mqueue: z.strictObject({ created: z.boolean(), errno: z.int() }),
  mqueueEntries: z.int(),
});

export type StartupFacts = z.infer<typeof startupSchema>;

export interface StartupExpectation {
  readonly uid: number;
  readonly gid: number;
  readonly device: string;
  readonly fsid: string;
  readonly tmpMiB: number;
  readonly shmMiB: number;
  readonly fileDescriptors: number;
  readonly memoryMiB: number;
  readonly swapMiB: number;
  readonly cpus: number;
  readonly pids: number;
}

export function parseStartupFacts(text: string): StartupFacts {
  return startupSchema.parse(JSON.parse(text));
}

function includesAll(actual: readonly string[], required: readonly string[]): boolean {
  return required.every((option) => actual.includes(option));
}

/** Every way the effective world differs from the declared profile. Empty means verified. */
export function startupViolations(facts: StartupFacts, expected: StartupExpectation): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  expect(
    facts.uid === expected.uid && facts.euid === expected.uid && facts.gid === expected.gid && facts.egid === expected.gid,
    `runs as ${facts.uid}:${facts.gid}, not ${expected.uid}:${expected.gid}`,
  );
  expect(facts.groups.every((group) => group === expected.gid), `has supplementary groups ${facts.groups.join(",")}`);
  expect(facts.caps.every((mask) => mask !== null && /^0+$/.test(mask)), `has capabilities ${facts.caps.join(" ")}`);
  expect(facts.noNewPrivs === "1", "no-new-privileges is not set");
  expect(facts.seccomp === "2", `seccomp mode is ${facts.seccomp ?? "unknown"}, not filtering`);

  const limit = (name: string) => facts.limits.find(([key]) => key === name)?.[1] ?? [];
  const files = String(expected.fileDescriptors);
  expect(limit("Max open files").join(" ") === `${files} ${files}`, `open-file limit is ${limit("Max open files").join(" ")}`);
  expect(limit("Max msgqueue size").join(" ") === "0 0", `message queue limit is ${limit("Max msgqueue size").join(" ")}`);
  expect(!facts.mqueue.created, "a POSIX message queue could be created");
  expect(facts.mqueueEntries === 0, `${facts.mqueueEntries} message queues exist`);

  const root = findMount(facts.mountinfo, "/");
  expect(root !== null && root.options.includes("ro"), "the root filesystem is not read-only");
  const world = findMount(facts.mountinfo, "/world");
  if (world === null) {
    problems.push("/world is not a mount");
  } else {
    expect(world.fsType === "ext4" && world.source === expected.device, `/world is ${world.fsType} from ${world.source}, not ext4 from ${expected.device}`);
    expect(includesAll(world.options, ["rw", "nosuid", "nodev", "noatime"]), `/world mount options are ${world.options.join(",")}`);
  }
  expect(facts.worldFsid === expected.fsid, `/world has filesystem ID ${facts.worldFsid}, not ${expected.fsid}`);
  expect(facts.worldWritable, "/world is not writable by the world user");
  expect(facts.worldOwner[0] === expected.uid && facts.worldOwner[1] === expected.gid, `/world is owned by ${facts.worldOwner.join(":")}`);

  for (const [point, mib] of [
    ["/tmp", expected.tmpMiB],
    ["/dev/shm", expected.shmMiB],
  ] as const) {
    const mount = findMount(facts.mountinfo, point);
    expect(
      mount !== null && mount.fsType === "tmpfs" && mount.superOptions.includes(`size=${mib * 1024}k`) && includesAll(mount.options, ["nosuid", "nodev"]),
      `${point} is not a nosuid,nodev tmpfs of ${mib} MiB`,
    );
  }
  // The world's own cgroup, as the kernel enforces it (cgroup v2, private namespace).
  const [memoryMax, swapMax, cpuMax, pidsMax] = facts.cgroup;
  expect(memoryMax === String(expected.memoryMiB * 1024 * 1024), `memory.max is ${memoryMax}`);
  expect(swapMax === String(expected.swapMiB * 1024 * 1024), `memory.swap.max is ${swapMax}`);
  expect(cpuMax === `${Math.round(expected.cpus * 100_000)} 100000`, `cpu.max is ${cpuMax}`);
  expect(pidsMax === String(expected.pids), `pids.max is ${pidsMax}`);
  expect(facts.net.length === 1 && facts.net[0] === "lo", `network interfaces are ${facts.net.join(",")}`);
  expect(facts.sockets.length === 0, `control sockets are visible: ${facts.sockets.join(", ")}`);
  expect(facts.pid1 === "/usr/bin/tini", `PID 1 is ${facts.pid1}, not tini`);
  expect(facts.env.join(",") === "HOME,HOSTNAME,PATH", `environment has ${facts.env.join(",")}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Sensor readings. The run loop no longer requests the listing (`baseline-sensors-v4`);
// it remains available to operator and diagnostic callers.

/** At most this many /world entries are listed, byte-ordered. */
export const LISTING_LIMIT = 64;
/** Entries read before giving up on counting; more means the listing is truncated. */
const LISTING_SCAN_LIMIT = 4096;

export const SENSOR_SCRIPT = `import base64, json, os, stat, sys
want_listing, limit, scan = sys.argv[1] == "1", int(sys.argv[2]), int(sys.argv[3])
out = {"storage": None, "storageError": None, "listing": None, "listingError": None}
try:
    s = os.statvfs("/world")
    out["storage"] = [s.f_frsize, s.f_blocks, s.f_bavail, s.f_files, s.f_favail]
except OSError as e:
    out["storageError"] = e.strerror or type(e).__name__
if want_listing:
    try:
        seen, more = [], False
        with os.scandir(b"/world") as it:
            for entry in it:
                if len(seen) >= scan:
                    more = True
                    break
                seen.append(entry)
        seen.sort(key=lambda e: e.name)
        entries = []
        for entry in seen[:limit]:
            try:
                st = os.lstat(entry.path)
                kind = "directory" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "symlink" if stat.S_ISLNK(st.st_mode) else "other"
                size = st.st_size if kind == "file" else None
            except OSError:
                kind, size = "other", None
            entries.append([base64.b64encode(entry.name).decode(), kind, size])
        out["listing"] = {"entries": entries, "truncated": more or len(seen) > limit}
    except OSError as e:
        out["listingError"] = e.strerror or type(e).__name__
print(json.dumps(out))
`;

const sensorSchema = z.strictObject({
  storage: z.tuple([z.int(), z.int(), z.int(), z.int(), z.int()]).nullable(),
  storageError: z.string().nullable(),
  listing: z
    .strictObject({
      entries: z.array(z.tuple([z.base64(), z.enum(["file", "directory", "symlink", "other"]), z.int().nullable()])),
      truncated: z.boolean(),
    })
    .nullable(),
  listingError: z.string().nullable(),
});

export function sensorArguments(listing: boolean): readonly string[] {
  return [listing ? "1" : "0", String(LISTING_LIMIT), String(LISTING_SCAN_LIMIT)];
}

export interface SensorReading {
  readonly storage: Metric<StorageMetrics>;
  readonly listing: Metric<{ readonly entries: readonly ListingEntry[]; readonly truncated: boolean }> | null;
}

// ignoreBOM keeps a leading U+FEFF, which is part of a file name, not an encoding mark.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeName(bytes: Buffer): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

export function parseSensorReading(text: string, listingRequested: boolean): SensorReading {
  const reading = sensorSchema.parse(JSON.parse(text));
  const storage: Metric<StorageMetrics> =
    reading.storage === null
      ? { available: false, reason: `statvfs failed: ${reading.storageError ?? "unknown"}` }
      : {
          available: true,
          value: {
            totalBytes: reading.storage[0] * reading.storage[1],
            availableBytes: reading.storage[0] * reading.storage[2],
            totalInodes: reading.storage[3],
            availableInodes: reading.storage[4],
          },
        };
  if (!listingRequested) return { storage, listing: null };
  if (reading.listing === null) {
    return { storage, listing: { available: false, reason: `listing failed: ${reading.listingError ?? "unknown"}` } };
  }
  const entries = reading.listing.entries.map(([nameBase64, type, sizeBytes]): ListingEntry => ({
    nameBase64,
    name: decodeName(Buffer.from(nameBase64, "base64")),
    type,
    sizeBytes,
  }));
  return { storage, listing: { available: true, value: { entries, truncated: reading.listing.truncated } } };
}
