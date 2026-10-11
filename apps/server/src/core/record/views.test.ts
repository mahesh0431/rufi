// The record as its screens read it, on a real database file with the
// fictional family: what is current, groups and paging, tiles, a row's
// history and a row that can't be shown. Saves go through the real tool
// caller, as the AI makes them in the chat.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordPage } from "@rufi/contracts/record";
import { beforeEach, describe, expect, it } from "vitest";
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
import { recordViews, type RecordViews } from "./views.ts";

const family = await readFile(
  new URL("../../../tests/fixtures/fictional-family.sql", import.meta.url),
  "utf8",
);

let store: Store;
let reader: Store;
let views: RecordViews;
let transcripts: Transcripts;
let chat: ChatRow;
let clock: string;
let said = 0;
let calls = 0;

beforeEach(async () => {
  const path = databasePath(await mkdtemp(join(tmpdir(), "rufi-views-")));
  store = openWritable(path);
  store.db.exec(family);
  reader = openReadOnly(path) as Store;
  views = recordViews(reader);
  clock = "2026-10-04T04:30:00.000Z";
  said = 0;
  calls = 0;
  transcripts = openTranscripts(store, () => clock);
  chat = (await transcripts.chat("asha")) as ChatRow;
  await transcripts.startTurn(chat, "t-1", {
    id: "thread-1",
    model: "gpt-6.1-sol",
  });
});

/** The user says it, and the AI saves these changes resting on it. */
async function saveSaid(text: string, changes: object[]) {
  await transcripts.addMessage(chat, {
    id: `msg-${String(++said)}`,
    kind: "message",
    text,
  });
  const answer = await chatCaller(reader, transcripts, () => undefined)(
    chat,
    "t-1",
    "person",
  )(
    "save_changes",
    { changes: changes.map((change) => ({ source: text, ...change })) },
    `call-${String(++calls)}`,
  );
  expect(answer.ok).toBe(true);
}

/** Every page of a kind, following each page's cursor. */
async function allPages(kind: Parameters<RecordViews["page"]>[1]) {
  const pages: RecordPage[] = [];
  let after: string | undefined;
  do {
    const page = await views.page("asha", kind, after);
    pages.push(page);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return pages;
}

const idsOf = (page: RecordPage) =>
  page.groups.flatMap((group) => group.rows.map((row) => row.id));

describe("what is current", () => {
  it("leaves out a replaced result and a removed one; the row still opens to its versions", async () => {
    await saveSaid("Remove the CRP result", [
      { kind: "result", action: "remove", id: "res-a3" },
    ]);
    const [page] = await allPages("lab_result");
    // res-a4 is replaced by the amended res-a5; res-a3 was removed.
    expect(
      page?.groups.map((group) => [
        group.id,
        idsOf({ groups: [group], next: null }),
      ]),
    ).toEqual([
      ["report:rep-asha-sep", ["res-a5", "res-a6"]],
      ["report:rep-asha-aug", ["res-a1", "res-a2"]],
      ["chat:2026-05", ["res-a7"]],
      ["chat:", ["res-a8"]],
    ]);
    const replaced = await views.detail("asha", "result", "res-a4");
    expect(replaced?.replacedBy).toMatchObject({ id: "res-a5", value: "4.6" });
    const amended = await views.detail("asha", "result", "res-a5");
    expect(amended?.replaces).toMatchObject({ id: "res-a4", value: "2.1" });
    expect((await views.detail("asha", "result", "res-a3"))?.removed).toBe(
      true,
    );
  });

  it("reads only the person's own rows", async () => {
    expect(await views.detail("asha", "result", "res-r1")).toBeUndefined();
    expect(
      await views.detail("asha", "no_such_kind", "res-a1"),
    ).toBeUndefined();
    const ravi = await views.page("ravi", "lab_result");
    expect(idsOf(ravi)).toEqual(["res-r1", "res-r2"]);
  });
});

describe("groups and paging", () => {
  it("pages by group: newest first, a report whole, a month after its days, undated last, with no group twice or missed", async () => {
    // Eleven more reports in 2025, one with no date, a long one, one with
    // no printed date whose results the person dated, and a result typed on
    // a day of May 2026 beside the one typed for May.
    const reports = Array.from({ length: 11 }, (_, n) => {
      const month = String(n + 1).padStart(2, "0");
      return { id: `rep-x${month}`, collected: `2025-${month}-10` };
    });
    reports.push({ id: "rep-nodate", collected: null as unknown as string });
    reports.push({ id: "rep-said", collected: null as unknown as string });
    const insertReport = store.db.prepare(
      "INSERT INTO reports (id, person_id, document_id, issuer, collected) VALUES (?, 'asha', 'doc-asha-aug', 'Sunrise Labs', ?)",
    );
    const insertResult = store.db.prepare(
      "INSERT INTO results (id, person_id, report_id, category, test_name, value_text, measured_at, entered_at) VALUES (?, 'asha', ?, 'lab', ?, '1', ?, '2026-10-01T10:00:00Z')",
    );
    for (const report of reports) {
      insertReport.run(report.id, report.collected);
      // July's report is long: it ends page 1, whole.
      const size = report.id === "rep-x07" ? 25 : 3;
      // The dated report's results: "around August 2025", a day in July and
      // one with no date. The latest dates the report.
      const said = ["2025-08", "2025-07-20", null];
      for (let n = 1; n <= size; n++) {
        insertResult.run(
          `${report.id}-${String(n)}`,
          report.id,
          `Test ${String(n)}`,
          report.id === "rep-said" ? (said[n - 1] ?? null) : report.collected,
        );
      }
    }
    insertResult.run("res-day", null, "Weight", "2026-05-20T08:30");

    const pages = await allPages("lab_result");
    expect(pages.map((page) => page.groups.map((group) => group.id))).toEqual([
      [
        "report:rep-asha-sep",
        "report:rep-asha-aug",
        "chat:2026-05-20",
        "chat:2026-05",
        "report:rep-x11",
        "report:rep-x10",
        "report:rep-x09",
        "report:rep-x08",
        "report:rep-said",
        "report:rep-x07",
      ],
      [
        "report:rep-x06",
        "report:rep-x05",
        "report:rep-x04",
        "report:rep-x03",
        "report:rep-x02",
        "report:rep-x01",
        "report:rep-nodate",
        "chat:",
      ],
    ]);
    expect(pages[1]?.next).toBeNull();
    // Every current result exactly once.
    const all = pages.flatMap(idsOf);
    expect(all.length).toBe(new Set(all).size);
    const current = store.db
      .prepare(
        "SELECT id FROM results WHERE person_id = 'asha' AND category = 'lab' AND id NOT IN ('res-a4')",
      )
      .all()
      .map((row) => (row as { id: string }).id);
    expect([...all].sort()).toEqual([...current].sort());
    // The long report comes whole on page 1.
    const july = pages[0]?.groups.find(
      (group) => group.id === "report:rep-x07",
    );
    expect(july?.rows).toHaveLength(25);
    expect(july).toMatchObject({
      type: "report",
      issuer: "Sunrise Labs",
      date: "2025-07-10",
    });
    // A report with no printed date takes its results' latest date.
    expect(
      pages[0]?.groups.find((group) => group.id === "report:rep-said"),
    ).toMatchObject({ date: "2025-08" });
    expect(pages[1]?.groups.at(-2)).not.toHaveProperty("date");
  });

  it("refuses a cursor it didn't give", async () => {
    await expect(
      views.page("asha", "lab_result", "not-a-cursor"),
    ).rejects.toThrow("That page isn't one Rufi gave.");
  });
});

describe("tiles", () => {
  it("say what they count: a stopped medicine is in the record, not taken now", async () => {
    store.db.exec(`
      INSERT INTO medicine_uses (id, person_id, name, strength, status, started, ended) VALUES
        ('med-a3', 'asha', 'Amoxicillin', '500 mg', 'stopped', '2024-01', '2024-02');
      INSERT INTO conditions (id, person_id, name, status) VALUES
        ('con-a1', 'asha', 'Type 2 diabetes', 'ongoing'),
        ('con-a2', 'asha', 'Sprained ankle', 'resolved');
      INSERT INTO allergies (id, person_id, substance, status) VALUES
        ('all-a1', 'asha', 'Pollen', 'inactive');
      INSERT INTO none_known (id, person_id, category, asserted) VALUES
        ('nk-a1', 'asha', 'allergies', '2026-10-01');
      INSERT INTO symptoms (id, person_id, name, status, onset) VALUES
        ('sym-a1', 'asha', 'Headache', 'ongoing', '2026-10-09'),
        ('sym-a2', 'asha', 'Cough', 'resolved', '2026-03');`);
    const overview = await views.overview("asha");
    expect(overview?.tiles).toEqual([
      {
        kind: "lab_result",
        count: 7,
        names: [],
        latest: {
          label: "Sunrise Labs",
          date: "2026-09-01",
          results: 2,
          flagged: 1,
        },
      },
      {
        kind: "measurement",
        count: 3,
        names: ["Blood pressure", "Weight"],
        latest: {
          label: "Blood pressure, Weight",
          date: "2026-09-20",
          results: 2,
          flagged: 0,
        },
      },
      {
        kind: "medicine_use",
        count: 3,
        now: 2,
        names: ["Creatine 5 g", "Metformin 500 mg"],
      },
      { kind: "prescription", count: 0, names: [] },
      { kind: "condition", count: 2, now: 1, names: ["Type 2 diabetes"] },
      // An inactive allergy is in the count; "none known" still holds.
      { kind: "allergy", count: 1, now: 0, names: [], noneKnown: "2026-10-01" },
      {
        kind: "symptom",
        count: 2,
        names: [],
        latest: { label: "Headache", date: "2026-10-09" },
      },
      { kind: "care_event", count: 0, names: [] },
    ]);
    // "None known" shows on the allergies' page.
    expect((await views.page("asha", "allergy")).groups).toMatchObject([
      {
        id: "none_known:nk-a1",
        rows: [{ kind: "none_known", asserted: "2026-10-01" }],
      },
      {
        id: "allergy:all-a1",
        rows: [{ kind: "allergy", substance: "Pollen" }],
      },
    ]);
  });
});

describe("a row opened", () => {
  it("lists its sources and every change in the order of saves, a correction as before and after", async () => {
    await saveSaid("My vitamin D was 24, not 22", [
      {
        kind: "result",
        action: "change",
        id: "res-a7",
        fields: { value: "24" },
      },
    ]);
    // The Mac's clock moved back: the order of saves still holds.
    clock = "2026-10-01T04:30:00.000Z";
    await saveSaid("Take the vitamin D result out", [
      { kind: "result", action: "remove", id: "res-a7" },
    ]);
    const opened = await views.detail("asha", "result", "res-a7");
    expect(
      opened?.history.map(({ action, at, fields, fromMessage }) => ({
        action,
        at,
        fields,
        fromMessage,
      })),
    ).toEqual([
      {
        action: "change",
        at: "2026-10-04T04:30:00.000Z",
        fields: [{ field: "value", before: "22", after: "24" }],
        fromMessage: true,
      },
      {
        action: "remove",
        at: "2026-10-01T04:30:00.000Z",
        fields: [],
        fromMessage: true,
      },
    ]);
    // A removal adds no source; the correction's message is one.
    expect(opened?.sources).toEqual([
      {
        type: "message",
        entry: "msg-1",
        text: "My vitamin D was 24, not 22",
        at: "2026-10-04T04:30:00.000Z",
      },
    ]);
    // A result read from a document points to its page.
    expect((await views.detail("asha", "result", "res-a1"))?.sources).toEqual([
      {
        type: "document",
        document: "doc-asha-aug",
        page: 1,
        file: "Sunrise Labs August.pdf",
      },
    ]);
  });

  it("shows a stored row that doesn't fit as can't-show, and the page and tiles still answer", async () => {
    store.db.exec(
      "INSERT INTO results (id, person_id, category, test_name, value_text, measured_at, entered_at) VALUES ('res-bad', 'asha', 'lab', 'Iron', '80', 'last week', '2026-10-01T10:00:00Z')",
    );
    const page = await views.page("asha", "lab_result");
    expect(page.groups.at(-1)?.rows).toEqual([
      expect.objectContaining({
        kind: "result",
        id: "res-a8",
        value: "B positive",
      }),
      {
        kind: "result",
        id: "res-bad",
        problem: "Its stored values don't fit a result.",
      },
    ]);
    expect((await views.overview("asha"))?.tiles[0]).toMatchObject({
      count: 8,
    });
  });
});

describe("series", () => {
  it("lists a test's current values in one unit and category, dated oldest first, undated last", async () => {
    store.db.exec(`
      INSERT INTO results (id, person_id, category, test_name, value_text, unit, measured_at, entered_at) VALUES
        ('tsh-mar', 'asha', 'lab', 'TSH', '1.9', 'mIU/L', '2026-03', '2026-10-01T10:00:00Z'),
        ('tsh-none', 'asha', 'lab', 'TSH', '3.0', 'mIU/L', NULL, '2026-10-01T10:00:00Z'),
        ('tsh-other', 'asha', 'lab', 'TSH', '1900', 'µIU/mL', '2026-04-01', '2026-10-01T10:00:00Z'),
        ('tsh-moved', 'asha', 'measurement', 'TSH', '2.5', 'mIU/L', '2026-04-01', '2026-10-01T10:00:00Z');`);
    const series = await views.series("asha", "TSH", "mIU/L", "lab");
    // The replaced 2.1 isn't a point: the amended 4.6 is.
    expect(series.values.map((value) => value.id)).toEqual([
      "tsh-mar",
      "res-a5",
      "tsh-none",
    ]);
    const other = await views.series("asha", "TSH", "mIU/L", "measurement");
    expect(other.values.map((value) => value.id)).toEqual(["tsh-moved"]);
  });
});

describe("lab results and measurements", () => {
  it("show each category on its page: a report's lab results whole on Lab results, measurements by the day taken at its precision, undated last", async () => {
    store.db.exec(`
      INSERT INTO reports (id, person_id, document_id, issuer, collected) VALUES
        ('rep-visit', 'asha', 'doc-asha-sep', 'Lakeview Clinic', NULL);
      INSERT INTO results (id, person_id, report_id, category, test_name, value_text, unit, measured_at, entered_at) VALUES
        ('bp-sep', 'asha', 'rep-asha-sep', 'measurement', 'Blood pressure', '130/85', 'mmHg', '2026-09-01', '2026-10-01T10:00:00Z'),
        ('lab-visit', 'asha', 'rep-visit', 'lab', 'Ferritin', '35', 'ng/mL', '2025-07-20', '2026-10-01T10:00:00Z'),
        ('pulse-visit', 'asha', 'rep-visit', 'measurement', 'Pulse', '72', '/min', '2025-09-03T10:15', '2026-10-01T10:00:00Z'),
        ('height-when', 'asha', NULL, 'measurement', 'Height', '160', 'cm', NULL, '2026-10-01T10:00:00Z');`);
    const groupsOf = async (kind: "lab_result" | "measurement") =>
      (await allPages(kind)).flatMap((page) =>
        page.groups.map((group) => ({
          id: group.id,
          type: group.type,
          date: group.date,
          issuer: group.issuer,
          rows: group.rows.map((row) => row.id),
        })),
      );

    expect(await groupsOf("lab_result")).toEqual([
      {
        id: "report:rep-asha-sep",
        type: "report",
        date: "2026-09-01",
        issuer: "Sunrise Labs",
        rows: ["res-a5", "res-a6"],
      },
      {
        id: "report:rep-asha-aug",
        type: "report",
        date: "2026-08-12",
        issuer: "Sunrise Labs",
        rows: ["res-a1", "res-a2", "res-a3"],
      },
      {
        id: "chat:2026-05",
        type: "chat",
        date: "2026-05",
        issuer: undefined,
        rows: ["res-a7"],
      },
      // A report with no printed date takes its lab results' latest date,
      // not its measurements'.
      {
        id: "report:rep-visit",
        type: "report",
        date: "2025-07-20",
        issuer: "Lakeview Clinic",
        rows: ["lab-visit"],
      },
      {
        id: "chat:",
        type: "chat",
        date: undefined,
        issuer: undefined,
        rows: ["res-a8"],
      },
    ]);
    expect(await groupsOf("measurement")).toEqual([
      {
        id: "day:2026-09-20",
        type: "day",
        date: "2026-09-20",
        issuer: undefined,
        rows: ["res-a9", "res-a10"],
      },
      {
        id: "day:2026-09-01",
        type: "day",
        date: "2026-09-01",
        issuer: undefined,
        rows: ["bp-sep"],
      },
      {
        id: "day:2026-08",
        type: "day",
        date: "2026-08",
        issuer: undefined,
        rows: ["res-a11"],
      },
      {
        id: "day:2025-09-03",
        type: "day",
        date: "2025-09-03",
        issuer: undefined,
        rows: ["pulse-visit"],
      },
      {
        id: "day:",
        type: "day",
        date: undefined,
        issuer: undefined,
        rows: ["height-when"],
      },
    ]);
  });

  it("move a result that an amendment in the other category replaces, and back when it is undone", async () => {
    const pageIds = async (kind: "lab_result" | "measurement") =>
      (await allPages(kind)).flatMap(idsOf);
    const counts = async () =>
      (await views.overview("asha"))?.tiles
        .slice(0, 2)
        .map((tile) => [tile.kind, tile.count]);

    await saveSaid("That vitamin D was a home test of 24", [
      {
        kind: "result",
        action: "add",
        fields: {
          test: "Vitamin D",
          value: "24",
          category: "measurement",
          replaces: "res-a7",
        },
      },
    ]);
    const amendment = String(
      (
        store.db
          .prepare("SELECT id FROM results WHERE replaces_id = 'res-a7'")
          .get() as { id: string }
      ).id,
    );
    expect(await pageIds("lab_result")).not.toContain("res-a7");
    expect(await pageIds("measurement")).toContain(amendment);
    expect(await counts()).toEqual([
      ["lab_result", 6],
      ["measurement", 4],
    ]);

    await saveSaid("Undo that", [
      { kind: "result", action: "remove", id: amendment },
    ]);
    expect(await pageIds("lab_result")).toContain("res-a7");
    expect(await pageIds("measurement")).not.toContain(amendment);
    expect(await counts()).toEqual([
      ["lab_result", 7],
      ["measurement", 3],
    ]);
  });
});

describe("follow-ups", () => {
  it("group by where they stand at the core's time, soonest first; Needs you has the overdue, due and coming-up ones", async () => {
    store.db
      .exec(`INSERT INTO follow_ups (id, person_id, title, due, status, outcome, removed) VALUES
      ('f-over', 'asha', 'Recheck vitamin D', '2026-09', 'open', NULL, 0),
      ('f-month', 'asha', 'Fasting lipid panel', '2026-10', 'open', NULL, 0),
      ('f-today', 'asha', 'Call the clinic', '2026-10-11T09:00', 'open', NULL, 0),
      ('f-soon', 'asha', 'Recheck HbA1c', '2026-11-03', 'open', NULL, 0),
      ('f-later', 'asha', 'Eye check-up', '2027', 'open', NULL, 0),
      ('f-visit', 'asha', 'Ask about the dose', 'next_visit', 'open', NULL, 0),
      ('f-none', 'asha', 'Find the vaccination card', NULL, 'open', NULL, 0),
      ('f-done', 'asha', 'Recheck ferritin', '2026-08', 'done', '35 ng/mL', 0),
      ('f-dropped', 'asha', 'Repeat the ultrasound', '2026-07', 'dropped', 'Not needed', 0),
      ('f-removed', 'asha', 'Taken out', '2026-09', 'open', NULL, 1),
      ('f-ravi', 'ravi', 'Recheck lipids', '2026-09', 'open', NULL, 0);`);
    views = recordViews(reader, () => new Date(2026, 9, 11, 14, 20));

    const { groups } = await views.followUps("asha");
    const overview = await views.overview("asha");

    expect(
      groups.map(({ group, rows }) => [group, rows.map((row) => row.id)]),
    ).toEqual([
      ["overdue", ["f-over"]],
      ["due", ["f-today", "f-month"]],
      ["coming_up", ["f-soon"]],
      ["later", ["f-later"]],
      ["next_visit", ["f-visit"]],
      ["no_date", ["f-none"]],
      ["done", ["f-done"]],
      ["dropped", ["f-dropped"]],
    ]);
    expect(
      overview?.needsYou.followUps.map(({ state, followUp }) => [
        state,
        followUp.id,
      ]),
    ).toEqual([
      ["overdue", "f-over"],
      ["due", "f-today"],
      ["due", "f-month"],
      ["coming_up", "f-soon"],
    ]);
    expect(overview?.openFollowUps).toBe(7);
  });
});
