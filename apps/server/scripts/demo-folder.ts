// The demo folder: Rufi's data folder for `pnpm demo`, apart from every
// other. Each run resets it to the golden data set and keeps only its
// ChatGPT sign-in, so you sign in once.
import { mkdir, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { openRecord } from "../src/core/store/install.ts";
import { holdRufiLock, writePrivateJson } from "../src/platform/files.ts";
import { writeGolden } from "../tests/fixtures/golden.ts";

/** The demo folder: in your home folder, not in a checkout, so every worktree shares its sign-in. */
export const demoFolder = (home = homedir()) => join(home, "Rufi-demo");

/** Says a folder is a demo folder, so a reset never clears another one. */
const MARK = "demo.json";

/** What a reset keeps: the mark, the sign-in's registration and the lock it holds. */
const KEPT = new Set([MARK, "chatgpt.json", "rufi.lock"]);

/**
 * Resets `folder` to the golden data set, dated up to `today`. Refuses when
 * RUFI_HOME names another folder, when the folder holds files but isn't a
 * demo folder, and while Rufi runs on it. The sign-in's tokens stay in the
 * Keychain, under the registration kept here.
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
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const found = await readdir(folder);
  if (found.length > 0 && !found.includes(MARK)) {
    throw new Error(
      `${folder} isn't a demo folder, so pnpm demo won't clear it. Move it away and try again.`,
    );
  }
  let lost: Error | undefined;
  const release = await holdRufiLock(folder, (error) => {
    lost = error;
  });
  try {
    await writePrivateJson(join(folder, MARK), {
      note: "Rufi's demo folder: pnpm demo resets it each time.",
    });
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
