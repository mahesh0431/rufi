// The Claude installed on this Mac, which the Claude Agent SDK drives. Rufi
// ships no Claude of its own. Claude signs in by itself (`claude auth
// login`) in its folder in the data folder (CLAUDE_CONFIG_DIR), where it
// keeps and renews its sign-in and its conversations. Rufi finds it, checks
// it's new enough, starts its sign-in, and asks whether it is signed in and
// with what kind of sign-in, never whose.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, constants, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import {
  query as sdkQuery,
  type AccountInfo,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { within } from "./deadline.ts";

/**
 * The oldest Claude Rufi runs: the one its Claude adapter was tried with.
 * Rufi relies on how this version handles composed messages, MCP
 * registration, steering and interrupts, and on each turn's start naming
 * the messages it took.
 */
const CLAUDE_FLOOR = "2.1.314";

/**
 * Claude's folder in the data folder (CLAUDE_CONFIG_DIR): its settings,
 * sign-in and conversations. Claude finds its sign-in by the folder's path,
 * so it is never moved.
 */
export const claudeFolder = (home: string) => join(home, "claude");

/**
 * Claude's environment: the child's (platform/config.ts), with its folder.
 * Rufi's own process sets the folder too, as Claude's session functions
 * run in it.
 */
export const claudeEnvironment = (
  home: string,
  env: Readonly<Record<string, string>>,
): Record<string, string> => ({
  ...env,
  CLAUDE_CONFIG_DIR: claudeFolder(home),
});

/** A Claude Rufi may run: where it is, and its version. */
export interface InstalledClaude {
  path: string;
  version: string;
}

/** No Claude on this Mac. */
export class ClaudeMissing extends Error {
  constructor() {
    super(
      "Claude Code isn't installed on this Mac. Install it, then try again.",
    );
  }
}

/** A Claude older than Rufi's floor. */
export class ClaudeTooOld extends Error {
  constructor(version: string) {
    super(
      `Claude Code ${version} is older than Rufi needs (${CLAUDE_FLOOR}). Update it with: claude update`,
    );
  }
}

/** Where Claude's installers put `claude`, after PATH. */
const installPlaces = (home: string) => [
  join(home, ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

const VERSION_MS = 10_000;

/**
 * The installed Claude: the first `claude` on PATH, else in an installer's
 * usual place, checked like Rufi's own Codex (an executable nobody else can
 * change) and no older than CLAUDE_FLOOR. Rufi's server may run without the
 * person's shell PATH, hence the usual places.
 */
export async function findClaude(
  env: NodeJS.ProcessEnv = process.env,
  places: readonly string[] = installPlaces(env["HOME"] ?? homedir()),
): Promise<InstalledClaude> {
  const folders = [
    ...(env["PATH"] ?? "").split(delimiter).filter((folder) => folder !== ""),
    ...places,
  ];
  for (const folder of folders) {
    const path = join(folder, "claude");
    if (!(await isExecutable(path))) continue;
    const mode = (await stat(path)).mode;
    if ((mode & 0o022) !== 0) {
      throw new Error(
        `${path} can be changed by other users, so Rufi won't run it.`,
      );
    }
    const version = await versionOf(path);
    if (olderThan(version, CLAUDE_FLOOR)) throw new ClaudeTooOld(version);
    return { path, version };
  }
  throw new ClaudeMissing();
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    // Not there, or not runnable: look in the next place.
    return false;
  }
}

async function versionOf(path: string): Promise<string> {
  const { stdout } = await promisify(execFile)(path, ["--version"], {
    timeout: VERSION_MS,
  });
  const version = /^(\d+\.\d+\.\d+)/.exec(stdout.trim())?.[1];
  if (version === undefined) {
    throw new Error(`${path} didn't say its version.`);
  }
  return version;
}

function olderThan(version: string, floor: string): boolean {
  const parts = (text: string) => text.split(".").map(Number);
  const [a, b] = [parts(version), parts(floor)];
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

/** What kind of sign-in Claude has: never who, never the plan's details. */
export type ClaudeSignIn = "subscription" | "api key" | "none";

const ASK_MS = 15_000;

/** The kind of sign-in an account shows. */
export function signInOf(account: AccountInfo): ClaudeSignIn {
  if (account.subscriptionType) return "subscription";
  if (account.apiKeySource && account.apiKeySource !== "none") {
    return "api key";
  }
  return "none";
}

/** Asks the installed Claude how it's signed in; see askClaude. */
export function claudeSignIn(
  claude: InstalledClaude,
  options: AskOptions,
): Promise<ClaudeSignIn> {
  return askClaude(claude, options, async (run) =>
    signInOf(await within(run.accountInfo(), ASK_MS, "how it's signed in")),
  );
}

/**
 * Whether Claude is signed in, as `claude auth status` says, never whose.
 * `env` names Claude's folder (claudeEnvironment). Aborting `signal` ends
 * it; it settles once Claude's process has exited.
 */
export async function claudeSignedIn(
  claude: InstalledClaude,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<boolean> {
  const asked = promisify(execFile)(claude.path, ["auth", "status", "--json"], {
    env,
    timeout: ASK_MS,
    ...(signal && { signal }),
  });
  // Signed out, it exits 1 and still says so.
  const { stdout } = await asked.catch(async (error: unknown) => {
    // Node settles an aborted call at once: wait until Claude has exited.
    if (signal?.aborted) {
      await exitOf(asked.child);
      throw error;
    }
    const said = (error as { stdout?: unknown }).stdout;
    if (typeof said === "string" && said.trim() !== "") return { stdout: said };
    throw error;
  });
  return (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true;
}

/** How long a stopped Claude process may take to exit before it's killed. */
const EXIT_MS = 5_000;

/** Settles once `child` has exited; one still running after EXIT_MS is killed. */
async function exitOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const late = setTimeout(() => child.kill("SIGKILL"), EXIT_MS);
  await exited;
  clearTimeout(late);
}

/**
 * Claude's own sign-in, `claude auth login`: Claude opens the browser and
 * waits for it. Its link goes to `showLink` when Claude shows one; resolves
 * once Claude is signed in. Aborting `signal` ends it.
 */
export function claudeLogIn(
  claude: InstalledClaude,
  env: Record<string, string>,
  handlers: { showLink: (link: string) => void; signal: AbortSignal },
): Promise<void> {
  const login = spawn(claude.path, ["auth", "login", "--claudeai"], {
    env,
    signal: handlers.signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  let shown = false;
  for (const stream of [login.stdout, login.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      said = (said + chunk).slice(-4_000);
      const link = /https:\/\/\S+/.exec(said)?.[0];
      if (link !== undefined && !shown) {
        shown = true;
        handlers.showLink(link);
      }
    });
  }
  return new Promise((resolve, reject) => {
    login.on("error", (error) => {
      // Node reports a cancel at once: it settles on the exit below, once
      // Claude has exited (killed if it hasn't after EXIT_MS).
      if (handlers.signal.aborted) void exitOf(login);
      else reject(error);
    });
    login.on("exit", (code) => {
      if (code === 0) resolve();
      else {
        const last = said.trim().split("\n").at(-1);
        reject(new Error(last || "Claude's sign-in didn't finish."));
      }
    });
  });
}

export interface AskOptions {
  /** Where the asking session runs; nothing is written there. */
  cwd: string;
  /** Claude's environment, without Rufi's secrets (platform/config.ts). */
  env: Record<string, string>;
  query?: typeof sdkQuery;
}

/**
 * Asks the installed Claude something through the SDK, without sending a
 * message: a session is opened with none of the person's Claude setup and
 * no tools, asked, and closed.
 */
export async function askClaude<T>(
  claude: InstalledClaude,
  options: AskOptions,
  ask: (run: Query) => Promise<T>,
): Promise<T> {
  const query = options.query ?? sdkQuery;
  const closed = new AbortController();
  const run = query({
    prompt: silence(closed.signal),
    options: {
      pathToClaudeCodeExecutable: claude.path,
      cwd: options.cwd,
      env: options.env,
      settingSources: [],
      tools: [],
      strictMcpConfig: true,
      persistSession: false,
      settings: { disableClaudeAiConnectors: true },
    },
  });
  try {
    return await ask(run);
  } finally {
    closed.abort();
    run.close();
  }
}

/** An input that sends nothing until `signal` ends it, so no turn starts. */
function silence(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve({ done: true, value: undefined });
            },
            { once: true },
          );
        }),
    }),
  };
}
