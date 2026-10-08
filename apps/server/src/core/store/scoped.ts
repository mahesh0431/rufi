// One person's record as a database of its own, for the AI's SQL (run_sql):
// Rufi copies the person's rows into a new in-memory database, so a query
// can only see what was copied, whatever it says. The query runs in a child
// process, which Rufi ends at the time limit: SQLite can't be interrupted
// from here, and a stuck query must never block the core.
import { fork } from "node:child_process";
import { constants, DatabaseSync, type StatementSync } from "node:sqlite";

/** What a query may use, and when it is stopped; the tool's description says the same. */
export interface QueryLimits {
  /** Rows given back at most. */
  rows: number;
  /**
   * Bytes of rows (as UTF-8 JSON) given back at most: under what the agent
   * passes on to the model whole.
   */
  bytes: number;
  /** Time until the query is stopped, in milliseconds. */
  timeMs: number;
}

/**
 * Each table of the person's record, and which of its rows are theirs (`$p`
 * is the person). A table not named here is never copied: the conversations,
 * settings and drafts are Rufi's, not the record. Files carry no person; the
 * person's documents name theirs.
 */
export const RECORD_TABLES: Readonly<Record<string, string>> = {
  people: "id = $p",
  files: "id IN (SELECT file_id FROM documents WHERE person_id = $p)",
  documents: "person_id = $p",
  reports: "person_id = $p",
  results: "person_id = $p",
  medicine_uses: "person_id = $p",
  prescriptions: "person_id = $p",
  symptoms: "person_id = $p",
  conditions: "person_id = $p",
  allergies: "person_id = $p",
  care_events: "person_id = $p",
  none_known: "person_id = $p",
  follow_ups: "person_id = $p",
  operations: "person_id = $p",
  record_changes: "person_id = $p",
};

/**
 * The person's record as a new database, serialized: their rows of each
 * record table, with the tables as schema.sql defines them (comments
 * included, so the AI can read what each column means). Read in one go on
 * the core's thread, so no save lands in between.
 */
function personDatabase(source: DatabaseSync, personId: string) {
  // Its tables still name the ones left out (a source message), so their
  // foreign keys are off: nothing is checked against what isn't there.
  const copy = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: false,
  });
  try {
    for (const [table, theirs] of Object.entries(RECORD_TABLES)) {
      const { sql } = source
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
        )
        .get(table) as { sql: string };
      copy.exec(sql);
      const read = source.prepare(`SELECT * FROM ${table} WHERE ${theirs}`);
      read.setReturnArrays(true);
      read.setReadBigInts(true);
      const rows = read.all({ p: personId }) as unknown as unknown[][];
      const width = read.columns().length;
      const write = copy.prepare(
        `INSERT INTO ${table} VALUES (${Array.from({ length: width }, () => "?").join(", ")})`,
      );
      for (const row of rows) write.run(...(row as never[]));
    }
    return copy.serialize();
  } finally {
    copy.close();
  }
}

/** A query's rows, or why there are none. */
export type QueryOutcome =
  | {
      ok: true;
      columns: string[];
      rows: unknown[][];
      /** Why rows are missing: more matched than `rows`, or than `bytes`. */
      cut?: "rows" | "bytes";
    }
  | {
      ok: false;
      /** refused: not one read-only statement; failed: SQLite's error; stopped: the time limit. */
      why: "refused" | "failed" | "stopped";
      /** For the AI: SQLite's words, or Rufi's. */
      message: string;
    };

/** SQLite's result code for a statement its authorizer refused. */
const SQLITE_AUTH = 23;

/** Bytes SQLite may use at most in the child, for a query that runs away. */
const HEAP_BYTES = 256 * 1024 * 1024;

/** What a query may do: read and compute. Everything else is refused. */
const ALLOWED = new Set([
  constants.SQLITE_SELECT,
  constants.SQLITE_READ,
  constants.SQLITE_FUNCTION,
  constants.SQLITE_RECURSIVE,
]);

/**
 * Runs one read-only statement on the person's database, with the row and
 * size caps. Runs in the child (scoped-process.ts).
 */
export function runQuery(
  database: Uint8Array,
  sql: string,
  limits: Pick<QueryLimits, "rows" | "bytes">,
): QueryOutcome {
  const db = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: false,
  });
  try {
    db.deserialize(database);
    db.exec(
      `PRAGMA query_only = ON; PRAGMA hard_heap_limit = ${String(HEAP_BYTES)};`,
    );
    db.setAuthorizer((action) =>
      ALLOWED.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY,
    );
    let statement: StatementSync;
    try {
      statement = db.prepare(sql);
    } catch (error) {
      return failure(error);
    }
    if (!alone(db, sql.slice(statement.sourceSQL.length))) {
      return {
        ok: false,
        why: "refused",
        message: "Send one statement at a time.",
      };
    }
    statement.setReturnArrays(true);
    statement.setReadBigInts(true);
    const columns = statement.columns().map((column) => column.name);
    const rows: unknown[][] = [];
    let bytes = 0;
    try {
      for (const raw of statement.iterate()) {
        if (rows.length === limits.rows) {
          return { ok: true, columns, rows, cut: "rows" };
        }
        const row = (raw as unknown as unknown[]).map(plain);
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (bytes > limits.bytes) {
          return { ok: true, columns, rows, cut: "bytes" };
        }
        rows.push(row);
      }
    } catch (error) {
      return failure(error);
    }
    return { ok: true, columns, rows };
  } finally {
    db.close();
  }
}

/** Whether the rest of the text holds no other statement. */
function alone(db: DatabaseSync, rest: string): boolean {
  try {
    db.prepare(rest);
  } catch (error) {
    // Only spaces, comments and semicolons: node:sqlite finds no statement.
    return (error as { code?: unknown }).code === "ERR_INVALID_ARG_VALUE";
  }
  return false;
}

/** A value as JSON can carry it: a big integer as text, bytes by their count. */
function plain(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  }
  if (value instanceof Uint8Array) return { bytes: value.length };
  return value;
}

function failure(error: unknown): QueryOutcome {
  const { code, errcode, message } = error as {
    code?: unknown;
    errcode?: unknown;
    message?: unknown;
  };
  // SQLITE_AUTH: the authorizer refused; extension loading is refused too.
  if (errcode === SQLITE_AUTH || /not authorized/.test(String(message))) {
    return {
      ok: false,
      why: "refused",
      message:
        "Only reading is allowed: one SELECT (or WITH … SELECT) on the tables of this record.",
    };
  }
  if (code === "ERR_INVALID_ARG_VALUE") {
    return { ok: false, why: "refused", message: "The query is empty." };
  }
  return { ok: false, why: "failed", message: String(message) };
}

const PROCESS = new URL("scoped-process.ts", import.meta.url);

/**
 * Runs the AI's query on the person's own database, in a child process that
 * is ended at the time limit. Never throws for the query's own failures:
 * they come back as the outcome.
 */
export function scopedQuery(
  source: DatabaseSync,
  personId: string,
  sql: string,
  limits: QueryLimits,
): Promise<QueryOutcome> {
  const database = personDatabase(source, personId);
  return new Promise((resolve, reject) => {
    const child = fork(PROCESS, [], {
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [],
      env: {},
    });
    let settled = false;
    const settle = (end: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      end();
    };
    const timer = setTimeout(() => {
      settle(() => {
        resolve({
          ok: false,
          why: "stopped",
          message: `It reached the time limit of ${String(limits.timeMs / 1000)} seconds.`,
        });
      });
    }, limits.timeMs);
    child.once("message", (outcome) => {
      settle(() => {
        resolve(outcome as QueryOutcome);
      });
    });
    child.once("error", (error) => {
      settle(() => {
        reject(new Error("Couldn't run the query process", { cause: error }));
      });
    });
    child.once("exit", (code, signal) => {
      settle(() => {
        reject(
          new Error(
            `The query process ended early (${String(signal ?? code)})`,
          ),
        );
      });
    });
    child.send({ database, sql, limits });
  });
}
