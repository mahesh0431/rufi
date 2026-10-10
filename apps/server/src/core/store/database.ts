// Rufi's one database. The running Rufi opens it for writing (creating it in
// a new data folder) while it holds rufi.lock; Rufi's tools read it through a
// read-only connection of their own.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer } from "effect";
import { Kysely } from "kysely";
import { Home } from "../../platform/config.ts";
import { NodeSqliteDialect } from "./dialect.ts";
import { inspect, SCHEMA, type Found } from "./migrations.ts";
import type { Tables } from "./tables.ts";

export interface Store {
  /** The connection itself, for checks Kysely doesn't build (schema, pragmas). */
  db: DatabaseSync;
  /** Typed queries on the same connection. */
  query: Kysely<Tables>;
  close: () => void;
}

/** `rufi.sqlite` in Rufi's data folder. */
export const databasePath = (home: string) => join(home, "rufi.sqlite");

/**
 * Opens the database read-only, or returns undefined when there is none yet.
 * Only a record of this Rufi's version opens (./migrations.ts).
 */
export function openReadOnly(path: string): Store | undefined {
  if (!existsSync(path)) return undefined;
  return checked(new DatabaseSync(path, { readOnly: true }), path);
}

/**
 * Opens the database for writing, creating it from schema.sql when there is
 * none, readable by this user only (SQLite gives its side files the same
 * permissions). Only a record of this Rufi's version opens, and nothing
 * changes before that is known. Every write is synced to disk (WAL,
 * synchronous FULL), and deleted data is overwritten (secure_delete).
 */
export function openWritable(path: string): Store {
  if (!existsSync(path)) writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  const store = checked(new DatabaseSync(path), path, true);
  try {
    store.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;",
    );
  } catch (error) {
    store.close();
    throw new Error(`Couldn't set up ${path}`, { cause: error });
  }
  return store;
}

/** A database this Rufi doesn't open as it is; the message says why and what to do. */
export class CantOpen extends Error {
  readonly found: Found;
  constructor(path: string, found: Found) {
    super(
      found.state === "older"
        ? `${path} is from an older Rufi. Start Rufi to upgrade it.`
        : found.state === "newer"
          ? `Rufi can't open ${path}: it was made by a newer Rufi. Update Rufi to open it; this one left it unchanged.`
          : found.state === "empty"
            ? `${path} is empty.`
            : `Rufi can't open ${path}: it isn't a record this Rufi knows, so it left it unchanged.`,
    );
    this.found = found;
  }
}

/**
 * Opens a record of this Rufi's version, with foreign keys on. An empty
 * database is made into one, all of it or none, when `create` says so.
 */
function checked(db: DatabaseSync, path: string, create = false): Store {
  try {
    if (create && inspect(db).state === "empty") {
      db.exec(`BEGIN; ${SCHEMA}; COMMIT;`);
    }
    const found = inspect(db);
    if (found.state !== "current") throw new CantOpen(path, found);
    db.exec("PRAGMA foreign_keys = ON");
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
