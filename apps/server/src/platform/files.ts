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
 * Runs `task` while holding the lock for `folder`. A lock left by a crashed
 * process goes stale after 10 s. `waitMs` = 0 fails at once when busy.
 */
export async function withLock<T>(
  folder: string,
  waitMs: number,
  task: () => Promise<T>,
): Promise<T> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(folder, {
      lockfilePath: `${folder}/rufi.lock`,
      stale: 10_000,
      retries:
        waitMs > 0
          ? {
              retries: Math.ceil(waitMs / 250),
              minTimeout: 250,
              maxTimeout: 250,
            }
          : 0,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new BusyError(
        "Another Rufi sign-in command is running. Try again when it finishes.",
        {
          cause: error,
        },
      );
    }
    throw new Error(`Couldn't lock ${folder}`, { cause: error });
  }
  try {
    return await task();
  } finally {
    await release();
  }
}
