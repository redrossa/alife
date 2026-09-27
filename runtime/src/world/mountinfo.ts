// Parser for one line of /proc/<pid>/mountinfo (proc(5)):
//   36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue

export interface MountInfo {
  readonly mountPoint: string;
  /** Per-mount options, such as `rw,nosuid,nodev,noatime`. */
  readonly options: readonly string[];
  readonly fsType: string;
  readonly source: string;
  /** Superblock options, such as `rw,norecovery` or `size=16384k`. */
  readonly superOptions: readonly string[];
}

/** The kernel escapes space, tab, newline, and backslash in paths as octal. */
function unescape(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

export function parseMountInfoLine(line: string): MountInfo | null {
  const fields = line.trim().split(" ");
  const separator = fields.indexOf("-", 6);
  if (separator === -1) return null;
  const fsType = fields[separator + 1];
  const source = fields[separator + 2];
  const superOptions = fields[separator + 3];
  if (fsType === undefined || source === undefined || superOptions === undefined) return null;
  return {
    mountPoint: unescape(fields[4]!),
    options: fields[5]!.split(","),
    fsType,
    source: unescape(source),
    superOptions: superOptions.split(","),
  };
}

export function findMount(mountinfo: string, mountPoint: string): MountInfo | null {
  let found: MountInfo | null = null;
  for (const line of mountinfo.split("\n")) {
    const mount = parseMountInfoLine(line);
    // The last matching entry is the visible one when mounts are stacked.
    if (mount !== null && mount.mountPoint === mountPoint) found = mount;
  }
  return found;
}
