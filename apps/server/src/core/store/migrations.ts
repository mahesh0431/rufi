// The record's versions (docs/adr/0011). `PRAGMA user_version` holds the
// version; version n is what migrations 1 to n make, and schema.sql is the
// last one (a test checks). Migration 1 is the first record, as Rufi made it
// before it had versions: such a record has version 0 and is known by its
// exact shape. Rufi upgrades an older record at start, all pending
// migrations in one transaction, and opens nothing it doesn't know.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const read = (name: string) =>
  readFileSync(new URL(name, import.meta.url), "utf8");

/** The record as this Rufi makes it. */
export const SCHEMA = read("schema.sql");

/**
 * Each migration's SQL, in order: migration n takes version n - 1 to n.
 * One that has shipped never changes; a change is a new one at the end.
 * No BEGIN, COMMIT or PRAGMA in them: the runner does those.
 */
export const MIGRATIONS: readonly string[] = [
  read("migrations/0001-first-record.sql"),
  read("migrations/0002-save-order.sql"),
  read("migrations/0003-follow-up-notices.sql"),
  read("migrations/0004-result-categories.sql"),
  read("migrations/0005-deleted-documents.sql"),
  read("migrations/0006-picture-lines.sql"),
  read("migrations/0007-activity-notes.sql"),
  read("migrations/0008-save-warnings.sql"),
  read("migrations/0009-reader-retries.sql"),
  read("migrations/0010-chat-memory.sql"),
];

/** What a database file is, read without changing it. */
export type Found =
  | { state: "empty" }
  | { state: "current" }
  | { state: "older"; version: number }
  | { state: "newer"; version: number }
  | { state: "unknown"; version: number };

/** Every table and index, in a form that ignores comments, quotes and spacing. */
function shape(db: DatabaseSync): string {
  const rows = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; sql: string | null }[];
  return JSON.stringify(
    rows.map(({ type, name, sql }) => [
      type,
      name,
      (sql ?? "")
        .replace(/--[^\n]*/g, "")
        .replaceAll('"', "")
        .replace(/\s+/g, " ")
        .replace(/ ?([(),]) ?/g, "$1")
        .trim(),
    ]),
  );
}

const shapes = new Map<string, string>();

/** The shape SQL makes in an empty database. */
function shapeOf(sql: string): string {
  let made = shapes.get(sql);
  if (made === undefined) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(sql);
      made = shape(db);
    } finally {
      db.close();
    }
    shapes.set(sql, made);
  }
  return made;
}

/** What the database open on `db` is. Reads only. */
export function inspect(
  db: DatabaseSync,
  migrations: readonly string[] = MIGRATIONS,
): Found {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (version > migrations.length) return { state: "newer", version };
  const found = shape(db);
  if (version === 0 && found === "[]") return { state: "empty" };
  // Version 0 with the first record's shape: made before versions.
  const known = Math.max(version, 1);
  if (found !== shapeOf(migrations.slice(0, known).join("\n"))) {
    return { state: "unknown", version };
  }
  return known === migrations.length
    ? { state: "current" }
    : { state: "older", version: known };
}

/** Why SQLite's own checks fail on the database, or undefined when they pass. */
export function checkProblem(db: DatabaseSync): string | undefined {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (
    integrity.length !== 1 ||
    (integrity[0] as { integrity_check?: unknown }).integrity_check !== "ok"
  ) {
    return "damaged";
  }
  if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
    return "broken links";
  }
  return undefined;
}

/**
 * Brings the database at `path` to this Rufi's version, when it is older:
 * every pending migration and the new version in one transaction,
 * committed only when SQLite's integrity and foreign-key checks pass. On
 * any failure the record stays at its old version. The caller holds the
 * folder's rufi.lock and has verified a backup before upgrading it.
 */
export function migrate(
  path: string,
  migrations: readonly string[] = MIGRATIONS,
): void {
  const db = new DatabaseSync(path);
  try {
    const found = inspect(db, migrations);
    if (found.state === "current") return;
    if (found.state !== "older") {
      throw new Error(`${path} isn't an older record (${found.state}).`);
    }
    // After inspection and the caller's verified backup, use WAL so a crash
    // leaves the old record readable by the next start's read-only gate.
    // A table rebuild needs foreign keys off; the check before commit looks
    // at every link.
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF; PRAGMA synchronous = FULL;",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const migration of migrations.slice(found.version)) {
        db.exec(migration);
      }
      db.exec(`PRAGMA user_version = ${String(migrations.length)}`);
      const problem = checkProblem(db);
      if (problem) throw new Error(`The upgraded record is ${problem}.`);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw new Error(`Rufi couldn't upgrade ${path}, and left it as it was.`, {
        cause: error,
      });
    }
  } finally {
    db.close();
  }
}
