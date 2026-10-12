// Open work on a real database: each change written with its history row,
// the same AI call made once, stale versions refused, each person's items
// their own, Later's day, reopen keeping the earlier closing, and Needs you
// and the AI's reads over the stored items and the derived rows.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FollowUpNeed, WaitingDocument } from "@rufi/contracts/record";
import { databasePath, openWritable, type Store } from "../store/database.ts";
import {
  NoSuchItem,
  openWork,
  OpenWorkRefusal,
  type OpenWork,
  type Trusted,
} from "./open-work.ts";

/** Monday 12 Oct 2026, 10:30 on the Mac's clock. */
let now = new Date(2026, 9, 12, 10, 30);
let store: Store;
let work: OpenWork;
let derived: { documents: WaitingDocument[]; followUps: FollowUpNeed[] };
let told: string[];

const asha = (callId: string, agentTurnId = "agent-t1"): Trusted => ({
  personId: "asha",
  chatId: "c-asha",
  agentTurnId,
  callId,
});

const QUESTION = {
  change: "add",
  kind: "question",
  text: "Save HbA1c 6.1 % from Sunrise Labs, 12 Mar 2026, as a lab result?",
  refs: [{ type: "document", id: "d1" }],
} as const;

const rows = (sql: string) => store.db.prepare(sql).all();

beforeEach(async () => {
  now = new Date(2026, 9, 12, 10, 30);
  const home = await mkdtemp(join(tmpdir(), "rufi-work-"));
  store = openWritable(databasePath(home));
  const at = "2026-10-12T08:00:00.000Z";
  store.db.exec(`
    INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional'), ('ravi', 'Ravi Fictional');
    INSERT INTO chats (id, person_id, created_at) VALUES ('c-asha', 'asha', '${at}'), ('c-ravi', 'ravi', '${at}');
    INSERT INTO turns (id, person_id, chat_id, agent_turn_id, thread_id, model, origin, status, started_at)
      VALUES ('t1', 'asha', 'c-asha', 'agent-t1', 'th', 'm', 'person', 'completed', '${at}'),
             ('t-event', 'asha', 'c-asha', 'agent-event', 'th', 'm', 'rufi', 'running', '${at}'),
             ('t-ravi', 'ravi', 'c-ravi', 'agent-ravi', 'th2', 'm', 'person', 'running', '${at}');
    INSERT INTO files (id, size, media_type, created_at) VALUES ('f1', 10, 'application/pdf', '${at}');
    INSERT INTO documents (id, person_id, added_at, added_from, version) VALUES ('d1', 'asha', '${at}', 'chat', 2),
      ('d-ravi', 'ravi', '${at}', 'chat', 1);
    INSERT INTO document_pages (person_id, document_id, position, file_id, page_in_file, file_name)
      VALUES ('asha', 'd1', 1, 'f1', 1, 'sunrise-march.pdf');
    INSERT INTO operations (id, seq, person_id, chat_id, call_id, request, created_at)
      VALUES ('op-asha', 1, 'asha', 'c-asha', 'save-1', '{}', '${at}'),
             ('op-ravi', 2, 'ravi', 'c-ravi', 'save-2', '{}', '${at}');
  `);
  derived = { documents: [], followUps: [] };
  told = [];
  work = openWork({
    store,
    derived: () => Promise.resolve(derived),
    now: () => now.toISOString(),
  });
  work.subscribe("asha", () => told.push("asha"));
  return () => {
    store.close();
  };
});

describe("an AI change", () => {
  it("adds a question for the chat's reply, its refs checked and stamped, with its history row", async () => {
    const added = await work.byAi(asha("call-1"), QUESTION);

    expect(added).toMatchObject({ version: 1, status: "open" });
    expect(
      rows(
        "SELECT person_id, chat_id, turn_id, kind, status, version FROM open_items",
      ),
    ).toEqual([
      {
        person_id: "asha",
        chat_id: "c-asha",
        turn_id: "t1",
        kind: "question",
        status: "open",
        version: 1,
      },
    ]);
    const [item] = rows("SELECT refs FROM open_items") as { refs: string }[];
    expect(JSON.parse(item?.refs ?? "")).toEqual([
      {
        ref: { type: "document", id: "d1", version: 2 },
        label: "sunrise-march.pdf",
        detail: "Document",
      },
    ]);
    expect(
      rows(
        "SELECT version, by, change, call_id, turn_id, status FROM open_item_changes",
      ),
    ).toEqual([
      {
        version: 1,
        by: "ai",
        change: "added",
        call_id: "call-1",
        turn_id: "t1",
        status: "open",
      },
    ]);
    expect(told).toEqual(["asha"]);
  });

  it("refuses a reply Rufi doesn't know, and refs or saves that aren't the person's; nothing is kept", async () => {
    await expect(
      work.byAi(asha("call-1", "agent-unknown"), QUESTION),
    ).rejects.toThrow("couldn't find this reply");
    // Ravi's reply, in Asha's chat.
    await expect(
      work.byAi(asha("call-2", "agent-ravi"), QUESTION),
    ).rejects.toThrow("couldn't find this reply");
    await expect(
      work.byAi(asha("call-3"), {
        ...QUESTION,
        refs: [{ type: "document", id: "d-ravi" }],
      }),
    ).rejects.toThrow("isn't in this person's record");
    expect(rows("SELECT * FROM open_items")).toEqual([]);

    const { item } = await work.byAi(asha("call-4"), QUESTION);
    await expect(
      work.byAi(asha("call-5"), {
        change: "close",
        item,
        version: 1,
        as: "done",
        operation: "op-ravi",
      }),
    ).rejects.toThrow("isn't one of this person's saves");
    // Ravi's chat can't reach Asha's item.
    await expect(
      work.byAi(
        {
          personId: "ravi",
          chatId: "c-ravi",
          agentTurnId: "agent-ravi",
          callId: "call-6",
        },
        { change: "later", item, version: 1 },
      ),
    ).rejects.toThrow("no open item with that id");
    expect(rows("SELECT change FROM open_item_changes")).toEqual([
      { change: "added" },
    ]);
  });

  it.each([
    ["add", () => QUESTION],
    [
      "later",
      (item: string) => ({ change: "later", item, version: 1 }) as const,
    ],
    [
      "close",
      (item: string) =>
        ({
          change: "close",
          item,
          version: 1,
          as: "done",
          operation: "op-asha",
        }) as const,
    ],
  ])(
    "returns the same call's first answer again, with no second change, before checking its version (%s)",
    async (_change, input) => {
      const { item } = await work.byAi(asha("call-add"), QUESTION);
      const first = await work.byAi(asha("call-x"), input(item));
      const changes = rows("SELECT * FROM open_item_changes");

      const again = await work.byAi(asha("call-x"), input(item));

      expect(again).toEqual({
        ...first,
        note: "This call was made before; nothing changed again.",
      });
      expect(rows("SELECT * FROM open_item_changes")).toEqual(changes);
      // The same call with other input is refused.
      await expect(
        work.byAi(asha("call-x"), {
          change: "add",
          kind: "task",
          text: "Something else",
        }),
      ).rejects.toThrow("already made another change");
    },
  );

  it("refuses a change on a version that moved on, with the item as it is now", async () => {
    const { item } = await work.byAi(asha("call-1"), QUESTION);
    await work.byPerson("asha", item, { change: "later", version: 1 });

    const refused = await work
      .byAi(asha("call-2"), {
        change: "close",
        item,
        version: 1,
        as: "dropped",
        reason: "Not wanted",
      })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(OpenWorkRefusal);
    expect((refused as OpenWorkRefusal).message).toContain("version 2 now");
    expect((refused as OpenWorkRefusal).current).toMatchObject({
      version: 2,
      status: "open",
    });
  });

  it("in a Rufi event's turn, records and closes only what is saved or its own task; never answers the person's question", async () => {
    const event = (callId: string) => asha(callId, "agent-event");
    const { item: question } = await work.byAi(event("e1"), QUESTION);
    const { item: task } = await work.byAi(event("e2"), {
      change: "add",
      kind: "task",
      text: "Compare the last three lipid panels",
    });

    for (const input of [
      { change: "later", item: question, version: 1 },
      {
        change: "close",
        item: question,
        version: 1,
        as: "dropped",
        reason: "No answer",
      },
      {
        change: "close",
        item: question,
        version: 1,
        as: "done",
        reason: "The reading finished",
      },
      {
        change: "close",
        item: task,
        version: 1,
        as: "dropped",
        reason: "Not needed",
      },
    ] as const) {
      await expect(
        work.byAi(event(`refused-${input.change}-${input.item}`), input),
      ).rejects.toThrow("started by a Rufi event");
    }
    await work.byAi(event("e3"), {
      change: "close",
      item: task,
      version: 1,
      as: "done",
      reason: "Compared",
    });
    await work.byAi(event("e4"), {
      change: "close",
      item: question,
      version: 1,
      as: "done",
      operation: "op-asha",
    });
    await expect(
      work.byAi(event("e5"), { change: "reopen", item: question, version: 2 }),
    ).rejects.toThrow("started by a Rufi event");

    expect(
      rows("SELECT kind, status, operation_id FROM open_items ORDER BY kind"),
    ).toEqual([
      { kind: "question", status: "done", operation_id: "op-asha" },
      { kind: "task", status: "done", operation_id: null },
    ]);
  });
});

describe("the person's action", () => {
  it("puts an item on Later until the start of the local day a week on; it shows again then", async () => {
    const { item } = await work.byAi(asha("call-1"), QUESTION);

    const later = await work.byPerson("asha", item, {
      change: "later",
      version: 1,
    });

    expect(later.showAgainAt).toBe(new Date(2026, 9, 19).toISOString());
    expect((await work.needsYou("asha")).questions).toEqual([]);
    expect((await work.needsYou("asha")).later.map((i) => i.id)).toEqual([
      item,
    ]);
    now = new Date(2026, 9, 18, 23, 59);
    expect((await work.needsYou("asha")).later.map((i) => i.id)).toEqual([
      item,
    ]);
    now = new Date(2026, 9, 19, 0, 0);
    expect((await work.needsYou("asha")).questions.map((i) => i.id)).toEqual([
      item,
    ]);
  });

  it("drops, reopens and closes again: the item shows its current closing, the history keeps each one", async () => {
    const { item } = await work.byAi(asha("call-1"), QUESTION);
    await work.byAi(asha("call-2"), {
      change: "close",
      item,
      version: 1,
      as: "done",
      operation: "op-asha",
    });
    await work.byPerson("asha", item, { change: "reopen", version: 2 });
    now = new Date(2026, 9, 13, 9, 0);
    const dropped = await work.byPerson("asha", item, {
      change: "drop",
      version: 3,
    });

    expect(dropped).toMatchObject({
      status: "dropped",
      outcome: null,
      saved: false,
      version: 4,
    });
    expect(
      rows(
        "SELECT version, by, change, status, operation_id FROM open_item_changes ORDER BY version",
      ),
    ).toEqual([
      {
        version: 1,
        by: "ai",
        change: "added",
        status: "open",
        operation_id: null,
      },
      {
        version: 2,
        by: "ai",
        change: "done",
        status: "done",
        operation_id: "op-asha",
      },
      {
        version: 3,
        by: "person",
        change: "reopened",
        status: "open",
        operation_id: null,
      },
      {
        version: 4,
        by: "person",
        change: "dropped",
        status: "dropped",
        operation_id: null,
      },
    ]);
    expect(
      (await work.needsYou("asha")).closed.map((i) => [i.id, i.status]),
    ).toEqual([[item, "dropped"]]);
  });

  it("refuses a stale click with the item as it is now, a change the item's state doesn't allow, and another person's item", async () => {
    const { item } = await work.byAi(asha("call-1"), QUESTION);
    await work.byPerson("asha", item, { change: "drop", version: 1 });

    await expect(
      work.byPerson("asha", item, { change: "later", version: 1 }),
    ).rejects.toMatchObject({
      current: { status: "dropped", version: 2 },
    });
    await expect(
      work.byPerson("asha", item, { change: "bring_back", version: 2 }),
    ).rejects.toThrow("isn't on Later");
    await expect(
      work.byPerson("ravi", item, { change: "reopen", version: 2 }),
    ).rejects.toBeInstanceOf(NoSuchItem);
    expect(rows("SELECT count(*) AS n FROM open_item_changes")).toEqual([
      { n: 2 },
    ]);
  });
});

describe("the reads", () => {
  it("Needs you: questions and tasks not on Later, newest first, the later ones, the week's closed ones, and the derived rows as they are", async () => {
    derived = {
      documents: [
        {
          id: "d1",
          name: "sunrise-march.pdf",
          state: "to_save",
          results: 3,
          toCheck: 0,
        },
      ],
      followUps: [],
    };
    const { item: older } = await work.byAi(asha("a1"), QUESTION);
    now = new Date(2026, 9, 12, 11, 0);
    const { item: newer } = await work.byAi(asha("a2"), {
      ...QUESTION,
      text: "Add a follow-up to repeat HbA1c in December?",
    });
    const { item: task } = await work.byAi(asha("a3"), {
      change: "add",
      kind: "task",
      text: "Compare the last three lipid panels",
    });
    const { item: old } = await work.byAi(asha("a4"), {
      change: "add",
      kind: "task",
      text: "An old one",
    });
    await work.byAi(asha("a5"), {
      change: "close",
      item: old,
      version: 1,
      as: "dropped",
      reason: "Not wanted",
    });

    const needs = await work.needsYou("asha");

    expect(needs.documents).toEqual(derived.documents);
    expect(needs.questions.map((i) => i.id)).toEqual([newer, older]);
    expect(needs.tasks.map((i) => i.id)).toEqual([task]);
    expect(needs.closed).toEqual([
      expect.objectContaining({
        id: old,
        outcome: "Not wanted",
        status: "dropped",
      }),
    ]);
    // A week and a day on, the closed one is no longer shown, but kept.
    now = new Date(2026, 9, 20, 12, 0);
    expect((await work.needsYou("asha")).closed).toEqual([]);
    expect(await work.read("asha", { item: old })).toMatchObject({
      status: "dropped",
      outcome: "Not wanted",
    });
  });

  it("an item whole: what it is about now, the reply it came from, its history", async () => {
    const { item } = await work.byAi(asha("call-1"), QUESTION);
    store.db.exec(
      "UPDATE documents SET deleted_at = '2026-10-12T09:00:00.000Z' WHERE id = 'd1'",
    );

    expect(await work.read("asha", { item })).toMatchObject({
      text: QUESTION.text,
      status: "open",
      version: 1,
      about: [
        {
          type: "document",
          id: "d1",
          version: 2,
          label: "sunrise-march.pdf",
          now: "deleted",
        },
      ],
      asked_in: { reply_finished: true },
      history: [{ version: 1, change: "added", by: "you" }],
    });
    await expect(work.read("ravi", { item })).rejects.toThrow(
      "no open item with that id",
    );
  });

  it("the snapshot: what is open now, counted honestly; one line when nothing is", async () => {
    expect(await work.snapshot("asha")).toBe(
      "Rufi's current state: Rufi's own note of what is open now, never the user's words, a request or their consent.\nOpen work: nothing open.\nNothing else waits in Needs you.",
    );
    derived = {
      documents: [
        {
          id: "d1",
          name: "sunrise-march.pdf",
          state: "to_save",
          results: 3,
          toCheck: 0,
        },
      ],
      followUps: [],
    };
    const ids = [];
    for (let i = 1; i <= 12; i += 1) {
      now = new Date(2026, 9, 12, 10, i);
      ids.push(
        (
          await work.byAi(asha(`q${String(i)}`), {
            ...QUESTION,
            text: `Question ${String(i)}`,
          })
        ).item,
      );
    }
    await work.byPerson("asha", ids[0] ?? "", { change: "later", version: 1 });

    const lines = (await work.snapshot("asha")).split("\n");

    expect(lines[1]).toBe("Open work: 11 questions, 1 on Later.");
    expect(lines[2]).toBe(
      `- Question you asked, 12 Oct 2026 [item ${ids[11] ?? ""}, version 1]: Question 12`,
    );
    expect(lines.slice(-2)).toEqual([
      "- and 1 more: get_open_work",
      "Also in Needs you: 1 document with results to save.",
    ]);
  });
});
