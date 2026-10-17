// What the live runs share (the smoke set and the reader pack): every case
// at once, one token source for them all, a new output folder per run, the
// cases' scratch data folders, and each case's status for the report.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Turn } from "@rufi/contracts";
import { ChatGptError } from "../src/agent/chatgpt/openai.ts";

/**
 * Runs every case at once, or at most `jobs` at a time, until all have
 * ended. A case that throws is that case's result; the others run on.
 */
export async function runAll<T>(
  names: readonly string[],
  jobs: number | undefined,
  run: (name: string) => Promise<T>,
): Promise<Map<string, PromiseSettledResult<T>>> {
  const results = new Map<string, PromiseSettledResult<T>>();
  let next = 0;
  const worker = async () => {
    for (let name = names[next++]; name !== undefined; name = names[next++]) {
      try {
        results.set(name, { status: "fulfilled", value: await run(name) });
      } catch (reason) {
        results.set(name, { status: "rejected", reason });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(jobs ?? names.length, names.length) },
      worker,
    ),
  );
  return results;
}

const SPARE_MS = 5 * 60_000;

/**
 * One token source for every core and reader in the run. Each sign-in
 * call takes the data folder's credentials lock with a short wait, so
 * dozens at once would time out: here one call runs at a time, and a
 * token already known to be valid long enough for the caller is reused.
 * Each call asks for SPARE_MS more than its caller needs, so the callers
 * that come soon after can share it. A reader's long job never gets a token
 * that was asked for a short chat turn. The token stays in this process's
 * memory.
 */
export function sharedToken(
  get: (validForMs: number) => Promise<string>,
): (validForMs: number) => Promise<string> {
  let held: { token: string; until: number } | undefined;
  let last: Promise<unknown> = Promise.resolve();
  const fits = (validForMs: number) =>
    held !== undefined && held.until - Date.now() >= validForMs
      ? held.token
      : undefined;
  return (validForMs) => {
    const known = fits(validForMs);
    if (known !== undefined) return Promise.resolve(known);
    const asked = last.then(async () => {
      const now = fits(validForMs);
      if (now !== undefined) return now;
      const at = Date.now();
      const token = await get(validForMs + SPARE_MS);
      held = { token, until: at + validForMs + SPARE_MS };
      return token;
    });
    last = asked.catch(() => undefined);
    return asked;
  };
}

/**
 * A new folder for the run's output: by default
 * `/tmp/rufi-<kind>-<commit>-<time>-<random>`. A folder given that isn't
 * empty is refused, so one run never mixes with another.
 */
export async function outFolder(
  kind: "smoke" | "pack",
  given?: string,
): Promise<string> {
  if (given !== undefined) {
    await mkdir(given, { recursive: true });
    if ((await readdir(given)).length > 0)
      throw new Error(`${given} isn't empty. Give a new or empty folder.`);
    return given;
  }
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const time = new Date().toISOString().slice(0, 19).replaceAll(":", "");
  return mkdtemp(`/tmp/rufi-${kind}-${commit}-${time}-`);
}

/** The run's scratch data folders not removed or kept yet. */
const scratch = new Set<string>();

/**
 * Scratch data folders for a run's cases, named `<prefix>…` in the Mac's
 * temporary folder. The run removes each when its case is done with it, and
 * any still there when the run ends, also when it crashes or is stopped
 * with Ctrl-C, so a run leaves no fictional data in the temporary folder.
 * One a case needs as evidence is moved into the run's output folder
 * instead, for the report to say where.
 */
export const scratchFolders = {
  async make(prefix: string): Promise<string> {
    watchExit();
    const folder = await mkdtemp(join(tmpdir(), prefix));
    scratch.add(folder);
    return folder;
  },
  async remove(folder: string): Promise<void> {
    await rm(folder, { recursive: true, force: true });
    scratch.delete(folder);
  },
  /** Moves `folder` to `to`, where it stays when the run ends; `to`. */
  async keep(folder: string, to: string): Promise<string> {
    await rename(folder, to).catch(async (error: unknown) => {
      // The output folder is on another disk.
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await cp(folder, to, { recursive: true });
      await rm(folder, { recursive: true, force: true });
    });
    scratch.delete(folder);
    return to;
  },
};

let watching = false;

function watchExit(): void {
  if (watching) return;
  watching = true;
  process.once("exit", () => {
    for (const folder of scratch) {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  // Without these, a signal ends the run without its exit.
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
}

/** A wait in the harness that ran out: the run's trouble, not Rufi's answer. */
export class HarnessTimeout extends Error {}

/** Ends of a reply that come from the service or the machine, not Rufi. */
const INFRA_ENDS = new Set<Turn["endReason"]>([
  "timeout",
  "usage_limit",
  "rate_limit",
  "sign_in",
  "connection",
  "provider_failed",
]);

/** How long the event loop may stall before a failure counts as the run's. */
export const STALL_MS = 2_000;

export type Status = "passed" | "FAILED" | "needs a person's verdict" | "INFRA";

/**
 * A case's status. INFRA: a timeout, a usage limit, the sign-in, the
 * provider, or a failure while the event loop stalled. FAILED: a check
 * failed or the case went wrong. A case with no real check needs a
 * person's verdict even when its checks pass.
 */
export function statusOf(outcome: {
  failed: readonly string[];
  turns: readonly Pick<Turn, "endReason" | "endText">[];
  person: boolean;
  error?: unknown;
  stalledMs?: number;
}): { status: Status; why: string } {
  const { error, failed } = outcome;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HarnessTimeout || error instanceof ChatGptError)
    return { status: "INFRA", why: message };
  const ended = outcome.turns.find((t) => INFRA_ENDS.has(t.endReason));
  if (ended)
    return {
      status: "INFRA",
      why: [`a reply ended (${String(ended.endReason)})`, ended.endText]
        .filter(Boolean)
        .join(": "),
    };
  if (error !== undefined)
    return { status: "FAILED", why: `error: ${message}` };
  if (failed.length > 0 && (outcome.stalledMs ?? 0) > STALL_MS)
    return {
      status: "INFRA",
      why: `the event loop stalled ${String(Math.round(outcome.stalledMs ?? 0))} ms; checks failed: ${failed.join(", ")}`,
    };
  if (failed.length > 0) return { status: "FAILED", why: failed.join(", ") };
  if (outcome.person) return { status: "needs a person's verdict", why: "" };
  return { status: "passed", why: "" };
}
