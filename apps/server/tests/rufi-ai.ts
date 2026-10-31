// Rufi AI on the agent package, as the core starts it, for a test that
// opens the chat itself (server/chat.ts).
import type { ProviderAdapter } from "@rufi/agents/provider";
import { openAgentStore } from "@rufi/agents/store";
import { continuesAfterRestart } from "../src/core/chat/continues.ts";
import { DEFAULT_SHORTLIST } from "../src/core/chat/models.ts";
import type { Transcripts } from "../src/core/chat/transcript.ts";
import type { Store } from "../src/core/store/database.ts";
import { agentsPath } from "../src/server/agents.ts";
import { aiSandbox } from "../src/server/core.ts";
import { startRufiAi } from "../src/server/rufi-ai.ts";

export async function rufiAiFor(options: {
  home: string;
  record: Store;
  transcripts: Transcripts;
  adapter: ProviderAdapter;
  /** More providers, after the first. */
  others?: readonly ProviderAdapter[];
  tools: readonly string[];
}) {
  const store = openAgentStore(agentsPath(options.home));
  const system = await startRufiAi({
    store,
    record: options.record,
    transcripts: options.transcripts,
    adapters: [options.adapter, ...(options.others ?? [])],
    tools: options.tools,
    cwd: aiSandbox(options.home).folder,
    model: DEFAULT_SHORTLIST[0] ?? "",
    log: () => undefined,
  });
  return {
    agent: system.rufiAi,
    agents: system.agents,
    logs: system.logs,
    usage: system.usage,
    refreshModels: system.refreshModels,
    /** As the core does once the chat is open. */
    dispatch: async () =>
      system.agents.dispatch({
        continues: await continuesAfterRestart(options.transcripts.setting),
      }),
    close: async () => {
      await system.close();
      store.close();
    },
  };
}
