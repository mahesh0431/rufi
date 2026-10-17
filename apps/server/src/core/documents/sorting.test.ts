// Rufi AI's sort of an add, on a real database: the page check, a split
// into documents with their drafts in one transaction, the refusals that
// write nothing, the same call again, what a turn Rufi started may sort,
// pages a saved result cites, a fixed draft that moves with its page, and
// Rufi's own work on the requests (tend) and the person's Retry. One
// fictional PDF of five pages: two reports and a prescription.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuid } from "uuid";
import { beforeEach, describe, expect, it } from "vitest";
import { chatQueue } from "../chat/queue.ts";
import {
  transcripts as openTranscripts,
  type ChatRow,
  type Transcripts,
} from "../chat/transcript.ts";
import { databasePath, openWritable, type Store } from "../store/database.ts";
import {
  comparable,
  onPage,
  SORT_WAITS_MS,
  sorting,
  type SortInput,
  type SortScope,
} from "./sorting.ts";

const T0 = "2026-10-18T09:00:00.000Z";
let clock = T0;
const now = () => clock;
const later = (ms: number) => {
  clock = new Date(Date.parse(clock) + ms).toISOString();
};

/** The reader's copy of each page of pile.pdf. */
const COPIES = [
  "# Sunrise Labs\n\nReport No: SL-1\nCollected: 12/03/2026\n\n| Test | Result | Unit |\n| --- | --- | --- |\n| Haemoglobin | 13.2 | g/dL |\n| CRP | &lt;0.05 | mg/L |",
  "| Test | Result | Unit |\n| --- | --- | --- |\n| Ferritin | 1,25 | ng/mL |\n| Vitamin B12 | 1[0?]4 | pg/mL |",
  "# Lakeside Diagnostics\n\nCollected: 20/08/2026\n\n| Base excess | -2 | mmol/L |\n| Glucose | 104 | mg/dL |",
  "| HDL cholesterol | 41 | mg/dL |",
  "Dr. Rao\n\nRx: Metformin 500 mg, twice a day",
];

let store: Store;
let transcripts: Transcripts;
let chat: ChatRow;
let sorts: ReturnType<typeof sorting>;
let calls = 0;

beforeEach(async () => {
  clock = T0;
  store = openWritable(
    databasePath(await mkdtemp(join(tmpdir(), "rufi-sorting-"))),
  );
  store.db.exec(`
    INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional'), ('ravi', 'Ravi Fictional');
    INSERT INTO chats (id, person_id, created_at) VALUES ('c-asha', 'asha', '${T0}'), ('c-ravi', 'ravi', '${T0}');
    INSERT INTO files (id, size, media_type, created_at) VALUES ('f-pile', 1, 'application/pdf', '${T0}');
    INSERT INTO documents (id, person_id, added_at, added_from, version) VALUES ('pile', 'asha', '${T0}', 'documents_page', 1);
    INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, ended_at, created_at)
      VALUES ('job-1', 'asha', 'document_read', 'pile', 'done', 1, '[1,2,3,4,5]', '${T0}', '${T0}');
  `);
  for (const [index, copy] of COPIES.entries()) {
    const page = index + 1;
    store.db
      .prepare(
        `INSERT INTO document_pages (person_id, document_id, position, file_id, page_in_file, file_name, state, entry_job_id, entry_attempt)
         VALUES ('asha', 'pile', ?, 'f-pile', ?, 'pile.pdf', 'read', 'job-1', 1)`,
      )
      .run(page, page);
    store.db
      .prepare(
        `INSERT INTO page_copies (person_id, file_id, page_in_file, job_id, attempt, outcome, copy, saved_at)
         VALUES ('asha', 'f-pile', ?, 'job-1', 1, 'read', ?, '${T0}')`,
      )
      .run(page, copy);
  }
  transcripts = openTranscripts(store, now);
  chat = (await transcripts.chat("asha")) as ChatRow;
  sorts = sorting(store, now);
  return () => {
    store.close();
  };
});

const rows = (sql: string, ...args: (string | number)[]) =>
  store.db
    .prepare(sql)
    .all(...args)
    .map((row) => ({ ...row }));

/** A person's turn: a call of sort_documents in it. */
const personal = (callId = `call-${String(++calls)}`): SortScope => ({
  personId: "asha",
  chatId: "c-asha",
  agentTurnId: `turn-${callId}`,
  callId,
});

const draft = (
  page: number,
  test_name: string,
  value_text: string,
  more: Partial<SortInput["drafts"][number]> = {},
) => ({
  page,
  test_name,
  value_text,
  quote: `${test_name} | ${value_text}`,
  ...more,
});

/** The pile as Rufi AI sorts it: two reports and a prescription. */
const THREE: SortInput = {
  document: "pile",
  documents: [
    {
      pages: [1, 2],
      kind: "lab_report",
      date: "2026-03-12",
      lab: "Sunrise Labs",
      report_number: "SL-1",
    },
    {
      pages: [3, 4],
      kind: "lab_report",
      date: "2026-08-20",
      lab: "Lakeside Diagnostics",
    },
    { pages: [5], kind: "prescription" },
  ],
  drafts: [
    draft(1, "Haemoglobin", "13.2", { value_number: 13.2, unit: "g/dL" }),
    draft(1, "CRP", "<0.05", { comparator: "<", value_number: 0.05 }),
    draft(2, "Ferritin", "1,25", { value_number: 1.25 }),
    draft(2, "Vitamin B12", "1[0?]4", {
      value_number: 104,
      worth_a_look: "the middle digit is faint",
    }),
    draft(3, "Base excess", "-2", { value_number: -2 }),
    draft(3, "Glucose", "104"),
    draft(4, "HDL cholesterol", "41"),
  ],
};

const documents = () =>
  rows(
    "SELECT id, kind, date, issuer, report_number, from_document, version, deleted_at FROM documents WHERE person_id = 'asha' ORDER BY rowid",
  );
const pagesOfEach = () =>
  rows(
    "SELECT document_id, position FROM document_pages WHERE person_id = 'asha' ORDER BY position",
  );
const drafts = () =>
  rows(
    "SELECT document_id, page, seq, version, json_extract(fields, '$.value_text') AS value, unsure, quote FROM draft_items ORDER BY page, seq",
  );

describe("the page check", () => {
  it.each([
    ["<0.05", "| CRP | &lt;0.05 | mg/L |", true],
    ["-2", "| Base excess | -2 | mmol/L |", true],
    ["1,25", "| Ferritin | 1,25 | ng/mL |", true],
    ["1[0?]4", "| Vitamin B12 | 1[0?]4 |", true],
    ["1.5", "| Potassium | 1\\.5 |", true],
    ["13.2", "| Haemoglobin | **13.2** |", true],
    ["5.6", "<td>5.6</td>", true],
    // The doubt stays: a marked digit is not the plain number.
    ["104", "| Vitamin B12 | 1[0?]4 |", false],
    // Not inside a longer number.
    ["3.2", "| Haemoglobin | 13.2 |", false],
    ["13", "| Haemoglobin | 13.2 |", false],
    ["2", "| Haemoglobin | 13.2 |", false],
    ["1", "| Ferritin | 1,25 |", false],
    ["", "| Haemoglobin | 13.2 |", false],
  ])("%s on %s: %s", (value, copy, found) => {
    expect(onPage(value, copy)).toBe(found);
  });

  it("compares entities, escapes and spacing as the characters they stand for, marks kept", () => {
    expect(comparable("&lt;0.5&nbsp;mg/L")).toBe("<0.5 mg/L");
    expect(comparable("1\\*2 **bold**  ~~3~~ [unclear: 4]")).toBe(
      "1*2 bold ~~3~~ [unclear: 4]",
    );
  });
});

describe("a sort", () => {
  it("splits the add into documents and writes their drafts in one go, each on its page, deciding what the call says", async () => {
    const answer = await sorts.sort(personal("call-split"), THREE);

    const [pile, lakeside, rx] = documents();
    expect([pile, lakeside, rx]).toEqual([
      {
        id: "pile",
        kind: "lab_report",
        date: "2026-03-12",
        issuer: "Sunrise Labs",
        report_number: "SL-1",
        from_document: null,
        version: 2,
        deleted_at: null,
      },
      {
        id: expect.any(String) as string,
        kind: "lab_report",
        date: "2026-08-20",
        issuer: "Lakeside Diagnostics",
        report_number: null,
        from_document: "pile",
        version: 1,
        deleted_at: null,
      },
      {
        id: expect.any(String) as string,
        kind: "prescription",
        date: null,
        issuer: null,
        report_number: null,
        from_document: "pile",
        version: 1,
        deleted_at: null,
      },
    ]);
    // Each page keeps its place in the add.
    expect(pagesOfEach()).toEqual([
      { document_id: "pile", position: 1 },
      { document_id: "pile", position: 2 },
      { document_id: lakeside?.["id"], position: 3 },
      { document_id: lakeside?.["id"], position: 4 },
      { document_id: rx?.["id"], position: 5 },
    ]);
    expect(drafts()).toEqual([
      {
        document_id: "pile",
        page: 1,
        seq: 1,
        version: 1,
        value: "13.2",
        unsure: "[]",
        quote: "Haemoglobin | 13.2",
      },
      {
        document_id: "pile",
        page: 1,
        seq: 2,
        version: 1,
        value: "<0.05",
        unsure: "[]",
        quote: "CRP | <0.05",
      },
      {
        document_id: "pile",
        page: 2,
        seq: 1,
        version: 1,
        value: "1,25",
        unsure: "[]",
        quote: "Ferritin | 1,25",
      },
      {
        document_id: "pile",
        page: 2,
        seq: 2,
        version: 1,
        value: "1[0?]4",
        unsure: '["the middle digit is faint"]',
        quote: "Vitamin B12 | 1[0?]4",
      },
      {
        document_id: lakeside?.["id"],
        page: 3,
        seq: 1,
        version: 1,
        value: "-2",
        unsure: "[]",
        quote: "Base excess | -2",
      },
      {
        document_id: lakeside?.["id"],
        page: 3,
        seq: 2,
        version: 1,
        value: "104",
        unsure: "[]",
        quote: "Glucose | 104",
      },
      {
        document_id: lakeside?.["id"],
        page: 4,
        seq: 1,
        version: 1,
        value: "41",
        unsure: "[]",
        quote: "HDL cholesterol | 41",
      },
    ]);
    // Its reading is sorted, and the call is kept with its answer.
    expect(rows("SELECT sorted_at FROM jobs")).toEqual([{ sorted_at: T0 }]);
    expect(
      rows("SELECT document_id, state, call_id, answer FROM sort_requests"),
    ).toEqual([
      {
        document_id: "pile",
        state: "done",
        call_id: "call-split",
        answer: JSON.stringify(answer),
      },
    ]);
    expect(
      answer.documents.map((d) => [d.kind, d.pages, d.drafts, d.worth_a_look]),
    ).toEqual([
      ["lab_report", "1–2", 4, 1],
      ["lab_report", "3–4", 3, 0],
      ["prescription", "5", 0, 0],
    ]);

    // The same call again gets the same answer and writes nothing.
    expect(await sorts.sort(personal("call-split"), THREE)).toEqual(answer);
    expect(documents()).toHaveLength(3);
    expect(drafts()).toHaveLength(7);
  });

  it("refuses a call with every problem in it, and writes nothing", async () => {
    const before = { documents: documents(), pages: pagesOfEach() };
    const call = sorts.sort(personal(), {
      document: "pile",
      documents: [
        { pages: [1, 2, 9], kind: "lab_report" },
        { pages: [2, 3], kind: "lab_report" },
      ],
      drafts: [
        draft(1, "Haemoglobin", "13.4"),
        draft(1, "CRP", "0.05"),
        draft(5, "Metformin", "500"),
      ],
    });
    await expect(call).rejects.toMatchObject({
      message: "Nothing was sorted. Fix these and try again.",
      issues: [
        expect.objectContaining({ path: "documents.0.pages", got: "9" }),
        expect.objectContaining({
          path: "documents.1.pages",
          fix: "documents.0 already holds page 2: every page goes in one document.",
        }),
        expect.objectContaining({
          path: "documents",
          fix: "Pages 4–5 aren't sorted yet: put each of them in one of the documents too.",
        }),
        expect.objectContaining({
          path: "drafts.0.value_text",
          fix: "\"13.4\" isn't in page 1's copy. Give the value exactly as the copy prints it, marks included (your reading of an unclear digit goes in value_number), or leave the draft out.",
        }),
        // "0.05" is on the page, as part of "<0.05": the check is only that
        // the printed value is there.
        expect.objectContaining({ path: "drafts.2.page" }),
      ],
    });
    expect({ documents: documents(), pages: pagesOfEach() }).toEqual(before);
    expect(drafts()).toEqual([]);
    expect(rows("SELECT sorted_at FROM jobs")).toEqual([{ sorted_at: null }]);
    expect(rows("SELECT id FROM sort_requests")).toEqual([]);
  });

  it("refuses another person's add, and an add that is being read", async () => {
    await expect(
      sorts.sort({ ...personal(), personId: "ravi", chatId: "c-ravi" }, THREE),
    ).rejects.toThrow("There is no such document for this person");
    store.db.exec("UPDATE jobs SET state = 'running'");
    await expect(sorts.sort(personal(), THREE)).rejects.toThrow(
      "The reader is reading pages of this add now.",
    );
    expect(documents()).toHaveLength(1);
  });

  it("in the person's turn, sorts again: a page a saved result cites stays, a fixed draft moves with its page, untouched drafts give way", async () => {
    await sorts.sort(personal(), THREE);
    const [, lakeside] = documents();
    const id = String(lakeside?.["id"]);
    // The person fixed the HDL draft; the glucose draft was saved.
    store.db.exec(`
      UPDATE draft_items SET version = 2, fields = json_set(fields, '$.value_text', '42')
        WHERE json_extract(original, '$.test_name') = 'HDL cholesterol';
      INSERT INTO record_sources (person_id, kind, record_id, type, document_id, page)
        VALUES ('asha', 'result', 'res-g', 'document_page', '${id}', 3);
    `);

    // Page 3 can't move to the first report.
    await expect(
      sorts.sort(personal(), {
        document: "pile",
        documents: [
          { pages: [1, 2, 3], kind: "lab_report" },
          { pages: [4], kind: "lab_report" },
        ],
        drafts: [],
      }),
    ).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          fix: "Page 3 is a source of results saved in the record, so it stays in the document it is in: sort it there, or tell the user it can't move.",
        }),
      ],
    });

    // Page 4 is a report of its own: its fixed draft goes with it, at a
    // new version; page 3's untouched drafts give way to the call's.
    await sorts.sort(personal(), {
      document: "pile",
      documents: [
        { pages: [3], kind: "lab_report", lab: "Lakeside Diagnostics" },
        { pages: [4], kind: "lab_report", lab: "Lakeside Diagnostics" },
      ],
      drafts: [draft(3, "Glucose", "104")],
    });
    const after = documents();
    expect(after).toHaveLength(4);
    const own = String(after[3]?.["id"]);
    expect(pagesOfEach().slice(2)).toEqual([
      { document_id: id, position: 3 },
      { document_id: own, position: 4 },
      { document_id: String(after[2]?.["id"]), position: 5 },
    ]);
    expect(
      drafts()
        .filter((d) => Number(d["page"]) >= 3)
        .map((d) => [d["document_id"], d["page"], d["version"], d["value"]]),
    ).toEqual([
      [id, 3, 1, "104"],
      [own, 4, 3, "42"],
    ]);
  });
});

/** Rufi's request that Rufi AI sort the pile, as a reading's end writes it. */
async function asked(jobId = "job-1") {
  const queueId = uuid();
  await transcripts.addEvent(
    chat,
    {
      kind: "document_read",
      line: "Read pile.pdf · 5 pages. Rufi AI is sorting it.",
      ask: "A document reading finished: pile.pdf (document pile).",
      askId: queueId,
    },
    async (trx) => {
      await sorts.ask(
        trx,
        { personId: "asha", documentId: "pile", jobId },
        queueId,
      );
      return undefined;
    },
  );
  return queueId;
}

/** The chat hands its next row to Rufi AI: the turn it starts. */
async function handOver(agentTurnId: string) {
  const queue = chatQueue(store, now);
  const given = await queue.claim(chat, true);
  if (!given) throw new Error("Nothing to hand over.");
  await transcripts.startTurn(
    chat,
    agentTurnId,
    { id: "thread-1", model: "gpt-6.1-sol" },
    given.id,
  );
  return given;
}

const requests = () =>
  rows(
    "SELECT r.state, r.tries, r.retry_at, q.state AS row, q.held FROM sort_requests r LEFT JOIN chat_queue q ON q.id = r.queue_id ORDER BY r.created_at",
  );

describe("a turn Rufi started", () => {
  it("sorts only its request's add, and only the pages not sorted yet", async () => {
    await asked();
    const given = await handOver("turn-rufi");
    expect(given.origin).toBe("rufi");
    const scope = { ...personal("call-rufi"), agentTurnId: "turn-rufi" };
    await sorts.sort(scope, THREE);
    expect(requests()).toEqual([
      { state: "done", tries: 0, retry_at: null, row: "sent", held: null },
    ]);

    // Its request is done: another call in it sorts nothing.
    await expect(
      sorts.sort({ ...scope, callId: "call-rufi-2" }, THREE),
    ).rejects.toThrow("This turn was started by Rufi, not by the user");

    // A page read again waits; the next Rufi turn sorts only that page.
    store.db.exec(`
      INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, ended_at, created_at)
        VALUES ('job-2', 'asha', 'document_read', 'pile', 'done', 1, '[2]', '${T0}', '${T0}');
      INSERT INTO page_copies (person_id, file_id, page_in_file, job_id, attempt, outcome, copy, saved_at)
        VALUES ('asha', 'f-pile', 2, 'job-2', 1, 'read', '| Ferritin | 1,26 | ng/mL |', '${T0}');
    `);
    await asked("job-2");
    await handOver("turn-rufi-2");
    const again = { ...personal("call-rufi-3"), agentTurnId: "turn-rufi-2" };
    await expect(sorts.sort(again, THREE)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          fix: "Pages 1, 3–5 were sorted before. In a turn Rufi started you sort only the pages not sorted yet; the user can ask you to change the others.",
        }),
      ]) as unknown,
    });
    await sorts.sort(again, {
      document: "pile",
      documents: [{ pages: [2], kind: "lab_report" }],
      drafts: [draft(2, "Ferritin", "1,26")],
    });
    expect(requests().map((r) => r["state"])).toEqual(["done", "done"]);
  });
});

describe("Rufi's work on the requests", () => {
  it("hands a waiting request over, tries a failed one again after a wait, three times, then waits for Retry", async () => {
    await asked();
    expect(await sorts.tend()).toEqual({ people: ["asha"], wake: undefined });

    for (const [index, wait] of SORT_WAITS_MS.entries()) {
      // The hand-over failed.
      store.db.exec(
        "UPDATE chat_queue SET held = 'failed', held_text = 'The AI could not start.' WHERE state = 'waiting'",
      );
      const due = new Date(Date.parse(clock) + wait).toISOString();
      expect(await sorts.tend()).toEqual({ people: [], wake: due });
      expect(requests().at(-1)).toMatchObject({
        tries: index + 1,
        retry_at: due,
      });
      // Not yet: it waits.
      expect((await sorts.tend()).people).toEqual([]);
      later(wait);
      expect((await sorts.tend()).people).toEqual(["asha"]);
      expect(requests().at(-1)).toMatchObject({
        retry_at: null,
        row: "waiting",
        held: null,
      });
    }
    store.db.exec(
      "UPDATE chat_queue SET held = 'failed', held_text = 'The AI could not start.' WHERE state = 'waiting'",
    );
    await sorts.tend();
    expect(requests()).toEqual([
      { state: "failed", tries: 3, retry_at: null, row: "removed", held: null },
    ]);
    expect(rows("SELECT error FROM sort_requests")).toEqual([
      { error: "The AI could not start." },
    ]);

    // The person's Retry starts its tries again, at the end of the queue.
    expect(await sorts.retry("asha", "pile")).toBe(true);
    expect(requests()).toEqual([
      { state: "open", tries: 0, retry_at: null, row: "waiting", held: null },
    ]);
    // One that waits to go needs no Retry.
    expect(await sorts.retry("asha", "pile")).toBe(false);
  });

  it("a turn that ended without sorting asked the person; one they stopped waits for them; another end is tried again", async () => {
    await asked();
    await handOver("turn-1");
    await transcripts.endTurn(chat, "turn-1", { status: "completed" });
    await sorts.tend();
    expect(requests().map((r) => r["state"])).toEqual(["asked"]);
    expect(await sorts.retry("asha", "pile")).toBe(true);

    await handOver("turn-2");
    await transcripts.endTurn(chat, "turn-2", {
      status: "interrupted",
      reason: "stopped",
      text: "Stopped.",
    });
    await sorts.tend();
    expect(requests()).toEqual([
      {
        state: "open",
        tries: 0,
        retry_at: null,
        row: "waiting",
        held: "paused",
      },
    ]);
    expect((await sorts.tend()).people).toEqual([]);

    store.db.exec("UPDATE chat_queue SET held = NULL WHERE held = 'paused'");
    await handOver("turn-3");
    await transcripts.endTurn(chat, "turn-3", {
      status: "failed",
      reason: "connection",
      text: "The connection to ChatGPT dropped.",
    });
    expect((await sorts.tend()).wake).toBe(
      new Date(Date.parse(T0) + (SORT_WAITS_MS[0] ?? 0)).toISOString(),
    );
    expect(rows("SELECT tries, error FROM sort_requests")).toEqual([
      { tries: 1, error: "The connection to ChatGPT dropped." },
    ]);
  });

  it("a newer reading's request takes the place of the one that waited", async () => {
    await asked();
    await asked();
    expect(requests()).toEqual([
      { state: "void", tries: 0, retry_at: null, row: "removed", held: null },
      { state: "open", tries: 0, retry_at: null, row: "waiting", held: null },
    ]);
  });
});
