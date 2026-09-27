import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "../config/resolve.ts";
import { systemClock } from "../core/clock.ts";
import { isArchiveId, newWorldId, parseWorldId, type WorldId } from "../core/ids.ts";
import {
  CaptureRefusedError,
  createWorld,
  openWorld,
  openWorldForDestruction,
  worldHistory,
  WorldStateError,
  WorldVerificationError,
  type WorldAccess,
} from "../world/backend.ts";
import { DockerEngine, EngineResponseError, EngineUnavailableError, record, resolveDockerContext } from "../world/engine.ts";
import { readWorldMetadata, worldPaths, WorldMetadataError } from "../world/metadata.ts";
import { inspectContainer, inspectImage, inspectVolume, ResourceIdentityError } from "../world/resources.ts";
import { PrivilegeRequiredError, StorageError } from "../world/storage.ts";
import { MindUnavailableError } from "../mind/create.ts";
import { FinalizeRefusedError, RunNotFoundError } from "../records/finalize.ts";
import { ExportRefusedError } from "../records/export.ts";
import { ArchiveInspectionError } from "../records/inspection.ts";
import { CampaignError } from "../records/campaign.ts";
import { CredentialUnavailableError } from "../mind/anthropic.ts";
import { acquireOwnership, inspectOwnership, LockTokenError, OwnershipConflictError, ReleaseInProgressError } from "./locks.ts";
import { RunRefusedError } from "./run.ts";
import { chooseStateDir, prepareStateDir, StateDirError, type StateLayout } from "./state-dir.ts";
import { escapeTerminal, terminalJson } from "./terminal.ts";

// Operator commands for worlds (plan §14). Every command names its world by
// exact ID, takes the world lock for anything that changes state, and runs
// the privileged storage helper only with --allow-privileged-helper.

export type Output = (line: string) => void;

export class CommandUsageError extends Error {}

/** Problems an operator can act on: reported plainly with exit status 1, not as internal errors. */
export function isRefusal(error: unknown): boolean {
  return [
    WorldStateError,
    WorldVerificationError,
    CaptureRefusedError,
    PrivilegeRequiredError,
    StorageError,
    ResourceIdentityError,
    OwnershipConflictError,
    ReleaseInProgressError,
    LockTokenError,
    StateDirError,
    WorldMetadataError,
    EngineUnavailableError,
    EngineResponseError,
    RunRefusedError,
    FinalizeRefusedError,
    RunNotFoundError,
    MindUnavailableError,
    ExportRefusedError,
    ArchiveInspectionError,
    CampaignError,
    CredentialUnavailableError,
  ].some((kind) => error instanceof kind);
}

const common = {
  "state-dir": { type: "string" },
  json: { type: "boolean", default: false },
} as const;

/** npm runs scripts from the package directory; resolve user paths against the caller's directory. */
export function userPath(value: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

async function stateLayout(flag: string | undefined): Promise<StateLayout> {
  const choice = chooseStateDir({ flag: flag === undefined ? undefined : userPath(flag), env: process.env, home: homedir() });
  return prepareStateDir(choice.path);
}

function worldArgument(positionals: string[], command: string): WorldId {
  if (positionals.length !== 1) throw new CommandUsageError(`world ${command} takes exactly one world ID`);
  try {
    return parseWorldId(positionals[0]!);
  } catch (error) {
    throw new CommandUsageError((error as Error).message);
  }
}

/** Runs `action` holding the world lock, releasing it afterwards. */
async function withWorldLock<T>(layout: StateLayout, worldId: WorldId, allowPrivilegedHelper: boolean, action: (access: WorldAccess) => Promise<T>): Promise<T> {
  const ownership = await acquireOwnership(layout.locks, "world", worldId, systemClock);
  try {
    return await action({ layout, worldId, ownership, clock: systemClock, allowPrivilegedHelper });
  } finally {
    await ownership.release();
  }
}

function report(out: Output, json: boolean, value: Record<string, unknown>, lines: readonly string[]): void {
  if (json) out(terminalJson(value));
  else for (const line of lines) out(line);
}

// ---------------------------------------------------------------------------

export async function doctor(args: string[], out: Output): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { "docker-context": { type: "string" }, config: { type: "string" }, json: { type: "boolean", default: false } },
    allowPositionals: false,
    strict: true,
  });
  const contextName = values["docker-context"];
  if (contextName === undefined) throw new CommandUsageError("doctor needs --docker-context; nothing uses the default context implicitly");

  const context = await resolveDockerContext(contextName);
  const engine = new DockerEngine(context);
  const version = record(await engine.get("/version", { unversioned: true }), "version");
  const info = record(await engine.get("/info"), "info");
  const images: Record<string, unknown>[] = [];
  if (values.config !== undefined) {
    const loaded = await loadConfig(userPath(values.config));
    if (!loaded.ok) throw new CommandUsageError(`configuration is invalid; run config validate first`);
    for (const [role, reference] of [
      ["world", loaded.resolved.config.world.image],
      ["helper", loaded.resolved.config.world.storage.helperImage],
    ] as const) {
      const image = await inspectImage(engine, reference);
      images.push({ role, reference, present: image !== null, ...(image ?? {}) });
    }
  }
  const facts = {
    context: context.name,
    endpoint: context.endpoint,
    engineId: info.ID,
    operatingSystem: info.OperatingSystem,
    engineVersion: version.Version,
    apiVersions: `${String(version.MinAPIVersion)}–${String(version.ApiVersion)}`,
    architecture: info.Architecture,
    kernel: info.KernelVersion,
    cgroupVersion: info.CgroupVersion,
    securityOptions: info.SecurityOptions,
    images,
  };
  report(out, values.json, facts, [
    `Docker context ${escapeTerminal(context.name)} (${escapeTerminal(context.endpoint)})`,
    `  engine ${escapeTerminal(String(info.ID))}: ${escapeTerminal(String(info.OperatingSystem))}, Docker ${escapeTerminal(String(version.Version))}, API ${escapeTerminal(facts.apiVersions)}`,
    `  ${escapeTerminal(String(info.Architecture))}, kernel ${escapeTerminal(String(info.KernelVersion))}, cgroup v${escapeTerminal(String(info.CgroupVersion))}`,
    `  security: ${escapeTerminal(JSON.stringify(info.SecurityOptions))}`,
    ...images.map((image) => `  ${String(image.role)} image ${escapeTerminal(String(image.reference))}: ${image.present ? `present (${String(image.os)}/${String(image.architecture)})` : "missing; build it (images are never pulled implicitly)"}`),
    "Capabilities are reported, not tested. loop-ext4-volume-v1 needs the explicitly authorized privileged",
    "helper to attach storage; only OrbStack has been verified (see runtime/README.md).",
  ]);
  return 0;
}

async function worldCreate(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...common, config: { type: "string" }, "docker-context": { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new CommandUsageError("world create takes no positional arguments");
  if (values.config === undefined || values["docker-context"] === undefined) {
    throw new CommandUsageError("world create needs --config and --docker-context");
  }
  const loaded = await loadConfig(userPath(values.config));
  if (!loaded.ok) {
    out(`invalid configuration: ${escapeTerminal(values.config)}`);
    for (const issue of loaded.issues) out(`  ${escapeTerminal(issue.path)}: ${escapeTerminal(issue.message)}`);
    return 1;
  }
  const layout = await stateLayout(values["state-dir"]);
  const worldId = newWorldId(systemClock.now());
  const metadata = await withWorldLock(layout, worldId, false, async (access) => {
    const world = await createWorld(access, {
      dockerContext: values["docker-context"]!,
      resolved: loaded.resolved,
      minimumHostFreeMiB: loaded.resolved.config.operator.minimumHostFreeMiB,
    });
    await world.close();
    return world.metadata;
  });
  report(out, values.json, { worldId, metadata }, [
    `created world ${worldId}`,
    `  seed ${metadata.seed.id} (${metadata.seed.status}), ${metadata.storage.capacityMiB} MiB, ${metadata.storage.inodes} inodes, filesystem ${metadata.storage.uuid}`,
    `  records: ${escapeTerminal(worldPaths(layout, worldId).directory)}`,
    "  storage is not attached yet; attaching needs the privileged helper (world attach --allow-privileged-helper)",
  ]);
  return 0;
}

/** Read-only: never mounts, starts, repairs, or runs a helper. */
async function worldInspect(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true, strict: true });
  const worldId = worldArgument(positionals, "inspect");
  const layout = await stateLayout(values["state-dir"]);
  const paths = worldPaths(layout, worldId);
  const metadata = await readWorldMetadata(paths, worldId);
  const history = await worldHistory(paths);
  const owner = await inspectOwnership(layout.locks, "world", worldId);
  const engine = new DockerEngine(await resolveDockerContext(metadata.docker.context));
  const engineId = record(await engine.get("/info"), "info").ID;
  const container = await inspectContainer(engine, metadata.resources.container);
  const device = await inspectVolume(engine, metadata.resources.deviceVolume);
  const backing = await inspectVolume(engine, metadata.resources.backingVolume);
  let archives: string[] = [];
  try {
    archives = (await readdir(paths.archives)).filter((name) => isArchiveId(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const status = {
    worldId,
    provisioned: history.provisioned,
    destroyed: history.destroyed,
    engineMatches: engineId === metadata.docker.engineId,
    owner: owner?.holder ?? null,
    container: container === null ? "absent" : container.state.running ? "running" : "stopped",
    backingVolume: backing !== null,
    recordedDevice: device?.options.device ?? null,
    archives,
    metadata,
  };
  report(out, values.json, status, [
    `world ${worldId}${history.destroyed ? " (destroyed)" : history.provisioned ? "" : " (provisioning incomplete)"}`,
    `  engine ${escapeTerminal(metadata.docker.context)}: ${status.engineMatches ? "matches the record" : "DIFFERS from the record"}`,
    `  owner: ${owner?.holder ? `pid ${owner.holder.pid} on ${escapeTerminal(owner.holder.hostname)} since ${owner.holder.acquiredAt}` : "none"}`,
    `  container: ${status.container}`,
    `  backing volume: ${backing === null ? "absent" : "present"}; world volume names ${escapeTerminal(status.recordedDevice ?? "no device")} (identity not checked by inspect)`,
    `  seed ${metadata.seed.id}, ${metadata.storage.capacityMiB} MiB, ${metadata.storage.inodes} inodes, filesystem ${metadata.storage.uuid}`,
    `  archives: ${archives.length === 0 ? "none" : archives.join(", ")}`,
  ]);
  return 0;
}

async function worldAttach(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...common, "allow-privileged-helper": { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const worldId = worldArgument(positionals, "attach");
  const layout = await stateLayout(values["state-dir"]);
  await withWorldLock(layout, worldId, values["allow-privileged-helper"], async (access) => {
    const world = await openWorld(access);
    try {
      await world.attach();
    } finally {
      await world.close();
    }
  });
  report(out, values.json, { worldId, attached: true }, [`world ${worldId}: storage attached and its identity verified`]);
  return 0;
}

async function worldStop(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true, strict: true });
  const worldId = worldArgument(positionals, "stop");
  const layout = await stateLayout(values["state-dir"]);
  const result = await withWorldLock(layout, worldId, false, async (access) => {
    const world = await openWorld(access);
    try {
      return await world.stop("operator_stop");
    } finally {
      await world.close();
    }
  });
  report(out, values.json, { worldId, ...result }, [
    `world ${worldId}: ${result.verified ? "" : "NOT VERIFIED: "}${result.recorded ? "" : "NOT FULLY RECORDED: "}${escapeTerminal(result.detail)}`,
  ]);
  return result.verified && result.recorded ? 0 : 1;
}

async function worldCapture(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...common, label: { type: "string" }, "allow-privileged-helper": { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const worldId = worldArgument(positionals, "capture");
  if (values.label === undefined) throw new CommandUsageError("world capture needs --label, such as --label final");
  const layout = await stateLayout(values["state-dir"]);
  const result = await withWorldLock(layout, worldId, values["allow-privileged-helper"], async (access) => {
    const world = await openWorld(access);
    try {
      return { archive: await world.captureArtifacts(values.label!), directory: world.paths.archives };
    } finally {
      await world.close();
    }
  });
  const { archive } = result;
  report(out, values.json, { worldId, ...archive }, [
    `world ${worldId}: archive ${archive.archiveId} is ${archive.complete ? "complete" : "INCOMPLETE"} (${archive.entries} entries, ${archive.bytes} bytes)`,
    ...archive.omissions.map((omission) => `  omission: ${escapeTerminal(omission)}`),
    `  manifest: ${escapeTerminal(`${result.directory}/${archive.archiveId}/manifest.json`)}`,
  ]);
  return 0;
}

async function worldDetach(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...common, "allow-privileged-helper": { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const worldId = worldArgument(positionals, "detach");
  const layout = await stateLayout(values["state-dir"]);
  const result = await withWorldLock(layout, worldId, values["allow-privileged-helper"], async (access) => {
    const world = await openWorld(access);
    try {
      return await world.detach();
    } finally {
      await world.close();
    }
  });
  report(out, values.json, { worldId, ...result }, [
    result.verified ? `world ${worldId}: storage detached` : `world ${worldId}: NOT VERIFIED, still bound to ${result.remaining.join(", ")}`,
  ]);
  return result.verified ? 0 : 1;
}

async function worldDestroy(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...common, confirm: { type: "string" }, "allow-privileged-helper": { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const worldId = worldArgument(positionals, "destroy");
  if (values.confirm !== worldId) throw new CommandUsageError("world destroy needs --confirm with the exact world ID");
  const layout = await stateLayout(values["state-dir"]);
  const result = await withWorldLock(layout, worldId, values["allow-privileged-helper"], async (access) => {
    const world = await openWorldForDestruction(access);
    try {
      return await world.destroy();
    } finally {
      await world.close();
    }
  });
  report(out, values.json, { worldId, ...result }, [`world ${worldId}: ${result.verified ? "" : "NOT VERIFIED: "}${escapeTerminal(result.detail)}`]);
  return result.verified ? 0 : 1;
}

export async function worldCommand(args: string[], out: Output): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "create":
      return worldCreate(rest, out);
    case "inspect":
      return worldInspect(rest, out);
    case "attach":
      return worldAttach(rest, out);
    case "stop":
      return worldStop(rest, out);
    case "capture":
      return worldCapture(rest, out);
    case "detach":
      return worldDetach(rest, out);
    case "destroy":
      return worldDestroy(rest, out);
    default:
      throw new CommandUsageError(`unknown world command ${JSON.stringify(sub ?? "")}`);
  }
}
