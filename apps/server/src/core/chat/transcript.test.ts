// Reading a long chat by pages, as the screens do: the latest page opens it,
// and each older page is read before the one already shown. Written through
// the real transcripts into a real database file, with a fictional clock.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@rufi/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { databasePath, openWritable, type Store } from "../store/database.ts";
import {
  PAGE_ROWS,
  transcripts as openTranscripts,
  type ChatRow,
  type Step,
  type Transcripts,
} from "./transcript.ts";

let store: Store;
let transcripts: Transcripts;
let chat: ChatRow;
let minute = 0;
/** Each write a minute after the one before, from 1 Oct 2026. */
const clock = () =>
  new Date(Date.UTC(2026, 9, 1, 8, 0) + minute++ * 60_000).toISOString();

beforeEach(async () => {
  store = openWritable(
    databasePath(await mkdtemp(join(tmpdir(), "rufi-pages-"))),
  );
  store.db.exec(`
    INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
    INSERT INTO chats (id, person_id, created_at)
      VALUES ('c-asha', 'asha', '2026-10-01T08:00:00Z');
  `);
  minute = 0;
  transcripts = openTranscripts(store, clock);
  chat = (await transcripts.chat("asha")) as ChatRow;
});

/** One whole reply: the message, a thought, a command and the answer. */
async function reply(
  n: number,
  thread = "thread-1",
  ranOn: { model: string; effort?: string } = { model: "gpt-6-astra" },
): Promise<void> {
  const turn = `turn-${String(n)}`;
  await transcripts.startTurn(chat, turn, { id: thread, ...ranOn });
  await transcripts.addMessage(chat, {
    id: `m-${String(n)}`,
    kind: "message",
    text: `Fictional question ${String(n)}`,
    agentTurnId: turn,
  });
  await transcripts.addReasoning(chat, turn, "think", {
    summary: "Thinking",
    details: {},
  });
  await transcripts.setActivity(chat, turn, "cmd", {
    activity: "command",
    title: "Ran a command",
    status: "done",
  });
  await transcripts.appendReply(chat, turn, "answer", `Answer ${String(n)}`);
  await transcripts.endTurn(chat, turn, { status: "completed" });
}

/** Every page, the latest first, until the start of the chat. */
async function allPages(): Promise<Page[]> {
  const pages = [await transcripts.page(chat)];
  for (let last = pages[0]; last?.before != null; last = pages.at(-1)) {
    pages.push(await transcripts.page(chat, last.before));
  }
  return pages;
}

describe("the chat's pages", () => {
  it(
    "open at the latest replies and go back to the start, each turn whole, nothing skipped or repeated",
    { timeout: 30_000 },
    async () => {
      for (let n = 1; n <= 120; n++) {
        await reply(n);
        if (n === 40) {
          // A message recovered after a crash: it belongs to no turn.
          await transcripts.addMessage(chat, {
            id: "recovered",
            kind: "message",
            text: "Recovered",
          });
          // A reply that ended before anything of it was stored.
          await transcripts.startTurn(chat, "empty", {
            id: "thread-1",
            model: "gpt-6-astra",
          });
          await transcripts.endTurn(chat, "empty", { status: "failed" });
        }
        if (n === 80) {
          // A save that landed after its reply's Stop, when the next reply
          // had already begun: its receipt comes after that message.
          await transcripts.startTurn(chat, "next", {
            id: "thread-1",
            model: "gpt-6-astra",
          });
          await transcripts.addMessage(chat, {
            id: "m-next",
            kind: "message",
            text: "Next",
            agentTurnId: "next",
          });
          await transcripts.saveWithReceipt(
            chat,
            {
              agent: "agent-1",
              agentTurn: "agent-turn-80",
              ref: "turn-80",
              callId: "agent-1/1/call-80",
              tool: "save_changes",
              input: {},
              startedAt: transcripts.now(),
            },
            () =>
              Promise.resolve({
                id: "receipt-80",
                receipt: "Saved: a fictional headache",
                fresh: true,
                changes: [],
              }),
            () => ({ ok: true, text: '{"ok":true}' }),
          );
          await transcripts.endTurn(chat, "next", { status: "completed" });
        }
      }

      const pages = await allPages();
      expect(pages.length).toBeGreaterThan(3);
      // The latest page holds the newest replies and is bounded.
      expect(pages[0]?.entries.at(-1)?.text).toBe("Answer 120");
      expect(pages[0]?.entries.length).toBeLessThanOrEqual(PAGE_ROWS);
      // In order from the start, every shown entry once: no reasoning.
      const entries = pages.toReversed().flatMap((page) => page.entries);
      expect(entries.map((entry) => entry.seq)).toEqual(
        entries.map((entry) => entry.seq).toSorted((a, b) => a - b),
      );
      const ids = entries.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(entries.filter((entry) => entry.kind === "message")).toHaveLength(
        122,
      );
      expect(entries.filter((entry) => entry.kind === "reply")).toHaveLength(
        120,
      );
      expect(ids).toContain("recovered");
      expect(ids).toContain("receipt-80");
      // Each turn is on one page, with all its entries there.
      const turns = pages.flatMap((page) =>
        page.turns.map((turn) => ({ turn: turn.id, page })),
      );
      expect(new Set(turns.map((t) => t.turn)).size).toBe(turns.length);
      for (const { turn, page } of turns) {
        const own = entries.filter((entry) => entry.turnId === turn);
        expect(page.entries.filter((entry) => entry.turnId === turn)).toEqual(
          own,
        );
      }
      // The reply with nothing stored is on the page of its time: after
      // that page's first entry, before the newer page's first.
      const at = pages.findIndex((page) =>
        page.turns.some((turn) => turn.status === "failed"),
      );
      const started = pages[at]?.turns.find((t) => t.status === "failed")
        ?.startedAt as string;
      expect(pages[at]?.entries[0]?.createdAt ?? "").toSatisfy(
        (from: string) => from < started,
      );
      expect(pages[at - 1]?.entries[0]?.createdAt ?? "").toSatisfy(
        (until: string) => until > started,
      );
    },
  );

  it("say where a new thread started: the first turn on another thread, never the chat's first", async () => {
    await reply(1, "thread-1");
    await reply(2, "thread-1");
    await reply(3, "thread-2");
    await reply(4, "thread-2");
    await reply(5, "thread-3");
    const { turns } = await transcripts.page(chat);
    expect(turns.map((turn) => turn.newThread)).toEqual([
      false,
      false,
      true,
      false,
      true,
    ]);
  });

  it("give each reply its model and effort, and what the reply before it ran on, also when that one is on an older page", async () => {
    await reply(1, "thread-1", { model: "gpt-6-astra" });
    await reply(2, "thread-1", { model: "gpt-6-astra", effort: "xhigh" });
    for (let n = 3; n <= 40; n++) {
      await reply(n, "thread-1", { model: "claude-opus-5-5", effort: "high" });
    }
    const [latest, ...older] = await allPages();
    expect(older.length).toBeGreaterThan(0);
    const all = [...older.reverse(), latest].flatMap(
      (page) => page?.turns ?? [],
    );
    expect(
      all
        .slice(0, 3)
        .map(({ model, effort, before }) => ({ model, effort, before })),
    ).toEqual([
      { model: "gpt-6-astra", effort: null, before: null },
      {
        model: "gpt-6-astra",
        effort: "xhigh",
        before: { model: "gpt-6-astra", effort: null },
      },
      {
        model: "claude-opus-5-5",
        effort: "high",
        before: { model: "gpt-6-astra", effort: "xhigh" },
      },
    ]);
    // The latest page's first reply names the one before it, on a page not read.
    const first = latest?.turns[0];
    const earlier = all[all.findIndex((turn) => turn.id === first?.id) - 1];
    expect(first?.before).toEqual({
      model: earlier?.model,
      effort: earlier?.effort,
    });
  });

  it("are empty for a new chat", async () => {
    expect(await transcripts.page(chat)).toEqual({
      revision: 0,
      chat: { model: null, effort: "medium", context: null },
      entries: [],
      turns: [],
      before: null,
    });
  });
});

describe("a reply an agent's message started", () => {
  it("shows its steps below that message; one steered in later doesn't move them", async () => {
    store.db.exec(`
      INSERT INTO agent_owners (agent_id, person_id, chat_id, root, created_at)
        VALUES ('rufi-ai', 'asha', 'c-asha', 1, '2026-10-01T08:00:00Z');
    `);
    const step: Step = {
      id: "read",
      position: 1,
      type: "step",
      kind: "command",
      title: "Ran a command",
      detail: "ls",
      status: "completed",
      text: null,
      createdAt: "2026-10-01T09:00:00Z",
      updatedAt: "2026-10-01T09:00:00Z",
    };
    transcripts.readSteps({
      of: () => new Map([["turn-1", [step]]]),
      details: () => undefined,
    });
    const message = (input: string, said: string) => ({
      input,
      agent: "reader",
      title: "Reading letter.pdf",
      about: "wrote" as const,
      said,
    });
    // The clock moves on between the reply's start and its message.
    await transcripts.startTurn(
      chat,
      "turn-1",
      { id: "thread-1", model: "gpt-6-astra" },
      ["started"],
      [message("started", "The letter is from March 2025.")],
    );
    const shown = async () =>
      (await transcripts.page(chat)).entries.map((entry) => entry.text);
    expect(await shown()).toEqual([
      "The letter is from March 2025.",
      "Ran a command",
    ]);

    await transcripts.applyAgentMessage(
      chat,
      message("steered", "It names a TSH of 2.1."),
      "turn-1",
      () => Promise.resolve(),
    );
    expect(await shown()).toEqual([
      "The letter is from March 2025.",
      "Ran a command",
      "It names a TSH of 2.1.",
    ]);
  });
});
