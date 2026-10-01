// The config.toml Rufi writes into its own CODEX_HOME before every start.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FEATURES } from "./features.ts";

/**
 * OpenAI's documented settings for ChatGPT plan use through app-server
 * (developers.openai.com/siwc/token-sharing-open-source/codex-app-server),
 * plus Rufi's capability choices: live web search, low effort, no skills.
 */
function configToml(): string {
  const features = Object.entries(FEATURES)
    .map(([name, on]) => `${name} = ${String(on)}`)
    .join("\n");
  return `# Written by Rufi on every start; edits here are replaced.
model_provider = "openai_chatgpt_plan"
model_reasoning_effort = "low"
web_search = "live"

[model_providers.openai_chatgpt_plan]
name = "ChatGPT plan"
base_url = "https://api.openai.com/v1"
env_key = "ACCESS_TOKEN"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false

# Skills aren't feature flags. Discovered skills are also disabled per thread.
[skills]
include_instructions = false

[skills.bundled]
enabled = false

[features]
${features}
`;
}

/** Prepares Rufi's CODEX_HOME and the agent's working folder. */
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
