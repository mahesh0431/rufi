import { fork } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RECORD_TABLES, scopedQuery } from "./scoped.ts";

const schema = await readFile(new URL("schema.sql", import.meta.url), "utf8");

/** Rufi's own tables: never in the AI's queries. */
const RUFIS_OWN = [
  "settings",
  "conversations",
  "turns",
  "transcript_entries",
  "drafts",
  "chosen_conversations",
  "tool_calls",
];

describe("the person's own database", () => {
  it("names every table: a new one is in the record or Rufi's own, never by default", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schema);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row["name"]);
    db.close();
    expect(tables).toEqual(
      [...Object.keys(RECORD_TABLES), ...RUFIS_OWN].sort(),
    );
  });

  it("stops a query at the time limit, and Rufi goes on meanwhile", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schema);
    db.exec("INSERT INTO people (id, display_name) VALUES ('asha', 'Asha')");
    let ticks = 0;
    const ticking = setInterval(() => (ticks += 1), 20);
    const started = Date.now();
    const outcome = await scopedQuery(
      db,
      "asha",
      "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT count(*) FROM c",
      { rows: 10, bytes: 1000, timeMs: 300 },
    );
    clearInterval(ticking);
    expect(outcome).toEqual({
      ok: false,
      why: "stopped",
      message: "It reached the time limit of 0.3 seconds.",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(ticks).toBeGreaterThan(5);
    db.close();
  });

  it("ends a query's process by itself just after the time limit, and at once when Rufi is gone", async () => {
    const empty = new DatabaseSync(":memory:");
    const database = empty.serialize();
    empty.close();
    const forever =
      "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT count(*) FROM c";
    const run = (timeMs: number) => {
      const child = fork(new URL("scoped-process.ts", import.meta.url), [], {
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: [],
        env: {},
      });
      child.send({
        database,
        sql: forever,
        limits: { rows: 10, bytes: 1000, timeMs },
      });
      return child;
    };
    // Nobody ends it: it ends itself.
    let started = Date.now();
    await once(run(300), "exit");
    expect(Date.now() - started).toBeLessThan(2_500);
    // Rufi went away mid-query (its end of the channel closed).
    const orphan = run(60_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    started = Date.now();
    orphan.disconnect();
    await once(orphan, "exit");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
