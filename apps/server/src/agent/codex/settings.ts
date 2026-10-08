// Rufi's Codex settings, in one place. Everything not listed here is Codex's
// standard behaviour. Codex sees none of the user's own setup: CODEX_HOME is
// Rufi's (so no ~/.codex), and the app-server process gets its own HOME (so no
// personal skills from ~/.agents/skills), while the agent's commands still get
// the real HOME. MCP servers arrive one by one, chosen here (PLAN.md §3.1).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigReadResponse } from "./protocol/v2/ConfigReadResponse.ts";
import type { ExperimentalFeatureListResponse } from "./protocol/v2/ExperimentalFeatureListResponse.ts";
import type { ModelProviderCapabilitiesReadResponse } from "./protocol/v2/ModelProviderCapabilitiesReadResponse.ts";
import type { Rpc } from "./rpc.ts";

/**
 * OpenAI's documented settings for ChatGPT plan use through app-server
 * (developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
 */
const PROVIDER = `[model_providers.openai_chatgpt_plan]
name = "ChatGPT plan"
base_url = "https://api.openai.com/v1"
env_key = "ACCESS_TOKEN"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false`;

/** Rufi's choices on top of Codex's defaults, each with its reason. */
const SETTINGS = {
  /** Medium effort for chat: better answers matter more than the speed of low. */
  model_reasoning_effort: "medium",
  /**
   * Rufi keeps the AI's reasoning summaries with the reply (docs/adr/0004);
   * Codex's models send none unless asked.
   */
  model_reasoning_summary: "detailed",
  features: {
    /** Rufi starts and ends app-server itself; nothing keeps running after it. */
    daemon_auto_start: false,
    /**
     * No plugin catalogs or connectors: they'd only be downloaded, and
     * connectors don't work with ChatGPT plan sign-in. Chosen ones come later.
     */
    plugins: false,
    apps: false,
  },
} as const;

function configToml(userHome: string | undefined): string {
  const features = Object.entries(SETTINGS.features)
    .map(([name, on]) => `${name} = ${String(on)}`)
    .join("\n");
  // Top-level keys first: in TOML, a key after [features] belongs to it.
  return `# Written by Rufi on every start from src/agent/codex/settings.ts.
model_provider = "openai_chatgpt_plan"
model_reasoning_effort = "${SETTINGS.model_reasoning_effort}"
model_reasoning_summary = "${SETTINGS.model_reasoning_summary}"

[features]
${features}

${PROVIDER}
${
  userHome === undefined
    ? ""
    : `
# The agent's commands run with the user's real HOME.
[shell_environment_policy.set]
HOME = ${JSON.stringify(userHome)}
`
}`;
}

export interface CodexPaths {
  /** CODEX_HOME: Codex's config and threads. */
  codexHome: string;
  /** HOME for the app-server process only, so it finds none of the user's setup. */
  processHome: string;
  /** Where the agent works. */
  workspace: string;
}

/** Writes Rufi's CODEX_HOME and creates the folders Codex uses. */
export async function prepareCodexHome(
  home: string,
  userHome: string | undefined,
): Promise<CodexPaths> {
  const paths = {
    codexHome: join(home, "codex"),
    processHome: join(home, "codex", "home"),
    workspace: join(home, "workspace"),
  };
  for (const dir of Object.values(paths)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await writeFile(join(paths.codexHome, "config.toml"), configToml(userHome), {
    mode: 0o600,
  });
  return paths;
}

/**
 * Checks Codex applied Rufi's settings, so a renamed key in a new pin fails
 * loudly instead of being ignored.
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
  if (config.model_provider !== "openai_chatgpt_plan") {
    problems.push(`model_provider is ${String(config.model_provider)}`);
  }
  if (config.model_reasoning_effort !== SETTINGS.model_reasoning_effort) {
    problems.push(
      `model_reasoning_effort is ${String(config.model_reasoning_effort)}`,
    );
  }
  if (config.model_reasoning_summary !== SETTINGS.model_reasoning_summary) {
    problems.push(
      `model_reasoning_summary is ${String(config.model_reasoning_summary)}`,
    );
  }
  // Without namespace support Codex drops Rufi's tools without a word.
  const capabilities: ModelProviderCapabilitiesReadResponse = await rpc.request(
    "modelProvider/capabilities/read",
    {},
    timeoutMs,
  );
  if (!capabilities.namespaceTools) {
    problems.push("the provider doesn't take Rufi's tools (namespaceTools)");
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
