// Question cards in Rufi's chat (docs/adr/0036), on a real database file
// with the fictional family: Rufi AI asks with ask, the person's message
// quotes the card and, for a click, the answer it chose; the card is
// answered when that message goes to Rufi AI, and Rufi AI reads the quote
// wherever it reads the message.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Change } from "./transcript.ts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "../store/database.ts";
import { rufiCaller, type TurnScope } from "../tools/tools.ts";
import { turnScope } from "../../../tests/scope.ts";
import { drafts as openDrafts } from "./drafts.ts";
import { chatQueue, QueueRefusal, type ChatQueue } from "./queue.ts";
import {
  transcripts as openTranscripts,
  type ChatRow,
  type Transcripts,
} from "./transcript.ts";

const family = await readFile(
  new URL("../../../tests/fixtures/fictional-family.sql", import.meta.url),
  "utf8",
);

const CARD = {
  key: "Lipid panel, 12 Aug 2026",
  details: "- LDL 138 mg/dL\n- HDL 41 mg/dL",
  question: "Save these 2 results to your health record?",
  answers: ["Save", "Not now"],
};

let store: Store;
let reader: Store;
let transcripts: Transcripts;
let queue: ChatQueue;
let chat: ChatRow;
let turns = 0;

beforeEach(async () => {
  const path = databasePath(await mkdtemp(join(tmpdir(), "rufi-question-")));
  store = openWritable(path);
  store.db.exec(family);
  reader = openReadOnly(path) as Store;
  transcripts = openTranscripts(store, () => "2026-11-10T09:00:00.000Z");
  queue = chatQueue(store, () => "2026-11-10T09:00:00.000Z");
  chat = (await transcripts.chat("asha")) as ChatRow;
  turns = 0;
  await nextTurn();
});

/** A new reply of Rufi AI's starts, taking these waiting messages. */
async function nextTurn(...inputs: string[]) {
  turns += 1;
  await transcripts.startTurn(
    chat,
    `t-${String(turns)}`,
    { id: "thread-1", model: "gpt-6.1-sol" },
    inputs,
  );
}

/** An agent of the chat calls one of Rufi's tools in the current reply. */
async function call(
  tool: string,
  input: unknown,
  callId: string,
  scope: TurnScope = turnScope(chat, `t-${String(turns)}`),
  chats: Transcripts = transcripts,
) {
  const answer = await rufiCaller(reader, chats, () => undefined)(scope)(
    tool,
    input,
    callId,
  );
  return {
    ok: answer.ok,
    body: JSON.parse(answer.text) as {
      result: Record<string, unknown> & {
        entries: { kind: string; id?: string; text: string }[];
      };
      error?: string;
    },
  };
}

async function ask(card: unknown = CARD, callId = "call-ask") {
  const asked = await call("ask", card, callId);
  expect(asked.ok).toBe(true);
  return asked.body.result["id"] as string;
}

const entries = async () => (await transcripts.page(chat)).entries;

const cards = () =>
  store.db
    .prepare(
      "SELECT id, card, answer FROM transcript_entries WHERE kind = 'question'",
    )
    .all()
    .map((row) => ({ ...row }));

describe("ask", () => {
  it("puts Rufi AI's card in the chat as it gave it, with its words as Markdown for a screen that can't draw it, and answers its id and link", async () => {
    const asked = await call("ask", CARD, "call-ask");
    expect(asked.ok).toBe(true);
    const id = asked.body.result["id"] as string;
    expect(asked.body.result).toEqual({
      id,
      link: `rufi:/chat/questions/${id}`,
    });
    expect((await entries()).find((entry) => entry.id === id)).toMatchObject({
      kind: "question",
      card: { kind: "choice", ...CARD },
      text: "**Lipid panel, 12 Aug 2026**\n\n- LDL 138 mg/dL\n- HDL 41 mg/dL\n\nSave these 2 results to your health record?\n\n- Save\n- Not now",
    });
  });

  it("makes one card for the same call, also with other words and from a Rufi started again", async () => {
    const first = await ask();
    const again = await call(
      "ask",
      { ...CARD, question: "Save them?" },
      "call-ask",
      turnScope(chat, `t-${String(turns)}`),
      openTranscripts(store, () => "2026-11-10T09:05:00.000Z"),
    );
    expect(again.body.result).toMatchObject({ id: first });
    expect(cards()).toEqual([
      expect.objectContaining({
        id: first,
        card: expect.stringContaining('"Save these 2'),
      }),
    ]);
  });

  it("is Rufi AI's alone: a sub-agent of the chat is refused and writes nothing, while its other tools answer it", async () => {
    const helper = {
      ...turnScope(chat, `t-${String(turns)}`),
      agent: "agent-2",
      label: "Lab reader",
    };
    const asked = await call("ask", CARD, "agent-2/1/call-ask", helper);
    expect(asked.ok).toBe(false);
    expect(asked.body.error).toContain("send_agent");
    expect(cards()).toEqual([]);
    expect(
      (await call("read_chat", {}, "agent-2/1/call-read", helper)).ok,
    ).toBe(true);
  });
});

describe("a message that quotes a card", () => {
  it("is named by the card's key, and refused for another chat's card, an answer the card hasn't, or a line that isn't a card", async () => {
    const id = await ask();
    await queue.accept(
      chat,
      "m-1",
      "Save",
      [{ type: "question", id, answer: 0 }],
      "queue",
    );
    expect(
      (await queue.list(chat)).items.find((item) => item.id === "m-1"),
    ).toMatchObject({
      refs: [
        {
          ref: { type: "question", id, answer: 0 },
          label: "Lipid panel, 12 Aug 2026",
        },
      ],
    });

    const ravi = (await transcripts.chat("ravi")) as ChatRow;
    const refused = [
      () => queue.accept(ravi, "m-2", "Save", [{ type: "question", id }]),
      () =>
        queue.accept(chat, "m-3", "Save", [
          { type: "question", id, answer: 2 },
        ]),
      () =>
        queue.accept(chat, "m-4", "Save", [{ type: "question", id: "m-1" }]),
    ];
    for (const send of refused)
      await expect(send()).rejects.toThrow(QueueRefusal);
    expect(
      store.db
        .prepare("SELECT id FROM chat_queue WHERE id IN ('m-2', 'm-3', 'm-4')")
        .all(),
    ).toEqual([]);
  });

  it("answers its card with a click when it goes to Rufi AI: the card and the message change together, and a later click leaves the first answer", async () => {
    const id = await ask();
    await queue.accept(
      chat,
      "m-1",
      "Save",
      [{ type: "question", id, answer: 0 }],
      "queue",
    );
    // Waiting, it hasn't answered.
    expect(cards()).toEqual([expect.objectContaining({ id, answer: null })]);

    const changes: Change[] = [];
    transcripts.subscribe(chat.id, (change) => changes.push(change));
    await nextTurn("m-1");
    expect(cards()).toEqual([
      expect.objectContaining({
        answer: JSON.stringify({ message: "m-1", index: 0 }),
      }),
    ]);
    expect(
      changes.at(-1)?.entries.map((entry) => [entry.id, entry.answer]),
    ).toEqual(
      expect.arrayContaining([
        [id, { message: "m-1", index: 0 }],
        ["m-1", undefined],
      ]),
    );

    await queue.accept(
      chat,
      "m-2",
      "Not now",
      [{ type: "question", id, answer: 1 }],
      "queue",
    );
    await nextTurn("m-2");
    expect(cards()).toEqual([
      expect.objectContaining({
        answer: JSON.stringify({ message: "m-1", index: 0 }),
      }),
    ]);
  });

  it("answers nothing once removed from the queue, or once edited: an edit keeps the quote, not the answer", async () => {
    const id = await ask();
    await queue.accept(
      chat,
      "m-1",
      "Save",
      [{ type: "question", id, answer: 0 }],
      "queue",
    );
    await queue.remove(chat, "m-1");
    await queue.accept(
      chat,
      "m-2",
      "Save",
      [{ type: "question", id, answer: 0 }],
      "queue",
    );
    await queue.edit(chat, "m-2", "Save, but the LDL is 133");
    await nextTurn("m-1", "m-2");

    expect(cards()).toEqual([expect.objectContaining({ answer: null })]);
    expect((await entries()).find((entry) => entry.id === "m-2")).toMatchObject(
      {
        text: "Save, but the LDL is 133",
        refs: [
          { ref: { type: "question", id }, label: "Lipid panel, 12 Aug 2026" },
        ],
      },
    );
    expect(
      (await entries()).find((entry) => entry.id === "m-2")?.refs?.[0]?.ref,
    ).not.toHaveProperty("answer");
  });

  it("stays in the box as a quote, never with a click's answer", async () => {
    const id = await ask();
    const box = openDrafts(store);
    await box.save(chat, "Save, but", [{ type: "question", id, answer: 0 }]);
    expect(await box.read(chat)).toEqual({
      text: "Save, but",
      refs: [
        {
          ref: { type: "question", id },
          label: "Lipid panel, 12 Aug 2026",
          detail: "Rufi AI's question",
        },
      ],
    });
  });
});

describe("Rufi AI reading the chat back", () => {
  it("tells two cards with the same key apart: read_chat and a new thread's history give each answer the quote of its own card, and read_chat gives one card by its id", async () => {
    const first = await ask(CARD, "call-ask-1");
    const second = await ask(
      { ...CARD, details: "- LDL 133 mg/dL\n- HDL 41 mg/dL" },
      "call-ask-2",
    );
    await transcripts.endTurn(chat, `t-${String(turns)}`, {
      status: "completed",
    });
    await queue.accept(
      chat,
      "m-1",
      "Save",
      [{ type: "question", id: first, answer: 0 }],
      "queue",
    );
    await queue.accept(
      chat,
      "m-2",
      "Not now",
      [{ type: "question", id: second, answer: 1 }],
      "queue",
    );
    await nextTurn("m-1", "m-2");
    await transcripts.endTurn(chat, `t-${String(turns)}`, {
      status: "completed",
    });

    const read = await call("read_chat", {}, "call-read");
    const said = Object.fromEntries(
      read.body.result.entries.map((entry) => [
        entry.id ?? entry.text.split("\n")[0],
        entry,
      ]),
    );
    expect(
      read.body.result.entries
        .filter((entry) => entry.kind === "message")
        .map((entry) => entry.text),
    ).toEqual([
      `> [Lipid panel, 12 Aug 2026](rufi:/chat/questions/${second})\n\nNot now`,
      `> [Lipid panel, 12 Aug 2026](rufi:/chat/questions/${first})\n\nSave`,
    ]);
    expect(said[first]?.text).toContain(
      "Answered by a click: Save (message m-1).",
    );
    expect(said[second]?.text).toContain(
      "Answered by a click: Not now (message m-2).",
    );

    const one = await call("read_chat", { question: second }, "call-read-card");
    expect(one.body.result.entries).toEqual([
      expect.objectContaining({
        id: second,
        kind: "question",
        text: expect.stringContaining("LDL 133"),
      }),
    ]);
    const ravi = (await transcripts.chat("ravi")) as ChatRow;
    const elsewhere = await call(
      "read_chat",
      { question: second },
      "call-read-ravi",
      turnScope(ravi, "t-ravi"),
    );
    expect(elsewhere.ok).toBe(false);

    const history = await transcripts.lastMessages(chat, 10);
    expect(
      history.filter((line) => line.from === "user").map((line) => line.text),
    ).toEqual([
      `> [Lipid panel, 12 Aug 2026](rufi:/chat/questions/${first})\n\nSave`,
      `> [Lipid panel, 12 Aug 2026](rufi:/chat/questions/${second})\n\nNot now`,
    ]);
    expect(
      history.filter((line) => line.from === "ai").map((line) => line.text),
    ).toEqual([
      expect.stringContaining(`rufi:/chat/questions/${first}`),
      expect.stringContaining(`rufi:/chat/questions/${second}`),
    ]);
  });
});
