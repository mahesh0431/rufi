// What the live runs share (the smoke set and the reader pack): every case
// at once, the test sign-in for them all, a new output folder per run, the
// cases' scratch data folders, and each case's status for the report.
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Turn } from "@rufi/contracts";
import { DEADLINES } from "../src/agent/codex/appserver.ts";
import type { GetAccountResponse } from "../src/agent/codex/protocol/v2/GetAccountResponse.ts";
import { connect } from "../src/agent/codex/rpc.ts";
import { SignedOut } from "../src/agent/runtime.ts";
import { childEnvironment } from "../src/platform/config.ts";

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

/**
 * The test sign-in for every case of a run: Codex's own ChatGPT sign-in in
 * `home/codex` (RUFI_HOME). Codex renews it there first, so that no case's
 * copy needs renewing during the run (two copies renewing at once would end
 * it): `give` copies it into a case's data folder, `take` removes the copy
 * when the case ends. Fails, with how to sign in, when Codex isn't signed in.
 */
export async function testSignIn(home: string, codex: string) {
  const codexHome = join(home, "codex");
  const child = spawn(codex, ["app-server", "--listen", "stdio://"], {
    env: { ...childEnvironment(), CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    const rpc = connect(
      child.stdout,
      child.stdin,
      {
        request: () => Promise.reject(new Error("no requests expected")),
        notification: () => undefined,
        ignored: () => undefined,
      },
      DEADLINES.answerMs,
    );
    await rpc.request(
      "initialize",
      {
        clientInfo: { name: "Rufi", title: "Rufi", version: "0.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      DEADLINES.requestMs,
    );
    rpc.notify("initialized");
    const { account } = await rpc.request<GetAccountResponse>(
      "account/read",
      { refreshToken: true },
      DEADLINES.requestMs,
    );
    if (account?.type !== "chatgpt") {
      throw new SignedOut(
        `Codex isn't signed in to ChatGPT in ${home}. Sign in: RUFI_HOME=${home} pnpm rufi signin codex`,
      );
    }
  } finally {
    child.kill();
  }
  const file = (folder: string) => join(folder, "codex", "auth.json");
  return {
    give: async (caseHome: string) => {
      await mkdir(join(caseHome, "codex"), { recursive: true, mode: 0o700 });
      await copyFile(file(home), file(caseHome));
    },
    take: (caseHome: string) => rm(file(caseHome), { force: true }),
  };
}

export type TestSignIn = Awaited<ReturnType<typeof testSignIn>>;

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

/**
 * Runs a case on a scratch data folder of its own, `<prefix>…` in the Mac's
 * temporary folder. The folder is removed once the case has ended and
 * `passed` says it passed. After any other ending (a failure, an error, a
 * crash) it stays where it is, as the evidence: `kept` names it, and so does
 * the error the case threw.
 */
export async function onScratch<T>(
  prefix: string,
  run: (home: string) => Promise<T>,
  passed: (result: T) => boolean,
): Promise<{ result: T; kept: string | undefined }> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  let result: T;
  try {
    result = await run(home);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} (data folder: ${home})`,
      { cause: error },
    );
  }
  if (!passed(result)) return { result, kept: home };
  await rm(home, { recursive: true, force: true });
  return { result, kept: undefined };
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
  if (error instanceof HarnessTimeout || error instanceof SignedOut)
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
