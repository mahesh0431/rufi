// Rufi's Codex settings, in one place. Everything not listed here is Codex's
// standard behaviour. Skills, plugins and MCP servers aren't decided yet
// (PLAN.md §3.1): for now Codex's own defaults apply, and because CODEX_HOME
// is Rufi's, nothing from the user's ~/.codex is loaded.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigReadResponse } from "./protocol/v2/ConfigReadResponse.ts";
import type { ExperimentalFeatureListResponse } from "./protocol/v2/ExperimentalFeatureListResponse.ts";
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
  /** PLAN.md §3.1: answers can use current information from the web. */
  web_search: "live",
  /** PLAN.md §3.1: low effort for chat, for faster replies. */
  model_reasoning_effort: "low",
  features: {
    /** Rufi starts and ends app-server itself; nothing keeps running after it. */
    daemon_auto_start: false,
  },
} as const;

function configToml(): string {
  const features = Object.entries(SETTINGS.features)
    .map(([name, on]) => `${name} = ${String(on)}`)
    .join("\n");
  // Top-level keys first: in TOML, a key after [features] belongs to it.
  return `# Written by Rufi on every start from src/agent/codex/settings.ts.
model_provider = "openai_chatgpt_plan"
web_search = "${SETTINGS.web_search}"
model_reasoning_effort = "${SETTINGS.model_reasoning_effort}"

[features]
${features}

${PROVIDER}
`;
}

/** Writes Rufi's CODEX_HOME and creates the agent's working folder. */
export async function prepareCodexHome(
  home: string,
): Promise<{ codexHome: string; workspace: string }> {
  const codexHome = join(home, "codex");
  const workspace = join(home, "workspace");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(join(codexHome, "config.toml"), configToml(), {
    mode: 0o600,
  });
  return { codexHome, workspace };
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
  if (config.web_search !== SETTINGS.web_search) {
    problems.push(`web_search is ${String(config.web_search)}`);
  }
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
