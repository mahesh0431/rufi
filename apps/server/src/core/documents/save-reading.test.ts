// A reading saved whole by a reading agent (save_reading), through the
// chat's tool caller on a real database: it writes what the old reader's run
// writes, row for row; the same call again gets its kept answer, and what
// Rufi keeps of the call holds no page text; a document deleted first,
// another person's, or a page it doesn't have refuses it, with nothing
// written.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  transcripts as openTranscripts,
  type ChatRow,
} from "../chat/transcript.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "../store/database.ts";
import { chatCaller } from "../tools/tools.ts";
import { copies } from "./copies.ts";
import { readings } from "./reading.ts";
import { saveReading } from "./save-reading.ts";
import { sorting } from "./sorting.ts";

const family = await readFile(
  new URL("../../../tests/fixtures/fictional-family.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-10-30T09:00:00.000Z";
const now = () => NOW;

/** doc-asha-aug's two pages as a reader copies them: the second one blurred. */
const PAGE_1 =
  "# Sunrise Labs\n\n| Test | Result | Unit |\n| --- | --- | --- |\n| HbA1c | 7.1 | % |";
const PAGE_2 = "| LDL cholesterol | 1[4?]2 | mg/dL |";
const PAGES = [
  { page: 1, outcome: "read" as const, copy: PAGE_1 },
  {
    page: 2,
    outcome: "unreadable" as const,
    copy: PAGE_2,
    why: "The lower half is blurred.",
  },
];

/** A fictional family in a store of its own, with Asha's chat in a turn. */
async function opened() {
  const path = databasePath(await mkdtemp(join(tmpdir(), "rufi-saved-")));
  const store = openWritable(path);
  store.db.exec(family);
  const reader = openReadOnly(path) as Store;
  const transcripts = openTranscripts(store, now);
  const chat = (await transcripts.chat("asha")) as ChatRow;
  await transcripts.startTurn(chat, "t-1", {
    id: "thread-1",
    model: "gpt-6.1-sol",
  });
  return { store, reader, transcripts, chat };
}

let rufi: Awaited<ReturnType<typeof opened>>;
beforeEach(async () => {
  rufi = await opened();
  return () => {
    rufi.reader.close();
    rufi.store.close();
  };
});

/** The AI calls a tool in the chat's turn. */
async function call(
  tool: string,
  input: unknown,
  callId: string,
  { store, reader, transcripts, chat } = rufi,
) {
  const answer = await chatCaller(
    reader,
    transcripts,
    () => undefined,
    undefined,
    { run: sorting(store, now).sort, done: () => undefined },
    { run: saveReading(now), done: () => undefined },
  )(chat, "t-1", "person")(tool, input, callId);
  return JSON.parse(answer.text) as {
    ok: boolean;
    result?: { reading: string; pages: string; unreadable?: string };
    error?: string;
    issues?: { path: string }[];
  };
}

const rows = (store: Store, sql: string) =>
  store.db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));

/** What a reading of doc-asha-aug wrote, its job's id as "job". */
function written(store: Store) {
  const [job] = rows(store, "SELECT id FROM jobs");
  const named = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value === job?.["id"] ? "job" : value,
      ]),
    );
  return {
    jobs: rows(store, "SELECT * FROM jobs").map(named),
    copies: rows(store, "SELECT * FROM page_copies ORDER BY page_in_file").map(
      named,
    ),
    pages: rows(
      store,
      "SELECT * FROM document_pages WHERE document_id = 'doc-asha-aug' ORDER BY position",
    ).map(named),
    documents: rows(store, "SELECT id, version FROM documents"),
  };
}

describe("a reading agent's saved reading", () => {
  it("writes what the old reader's run writes, row for row, and its pages wait to be sorted", async () => {
    // The old reader copies both pages in a run and finishes it.
    const old = await opened();
    const reads = readings(old.store, now);
    const job = await old.store.query
      .transaction()
      .execute((trx) => reads.open(trx, "asha", "doc-asha-aug", false));
    if (!job) throw new Error("No reading was opened.");
    const run = await reads.startRun(job);
    const book = copies(old.store, now);
    for (const { page, ...copy } of PAGES) {
      run.lookedAt.add(page);
      await book.save(run, page, copy);
    }
    await reads.finish(run);

    const saved = await call(
      "save_reading",
      { document: "doc-asha-aug", pages: PAGES },
      "call-read",
    );
    expect(saved).toMatchObject({
      ok: true,
      result: { pages: "1–2", unreadable: "2" },
    });
    expect(written(rufi.store)).toEqual(written(old.store));
    // Rufi AI sorts from it: get_documents names it as the copies' reading.
    const sortable = await call(
      "get_documents",
      { document: "doc-asha-aug", copies: true },
      "call-copies",
    );
    expect(sortable).toMatchObject({
      ok: true,
      result: {
        copies: [
          { page: 1, sorted: false, reading: saved.result?.reading },
          { page: 2, sorted: false, reading: saved.result?.reading },
        ],
      },
    });
    old.reader.close();
    old.store.close();
  });

  it("gets its kept answer when the same call comes again, writes once, and keeps no page text", async () => {
    const input = { document: "doc-asha-aug", pages: PAGES };
    const first = await call("save_reading", input, "call-read");
    const again = await call("save_reading", input, "call-read");
    expect(again).toEqual(first);
    expect(rows(rufi.store, "SELECT id FROM jobs")).toHaveLength(1);
    const kept = rows(rufi.store, "SELECT input, answer FROM tool_calls");
    expect(
      kept.map((call): unknown => JSON.parse(String(call["input"]))),
    ).toEqual(
      kept.map(() => ({
        document: "doc-asha-aug",
        pages: [
          {
            page: 1,
            outcome: "read",
            copy: `(${String(PAGE_1.length)} characters)`,
          },
          {
            page: 2,
            outcome: "unreadable",
            copy: `(${String(PAGE_2.length)} characters)`,
            why: `(${String(PAGES[1]?.why?.length)} characters)`,
          },
        ],
      })),
    );
    expect(JSON.stringify(kept)).not.toMatch(/HbA1c|LDL cholesterol|blurred/);
  });

  it("is refused, with nothing written, for a document deleted first, another person's, or a page the document doesn't have", async () => {
    const before = written(rufi.store);
    rufi.store.db.exec(
      "UPDATE documents SET deleted_at = '2026-10-30T08:59:00Z' WHERE id = 'doc-asha-sep'",
    );
    const refused = [
      await call(
        "save_reading",
        { document: "doc-asha-sep", pages: [PAGES[0]] },
        "call-1",
      ),
      await call(
        "save_reading",
        { document: "doc-ravi-jul", pages: [PAGES[0]] },
        "call-2",
      ),
      await call(
        "save_reading",
        {
          document: "doc-asha-aug",
          pages: [PAGES[0], { ...PAGES[0], page: 3 }, PAGES[0]],
        },
        "call-3",
      ),
    ];
    expect(refused.map((answer) => answer.ok)).toEqual([false, false, false]);
    expect(refused[0]?.error).toMatch(/deleted this document/);
    expect(refused[1]?.error).toMatch(/no such document/);
    expect(refused[2]?.issues?.map((issue) => issue.path)).toEqual([
      "pages.1.page",
      "pages.2.page",
    ]);
    expect(written(rufi.store)).toEqual(before);
  });
});
