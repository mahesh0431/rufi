// The Claude adapter meets the provider boundary, on the scripted Claude
// (tests/fake-claude.ts). scripts/claude-live.ts runs it on the installed
// Claude.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerContract } from "@rufi/agents/contract";
import { describe, expect, it, vi } from "vitest";
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

describe("Claude's process for a conversation", () => {
  it("closes when a turn ends, and the next turn carries the conversation on in a new one", async () => {
    const folder = await mkdtemp(join(tmpdir(), "rufi-claude-adapter-"));
    const fake = fakeClaude({});
    const opens: { sessionId?: string; resume?: string }[] = [];
    const query = ((args: Parameters<typeof fake.query>[0]) => {
      opens.push({ ...args.options });
      return fake.query(args);
    }) as typeof fake.query;
    const adapter = claudeAdapter({
      claude: { path: "/fictional/claude", version: "2.1.312" },
      sandbox: { folder, unreadable: [] },
      env: {},
      plugin: { path: folder, skills: [] },
      query,
      sessions: fake.sessions,
    });
    const ends: string[] = [];
    const conversation = await adapter.open({
      cwd: folder,
      instructions: "Answer briefly.",
      model: "claude-fictional-1",
      effort: "low",
      tools: { url: "http://127.0.0.1:9/mcp", key: "key-1" },
      onEvent: (event) => {
        if (event.type === "turnEnded") ends.push(event.turn);
      },
    });
    for (const id of ["message-1", "message-2"]) {
      expect(
        await conversation.startTurn({
          input: { id, parts: ["What was Asha's last TSH?"] },
          model: "claude-fictional-1",
          effort: "low",
        }),
      ).toEqual({ status: "delivered" });
      await vi.waitFor(() => {
        expect(ends).toHaveLength(id === "message-1" ? 1 : 2);
      });
    }
    await adapter.close();

    expect(
      opens.map(({ sessionId, resume }) => ({ sessionId, resume })),
    ).toEqual([
      { sessionId: conversation.ref, resume: undefined },
      { sessionId: undefined, resume: conversation.ref },
    ]);
  });
});
