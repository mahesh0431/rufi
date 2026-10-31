// The Claude adapter meets the provider boundary, on the scripted Claude
// (tests/fake-claude.ts). scripts/claude-live.ts runs it on the installed
// Claude.
import { mkdtemp, readFile } from "node:fs/promises";
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
  callMeta: (_conversation, _turn, call) =>
    Promise.resolve(fakeClaude({}).callMeta(call)),
  cannot: {
    lostStart:
      "Claude gives no answer to a message written to it: it counts as sent once written",
    lostSteer:
      "Claude gives no answer to a message written to it: it counts as sent once written",
  },
});

/** The adapter on a scripted Claude, and how to open a conversation. */
async function onFake(
  query: ReturnType<typeof fakeClaude>["query"],
  sessions: ReturnType<typeof fakeClaude>["sessions"],
) {
  const folder = await mkdtemp(join(tmpdir(), "rufi-claude-adapter-"));
  const adapter = claudeAdapter({
    claude: { path: "/fictional/claude", version: "2.1.312" },
    sandbox: { folder, unreadable: [] },
    env: {},
    plugin: { path: folder, skills: [] },
    query,
    sessions,
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
  return { adapter, conversation, start, ends, events };
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

describe("a process that ends before Claude begins the turn", () => {
  it("shows the message in a turn that failed, so it can be sent again", async () => {
    const fake = fakeClaude({}, { endsBeforeATurn: true });
    const { adapter, start, events } = await onFake(fake.query, fake.sessions);
    expect(await start("message-1")).toEqual({ status: "delivered" });
    await vi.waitFor(() => {
      expect(events).toEqual([
        expect.objectContaining({
          type: "turnStarted",
          inputs: ["message-1"],
        }) as unknown,
        expect.objectContaining({
          type: "turnEnded",
          end: expect.objectContaining({
            status: "failed",
            reason: "process_died",
          }) as unknown,
        }) as unknown,
      ]);
    });
    await adapter.close();
  });
});

describe("a message sent again", () => {
  it("goes to Claude again after its reply failed", async () => {
    const fake = fakeClaude({ turn: "fails" });
    const { adapter, start, ends } = await onFake(fake.query, fake.sessions);
    expect(await start("message-1")).toEqual({ status: "delivered" });
    await vi.waitFor(() => {
      expect(ends()).toHaveLength(1);
    });

    expect(await start("message-1")).toEqual({ status: "delivered" });
    await vi.waitFor(() => {
      expect(ends()).toHaveLength(2);
    });
    await adapter.close();
  });
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
