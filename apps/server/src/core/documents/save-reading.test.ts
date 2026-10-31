// A reading saved whole by a reading agent (save_reading), through the
// chat's tool caller on a real database: it writes a reading as older ones
// are stored, its pages waiting to be sorted; the same call again gets its kept answer, and what
// Rufi keeps of the call holds no page text; a document deleted first,
// another person's, or a page it doesn't have refuses it, with nothing
// written.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { turnScope } from "../../../tests/scope.ts";
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
import { rufiCaller } from "../tools/tools.ts";
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
  const answer = await rufiCaller(
    reader,
    transcripts,
    () => undefined,
    undefined,
    { run: sorting(store, now).sort, done: () => undefined },
    undefined,
    { run: saveReading(now), done: () => undefined },
  )(turnScope(chat, "t-1"))(tool, input, callId);
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

/** What readings of doc-asha-aug wrote, its job's id as "job". */
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
  it("writes a reading as older readings are stored: done, a copy of each page and each page's state, its pages waiting to be sorted", async () => {
    const saved = await call(
      "save_reading",
      { document: "doc-asha-aug", pages: PAGES },
      "call-read",
    );
    expect(saved).toMatchObject({
      ok: true,
      result: { pages: "1–2", unreadable: "2" },
    });
    expect(
      rows(rufi.store, "SELECT state, targets, sorted_at, error FROM jobs"),
    ).toEqual([
      { state: "done", targets: "[1,2]", sorted_at: null, error: null },
    ]);
    expect(
      rows(
        rufi.store,
        "SELECT page_in_file, outcome, copy, why FROM page_copies ORDER BY page_in_file",
      ),
    ).toEqual([
      { page_in_file: 1, outcome: "read", copy: PAGE_1, why: null },
      {
        page_in_file: 2,
        outcome: "unreadable",
        copy: PAGE_2,
        why: "The lower half is blurred.",
      },
    ]);
    expect(
      rows(
        rufi.store,
        "SELECT position, state, state_why FROM document_pages WHERE document_id = 'doc-asha-aug' ORDER BY position",
      ),
    ).toEqual([
      { position: 1, state: "read", state_why: null },
      {
        position: 2,
        state: "unreadable",
        state_why: "The lower half is blurred.",
      },
    ]);
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
  });

  it("of fewer pages than the document has leaves the others not looked at, never read, until a reading saves them", async () => {
    const states = () =>
      rows(
        rufi.store,
        "SELECT position, state FROM document_pages WHERE document_id = 'doc-asha-aug' ORDER BY position",
      );
    const first = await call(
      "save_reading",
      { document: "doc-asha-aug", pages: [PAGES[0]] },
      "call-first",
    );
    expect(first).toMatchObject({
      ok: true,
      result: { pages: "1", not_read: "2" },
    });
    expect(states()).toEqual([
      { position: 1, state: "read" },
      { position: 2, state: "not_looked_at" },
    ]);
    const rest = await call(
      "save_reading",
      { document: "doc-asha-aug", pages: [PAGES[1]] },
      "call-rest",
    );
    expect(rest.result).toEqual(
      expect.not.objectContaining({ not_read: expect.anything() as unknown }),
    );
    expect(states()).toEqual([
      { position: 1, state: "read" },
      { position: 2, state: "unreadable" },
    ]);
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
