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
            test: "Free T4",
            value: "1.1",
            unit: "ng/dL",
            range: "0.8 - 1.8",
            context: "Direct",
            measured: "2026-09-01",
          },
          {
            test: "TSH",
            value: "4.6",
            unit: "mIU/L",
            range: "0.4 - 4.0",
            flag: "High",
            measured: "2026-08-12",
            amended: true,
          },
          {
            test: "CRP",
            value: "<5",
            unit: "mg/L",
            range: "<10",
            measured: "2026-08-12",
          },
          {
            test: "Glucose",
            value: "118",
            unit: "mg/dL",
            range: "70 - 99",
            flag: "High",
            context: "Fasting",
            measured: "2026-08-12",
          },
          {
            test: "HbA1c",
            value: "6.8",
            unit: "%",
            range: "4.0 - 5.6",
            flag: "High",
            measured: "2026-08-12",
          },
          {
            test: "Vitamin D",
            value: "22",
            unit: "ng/mL",
            range: "30 - 100",
            flag: "Low",
            measured: "2026-05",
          },
          { test: "Blood group", value: "B positive" },
        ],
      },
    });
  });

  it("leaves out a result an amendment replaced, which stays stored", async () => {
    const store = makeDatabase(family);
    const { body } = await call({ store, personId: "asha" });
    const shown = JSON.stringify(body);
    expect(shown).not.toContain('"2.1"');
    expect(
      store.db
        .prepare("SELECT value_text FROM results WHERE id = 'res-a4'")
        .get(),
    ).toEqual({ value_text: "2.1" });
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

  it("finds replaced results through an index, not a scan", () => {
    const store = makeDatabase(family);
    const plan = store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT 1 FROM results r WHERE r.person_id = ? AND NOT EXISTS (SELECT 1 FROM results n WHERE n.person_id = r.person_id AND n.replaces_id = r.id)",
      )
      .all("asha") as { detail: string }[];
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "USING COVERING INDEX results_by_replaced",
    );
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

const left = (text: string) =>
  (JSON.parse(text) as { rejections_left: number }).rejections_left;

describe("read_conversation", () => {
  /** Two conversations of Asha's and one of Ravi's, 30 entries each. */
  const conversations = [
    ["c-asha", "asha"],
    ["c-asha-2", "asha"],
    ["c-ravi", "ravi"],
  ]
    .map(
      ([id, person]) =>
        `INSERT INTO conversations (id, person_id, title, provider, model, created_at) VALUES ('${id ?? ""}', '${person ?? ""}', 'Fictional', 'codex', 'gpt-6.1-sol', '2026-10-01T10:00:00Z');` +
        Array.from({ length: 30 }, (_, i) => {
          const kind =
            ["message", "reply", "activity", "steer"][i % 4] ?? "message";
          const activity =
            kind === "activity" ? "'command', 'done'" : "NULL, NULL";
          return `INSERT INTO transcript_entries (id, person_id, conversation_id, seq, kind, text, activity, status, detail, revision, created_at, updated_at) VALUES ('${id ?? ""}-${String(i + 1)}', '${person ?? ""}', '${id ?? ""}', ${String(i + 1)}, '${kind}', '${id ?? ""} entry ${String(i + 1)}', ${activity}, ${kind === "activity" ? "'ls'" : "NULL"}, 1, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z');`;
        }).join(""),
    )
    .join("");

  it("pages back through the conversation, newest first", async () => {
    const store = makeDatabase(family, conversations);
    const context = { store, personId: "asha", conversationId: "c-asha" };
    const first = await call(context, "read_conversation", { limit: 4 });
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
    const last = await call(context, "read_conversation", { before: 3 });
    expect(
      (last.body["result"] as { entries: { position: number }[] }).entries.map(
        (e) => e.position,
      ),
    ).toEqual([2, 1]);
    expect(last.body["result"]).not.toHaveProperty("next_before");
  });

  it("reads only the conversation Rufi chose, never another person's", async () => {
    const store = makeDatabase(family, conversations);
    const { body } = await call(
      { store, personId: "asha", conversationId: "c-ravi" },
      "read_conversation",
      {},
    );
    expect(body).toEqual({ ok: true, result: { entries: [] } });
    const own = await call(
      { store, personId: "asha", conversationId: "c-asha-2" },
      "read_conversation",
      {},
    );
    expect(JSON.stringify(own.body)).not.toContain("c-asha entry");
    expect(JSON.stringify(own.body)).not.toContain("c-ravi");
  });

  it("refuses outside a saved conversation, and a page too big", async () => {
    const store = makeDatabase(family, conversations);
    expect(
      (await call({ store, personId: "asha" }, "read_conversation", {})).body[
        "error"
      ],
    ).toBe(
      "This isn't a saved conversation, so it has nothing earlier to read.",
    );
    const { body } = await call(
      { store, personId: "asha", conversationId: "c-asha" },
      "read_conversation",
      { limit: 51 },
    );
    expect(body["error"]).toBe("The input for read_conversation isn't valid.");
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
      "There is no tool called rm_rf. Rufi's tools: get_overview, read_conversation.",
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
