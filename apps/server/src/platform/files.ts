import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

/** Reads a JSON file, or undefined when it doesn't exist. */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Couldn't read ${path}`, { cause: error });
  }
}

/**
 * A temp file beside `path`, to rename onto it: its own name each time, so
 * two writes of the same file at the same time never share one.
 */
export const tempPath = (path: string) => `${path}.${randomUUID()}.tmp`;

/** Every temp file tempPath gives for `path`, as a glob. */
export const tempPattern = (path: string) => `${path}.*.tmp`;

/**
 * Writes JSON readable only by this user, replacing the file in one step.
 * The file and the folder's new entry are on the disk when it returns.
 */
export async function writePrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = tempPath(path);
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncFolder(dirname(path));
}

/** Puts a folder's entries (a new, renamed or removed file) on the disk. */
export async function syncFolder(path: string): Promise<void> {
  const folder = await open(path, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

/** Puts a file's bytes on the disk; a read-only file too. */
export async function syncFile(path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** The sha256 of a file's bytes, in hex. */
export async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

class BusyError extends Error {}

/**
 * Rufi's locks, folders. Whoever needs both takes them in this order:
 * `location.lock`, then `rufi.lock`.
 * - `location.lock`: beside the location file, held while Rufi finds its
 *   data folder (and makes it, at the first start) or moves it.
 * - `rufi.lock`: in the data folder, held for its whole life by the running
 *   Rufi, or by a terminal command, so only one of them uses the data
 *   folder at a time.
 * A lock left by a crashed process goes stale after 10 s.
 */
const STALE_MS = 10_000;

async function lock(
  folder: string,
  name: "location" | "rufi",
  waitMs: number,
  busy: string,
  onLost?: (error: Error) => void,
): Promise<() => Promise<void>> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  try {
    // proper-lockfile keeps its locks by this path: one per lock, so the two
    // locks don't replace each other. Nothing needs to exist there.
    return await lockfile.lock(`${folder}/${name}`, {
      realpath: false,
      lockfilePath: `${folder}/${name}.lock`,
      stale: STALE_MS,
      retries:
        waitMs > 0
          ? {
              retries: Math.ceil(waitMs / 250),
              minTimeout: 250,
              maxTimeout: 250,
            }
          : 0,
      ...(onLost && { onCompromised: onLost }),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new BusyError(busy, { cause: error });
    }
    throw new Error(`Couldn't lock ${folder}`, { cause: error });
  }
}

/**
 * Takes `rufi.lock` until the returned function releases it. `onLost` is
 * called if it is lost while held (its folder removed, or not refreshed in
 * time), so the holder can stop writing at once.
 */
export function holdRufiLock(
  folder: string,
  onLost: (error: Error) => void,
): Promise<() => Promise<void>> {
  return lock(
    folder,
    "rufi",
    0,
    "Rufi is already running with this data folder, or another Rufi command is. Quit it first, then try again.",
    onLost,
  );
}

/**
 * Runs `task` while holding `location.lock` in `folder`, where the location
 * file is; waits up to `waitMs` for it.
 */
export async function withLocationLock<T>(
  folder: string,
  waitMs: number,
  task: () => Promise<T>,
): Promise<T> {
  const release = await lock(
    folder,
    "location",
    waitMs,
    "Another Rufi command is finding or moving Rufi's data folder. Try again when it finishes.",
  );
  try {
    return await task();
  } finally {
    await release();
  }
}
