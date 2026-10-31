import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { TABLES_TS, tablesTs } from "../../../scripts/db-types.ts";
import { TOOLS_JSON } from "../../../scripts/tools-json.ts";
import {
  databasePath,
  onlyPersonId,
  openReadOnly,
  openWritable,
  type Store,
} from "../store/database.ts";
import { transcripts, type ChatRow } from "../chat/transcript.ts";
import { RESULTS_SHOWN } from "./overview.ts";
import {
  defineTool,
  NoInput,
  REJECTIONS_PER_TURN,
  Refusal,
  toolCaller,
  type ToolContext,
} from "./registry.ts";
import { LIMITS } from "./records.ts";
import {
  chatCaller,
  forAgent,
  REJECTIONS_SETTING,
  TOOLS,
  toolsJson,
} from "./tools.ts";
import type { Log } from "../../platform/logs.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const schema = await read("../store/schema.sql");
const family = await read("../../../tests/fixtures/fictional-family.sql");

let path: string;
let logged: string[];
/** Records each log event as one JSON line, as the log file would. */
const record: Log = (event, fields) => {
  logged.push(JSON.stringify({ event, ...fields }));
};

/** A database file with the schema and, by default, the fictional family. */
function makeDatabase(...sql: string[]): Store {
  const db = new DatabaseSync(path);
  db.exec(schema);
  for (const statements of sql) db.exec(statements);
  db.close();
  const store = openReadOnly(path);
  if (!store) throw new Error("no database");
  return store;
}

beforeEach(async () => {
  path = databasePath(await mkdtemp(join(tmpdir(), "rufi-tools-")));
  logged = [];
});

/** Calls a tool as the agent would and returns the parsed answer. */
async function call(
  context: ToolContext,
  name = "get_overview",
  input: unknown = {},
) {
  const answer = await forAgent(() => context, record).forTurn()(name, input);
  return {
    ...answer,
    body: JSON.parse(answer.text) as Record<string, unknown>,
  };
}

describe("get_overview", () => {
  it("shows a person's current results as printed, newest measured first; a file still unsent in the chat box isn't counted", async () => {
    const store = makeDatabase(
      family,
      "INSERT INTO documents (id, person_id, added_at, added_from) VALUES ('doc-unsent', 'asha', '2026-10-01T09:00:00Z', 'chat')",
    );
    const { ok, body } = await call({ store, personId: "asha" });
    expect(ok).toBe(true);
    expect(body).toEqual({
      ok: true,
      result: {
        person: "Asha Fictional",
        documents: 2,
        reports: 2,
        results: 10,
        earlier_versions_kept: 1,
        latest_results: [
          {
            id: "res-a10",
            test: "Weight",
            value: "61.5",
            category: "measurement",
            unit: "kg",
            measured: "2026-09-20",
          },
          {
            id: "res-a9",
            test: "Blood pressure",
            value: "128/84",
            category: "measurement",
            unit: "mmHg",
            measured: "2026-09-20",
          },
          {
            id: "res-a6",
            test: "Free T4",
            value: "1.1",
            category: "lab",
            unit: "ng/dL",
            range: "0.8 - 1.8",
            context: "Direct",
            measured: "2026-09-01",
          },
          {
            id: "res-a5",
            test: "TSH",
            value: "4.6",
            category: "lab",
            unit: "mIU/L",
            range: "0.4 - 4.0",
            flag: "High",
            measured: "2026-08-12",
            amended: true,
          },
          {
            id: "res-a3",
            test: "CRP",
            value: "<5",
            category: "lab",
            unit: "mg/L",
            range: "<10",
            measured: "2026-08-12",
          },
          {
            id: "res-a2",
            test: "Glucose",
            value: "118",
            category: "lab",
            unit: "mg/dL",
            range: "70 - 99",
            flag: "High",
            context: "Fasting",
            measured: "2026-08-12",
          },
          {
            id: "res-a1",
            test: "HbA1c",
            value: "6.8",
            category: "lab",
            unit: "%",
            range: "4.0 - 5.6",
            flag: "High",
            measured: "2026-08-12",
          },
          {
            id: "res-a11",
            test: "Weight",
            value: "62",
            category: "measurement",
            unit: "kg",
            measured: "2026-08",
          },
          {
            id: "res-a7",
            test: "Vitamin D",
            value: "22",
            category: "lab",
            unit: "ng/mL",
            range: "30 - 100",
            flag: "Low",
            measured: "2026-05",
          },
          {
            id: "res-a8",
            test: "Blood group",
            value: "B positive",
            category: "lab",
          },
        ],
        record: {
          medicine_use: {
            items: [
              {
                id: "med-a2",
                name: "Creatine",
                strength: "5 g",
                schedule: "every morning",
                status: "current",
                started: { date: "2026-06" },
              },
              {
                id: "med-a1",
                name: "Metformin",
                strength: "500 mg",
                amount: "1 tablet",
                schedule: "twice a day",
                route: "by mouth",
                purpose: "blood sugar",
                status: "current",
                started: { date: "2024-03" },
              },
            ],
          },
        },
        latest_saves: [],
        record_version: 0,
      },
    });
  });

  it("reads only the chosen person's record", async () => {
    const store = makeDatabase(family);
    const { body } = await call({ store, personId: "ravi" });
    expect(body).toMatchObject({
      result: { person: "Ravi Fictional", documents: 1, results: 2 },
    });
    expect(JSON.stringify(body)).not.toContain("HbA1c");
  });

  it(`shows at most ${String(RESULTS_SHOWN)} results, in a stable order`, async () => {
    const rows = Array.from({ length: 25 }, (_, i) => {
      const n = String(i).padStart(2, "0");
      return `('extra-${n}', 'ravi', NULL, 'measurement', 'Weight', '${n}', NULL, NULL, 'kg', NULL, NULL, NULL, '2026-01-01', '2026-01-01T00:00:00Z', NULL)`;
    });
    const store = makeDatabase(
      family,
      `INSERT INTO results (id, person_id, report_id, category, test_name, value_text, comparator, value_number, unit, reference_range, flag_text, context_text, measured_at, entered_at, replaces_id) VALUES ${rows.join(",")}`,
    );
    const { body } = await call({ store, personId: "ravi" });
    const latest = (body["result"] as { latest_results: { value: string }[] })
      .latest_results;
    expect(latest).toHaveLength(RESULTS_SHOWN);
    // The June results first (same dates, so by id, newest first), then the
    // same-date extras by id.
    expect(latest.slice(0, 4).map((row) => row.value)).toEqual([
      "41",
      "162",
      "24",
      "23",
    ]);
  });

  it("asks for a person to be chosen when there is more than one", async () => {
    const store = makeDatabase(family);
    const { ok, body } = await call({ store, personId: undefined });
    expect(ok).toBe(false);
    expect(body["error"]).toBe(
      "No person is chosen in Rufi, so the record can't be read. Ask the user which person they mean: Asha Fictional, Ravi Fictional.",
    );
  });

  it("can't reach a person who isn't in the record", async () => {
    const store = makeDatabase(family);
    const { body } = await call({ store, personId: "someone-else" });
    expect(body["error"]).toBe("The chosen person isn't in Rufi.");
  });

  it("says when there are no records or people yet", async () => {
    expect(
      (await call({ store: undefined, personId: undefined })).body,
    ).toEqual({ ok: true, result: { note: "Rufi has no records yet." } });
    const empty = makeDatabase();
    expect((await call({ store: empty, personId: undefined })).body).toEqual({
      ok: true,
      result: { note: "Rufi has no people yet." },
    });
  });
});

describe("get_records", () => {
  const records = (
    store: Store,
    input: Record<string, unknown>,
    personId = "asha",
  ) => call({ store, personId }, "get_records", input);
  const ids = (answer: { body: Record<string, unknown> }) =>
    (answer.body["result"] as { records: { id: string }[] }).records.map(
      (found) => found.id,
    );

  it("reads only the active person's records, from either side", async () => {
    const store = makeDatabase(family);
    expect(ids(await records(store, { kind: "result" }, "ravi"))).toEqual([
      "res-r2",
      "res-r1",
    ]);
    expect(ids(await records(store, { kind: "allergy" }, "ravi"))).toEqual([
      "all-r1",
    ]);
    const asha = await records(store, { kind: "allergy" });
    expect(asha.body).toEqual({
      ok: true,
      result: { kind: "allergy", records: [], returned: 0, complete: true },
    });
    expect(ids(await records(store, { kind: "medicine_use" }))).not.toContain(
      "med-r1",
    );
  });

  it("takes no person from the AI", async () => {
    const store = makeDatabase(family);
    const { ok, body } = await records(store, {
      kind: "result",
      person: "ravi",
    });
    expect(ok).toBe(false);
    expect(body).not.toHaveProperty("result");
    expect(JSON.stringify(body)).not.toContain("LDL");
  });

  it("gives records as stored, newest first, removed and replaced ones marked, of one category when asked", async () => {
    const store = makeDatabase(
      family,
      "UPDATE results SET removed = 1 WHERE id = 'res-a2'",
    );
    expect(
      ids(await records(store, { kind: "result", category: "measurement" })),
    ).toEqual(["res-a10", "res-a9", "res-a11"]);
    expect(
      (await records(store, { kind: "symptom", category: "lab" })).ok,
    ).toBe(false);
    const { body } = await records(store, { kind: "result", category: "lab" });
    const result = body["result"] as { records: Record<string, unknown>[] };
    expect(result).toMatchObject({ returned: 8, complete: true });
    expect(result.records.map((found) => found["id"])).toEqual([
      "res-a6",
      "res-a5",
      "res-a4",
      "res-a3",
      "res-a2",
      "res-a1",
      "res-a7",
      "res-a8",
    ]);
    expect(result.records.slice(1, 5)).toEqual([
      {
        id: "res-a5",
        version: null,
        test: "TSH",
        value: "4.6",
        category: "lab",
        number: 4.6,
        unit: "mIU/L",
        range: "0.4 - 4.0",
        flag: "High",
        measured: { date: "2026-08-12" },
        replaces: "res-a4",
        sources: [
          { document: "doc-asha-sep", page: 1, file: "thyroid recheck.jpg" },
        ],
      },
      {
        id: "res-a4",
        version: null,
        test: "TSH",
        value: "2.1",
        category: "lab",
        number: 2.1,
        unit: "mIU/L",
        range: "0.4 - 4.0",
        measured: { date: "2026-08-12" },
        replaced_by: "res-a5",
        sources: [
          {
            document: "doc-asha-aug",
            page: 2,
            file: "Sunrise Labs August.pdf",
          },
        ],
      },
      {
        id: "res-a3",
        version: null,
        test: "CRP",
        value: "<5",
        category: "lab",
        comparator: "<",
        number: 5,
        unit: "mg/L",
        range: "<10",
        measured: { date: "2026-08-12" },
        sources: [
          {
            document: "doc-asha-aug",
            page: 2,
            file: "Sunrise Labs August.pdf",
          },
        ],
      },
      expect.objectContaining({ id: "res-a2", removed: true }),
    ]);
  });

  it("reads between two dates, a date at a lower precision when it overlaps, never an undated one", async () => {
    const store = makeDatabase(
      family,
      `INSERT INTO follow_ups (id, person_id, title, due) VALUES
        ('fu-next', 'asha', 'Ask about the TSH', 'next_visit'),
        ('fu-none', 'asha', 'Book an eye test', NULL),
        ('fu-nov', 'asha', 'Repeat HbA1c', '2026-11'),
        ('fu-oct', 'asha', 'Thyroid review', '2026-10-20')`,
    );
    const between = async (from?: string, to?: string) =>
      ids(
        await records(store, {
          kind: "result",
          ...(from !== undefined && { from }),
          ...(to !== undefined && { to }),
        }),
      );
    // A month bound takes the days in it.
    expect(await between("2026-08", "2026-08")).toEqual([
      "res-a5",
      "res-a4",
      "res-a3",
      "res-a2",
      "res-a1",
      "res-a11",
    ]);
    // Vitamin D is dated May 2026: in from mid-May, not in up to April.
    expect(await between("2026-05-15", "2026-06")).toEqual(["res-a7"]);
    expect(await between(undefined, "2026-04")).toEqual([]);
    expect(await between("2026")).not.toContain("res-a8");
    expect(
      ids(await records(store, { kind: "medicine_use", from: "2025" })),
    ).toEqual(["med-a2"]);
    // A follow-up due at the next visit has no calendar date: after the
    // dated ones, before the undated, and never in a read between dates.
    expect(ids(await records(store, { kind: "follow_up" }))).toEqual([
      "fu-nov",
      "fu-oct",
      "fu-next",
      "fu-none",
    ]);
    expect(
      ids(await records(store, { kind: "follow_up", from: "2026" })),
    ).toEqual(["fu-nov", "fu-oct"]);
    const { ok, body } = await records(store, {
      kind: "result",
      from: "last May",
    });
    expect(ok).toBe(false);
    expect(JSON.stringify(body)).toContain("YYYY");
  });

  it(`says when more than ${String(LIMITS.records)} records matched: exactly ${String(LIMITS.records)} are complete`, async () => {
    const glucose = (n: number) =>
      Array.from({ length: n }, (_, i) => {
        const day = new Date(Date.UTC(2025, 0, 1 + i))
          .toISOString()
          .slice(0, 10);
        return `('g${String(i)}', 'asha', NULL, 'lab', 'Glucose', '5.${String(i % 10)}', NULL, NULL, 'mmol/L', NULL, NULL, NULL, '${day}', '2026-01-01T00:00:00Z', NULL)`;
      }).join(",");
    const insert = (n: number) =>
      `DELETE FROM results WHERE person_id = 'asha'; INSERT INTO results (id, person_id, report_id, category, test_name, value_text, comparator, value_number, unit, reference_range, flag_text, context_text, measured_at, entered_at, replaces_id) VALUES ${glucose(n)}`;
    const exactly = makeDatabase(family, insert(LIMITS.records));
    expect(
      (await records(exactly, { kind: "result" })).body["result"],
    ).toMatchObject({ returned: LIMITS.records, complete: true });
    expect(
      (await records(exactly, { kind: "result" })).body["result"],
    ).not.toHaveProperty("capped");
    exactly.close();

    path = databasePath(await mkdtemp(join(tmpdir(), "rufi-tools-")));
    const more = makeDatabase(family, insert(LIMITS.records + 1));
    const capped = await records(more, { kind: "result" });
    expect(capped.body["result"]).toMatchObject({
      returned: LIMITS.records,
      complete: false,
      next: `g1`,
    });
    // The newest first: the oldest one is the one left out, and reading on gets it.
    expect(ids(capped)).not.toContain("g0");
    expect(
      (await records(more, { kind: "result", after: "g1" })).body["result"],
    ).toMatchObject({ records: [{ id: "g0" }], complete: true });
  });

  it("reads on past the cap to the end, also among 300 records of one day, of either category, and records with no date", async () => {
    // Lab results and measurements in turn, all on one day.
    const day = Array.from(
      { length: 300 },
      (_, i) =>
        `('d${String(i).padStart(3, "0")}', 'asha', NULL, '${i % 2 === 0 ? "lab" : "measurement"}', 'Glucose', '${String(90 + (i % 30))}', 'mg/dL', '2026-08-12', '2026-08-13T00:00:00Z')`,
    ).join(",");
    const store = makeDatabase(
      family,
      `INSERT INTO results (id, person_id, report_id, category, test_name, value_text, unit, measured_at, entered_at) VALUES ${day}`,
    );
    const readAll = async (input: Record<string, unknown>) => {
      const read: { id: string; category: string }[] = [];
      let after: string | undefined;
      for (let reads = 0; reads < 10; reads++) {
        const answer = (
          await records(store, {
            ...input,
            ...(after !== undefined && { after }),
          })
        ).body["result"] as {
          records: { id: string; category: string }[];
          complete: boolean;
          next?: string;
        };
        read.push(...answer.records);
        if (answer.complete) break;
        after = answer.next;
      }
      return read;
    };
    // Every record once: the fictional family's 11 and the day's 300.
    const read = (await readAll({ kind: "result" })).map((found) => found.id);
    expect(read).toHaveLength(311);
    expect(new Set(read).size).toBe(311);
    expect(read.slice(-2)).toEqual(["res-a7", "res-a8"]);
    // Only measurements: the family's 3 and the day's 150, each once.
    const measurements = await readAll({
      kind: "result",
      category: "measurement",
    });
    expect(new Set(measurements.map((found) => found.id)).size).toBe(153);
    expect(measurements).toHaveLength(153);
    expect(
      measurements.every((found) => found.category === "measurement"),
    ).toBe(true);
    // An anchor from another read: another person's, or another category's.
    for (const input of [
      { kind: "result", after: "res-r1" },
      { kind: "result", category: "measurement", after: "res-a7" },
    ]) {
      const { ok, body } = await records(store, input);
      expect(ok).toBe(false);
      expect(body["error"]).toBe(
        "That `after` isn't from this read: read again without it.",
      );
    }
  });

  it("reads exactly the records named by id, and says which aren't there", async () => {
    const store = makeDatabase(family);
    const result = (
      await records(store, {
        kind: "result",
        ids: ["res-a7", "res-a1", "res-r1", "nope"],
      })
    ).body["result"];
    expect(result).toMatchObject({
      records: [{ id: "res-a1" }, { id: "res-a7" }],
      complete: true,
      not_found: ["res-r1", "nope"],
    });
    const both = await records(store, {
      kind: "result",
      ids: ["res-a1"],
      from: "2026",
    });
    expect(both.ok).toBe(false);
  });

  it("reads exactly one report's results, as stored; only results, and only the active person's reports", async () => {
    const store = makeDatabase(family);
    const report = await records(store, {
      kind: "result",
      report: "rep-asha-aug",
    });
    expect(report.body["result"]).toMatchObject({
      kind: "result",
      report: "rep-asha-aug",
      records: [
        { id: "res-a4", replaced_by: "res-a5" },
        { id: "res-a3" },
        { id: "res-a2" },
        { id: "res-a1" },
      ],
      complete: true,
    });
    expect(
      (await records(store, { kind: "result", report: "rep-ravi-jul" })).body,
    ).toMatchObject({
      ok: false,
      error: "There is no report rep-ravi-jul in this person's record.",
    });
    for (const wrong of [
      { kind: "allergy", report: "rep-asha-aug" },
      { kind: "result", report: "rep-asha-aug", ids: ["res-a1"] },
    ]) {
      expect((await records(store, wrong)).ok).toBe(false);
    }
    // A continuation from another report's read isn't from this one.
    expect(
      (
        await records(store, {
          kind: "result",
          report: "rep-asha-sep",
          after: "res-a1",
        })
      ).body,
    ).toMatchObject({
      ok: false,
      error: "That `after` isn't from this read: read again without it.",
    });
  });

  it(`says when the records are more than ${String(LIMITS.bytes / 1000)} KB`, async () => {
    const long = "x".repeat(1_000);
    const symptoms = Array.from(
      { length: 40 },
      (_, i) =>
        `('s${String(i).padStart(2, "0")}', 'asha', 'Headache', 'resolved', '2026-01-${String(1 + (i % 28)).padStart(2, "0")}', '${long}')`,
    ).join(",");
    const store = makeDatabase(
      family,
      `INSERT INTO symptoms (id, person_id, name, status, onset, details) VALUES ${symptoms}`,
    );
    const result = (await records(store, { kind: "symptom" })).body[
      "result"
    ] as { returned: number; capped: string; next: string };
    expect(result).toMatchObject({ complete: false });
    expect(result.returned).toBeGreaterThan(0);
    expect(result.returned).toBeLessThan(40);
    expect(result.capped).toBe(
      `More records matched than come back at once (${String(LIMITS.bytes / 1000)} KB). These are the next ${String(result.returned)}: read on with after set to next.`,
    );
    const rest = (await records(store, { kind: "symptom", after: result.next }))
      .body["result"] as { returned: number };
    expect(result.returned + rest.returned).toBeLessThanOrEqual(40);
  });

  it(`gives one record larger than ${String(LIMITS.bytes / 1000)} KB on its own, so the read moves on past it`, async () => {
    const huge = "x".repeat(LIMITS.bytes + 1_000);
    const store = makeDatabase(
      family,
      `INSERT INTO symptoms (id, person_id, name, status, onset, details) VALUES
         ('s-big', 'asha', 'Headache', 'resolved', '2026-02-01', '${huge}'),
         ('s-small', 'asha', 'Headache', 'resolved', '2026-01-01', NULL)`,
    );
    const first = (await records(store, { kind: "symptom" })).body[
      "result"
    ] as { records: { id: string }[]; complete: boolean; next: string };
    expect(first.records.map((r) => r.id)).toEqual(["s-big"]);
    expect(first).toMatchObject({ complete: false, next: "s-big" });
    const rest = (await records(store, { kind: "symptom", after: first.next }))
      .body["result"] as { records: { id: string }[] };
    expect(rest.records.map((r) => r.id)).toContain("s-small");
  });

  it("answers a read that fails with an error, never with no records", async () => {
    const store = makeDatabase(family);
    const writer = new DatabaseSync(path);
    writer.exec("DROP TABLE symptoms");
    writer.close();
    const { ok, body } = await records(store, { kind: "symptom" });
    expect(ok).toBe(false);
    expect(body).toEqual({
      ok: false,
      error: "Rufi couldn't run get_records.",
    });
  });
});

const left = (text: string) =>
  (JSON.parse(text) as { rejections_left: number }).rejections_left;

describe("read_chat", () => {
  /** Asha's chat and Ravi's, 30 entries each. */
  const chats =
    "UPDATE chats SET id = 'c-' || person_id;" +
    [
      ["c-asha", "asha"],
      ["c-ravi", "ravi"],
    ]
      .map(([id, person]) =>
        Array.from({ length: 30 }, (_, i) => {
          const kind =
            ["message", "reply", "activity", "steer"][i % 4] ?? "message";
          const activity =
            kind === "activity" ? "'command', 'done'" : "NULL, NULL";
          return `INSERT INTO transcript_entries (id, person_id, chat_id, seq, kind, text, activity, status, detail, revision, created_at, updated_at) VALUES ('${id ?? ""}-${String(i + 1)}', '${person ?? ""}', '${id ?? ""}', ${String(i + 1)}, '${kind}', '${id ?? ""} entry ${String(i + 1)}', ${activity}, ${kind === "activity" ? "'ls'" : "NULL"}, 1, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z');`;
        }).join(""),
      )
      .join("");

  it("pages back through the chat, newest first", async () => {
    const store = makeDatabase(family, chats);
    const context = { store, personId: "asha", chatId: "c-asha" };
    const first = await call(context, "read_chat", { limit: 4 });
    expect(first.body).toEqual({
      ok: true,
      result: {
        entries: [
          {
            position: 30,
            kind: "reply",
            text: "c-asha entry 30",
            at: "2026-10-01T10:00:00Z",
          },
          {
            position: 29,
            kind: "message",
            text: "c-asha entry 29",
            at: "2026-10-01T10:00:00Z",
          },
          {
            position: 28,
            kind: "steer",
            text: "c-asha entry 28",
            at: "2026-10-01T10:00:00Z",
          },
          {
            position: 27,
            kind: "activity",
            text: "c-asha entry 27",
            detail: "ls",
            at: "2026-10-01T10:00:00Z",
          },
        ],
        next_before: 27,
      },
    });
    const last = await call(context, "read_chat", { before: 3 });
    expect(
      (last.body["result"] as { entries: { position: number }[] }).entries.map(
        (e) => e.position,
      ),
    ).toEqual([2, 1]);
    expect(last.body["result"]).not.toHaveProperty("next_before");
  });

  it("reads only the chat Rufi chose, never another person's", async () => {
    const store = makeDatabase(family, chats);
    const { body } = await call(
      { store, personId: "asha", chatId: "c-ravi" },
      "read_chat",
      {},
    );
    expect(body).toEqual({ ok: true, result: { entries: [] } });
  });

  it("refuses outside Rufi's chat, and a page too big", async () => {
    const store = makeDatabase(family, chats);
    expect(
      (await call({ store, personId: "asha" }, "read_chat", {})).body["error"],
    ).toBe("This isn't Rufi's chat, so it has nothing earlier to read.");
    const { body } = await call(
      { store, personId: "asha", chatId: "c-asha" },
      "read_chat",
      { limit: 51 },
    );
    expect(body["error"]).toBe("The input for read_chat isn't valid.");
  });
});

describe("the error envelope", () => {
  it("answers bad input with the issues and an example", async () => {
    const store = makeDatabase(family);
    const { ok, body } = await call(
      { store, personId: "asha" },
      "get_overview",
      {
        person: "ravi",
      },
    );
    expect(ok).toBe(false);
    expect(body).toEqual({
      ok: false,
      error: "The input for get_overview isn't valid.",
      issues: [
        {
          path: "person",
          got: '"ravi"',
          fix: "This tool takes no input; leave it out",
        },
      ],
      example: {},
      rejections_left: REJECTIONS_PER_TURN - 1,
    });
  });

  it("refuses input that isn't an object", async () => {
    const { body } = await call(
      { store: undefined, personId: undefined },
      "get_overview",
      "everything",
    );
    expect(body["issues"]).toEqual([
      { path: "", got: '"everything"', fix: "Expected object" },
    ]);
  });

  it("names Rufi's tools when the model asks for one that doesn't exist", async () => {
    const { body } = await call(
      { store: undefined, personId: undefined },
      "rm_rf",
    );
    expect(body["error"]).toBe(
      "There is no tool called rm_rf. Rufi's tools: get_overview, get_records, get_documents, read_chat, save_changes, dismiss_items, sort_documents, save_reading, create_brief, show_face.",
    );
  });

  it("stops the turn when the model keeps getting it wrong", async () => {
    const caller = forAgent(
      () => ({ store: undefined, personId: undefined }),
      () => undefined,
    ).forTurn();
    const answers = [];
    for (let i = 0; i < REJECTIONS_PER_TURN; i++) {
      answers.push(await caller("nope", {}));
    }
    expect(answers.map((a) => left(a.text))).toEqual([2, 1, 0]);
    expect(answers.map((a) => a.stopTurn)).toEqual([
      undefined,
      undefined,
      "The AI kept making requests Rufi couldn't accept.",
    ]);
  });

  it("gives each turn its own count", async () => {
    const tools = forAgent(
      () => ({ store: undefined, personId: undefined }),
      () => undefined,
    );
    await tools.forTurn()("nope", {});
    const next = await tools.forTurn()("nope", {});
    expect(left(next.text)).toBe(REJECTIONS_PER_TURN - 1);
  });

  it.each([
    { value: undefined, lefts: [2, 1, 0], parallel: false },
    { value: "5", lefts: [4, 3, 2, 1, 0], parallel: false },
    ...["0", "2.5", "lots"].map((value) => ({
      value,
      lefts: [2, 1, 0],
      parallel: false,
    })),
    { value: undefined, lefts: [2, 1, 0], parallel: true },
    { value: "2", lefts: [1, 0], parallel: true },
    { value: "lots", lefts: [2, 1, 0], parallel: true },
  ])(
    "ends a reply after its refused calls (setting $value, parallel $parallel)",
    async ({ value, lefts, parallel }) => {
      makeDatabase(family).close();
      const store = openWritable(path);
      try {
        const chats = transcripts(store, () => "2026-10-14T10:00:00Z");
        const chat = (await chats.chat("asha")) as ChatRow;
        if (value !== undefined)
          await chats.saveSetting(REJECTIONS_SETTING, value);
        const caller = chatCaller(store, chats, record)(chat, "t-1", "person");
        const refuse = () => caller("get_documents", { page: 1 });
        const answers = [];
        if (parallel) answers.push(...(await Promise.all(lefts.map(refuse))));
        else {
          for (const _ of lefts) answers.push(await refuse());
        }
        expect(answers.map((answer) => left(answer.text))).toEqual(lefts);
        expect(answers.map((answer) => answer.stopTurn !== undefined)).toEqual(
          lefts.map((remaining) => remaining === 0),
        );
      } finally {
        store.close();
      }
    },
  );

  it("tells the model only that a tool failed, and logs only its name and error code", async () => {
    const broken = defineTool({
      name: "broken",
      description: "Fails.",
      input: NoInput,
      callers: "model",
      readOnly: true,
      destructive: false,
      examples: [{}],
      run: () => {
        throw new Error("disk on fire");
      },
    });
    const caller = toolCaller(
      [broken],
      () => ({ store: undefined, personId: undefined }),
      record,
    );
    const answer = await caller("broken", {});
    expect(JSON.parse(answer.text)).toEqual({
      ok: false,
      error: "Rufi couldn't run broken.",
    });
    expect(logged).toEqual([
      JSON.stringify({ event: "tool.failed", tool: "broken", error: "Error" }),
    ]);
  });

  it("treats a refusal as a rejection with its own words", async () => {
    const refusing = defineTool({
      name: "refusing",
      description: "Refuses.",
      input: NoInput,
      callers: "model",
      readOnly: true,
      destructive: false,
      examples: [{}],
      run: () => {
        throw new Refusal("Not today.");
      },
    });
    const answer = await toolCaller(
      [refusing],
      () => ({ store: undefined, personId: undefined }),
      () => undefined,
    )("refusing", {});
    expect(JSON.parse(answer.text)).toMatchObject({
      ok: false,
      error: "Not today.",
      rejections_left: REJECTIONS_PER_TURN - 1,
    });
  });

  it("never offers the model a tool only the UI may call", async () => {
    const uiOnly = defineTool({
      name: "accept_changes",
      description: "UI only.",
      input: NoInput,
      callers: "ui",
      readOnly: false,
      destructive: false,
      examples: [{}],
      run: () => "accepted",
    });
    const answer = await toolCaller(
      [uiOnly],
      () => ({ store: undefined, personId: undefined }),
      () => undefined,
    )("accept_changes", {});
    expect(answer.ok).toBe(false);
  });
});

describe("show_face", () => {
  it("answers ok in Rufi's chat and changes nothing", async () => {
    makeDatabase(family).close();
    const store = openWritable(path);
    try {
      const chats = transcripts(store, () => "2026-10-14T10:00:00Z");
      const chat = (await chats.chat("asha")) as ChatRow;
      const caller = chatCaller(store, chats, record)(chat, "t-1", "person");
      const changes = () =>
        store.db.prepare("SELECT total_changes() AS n").get()?.["n"];
      const before = changes();
      const answer = await caller("show_face", { face: "found" });
      expect(JSON.parse(answer.text)).toEqual({ ok: true });
      expect(changes()).toBe(before);
    } finally {
      store.close();
    }
  });

  it("has no sad or sorry face to show", async () => {
    for (const face of ["sorry", "sleepy", "steady"]) {
      const answer = await call(
        { store: undefined, personId: undefined },
        "show_face",
        { face },
      );
      expect(answer.body["error"]).toBe("The input for show_face isn't valid.");
    }
  });
});

describe("tables.ts", () => {
  it("matches schema.sql (run pnpm db:types)", async () => {
    expect(await readFile(TABLES_TS, "utf8")).toBe(tablesTs(schema));
  });
});

describe("tools.json", () => {
  it("matches the registry (run pnpm tools:json)", async () => {
    expect(await readFile(TOOLS_JSON, "utf8")).toBe(toolsJson());
  });

  it("has examples that every tool accepts", () => {
    for (const tool of TOOLS) {
      expect(tool.examples.length).toBeGreaterThan(0);
      for (const example of tool.examples) {
        expect(
          Result.isSuccess(Schema.decodeUnknownResult(tool.input)(example)),
        ).toBe(true);
      }
    }
  });
});

describe("the database", () => {
  it("is optional until Rufi has records", () => {
    expect(openReadOnly(path)).toBeUndefined();
  });

  it("is opened read-only", () => {
    const store = makeDatabase(family);
    expect(() => {
      store.db.exec("DELETE FROM results");
    }).toThrow(/readonly/);
  });

  it("is refused when its tables aren't a record Rufi knows", () => {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE people (id TEXT PRIMARY KEY)");
    db.close();
    expect(() => openReadOnly(path)).toThrow("isn't a record this Rufi knows");
  });

  it("picks the person only when there is exactly one", async () => {
    expect(await onlyPersonId(makeDatabase(family))).toBeUndefined();
    path = `${path}-one`;
    expect(
      await onlyPersonId(
        makeDatabase("INSERT INTO people VALUES ('solo', 'Solo Fictional')"),
      ),
    ).toBe("solo");
  });
});
