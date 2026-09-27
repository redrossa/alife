// Generator for the draft `sparse-v1` seed (plan §10). It writes a
// deterministic synthetic numerical CSV and a short collection of unrelated
// descriptive text fragments. There is no task, instruction, puzzle, broken
// script, or intended solution; the materials can be analysed, reorganised,
// transformed, used for something else, or ignored.
//
// This seed is a draft until the pilot freeze: regenerate with
// `node world/seeds/sparse-v1/generate.ts` from `runtime/`, which rewrites
// `files/` and the entries in `seed.json`. A unit test checks that the
// committed files are exactly this generator's output.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Fixed PRNG seed, so every generation is byte-identical. */
const PRNG_SEED = 0x5eed_0001;
const ROWS = 240;

// mulberry32: small, well-known, and fully specified here.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function csv(): string {
  const random = mulberry32(PRNG_SEED);
  const lines = ["index,a,b,c"];
  for (let index = 0; index < ROWS; index++) {
    const a = random();
    // Sum of three uniforms: a rounded, bell-like distribution around zero.
    const b = (random() + random() + random() - 1.5) * 4;
    const c = Math.floor(random() * 100);
    lines.push(`${index},${a.toFixed(4)},${b.toFixed(4)},${c}`);
  }
  return `${lines.join("\n")}\n`;
}

const FRAGMENTS = [
  "A slate roof after rain holds water in its seams longer than on its faces. The darker lines follow the overlaps and fade from the ridge downward as the slates dry.",
  "Lichen on the north side of the wall is pale green. On the south side it is orange and grows in smaller, rounder patches.",
  "The ferry crossing takes eleven minutes in calm weather. Gulls follow the wake for the first half and then turn back toward the pier.",
  "A wooden spoon left in a pot of soup warms slowly along its handle. The end nearest the pot becomes too hot to hold before the far end is warm.",
  "At the edge of the field, a line of poplars leans slightly east. Their leaves show silver undersides whenever the wind rises.",
  "The market opens before sunrise. Crates of oranges are stacked by the entrance, and the first stalls are lit by battery lamps.",
];

function fragments(): string {
  return `${FRAGMENTS.join("\n\n")}\n`;
}

/** Relative path to contents, in archive order. */
export function generateSparseV1(): ReadonlyMap<string, Buffer> {
  return new Map([
    ["materials/fragments.txt", Buffer.from(fragments(), "utf8")],
    ["materials/measurements.csv", Buffer.from(csv(), "utf8")],
  ]);
}

async function main(): Promise<void> {
  const root = import.meta.dirname;
  const files = generateSparseV1();
  await rm(path.join(root, "files"), { recursive: true, force: true });
  const entries: unknown[] = [{ path: "materials", type: "directory", mode: "0755" }];
  for (const [relative, content] of files) {
    await mkdir(path.dirname(path.join(root, "files", relative)), { recursive: true });
    await writeFile(path.join(root, "files", relative), content);
    entries.push({
      path: relative,
      type: "file",
      mode: "0644",
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  const manifestPath = path.join(root, "seed.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.entries = entries;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) await main();
