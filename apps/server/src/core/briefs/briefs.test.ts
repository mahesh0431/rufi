// Visit briefs as the AI makes them in Rufi's chat: the real tool caller,
// the real transcripts and a real database file with the fictional family.
// Messages are sent at 10:00 on Sunday 4 Oct 2026 in India.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  transcripts as openTranscripts,
  type ChatRow,
  type Transcripts,
} from "../chat/transcript.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "../store/database.ts";
import { chatCaller } from "../tools/tools.ts";
import { readBrief } from "./briefs.ts";

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

let store: Store;
let reader: Store;
let transcripts: Transcripts;
let chat: ChatRow;
let said = 0;

beforeEach(async () => {
  const path = databasePath(await mkdtemp(join(tmpdir(), "rufi-brief-")));
  store = openWritable(path);
  store.db.exec(family);
  reader = openReadOnly(path) as Store;
  transcripts = openTranscripts(store, () => "2026-10-04T04:30:00.000Z");
  chat = (await transcripts.chat("asha")) as ChatRow;
  await transcripts.startTurn(chat, "t-1", {
    id: "thread-1",
    model: "gpt-6.1-sol",
  });
});

/** The AI calls one of Rufi's tools in the chat's turn. */
async function use(
  tool: string,
  input: unknown,
  callId: string,
  origin: "person" | "rufi" = "person",
) {
  const answer = await chatCaller(reader, transcripts, () => undefined)(
    chat,
    "t-1",
    origin,
  )(tool, input, callId);
  return {
    ok: answer.ok,
    body: JSON.parse(answer.text) as Record<string, unknown> & {
      result: Record<string, unknown>;
      issues: { path: string; fix: string }[];
    },
  };
}

/** The user says something, and the AI saves one change resting on it. */
async function saveSaid(text: string, change: Record<string, unknown>) {
  await transcripts.addMessage(chat, {
    id: `msg-${String(++said)}`,
    kind: "message",
    text,
  });
  const saved = await use(
    "save_changes",
    { changes: [{ ...change, source: text }] },
    `save-${String(said)}`,
  );
  expect(saved.ok).toBe(true);
}

const version = async () =>
  (
    (await use("get_overview", {}, `overview-${String(++said)}`)).body
      .result as { record_version: number }
  ).record_version;

const MARKDOWN = `## For the visit on Friday

### Current medicines
- Metformin 500 mg, twice a day
- Creatine 5 g, every morning
- Magnesium 200 mg, at night

### Recent results
- HbA1c 6.8 % (lab range 4.0 - 5.6, marked High), 12 Aug 2026

### Questions to ask
- Question: Is the HbA1c a reason to change the Metformin?`;

const CITED = [
  { kind: "medicine_use", id: "med-a1" },
  { kind: "medicine_use", id: "med-a2" },
  { kind: "result", id: "res-a1" },
];

const rows = (sql: string) => store.db.prepare(sql).all();
/** Everything making a brief writes, to check a refused one wrote nothing. */
const written = () => ({
  briefs: rows("SELECT * FROM briefs"),
  lines: rows("SELECT * FROM transcript_entries WHERE kind = 'brief'"),
  revision: rows(`SELECT revision FROM chats WHERE id = '${chat.id}'`),
});

describe("create_brief", () => {
  it("writes the brief and its line together, with the record version and each cited record's version", async () => {
    await saveSaid("I started magnesium 200 mg at night", {
      kind: "medicine_use",
      action: "add",
      fields: { name: "Magnesium", strength: "200 mg", schedule: "at night" },
    });
    const magnesium = rows(
      "SELECT id FROM medicine_uses WHERE name = 'Magnesium'",
    )[0] as { id: string };
    const saveId = (rows("SELECT id FROM operations")[0] as { id: string }).id;
    const recordVersion = await version();
    expect(recordVersion).toBe(1);

    const made = await use(
      "create_brief",
      {
        markdown: MARKDOWN,
        record_version: recordVersion,
        cited: [...CITED, { kind: "medicine_use", id: magnesium.id }],
      },
      "brief-1",
    );

    expect(made).toMatchObject({
      ok: true,
      body: { result: { brief: "Visit brief · 4 Oct 2026 · 4 records cited" } },
    });
    const [brief] = rows("SELECT * FROM briefs") as {
      id: string;
      cited: string;
      record_version: number;
      turn_id: string;
    }[];
    expect(brief?.record_version).toBe(1);
    expect(JSON.parse(brief?.cited ?? "")).toEqual([
      { kind: "medicine_use", id: "med-a1", version: null },
      { kind: "medicine_use", id: "med-a2", version: null },
      { kind: "result", id: "res-a1", version: null },
      { kind: "medicine_use", id: magnesium.id, version: saveId },
    ]);
    // Its line has its id, in the reply that made it.
    expect(
      rows(
        "SELECT id, turn_id, text FROM transcript_entries WHERE kind = 'brief'",
      ),
    ).toEqual([
      {
        id: brief?.id,
        turn_id: brief?.turn_id,
        text: "Visit brief · 4 Oct 2026 · 4 records cited",
      },
    ]);

    expect(await readBrief(store.query, "asha", brief?.id ?? "")).toEqual({
      id: brief?.id,
      createdAt: "2026-10-04T04:30:00.000Z",
      markdown: MARKDOWN,
      changedSince: false,
      sources: [
        {
          kind: "Medicine use",
          what: "Metformin 500 mg · Mar 2024 · current",
          from: "Saved before Rufi kept sources",
          changedSince: false,
        },
        {
          kind: "Medicine use",
          what: "Creatine 5 g · Jun 2026 · current",
          from: "Saved before Rufi kept sources",
          changedSince: false,
        },
        {
          kind: "Result",
          what: "HbA1c 6.8 % · 12 Aug 2026",
          from: "Sunrise Labs report, collected 12 Aug 2026 · Sunrise Labs August.pdf",
          changedSince: false,
        },
        {
          kind: "Medicine use",
          // Its status isn't known, so it isn't shown.
          what: "Magnesium 200 mg",
          from: "Your message, 4 Oct 2026: “I started magnesium 200 mg at night”",
          changedSince: false,
        },
      ],
    });
  });

  it("shows the record changed since, and keeps each record as it was cited", async () => {
    await use(
      "create_brief",
      { markdown: MARKDOWN, record_version: await version(), cited: CITED },
      "brief-1",
    );
    const id = (rows("SELECT id FROM briefs")[0] as { id: string }).id;
    await saveSaid("I stopped creatine", {
      kind: "medicine_use",
      action: "change",
      id: "med-a2",
      fields: { status: "stopped" },
    });

    const brief = await readBrief(store.query, "asha", id);
    expect(brief?.changedSince).toBe(true);
    expect(
      brief?.sources.map(({ what, changedSince }) => ({ what, changedSince })),
    ).toEqual([
      { what: "Metformin 500 mg · Mar 2024 · current", changedSince: false },
      // As the brief cited it, not as it is now.
      { what: "Creatine 5 g · Jun 2026 · current", changedSince: true },
      { what: "HbA1c 6.8 % · 12 Aug 2026", changedSince: false },
    ]);
    expect(brief?.markdown).toBe(MARKDOWN);
  });

  it("takes an older record version, and then shows the record changed since", async () => {
    // A save while the AI wrote: an accepted rare race, not re-checked.
    const before = await version();
    await saveSaid("I stopped creatine", {
      kind: "medicine_use",
      action: "change",
      id: "med-a2",
      fields: { status: "stopped" },
    });
    await use(
      "create_brief",
      { markdown: MARKDOWN, record_version: before, cited: CITED },
      "brief-1",
    );
    const id = (rows("SELECT id FROM briefs")[0] as { id: string }).id;
    expect((await readBrief(store.query, "asha", id))?.changedSince).toBe(true);
  });

  it("makes one brief for the same call, and refuses the call for another brief", async () => {
    const input = { markdown: MARKDOWN, record_version: 0, cited: CITED };
    const first = await use("create_brief", input, "brief-1");
    const again = await use("create_brief", input, "brief-1");
    expect(again).toMatchObject({
      ok: true,
      body: {
        result: {
          brief: first.body.result["brief"],
          note: "This call already made this brief.",
        },
      },
    });
    const before = written();
    expect(before.briefs).toHaveLength(1);
    expect(before.lines).toHaveLength(1);

    const other = await use(
      "create_brief",
      { ...input, markdown: `${MARKDOWN}\n- Question: Anything else?` },
      "brief-1",
    );
    expect(other.ok).toBe(false);
    expect(other.body["error"]).toBe(
      "This call was already used for another brief, so nothing was made. Make a new call.",
    );
    expect(written()).toEqual(before);
  });

  it("refuses records that aren't saved in this person's record, a removed one and a version Rufi never gave, writing nothing", async () => {
    await saveSaid("Remove the creatine, I never took it", {
      kind: "medicine_use",
      action: "remove",
      id: "med-a2",
    });
    const before = written();
    const refused = await use(
      "create_brief",
      {
        markdown: MARKDOWN,
        record_version: 5,
        cited: [
          { kind: "medicine_use", id: "med-a1" },
          // Ravi's result, and an id the record doesn't have.
          { kind: "result", id: "res-r1" },
          { kind: "result", id: "draft-item-1" },
          { kind: "medicine_use", id: "med-a2" },
        ],
      },
      "brief-1",
    );
    expect(refused.ok).toBe(false);
    expect(refused.body.issues.map(({ path, fix }) => ({ path, fix }))).toEqual(
      [
        {
          path: "record_version",
          fix: "Rufi gave no such record version. Read get_overview and give its record_version.",
        },
        {
          path: "cited.1.id",
          fix: "No result with this id is saved in this person's record. Cite only saved records you read with get_overview or get_records.",
        },
        {
          path: "cited.2.id",
          fix: "No result with this id is saved in this person's record. Cite only saved records you read with get_overview or get_records.",
        },
        {
          path: "cited.3.id",
          fix: "This medicine use was removed from the record. Leave it out of the brief.",
        },
      ],
    );
    expect(written()).toEqual(before);
  });

  it("is refused in a turn a Rufi event started", async () => {
    const before = written();
    const refused = await use(
      "create_brief",
      { markdown: MARKDOWN, record_version: 0, cited: CITED },
      "brief-1",
      "rufi",
    );
    expect(refused.ok).toBe(false);
    expect(refused.body["error"]).toContain("started by a Rufi event");
    expect(written()).toEqual(before);
  });
});

describe("a brief's page", () => {
  it("is read only for its own person", async () => {
    await use(
      "create_brief",
      { markdown: MARKDOWN, record_version: 0, cited: CITED },
      "brief-1",
    );
    const id = (rows("SELECT id FROM briefs")[0] as { id: string }).id;
    expect(await readBrief(store.query, "ravi", id)).toBeUndefined();
    expect(
      await readBrief(store.query, "asha", "no-such-brief"),
    ).toBeUndefined();
  });
});
