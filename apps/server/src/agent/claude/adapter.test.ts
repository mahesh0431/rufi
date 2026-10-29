// The Claude adapter meets the provider boundary, on the scripted Claude
// (tests/fake-claude.ts). scripts/claude-live.ts runs it on the installed
// Claude.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerContract } from "@rufi/agents/contract";
import type { ProviderEvent } from "@rufi/agents/provider";
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

/** The adapter on a scripted Claude, and how to open a conversation. */
async function onFake(
  query: ReturnType<typeof fakeClaude>["query"],
  sessions: ReturnType<typeof fakeClaude>["sessions"],
  more: { stopMs?: number } = {},
) {
  const folder = await mkdtemp(join(tmpdir(), "rufi-claude-adapter-"));
  const adapter = claudeAdapter({
    claude: { path: "/fictional/claude", version: "2.1.312" },
    sandbox: { folder, unreadable: [] },
    env: {},
    plugin: { path: folder, skills: [] },
    query,
    sessions,
    ...more,
  });
  const events: ProviderEvent[] = [];
  const conversation = await adapter.open({
    cwd: folder,
    instructions: "Answer briefly.",
    model: "claude-fictional-1",
    effort: "low",
    tools: { url: "http://127.0.0.1:9/mcp", key: "key-1" },
    onEvent: (event) => {
      events.push(event);
    },
  });
  const start = (id: string) =>
    conversation.startTurn({
      input: { id, parts: ["What was Asha's last TSH?"] },
      model: "claude-fictional-1",
      effort: "low",
    });
  const ends = () =>
    events.flatMap((event) => (event.type === "turnEnded" ? [event.end] : []));
  /** The first turn, once it has started. */
  const first = () =>
    vi.waitFor(() => {
      const started = events.find((event) => event.type === "turnStarted");
      expect(started).toBeDefined();
      return started?.turn ?? "";
    });
  return { adapter, conversation, start, ends, first };
}

describe("Claude's process for a conversation", () => {
  it("closes when a turn ends, and the next turn carries the conversation on in a new one", async () => {
    const fake = fakeClaude({});
    const opens: { sessionId?: string; resume?: string }[] = [];
    const query = ((args: Parameters<typeof fake.query>[0]) => {
      opens.push({ ...args.options });
      return fake.query(args);
    }) as typeof fake.query;
    const { adapter, conversation, start, ends } = await onFake(
      query,
      fake.sessions,
    );
    for (const id of ["message-1", "message-2"]) {
      expect(await start(id)).toEqual({ status: "delivered" });
      await vi.waitFor(() => {
        expect(ends()).toHaveLength(id === "message-1" ? 1 : 2);
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

describe("a turn that fails", () => {
  it("ends failed, connection, when Claude's requests got no answer at all", async () => {
    const fake = fakeClaude({}, { connectionDrops: true });
    const { adapter, start, ends } = await onFake(fake.query, fake.sessions);
    expect(await start("message-1")).toEqual({ status: "delivered" });
    await vi.waitFor(() => {
      expect(ends()).toEqual([
        expect.objectContaining({ status: "failed", reason: "connection" }),
      ]);
    });
    await adapter.close();
  });
});

describe("steers Claude takes into a turn of its own", () => {
  it("settles a second steer the turn names later, and lets the next turn start", async () => {
    const fake = fakeClaude({ turn: "runs" }, { nextTurn: "two" });
    const { adapter, conversation, start, ends, first } = await onFake(
      fake.query,
      fake.sessions,
    );
    expect(await start("message-1")).toEqual({ status: "delivered" });
    const turn = await first();
    const outcomes = ["steer-1", "steer-2"].map((id) =>
      conversation.steer({ input: { id, parts: ["And the date?"] }, turn }),
    );

    expect(await outcomes[0]).toEqual({
      status: "next_turn",
      turn: expect.any(String) as string,
    });
    expect(await outcomes[1]).toEqual({ status: "delivered" });
    await vi.waitFor(() => {
      expect(ends()).toHaveLength(2);
    });
    expect(await start("message-2")).toEqual({ status: "delivered" });
    await adapter.close();
  });

  it("are stopped, and the process ended, when Stop comes before the turn's first answer", async () => {
    const fake = fakeClaude(
      { turn: "runs", ignoresInterrupt: true },
      { nextTurn: "before_an_answer" },
    );
    const { adapter, conversation, start, ends, first } = await onFake(
      fake.query,
      fake.sessions,
      { stopMs: 50 },
    );
    expect(await start("message-1")).toEqual({ status: "delivered" });
    const turn = await first();
    const outcome = conversation.steer({
      input: { id: "steer-1", parts: ["And the date?"] },
      turn,
    });
    await vi.waitFor(() => {
      expect(ends()).toHaveLength(1);
    });
    await conversation.stop(turn);

    expect(fake.closes()).toBe(1);
    expect(await outcome).toEqual({
      status: "uncertain",
      text: expect.any(String) as string,
    });
    await adapter.close();
  });
});
