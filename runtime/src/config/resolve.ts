import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { ToolDefinition } from "../core/contracts.ts";
import { canonicalSha256, deepFreeze, sha256Hex } from "../core/hash.ts";
import { tokenEstimator } from "../core/tokens.ts";
import { observationBound } from "../core/observation.ts";
import { shellBodyTools } from "../core/tools.ts";
import { fakeScriptSchema, type FakeScript } from "../mind/fake.ts";
import { ANTHROPIC_MODELS, configSchema, trackedJobBound, type Config } from "./schema.ts";

const PLACEHOLDER = "REPLACE_WITH_";
const MAX_CONFIG_BYTES = 1 << 20;
const MAX_PROMPT_BYTES = 64 << 10;
const MAX_SCRIPT_BYTES = 16 << 20;

export interface ConfigIssue {
  /** Location such as `world.storage.inodes`, or the file for file-level problems. */
  readonly path: string;
  readonly message: string;
}

export interface ResolvedFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Configuration frozen for one episode, with every referenced file read and hashed. */
export interface ResolvedConfig {
  readonly sourcePath: string;
  readonly config: Config;
  /** Canonical hash of the configuration as written; referenced files are hashed separately. */
  readonly configSha256: string;
  readonly prompt: ResolvedFile & { readonly text: string };
  readonly fakeScript: (ResolvedFile & { readonly script: FakeScript }) | null;
  readonly tools: readonly ToolDefinition[];
  readonly toolsSha256: string;
  /** Conservative input estimate for instructions, tools, and the largest possible observation. */
  readonly fixedRequestTokens: number;
}

export type ConfigResult =
  | { readonly ok: true; readonly resolved: ResolvedConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

class FileProblem extends Error {}

function readFailure(what: string, error: unknown): FileProblem {
  return new FileProblem(`cannot read ${what}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
}

/** Reads a regular file of at most `limit` bytes. Every filesystem failure becomes a `FileProblem`. */
async function readBounded(file: string, limit: number, what: string): Promise<Buffer> {
  let handle: FileHandle;
  try {
    // Non-blocking, so naming a FIFO cannot hang validation.
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw readFailure(what, error);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new FileProblem(`${what} is not a regular file`);
    if (info.size > limit) throw new FileProblem(`${what} is ${info.size} bytes; the limit is ${limit}`);
    // Read one byte past the expected size so a file that grew after `stat` is refused, not truncated.
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new FileProblem(`${what} changed while being read`);
    return buffer.subarray(0, length);
  } catch (error) {
    throw error instanceof FileProblem ? error : readFailure(what, error);
  } finally {
    await handle.close();
  }
}

function decodeUtf8(bytes: Buffer, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new FileProblem(`${what} is not valid UTF-8`);
  }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new FileProblem(`${what} is not valid JSON: ${(error as Error).message}`);
  }
}

export function formatPath(segments: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out === "" ? "(root)" : out;
}

function zodIssues(error: z.ZodError, prefix = ""): ConfigIssue[] {
  return error.issues.map((issue) => {
    const location = formatPath(issue.path);
    return { path: prefix && location === "(root)" ? prefix : `${prefix}${prefix ? ":" : ""}${location}`, message: issue.message };
  });
}

/** Paths of string values that still contain an unfilled `REPLACE_WITH_` placeholder. */
export function findPlaceholders(value: unknown, at: PropertyKey[] = []): string[] {
  if (typeof value === "string") return value.includes(PLACEHOLDER) ? [formatPath(at)] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => findPlaceholders(item, [...at, index]));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => findPlaceholders(item, [...at, key]));
  }
  return [];
}

/**
 * Reads, validates, and freezes a configuration file. Relative file references
 * resolve against the configuration file's directory. Every problem found is
 * reported together; nothing is defaulted, repaired, or weakened.
 */
export async function loadConfig(file: string): Promise<ConfigResult> {
  const sourcePath = path.resolve(file);
  const base = path.dirname(sourcePath);

  let raw: unknown;
  try {
    raw = parseJson(decodeUtf8(await readBounded(sourcePath, MAX_CONFIG_BYTES, "configuration"), "configuration"), "configuration");
  } catch (error) {
    if (error instanceof FileProblem) return { ok: false, issues: [{ path: "(file)", message: error.message }] };
    throw error;
  }

  const placeholders = findPlaceholders(raw);
  const issues: ConfigIssue[] = placeholders.map((at) => ({ path: at, message: "unresolved placeholder" }));
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    issues.push(...zodIssues(parsed.error).filter((issue) => !placeholders.includes(issue.path)));
  }
  if (!parsed.success || issues.length > 0) return { ok: false, issues };

  const config = parsed.data;
  const fileIssue = (at: string, error: unknown): ConfigIssue => {
    if (error instanceof FileProblem) return { path: at, message: error.message };
    throw error;
  };

  let prompt: ResolvedConfig["prompt"] | null = null;
  const promptPath = path.resolve(base, config.body.prompt);
  try {
    const bytes = await readBounded(promptPath, MAX_PROMPT_BYTES, "prompt");
    const text = decodeUtf8(bytes, "prompt");
    if (text.trim().length === 0) throw new FileProblem("prompt is empty");
    prompt = { path: promptPath, sha256: sha256Hex(bytes), bytes: bytes.length, text };
  } catch (error) {
    issues.push(fileIssue("body.prompt", error));
  }

  let fakeScript: ResolvedConfig["fakeScript"] = null;
  if (config.mind.provider === "fake") {
    const scriptPath = path.resolve(base, config.mind.script);
    try {
      const bytes = await readBounded(scriptPath, MAX_SCRIPT_BYTES, "fake script");
      const result = fakeScriptSchema.safeParse(parseJson(decodeUtf8(bytes, "fake script"), "fake script"));
      if (result.success) {
        fakeScript = { path: scriptPath, sha256: sha256Hex(bytes), bytes: bytes.length, script: result.data };
      } else {
        issues.push(...zodIssues(result.error, "mind.script"));
      }
    } catch (error) {
      issues.push(fileIssue("mind.script", error));
    }
  }

  const tools = shellBodyTools({ actionWaitMs: config.body.actionWaitMs });
  const fixed = prompt === null ? null : fitCheck(config, prompt.text, tools);
  if (fixed?.issue) issues.push(fixed.issue);
  const fixedRequestTokens = fixed?.tokens ?? 0;

  if (issues.length > 0 || prompt === null) return { ok: false, issues };

  const resolved: ResolvedConfig = {
    sourcePath,
    config,
    configSha256: canonicalSha256(config),
    prompt,
    fakeScript,
    tools,
    toolsSha256: canonicalSha256(tools),
    fixedRequestTokens,
  };
  return { ok: true, resolved: deepFreeze(resolved) };
}

/** The request without history must fit the context budget with the output allowance and margin. */
function fitCheck(config: Config, promptText: string, tools: readonly ToolDefinition[]): { readonly tokens: number; readonly issue: ConfigIssue | null } {
  const estimator = tokenEstimator(config.body.tokenEstimator);
  let fixedRequestTokens: number;
  let issue: ConfigIssue | null = null;
  {
    const prompt = { text: promptText };
    // The request without history: instructions, tools, and the largest observation the sensors can produce.
    const observation = observationBound({
      trackedJobs: trackedJobBound(config.body),
      exposeContextUsage: config.body.exposeContextUsage,
    });
    fixedRequestTokens = estimator.request({
      requestId: "fit-check",
      tick: 1,
      instructions: prompt.text,
      tools,
      history: [],
      observation: "x".repeat(observation),
      maximumOutputTokens: config.mind.maximumOutputTokens,
    });
    const needed = fixedRequestTokens + config.mind.maximumOutputTokens + config.body.contextMarginTokens;
    if (needed > config.body.contextBudgetTokens) {
      issue = {
        path: "body.contextBudgetTokens",
        message:
          `the request without history (prompt, tools, and the largest possible observation) with output allowance and margin ` +
          `needs up to ${needed} tokens by ${estimator.id}; the budget is ${config.body.contextBudgetTokens}`,
      };
    }
  }
  return { tokens: fixedRequestTokens, issue };
}

const storedToolSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  parameters: z.custom<Readonly<Record<string, unknown>>>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype,
    { message: "tool parameters must be a JSON object" },
  ),
});

/**
 * Resolves a run's stored copies of its inputs (clean resume): the resolved
 * configuration, prompt, tools, and fake script exactly as the run recorded
 * them. The files the run started from are never read again. The caller
 * checks the hashes against the run's manifest.
 */
export async function loadStoredConfig(files: {
  readonly config: string;
  readonly prompt: string;
  readonly tools: string;
  readonly fakeScript: string;
}): Promise<ConfigResult> {
  const issues: ConfigIssue[] = [];
  const read = async <T>(file: string, limit: number, what: string, parse: (bytes: Buffer) => T): Promise<{ bytes: Buffer; value: T } | null> => {
    try {
      const bytes = await readBounded(file, limit, what);
      return { bytes, value: parse(bytes) };
    } catch (error) {
      if (!(error instanceof FileProblem)) throw error;
      issues.push({ path: what, message: error.message });
      return null;
    }
  };
  const config = await read(files.config, MAX_CONFIG_BYTES, "stored configuration", (bytes) => {
    const parsed = configSchema.safeParse(parseJson(decodeUtf8(bytes, "stored configuration"), "stored configuration"));
    if (!parsed.success) throw new FileProblem(`stored configuration is invalid: ${zodIssues(parsed.error)[0]?.message ?? "invalid"}`);
    return parsed.data;
  });
  const prompt = await read(files.prompt, MAX_PROMPT_BYTES, "stored prompt", (bytes) => decodeUtf8(bytes, "stored prompt"));
  const tools = await read(files.tools, MAX_CONFIG_BYTES, "stored tools", (bytes) => {
    const parsed = z.array(storedToolSchema).safeParse(parseJson(decodeUtf8(bytes, "stored tools"), "stored tools"));
    if (!parsed.success) throw new FileProblem("stored tools are invalid");
    return parsed.data;
  });
  if (config === null || prompt === null || tools === null) return { ok: false, issues };
  let fakeScript: ResolvedConfig["fakeScript"] = null;
  if (config.value.mind.provider === "fake") {
    const script = await read(files.fakeScript, MAX_SCRIPT_BYTES, "stored fake script", (bytes) => {
      const parsed = fakeScriptSchema.safeParse(parseJson(decodeUtf8(bytes, "stored fake script"), "stored fake script"));
      if (!parsed.success) throw new FileProblem("stored fake script is invalid");
      return parsed.data;
    });
    if (script === null) return { ok: false, issues };
    fakeScript = { path: files.fakeScript, sha256: sha256Hex(script.bytes), bytes: script.bytes.length, script: script.value };
  }
  const fixed = fitCheck(config.value, prompt.value, tools.value);
  if (fixed.issue !== null) return { ok: false, issues: [fixed.issue] };
  const resolved: ResolvedConfig = {
    sourcePath: files.config,
    config: config.value,
    configSha256: canonicalSha256(config.value),
    prompt: { path: files.prompt, sha256: sha256Hex(prompt.bytes), bytes: prompt.bytes.length, text: prompt.value },
    fakeScript,
    tools: tools.value,
    toolsSha256: canonicalSha256(tools.value),
    fixedRequestTokens: fixed.tokens,
  };
  return { ok: true, resolved: deepFreeze(resolved) };
}

/**
 * Reasons a valid configuration still may not spend money. Checked again
 * before any live start; an empty list is necessary, not sufficient.
 */
export function paidExecutionBlockers(config: Config): string[] {
  if (config.mind.provider === "fake") return [];
  if (config.mind.provider === "anthropic") {
    const blockers: string[] = [];
    const bound = config.mind.costBound;
    const model = ANTHROPIC_MODELS[config.mind.model];
    if (bound.inputUsdPerMillionTokens === null) blockers.push("mind.costBound.inputUsdPerMillionTokens is null");
    else if (bound.inputUsdPerMillionTokens < model.minimumInputUsdPerMillionTokens) {
      blockers.push(`mind.costBound.inputUsdPerMillionTokens is below the known ${model.minimumInputUsdPerMillionTokens} for ${config.mind.model}`);
    }
    if (bound.outputUsdPerMillionTokens === null) blockers.push("mind.costBound.outputUsdPerMillionTokens is null");
    else if (bound.outputUsdPerMillionTokens < model.minimumOutputUsdPerMillionTokens) {
      blockers.push(`mind.costBound.outputUsdPerMillionTokens is below the known ${model.minimumOutputUsdPerMillionTokens} for ${config.mind.model}`);
    }
    if (bound.verifiedOn === null) blockers.push("mind.costBound.verifiedOn is null");
    if (config.operator.campaignDirectory === undefined) blockers.push("operator.campaignDirectory is not set");
    return blockers;
  }
  const blockers: string[] = [];
  const bound = config.mind.costBound;
  if (bound.inputUsdPerMillionTokens === null) blockers.push("mind.costBound.inputUsdPerMillionTokens is null");
  if (bound.outputUsdPerMillionTokens === null) blockers.push("mind.costBound.outputUsdPerMillionTokens is null");
  if (bound.verifiedOn === null) blockers.push("mind.costBound.verifiedOn is null");
  blockers.push("the OpenAI adapter is not implemented yet (Phase 5)");
  return blockers;
}
