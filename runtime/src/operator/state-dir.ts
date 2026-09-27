import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run records and world metadata live outside the checkout and the website's
// deployment context (plan §6, §13.1), in a private directory owned by the
// operator.

export const STATE_DIR_ENV = "ALIFE_STATE_DIR";

/** Repository root, derived from this module's location in `runtime/{src,dist}/operator/`. */
export const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface StateDirChoice {
  readonly path: string;
  readonly source: "flag" | "ALIFE_STATE_DIR" | "XDG_STATE_HOME" | "home";
}

export interface StateLayout {
  readonly root: string;
  readonly runs: string;
  readonly worlds: string;
  readonly locks: string;
}

export class StateDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateDirError";
  }
}

function absolute(value: string, what: string): string {
  if (!path.isAbsolute(value)) throw new StateDirError(`${what} must be an absolute path`);
  return path.normalize(value);
}

/** Explicit flag, then `ALIFE_STATE_DIR`, then `$XDG_STATE_HOME/alife`, then `~/.local/state/alife`. */
export function chooseStateDir(options: {
  readonly flag?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}): StateDirChoice {
  if (options.flag !== undefined) return { path: absolute(options.flag, "--state-dir"), source: "flag" };
  const explicit = options.env[STATE_DIR_ENV];
  if (explicit) return { path: absolute(explicit, STATE_DIR_ENV), source: "ALIFE_STATE_DIR" };
  const xdg = options.env.XDG_STATE_HOME;
  if (xdg) return { path: path.join(absolute(xdg, "XDG_STATE_HOME"), "alife"), source: "XDG_STATE_HOME" };
  return { path: path.join(absolute(options.home, "home directory"), ".local", "state", "alife"), source: "home" };
}

/** Resolves symlinks in the longest existing prefix, so containment checks see real locations. */
async function realLocation(target: string): Promise<string> {
  const pending: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await realpath(current), ...pending.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  // Only a leading `..` component leaves `parent`; a child may be named `..state`.
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return !escapes;
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new StateDirError(`${directory} is a symbolic link`);
  if (!info.isDirectory()) throw new StateDirError(`${directory} is not a directory`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new StateDirError(`${directory} is not owned by the current user`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new StateDirError(
      `${directory} is accessible to other users (mode ${(info.mode & 0o777).toString(8)}); run: chmod 700 '${directory}'`,
    );
  }
}

/**
 * Creates or verifies the private state layout. Refuses locations inside the
 * repository and never loosens or tightens existing permissions itself.
 */
export async function prepareStateDir(
  directory: string,
  options: { readonly forbiddenRoots?: readonly string[] } = {},
): Promise<StateLayout> {
  const root = absolute(directory, "state directory");
  const real = await realLocation(root);
  for (const forbidden of options.forbiddenRoots ?? [REPOSITORY_ROOT]) {
    const forbiddenReal = await realLocation(forbidden);
    if (isWithin(real, forbiddenReal)) {
      throw new StateDirError(`state directory ${root} is inside ${forbidden}; choose a location outside the repository`);
    }
  }

  const layout: StateLayout = {
    root,
    runs: path.join(root, "runs"),
    worlds: path.join(root, "worlds"),
    locks: path.join(root, "locks"),
  };
  for (const entry of [layout.root, layout.runs, layout.worlds, layout.locks]) await privateDirectory(entry);
  return layout;
}
