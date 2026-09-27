#!/usr/bin/env node
import { parseArgs } from "node:util";

import { loadConfig, paidExecutionBlockers } from "./config/resolve.ts";
import { runtimeIdentity } from "./records/manifest.ts";
import { escapeTerminal, terminalJson } from "./operator/terminal.ts";
import { campaignCommand, lockCommand, observeCommand, probeCommand, runCommand } from "./operator/run-commands.ts";
import { CommandUsageError, doctor, isRefusal, userPath, worldCommand, type Output } from "./operator/world-commands.ts";

// Only implemented commands are listed (plan §14).

const USAGE = `Usage: alife <command> [options]

Commands:
  config validate <file> [--json]   Check a configuration without side effects.
  doctor --docker-context <name> [--config <file>] [--json]
                                    Report engine capabilities without changing anything.
  world create --config <file> --docker-context <name>
                                    Create and seed a new world's storage (unprivileged).
  world inspect <world-id>          Show a world's records and resources; read-only.
  world attach <world-id> --allow-privileged-helper
                                    Attach storage and verify its identity.
  world stop <world-id>             Stop a running world container; storage stays attached.
  world capture <world-id> --label <label> [--allow-privileged-helper]
                                    Archive a stopped world's files read-only.
  world detach <world-id> --allow-privileged-helper
                                    Unbind a stopped world's storage from its loop device.
  world destroy <world-id> --confirm <world-id> --allow-privileged-helper
                                    Remove a stopped world's storage and resources; keep records.
  run start --world <world-id> --config <file> [--allow-privileged-helper]
                                    Run one episode in the foreground, guarded by an independent
                                    watchdog armed before the world starts. A paid mind is also
                                    admitted against its configured spending campaign. The
                                    stopped world is captured before and after. SIGINT or SIGTERM
                                    stops it cleanly, aborting a model request in flight; a
                                    dispatched shell action finishes its wait first.
  run stop <run-id>                 Ask a run's live controller to stop, through its authenticated
                                    local control endpoint; never signals a process, never retries.
  run resume <run-id> [--allow-privileged-helper]
                                    Continue a cleanly stopped run in a new supervised process, with
                                    its stored inputs, history, accounting, and original deadline.
                                    Nothing is replayed; anything uncertain refuses.
  run status <run-id>               Show a run's recorded state, its watchdog evidence, and any
                                    unknown outcomes; read-only.
  run finalize <run-id> --acknowledge-uncertainty
                                    Close an interrupted or review-required run, recording what
                                    remains unknown; a finalized run cannot be resumed.
  run capture <run-id> --label <label> [--allow-privileged-helper]
                                    Archive a stopped world's files for a run that is not running,
                                    and associate the archive with it. Never stops a world.
  run export <run-id> --output <new-dir> [--maximum-bytes <n>] [--maximum-files <n>]
                                    Copy a run's records and associated archives into a new private
                                    directory with a hashed inventory. Not a publication approval.
  observe list <run-id> --archive <archive-id>
                                    List an associated archive's verified index; nothing is extracted.
  observe read <run-id> --archive <archive-id> (<path> | --path-base64 <b64>) [--offset <n>] [--length <n>]
                                    Read a bounded byte range of one regular file in an archive.
  campaign create --directory <absolute-dir> --limit-usd <dollars> [--json]
                                    Create the shared Phase 5 spending campaign (phase5-smoke-v1),
                                    at most $100. Never resets or raises an existing campaign.
  campaign status --directory <absolute-dir> [--json]
                                    Show a campaign's limit, spending, and outstanding holds;
                                    read-only, and never creates one.
  probe anthropic --config <file> --output <new-dir> --confirm-paid
                                    Run the synthetic compatibility probe: at most 3 paid requests,
                                    $20 and 30 minutes, within the shared campaign; never retried.
  lock status world|run <id>        Show who holds a lock, including its token.
  lock release world|run <id> --token <token>
                                    Remove a lock left by a controller that is no longer running.
  version                           Print runtime and Node.js versions.
  help                              Show this message.

World, run, observe, and lock commands accept --state-dir <dir> and --json. The privileged storage
helper runs only with --allow-privileged-helper; nothing escalates implicitly.

Exit status: 0 success, 1 invalid input or refused operation, 2 usage error,
3 internal error.`;

class UsageError extends Error {}

async function configValidate(args: string[], out: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1) throw new UsageError("config validate takes exactly one file");
  const file = userPath(positionals[0]!);
  const result = await loadConfig(file);

  if (values.json) {
    const report = result.ok
      ? {
          valid: true,
          file,
          configSha256: result.resolved.configSha256,
          promptSha256: result.resolved.prompt.sha256,
          toolsSha256: result.resolved.toolsSha256,
          fixedRequestTokens: result.resolved.fixedRequestTokens,
          paidExecutionBlockers: paidExecutionBlockers(result.resolved.config),
        }
      : { valid: false, file, issues: result.issues };
    out(terminalJson(report));
    return result.ok ? 0 : 1;
  }

  if (!result.ok) {
    out(`invalid: ${escapeTerminal(file)}`);
    for (const issue of result.issues) out(`  ${escapeTerminal(issue.path)}: ${escapeTerminal(issue.message)}`);
    return 1;
  }
  const { resolved } = result;
  out(`valid: ${escapeTerminal(file)}`);
  out(`  config sha256: ${resolved.configSha256}`);
  out(`  prompt sha256: ${resolved.prompt.sha256}`);
  out(`  mind: ${resolved.config.mind.provider}`);
  out(`  fixed request estimate: ${resolved.fixedRequestTokens} of ${resolved.config.body.contextBudgetTokens} tokens`);
  for (const blocker of paidExecutionBlockers(resolved.config)) {
    out(`  paid execution blocked: ${escapeTerminal(blocker)}`);
  }
  return 0;
}

export async function main(argv: string[], out: Output = console.log, err: Output = console.error): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(USAGE);
        return command === undefined ? 2 : 0;
      case "version":
      case "--version": {
        const identity = await runtimeIdentity();
        out(`${identity.package} ${identity.version} (Node.js ${identity.node}, ${identity.platform}/${identity.arch})`);
        return 0;
      }
      case "config": {
        const [sub, ...args] = rest;
        if (sub === "validate") return await configValidate(args, out);
        throw new UsageError(`unknown config command ${JSON.stringify(sub ?? "")}`);
      }
      case "doctor":
        return await doctor(rest, out);
      case "world":
        return await worldCommand(rest, out);
      case "run":
        return await runCommand(rest, out, err);
      case "lock":
        return await lockCommand(rest, out);
      case "observe":
        return await observeCommand(rest, out);
      case "campaign":
        return await campaignCommand(rest, out);
      case "probe":
        return await probeCommand(rest, out, err);
      default:
        throw new UsageError(`unknown command ${JSON.stringify(command)}`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof CommandUsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      err(`alife: ${escapeTerminal((error as Error).message)}\n\n${USAGE}`);
      return 2;
    }
    if (isRefusal(error)) {
      err(`alife: ${escapeTerminal((error as Error).message)}`);
      return 1;
    }
    // Expected problems are reported as issues; anything reaching here is a runtime defect.
    err(`alife: internal error: ${escapeTerminal(error instanceof Error ? error.message : String(error))}`);
    return 3;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
