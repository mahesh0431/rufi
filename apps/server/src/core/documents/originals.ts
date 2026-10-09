// Where the bytes of documents live in the data folder. An original is kept
// in files/<sha256> exactly as it came, written and synced before any row
// points to it. A display copy (HEIC → JPEG) is a cache in cache/display/:
// made again when missing, never backed up.
import { constants } from "node:fs";
import { copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../../platform/files.ts";

export const filesPath = (home: string) => join(home, "files");
export const originalPath = (home: string, id: string) =>
  join(filesPath(home), id);
export const displayPath = (home: string, id: string) =>
  join(home, "cache", "display", `${id}.jpg`);

/** A file id is the sha256 of its bytes, in hex: nothing else is a path. */
export const isFileId = (id: string) => /^[0-9a-f]{64}$/.test(id);

/** Writes and syncs a file, its folder too, then puts it in place in one step. */
async function writeSynced(path: string, bytes: Uint8Array): Promise<void> {
  const folder = join(path, "..");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  const dir = await open(folder, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/** Keeps an original under its id. The same bytes again replace themselves. */
export const keepOriginal = (home: string, id: string, bytes: Uint8Array) =>
  writeSynced(originalPath(home, id), bytes);

/** Keeps a display copy; it's a cache, so it needs no sync of its own. */
export const keepDisplay = (home: string, id: string, bytes: Uint8Array) =>
  writeSynced(displayPath(home, id), bytes);

/** A file in `from` that isn't there, or isn't the bytes its id names. */
export class OriginalMissing extends Error {}

/**
 * Copies the original `id` from the folder `fromFolder` into `toFolder` (a
 * clone where the disk allows, else a normal copy), then checks the copy is
 * the bytes its id names: its size and its hash.
 */
export async function copyOriginal(
  fromFolder: string,
  toFolder: string,
  id: string,
  size: number,
): Promise<void> {
  const from = join(fromFolder, id);
  const to = join(toFolder, id);
  try {
    await copyFile(
      from,
      to,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new OriginalMissing(`The document file ${id} is missing.`, {
        cause: error,
      });
    }
    throw error;
  }
  await checkOriginal(toFolder, id, size, true);
}

/**
 * Checks the file `id` in `folder` is there with its size and, when `deep`,
 * its hash. Throws OriginalMissing when it isn't.
 */
export async function checkOriginal(
  folder: string,
  id: string,
  size: number,
  deep: boolean,
): Promise<void> {
  const path = join(folder, id);
  const found = await stat(path).catch(() => undefined);
  if (found?.size !== size || (deep && (await sha256(path)) !== id)) {
    throw new OriginalMissing(`The document file ${id} is missing or changed.`);
  }
}
