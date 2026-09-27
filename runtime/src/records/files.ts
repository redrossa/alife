import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import path from "node:path";

// Durable, write-once files for records. Nothing written here is ever
// replaced: a name that exists already is an error, not an overwrite.

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writes a file durably under a name that must not exist yet: the content is
 * synced under a temporary name, then hard-linked into place, which fails
 * rather than replacing an existing file.
 */
export async function writeNewFile(file: string, content: string | Uint8Array): Promise<void> {
  await writeNewFiles([[file, content]]);
}

/**
 * `writeNewFile` for several files at once: the contents are synced
 * concurrently, and each directory involved is synced once after every name
 * is in place. Fails if any name exists; files already placed stay.
 */
export async function writeNewFiles(files: readonly (readonly [string, string | Uint8Array])[]): Promise<void> {
  const placed = await Promise.allSettled(
    files.map(async ([file, content]) => {
      const temporary = `${file}.${process.pid}.tmp`;
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await handle.writeFile(content);
        // An empty file has no contents to flush; its name is made durable with the directory below.
        if (content.length > 0) await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, file);
      } finally {
        await unlink(temporary);
      }
    }),
  );
  await Promise.all([...new Set(files.map(([file]) => path.dirname(file)))].map((directory) => syncDirectory(directory)));
  const failure = placed.find((result) => result.status === "rejected");
  if (failure !== undefined) throw failure.reason;
}
