// Rufi's Codex settings, in one place. Everything not listed here is Codex's
// standard behaviour, its sign-in too: Codex's own ChatGPT login, kept and
// renewed by Codex in CODEX_HOME. Codex sees none of the user's own setup:
// CODEX_HOME is Rufi's (so no ~/.codex), and the app-server process gets its
// own HOME (so no
// personal skills from ~/.agents/skills), while the agent's commands still get
// the real HOME. The skills are Rufi's own, written into CODEX_HOME at each
// start; Codex's bundled ones are off. MCP servers arrive one by one, chosen
// here (PLAN.md §3.1): today only Rufi's own, given to each thread
// (mcpServers). The chat's AI works in its folder, sandboxed by one named
// permission profile (aiProfile, docs/adr/0016).
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSandbox, AgentSkill, McpServer } from "../runtime.ts";
import type { ConfigReadResponse } from "./protocol/v2/ConfigReadResponse.ts";
import type { ExperimentalFeatureListResponse } from "./protocol/v2/ExperimentalFeatureListResponse.ts";
import type { Rpc } from "./rpc.ts";

/** Rufi's choices on top of Codex's defaults, each with its reason. */
const SETTINGS = {
  /** Medium effort for chat: better answers matter more than the speed of low. */
  model_reasoning_effort: "medium",
  /** Codex's own prompt stays, without a personality: Rufi's words set the tone. */
  personality: "none",
  /**
   * Rufi keeps the AI's reasoning summaries with the reply (docs/adr/0004);
   * Codex asks the model for none unless set (0.163.0).
   */
  model_reasoning_summary: "detailed",
  features: {
    /** Rufi starts and ends app-server itself; nothing keeps running after it. */
    daemon_auto_start: false,
    /**
     * No plugin catalogs or connectors: they'd only be downloaded. Chosen
     * ones come later.
     */
    plugins: false,
    apps: false,
    /**
     * No Codex sub-agents: Rufi's own start_agent is the one kind
     * (docs/adr/0026). On, it would bring their tools back regardless.
     */
    multi_agent_v2: false,
  },
} as const;

/**
 * The permission profile the chat's AI runs under: Codex's workspace profile
 * (it writes in its working folder, the AI's folder, and the temp folders;
 * it reads the rest), with the network on and Rufi's unreadable paths
 * denied. Threads select it by name; the legacy sandbox setting has no
 * denied reads.
 */
export const AI_PROFILE = "rufi-ai";

const key = (path: string) => JSON.stringify(path);

function aiProfile(sandbox: AgentSandbox, skills: string): string {
  const entries = [
    `${key(sandbox.folder)} = "write"`,
    // The data folder may itself be under a writable temp root.
    `${key(skills)} = "read"`,
    ...sandbox.unreadable.map((path) => `${key(path)} = "deny"`),
  ];
  return `
[permissions.${AI_PROFILE}]
extends = ":workspace"

[permissions.${AI_PROFILE}.filesystem]
${entries.join("\n")}

[permissions.${AI_PROFILE}.network]
enabled = true
`;
}

/**
 * What the agent's commands get set on top of their environment: the user's
 * real HOME, and caches in the AI's folder, the only place they can write
 * (on macOS, pip's and matplotlib's own are in HOME). Never a secret.
 */
function commandsEnvironment(options: CodexHomeOptions): string {
  const cache = options.sandbox && join(options.sandbox.folder, ".cache");
  const set = [
    ...(options.userHome === undefined
      ? []
      : [`HOME = ${key(options.userHome)}`]),
    ...(cache === undefined
      ? []
      : [
          `XDG_CACHE_HOME = ${key(cache)}`,
          `PIP_CACHE_DIR = ${key(join(cache, "pip"))}`,
          `MPLCONFIGDIR = ${key(join(cache, "matplotlib"))}`,
        ]),
  ];
  return set.length === 0
    ? ""
    : `\n# The real HOME, and caches where the commands can write.\n[shell_environment_policy.set]\n${set.join("\n")}\n`;
}

function configToml(options: CodexHomeOptions, skills: string): string {
  const features = Object.entries(SETTINGS.features)
    .map(([name, on]) => `${name} = ${String(on)}`)
    .join("\n");
  // Top-level keys first: in TOML, a key after [features] belongs to it.
  return `# Written by Rufi on every start from src/agent/codex/settings.ts.
model_reasoning_effort = "${SETTINGS.model_reasoning_effort}"
model_reasoning_summary = "${SETTINGS.model_reasoning_summary}"
personality = "${SETTINGS.personality}"
# A thread Rufi lets go of (to give it new instructions) closes at once.
thread_unload_delay_secs = 0
${options.sandbox ? `default_permissions = "${AI_PROFILE}"\n` : ""}
[features]
${features}

# Only Rufi's skills: none of Codex's own.
[skills.bundled]
enabled = false

# No Codex sub-agents (spawn_agent and its tools): Rufi starts its own.
[agents]
enabled = false

# The agent's commands get no variable named like a secret (*KEY*, *SECRET*,
# *TOKEN*); Codex itself runs with none.
[shell_environment_policy]
ignore_default_excludes = false
${commandsEnvironment(options)}${options.sandbox ? aiProfile(options.sandbox, skills) : ""}`;
}

export interface CodexHomeOptions {
  /** The user's real HOME, for the agent's commands. */
  userHome?: string | undefined;
  /** The AI's folder and what its commands may never read. */
  sandbox?: AgentSandbox;
  /** Rufi's skills, written into CODEX_HOME/skills. */
  skills?: readonly AgentSkill[];
}

export interface CodexPaths {
  /** CODEX_HOME: Codex's config, skills and threads. */
  codexHome: string;
  /** HOME for the app-server process only, so it finds none of the user's setup. */
  processHome: string;
}

/**
 * Where Codex saves the images it generates, one folder per thread
 * (CODEX_HOME/generated_images, 0.159.3); replies show them.
 */
export const generatedImages = (home: string) =>
  join(home, "codex", "generated_images");

/**
 * Writes Rufi's CODEX_HOME and creates the folders Codex uses: the skills
 * are written again from Rufi's copy, so they always match this Rufi, and
 * the AI's folder is made when there is one.
 */
export async function prepareCodexHome(
  home: string,
  options: CodexHomeOptions,
): Promise<CodexPaths> {
  const paths = {
    codexHome: join(home, "codex"),
    processHome: join(home, "codex", "home"),
  };
  for (const dir of [
    ...Object.values(paths),
    ...(options.sandbox ? [options.sandbox.folder] : []),
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const skills = join(paths.codexHome, "skills");
  await rm(skills, { recursive: true, force: true });
  for (const skill of options.skills ?? []) {
    await mkdir(join(skills, skill.name), { recursive: true, mode: 0o700 });
    for (const [name, text] of [
      ["SKILL.md", skill.text],
      ...Object.entries(skill.files),
    ] as const) {
      await writeFile(join(skills, skill.name, name), text, { mode: 0o600 });
    }
  }
  await writeFile(
    join(paths.codexHome, "config.toml"),
    configToml(options, skills),
    {
      mode: 0o600,
    },
  );
  return paths;
}

/**
 * Checks Codex applied the settings Rufi can't do without (the effort, what
 * runs), so a renamed key in a new pin fails loudly instead of
 * being ignored. The style settings (personality, reasoning summaries) aren't
 * checked: without them the chat still works.
 */
export async function checkSettings(
  rpc: Rpc,
  timeoutMs: number,
): Promise<void> {
  const { config }: ConfigReadResponse = await rpc.request(
    "config/read",
    {},
    timeoutMs,
  );
  const problems: string[] = [];
  if (config.model_reasoning_effort !== SETTINGS.model_reasoning_effort) {
    problems.push(
      `model_reasoning_effort is ${String(config.model_reasoning_effort)}`,
    );
  }
  const enabled = new Map<string, boolean>();
  let cursor: string | null = null;
  do {
    const page: ExperimentalFeatureListResponse = await rpc.request(
      "experimentalFeature/list",
      { cursor },
      timeoutMs,
    );
    for (const feature of page.data) enabled.set(feature.name, feature.enabled);
    cursor = page.nextCursor;
  } while (cursor);
  for (const [name, wanted] of Object.entries<boolean>(SETTINGS.features)) {
    const actual = enabled.get(name);
    if (actual !== wanted) {
      problems.push(
        `${name} is ${actual === undefined ? "unknown" : actual ? "on" : "off"}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Codex didn't take Rufi's settings: ${problems.join("; ")}.`,
    );
  }
}

/** The name Codex knows Rufi's MCP server by, in the chat and the reader. */
export const RUFI_SERVER = "rufi";

/**
 * Codex cuts a tool's input schema over this to `unknown` before the model
 * sees it (5,000 bytes unless set, 0.159.3). Rufi's largest, save_changes, is
 * about 19 KB: it is kept whole, and the code runner's declaration uses it.
 */
const SCHEMA_MAX_BYTES = 64 * 1024;

/**
 * A thread's MCP settings: Rufi's server with the thread's key. Codex can't
 * start the thread without it (`required`), runs its tools without asking
 * (with approvals off it would refuse a tool that isn't read-only), and gives
 * up on a call a little after Rufi's own deadline for it. Codex defers an MCP
 * server's tools: the model finds them first (in exec's ALL_TOOLS, or with
 * tool_search on a direct model). `eager` gives them to the model at once.
 */
export function mcpServers(server: McpServer, toolMs: number, eager = false) {
  return {
    [RUFI_SERVER]: {
      url: server.url,
      http_headers: { Authorization: `Bearer ${server.key}` },
      required: true,
      default_tools_approval_mode: "approve",
      startup_timeout_sec: 10,
      tool_timeout_sec: Math.ceil(toolMs / 1000) + 10,
      tool_input_schema_max_bytes: SCHEMA_MAX_BYTES,
      ...(eager && { omit_tools_from: ["deferred"] }),
    },
  };
}
