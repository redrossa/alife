import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { z } from "zod";

import { sha256Hex } from "../core/hash.ts";

// Run manifest (plan §10, "Recorded identity"): everything needed to say what
// ran, without secrets. Written once when a run is created (Phase 3).

// Version 2 follows configuration schema 2 (job policy instead of timeout policy).
// No version 1 manifest was ever written.
export const MANIFEST_SCHEMA_VERSION = 2;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const runtimeIdentitySchema = z.strictObject({
  package: z.string(),
  version: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
});

const sourceIdentitySchema = z.strictObject({
  revision: z.string().nullable(),
  dirty: z.boolean().nullable(),
  /** Hash of `git status` and the tracked-file diff; untracked file contents are not covered. */
  dirtySha256: sha256.nullable(),
});

export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  runId: z.string(),
  worldId: z.string(),
  createdAt: z.iso.datetime(),
  runtime: runtimeIdentitySchema,
  source: sourceIdentitySchema,
  config: z.strictObject({
    sha256,
    promptSha256: sha256,
    toolsSha256: sha256,
    fakeScriptSha256: sha256.nullable(),
  }),
  profiles: z.strictObject({
    storage: z.string(),
    container: z.string(),
    capture: z.string(),
    ipc: z.string(),
    body: z.string(),
    sensors: z.string(),
    jobPolicy: z.string(),
    outputTruncation: z.string(),
    contextPolicy: z.string(),
    tokenEstimator: z.string(),
    retry: z.string(),
    logging: z.string(),
    network: z.string(),
  }),
  world: z.strictObject({
    image: z.string(),
    imageArchitecture: z.string(),
    seed: z.string(),
    seedSha256: sha256,
    requestedCapacityMiB: z.int(),
    effectiveCapacityBytes: z.int(),
    effectiveInodes: z.int(),
  }),
  engine: z.strictObject({
    dockerContext: z.string(),
    engineId: z.string(),
    version: z.string(),
    apiVersion: z.string(),
    os: z.string(),
    architecture: z.string(),
    kernel: z.string(),
    cgroupVersion: z.string(),
    securityOptions: z.array(z.string()),
  }),
  mind: z.strictObject({
    adapter: z.string(),
    provider: z.string(),
    model: z.string().nullable(),
    sdkVersion: z.string().nullable(),
  }),
  /** Observer metadata; never agent input. */
  trial: z.strictObject({ groupId: z.string(), trialId: z.string() }).nullable(),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;

export async function runtimeIdentity(): Promise<RuntimeIdentity> {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    name: string;
    version: string;
  };
  return {
    package: pkg.name,
    version: pkg.version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

const run = promisify(execFile);

/** Source revision of the checkout containing `directory`, or nulls when Git cannot say. */
export async function sourceIdentity(directory: string): Promise<SourceIdentity> {
  const git = async (...args: string[]) =>
    (
      await run("git", ["-C", directory, ...args], {
        encoding: "buffer",
        maxBuffer: 64 << 20,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0" },
      })
    ).stdout;
  // The three reads are independent; the diff is used only when the status shows changes.
  const [revision, status, diff] = await Promise.allSettled([git("rev-parse", "HEAD"), git("status", "--porcelain=v1", "-z"), git("diff", "HEAD", "--binary")]);
  if (revision.status === "rejected" || status.status === "rejected") return { revision: null, dirty: null, dirtySha256: null };
  const head = revision.value.toString("utf8").trim();
  if (status.value.length === 0) return { revision: head, dirty: false, dirtySha256: null };
  if (diff.status === "rejected") return { revision: null, dirty: null, dirtySha256: null };
  return { revision: head, dirty: true, dirtySha256: sha256Hex(Buffer.concat([status.value, Buffer.from([0]), diff.value])) };
}
