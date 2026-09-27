import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { loadConfig, paidExecutionBlockers } from "../config/resolve.ts";
import { createMind } from "../mind/create.ts";
import { configSchema } from "../config/schema.ts";
import { systemClock } from "../core/clock.ts";
import type { OperationalOutcome } from "../core/contracts.ts";
import { isArchiveId, isRunId, isWorldId, parseRunId, parseWorldId, type RunId } from "../core/ids.ts";
import { renderOutcome } from "../core/observation.ts";
import { createCampaign, openCampaign, readCampaign, SMOKE_CAMPAIGN_ID, type CampaignSnapshot } from "../records/campaign.ts";
import { exportRun } from "../records/export.ts";
import { analyzeRun, finalizeRun, isInterrupted, needsFinalization, pendingAcknowledgement, type WorldStopCheck } from "../records/finalize.ts";
import { listArchive, readArchiveFile, type InspectionLimits } from "../records/inspection.ts";
import { readEventLog } from "../records/events.ts";
import { RunRecorder, runPaths, type RunPaths } from "../records/run-store.ts";
import { openWorld } from "../world/backend.ts";
import { acquireOwnership, inspectOwnership, releaseAbandonedOwnership, type OwnedKind } from "./locks.ts";
import { captureIntoRun, requestRunStop, resumeManagedRun, startManagedRun } from "./managed-run.ts";
import { PROBE_LIMITS, runAnthropicProbe } from "./probe.ts";
import { RunRefusedError, type RunResult } from "./run.ts";
import { chooseStateDir, prepareStateDir, type StateLayout } from "./state-dir.ts";
import { escapeTerminal, terminalJson } from "./terminal.ts";
import { CommandUsageError, userPath, type Output } from "./world-commands.ts";
import { messageOf } from "../core/errors.ts";

// Operator commands for runs and locks (plan §14). `run start` runs in the
// foreground; SIGINT or SIGTERM asks it to stop cleanly, aborting a model
// request in flight. Status and inspection are read-only. Finalization closes an
// interrupted run only with explicit acknowledgement of what is unknown.

const common = {
  "state-dir": { type: "string" },
  json: { type: "boolean", default: false },
} as const;

async function stateLayout(flag: string | undefined): Promise<StateLayout> {
  const choice = chooseStateDir({ flag: flag === undefined ? undefined : userPath(flag), env: process.env, home: homedir() });
  return prepareStateDir(choice.path);
}

function runArgument(positionals: string[], command: string): RunId {
  if (positionals.length !== 1) throw new CommandUsageError(`run ${command} takes exactly one run ID`);
  try {
    return parseRunId(positionals[0]!);
  } catch (error) {
    throw new CommandUsageError((error as Error).message);
  }
}

function outcomeLine(outcome: OperationalOutcome): string {
  return escapeTerminal(renderOutcome(outcome));
}

/** Converts the first SIGINT or SIGTERM into a stop request; later ones only report. */
export function stopOnSignals(err: Output): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const handler = (name: NodeJS.Signals) => {
    if (controller.signal.aborted) {
      err(`alife: ${name}: already stopping; the run ends its current step and then stops the world`);
      return;
    }
    err(`alife: ${name}: stopping (a model request in flight is aborted; a dispatched action finishes its wait)`);
    controller.abort(name);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    },
  };
}

function printResult(result: RunResult, json: boolean, out: Output): number {
  if (json) out(terminalJson(result));
  else {
    out(
      `run ${result.runId}: ${result.state} (${result.reason}) after ${result.completedTicks} ticks: ` +
        `${result.attemptedCalls} model calls attempted, ${result.respondedCalls} answered`,
    );
    out(`  ${escapeTerminal(result.detail)}`);
    if (result.worldStop !== null) {
      const stop = result.worldStop;
      out(`  world stop: ${stop.verified ? "verified" : "NOT VERIFIED"}${stop.recorded ? "" : ", NOT FULLY RECORDED"}: ${escapeTerminal(stop.detail)}`);
      const { safety } = stop;
      const issues = [
        ...safety.uncertainEffects.map((effect) => `${effect.jobId} uncertain (${effect.cause})`),
        ...(safety.requiredEvidenceFailed ? ["required evidence incomplete"] : []),
      ];
      out(
        `  execution epoch ${escapeTerminal(safety.epochId)}: assessment ${safety.sealed ? "sealed" : "NOT SEALED"}, ` +
          `${safety.committedEffects} effect(s) committed; ${issues.length === 0 ? (safety.reviewRequired ? "review required" : "nothing uncertain") : escapeTerminal(issues.join("; "))}`,
      );
    }
    if (result.checkpointSha256 !== null) out(`  checkpoint ${result.checkpointSha256}`);
    if (result.state === "stopped_clean") out(`  it can be resumed explicitly: run resume ${result.runId}`);
    if (result.state === "recovery_required") {
      out(`  review the run (run status ${result.runId}) and finalize it (run finalize ${result.runId} --acknowledge-uncertainty)`);
    }
    if (!result.recorded) out("  the final state could not be recorded; the run will show as interrupted");
  }
  return result.state === "recovery_required" ? 1 : 0;
}

async function runStart(args: string[], out: Output, err: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...common, world: { type: "string" }, config: { type: "string" }, "allow-privileged-helper": { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new CommandUsageError("run start takes no positional arguments");
  if (values.world === undefined || values.config === undefined) throw new CommandUsageError("run start needs --world and --config");
  let worldId;
  try {
    worldId = parseWorldId(values.world);
  } catch (error) {
    throw new CommandUsageError((error as Error).message);
  }
  const loaded = await loadConfig(userPath(values.config));
  if (!loaded.ok) {
    out(`invalid configuration: ${escapeTerminal(values.config)}`);
    for (const issue of loaded.issues) out(`  ${escapeTerminal(issue.path)}: ${escapeTerminal(issue.message)}`);
    return 1;
  }
  const layout = await stateLayout(values["state-dir"]);
  const stop = stopOnSignals(err);
  try {
    const result = await startManagedRun({
      layout,
      resolved: loaded.resolved,
      worldId,
      clock: systemClock,
      signal: stop.signal,
      allowPrivilegedHelper: values["allow-privileged-helper"],
      onCreated: (runId, paths) => {
        if (!values.json) out(`run ${runId} in world ${worldId}; records: ${escapeTerminal(paths.directory)}`);
      },
      onTick: (report) => {
        if (!values.json) out(`  tick ${report.tick}: ${outcomeLine(report.outcome)}`);
      },
    });
    return printResult(result, values.json, out);
  } finally {
    stop.dispose();
  }
}

async function runResume(args: string[], out: Output, err: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...common, "allow-privileged-helper": { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const runId = runArgument(positionals, "resume");
  const layout = await stateLayout(values["state-dir"]);
  const stop = stopOnSignals(err);
  try {
    if (!values.json) out(`resuming run ${runId}; records: ${escapeTerminal(runPaths(layout, runId).directory)}`);
    const result = await resumeManagedRun({
      layout,
      runId,
      clock: systemClock,
      signal: stop.signal,
      allowPrivilegedHelper: values["allow-privileged-helper"],
      onTick: (report) => {
        if (!values.json) out(`  tick ${report.tick}: ${outcomeLine(report.outcome)}`);
      },
    });
    return printResult(result, values.json, out);
  } finally {
    stop.dispose();
  }
}

async function runStop(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true, strict: true });
  const runId = runArgument(positionals, "stop");
  const layout = await stateLayout(values["state-dir"]);
  const result = await requestRunStop({ layout, runId, clock: systemClock });
  if (values.json) out(terminalJson({ runId, ...result }));
  else out(`run ${runId}: ${result.accepted ? "stop requested" : "stop NOT accepted"}: ${escapeTerminal(result.reason)}`);
  return result.accepted ? 0 : 1;
}

/** The run's record limit from its stored configuration. */
async function recordLimit(paths: RunPaths): Promise<number> {
  try {
    return configSchema.parse(JSON.parse(await readFile(paths.config, "utf8"))).operator.recordLimitMiB * (1 << 20);
  } catch {
    throw new RunRefusedError("the run's stored configuration, which sets its record limit, is unreadable");
  }
}

async function runCapture(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...common, label: { type: "string" }, "allow-privileged-helper": { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const runId = runArgument(positionals, "capture");
  if (values.label === undefined) throw new CommandUsageError("run capture needs --label, such as --label paused");
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(values.label)) throw new CommandUsageError("a label is 1-32 lowercase letters, digits, and hyphens");
  const layout = await stateLayout(values["state-dir"]);
  const paths = runPaths(layout, runId);
  // Capture never stops or interrupts a run: a live owner keeps its lock, and this refuses.
  const runLock = await acquireOwnership(layout.locks, "run", runId, systemClock);
  try {
    const analysis = await analyzeRun(paths, runId);
    const worldId = analysis.worldId;
    if (worldId === null || !isWorldId(worldId)) throw new RunRefusedError(`run ${runId} records no world`);
    const limitBytes = await recordLimit(paths);
    const worldLock = await acquireOwnership(layout.locks, "world", worldId, systemClock);
    try {
      const world = await openWorld({ layout, worldId, ownership: worldLock, clock: systemClock, allowPrivilegedHelper: values["allow-privileged-helper"] });
      try {
        const records = await RunRecorder.open({ paths, runId, clock: systemClock, limitBytes });
        try {
          const captured = await captureIntoRun({ world, records, layout, worldId, paths, phase: "manual", label: values.label, budget: records.remainingBytes() });
          if (captured.result === null) throw new RunRefusedError(`run ${runId}: the capture failed and was recorded: ${captured.reason ?? "unknown"}`);
          const archive = captured.result;
          if (values.json) out(terminalJson({ runId, worldId, ...archive }));
          else {
            out(`run ${runId}: archive ${archive.archiveId} is ${archive.complete ? "complete" : "INCOMPLETE"} (${archive.entries} entries, ${archive.bytes} bytes); associated with the run`);
            for (const omission of archive.omissions) out(`  omission: ${escapeTerminal(omission)}`);
          }
          return 0;
        } finally {
          await records.close();
        }
      } finally {
        await world.close();
      }
    } finally {
      await worldLock.release();
    }
  } finally {
    await runLock.release();
  }
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CommandUsageError(`${name} must be a non-negative integer`);
  return Number(value);
}

async function runExport(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...common, output: { type: "string" }, "maximum-bytes": { type: "string" }, "maximum-files": { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const runId = runArgument(positionals, "export");
  if (values.output === undefined) throw new CommandUsageError("run export needs --output with a new directory");
  const layout = await stateLayout(values["state-dir"]);
  const paths = runPaths(layout, runId);
  // Everything a run stores fits its record limit; the export adds its manifest.
  const fallback = await recordLimit(paths).catch(() => 64 << 30);
  const result = await exportRun({
    layout,
    runId,
    outputDirectory: userPath(values.output),
    maximumBytes: positiveInteger(values["maximum-bytes"], "--maximum-bytes", fallback + (16 << 20)),
    maximumFiles: positiveInteger(values["maximum-files"], "--maximum-files", 1_000_000),
  });
  if (values.json) out(terminalJson(result));
  else {
    out(`run ${runId}: exported ${result.files.length} file(s) to ${escapeTerminal(result.directory)}; ${result.complete ? "complete" : "INCOMPLETE"}`);
    for (const omission of result.omissions) out(`  omission: ${escapeTerminal(omission)}`);
    out("  this is a private copy of the evidence, not an approval to publish it");
  }
  return 0;
}

async function runStatus(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true, strict: true });
  const runId = runArgument(positionals, "status");
  const layout = await stateLayout(values["state-dir"]);
  const paths = runPaths(layout, runId);
  const analysis = await analyzeRun(paths, runId);
  const owner = await inspectOwnership(layout.locks, "run", runId);
  const interrupted = isInterrupted(analysis, owner);
  const pending = pendingAcknowledgement(analysis);
  const reviewRequired = !interrupted && needsFinalization(analysis) && analysis.state !== null && !["created", "ready", "running", "stopping"].includes(analysis.state);
  const status = { ...analysis, owner: owner?.holder ?? null, ownerAppearsAlive: owner?.appearsAlive ?? null, interrupted };
  if (values.json) {
    out(terminalJson(status));
    return 0;
  }
  const state = analysis.state ?? "no lifecycle recorded";
  out(
    `run ${runId}: ${state}${interrupted ? " (INTERRUPTED: no live owner)" : ""}${analysis.stopReason === null ? "" : ` (${escapeTerminal(analysis.stopReason)})`}` +
      (reviewRequired && analysis.state !== "recovery_required" ? " (REVIEW REQUIRED: watchdog evidence)" : ""),
  );
  out(`  world: ${escapeTerminal(analysis.worldId ?? "unknown")}; completed ticks: ${analysis.completedTicks}; last event: ${analysis.lastSequence}`);
  const { calls } = analysis;
  out(
    `  model calls confirmed by the record: ${calls.confirmedAttempted} made, ${calls.answered} answered, ${calls.failed} failed` +
      (calls.unresolved === 0 ? "" : `; ${calls.unresolved} recorded request(s) with unknown invocation status`),
  );
  if (owner?.holder) out(`  owner: pid ${owner.holder.pid} on ${escapeTerminal(owner.holder.hostname)} since ${owner.holder.acquiredAt} (${owner.appearsAlive === null ? "liveness unknown" : owner.appearsAlive ? "appears alive" : "appears dead"})`);
  if (analysis.checkpointSha256 !== null) out(`  checkpoint: ${analysis.checkpointSha256}`);
  for (const issue of analysis.issues) out(`  log issue: ${escapeTerminal(issue.detail)}`);
  if (analysis.logMissing) out("  the run has no event log");
  for (const request of pending.requests) out(`  unknown outcome: model request ${escapeTerminal(request.requestId)}`);
  for (const action of pending.actions) {
    out(`  unknown outcome: action ${escapeTerminal(action.actionId)} (prepared; it may or may not have started; exec ${escapeTerminal(action.execId ?? "unknown")})`);
  }
  for (const reservation of pending.reservations) out(`  unreconciled reservation: ${escapeTerminal(reservation.requestId)} (${reservation.microUsd} micro-USD kept)`);
  for (const action of pending.uncertainActions) out(`  uncertain result: action ${escapeTerminal(action.actionId)} ${escapeTerminal(action.state)}`);
  const { watchdog } = analysis;
  if (analysis.supervision !== null || watchdog.state !== "absent") {
    out(`  watchdog: ${watchdog.state}${watchdog.stopVerified === null ? "" : `, stop ${watchdog.stopVerified ? "verified" : "NOT verified"}`}${watchdog.reviewRequired ? " (review required)" : ""}`);
    for (const issue of watchdog.issues) out(`    ${escapeTerminal(issue)}`);
  }
  if (analysis.finalization !== null) out(`  finalized at ${analysis.finalization.finalizedAt}${analysis.finalization.logProblem === null ? "" : ` (recorded in finalization.json: ${escapeTerminal(analysis.finalization.logProblem)})`}`);
  return 0;
}

async function checkWorld(layout: StateLayout, worldId: string | null): Promise<WorldStopCheck> {
  if (worldId === null || !isWorldId(worldId)) return { container: "unknown", detail: "the run's world is not recorded" };
  const lock = await acquireOwnership(layout.locks, "world", worldId, systemClock);
  try {
    const world = await openWorld({ layout, worldId, ownership: lock, clock: systemClock, allowPrivilegedHelper: false });
    try {
      const status = await world.inspect();
      return { container: status.container, detail: `world ${worldId} container is ${status.container}` };
    } finally {
      await world.close();
    }
  } catch (error) {
    return { container: "unknown", detail: `the world could not be checked: ${messageOf(error)}` };
  } finally {
    await lock.release();
  }
}

async function runFinalize(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { ...common, "acknowledge-uncertainty": { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const runId = runArgument(positionals, "finalize");
  const layout = await stateLayout(values["state-dir"]);
  const paths = runPaths(layout, runId);
  const lock = await acquireOwnership(layout.locks, "run", runId, systemClock);
  try {
    const analysis = await analyzeRun(paths, runId);
    const pending = pendingAcknowledgement(analysis);
    const world = await checkWorld(layout, analysis.worldId);
    if (!values["acknowledge-uncertainty"]) {
      const report = { runId, state: analysis.state, world, pending, logIssues: analysis.issues, finalized: false };
      if (values.json) out(terminalJson(report));
      else {
        out(`run ${runId} (${analysis.state ?? "no lifecycle recorded"}) would be finalized with:`);
        out(`  ${pending.requests.length} model request(s), ${pending.actions.length} action(s), and ${pending.reservations.length} reservation(s) without outcomes`);
        out(`  ${pending.uncertainActions.length} action(s) with uncertain results; ${analysis.issues.length} log issue(s)`);
        out(`  watchdog evidence: ${pending.watchdog?.state ?? "absent"}${pending.watchdog?.reviewRequired === true ? " (review required)" : ""}`);
        out(`  ${escapeTerminal(world.detail)}`);
        out("  nothing was changed; rerun with --acknowledge-uncertainty to finalize");
      }
      return 1;
    }
    // The record limit comes from the run's own configuration; without it nothing is appended.
    let limitBytes: number | null = null;
    try {
      limitBytes = configSchema.parse(JSON.parse(await readFile(paths.config, "utf8"))).operator.recordLimitMiB * (1 << 20);
    } catch {
      limitBytes = null;
    }
    const record = await finalizeRun({ paths, runId, clock: systemClock, analysis, world, limitBytes });
    if (values.json) out(terminalJson(record));
    else {
      out(`run ${runId}: finalized; it cannot be resumed`);
      out(`  acknowledged ${record.acknowledged.requests.length} request(s), ${record.acknowledged.actions.length} action(s), ${record.acknowledged.reservations.length} reservation(s), ${record.acknowledged.uncertainActions.length} uncertain result(s)`);
      if (record.acknowledged.watchdog !== undefined) out(`  acknowledged watchdog evidence: ${record.acknowledged.watchdog.state}${record.acknowledged.watchdog.reviewRequired ? " (review required)" : ""}`);
      out(`  ${escapeTerminal(record.world.detail)}`);
      if (record.logProblem !== null) out(`  recorded in finalization.json: ${escapeTerminal(record.logProblem)}`);
    }
    return 0;
  } finally {
    await lock.release();
  }
}

export async function runCommand(args: string[], out: Output, err: Output): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "start":
      return runStart(rest, out, err);
    case "resume":
      return runResume(rest, out, err);
    case "stop":
      return runStop(rest, out);
    case "capture":
      return runCapture(rest, out);
    case "export":
      return runExport(rest, out);
    case "status":
      return runStatus(rest, out);
    case "finalize":
      return runFinalize(rest, out);
    default:
      throw new CommandUsageError(`unknown run command ${JSON.stringify(sub ?? "")}`);
  }
}

// ---------------------------------------------------------------------------

function lockTarget(positionals: string[], command: string): { kind: OwnedKind; id: string } {
  const [kind, id] = positionals;
  if (positionals.length !== 2 || (kind !== "world" && kind !== "run")) throw new CommandUsageError(`lock ${command} takes world|run and an ID`);
  if (!(kind === "world" ? isWorldId(id!) : isRunId(id!))) throw new CommandUsageError(`not a ${kind} ID: ${JSON.stringify(id)}`);
  return { kind, id: id! };
}

export async function lockCommand(args: string[], out: Output): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "status") {
    const { values, positionals } = parseArgs({ args: rest, options: common, allowPositionals: true, strict: true });
    const { kind, id } = lockTarget(positionals, "status");
    const layout = await stateLayout(values["state-dir"]);
    const status = await inspectOwnership(layout.locks, kind, id);
    if (values.json) out(terminalJson({ kind, id, held: status !== null, ...(status ?? {}) }));
    else if (status === null) out(`${kind} ${id}: not locked`);
    else if (status.holder === null) out(`${kind} ${id}: locked by an unreadable lock file`);
    else {
      const liveness = status.appearsAlive === null ? "liveness unknown (another host)" : status.appearsAlive ? "appears alive" : "appears dead";
      out(`${kind} ${id}: held by pid ${status.holder.pid} on ${escapeTerminal(status.holder.hostname)} since ${status.holder.acquiredAt} (${liveness})`);
      out(`  token ${status.holder.token}`);
    }
    return 0;
  }
  if (sub === "release") {
    const { values, positionals } = parseArgs({ args: rest, options: { ...common, token: { type: "string" } }, allowPositionals: true, strict: true });
    const { kind, id } = lockTarget(positionals, "release");
    if (values.token === undefined) throw new CommandUsageError("lock release needs --token with the exact token from lock status");
    const layout = await stateLayout(values["state-dir"]);
    await releaseAbandonedOwnership(layout.locks, kind, id, values.token);
    out(`${kind} ${id}: abandoned lock released`);
    return 0;
  }
  throw new CommandUsageError(`unknown lock command ${JSON.stringify(sub ?? "")}`);
}

// ---------------------------------------------------------------------------
// Read-only inspection of a run's associated archives

/** Generous defaults: an associated archive already fits its run's record limit. */
const OBSERVE_LIMITS: InspectionLimits = { maximumArchiveBytes: 2 ** 44, maximumEntries: 16_000_000, maximumReadBytes: 16 << 20 };
const DEFAULT_READ_BYTES = 64 << 10;

/** The run-owned copy of an archive the run's record associates with it. */
async function associatedArchive(layout: StateLayout, runId: RunId, archiveId: string | undefined): Promise<string> {
  if (archiveId === undefined) throw new CommandUsageError("observe needs --archive with an archive ID");
  if (!isArchiveId(archiveId)) throw new CommandUsageError(`not an archive ID: ${JSON.stringify(archiveId)}`);
  const paths = runPaths(layout, runId);
  const { events } = await readEventLog(paths.events).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new RunRefusedError(`there is no run ${runId} with an event log in this state directory`);
    throw error;
  });
  if (!events.some((event) => event.type === "archive.created" && event.data.archiveId === archiveId)) {
    throw new RunRefusedError(`archive ${archiveId} is not associated with run ${runId}`);
  }
  return path.join(paths.archives, archiveId);
}

export async function observeCommand(args: string[], out: Output): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "list") {
    const { values, positionals } = parseArgs({ args: rest, options: { ...common, archive: { type: "string" } }, allowPositionals: true, strict: true });
    const runId = runArgument(positionals, "observe list");
    const layout = await stateLayout(values["state-dir"]);
    const directory = await associatedArchive(layout, runId, values.archive);
    const listing = await listArchive({ directory, limits: OBSERVE_LIMITS });
    if (values.json) {
      out(terminalJson({ runId, archiveId: values.archive, ...listing }));
      return 0;
    }
    out(`run ${runId} archive ${values.archive}: ${listing.entries.length} entries; ${listing.complete ? "complete" : "INCOMPLETE capture"}`);
    for (const omission of listing.omissions) out(`  omission: ${escapeTerminal(omission)}`);
    for (const entry of listing.entries) {
      const name = entry.path === null ? `(not UTF-8; base64 ${entry.pathBase64})` : escapeTerminal(entry.path);
      out(`  ${entry.type.padEnd(9)} ${entry.mode} ${entry.uid}:${entry.gid} ${String(entry.size).padStart(10)} ${name}`);
    }
    return 0;
  }
  if (sub === "read") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { ...common, archive: { type: "string" }, offset: { type: "string" }, length: { type: "string" }, "path-base64": { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    const [run, name, ...extra] = positionals;
    if (run === undefined || extra.length > 0 || (name === undefined) === (values["path-base64"] === undefined)) {
      throw new CommandUsageError("observe read takes a run ID and either a path or --path-base64");
    }
    const runId = runArgument([run], "observe read");
    const layout = await stateLayout(values["state-dir"]);
    const directory = await associatedArchive(layout, runId, values.archive);
    const pathBase64 = values["path-base64"] ?? Buffer.from(name!, "utf8").toString("base64");
    const result = await readArchiveFile({
      directory,
      pathBase64,
      offset: positiveInteger(values.offset, "--offset", 0),
      length: positiveInteger(values.length, "--length", DEFAULT_READ_BYTES),
      limits: OBSERVE_LIMITS,
    });
    const data = Buffer.from(result.data);
    if (values.json) {
      out(terminalJson({
        runId,
        archiveId: values.archive,
        pathBase64,
        dataBase64: data.toString("base64"),
        offset: result.offset,
        totalBytes: result.totalBytes,
        truncated: result.truncated,
        complete: result.complete,
        omissions: result.omissions,
      }));
      return 0;
    }
    const end = result.offset + data.length;
    out(`bytes ${result.offset}-${end} of ${result.totalBytes}${result.truncated ? " (more follows)" : ""}; ${result.complete ? "complete capture" : "INCOMPLETE capture"}`);
    out(escapeTerminal(new TextDecoder("utf-8", { fatal: false }).decode(data), { keepNewlines: true }));
    return 0;
  }
  throw new CommandUsageError(`unknown observe command ${JSON.stringify(sub ?? "")}`);
}

// ---------------------------------------------------------------------------
// The shared spending campaign (Phase 5)

/** The operator's approved ceiling for all Phase 5 paid calls together. */
const MAXIMUM_CAMPAIGN_MICRO_USD = 100_000_000;
const CAMPAIGN_STORE_BYTES = 16 << 20;

/** Parses a positive decimal dollar amount exactly into integer micro-dollars. */
function microDollars(text: string): number {
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text);
  if (match === null) throw new CommandUsageError(`--limit-usd must be a decimal number of dollars with at most six decimal places, not ${JSON.stringify(text)}`);
  const value = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
  if (value <= 0 || value > MAXIMUM_CAMPAIGN_MICRO_USD) throw new CommandUsageError(`--limit-usd must be more than 0 and at most ${MAXIMUM_CAMPAIGN_MICRO_USD / 1_000_000}`);
  return value;
}

function campaignDirectory(value: string | undefined): string {
  if (value === undefined) throw new CommandUsageError("campaign commands need --directory with an absolute path");
  if (!path.isAbsolute(value)) throw new CommandUsageError("--directory must be an absolute path");
  return path.normalize(value);
}

function reportCampaign(out: Output, json: boolean, directory: string, snapshot: CampaignSnapshot & { readonly owned?: boolean }): void {
  if (json) {
    out(terminalJson({ directory, ...snapshot }));
    return;
  }
  const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(6)}`;
  out(`campaign ${snapshot.campaignId} at ${escapeTerminal(directory)}`);
  out(`  limit ${usd(snapshot.limitMicroUsd)}; accounted ${usd(snapshot.accountedMicroUsd)}; remaining ${usd(snapshot.remainingMicroUsd)}`);
  for (const reservation of snapshot.outstanding) {
    out(`  outstanding: ${escapeTerminal(reservation.requestId)} of ${escapeTerminal(reservation.runId)} holds ${usd(reservation.maximumMicroUsd)}`);
  }
  if (snapshot.reviewRequired) out("  REVIEW REQUIRED: a settled charge exceeded its reservation; nothing more is admitted");
  if (snapshot.owned === true) out("  owned by a process now, or left owned by one that crashed");
}

export async function campaignCommand(args: string[], out: Output): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "create") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false }, directory: { type: "string" }, "limit-usd": { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) throw new CommandUsageError("campaign create takes no positional arguments");
    const directory = campaignDirectory(values.directory);
    if (values["limit-usd"] === undefined) throw new CommandUsageError("campaign create needs --limit-usd");
    const limitMicroUsd = microDollars(values["limit-usd"]);
    const campaign = await createCampaign({ directory, campaignId: SMOKE_CAMPAIGN_ID, limitMicroUsd, maximumBytes: CAMPAIGN_STORE_BYTES });
    try {
      reportCampaign(out, values.json, directory, await campaign.snapshot());
    } finally {
      await campaign.close();
    }
    return 0;
  }
  if (sub === "status") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false }, directory: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) throw new CommandUsageError("campaign status takes no positional arguments");
    const directory = campaignDirectory(values.directory);
    reportCampaign(out, values.json, directory, await readCampaign({ directory, campaignId: SMOKE_CAMPAIGN_ID }));
    return 0;
  }
  throw new CommandUsageError(`unknown campaign command ${JSON.stringify(sub ?? "")}`);
}

// ---------------------------------------------------------------------------
// The synthetic compatibility probe (Phase 5 plan §9)

export async function probeCommand(args: string[], out: Output, err: Output): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "anthropic") throw new CommandUsageError(`unknown probe command ${JSON.stringify(sub ?? "")}`);
  const { values, positionals } = parseArgs({
    args: rest,
    options: { json: { type: "boolean", default: false }, config: { type: "string" }, output: { type: "string" }, "confirm-paid": { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new CommandUsageError("probe anthropic takes no positional arguments");
  if (values.config === undefined || values.output === undefined) throw new CommandUsageError("probe anthropic needs --config and --output");
  if (!values["confirm-paid"]) {
    throw new CommandUsageError(
      `probe anthropic makes up to ${PROBE_LIMITS.maximumCalls} paid requests (at most $${PROBE_LIMITS.maximumMicroUsd / 1_000_000}, within the shared campaign); pass --confirm-paid`,
    );
  }
  const loaded = await loadConfig(userPath(values.config));
  if (!loaded.ok) {
    out(`invalid configuration: ${escapeTerminal(values.config)}`);
    for (const issue of loaded.issues) out(`  ${escapeTerminal(issue.path)}: ${escapeTerminal(issue.message)}`);
    return 1;
  }
  const { resolved } = loaded;
  const { config } = resolved;
  if (config.mind.provider !== "anthropic") throw new RunRefusedError("the probe needs an anthropic configuration");
  const blockers = paidExecutionBlockers(config);
  if (blockers.length > 0) throw new RunRefusedError(`paid execution is blocked: ${blockers.join("; ")}`);
  const { mind, rates } = createMind(resolved);
  const campaign = await openCampaign({ directory: config.operator.campaignDirectory!, campaignId: SMOKE_CAMPAIGN_ID });
  const stop = stopOnSignals(err);
  try {
    const report = await runAnthropicProbe({
      mind,
      rates,
      campaign,
      tools: resolved.tools,
      maximumOutputTokens: config.mind.maximumOutputTokens,
      output: userPath(values.output),
      probeId: `probe-${systemClock.now().toISOString().replace(/[-:.]/g, "")}`,
      clock: systemClock,
      signal: stop.signal,
    });
    if (values.json) out(terminalJson(report));
    else {
      out(`probe ${report.probeId}: tool-result follow-up ${report.toolFollowUp}; changed prefix ${report.prefixChange}; estimate held: ${String(report.estimateHeld)}`);
      for (const step of report.steps) {
        out(`  step ${step.step}: ${step.outcome}; estimated ${step.estimatedInputTokens} input tokens; reserved ${step.reservedMicroUsd} and charged ${step.chargedMicroUsd} micro-USD`);
      }
      out(`  evidence: ${escapeTerminal(report.evidence)}`);
    }
    return 0;
  } finally {
    stop.dispose();
    await campaign.close();
  }
}
