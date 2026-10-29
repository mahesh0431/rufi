// The Claude adapter meets the provider boundary, on the scripted Claude
// (tests/fake-claude.ts). scripts/claude-live.ts runs it on the installed
// Claude.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerContract } from "@rufi/agents/contract";
import { fakeClaude } from "../../../tests/fake-claude.ts";
import { claudeAdapter } from "./adapter.ts";

providerContract("Claude", {
  setUp: async (script) => {
    const folder = await mkdtemp(join(tmpdir(), "rufi-claude-adapter-"));
    const fake = fakeClaude(script);
    return {
      adapter: claudeAdapter({
        claude: { path: "/fictional/claude", version: "2.1.312" },
        sandbox: { folder, unreadable: [] },
        env: {},
        plugin: { path: folder, skills: [] },
        query: fake.query,
        sessions: fake.sessions,
        startMs: 500,
        stopMs: 500,
      }),
      options: {
        cwd: folder,
        model: "claude-fictional-1",
        effort: "low",
        tools: { url: "http://127.0.0.1:9/mcp", key: "key-1" },
      },
    };
  },
  callMeta: () => Promise.resolve({}),
  cannot: {
    lostSteer:
      "a steer has no reply to lose: it stays with Claude until Claude shows what became of it",
  },
  pending: {
    placed: "Rufi's tools on Claude come next",
    closedTurn: "Rufi's tools on Claude come next",
    pictures: "Claude's steps come with its items",
  },
});
