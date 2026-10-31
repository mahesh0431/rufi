// One Claude conversation: one process of the Claude installed on this Mac,
// driven through the Claude Agent SDK under Rufi's settings, so none of the
// person's own Claude setup loads: not their CLAUDE.md, skills, plugins, MCP
// servers or claude.ai connectors (settingSources is empty, and the switches
// below cover what it doesn't). Claude gets Rufi's skills as a plugin and
// Rufi's rules after Claude Code's own prompt, as Codex keeps its own; every
// message goes as written, so a `/command` or `@file` in it is just text.
// Claude's own sub-agents, workflows, schedules and background commands are
// off: their tools aren't given. Claude works in the AI's folder under Rufi
// AI's lock-down (sandbox.ts). Rufi picks a new conversation's id, and
// carries on a kept one by it.
import { spawn, type ChildProcess } from "node:child_process";
import type { UUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  query as sdkQuery,
  type EffortLevel,
  type Options,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { killTree } from "../codex/processes.ts";
import type { AgentSandbox, AgentSkill } from "../runtime.ts";
import { within } from "./deadline.ts";
import type { InstalledClaude } from "./executable.ts";
import { claudeLockDown } from "./sandbox.ts";

/**
 * Claude's own tools the AI gets: those Rufi AI has on Codex (commands, the
 * internet, files in its folder) and Skill, for Rufi's skills. Not Task
 * (Claude's sub-agents), Workflow, the schedules or the remote triggers.
 */
const TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "WebSearch",
  "Skill",
];

/** The name Claude knows Rufi's plugin by: its skills are `rufi:<name>`. */
const PLUGIN = "rufi";

/** Claude Code's own plugins (2.1.312), off like everything not Rufi's. */
const BUILT_IN_PLUGINS = [
  "cc-plugin-agents-md",
  "cc-plugin-telemetry",
  "cc-plugin-plugin-authoring",
];

/** Rufi's choices on top of Claude's defaults, as its flag settings. */
const SETTINGS = {
  /**
   * The person's claude.ai connectors, synced skills and plugins stay
   * theirs. strictMcpConfig alone keeps the connectors out in 2.1.312; this
   * stays so that a change in either doesn't let them in.
   */
  disableClaudeAiConnectors: true,
  syncClaudeAiSkills: false,
  syncClaudeAiPlugins: false,
  /**
   * The person's other Claude sessions on this Mac can't message Rufi AI's
   * conversation (Claude's cross-session messages): only Rufi puts words in.
   */
  crossSessionInbound: "refuse",
  /** Rufi's skills only: none of Claude Code's own skills and workflows. */
  disableBundledSkills: true,
  enabledPlugins: Object.fromEntries(
    BUILT_IN_PLUGINS.map((name) => [`${name}@builtin`, false]),
  ),
} satisfies Settings;

/**
 * Set for Claude's process. A background command would outlive Stop, and
 * its end would start a turn by itself.
 */
const ENVIRONMENT = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };

/** How long Claude has to end after its session closes, before it's killed. */
const CLOSE_MS = 10_000;
/** How long Claude has to say what it loaded. */
const ASK_MS = 15_000;

/** Rufi's skills, as the plugin Claude loads, and their names in Claude. */
export interface ClaudePlugin {
  path: string;
  skills: string[];
}

/**
 * Writes Rufi's skills as a Claude plugin in Rufi's home, afresh at each
 * start, so they always match this Rufi.
 */
export async function prepareClaudePlugin(
  home: string,
  skills: readonly AgentSkill[],
): Promise<ClaudePlugin> {
  const path = join(home, "claude", "plugin");
  await rm(path, { recursive: true, force: true });
  await mkdir(join(path, ".claude-plugin"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(path, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: PLUGIN, description: "Rufi's skills." }),
    { mode: 0o600 },
  );
  for (const skill of skills) {
    const folder = join(path, "skills", skill.name);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    for (const [name, text] of [
      ["SKILL.md", skill.text],
      ...Object.entries(skill.files),
    ] as const) {
      await writeFile(join(folder, name), text, { mode: 0o600 });
    }
  }
  return { path, skills: skills.map((skill) => `${PLUGIN}:${skill.name}`) };
}

export interface ClaudeSessionOptions {
  claude: InstalledClaude;
  /** The AI's folder, Claude's working folder, and what it can never read. */
  sandbox: AgentSandbox;
  /** Claude's environment, without Rufi's secrets (platform/config.ts). */
  env: Readonly<Record<string, string>>;
  /** Rufi's rules, after Claude Code's own prompt. */
  instructions: string;
  /** An exact model id, never an alias such as `opus`, which moves. */
  model: string;
  effort?: EffortLevel;
  /** A new conversation, under the id Rufi gives it, or a kept one. */
  conversation: { start: string } | { resume: string };
  plugin: ClaudePlugin;
  query?: typeof sdkQuery;
  closeMs?: number;
}

export interface ClaudeSession {
  /**
   * What Claude says, as it comes. Read it to its end: leaving early closes
   * the session.
   */
  messages: AsyncIterable<SDKMessage>;
  /** A message, delivered as written, under Rufi's id for it. */
  send: (text: string, id: UUID) => void;
  /**
   * What Claude loaded that Rufi didn't ask for (another MCP server, a
   * CLAUDE.md, a skill or agent not Rufi's), as one line each; empty when
   * nothing. It can be asked before the first message, but MCP servers such
   * as claude.ai's connectors join a few seconds after Claude starts.
   */
  unexpected: () => Promise<string[]>;
  /** Ends the conversation's process and everything under it. */
  close: () => Promise<void>;
}

/** Opens a conversation; Claude starts at once, and nothing is sent. */
export function openClaudeSession(
  options: ClaudeSessionOptions,
): ClaudeSession {
  const query = options.query ?? sdkQuery;
  const lockDown = claudeLockDown(options.sandbox, options.plugin.path);
  const input = inputQueue();
  let child: ChildProcess | undefined;
  const run = query({
    prompt: input.messages,
    options: {
      pathToClaudeCodeExecutable: options.claude.path,
      cwd: options.sandbox.folder,
      env: { ...options.env, ...lockDown.env, ...ENVIRONMENT },
      settingSources: [],
      strictMcpConfig: true,
      tools: TOOLS,
      plugins: [{ type: "local", path: options.plugin.path }],
      skills: options.plugin.skills,
      settings: { ...SETTINGS, ...lockDown.settings },
      permissionMode: lockDown.permissionMode,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: options.instructions,
      },
      model: options.model,
      ...(options.effort && { effort: options.effort }),
      ...("start" in options.conversation
        ? { sessionId: options.conversation.start }
        : { resume: options.conversation.resume }),
      // Its own process group, so everything it starts can be ended with it.
      spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
        const spawned = spawn(command, args, {
          cwd,
          env,
          signal,
          stdio: ["pipe", "pipe", "ignore"],
          detached: true,
        });
        child = spawned;
        return spawned;
      },
    } satisfies Options,
  });
  return {
    messages: run,
    send: (text, id) => {
      input.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        uuid: id,
        client_composed: true,
      });
    },
    unexpected: async () => {
      const [servers, context] = await Promise.all([
        within(run.mcpServerStatus(), ASK_MS, "its MCP servers"),
        within(
          run.getContextUsage({ detail: "summary" }),
          ASK_MS,
          "what it loaded",
        ),
      ]);
      return [
        ...servers
          .filter((server) => server.name !== PLUGIN)
          .map((server) => `MCP server ${server.name}`),
        ...context.memoryFiles.map((file) => `instructions in ${file.path}`),
        ...(context.skills?.skillFrontmatter ?? [])
          .filter((skill) => !options.plugin.skills.includes(skill.name))
          .map((skill) => `skill ${skill.name}`),
        ...context.agents.map((agent) => `agent ${agent.agentType}`),
      ];
    },
    close: async () => {
      input.end();
      run.close();
      const pid = child?.pid;
      if (pid === undefined || child === undefined) return;
      if (await ends(child, options.closeMs ?? CLOSE_MS)) return;
      await killTree(pid);
    },
  };
}

/**
 * What Claude has at a turn's start beyond what Rufi gave it: a tool, an MCP
 * server or a plugin not Rufi's, as one line each. Rufi's own MCP server
 * and its tools are Rufi's.
 */
export function unexpectedAtStart(init: SDKSystemMessage): string[] {
  return [
    ...init.tools
      .filter(
        (tool) => !TOOLS.includes(tool) && !tool.startsWith(`mcp__${PLUGIN}__`),
      )
      .map((tool) => `tool ${tool}`),
    ...init.mcp_servers
      .filter((server) => server.name !== PLUGIN)
      .map((server) => `MCP server ${server.name}`),
    ...init.plugins
      .filter((plugin) => plugin.name !== PLUGIN)
      .map((plugin) => `plugin ${plugin.name}`),
  ];
}

/** Whether `child` has ended, or ends within `ms`. */
function ends(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Messages for Claude, as an input it reads until the session ends. */
function inputQueue() {
  const waiting: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const messages: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        while (waiting.length === 0 && !ended) {
          await new Promise<void>((resolve) => (wake = resolve));
        }
        const message = waiting.shift();
        return message === undefined
          ? { done: true, value: undefined }
          : { done: false, value: message };
      },
    }),
  };
  return {
    messages,
    push: (message: SDKUserMessage) => {
      waiting.push(message);
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
  };
}
