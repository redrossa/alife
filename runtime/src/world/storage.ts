import type { WorldId } from "../core/ids.ts";
import { EngineResponseError, type DockerEngine } from "./engine.ts";
import { parseMountInfoLine, type MountInfo } from "./mountinfo.ts";
import {
  containersUsingVolume,
  createVolume,
  expectVolume,
  inspectVolume,
  removeVolume,
  ResourceIdentityError,
  runHelper,
  type HelperResult,
  type HelperSpec,
  type WorldResourceNames,
} from "./resources.ts";
import type { Seed } from "./seeds.ts";

// Storage profile `loop-ext4-volume-v1` (plan §7.3, Phase 0 Decision 1): a
// fixed-size ext4 image in a Docker volume, attached to a loop device by an
// explicitly authorized privileged helper and mounted through the local
// volume driver. The agent's container never sees the backing image, the loop
// device, or Docker. Nothing here reformats, resizes, reseeds, or repairs an
// existing filesystem, and any doubt about identity fails closed.

export const BLOCK_SIZE = 4096;
export const JOURNAL_MIB = 4;
export const WORLD_MOUNT_OPTIONS = "noatime,nodev,nosuid";
export const READONLY_MOUNT_OPTIONS = "ro,norecovery,noatime,nodev,nosuid,noexec";

const LOOP_DEVICE = /^\/dev\/loop[0-9]{1,5}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HELPER_MEMORY = 128 << 20;

export class PrivilegeRequiredError extends Error {
  constructor(action: string, reason: string) {
    super(`${action} needs the privileged storage helper (${reason}); rerun with explicit authorization (--allow-privileged-helper)`);
    this.name = "PrivilegeRequiredError";
  }
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export interface Superblock {
  readonly uuid: string;
  readonly label: string;
  /** `clean`, or anything else the filesystem reports. */
  readonly state: string;
  readonly features: readonly string[];
  readonly blockSize: number;
  readonly blockCount: number;
  readonly freeBlocks: number;
  readonly inodeCount: number;
  readonly freeInodes: number;
  readonly mountCount: number;
  readonly lastWriteTime: string;
}

/** A filesystem that may need journal recovery or checking is not clean. */
export function isClean(superblock: Superblock): boolean {
  return superblock.state === "clean" && !superblock.features.includes("needs_recovery");
}

/** Parses `dumpe2fs -h` output. Missing or malformed fields are errors, not defaults. */
export function parseSuperblock(text: string): Superblock {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z][A-Za-z /#_-]*):\s*(.*)$/.exec(line);
    if (match && !fields.has(match[1]!)) fields.set(match[1]!, match[2]!.trim());
  }
  const text_ = (key: string): string => {
    const value = fields.get(key);
    if (value === undefined) throw new StorageError(`superblock has no "${key}" field`);
    return value;
  };
  const count = (key: string): number => {
    const value = text_(key);
    if (!/^[0-9]+$/.test(value)) throw new StorageError(`superblock field "${key}" is not a count: ${JSON.stringify(value)}`);
    return Number(value);
  };
  const label = text_("Filesystem volume name");
  return {
    uuid: text_("Filesystem UUID"),
    label: label === "<none>" ? "" : label,
    state: text_("Filesystem state"),
    features: text_("Filesystem features").split(/\s+/).filter((feature) => feature.length > 0),
    blockSize: count("Block size"),
    blockCount: count("Block count"),
    freeBlocks: count("Free blocks"),
    inodeCount: count("Inode count"),
    freeInodes: count("Free inodes"),
    mountCount: count("Mount count"),
    lastWriteTime: text_("Last write time"),
  };
}

/**
 * The statfs filesystem ID ext4 reports for a UUID, as `os.statvfs().f_fsid`
 * returns it on 64-bit Linux: the two little-endian 64-bit halves XORed.
 */
export function ext4Fsid(uuid: string): string {
  if (!UUID.test(uuid)) throw new RangeError(`invalid UUID ${JSON.stringify(uuid)}`);
  const bytes = Buffer.from(uuid.replace(/-/g, ""), "hex");
  return (bytes.readBigUInt64LE(0) ^ bytes.readBigUInt64LE(8)).toString(16);
}

export interface StorageIdentityCheck {
  readonly ok: boolean;
  readonly device: string;
  readonly reason: string | null;
  readonly fsid: string | null;
  readonly mount: MountInfo | null;
}

export interface AttachResult {
  readonly device: string;
  /** False when the existing attachment already verified. */
  readonly attached: boolean;
}

export interface DetachResult {
  readonly detached: readonly string[];
  /** Devices still bound to the image, e.g. because a mount keeps them busy. */
  readonly remaining: readonly string[];
}

export type HelperRecorder = (
  phase: "starting" | "finished",
  details: Readonly<Record<string, unknown>>,
  privileged: boolean,
) => Promise<void>;

export interface StorageOptions {
  readonly worldId: WorldId;
  readonly names: WorldResourceNames;
  readonly helperImage: string;
  /** Image with Python, used unprivileged to read the mounted filesystem ID. */
  readonly worldImage: string;
  readonly uid: number;
  readonly gid: number;
  readonly uuid: string;
  /** Explicit operator authorization for the privileged helper; never assumed. */
  readonly allowPrivilegedHelper: boolean;
  readonly recordHelper: HelperRecorder;
}

const PROVISION_SCRIPT = `set -eu
f=/backing/world.ext4
if [ -e "$f" ]; then echo "backing image already exists; refusing to overwrite it" >&2; exit 3; fi
available=$(df -Pk /backing | awk 'NR == 2 { print $4 }')
needed=$(( ($1 + $5) * 1024 ))
if [ "$available" -lt "$needed" ]; then echo "volume filesystem has $available KiB available; $needed KiB needed" >&2; exit 4; fi
tar -x -f - -C /seed --no-same-owner
chown -R "$6:$7" /seed
printf 'SEEDENTRIES=%s\n' "$(find /seed -mindepth 1 | wc -l)"
(cd /seed && find . -type f -exec sha256sum {} +) | sed 's/^/SEEDFILE=/'
truncate -s "$1M" "$f"
mkfs.ext4 -q -F -b ${BLOCK_SIZE} -N "$2" -m 0 -J size=${JOURNAL_MIB} -U "$3" -L "$4" -E "root_owner=$6:$7,lazy_itable_init=0,lazy_journal_init=0" -d /seed "$f"
dumpe2fs -h "$f" 2>/dev/null
`;

const SUPERBLOCK_SCRIPT = `set -eu
dumpe2fs -h /backing/world.ext4 2>/dev/null
`;

const ATTACH_SCRIPT = `set -eu
f=/backing/world.ext4
[ -f "$f" ] || { echo "backing image is missing" >&2; exit 3; }
devices=$(losetup -j "$f" -n -O NAME)
count=$(printf '%s\\n' "$devices" | grep -c . || true)
if [ "$count" -gt 1 ]; then echo "backing image is bound to several loop devices:" $devices >&2; exit 5; fi
if [ "$count" -eq 0 ]; then devices=$(losetup --find --show --nooverlap "$f"); fi
printf 'DEVICE=%s\\n' "$devices"
blkid -p -o export "$devices"
`;

const DETACH_SCRIPT = `set -eu
f=/backing/world.ext4
for d in $(losetup -j "$f" -n -O NAME); do losetup -d "$d"; printf 'DETACHED=%s\\n' "$d"; done
printf 'REMAINING=%s\\n' "$(losetup -j "$f" -n -O NAME | tr '\\n' ' ')"
`;

// Refuses (without output, which would corrupt the archive) unless /src is
// ext4 whose superblock itself is mounted ro,norecovery, not merely a
// read-only bind of a writable mount.
const CAPTURE_SCRIPT = `set -eu
awk '$5 == "/src" { for (i = 7; i < NF && $i != "-"; i++) ; if ($(i + 1) == "ext4" && $6 ~ /(^|,)ro(,|$)/ && $(i + 3) ~ /(^|,)ro(,|$)/ && $(i + 3) ~ /(^|,)norecovery(,|$)/) found = 1 } END { exit !found }' /proc/self/mountinfo
exec tar -C /src --numeric-owner --one-file-system --format=gnu -cf - .
`;

const IDENTITY_SCRIPT = `import json, os
s = os.statvfs("/world")
line = next((l for l in open("/proc/self/mountinfo") if l.split(" ")[4] == "/world"), None)
print(json.dumps({"fsid": format(s.f_fsid, "x"), "mountinfo": line}))
`;

/** The seed as extracted in the helper, before mkfs copies it, must be exactly the manifest. */
function checkExtractedSeed(seed: Seed, output: string): void {
  const lines = output.split("\n");
  const count = lines.find((line) => line.startsWith("SEEDENTRIES="))?.slice("SEEDENTRIES=".length).trim();
  const files = lines
    .filter((line) => line.startsWith("SEEDFILE="))
    .map((line) => {
      const match = /^SEEDFILE=([a-f0-9]{64}) {2}\.\/(.+)$/.exec(line);
      if (match === null) throw new StorageError(`unexpected seed check line ${JSON.stringify(line)}`);
      return `${match[2]} ${match[1]}`;
    })
    .sort();
  const expected = seed.entries
    .flatMap((entry) => (entry.type === "file" ? [`${entry.path} ${entry.sha256}`] : []))
    .sort();
  if (count !== String(seed.entries.length) || files.join("\n") !== expected.join("\n")) {
    throw new StorageError(`the extracted seed ${seed.id} does not match its manifest; provisioning is rejected and the world is not usable`);
  }
}

function keyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const equals = line.indexOf("=");
    if (equals > 0) values.set(line.slice(0, equals), line.slice(equals + 1).trim());
  }
  return values;
}

function helperFailure(what: string, result: HelperResult): StorageError {
  const stderr = result.stderr.toString("utf8").trim().slice(0, 1024);
  const why = result.timedOut ? "timed out" : `exited ${result.exitCode}`;
  return new StorageError(`${what} ${why}${stderr ? `: ${stderr}` : ""}`);
}

export class LoopExt4Storage {
  readonly #engine: DockerEngine;
  readonly #options: StorageOptions;

  constructor(engine: DockerEngine, options: StorageOptions) {
    this.#engine = engine;
    this.#options = options;
  }

  get expectedFsid(): string {
    return ext4Fsid(this.#options.uuid);
  }

  async #helper(spec: Omit<HelperSpec, "worldId" | "beforeStart">): Promise<HelperResult> {
    const details = { purpose: spec.purpose, image: spec.image, cmd: spec.cmd.slice(0, 1) };
    if (spec.privileged && !this.#options.allowPrivilegedHelper) {
      throw new PrivilegeRequiredError(spec.purpose, "the operator has not authorized it for this command");
    }
    const result = await runHelper(this.#engine, {
      ...spec,
      worldId: this.#options.worldId,
      // The invocation is recorded durably before the helper can act.
      beforeStart: (container) => this.#options.recordHelper("starting", { ...details, container }, spec.privileged),
    });
    await this.#options.recordHelper(
      "finished",
      { ...details, container: { id: result.containerId, name: result.name }, exitCode: result.exitCode, timedOut: result.timedOut },
      spec.privileged,
    );
    return result;
  }

  /**
   * Creates the backing volume and a new filesystem seeded with `seed`. Only
   * for a new world: an existing volume or image is never touched.
   */
  async provision(parameters: {
    readonly capacityMiB: number;
    readonly inodes: number;
    readonly label: string;
    readonly seed: Seed;
    readonly minimumFreeMiB: number;
  }): Promise<Superblock> {
    const { names, uid, gid, uuid } = this.#options;
    await createVolume(this.#engine, names.backingVolume, this.#options.worldId, "backing");
    const seedMiB = Math.ceil((parameters.seed.bytes * 2 + (1 << 20)) / (1 << 20));
    const result = await this.#helper({
      purpose: "provision",
      image: this.#options.helperImage,
      privileged: false,
      // Only to give the extracted seed to the world user; no other capability.
      capAdd: ["CHOWN"],
      user: "0:0",
      mounts: [{ volume: names.backingVolume, target: "/backing", readOnly: false }],
      tmpfs: { "/seed": `rw,nosuid,nodev,noexec,size=${seedMiB}m,mode=0755` },
      cmd: [
        "/bin/sh",
        "-c",
        PROVISION_SCRIPT,
        "provision",
        String(parameters.capacityMiB),
        String(parameters.inodes),
        uuid,
        parameters.label,
        String(parameters.minimumFreeMiB),
        String(uid),
        String(gid),
      ],
      stdin: parameters.seed.archive,
      stdoutLimit: 64 << 10,
      stderrLimit: 16 << 10,
      timeoutMs: 600_000,
      memoryBytes: HELPER_MEMORY + seedMiB * (1 << 20),
      pids: 32,
    });
    if (result.exitCode !== 0) throw helperFailure("provisioning", result);
    const output = result.stdout.toString("utf8");
    checkExtractedSeed(parameters.seed, output);
    const superblock = parseSuperblock(output);
    if (superblock.uuid !== uuid) throw new StorageError(`new filesystem has UUID ${superblock.uuid}, not ${uuid}`);
    if (!isClean(superblock)) throw new StorageError(`new filesystem is not clean (${superblock.state})`);
    return superblock;
  }

  /** Reads the backing image's superblock without mounting it. */
  async superblock(): Promise<Superblock> {
    const result = await this.#helper({
      purpose: "superblock",
      image: this.#options.helperImage,
      privileged: false,
      capAdd: [],
      user: "0:0",
      mounts: [{ volume: this.#options.names.backingVolume, target: "/backing", readOnly: true }],
      cmd: ["/bin/sh", "-c", SUPERBLOCK_SCRIPT],
      stdoutLimit: 64 << 10,
      stderrLimit: 16 << 10,
      timeoutMs: 60_000,
      memoryBytes: HELPER_MEMORY,
      pids: 16,
    });
    if (result.exitCode !== 0) throw helperFailure("reading the superblock", result);
    const superblock = parseSuperblock(result.stdout.toString("utf8"));
    if (superblock.uuid !== this.#options.uuid) {
      throw new StorageError(`backing image has UUID ${superblock.uuid}, not the recorded ${this.#options.uuid}`);
    }
    return superblock;
  }

  /** Privileged: binds the image to a loop device (reusing an existing binding) and checks its UUID and type. */
  async #attachDevice(): Promise<string> {
    const result = await this.#helper({
      purpose: "attach",
      image: this.#options.helperImage,
      privileged: true,
      capAdd: [],
      user: "0:0",
      mounts: [{ volume: this.#options.names.backingVolume, target: "/backing", readOnly: false }],
      cmd: ["/bin/sh", "-c", ATTACH_SCRIPT],
      stdoutLimit: 16 << 10,
      stderrLimit: 16 << 10,
      timeoutMs: 60_000,
      memoryBytes: HELPER_MEMORY,
      pids: 16,
    });
    if (result.exitCode !== 0) throw helperFailure("attaching the loop device", result);
    const values = keyValues(result.stdout.toString("utf8"));
    const device = values.get("DEVICE") ?? "";
    if (!LOOP_DEVICE.test(device)) throw new StorageError(`attach reported an unexpected device ${JSON.stringify(device)}`);
    if (values.get("UUID") !== this.#options.uuid || values.get("TYPE") !== "ext4") {
      throw new StorageError(`${device} holds ${values.get("TYPE") ?? "no"} filesystem ${values.get("UUID") ?? "(no UUID)"}, not ext4 ${this.#options.uuid}`);
    }
    return device;
  }

  /** Privileged: unbinds every loop device backed by this image and reports any that remain. */
  async detach(): Promise<DetachResult> {
    const result = await this.#helper({
      purpose: "detach",
      image: this.#options.helperImage,
      privileged: true,
      capAdd: [],
      user: "0:0",
      mounts: [{ volume: this.#options.names.backingVolume, target: "/backing", readOnly: true }],
      cmd: ["/bin/sh", "-c", DETACH_SCRIPT],
      stdoutLimit: 16 << 10,
      stderrLimit: 16 << 10,
      timeoutMs: 60_000,
      memoryBytes: HELPER_MEMORY,
      pids: 16,
    });
    if (result.exitCode !== 0) throw helperFailure("detaching the loop device", result);
    const lines = result.stdout.toString("utf8").split("\n");
    const detached = lines.filter((line) => line.startsWith("DETACHED=")).map((line) => line.slice("DETACHED=".length));
    const remaining = (lines.find((line) => line.startsWith("REMAINING=")) ?? "REMAINING=")
      .slice("REMAINING=".length)
      .split(/\s+/)
      .filter((device) => device.length > 0);
    return { detached, remaining };
  }

  /** The device the world volume currently names, after checking the volume is this world's. */
  async recordedDevice(): Promise<string | null> {
    const volume = await inspectVolume(this.#engine, this.#options.names.deviceVolume);
    if (volume === null) return null;
    expectVolume(volume, this.#options.worldId, "device");
    const device = volume.options.device ?? "";
    if (!LOOP_DEVICE.test(device) || volume.options.type !== "ext4" || volume.options.o !== WORLD_MOUNT_OPTIONS) {
      throw new ResourceIdentityError(`volume ${volume.name} has unexpected options ${JSON.stringify(volume.options)}`);
    }
    return device;
  }

  /**
   * Unprivileged check that `device` holds this world's filesystem: mounts it
   * read-only without journal recovery and compares the statfs ID. The world
   * must not be running, since a second mount of a live filesystem is not a
   * trustworthy view.
   */
  async verifyIdentity(device: string): Promise<StorageIdentityCheck> {
    const fail = (reason: string, fsid: string | null = null, mount: MountInfo | null = null): StorageIdentityCheck => ({
      ok: false,
      device,
      reason,
      fsid,
      mount,
    });
    await this.#createReadonlyVolume(device);
    try {
      let result: HelperResult;
      try {
        result = await this.#helper({
          purpose: "identity",
          image: this.#options.worldImage,
          privileged: false,
          capAdd: [],
          user: `${this.#options.uid}:${this.#options.gid}`,
          mounts: [{ volume: this.#options.names.readonlyVolume, target: "/world", readOnly: true }],
          cmd: ["python3", "-I", "-c", IDENTITY_SCRIPT],
          stdoutLimit: 16 << 10,
          stderrLimit: 16 << 10,
          timeoutMs: 60_000,
          memoryBytes: HELPER_MEMORY,
          pids: 16,
        });
      } catch (error) {
        // The engine refuses to start a container whose volume cannot be mounted.
        if (error instanceof EngineResponseError) return fail(`${device} could not be mounted: ${error.message}`);
        throw error;
      }
      if (result.exitCode !== 0) return fail(`identity reader ${helperFailure("", result).message.trim()}`);
      const reading = JSON.parse(result.stdout.toString("utf8")) as { fsid?: unknown; mountinfo?: unknown };
      const fsid = typeof reading.fsid === "string" ? reading.fsid : null;
      const mount = typeof reading.mountinfo === "string" ? parseMountInfoLine(reading.mountinfo) : null;
      if (mount === null) return fail("the read-only mount did not appear at /world", fsid);
      if (mount.fsType !== "ext4" || mount.source !== device) {
        return fail(`/world is ${mount.fsType} from ${mount.source}, not ext4 from ${device}`, fsid, mount);
      }
      if (!mount.superOptions.includes("ro") || !mount.superOptions.includes("norecovery")) {
        return fail(`the identity mount of ${device} is not ro,norecovery (${mount.superOptions.join(",")})`, fsid, mount);
      }
      if (fsid !== this.expectedFsid) {
        return fail(`${device} holds filesystem ID ${fsid}, not this world's ${this.expectedFsid}`, fsid, mount);
      }
      return { ok: true, device, reason: null, fsid, mount };
    } finally {
      await removeVolume(this.#engine, this.#options.names.readonlyVolume, this.#options.worldId, "readonly");
    }
  }

  /** Creates the read-only volume for `device`, replacing an unused stale one of this world. */
  async #createReadonlyVolume(device: string): Promise<void> {
    const { names, worldId } = this.#options;
    await removeVolume(this.#engine, names.readonlyVolume, worldId, "readonly");
    const expected = { type: "ext4", device, o: READONLY_MOUNT_OPTIONS };
    const created = await createVolume(this.#engine, names.readonlyVolume, worldId, "readonly", expected);
    const options = created.options;
    if (Object.keys(options).length !== 3 || options.type !== expected.type || options.device !== device || options.o !== expected.o) {
      throw new ResourceIdentityError(`volume ${created.name} has options ${JSON.stringify(created.options)}, not ${JSON.stringify(expected)}`);
    }
  }

  /**
   * `tar-capture-v1`: streams a GNU tar of the stopped world's filesystem,
   * mounted read-only without journal recovery, from a helper holding only
   * CAP_DAC_READ_SEARCH. The helper first confirms its view is a read-only
   * ext4 mount. `sink` receives the archive and can stop it early.
   */
  async streamArchive(device: string, sink: (chunk: Buffer) => boolean, timeoutMs: number): Promise<HelperResult> {
    await this.#createReadonlyVolume(device);
    try {
      return await this.#helper({
        purpose: "capture",
        image: this.#options.helperImage,
        privileged: false,
        capAdd: ["DAC_READ_SEARCH"],
        user: "0:0",
        mounts: [{ volume: this.#options.names.readonlyVolume, target: "/src", readOnly: true }],
        cmd: ["/bin/sh", "-c", CAPTURE_SCRIPT],
        stdoutSink: sink,
        stdoutLimit: 0,
        stderrLimit: 16 << 10,
        timeoutMs,
        memoryBytes: HELPER_MEMORY,
        pids: 16,
      });
    } finally {
      await removeVolume(this.#engine, this.#options.names.readonlyVolume, this.#options.worldId, "readonly");
    }
  }

  /**
   * Makes sure the world volume names a loop device holding this world's
   * filesystem. Reuses a verified attachment; otherwise binds the image with
   * the privileged helper (only if authorized) and replaces a stale, unused
   * world volume. Must be called while the world is stopped.
   */
  async ensureAttached(): Promise<AttachResult & { readonly check: StorageIdentityCheck }> {
    const { names, worldId } = this.#options;
    const recorded = await this.recordedDevice();
    let reason = "the world volume does not exist";
    if (recorded !== null) {
      const check = await this.verifyIdentity(recorded);
      if (check.ok) return { device: recorded, attached: false, check };
      reason = check.reason ?? "identity check failed";
    }
    if (!this.#options.allowPrivilegedHelper) throw new PrivilegeRequiredError("attaching storage", reason);

    const device = await this.#attachDevice();
    if (recorded !== device) {
      if (recorded !== null) {
        const users = await containersUsingVolume(this.#engine, names.deviceVolume);
        if (users.length > 0) {
          throw new StorageError(`world volume ${names.deviceVolume} names a stale device but is used by ${users.join(", ")}`);
        }
        await removeVolume(this.#engine, names.deviceVolume, worldId, "device");
      }
      await createVolume(this.#engine, names.deviceVolume, worldId, "device", { type: "ext4", device, o: WORLD_MOUNT_OPTIONS });
    }
    const check = await this.verifyIdentity(device);
    if (!check.ok) throw new StorageError(`after attaching, ${check.reason ?? "the identity check failed"}`);
    return { device, attached: true, check };
  }

  /** Removes this world's device and read-only volumes if unused. The attachment itself is untouched. */
  async removeDeviceVolumes(): Promise<void> {
    const { names, worldId } = this.#options;
    await removeVolume(this.#engine, names.readonlyVolume, worldId, "readonly");
    await removeVolume(this.#engine, names.deviceVolume, worldId, "device");
  }

  async removeBackingVolume(): Promise<void> {
    await removeVolume(this.#engine, this.#options.names.backingVolume, this.#options.worldId, "backing");
  }
}
