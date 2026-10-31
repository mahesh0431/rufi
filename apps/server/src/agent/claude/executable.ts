// The Claude installed on this Mac, which the Claude Agent SDK drives. Rufi
// ships no Claude of its own and, for now, no Claude sign-in or API-key
// setting: Claude uses whatever sign-in it has. Rufi only finds it, checks
// it's new enough, and asks what kind of sign-in it has, never whose.
import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import {
  query as sdkQuery,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * The oldest Claude Rufi runs: the one its Claude adapter was tried with.
 * Rufi relies on how this version handles composed messages, MCP
 * registration, steering and interrupts.
 */
const CLAUDE_FLOOR = "2.1.312";

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

const SIGN_IN_MS = 15_000;

/**
 * Asks the installed Claude how it's signed in, through the SDK, without
 * sending a message: a session is opened with none of the person's Claude
 * setup and no tools, asked, and closed.
 */
export async function claudeSignIn(
  claude: InstalledClaude,
  options: {
    /** Where the asking session runs; nothing is written there. */
    cwd: string;
    /** Claude's environment, without Rufi's secrets (platform/config.ts). */
    env: Record<string, string>;
    query?: typeof sdkQuery;
  },
): Promise<ClaudeSignIn> {
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
  let timer: NodeJS.Timeout | undefined;
  try {
    const account = await Promise.race([
      run.accountInfo(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Claude didn't say how it's signed in."));
        }, SIGN_IN_MS);
      }),
    ]);
    if (account.subscriptionType) return "subscription";
    if (account.apiKeySource && account.apiKeySource !== "none") {
      return "api key";
    }
    return "none";
  } finally {
    clearTimeout(timer);
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
