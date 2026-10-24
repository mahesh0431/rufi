// Saving a document's draft items, as the AI does it in Rufi's chat: the
// real tool caller, the real transcripts, a real database with the
// fictional family, and drafts made by a real sort of the reader's page
// copies. Messages are sent at 10:00 on Sunday 11 Oct 2026 in India.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chip } from "@rufi/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  transcripts as openTranscripts,
  type ChatRow,
  type Transcripts,
} from "../chat/transcript.ts";
import type { Entry } from "../documents/notebook.ts";
import { draftItems } from "../documents/items.ts";
import { sorting } from "../documents/sorting.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "../store/database.ts";
import { chatCaller } from "../tools/tools.ts";

const TZ = process.env["TZ"];
process.env["TZ"] = "Asia/Kolkata";
afterAll(() => {
  if (TZ === undefined) delete process.env["TZ"];
  else process.env["TZ"] = TZ;
});

const family = await readFile(
  new URL("../../../tests/fixtures/fictional-family.sql", import.meta.url),
  "utf8",
);
const SUNDAY_10AM = "2026-10-11T04:30:00.000Z";

let store: Store;
let reader: Store;
let transcripts: Transcripts;
let chat: ChatRow;
let said = 0;
let calls = 0;

beforeEach(async () => {
  const path = databasePath(await mkdtemp(join(tmpdir(), "rufi-items-")));
  store = openWritable(path);
  store.db.exec(family);
  reader = openReadOnly(path) as Store;
  transcripts = openTranscripts(store, () => SUNDAY_10AM);
  chat = (await transcripts.chat("asha")) as ChatRow;
  await transcripts.startTurn(chat, "t-1", {
    id: "thread-1",
    model: "gpt-6.1-sol",
  });
  return () => {
    reader.close();
    store.close();
  };
});

const COLLECTED = { label: "Collected", date: "12/08/2026", iso: "2026-08-12" };

/** Page 1 prints the report's head; page 2 is its table going on. */
const PAGES: Record<number, Entry> = {
  1: {
    outcome: "read",
    facts: {
      kind: "lab_report",
      dates: [COLLECTED, { label: "Reported", date: "13/08/2026" }],
      issuer: "Sunrise Labs",
      name: "Asha Fictional",
      report_number: "SL-1042",
    },
    items: [
      {
        test_name: "HbA1c",
        value_text: "7.1",
        value_number: 7.1,
        unit: "%",
        reference_range: "4.0 - 5.6",
        flag_text: "H",
      },
      {
        test_name: "TSH",
        value_text: "2.1",
        value_number: 2.1,
        unit: "mIU/L",
        reference_range: "0.4 - 4.0",
      },
    ],
  },
  2: {
    outcome: "read",
    items: [
      {
        test_name: "LDL cholesterol",
        value_text: "142",
        value_number: 142,
        unit: "mg/dL",
        flag_text: "High",
        unsure: "the last digit is smudged",
      },
      {
        test_name: "Vitamin D",
        value_text: "18",
        unit: "ng/mL",
        date: { label: "Collected", date: "03/04/2026" },
        column: "earlier",
      },
    ],
  },
};

/** A page's copy, as the reader would write it: its head and its table. */
function copyOf(entry: Entry): string {
  const facts = entry.facts;
  const head = [
    ...(facts?.issuer ? [`# ${facts.issuer}`] : []),
    ...(facts?.report_number ? [`Report No: ${facts.report_number}`] : []),
    ...(facts?.dates ?? []).map((d) => `${d.label}: ${d.date}`),
  ];
  const rows = entry.outcome === "read" ? entry.items : [];
  return [
    ...head,
    "",
    "| Test | Result | Unit | Range | Flag |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(
      (item) =>
        `| ${item.test_name} | ${item.value_text} | ${item.unit ?? ""} | ${item.reference_range ?? ""} | ${item.flag_text ?? ""} |`,
    ),
  ].join("\n");
}

/**
 * Reads a document with these pages as Rufi does now: the reader's copy of
 * each page, then Rufi AI's sort of it in the user's turn (sort_documents),
 * making one document of every page with its drafts, as an AI would from
 * the copies: the lab, number and first date printed, and each item's own
 * date, or else its report's for a current value.
 */
async function read(
  pages: Record<number, Entry> = PAGES,
  documentId = "doc-asha-aug",
) {
  const sorted = await call("sort_documents", copied(pages, documentId));
  expect(sorted.ok, JSON.stringify(sorted)).toBe(true);
}

/** The reader's copies of these pages, and the sort Rufi AI would call. */
function copied(pages: Record<number, Entry>, documentId: string) {
  const jobId = `job-${documentId}`;
  const targets = Object.keys(pages).map(Number);
  store.db
    .prepare(
      "INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, ended_at, created_at) VALUES (?, 'asha', 'document_read', ?, 'done', 1, ?, '2026-10-11T04:01:00Z', '2026-10-11T04:00:00Z')",
    )
    .run(jobId, documentId, JSON.stringify(targets));
  for (const [position, entry] of Object.entries(pages)) {
    store.db
      .prepare(
        `INSERT INTO page_copies (person_id, file_id, page_in_file, job_id, attempt, outcome, copy, saved_at)
         SELECT person_id, file_id, page_in_file, ?, 1, 'read', ?, '2026-10-11T04:00:30Z'
         FROM document_pages WHERE person_id = 'asha' AND document_id = ? AND position = ?`,
      )
      .run(jobId, copyOf(entry), documentId, Number(position));
    store.db
      .prepare(
        "UPDATE document_pages SET entry_job_id = ?, entry_attempt = 1, state = 'read' WHERE document_id = ? AND position = ?",
      )
      .run(jobId, documentId, Number(position));
  }
  const facts = Object.values(pages).flatMap((p) => (p.facts ? [p.facts] : []));
  const dated = facts.find((f) => f.dates?.[0] !== undefined)?.dates?.[0];
  const drafts = Object.entries(pages).flatMap(([position, entry]) =>
    entry.outcome !== "read"
      ? []
      : entry.items.map(
          ({ unsure, column, from_page: _from, date, ...item }) => {
            const when = date ?? (column === "earlier" ? undefined : dated);
            return {
              page: Number(position),
              ...item,
              ...(when !== undefined && { date: when }),
              quote: `${item.test_name} ${item.value_text}`,
              ...(unsure !== undefined && { worth_a_look: unsure }),
            };
          },
        ),
  );
  const issuer = facts.find((f) => f.issuer)?.issuer;
  const number = facts.find((f) => f.report_number)?.report_number;
  return {
    document: documentId,
    documents: [
      {
        id: documentId,
        pages: targets,
        kind: facts.find((f) => f.kind)?.kind ?? "lab_report",
        ...(dated?.iso !== undefined && { date: dated.iso }),
        ...(issuer !== undefined && { lab: issuer }),
        ...(number !== undefined && { report_number: number }),
      },
    ],
    drafts,
  };
}

/** The draft items' ids by test, in page order. */
const drafts = () =>
  Object.fromEntries(
    (
      store.db
        .prepare(
          "SELECT id, fields FROM draft_items WHERE person_id = 'asha' ORDER BY page, seq",
        )
        .all() as { id: string; fields: string }[]
    ).map((row) => [
      (JSON.parse(row.fields) as { test_name: string }).test_name,
      row.id,
    ]),
  ) as Record<string, string>;

/** The user says it in this turn, with its chips. */
async function say(text: string, refs?: Chip[]): Promise<string> {
  const id = `msg-${String(++said)}`;
  await transcripts.addMessage(chat, {
    id,
    kind: "message",
    text,
    agentTurnId: "t-1",
    ...(refs !== undefined && { refs }),
  });
  return id;
}

/** The AI calls a tool in the chat's turn, started by `origin`. */
async function call(
  tool: string,
  input: unknown,
  origin: "person" | "rufi" = "person",
  callId = `call-${String(++calls)}`,
) {
  const answer = await chatCaller(
    reader,
    transcripts,
    () => undefined,
    undefined,
    { run: sorting(store, () => SUNDAY_10AM).sort, done: () => undefined },
  )(chat, "t-1", origin)(tool, input, callId);
  return {
    ...(JSON.parse(answer.text) as object),
    kept: answer.kept,
  } as {
    kept?: true;
    ok: boolean;
    result: {
      receipt?: string;
      changes: { kind: string; action: string; id: string }[];
      already_saved?: unknown[];
      note?: string;
      dismissed?: string[];
    };
    error?: string;
    issues: { path: string; fix: string }[];
  };
}

const rows = (sql: string, ...params: unknown[]) =>
  store.db
    .prepare(sql)
    .all(...(params as string[]))
    .map((row) => ({ ...row }));
const one = (sql: string, ...params: unknown[]) => rows(sql, ...params)[0];

/** Everything a save writes, to check that a refused one wrote nothing. */
const written = () => ({
  operations: rows("SELECT * FROM operations"),
  results: rows("SELECT * FROM results ORDER BY rowid"),
  sources: rows("SELECT * FROM record_sources ORDER BY rowid"),
  reports: rows("SELECT * FROM reports ORDER BY rowid"),
  drafts: rows("SELECT * FROM draft_items ORDER BY rowid"),
  receipts: rows("SELECT text FROM transcript_entries WHERE kind = 'receipt'"),
});

/** A receipt as plain lines, without Markdown marks and escapes. */
const lines = (receipt: unknown) =>
  String(receipt)
    .split("\n")
    .map((line) =>
      line
        .replace(/^- /, "")
        .replace(/\\(.)|\*/g, (_, kept?: string) => kept ?? ""),
    )
    .filter((line) => line !== "");

describe("saving draft items", () => {
  it("saves Rufi AI's drafts in their document's report, as sorted, and never in another document's with the same printed report", async () => {
    const page = (test: string, value: string): Record<number, Entry> => ({
      1: {
        outcome: "read",
        facts: {
          issuer: "Sunrise Labs",
          report_number: "SL-7",
          dates: [COLLECTED],
        },
        items: [{ test_name: test, value_text: value }],
      },
    });
    await read(page("Ferritin", "42"));
    // The same report added again, as another file.
    await read(page("Vitamin B12", "510"), "doc-asha-sep");
    const { Ferritin = "", "Vitamin B12": B12 = "" } = drafts();
    await say("Save both");
    const saved = await call("save_changes", {
      items: [Ferritin, B12].map((item) => ({
        item,
        version: 1,
        as: "new",
        category: "lab",
      })),
    });
    expect(saved.ok).toBe(true);
    expect(
      rows(
        "SELECT p.document_id, p.issuer, p.report_number, p.collected, r.measured_at FROM results r JOIN reports p ON p.person_id = r.person_id AND p.id = r.report_id WHERE r.test_name IN ('Ferritin', 'Vitamin B12') ORDER BY r.test_name",
      ),
    ).toEqual([
      {
        document_id: "doc-asha-aug",
        issuer: "Sunrise Labs",
        report_number: "SL-7",
        collected: "2026-08-12",
        measured_at: "2026-08-12",
      },
      {
        document_id: "doc-asha-sep",
        issuer: "Sunrise Labs",
        report_number: "SL-7",
        collected: "2026-08-12",
        measured_at: "2026-08-12",
      },
    ]);
  });

  it("dates Rufi AI's draft only by its own date: one without is refused until the user gives one", async () => {
    await read();
    const { HbA1c = "" } = drafts();
    // As if Rufi AI left the date out.
    store.db
      .prepare(
        "UPDATE draft_items SET fields = json_remove(fields, '$.date') WHERE id = ?",
      )
      .run(HbA1c);
    await say("Save the HbA1c");
    const refused = await call("save_changes", {
      items: [{ item: HbA1c, version: 1, as: "new", category: "lab" }],
    });
    expect(refused.issues[0]?.fix).toMatch(
      /^This item has no date Rufi can store \(none is printed for it\)/,
    );
  });

  it("refuses a draft whose page was read again since, and saves nothing", async () => {
    await read();
    const { HbA1c = "" } = drafts();
    // Page 1 is read again: a newer reading's copy of it.
    store.db.exec(`
      INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, ended_at, created_at)
        VALUES ('job-again', 'asha', 'document_read', 'doc-asha-aug', 'done', 1, '[1]', '2026-10-11T05:01:00Z', '2026-10-11T05:00:00Z');
      INSERT INTO page_copies (person_id, file_id, page_in_file, job_id, attempt, outcome, copy, saved_at)
        SELECT person_id, file_id, page_in_file, 'job-again', 1, 'read', '| HbA1c | 7.1 | % |', '2026-10-11T05:00:30Z'
        FROM document_pages WHERE document_id = 'doc-asha-aug' AND position = 1;
    `);
    await say("Save the HbA1c");
    const before = written();
    const refused = await call("save_changes", {
      items: [{ item: HbA1c, version: 1, as: "new", category: "lab" }],
    });
    expect(refused.issues[0]?.fix).toBe(
      "This draft is out of date: its page was read again since it was drafted. Read the document again with get_documents and save its new drafts.",
    );
    expect(written()).toEqual(before);
  });

  it("saves the stored items exactly, each with its document page as its source, in one report", async () => {
    await read();
    const { HbA1c = "", TSH = "" } = drafts();
    await say("Save the HbA1c and TSH");
    const saved = await call("save_changes", {
      items: [
        { item: HbA1c, version: 1, as: "new", category: "lab" },
        { item: TSH, version: 1, as: "new", category: "lab" },
      ],
    });
    expect(saved.ok).toBe(true);
    expect(lines(saved.result.receipt)).toEqual([
      "Saved 2 results from Sunrise Labs August.pdf · 2 new",
      'Added result HbA1c 7.1 %: category lab, range 4.0 - 5.6, flag H, measured 12 Aug 2026 ("Collected 12/08/2026") · page 1',
      'Added result TSH 2.1 mIU/L: category lab, range 0.4 - 4.0, measured 12 Aug 2026 ("Collected 12/08/2026") · page 1',
    ]);
    const [hba1c, tsh] = saved.result.changes.map((c) => c.id);
    // The values are the reader's, as printed; Rufi's report groups them.
    expect(
      one(
        "SELECT test_name, value_text, value_number, unit, reference_range, flag_text, measured_at, measured_words, report_id FROM results WHERE id = ?",
        hba1c,
      ),
    ).toEqual({
      test_name: "HbA1c",
      value_text: "7.1",
      value_number: 7.1,
      unit: "%",
      reference_range: "4.0 - 5.6",
      flag_text: "H",
      measured_at: "2026-08-12",
      measured_words: "Collected 12/08/2026",
      report_id: expect.any(String) as string,
    });
    expect(
      rows(
        "SELECT issuer, report_number, collected FROM reports WHERE report_number IS NOT NULL",
      ),
    ).toEqual([
      {
        issuer: "Sunrise Labs",
        report_number: "SL-1042",
        collected: "2026-08-12",
      },
    ]);
    expect(
      rows(
        "SELECT record_id, type, document_id, page, entry_id FROM record_sources WHERE record_id IN (?, ?) ORDER BY rowid",
        hba1c,
        tsh,
      ),
    ).toEqual([
      {
        record_id: hba1c,
        type: "document_page",
        document_id: "doc-asha-aug",
        page: 1,
        entry_id: null,
      },
      {
        record_id: tsh,
        type: "document_page",
        document_id: "doc-asha-aug",
        page: 1,
        entry_id: null,
      },
    ]);
    expect(
      rows(
        "SELECT status, saved_as, record_id, version, operation_id IS NOT NULL AS by_save FROM draft_items WHERE id IN (?, ?) ORDER BY page, seq",
        HbA1c,
        TSH,
      ),
    ).toEqual([
      {
        status: "saved",
        saved_as: "new",
        record_id: hba1c,
        version: 1,
        by_save: 1,
      },
      {
        status: "saved",
        saved_as: "new",
        record_id: tsh,
        version: 1,
        by_save: 1,
      },
    ]);
    // A save from a document alone rests on no message.
    expect(rows("SELECT action, source_entry_id FROM record_changes")).toEqual([
      { action: "add", source_entry_id: null },
      { action: "add", source_entry_id: null },
    ]);
  });

  it("applies the user's fix and keeps the reader's value in the draft", async () => {
    await read();
    const { "LDL cholesterol": ldl = "" } = drafts();
    const message = await say("The LDL is 132, not 142");
    const saved = await call("save_changes", {
      items: [
        {
          item: ldl,
          version: 1,
          as: "new",
          category: "lab",
          fix: {
            fields: { value: "132", number: 132 },
          },
        },
      ],
    });
    expect(saved.ok).toBe(true);
    const id = saved.result.changes[0]?.id ?? "";
    expect(
      one("SELECT value_text, value_number FROM results WHERE id = ?", id),
    ).toEqual({ value_text: "132", value_number: 132 });
    expect(lines(saved.result.receipt).at(-1)).toMatch(
      /· page 2, and your message$/,
    );
    expect(
      rows(
        "SELECT type, entry_id, page FROM record_sources WHERE record_id = ? ORDER BY rowid",
        id,
      ),
    ).toEqual([
      { type: "message", entry_id: message, page: null },
      { type: "document_page", entry_id: null, page: 2 },
    ]);
    expect(
      one("SELECT source_entry_id FROM record_changes WHERE record_id = ?", id),
    ).toEqual({ source_entry_id: message });
    const draft = one(
      "SELECT fields, original FROM draft_items WHERE id = ?",
      ldl,
    ) as { fields: string; original: string };
    expect(JSON.parse(draft.fields)).toMatchObject({ value_text: "142" });
    expect(JSON.parse(draft.original)).toMatchObject({ value_text: "142" });
  });

  it("takes the number of a value the user fixed on the document's page from the save, and only for that value", async () => {
    await read();
    const { HbA1c = "", TSH = "", "LDL cholesterol": LDL = "" } = drafts();
    const pageFix = (item: string, value: string) =>
      draftItems(store, () => undefined).fix("asha", "doc-asha-aug", item, {
        version: 1,
        fields: { value_text: value },
      });
    await pageFix(HbA1c, "7,4");
    // Then corrected again in the chat: the page fix's number goes with it.
    await pageFix(LDL, "<4,6");
    await say("Save them; the LDL actually says Negative");
    const refused = await call("save_changes", {
      items: [
        {
          item: HbA1c,
          version: 2,
          as: "new",
          category: "lab",
          value_number: 7.4,
        },
        {
          item: TSH,
          version: 1,
          as: "new",
          category: "lab",
          value_number: 2.4,
        },
      ],
    });
    expect(refused.issues.map((i) => i.path)).toEqual(["items.1.value_number"]);
    const saved = await call("save_changes", {
      items: [
        {
          item: HbA1c,
          version: 2,
          as: "new",
          category: "lab",
          value_number: 7.4,
        },
        { item: TSH, version: 1, as: "new", category: "lab" },
        {
          item: LDL,
          version: 2,
          as: "new",
          category: "lab",
          value_number: 4.6,
          comparator: "<",
          fix: { fields: { value: "Negative" } },
        },
      ],
    });
    expect(saved.ok).toBe(true);
    expect(
      saved.result.changes.map((c) =>
        one(
          "SELECT value_text, comparator, value_number FROM results WHERE id = ?",
          c.id,
        ),
      ),
    ).toEqual([
      { value_text: "7,4", comparator: null, value_number: 7.4 },
      { value_text: "2.1", comparator: null, value_number: 2.1 },
      { value_text: "Negative", comparator: null, value_number: null },
    ]);
  });

  it("refuses an item with no date it can store until the user gives one", async () => {
    await read();
    const { "Vitamin D": vitamin = "" } = drafts();
    await say("Save the vitamin D, it was taken on 3 April");
    const refused = await call("save_changes", {
      items: [{ item: vitamin, version: 1, as: "new", category: "lab" }],
    });
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]?.fix).toBe(
      "This item has no date Rufi can store (\"Collected 03/04/2026\": the order of day and month isn't certain). Ask the user when the sample was taken; a rough date such as 'around August 2026' is fine. Give it in fix.fields.measured at the precision they gave, with the words it came from; never make one up.",
    );
    const saved = await call("save_changes", {
      items: [
        {
          item: vitamin,
          version: 1,
          as: "new",
          category: "lab",
          fix: {
            fields: { measured: { date: "2026-04-03", words: "3 April" } },
          },
        },
      ],
    });
    expect(saved.ok).toBe(true);
    expect(
      one(
        "SELECT measured_at, measured_words FROM results WHERE id = ?",
        saved.result.changes[0]?.id,
      ),
    ).toEqual({ measured_at: "2026-04-03", measured_words: "3 April" });
  });

  it("adds the page as another source of a result already saved, changing no value; undo takes off only that link", async () => {
    await read();
    const { TSH = "" } = drafts();
    // The user typed a TSH before; the report has the same one.
    store.db
      .exec(`INSERT INTO results (id, person_id, category, test_name, value_text, unit, measured_at, entered_at)
      VALUES ('res-typed', 'asha', 'lab', 'TSH', '2.1', 'mIU/L', '2026-08-12', '2026-09-01T00:00:00Z')`);
    const before = one("SELECT * FROM results WHERE id = 'res-typed'");
    await say("Yes, it's the same TSH");
    // Another source never changes the saved result, its category neither.
    const unchanged = written();
    const moved = await call("save_changes", {
      items: [
        {
          item: TSH,
          version: 1,
          as: "another_source",
          record: { id: "res-typed", version: null },
          category: "lab",
        },
      ],
    });
    expect(moved.issues.map((i) => i.path)).toEqual(["items.0.category"]);
    expect(written()).toEqual(unchanged);
    const linked = await call("save_changes", {
      items: [
        {
          item: TSH,
          version: 1,
          as: "another_source",
          record: { id: "res-typed", version: null },
        },
      ],
    });
    expect(linked.ok).toBe(true);
    expect(lines(linked.result.receipt)).toEqual([
      "Saved 1 result from Sunrise Labs August.pdf · 1 more source",
      "Added a source to result TSH 2.1 mIU/L: Sunrise Labs August.pdf, page 1 (its values stay as they are)",
    ]);
    expect(one("SELECT * FROM results WHERE id = 'res-typed'")).toEqual(before);
    const save = (one("SELECT id FROM operations") as { id: string }).id;
    expect(rows("SELECT action FROM record_changes")).toEqual([
      { action: "link" },
    ]);
    // The record's version is that save now.
    const records = await call("get_records", {
      kind: "result",
      ids: ["res-typed"],
    });
    expect(records.result).toMatchObject({
      records: [
        {
          id: "res-typed",
          version: save,
          sources: [
            {
              document: "doc-asha-aug",
              page: 1,
              file: "Sunrise Labs August.pdf",
            },
          ],
        },
      ],
    });

    await say("Undo that");
    const undone = await call("save_changes", {
      changes: [
        {
          kind: "result",
          action: "remove_source",
          id: "res-typed",
          from: { document: "doc-asha-aug", page: 1 },
        },
      ],
    });
    expect(undone.ok).toBe(true);
    expect(lines(undone.result.receipt)).toEqual([
      "Saved",
      "Took a source off result TSH 2.1 mIU/L: Sunrise Labs August.pdf, page 1 (its values stay as they are)",
    ]);
    expect(one("SELECT * FROM results WHERE id = 'res-typed'")).toEqual(before);
    expect(
      rows(
        "SELECT removed_by IS NOT NULL AS removed FROM record_sources WHERE record_id = 'res-typed'",
      ),
    ).toEqual([{ removed: 1 }]);
    // The draft stays saved: it doesn't come back as new.
    expect(one("SELECT status FROM draft_items WHERE id = ?", TSH)).toEqual({
      status: "saved",
    });
  });

  it("links a page again after an undo took it off the result, in a save of its own with a receipt and history", async () => {
    // The same result printed on both pages of the report.
    const haemoglobin = {
      test_name: "Haemoglobin",
      value_text: "13.4",
      value_number: 13.4,
      unit: "g/dL",
    };
    await read({
      1: {
        outcome: "read",
        facts: { dates: [COLLECTED], issuer: "Sunrise Labs" },
        items: [haemoglobin],
      },
      2: { outcome: "read", items: [haemoglobin] },
    });
    const [first = "", second = ""] = rows(
      "SELECT id FROM draft_items ORDER BY page",
    ).map((row) => String(row["id"]));
    const versionOf = async (id: string) =>
      (
        (await call("get_records", { kind: "result", ids: [id] })).result as {
          records?: { version: string | null }[];
        }
      ).records?.[0]?.version ?? null;
    const relink = async (id: string) => ({
      item: second,
      version: 1,
      as: "another_source",
      record: { id, version: await versionOf(id) },
    });

    await say("Save it; page 2 is the same result");
    const saved = await call("save_changes", {
      items: [{ item: first, version: 1, as: "new", category: "lab" }],
    });
    const id = saved.result.changes[0]?.id ?? "";
    const firstSave = (one("SELECT id FROM operations") as { id: string }).id;
    expect((await call("save_changes", { items: [await relink(id)] })).ok).toBe(
      true,
    );
    await say("Undo both");
    for (const change of [
      {
        kind: "result",
        action: "remove_source",
        id,
        from: { document: "doc-asha-aug", page: 2 },
      },
      { kind: "result", action: "remove", id },
    ]) {
      expect((await call("save_changes", { changes: [change] })).ok).toBe(true);
    }
    await say("Save it again, with both pages");
    // A removed result takes no page: it is put back first.
    const removed = written();
    const refused = await call("save_changes", { items: [await relink(id)] });
    expect(refused.issues.map((i) => [i.path, i.fix])).toEqual([
      [
        "items.0.record",
        "That result is removed. To save this item into it, put it back first with a restore change, in a save of its own, after the user's yes; then save the item.",
      ],
    ]);
    expect(written()).toEqual(removed);
    expect(
      (
        await call("save_changes", {
          changes: [{ kind: "result", action: "restore", id }],
        })
      ).ok,
    ).toBe(true);
    const again = await call("save_changes", { items: [await relink(id)] });
    expect(again.ok).toBe(true);
    expect(lines(again.result.receipt)).toEqual([
      "Saved 1 result from Sunrise Labs August.pdf · 1 more source",
      "Added a source to result Haemoglobin 13.4 g/dL: Sunrise Labs August.pdf, page 2 (its values stay as they are)",
    ]);
    expect(again.result.changes).toEqual([
      { kind: "result", action: "link", id },
    ]);
    const save = (
      one("SELECT id FROM operations ORDER BY seq DESC LIMIT 1") as {
        id: string;
      }
    ).id;
    expect(
      one(
        "SELECT status, saved_as, record_id, operation_id FROM draft_items WHERE id = ?",
        second,
      ),
    ).toEqual({
      status: "saved",
      saved_as: "another_source",
      record_id: id,
      operation_id: save,
    });
    expect(
      rows(
        "SELECT c.action FROM record_changes c JOIN operations o ON o.id = c.operation_id WHERE c.record_id = ? ORDER BY o.seq, c.seq",
        id,
      ).map((row) => row["action"]),
    ).toEqual(["add", "link", "unlink", "remove", "restore", "link"]);
    expect(
      rows(
        "SELECT page FROM record_sources WHERE record_id = ? AND type = 'document_page' AND removed_by IS NULL ORDER BY page",
        id,
      ),
    ).toEqual([{ page: 1 }, { page: 2 }]);

    // Both pages are sources now, so both items are saved as they are.
    const after = written();
    const twice = await call("save_changes", {
      items: [
        { item: first, version: 1, as: "new", category: "lab" },
        await relink(id),
      ],
    });
    expect(twice.ok).toBe(true);
    expect(twice.result.changes).toEqual([]);
    expect(twice.result.already_saved).toEqual([
      {
        item: first,
        as: "new",
        record: id,
        save: firstSave,
      },
      { item: second, as: "another_source", record: id, save },
    ]);
    expect(written()).toEqual(after);
  });

  it("saves a correction as a new result that replaces the saved one", async () => {
    await read();
    const { HbA1c = "" } = drafts();
    await say("That report corrects my HbA1c");
    const saved = await call("save_changes", {
      items: [
        {
          item: HbA1c,
          version: 1,
          as: "correction",
          record: { id: "res-a1", version: null },
        },
      ],
    });
    expect(saved.ok).toBe(true);
    expect(lines(saved.result.receipt)[1]).toBe(
      'Added result HbA1c 7.1 %: category lab, range 4.0 - 5.6, flag H, measured 12 Aug 2026 ("Collected 12/08/2026"), replaces HbA1c 6.8 % · page 1',
    );
    expect(
      one(
        "SELECT replaces_id FROM results WHERE id = ?",
        saved.result.changes[0]?.id,
      ),
    ).toEqual({ replaces_id: "res-a1" });
    expect(one("SELECT value_text FROM results WHERE id = 'res-a1'")).toEqual({
      value_text: "6.8",
    });
  });

  it("needs a category for a new item; a correction keeps the corrected result's unless the save gives one", async () => {
    await read();
    const { HbA1c = "", TSH = "" } = drafts();
    await say("Save them: both correct my saved results");
    const before = written();
    const none = await call("save_changes", {
      items: [{ item: HbA1c, version: 1, as: "new" }],
    });
    expect(none.issues.map((i) => i.path)).toEqual(["items.0.category"]);
    expect(written()).toEqual(before);

    const saved = await call("save_changes", {
      items: [
        {
          item: HbA1c,
          version: 1,
          as: "correction",
          record: { id: "res-a1", version: null },
        },
        {
          item: TSH,
          version: 1,
          as: "correction",
          // A weight typed in the chat (a measurement), corrected by a lab value.
          record: { id: "res-a10", version: null },
          category: "lab",
        },
      ],
    });
    expect(saved.ok).toBe(true);
    expect(
      saved.result.changes.map((c) =>
        one("SELECT category FROM results WHERE id = ?", c.id),
      ),
    ).toEqual([{ category: "lab" }, { category: "lab" }]);
  });

  it("refuses two items that both correct the same saved result", async () => {
    await read();
    const { HbA1c = "", TSH = "" } = drafts();
    await say("Both correct my HbA1c");
    const before = written();
    const refused = await call("save_changes", {
      items: [HbA1c, TSH].map((item) => ({
        item,
        version: 1,
        as: "correction",
        record: { id: "res-a1", version: null },
      })),
    });
    expect(refused.ok).toBe(false);
    expect(refused.issues).toEqual([
      {
        path: "items.1.record",
        got: expect.any(String) as unknown,
        fix: "items.0 already changes this result: make it one change.",
      },
    ]);
    expect(written()).toEqual(before);
  });

  it("refuses a stale, dismissed or unknown item, or a changed record, and saves nothing", async () => {
    await read();
    const { HbA1c = "", TSH = "", "LDL cholesterol": ldl = "" } = drafts();
    store.db.exec(
      `UPDATE draft_items SET version = 2 WHERE id = '${TSH}'; UPDATE draft_items SET status = 'dismissed', dismissed_by = 'x' WHERE id = '${ldl}'`,
    );
    const before = written();
    await say("Save them");
    const refused = await call("save_changes", {
      items: [
        {
          item: HbA1c,
          version: 1,
          as: "correction",
          record: { id: "res-a1", version: "an-old-save" },
        },
        { item: TSH, version: 1, as: "new", category: "lab" },
        { item: ldl, version: 1, as: "new", category: "lab" },
        { item: "drf-ravi", version: 1, as: "new", category: "lab" },
      ],
    });
    expect(refused.ok).toBe(false);
    expect(refused.issues.map((i) => [i.path, i.fix])).toEqual([
      [
        "items.0.record",
        "That result changed since you read it: its version is null now. Read it again with get_records, tell the user what changed and ask again.",
      ],
      [
        "items.1.version",
        "This item changed since you read it: it is at version 2 now. Read it again with get_documents, tell the user what changed and ask again.",
      ],
      [
        "items.2.item",
        "This item was dismissed, so it is never saved. Say so to the user.",
      ],
      [
        "items.3.item",
        "No draft item with this id is this person's. Read the document with get_documents for its items.",
      ],
    ]);
    expect(written()).toEqual(before);
  });

  it("saves an item once: the same item again returns its earlier save", async () => {
    await read();
    const { HbA1c = "" } = drafts();
    await say("Save it");
    const first = await call("save_changes", {
      items: [{ item: HbA1c, version: 1, as: "new", category: "lab" }],
    });
    const after = written();
    const again = await call("save_changes", {
      items: [{ item: HbA1c, version: 1, as: "new", category: "lab" }],
    });
    expect(again.ok).toBe(true);
    expect(again.result).toEqual({
      changes: [],
      already_saved: [
        {
          item: HbA1c,
          as: "new",
          record: first.result.changes[0]?.id,
          save: (one("SELECT id FROM operations") as { id: string }).id,
        },
      ],
      note: "Nothing was saved, and Rufi added no receipt: every item is in the record already, as its earlier save in already_saved put it. If the user asked for something else, read the result with get_records and tell them.",
    });
    expect(written()).toEqual(after);

    // Beside an item saved now, it is named as not saved again.
    const { TSH = "" } = drafts();
    const mixed = await call("save_changes", {
      items: [
        { item: HbA1c, version: 1, as: "new", category: "lab" },
        { item: TSH, version: 1, as: "new", category: "lab" },
      ],
    });
    expect(mixed.ok).toBe(true);
    expect(lines(mixed.result.receipt)[0]).toBe(
      "Saved 1 result from Sunrise Labs August.pdf · 1 new",
    );
    expect(mixed.result.already_saved).toHaveLength(1);
    expect(mixed.result.note).toBe(
      "The items in already_saved weren't saved again: each is in the record already, as its earlier save put it.",
    );
  });

  it("refuses a save when the document changed since the user's message pointed at it", async () => {
    await read();
    const { HbA1c = "" } = drafts();
    const chip: Chip = {
      ref: { type: "document", id: "doc-asha-aug", version: 1 },
      label: "Sunrise Labs August.pdf",
      detail: "Lab report",
    };
    await say("Save it", [chip]);
    // A fix or a retry moved the document on meanwhile.
    store.db.exec("UPDATE documents SET version = 2 WHERE id = 'doc-asha-aug'");
    const refused = await call("save_changes", {
      items: [{ item: HbA1c, version: 1, as: "new", category: "lab" }],
    });
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]?.fix).toBe(
      "The document changed since the user's message (a reading or a fix): read it again with get_documents, tell the user what changed and ask again.",
    );
  });

  it("saves 300 items in one save with a summary receipt", async () => {
    await read({
      1: {
        outcome: "read",
        facts: { dates: [COLLECTED], issuer: "Sunrise Labs" },
        items: Array.from({ length: 300 }, (_, i) => ({
          test_name: `Test ${String(i + 1)}`,
          value_text: String(i),
        })),
      },
      2: { outcome: "nothing_here", items: [] },
    });
    const ids = Object.values(drafts());
    await say("Save all of them");
    const saved = await call("save_changes", {
      items: ids.map((item) => ({
        item,
        version: 1,
        as: "new",
        category: "lab",
      })),
    });
    expect(saved.ok).toBe(true);
    expect(saved.result.changes).toHaveLength(300);
    expect(rows("SELECT id FROM operations")).toHaveLength(1);
    const receipt = (
      one("SELECT text FROM transcript_entries WHERE kind = 'receipt'") as {
        text: string;
      }
    ).text;
    expect(lines(receipt)[0]).toBe(
      "Saved 300 results from Sunrise Labs August.pdf · 300 new",
    );
    expect(lines(receipt)).toHaveLength(301);
    // The AI gets the start of it; the chat has it whole.
    expect(saved.result.receipt).toMatch(/282 more lines in Rufi's receipt/);
  });

  it("removes a saved result to undo a save from a document", async () => {
    await read();
    const { HbA1c = "" } = drafts();
    await say("Save it");
    const saved = await call("save_changes", {
      items: [{ item: HbA1c, version: 1, as: "new", category: "lab" }],
    });
    const id = saved.result.changes[0]?.id ?? "";
    await say("Undo that");
    const undone = await call("save_changes", {
      changes: [{ kind: "result", action: "remove", id }],
    });
    expect(undone.ok).toBe(true);
    expect(one("SELECT removed FROM results WHERE id = ?", id)).toEqual({
      removed: 1,
    });

    // Asked again, the item goes in as a new result of its own.
    await say("Save it again");
    const again = await call("save_changes", {
      items: [{ item: HbA1c, version: 1, as: "new", category: "lab" }],
    });
    expect(again.ok).toBe(true);
    expect(lines(again.result.receipt)[1]).toBe(
      'Added result HbA1c 7.1 %: category lab, range 4.0 - 5.6, flag H, measured 12 Aug 2026 ("Collected 12/08/2026") · page 1',
    );
    const added = again.result.changes[0]?.id ?? "";
    expect(added).not.toBe(id);
    expect(
      one(
        "SELECT record_id, operation_id FROM draft_items WHERE id = ?",
        HbA1c,
      ),
    ).toEqual({
      record_id: added,
      operation_id: (
        one("SELECT id FROM operations ORDER BY seq DESC LIMIT 1") as {
          id: string;
        }
      ).id,
    });
    expect(one("SELECT removed FROM results WHERE id = ?", id)).toEqual({
      removed: 1,
    });
  });
});

describe("a sort again", () => {
  it("keeps the lab, number and date it leaves out: a later save from the same report lands in the same report", async () => {
    await read();
    const save = async (item: string) => {
      const saved = await call("save_changes", {
        items: [{ item, version: 1, as: "new", category: "lab" }],
      });
      expect(saved.ok, JSON.stringify(saved)).toBe(true);
      return saved.result.changes[0]?.id ?? "";
    };
    await say("Save the HbA1c");
    const hba1c = await save(drafts()["HbA1c"] ?? "");
    // Page 2 sorted again into its document, naming nothing else of it.
    const again = await call("sort_documents", {
      document: "doc-asha-aug",
      documents: [{ id: "doc-asha-aug", pages: [2] }],
      drafts: [
        {
          page: 2,
          test_name: "LDL cholesterol",
          value_text: "142",
          unit: "mg/dL",
          date: COLLECTED,
          quote: "LDL cholesterol 142",
        },
      ],
    });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    await say("Save the LDL too");
    const ldl = await save(drafts()["LDL cholesterol"] ?? "");
    const report = (id: string) =>
      rows(
        "SELECT p.id, p.issuer, p.report_number, p.collected FROM results r JOIN reports p ON p.person_id = r.person_id AND p.id = r.report_id WHERE r.id = ?",
        id,
      );
    expect(report(hba1c)).toEqual([
      {
        id: expect.any(String) as string,
        issuer: "Sunrise Labs",
        report_number: "SL-1042",
        collected: "2026-08-12",
      },
    ]);
    expect(report(ldl)).toEqual(report(hba1c));
  });
});

describe("a sort's trace", () => {
  it("is kept with the sort, in its transaction: when it can't be kept, nothing is sorted; the same call again answers the same", async () => {
    const input = copied(PAGES, "doc-asha-aug");
    const before = rows("SELECT * FROM documents WHERE id = 'doc-asha-aug'");
    store.db.exec(
      "CREATE TRIGGER no_trace BEFORE INSERT ON tool_calls BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const failed = await call("sort_documents", input, "person", "call-sort");
    expect(failed.ok).toBe(false);
    expect(rows("SELECT * FROM documents WHERE id = 'doc-asha-aug'")).toEqual(
      before,
    );
    expect(drafts()).toEqual({});
    expect(
      rows("SELECT sorted_at FROM jobs WHERE id = 'job-doc-asha-aug'"),
    ).toEqual([{ sorted_at: null }]);

    store.db.exec("DROP TRIGGER no_trace");
    const { kept: given, ...sorted } = await call(
      "sort_documents",
      input,
      "person",
      "call-sort",
    );
    expect(sorted.ok).toBe(true);
    // Kept with the sort, exactly as the AI gets it: the chat keeps it no
    // more.
    expect(given).toBe(true);
    const kept = rows(
      "SELECT tool, input, answer, ok FROM tool_calls WHERE call_id = 'call-sort'",
    );
    expect(kept).toEqual([
      {
        tool: "sort_documents",
        input: JSON.stringify(input),
        answer: JSON.stringify(sorted),
        ok: 1,
      },
    ]);

    // The same call again gets the same answer and writes nothing.
    const documents = rows("SELECT id, version FROM documents");
    const { kept: _, ...again } = await call(
      "sort_documents",
      input,
      "person",
      "call-sort",
    );
    expect(again).toEqual(sorted);
    expect(rows("SELECT id, version FROM documents")).toEqual(documents);
  });
});

describe("dismissing draft items", () => {
  it("dismisses items for good with a receipt line, and raises their versions", async () => {
    await read();
    const { "Vitamin D": vitamin = "", HbA1c = "" } = drafts();
    await say("Skip the vitamin D, that row is old");
    const done = await call("dismiss_items", {
      items: [{ item: vitamin, version: 1 }],
    });
    expect(done.ok).toBe(true);
    expect(lines(done.result.receipt)).toEqual([
      "Set aside 1 item from Sunrise Labs August.pdf: not saved",
      "Vitamin D 18 ng/mL · page 2",
    ]);
    expect(
      one("SELECT status, version FROM draft_items WHERE id = ?", vitamin),
    ).toEqual({ status: "dismissed", version: 2 });
    const save = await call("save_changes", {
      items: [{ item: vitamin, version: 2, as: "new", category: "lab" }],
    });
    expect(save.ok).toBe(false);
    // A saved item can't be dismissed; nothing of the call is.
    await call("save_changes", {
      items: [{ item: HbA1c, version: 1, as: "new", category: "lab" }],
    });
    const refused = await call("dismiss_items", {
      items: [{ item: HbA1c, version: 1 }],
    });
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]?.fix).toBe(
      "This item is saved in the record. To take it out, remove its record with save_changes, after the user says yes.",
    );
  });

  it("lets the rest be saved in the same turn as the document the message pointed at", async () => {
    await read();
    const { "Vitamin D": vitamin = "", HbA1c = "" } = drafts();
    await say("Save it, but not the vitamin D", [
      {
        ref: { type: "document", id: "doc-asha-aug", version: 1 },
        label: "Sunrise Labs August.pdf",
        detail: "Lab report",
      },
    ]);
    const done = await call("dismiss_items", {
      items: [{ item: vitamin, version: 1 }],
    });
    expect(done.ok).toBe(true);
    const saved = await call("save_changes", {
      items: [{ item: HbA1c, version: 1, as: "new", category: "lab" }],
    });
    expect(saved.ok).toBe(true);
  });
});

describe("a turn a Rufi event started", () => {
  it("can't save, dismiss or sort draft items", async () => {
    await read();
    const { HbA1c = "" } = drafts();
    const before = written();
    const sorted = drafts();
    for (const [tool, input] of [
      [
        "save_changes",
        { items: [{ item: HbA1c, version: 1, as: "new", category: "lab" }] },
      ],
      ["dismiss_items", { items: [{ item: HbA1c, version: 1 }] }],
      [
        "sort_documents",
        {
          document: "doc-asha-aug",
          documents: [{ id: "doc-asha-aug", pages: [1], kind: "letter" }],
          drafts: [],
        },
      ],
    ] as const) {
      const answer = await call(tool, input, "rufi");
      expect(answer.ok).toBe(false);
      expect(answer.error).toBe(
        "This turn was started by a Rufi event, not by the user, so nothing can be saved, sorted or made in it. Explain or ask; the user asks in a message of their own.",
      );
    }
    expect(written()).toEqual(before);
    expect(drafts()).toEqual(sorted);
  });
});
