// Rufi AI's sort of an add, on a real database: a split into documents
// with their drafts in one transaction, the refusals that write nothing,
// pages a saved result cites, a fixed draft that moves with
// its page, and a page read again placed on its own. One fictional PDF of
// five pages: two reports and a prescription.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { databasePath, openWritable, type Store } from "../store/database.ts";
import { documents as openDocuments } from "./documents.ts";
import { sorting, type SortInput, type SortScope } from "./sorting.ts";

const T0 = "2026-10-18T09:00:00.000Z";
let clock = T0;
const now = () => clock;

/** The reader's copy of each page of pile.pdf. */
const COPIES = [
  "# Sunrise Labs\n\nReport No: SL-1\nCollected: 12/03/2026\n\n| Test | Result | Unit |\n| --- | --- | --- |\n| Haemoglobin | 13.2 | g/dL |\n| CRP | &lt;0.05 | mg/L |",
  "| Test | Result | Unit |\n| --- | --- | --- |\n| Ferritin | 1,25 | ng/mL |\n| Vitamin B12 | 1[0?]4 | pg/mL |",
  "# Lakeside Diagnostics\n\nCollected: 20/08/2026\n\n| Base excess | -2 | mmol/L |\n| Glucose | 104 | mg/dL |",
  "| HDL cholesterol | 41 | mg/dL |",
  "Dr. Rao\n\nRx: Metformin 500 mg, twice a day",
];

let home: string;
let store: Store;
let sorts: ReturnType<typeof sorting>;
let calls = 0;

beforeEach(async () => {
  clock = T0;
  home = await mkdtemp(join(tmpdir(), "rufi-sorting-"));
  store = openWritable(databasePath(home));
  store.db.exec(`
    INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional'), ('ravi', 'Ravi Fictional');
    INSERT INTO chats (id, person_id, created_at) VALUES ('c-asha', 'asha', '${T0}'), ('c-ravi', 'ravi', '${T0}');
    INSERT INTO files (id, size, media_type, created_at) VALUES ('f-pile', 1, 'application/pdf', '${T0}');
    INSERT INTO documents (id, person_id, added_at, added_from, version, sent_at) VALUES ('pile', 'asha', '${T0}', 'documents_page', 1, '${T0}');
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
      id: "pile",
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
    // Rufi AI's reading of the marked digit; the marks stay in its quote.
    draft(2, "Vitamin B12", "104", {
      value_number: 104,
      quote: "Vitamin B12 | 1[0?]4",
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

describe("the Documents list", () => {
  it("says an add isn't sorted yet, then shows each of its documents with its place in the file, its kind, lab and date", async () => {
    const list = () => openDocuments(store, home, now).list("asha");
    expect(await list()).toEqual([
      expect.objectContaining({
        id: "pile",
        kind: null,
        place: null,
        notSorted: true,
      }),
    ]);
    await sorts.sort(personal(), THREE);
    expect(
      (await list()).map((d) => [d.kind, d.date, d.lab, d.place, d.notSorted]),
    ).toEqual([
      [
        "lab_report",
        "2026-03-12",
        "Sunrise Labs",
        { pages: [1, 2], of: 5 },
        false,
      ],
      [
        "lab_report",
        "2026-08-20",
        "Lakeside Diagnostics",
        { pages: [3, 4], of: 5 },
        false,
      ],
      ["prescription", null, null, { pages: [5], of: 5 }, false],
    ]);
  });
});

describe("a draft's value", () => {
  it("is kept as Rufi AI gives it, also when its page's copy doesn't print it", async () => {
    await sorts.sort(personal(), {
      ...THREE,
      drafts: [draft(2, "Vitamin B12", "104"), draft(2, "Ferritin", "125")],
    });
    expect(drafts().map((d) => d["value"])).toEqual(["104", "125"]);
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
        value: "104",
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
    // Its reading is sorted.
    expect(rows("SELECT sorted_at FROM jobs")).toEqual([{ sorted_at: T0 }]);
    expect(
      answer.documents.map((d) => [d.kind, d.pages, d.drafts, d.worth_a_look]),
    ).toEqual([
      ["lab_report", "1–2", 4, 1],
      ["lab_report", "3–4", 3, 0],
      ["prescription", "5", 0, 0],
    ]);
  });

  it("refuses a call with every problem in it, and writes nothing", async () => {
    const before = { documents: documents(), pages: pagesOfEach() };
    const call = sorts.sort(personal(), {
      document: "pile",
      documents: [
        { pages: [1, 2, 9], kind: "lab_report" },
        { pages: [2, 3], kind: "lab_report" },
      ],
      drafts: [draft(5, "Metformin", "500")],
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
        expect.objectContaining({ path: "drafts.0.page" }),
      ],
    });
    expect({ documents: documents(), pages: pagesOfEach() }).toEqual(before);
    expect(drafts()).toEqual([]);
    expect(rows("SELECT sorted_at FROM jobs")).toEqual([{ sorted_at: null }]);
  });

  it("refuses a document id not of this add or named twice, a new document without its kind, and the add's own document left out", async () => {
    await expect(
      sorts.sort(personal(), {
        document: "pile",
        documents: [
          { id: "doc-other", pages: [1] },
          { id: "pile", pages: [2] },
          { id: "pile", pages: [3] },
          { pages: [4, 5] },
        ],
        drafts: [],
      }),
    ).rejects.toMatchObject({
      issues: [
        expect.objectContaining({ path: "documents.0.id", got: '"doc-other"' }),
        expect.objectContaining({ path: "documents.2.id", got: '"pile"' }),
        expect.objectContaining({ path: "documents.3.kind" }),
      ],
    });
    await expect(
      sorts.sort(personal(), {
        ...THREE,
        documents: THREE.documents.map(({ id: _id, ...group }) => group),
      }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: "documents", got: '"pile"' })],
    });
    expect(documents()).toHaveLength(1);
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
          { id: "pile", pages: [1, 2, 3] },
          { id, pages: [4] },
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
    // new version; page 3's untouched drafts give way to the call's. What
    // the call leaves out of Lakeside's stays.
    const answer = await sorts.sort(personal(), {
      document: "pile",
      documents: [
        { id, pages: [3], report_number: "LD-9" },
        { pages: [4], kind: "lab_report", lab: "Lakeside Diagnostics" },
      ],
      drafts: [draft(3, "Glucose", "104")],
    });
    const after = documents();
    expect(after).toHaveLength(4);
    expect(after[1]).toMatchObject({
      kind: "lab_report",
      date: "2026-08-20",
      issuer: "Lakeside Diagnostics",
      report_number: "LD-9",
    });
    const own = String(after[3]?.["id"]);
    expect(answer.documents.map((d) => [d.kind, d.date, d.pages])).toEqual([
      ["lab_report", "2026-08-20", "3"],
      ["lab_report", null, "4"],
    ]);
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

  it("places a page read again as a new document, and the document it was in keeps its pages, lab and date", async () => {
    await sorts.sort(personal(), THREE);
    const lakeside = documents()[1];
    // Page 4 read again is a letter.
    store.db.exec(`
      INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, ended_at, created_at)
        VALUES ('job-2', 'asha', 'document_read', 'pile', 'done', 1, '[4]', '${T0}', '${T0}');
      INSERT INTO page_copies (person_id, file_id, page_in_file, job_id, attempt, outcome, copy, saved_at)
        VALUES ('asha', 'f-pile', 4, 'job-2', 1, 'read', 'Dear Asha, see you on 21/08/2026.', '${T0}');
    `);
    const answer = await sorts.sort(personal(), {
      document: "pile",
      documents: [{ pages: [4], kind: "letter", date: "2026-08-21" }],
      drafts: [],
    });
    const [, before, , letter] = documents();
    // A page left it: its version goes up, nothing else.
    expect(before).toEqual({ ...lakeside, version: 2 });
    expect(letter).toMatchObject({
      kind: "letter",
      date: "2026-08-21",
      from_document: "pile",
    });
    expect(pagesOfEach().slice(2)).toEqual([
      { document_id: lakeside?.["id"], position: 3 },
      { document_id: letter?.["id"], position: 4 },
      { document_id: expect.any(String) as string, position: 5 },
    ]);
    expect(answer.documents).toMatchObject([
      { id: letter?.["id"], kind: "letter", pages: "4" },
    ]);
  });
});
