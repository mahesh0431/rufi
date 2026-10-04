// Rufi's one database. The running Rufi opens it for writing (creating it in
// a new data folder) while it holds rufi.lock; Rufi's tools read it through a
// read-only connection of their own.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer } from "effect";
import { Kysely } from "kysely";
import { Home } from "../../platform/config.ts";
import { NodeSqliteDialect } from "./dialect.ts";
import type { Tables } from "./tables.ts";

export interface Store {
  /** The connection itself, for checks Kysely doesn't build (schema, pragmas). */
  db: DatabaseSync;
  /** Typed queries on the same connection. */
  query: Kysely<Tables>;
  close: () => void;
}

const SCHEMA = readFileSync(new URL("schema.sql", import.meta.url), "utf8");

/** `rufi.sqlite` in Rufi's data folder. */
export const databasePath = (home: string) => join(home, "rufi.sqlite");

/**
 * Opens the database read-only, or returns undefined when there is none yet.
 * A database whose tables differ from schema.sql is refused: until dogfood
 * the database is reset rather than migrated.
 */
export function openReadOnly(path: string): Store | undefined {
  if (!existsSync(path)) return undefined;
  return checked(new DatabaseSync(path, { readOnly: true }), path);
}

/**
 * Opens the database for writing, creating it from schema.sql when there is
 * none. Every write is synced to disk (WAL, synchronous FULL), and deleted
 * data is overwritten (secure_delete).
 */
export function openWritable(path: string): Store {
  const created = !existsSync(path);
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;",
    );
    // All of it or none: a half-made database would be refused next time.
    if (created) db.exec(`BEGIN; ${SCHEMA}; COMMIT;`);
  } catch (error) {
    db.close();
    throw new Error(`Couldn't set up ${path}`, { cause: error });
  }
  return checked(db, path);
}

/** Turns on foreign keys and refuses a database made by another schema. */
function checked(db: DatabaseSync, path: string): Store {
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const expected = new DatabaseSync(":memory:");
    expected.exec(SCHEMA);
    const same = describe(db) === describe(expected);
    expected.close();
    if (!same) {
      throw new Error(
        `${path} was made by an older Rufi. It's test data until dogfood: delete it and start again.`,
      );
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    db,
    query: new Kysely<Tables>({ dialect: new NodeSqliteDialect(db) }),
    close: () => {
      db.close();
    },
  };
}

/** The record, open read-only for as long as it's needed; undefined when there is none yet. */
export class RecordStore extends Context.Service<
  RecordStore,
  Store | undefined
>()("rufi/RecordStore") {}

export const recordLayer = Layer.effect(
  RecordStore,
  Effect.acquireRelease(
    Effect.flatMap(Home, (home) =>
      Effect.try({
        try: () => openReadOnly(databasePath(home)),
        catch: (error) => error,
      }),
    ),
    (store) => Effect.sync(() => store?.close()),
  ),
);

/** The one person in the record, when there is exactly one. */
export async function onlyPersonId(store: Store): Promise<string | undefined> {
  const people = await store.query
    .selectFrom("people")
    .select("id")
    .limit(2)
    .execute();
  return people.length === 1 ? people[0]?.id : undefined;
}

/** Every table and index, as SQLite stored its definition. */
function describe(db: DatabaseSync): string {
  return JSON.stringify(
    db
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all(),
  );
}
