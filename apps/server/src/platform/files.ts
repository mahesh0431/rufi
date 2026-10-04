import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/** Writes JSON readable only by this user, replacing the file in one step. */
export async function writePrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

class BusyError extends Error {}

/**
 * Rufi's two locks, folders in the data folder. Whoever needs both takes
 * `rufi.lock` first.
 * - `rufi.lock`: held for its whole life by the running Rufi, or by a
 *   terminal command, so only one of them uses the data folder at a time.
 * - `credentials.lock`: held briefly while the sign-in is changed or renewed.
 * A lock left by a crashed process goes stale after 10 s.
 */
const STALE_MS = 10_000;

async function lock(
  folder: string,
  name: "rufi" | "credentials",
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
 * Runs `task` while holding `credentials.lock`. `waitMs` = 0 fails at once
 * when it's taken.
 */
export async function withCredentialsLock<T>(
  folder: string,
  waitMs: number,
  task: () => Promise<T>,
): Promise<T> {
  const release = await lock(
    folder,
    "credentials",
    waitMs,
    "Another Rufi sign-in command is running. Try again when it finishes.",
  );
  try {
    return await task();
  } finally {
    await release();
  }
}
