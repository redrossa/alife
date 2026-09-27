import type { StartupFacts } from "../../src/world/probes.ts";

// A startup reading from a world that matches the fixture profile (uid/gid
// 1000, /world on /dev/loop0, 16 MiB /tmp, 8 MiB /dev/shm, 256 descriptors,
// 256 MiB memory, no swap, half a CPU, 64 PIDs).

export const MOUNTINFO = [
  "700 600 0:80 / / ro,relatime - overlay overlay rw,lowerdir=/x",
  "701 700 7:0 / /world rw,nosuid,nodev,noatime master:36 - ext4 /dev/loop0 rw",
  "702 700 0:81 / /tmp rw,nosuid,nodev,relatime - tmpfs tmpfs rw,size=16384k,mode=1777",
  "703 700 0:82 / /dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=8192k",
  "704 700 0:83 / /dev/mqueue rw,nosuid,nodev,noexec,relatime - mqueue mqueue rw",
  "705 700 0:84 / /with\\040space rw - tmpfs tmpfs rw",
].join("\n");

export function goodFacts(): StartupFacts {
  return {
    uid: 1000,
    euid: 1000,
    gid: 1000,
    egid: 1000,
    groups: [1000],
    caps: ["0000000000000000", "0000000000000000", "0000000000000000", "0000000000000000", "0000000000000000"],
    noNewPrivs: "1",
    seccomp: "2",
    limits: [
      ["Max open files", ["256", "256"]],
      ["Max msgqueue size", ["0", "0"]],
    ],
    mountinfo: MOUNTINFO,
    worldFsid: "88d84c444c440090",
    worldWritable: true,
    worldOwner: [1000, 1000],
    net: ["lo"],
    sockets: [],
    pid1: "/usr/bin/tini",
    cgroup: [String(256 << 20), "0", "50000 100000", "64"],
    env: ["HOME", "HOSTNAME", "PATH"],
    mqueue: { created: false, errno: 24 },
    mqueueEntries: 0,
  };
}

export const EXPECTED = {
  uid: 1000,
  gid: 1000,
  device: "/dev/loop0",
  fsid: "88d84c444c440090",
  tmpMiB: 16,
  shmMiB: 8,
  fileDescriptors: 256,
  memoryMiB: 256,
  swapMiB: 0,
  cpus: 0.5,
  pids: 64,
};
