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
  type Store,
} from "../store/database.ts";
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
import { forAgent, TOOLS, toolsJson } from "./tools.ts";
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
  it("shows a person's current results as printed, newest measured first", async () => {
    const store = makeDatabase(family);
    const { ok, body } = await call({ store, personId: "asha" });
    expect(ok).toBe(true);
    expect(body).toEqual({
      ok: true,
      result: {
        person: "Asha Fictional",
        documents: 2,
        reports: 2,
        results: 7,
        earlier_versions_kept: 1,
        latest_results: [
          {
            id: "res-a6",
            test: "Free T4",
            value: "1.1",
            unit: "ng/dL",
            range: "0.8 - 1.8",
            context: "Direct",
            measured: "2026-09-01",
          },
          {
            id: "res-a5",
            test: "TSH",
            value: "4.6",
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
            unit: "mg/L",
            range: "<10",
            measured: "2026-08-12",
          },
          {
            id: "res-a2",
            test: "Glucose",
            value: "118",
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
            unit: "%",
            range: "4.0 - 5.6",
            flag: "High",
            measured: "2026-08-12",
          },
          {
            id: "res-a7",
            test: "Vitamin D",
            value: "22",
            unit: "ng/mL",
            range: "30 - 100",
            flag: "Low",
            measured: "2026-05",
          },
          { id: "res-a8", test: "Blood group", value: "B positive" },
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
      return `('extra-${n}', 'ravi', NULL, 'Weight', '${n}', NULL, NULL, 'kg', NULL, NULL, NULL, '2026-01-01', '2026-01-01T00:00:00Z', NULL)`;
    });
    const store = makeDatabase(
      family,
      `INSERT INTO results (id, person_id, report_id, test_name, value_text, comparator, value_number, unit, reference_range, flag_text, context_text, measured_at, entered_at, replaces_id) VALUES ${rows.join(",")}`,
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

  it("gives records as stored, newest first, removed and replaced ones marked", async () => {
    const store = makeDatabase(
      family,
      "UPDATE results SET removed = 1 WHERE id = 'res-a2'",
    );
    const { body } = await records(store, { kind: "result" });
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
        test: "TSH",
        value: "4.6",
        number: 4.6,
        unit: "mIU/L",
        range: "0.4 - 4.0",
        flag: "High",
        measured: { date: "2026-08-12" },
        replaces: "res-a4",
      },
      {
        id: "res-a4",
        test: "TSH",
        value: "2.1",
        number: 2.1,
        unit: "mIU/L",
        range: "0.4 - 4.0",
        measured: { date: "2026-08-12" },
        replaced_by: "res-a5",
      },
      {
        id: "res-a3",
        test: "CRP",
        value: "<5",
        comparator: "<",
        number: 5,
        unit: "mg/L",
        range: "<10",
        measured: { date: "2026-08-12" },
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
        return `('g${String(i)}', 'asha', NULL, 'Glucose', '5.${String(i % 10)}', NULL, NULL, 'mmol/L', NULL, NULL, NULL, '${day}', '2026-01-01T00:00:00Z', NULL)`;
      }).join(",");
    const insert = (n: number) =>
      `DELETE FROM results WHERE person_id = 'asha'; INSERT INTO results (id, person_id, report_id, test_name, value_text, comparator, value_number, unit, reference_range, flag_text, context_text, measured_at, entered_at, replaces_id) VALUES ${glucose(n)}`;
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
      capped: `Narrow the dates: more records matched than the ${String(LIMITS.records)} records that come back at most. These are the newest ${String(LIMITS.records)}.`,
    });
    // The newest first: the oldest one is the one left out, and a narrower read gets it.
    expect(ids(capped)).not.toContain("g0");
    expect(
      ids(await records(more, { kind: "result", to: "2025-01-01" })),
    ).toEqual(["g0"]);
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
    ] as { returned: number; capped: string };
    expect(result).toMatchObject({ complete: false });
    expect(result.returned).toBeGreaterThan(0);
    expect(result.returned).toBeLessThan(40);
    expect(result.capped).toBe(
      `Narrow the dates: more records matched than the ${String(LIMITS.bytes / 1000)} KB that come back at most. These are the newest ${String(result.returned)}.`,
    );
  });

  it("names each read in plain words, with its dates", () => {
    const { specs } = forAgent(
      () => ({ store: undefined, personId: undefined }),
      record,
    );
    const shown = specs.find((spec) => spec.name === "get_records")?.shown;
    expect(
      [
        { kind: "result" },
        { kind: "symptom", from: "2026", to: "2026" },
        { kind: "symptom", from: "2026-01-01", to: "2026-12-31" },
        { kind: "result", from: "2026-08", to: "2026-08-31" },
        { kind: "result", from: "2026-08-12", to: "2026-08-12" },
        { kind: "medicine_use", from: "2024-03" },
        { kind: "allergy", to: "2025" },
        { kind: "care_event", from: "2024", to: "2026-10-08" },
        { kind: "rash" },
        "not an object",
      ].map((input) => shown?.(input)),
    ).toEqual([
      "Read your results",
      "Read your symptoms in 2026",
      "Read your symptoms in 2026",
      "Read your results in Aug 2026",
      "Read your results on 12 Aug 2026",
      "Read your medicine uses since Mar 2024",
      "Read your allergies up to 2025",
      "Read your care events from 2024 to 8 Oct 2026",
      "Read your records",
      "Read your records",
    ]);
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
  /** Two chats of Asha's and one of Ravi's, 30 entries each. */
  const chats = [
    ["c-asha", "asha"],
    ["c-asha-2", "asha"],
    ["c-ravi", "ravi"],
  ]
    .map(
      ([id, person]) =>
        `INSERT INTO chats (id, person_id, title, provider, model, created_at) VALUES ('${id ?? ""}', '${person ?? ""}', 'Fictional', 'codex', 'gpt-6.1-sol', '2026-10-01T10:00:00Z');` +
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
    const own = await call(
      { store, personId: "asha", chatId: "c-asha-2" },
      "read_chat",
      {},
    );
    expect(JSON.stringify(own.body)).not.toContain("c-asha entry");
    expect(JSON.stringify(own.body)).not.toContain("c-ravi");
  });

  it("refuses outside a saved chat, and a page too big", async () => {
    const store = makeDatabase(family, chats);
    expect(
      (await call({ store, personId: "asha" }, "read_chat", {})).body["error"],
    ).toBe("This isn't a saved chat, so it has nothing earlier to read.");
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
      "There is no tool called rm_rf. Rufi's tools: get_overview, get_records, read_chat, save_changes.",
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

  it("tells the model only that a tool failed, and logs only its name and error code", async () => {
    const broken = defineTool({
      name: "broken",
      description: "Fails.",
      shown: "Did something",
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
      shown: "Did something",
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
      shown: "Did something",
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

  it("tells the model the date format wherever it gives a date", () => {
    const { tools } = JSON.parse(toolsJson()) as {
      tools: { name: string; inputSchema: Record<string, unknown> }[];
    };
    const input = (name: string) =>
      tools.find((tool) => tool.name === `rufi.${name}`)?.inputSchema as {
        properties: Record<string, { description?: string }>;
        $defs: Record<
          string,
          { properties: Record<string, { description?: string }> }
        >;
      };
    const records = input("get_records").properties;
    expect(records["from"]?.description).toContain("YYYY-MM-DD");
    expect(records["to"]?.description).toContain("YYYY-MM-DD");
    expect(
      input("save_changes").$defs["DateSaid"]?.properties["date"]?.description,
    ).toContain("YYYY-MM-DD");
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

  it("is refused when its tables don't match schema.sql", () => {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE people (id TEXT PRIMARY KEY)");
    db.close();
    expect(() => openReadOnly(path)).toThrow("made by an older Rufi");
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
