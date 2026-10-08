// run_sql: one read-only query on the active person's own record, for what
// the overview doesn't show: earlier results, trends, counts, comparisons.
// Rufi's code decides what the query can see (core/store/scoped.ts).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import {
  RECORD_TABLES,
  scopedQuery,
  type QueryLimits,
} from "../store/scoped.ts";
import { defineTool, Failure, Refusal } from "./registry.ts";

/** The caps the description states; the query runs with the same numbers. */
export const LIMITS: QueryLimits = {
  rows: 200,
  bytes: 32_000,
  timeMs: 5_000,
};

/** The longest query Rufi takes, in characters. */
const SQL_MAX = 10_000;

/** Each record table with its columns, as schema.sql defines them. */
function tables(): string {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(new URL("../store/schema.sql", import.meta.url), "utf8"),
    );
    return Object.keys(RECORD_TABLES)
      .map((table) => {
        const columns = db
          .prepare("SELECT name FROM pragma_table_info(?)")
          .all(table)
          .map((column) => String(column["name"]));
        return `${table}(${columns.join(", ")})`;
      })
      .join("; ");
  } finally {
    db.close();
  }
}

const Input = Schema.Struct({
  sql: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SQL_MAX),
  ).annotate({
    description: `One SQLite SELECT (or WITH … SELECT) statement, at most ${String(SQL_MAX)} characters.`,
  }),
});

export const runSql = defineTool({
  name: "run_sql",
  shown: "Query your record",
  description: `Runs one read-only SQLite query on the active person's record and returns its rows. The database holds only this person's record, nothing else: no other person, no conversations, no settings. Tables and columns: ${tables()}. Each table's definition, with what its columns mean, is in sqlite_schema (SELECT sql FROM sqlite_schema WHERE name = 'results'). Values are as printed: value_text is the printed value ("<5" stays "<5"), value_number its plain number when there is one, comparator "<" or ">" when one was printed. Dates are text at the precision known: "2026", "2026-08" or "2026-08-12". A row with removed = 1 was removed from the record and is kept as history. A result with replaces_id amends the result it names: the current results are those not removed and not replaced by a result that isn't removed. operations and record_changes are the saves: each changed record's whole row before and after (JSON), and when (operations.created_at). One statement, reading only; nothing can be changed. Limits: at most ${String(LIMITS.rows)} rows and ${String(LIMITS.bytes / 1000)} KB of rows (as UTF-8 JSON) come back, and the query is stopped after ${String(LIMITS.timeMs / 1000)} seconds. When a limit cuts the rows, the answer says "complete": false and why: count, group and filter in SQL instead. A query that fails or is stopped returns no rows, only the error. Rufi chooses the person, not you.`,
  input: Input,
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [
    {
      sql: "SELECT test_name, value_text, unit, measured_at FROM results WHERE test_name = 'HbA1c' AND removed = 0 ORDER BY measured_at",
    },
  ],
  run: async (input, { store, personId }) => {
    if (!store) return { note: "Rufi has no records yet." };
    if (personId === undefined) {
      throw new Refusal(
        "No person is chosen in Rufi, so the record can't be read. Ask the user which person they mean.",
      );
    }
    const outcome = await scopedQuery(store.db, personId, input.sql, LIMITS);
    if (!outcome.ok) {
      throw new Failure(
        `${outcome.why === "refused" ? "Rufi refused the query" : outcome.why === "stopped" ? "The query was stopped" : "The query failed"}: ${outcome.message} Nothing was read.`,
      );
    }
    return {
      columns: outcome.columns,
      rows: outcome.rows,
      rows_returned: outcome.rows.length,
      complete: outcome.cut === undefined,
      ...(outcome.cut === "rows" && {
        cut: `More than ${String(LIMITS.rows)} rows matched; these are the first ${String(LIMITS.rows)}.`,
      }),
      ...(outcome.cut === "bytes" && {
        cut: `The rows that matched are more than ${String(LIMITS.bytes / 1000)} KB; these are the first ${String(outcome.rows.length)}.`,
      }),
    };
  },
});
