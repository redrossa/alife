# Phase 0 capability probes

Standalone probes for Phase 0 of the first runnable system plan. They check
the plan's risky Docker, storage, and execution assumptions against a real
engine before the runtime is built. This is not the runtime. Phase 1 creates
the `runtime/` package, and Phase 2 reimplements the chosen storage backend
behind `WorldBackend`.

Findings and the support matrix are in [RESULTS.md](RESULTS.md). Raw evidence is
in `results/<run-id>.json`.

## Requirements

- Node.js 22 or newer (standard library only; no `npm install`).
- A local Docker context reachable over a unix socket. OrbStack is the only
  verified environment.
- The first run needs network access to pull the pinned base images and build
  two small probe images.

## Running

```sh
node runtime/spikes/phase0/probe.mjs --docker-context orbstack --allow-privileged-helper
```

| Flag | Effect |
| --- | --- |
| `--docker-context <name>` | Required. Nothing uses the default context implicitly. |
| `--allow-privileged-helper` | Allows short-lived `--privileged` helper containers to attach and detach loop devices. Without it, only discovery runs. |
| `--allow-engine-restart` | Runs `orbctl stop` and `orbctl start` to test persistence across an application/VM restart. **This stops every container on the engine.** OrbStack only. |
| `--keep` | Leave the probe's resources in place for inspection. |
| `--cleanup <run-id>` | Remove resources left behind by an earlier run. |
| `--out <dir>` | Where to write the JSON report. The default is `results/`. |

The script exits non-zero if any check fails.

## What it creates

The probes build two images, `alife-p0-world:dev` and `alife-p0-tools:dev`, and
keep them after the run. Every container and volume is named
`alife-p0-<run-id>-*` and labelled `sh.alife.phase0.run=<run-id>`. Cleanup
removes only resources with that exact label and detaches only loop devices
backed by the run's own images. A capture archive is written temporarily to the
OS temporary directory and deleted during cleanup.

Nothing mounts host paths, uses network access at run time (except for image
builds), reads model credentials, or touches other containers. The only
exception is `--allow-engine-restart`, which stops and starts the whole
OrbStack instance.

## Privileged helper disclosure

The kernel has no mount option for a loop device, so the Docker `local` volume
driver cannot mount an image file on its own (see probe `D4`). A loop device
has to be attached first. The helper that does this runs `alpine` with
`--privileged --network none --read-only`, mounts only the world's backing
volume, and runs one fixed `losetup` or `blkid` script.

A privileged container is effectively root in OrbStack's Linux VM. With
OrbStack's default `machine.docker.isolated: false`, that VM can also reach
the macOS file share. Only use the helper with scripts you have reviewed.

The helper is needed only for these steps:

- attaching a world's backing image after creation;
- attaching it again after every OrbStack or VM restart;
- detaching it on destroy.

Image creation, identity checks, the world itself, and capture all run without
extra privileges.
