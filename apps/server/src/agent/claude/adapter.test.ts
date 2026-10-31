// The Claude adapter meets the provider boundary, on the scripted Claude
// (tests/fake-claude.ts). scripts/claude-live.ts runs it on the installed
// Claude.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerContract } from "@rufi/agents/contract";
import type { Conversation, ProviderEvent } from "@rufi/agents/provider";
import { describe, expect, it, vi } from "vitest";
import { fakeClaude } from "../../../tests/fake-claude.ts";
import { callIdOf } from "../../core/chat/agents.ts";
import { claudeAdapter } from "./adapter.ts";

/** The scripted Claude of the contract's case now running. */
let scripted: ReturnType<typeof fakeClaude> | undefined;

providerContract("Claude", {
  setUp: async (script) => {
    const folder = await mkdtemp(join(tmpdir(), "rufi-claude-adapter-"));
    const fake = fakeClaude(script);
    scripted = fake;
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
  callMeta: (conversation, _turn, call) =>
    scripted?.callRufi(conversation.ref, call) ?? Promise.resolve(undefined),
  cannot: {
    lostSteer:
      "a steer has no reply to lose: it stays with Claude until Claude shows what became of it",
  },
});

/** The adapter on a scripted Claude, and how to open a conversation. */
async function onFake(
  query: ReturnType<typeof fakeClaude>["query"],
  sessions: ReturnType<typeof fakeClaude>["sessions"],
  more: { stopMs?: number; startMs?: number } = {},
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
  return { adapter, conversation, start, ends, first, events };
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

  it.each([
    ["ignores the interrupt", { ignoresInterrupt: true }],
    ["never answers it", { cancelLost: true }],
  ] as const)(
    "are stopped, and the process ended, when Stop comes before the turn's first answer and Claude %s",
    async (_, interrupt) => {
      const fake = fakeClaude(
        { turn: "runs", ...interrupt },
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
    },
  );
});

describe("Stop", () => {
  it.each([
    ["starts its own turn", "starts_during_interrupt", "uncertain"],
    ["answers in its own turn", "answers_during_interrupt", "next_turn"],
  ] as const)(
    "leaves nothing running when Claude %s during the interrupt",
    async (_, nextTurn, steered) => {
      const fake = fakeClaude(
        { turn: "runs", ignoresInterrupt: true },
        { nextTurn },
      );
      const { adapter, conversation, start, events, first } = await onFake(
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
        expect(events.some((event) => event.type === "turnEnded")).toBe(true);
      });
      await conversation.stop(turn);

      expect(fake.closes()).toBe(1);
      expect((await outcome).status).toBe(steered);
      // Every turn reported as started is reported as ended.
      const started = events.flatMap((event) =>
        event.type === "turnStarted" ? [event.turn] : [],
      );
      const ended = events.flatMap((event) =>
        event.type === "turnEnded" ? [event.turn] : [],
      );
      expect(ended).toEqual(started);
      await adapter.close();
    },
  );
});

describe("a conversation Claude no longer keeps", () => {
  // Claude deletes a conversation's transcript after a while unused, as it
  // does its own: the next turn has to go in a new one.
  it("is missing at the next start, which starts nothing", async () => {
    const fake = fakeClaude({});
    const { adapter, conversation, start, ends, events } = await onFake(
      fake.query,
      fake.sessions,
    );
    expect(await start("message-1")).toEqual({ status: "delivered" });
    await vi.waitFor(() => {
      expect(ends()).toHaveLength(1);
    });
    await fake.sessions.delete(conversation.ref);

    expect(await start("message-2")).toEqual({
      status: "not_delivered",
      reason: "missing",
      text: expect.any(String) as string,
    });
    expect(events.filter((event) => event.type === "turnStarted")).toHaveLength(
      1,
    );
    await adapter.close();
  });
});

describe("a message Claude is slow to start", () => {
  it("is uncertain, never not received, and can't start later unseen", async () => {
    const fake = fakeClaude({}, { slowStartMs: 300 });
    const { adapter, conversation, start, events } = await onFake(
      fake.query,
      fake.sessions,
      { startMs: 100 },
    );
    expect(await start("message-1")).toEqual({
      status: "uncertain",
      text: expect.any(String) as string,
    });
    expect(
      (await conversation.reconcile(["message-1"])).get("message-1"),
    ).not.toBe("not_received");

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fake.closes()).toBe(1);
    expect(events).toEqual([]);
    await adapter.close();
  });
});

describe("what Claude does in a turn", () => {
  it("shows as its items by Claude's ids, then the turn's usage, with no picture's or document's bytes; usage now from its limits", async () => {
    // A turn recorded from the installed Claude, its paths and limits made
    // fictional; its compaction is written from the SDK's type, as are the
    // two documents its picture's result gains here: one whose pages are
    // pictures, and a PDF.
    const recorded = await readFile(
      join(import.meta.dirname, "../../../tests/fixtures/claude-turn.json"),
      "utf8",
    );
    const bash = "toolu_01RjiXhjDmM8dmfeN3SiFeSf";
    const read = "toolu_011UYhCNHzyCKmJsiqCPGZ1M";
    const png = /"data": "([^"]+)"/.exec(recorded)?.[1] ?? "";
    const pdf = Buffer.from("%PDF-1.4 a fictional report").toString("base64");
    const picture = (data?: string) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        ...(data && { data }),
      },
    });
    const documents = (bytes?: { png: string; pdf: string }) => [
      {
        type: "document",
        source: { type: "content", content: [picture(bytes?.png)] },
      },
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          ...(bytes && { data: bytes.pdf }),
        },
      },
    ];
    const frames = (JSON.parse(recorded) as Record<string, unknown>[]).map(
      (frame) => {
        const message = frame["message"] as { content?: unknown } | undefined;
        const [block] = Array.isArray(message?.content)
          ? (message.content as { tool_use_id?: string; content?: unknown[] }[])
          : [];
        if (frame["type"] !== "user" || block?.tool_use_id !== read) {
          return frame;
        }
        block.content = [...(block.content ?? []), ...documents({ png, pdf })];
        return frame;
      },
    );
    const fake = fakeClaude({}, { frames });
    const { adapter, start, events } = await onFake(fake.query, fake.sessions);
    expect(await start("message-1")).toEqual({ status: "delivered" });
    await vi.waitFor(() => {
      expect(events.at(-1)?.type).toBe("turnEnded");
    });

    const command = { kind: "command", title: "echo hello-probe" };
    const image = {
      kind: "other",
      title: "Read",
      detail: "/fictional/home/ai/dot.png",
    };
    // All of the one turn; toEqual leaves out the undefined turn.
    expect(new Set(events.map((event) => event.turn)).size).toBe(1);
    expect(events.map((event) => ({ ...event, turn: undefined }))).toEqual([
      { type: "turnStarted", inputs: ["message-1"] },
      {
        type: "reasoning",
        item: "084ec2c6-2d45-4e22-9fa4-f15c06940c50",
        summary: "",
        payload: expect.objectContaining({ type: "thinking" }) as unknown,
      },
      {
        type: "step",
        item: bash,
        ...command,
        status: "running",
        payload: expect.anything() as unknown,
      },
      {
        type: "step",
        item: read,
        ...image,
        status: "running",
        payload: expect.anything() as unknown,
      },
      {
        type: "step",
        item: read,
        ...image,
        status: "done",
        payload: {
          use: expect.objectContaining({ id: read }) as unknown,
          result: {
            type: "tool_result",
            tool_use_id: read,
            content: [picture(), ...documents()],
          },
        },
      },
      {
        type: "step",
        item: bash,
        ...command,
        status: "done",
        payload: {
          use: expect.objectContaining({ id: bash }) as unknown,
          result: expect.objectContaining({
            content: "hello-probe",
          }) as unknown,
        },
      },
      {
        type: "step",
        item: "5f0c2b7e-3d41-4a8e-9c6d-1b2a3c4d5e6f",
        kind: "compaction",
        title: "compact_boundary",
        detail: "auto",
        status: "done",
        payload: expect.objectContaining({ trigger: "auto" }) as unknown,
      },
      {
        type: "text",
        item: "af1f118b-ac96-46ed-ad9c-ecd7f3b979c1",
        delta: "done",
        done: true,
      },
      // The context: the last request's input, cache writes and reads, and
      // output; and the model's window.
      { type: "usage", tokens: 2 + 397 + 13_452 + 3, window: 1_000_000 },
      // The turn's: all it read, of that from the cache, and wrote.
      {
        type: "turnUsage",
        input: 4 + 7_144 + 20_157,
        cached: 20_157,
        output: 309,
        payload: expect.objectContaining({ output_tokens: 309 }) as unknown,
      },
      { type: "turnEnded", end: { status: "done", answer: "done" } },
    ]);
    expect(png).not.toBe("");
    expect(JSON.stringify(events)).not.toContain(png);
    expect(JSON.stringify(events)).not.toContain(pdf);

    expect(await adapter.usage()).toEqual([
      { minutes: 300, usedPercent: 42, resetsAt: "2026-10-30T00:40:00.000Z" },
      {
        minutes: 10_080,
        usedPercent: 18,
        resetsAt: "2026-11-01T03:00:00.000Z",
      },
    ]);
    await adapter.close();
  });
});

/**
 * Rufi's door as far as a call goes (server/door.ts): it places the call,
 * refusing one the adapter can't place, and keeps each call's answer by
 * Rufi's call id, made by the door's own helper, so a repeat gets the same
 * answer.
 */
function fakeDoor(agent: string) {
  const answers = new Map<string, string>();
  return (conversation: Conversation, number: number, meta: unknown) => {
    const placed = conversation.placeCall(meta);
    if (placed === undefined) return "refused";
    const id = callIdOf(agent, number, placed.call);
    const answer = answers.get(id) ?? `saved ${String(answers.size + 1)}`;
    answers.set(id, answer);
    return answer;
  };
}

describe("calls to Rufi's tools", () => {
  it("are placed in the turn their hook saw: a repeat gets the same answer, and an id the hook never saw is refused", async () => {
    const fake = fakeClaude({ turn: "runs" });
    const { adapter, conversation, start, first } = await onFake(
      fake.query,
      fake.sessions,
    );
    const door = fakeDoor("agent-1");
    await start("message-1");
    await first();
    const meta = await fake.callRufi(conversation.ref, "toolu_1");

    expect(door(conversation, 1, meta)).toBe("saved 1");
    expect(door(conversation, 1, meta)).toBe("saved 1");
    expect(
      door(conversation, 1, { "claudecode/toolUseId": "toolu_unseen" }),
    ).toBe("refused");
    await adapter.close();
  });

  it("once Stop starts, refuse its turn's calls, and let no new one leave Claude", async () => {
    const during: (object | undefined)[] = [];
    const fake = fakeClaude(
      { turn: "runs" },
      {
        onInterrupt: async (id) => {
          during.push(await fake.callRufi(id, "toolu_2"));
        },
      },
    );
    const { adapter, conversation, start, first } = await onFake(
      fake.query,
      fake.sessions,
    );
    const door = fakeDoor("agent-1");
    await start("message-1");
    const turn = await first();
    const meta = await fake.callRufi(conversation.ref, "toolu_1");
    expect(door(conversation, 1, meta)).toBe("saved 1");

    await conversation.stop(turn);
    expect(during).toEqual([undefined]);
    expect(door(conversation, 1, meta)).toBe("refused");
    await adapter.close();
  });

  it("are a new call in a replacement conversation, under the same toolUseId", async () => {
    const fake = fakeClaude({ turn: "runs" });
    const door = fakeDoor("agent-1");
    const answers: string[] = [];
    for (const number of [1, 2]) {
      const { adapter, conversation, start, first } = await onFake(
        fake.query,
        fake.sessions,
      );
      await start(`message-${String(number)}`);
      await first();
      const meta = await fake.callRufi(conversation.ref, "toolu_1");
      answers.push(door(conversation, number, meta));
      await adapter.close();
    }
    expect(answers).toEqual(["saved 1", "saved 2"]);
  });

  it("from a turn Claude began by itself, is placed in that turn before it starts for Rufi", async () => {
    const fake = fakeClaude(
      { turn: "runs", ignoresInterrupt: true },
      { nextTurn: "answers_during_interrupt" },
    );
    const { adapter, conversation, start, events, first } = await onFake(
      fake.query,
      fake.sessions,
      { stopMs: 50 },
    );
    await start("message-1");
    const turn = await first();
    void conversation.steer({
      input: { id: "steer-1", parts: ["And the date?"] },
      turn,
    });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "turnEnded")).toBe(true);
    });
    // Claude's own turn has begun; its first answer comes later.
    const meta = await vi.waitFor(async () => {
      const meta = await fake.callRufi(conversation.ref, "toolu_1");
      expect(meta).toBeDefined();
      return meta;
    });
    const placed = conversation.placeCall(meta);
    expect(placed?.turn).not.toBe(turn);

    await conversation.stop(turn);
    expect(events).toContainEqual({
      type: "turnStarted",
      turn: placed?.turn,
      inputs: ["steer-1"],
    });
    await adapter.close();
  });
});
