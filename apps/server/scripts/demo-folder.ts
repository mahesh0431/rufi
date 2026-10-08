// The demo folder: Rufi's data folder for `pnpm demo`, apart from every
// other. Each run resets it to the golden data set and keeps only its
// ChatGPT sign-in, so you sign in once.
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { openRecord } from "../src/core/store/install.ts";
import { holdRufiLock, writePrivateJson } from "../src/platform/files.ts";
import { writeGolden } from "../tests/fixtures/golden.ts";

/** The demo folder: in your home folder, not in a checkout, so every worktree shares its sign-in. */
export const demoFolder = (home = homedir()) => join(home, "Rufi-demo");

/**
 * Says a folder is a demo folder, so a reset never clears another one: a
 * file with exactly this content, which only a reset writes.
 */
const MARK = "demo.json";
const markFor = (folder: string) => ({ kind: "rufi-demo-folder", folder });

/** What a reset keeps: the mark, the sign-in's registration and the lock it holds. */
const KEPT = new Set([MARK, "chatgpt.json", "rufi.lock"]);

/**
 * Resets `folder` to the golden data set, dated up to `today`. Refuses when
 * RUFI_HOME names another folder, when the folder holds files but isn't a
 * demo folder, when it or one of its own files is a link (a reset deletes
 * only inside the folder), and while Rufi runs on it. The sign-in's tokens
 * stay in the Keychain, under the registration kept here.
 */
export async function resetDemo(
  folder: string,
  env: NodeJS.ProcessEnv,
  today: Date,
): Promise<void> {
  const asked = env["RUFI_HOME"]?.trim();
  if (asked && resolve(asked) !== folder) {
    throw new Error(
      `pnpm demo uses only its own folder, ${folder}, and RUFI_HOME is ${asked}. Unset RUFI_HOME and try again.`,
    );
  }
  if (!(await lstat(folder).catch(missing))) {
    await mkdir(folder, { mode: 0o700 });
  }
  // Checked before the lock is made in it, and again once it is held.
  await checkDemo(folder);
  let lost: Error | undefined;
  const release = await holdRufiLock(folder, (error) => {
    lost = error;
  });
  try {
    await checkDemo(folder);
    await writePrivateJson(join(folder, MARK), markFor(folder));
    // rm removes a link deeper inside without following it.
    for (const name of await readdir(folder)) {
      if (!KEPT.has(name)) {
        await rm(join(folder, name), { recursive: true, force: true });
      }
    }
    const store = await openRecord(folder);
    try {
      await writeGolden(folder, store, today);
    } finally {
      store.close();
    }
    if (lost) {
      throw new Error("The demo folder's lock was lost during the reset.", {
        cause: lost,
      });
    }
  } finally {
    await release();
  }
}

/**
 * Refuses a folder a reset mustn't clear: a link, one that holds files
 * without the mark, and one whose own files include a link.
 */
async function checkDemo(folder: string): Promise<void> {
  if (!(await lstat(folder)).isDirectory()) {
    throw new Error(
      `${folder} is a link or a file, not a folder, so pnpm demo won't use it. Move it away and try again.`,
    );
  }
  const names = await readdir(folder);
  // The lock is the reset's own.
  if (names.every((name) => name === "rufi.lock")) return;
  if (!(await marked(folder))) {
    throw new Error(
      `${folder} isn't a demo folder that pnpm demo made, so it won't clear it. Move it away and try again.`,
    );
  }
  for (const name of names) {
    const path = join(folder, name);
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(
        `${path} is a link, so pnpm demo won't clear the folder. Move it away and try again.`,
      );
    }
  }
}

/** Whether the folder holds the mark a reset wrote for it, as a plain file. */
async function marked(folder: string): Promise<boolean> {
  const path = join(folder, MARK);
  if (!(await lstat(path).catch(missing))?.isFile()) return false;
  try {
    const found: unknown = JSON.parse(await readFile(path, "utf8"));
    return isDeepStrictEqual(found, markFor(folder));
  } catch (error) {
    // Not JSON: not the mark.
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/** Undefined for a path that isn't there; any other failure stands. */
function missing(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}
