import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");
export const PROMPTS = path.resolve(import.meta.dirname, "../../prompts");

export type Json = Record<string, unknown>;

export async function fixtureConfig(): Promise<Json> {
  return JSON.parse(await readFile(path.join(FIXTURES, "fake.config.json"), "utf8")) as Json;
}

/** Writes a configuration with its prompt and fake script into a fresh directory. */
export async function writeConfig(config: Json): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "alife-config-"));
  await copyFile(path.join(PROMPTS, "baseline.txt"), path.join(dir, "prompt.txt"));
  await copyFile(path.join(FIXTURES, "fake-script.json"), path.join(dir, "fake-script.json"));
  const body = config.body as Json | undefined;
  if (body && body.prompt === "../../prompts/baseline.txt") body.prompt = "prompt.txt";
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify(config));
  return file;
}

/** Applies `mutate` to a copy of the valid fixture and writes it. */
export async function variant(mutate: (config: Json & { world: Json; body: Json; mind: Json; operator: Json }) => void) {
  const config = (await fixtureConfig()) as Json & { world: Json; body: Json; mind: Json; operator: Json };
  mutate(config);
  return writeConfig(config);
}
