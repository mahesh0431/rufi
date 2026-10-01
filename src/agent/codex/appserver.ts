// One Codex app-server child process, started as OpenAI documents for ChatGPT
// plan use, and checked before Rufi uses it.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { FEATURES } from "./features.ts";
import { killTree } from "./processes.ts";
import type { InitializeParams } from "./protocol/InitializeParams.ts";
import type { ExperimentalFeature } from "./protocol/v2/ExperimentalFeature.ts";
import type { ExperimentalFeatureListResponse } from "./protocol/v2/ExperimentalFeatureListResponse.ts";
import type { HooksListResponse } from "./protocol/v2/HooksListResponse.ts";
import type { ListMcpServerStatusResponse } from "./protocol/v2/ListMcpServerStatusResponse.ts";
import type { SkillsConfigWriteResponse } from "./protocol/v2/SkillsConfigWriteResponse.ts";
import type { SkillsListResponse } from "./protocol/v2/SkillsListResponse.ts";
import { connect, type Rpc, type RpcHandlers } from "./rpc.ts";

/** How to run Codex: the pinned binary in the app, a scripted fake in tests. */
export interface CodexCommand {
  file: string;
  args: readonly string[];
}

export interface Deadlines {
  /** initialize, thread start/resume, the turn/start acknowledgement, checks. */
  requestMs: number;
  /** A whole turn. */
  turnMs: number;
  /** Stop: for Codex to acknowledge the interrupt, then for the turn to end. */
  interruptAckMs: number;
  interruptEndMs: number;
  /** Rufi's own answers to Codex's requests. */
  answerMs: number;
}

export const DEADLINES: Deadlines = {
  requestMs: 30_000,
  turnMs: 5 * 60_000,
  interruptAckMs: 5_000,
  interruptEndMs: 10_000,
  answerMs: 30_000,
};

export interface AppServer {
  rpc: Rpc;
  /** The access token this process was started with. */
  token: string;
  running: () => boolean;
  /** Ends app-server and every program it started. */
  stop: () => Promise<void>;
}

export interface StartOptions {
  command: CodexCommand;
  /** The child's whole environment, apart from CODEX_HOME and ACCESS_TOKEN. */
  env: Readonly<Record<string, string>>;
  codexHome: string;
  token: string;
  version: string;
  deadlines: Deadlines;
  handlers: RpcHandlers;
  onExit: (why: Error) => void;
}

export async function startAppServer(
  options: StartOptions,
): Promise<AppServer> {
  const child = spawn(
    options.command.file,
    [...options.command.args, "app-server", "--listen", "stdio://"],
    {
      env: {
        ...options.env,
        CODEX_HOME: options.codexHome,
        ACCESS_TOKEN: options.token,
      },
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so Stop can end it with everything it started.
      detached: true,
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  const rpc = connect(
    child.stdout,
    child.stdin,
    options.handlers,
    options.deadlines.answerMs,
  );
  const exited = Promise.withResolvers<undefined>();
  let running = true;
  const ended = (why: Error) => {
    if (!running) return;
    running = false;
    rpc.close(why);
    options.onExit(why);
    exited.resolve(undefined);
  };
  child.on("exit", (code, signal) => {
    ended(
      new Error(`Codex stopped (${String(code ?? signal)}).`, {
        cause: new Error(stderr),
      }),
    );
  });
  child.on("error", (error) => {
    ended(new Error("Couldn't start Codex.", { cause: error }));
  });

  const stop = async () => {
    if (running && child.pid !== undefined) await killTree(child.pid);
    await Promise.race([exited.promise, sleep(5_000)]);
  };
  try {
    const params: InitializeParams = {
      // The name matches the agent_name_hint sent when Rufi registers.
      clientInfo: { name: "Rufi", title: "Rufi", version: options.version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    await rpc.request("initialize", params, options.deadlines.requestMs);
    rpc.notify("initialized");
    await checkFeatures(rpc, undefined, options.deadlines.requestMs);
  } catch (error) {
    await stop();
    throw error;
  }
  return { rpc, token: options.token, running: () => running, stop };
}

/** Refuses Codex unless its feature flags are exactly Rufi's list. */
export async function checkFeatures(
  rpc: Rpc,
  threadId: string | undefined,
  timeoutMs: number,
): Promise<void> {
  const features: ExperimentalFeature[] = [];
  let cursor: string | null = null;
  do {
    const page: ExperimentalFeatureListResponse = await rpc.request(
      "experimentalFeature/list",
      { cursor, threadId },
      timeoutMs,
    );
    features.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  const problems = featureProblems(features);
  if (problems.length > 0) {
    throw new Error(
      `Codex isn't set up the way Rufi needs: ${problems.join("; ")}.`,
    );
  }
}

export function featureProblems(
  features: readonly Pick<ExperimentalFeature, "name" | "stage" | "enabled">[],
): string[] {
  const problems: string[] = [];
  for (const { name, stage, enabled } of features) {
    if (stage === "removed") continue; // no longer does anything
    const wanted = FEATURES[name];
    if (wanted === undefined) {
      problems.push(`${name} is a feature Rufi's list doesn't name`);
    } else if (enabled !== wanted) {
      problems.push(`${name} is ${enabled ? "on" : "off"}`);
    }
  }
  return problems;
}

/**
 * Checks a thread before use: its feature flags, no skills offered, and no MCP
 * servers or hooks, which a project config in the working folder could add.
 */
export async function checkThread(
  rpc: Rpc,
  threadId: string,
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  await checkFeatures(rpc, threadId, timeoutMs);
  const skills: SkillsListResponse = await rpc.request(
    "skills/list",
    { cwds: [cwd], forceReload: true },
    timeoutMs,
  );
  for (const skill of skills.data.flatMap((entry) => entry.skills)) {
    if (!skill.enabled) continue;
    const written: SkillsConfigWriteResponse = await rpc.request(
      "skills/config/write",
      { path: skill.path, enabled: false },
      timeoutMs,
    );
    if (written.effectiveEnabled) {
      throw new Error(`Codex wouldn't turn off the skill ${skill.name}.`);
    }
  }
  const mcp: ListMcpServerStatusResponse = await rpc.request(
    "mcpServerStatus/list",
    {},
    timeoutMs,
  );
  if (mcp.data.length > 0) {
    throw new Error(
      `Codex has MCP servers set up (${mcp.data.map((server) => server.name).join(", ")}); Rufi doesn't allow them.`,
    );
  }
  const hooks: HooksListResponse = await rpc.request(
    "hooks/list",
    { cwds: [cwd] },
    timeoutMs,
  );
  if (hooks.data.some((entry) => entry.hooks.length > 0)) {
    throw new Error("Codex has hooks set up; Rufi doesn't allow them.");
  }
}
