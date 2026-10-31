// The agent database: the package's own SQLite file (agents.sqlite in the
// host's data folder), apart from the host's records. It isn't backed up,
// exported or moved; when it's lost, a new file starts, says it is new, and
// the host carries on from its own history.
//
// Every change writes its events in the same transaction, so the host, which
// reads the event log after its cursor, learns of a change exactly when it's
// there. A change is one synchronous transaction:
// nothing else in the process runs between its writes. The connection
// writes only inside a change, so nothing a change started can write after
// it ends.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const read = (name: string) =>
  readFileSync(new URL(name, import.meta.url), "utf8");

/**
 * Each migration's SQL, in order: migration n takes the file from version
 * n - 1 to n. One that has shipped never changes; a change is a new one at
 * the end. No BEGIN, COMMIT or PRAGMA in them: openAgentStore does those.
 */
const MIGRATIONS: readonly string[] = [
  read("migrations/0001-agents.sql"),
  read("migrations/0002-questions.sql"),
  read("migrations/0003-agents-talk-back.sql"),
  read("migrations/0004-turn-usage.sql"),
];

/** An event as the log keeps it. */
export interface StoredEvent {
  /** Its place in the log: 1, 2, 3..., never used twice in one file. */
  number: number;
  type: string;
  /** The agent it is about, if one. */
  agent: string | null;
  payload: unknown;
  /** When it was written (ISO 8601). */
  at: string;
}

/** What a change's body returns: anything but a promise, as it can't wait. */
type Sync<T> = T extends PromiseLike<unknown> ? never : T;

/** One change, inside its transaction. */
export interface Change {
  /** The connection, for the change's reads and writes. */
  readonly db: DatabaseSync;
  /** Records an event: it commits with the change, or not at all. */
  event: (type: string, agent: string | null, payload: object) => void;
}

export interface AgentStore {
  /** The file was made by this open: whatever ran before is gone. */
  readonly fresh: boolean;
  /** The connection, for reads outside a change: it writes only in one. */
  readonly db: DatabaseSync;
  /**
   * Runs `work` as one transaction, and returns what it returns. Its writes
   * and the events it records commit together; if it throws, or records no
   * event, none of them do. It runs at once: it can't wait for anything.
   */
  change: <T>(work: (change: Change) => Sync<T>) => T;
  /** Up to `limit` events after `number`, in order. */
  eventsAfter: (number: number, limit?: number) => StoredEvent[];
  /**
   * Calls `listener` after each change commits, with its last event's
   * number, never inside the change; it reads the log after its own
   * cursor, and handles its own errors. Returns what stops it.
   */
  onCommit: (listener: (number: number) => void) => () => void;
  close: () => void;
}

/** The file's version is newer than this package knows. */
export class NewerAgentStore extends Error {}

/**
 * Opens the agent database at `path`, creating it when there is none,
 * readable by this user only (SQLite gives its side files the same
 * permissions), and brings it to this version, all pending migrations in
 * one transaction. A file from a newer version is left as it is. Every
 * write is synced to disk (WAL, synchronous FULL), and deleted data is
 * overwritten (secure_delete), as a forget needs.
 */
export function openAgentStore(path: string): AgentStore {
  if (!existsSync(path)) writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  const db = new DatabaseSync(path);
  let version: number;
  try {
    ({ user_version: version } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    });
    if (version > MIGRATIONS.length) {
      throw new NewerAgentStore(
        `${path} was made by a newer Rufi (version ${String(version)}); this one left it unchanged.`,
      );
    }
    db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;",
    );
    if (version < MIGRATIONS.length) migrate(db, version);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA query_only = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  return store(db, version === 0);
}

function migrate(db: DatabaseSync, from: number): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of MIGRATIONS.slice(from)) db.exec(migration);
    db.exec(`PRAGMA user_version = ${String(MIGRATIONS.length)}`);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw new Error("Couldn't set up the agent database.", { cause: error });
  }
}

function store(db: DatabaseSync, fresh: boolean): AgentStore {
  const append = db.prepare(
    "INSERT INTO events (type, agent_id, payload, created_at) VALUES (?, ?, ?, ?) RETURNING number",
  );
  const after = db.prepare(
    "SELECT number, type, agent_id, payload, created_at FROM events WHERE number > ? ORDER BY number LIMIT ?",
  );
  const listeners = new Set<(number: number) => void>();
  const inTransaction = () => db.isTransaction;

  const self: AgentStore = {
    fresh,
    db,

    change: (work) => {
      if (inTransaction()) {
        throw new Error("A change can't run inside another.");
      }
      let last: number | undefined;
      const change: Change = {
        db,
        event: (type, agent, payload) => {
          const row = append.get(
            type,
            agent,
            JSON.stringify(payload),
            new Date().toISOString(),
          ) as { number: number };
          last = row.number;
        },
      };
      let result;
      db.exec("PRAGMA query_only = OFF");
      try {
        db.exec("BEGIN IMMEDIATE");
        result = work(change);
        if (typeof (result as { then?: unknown } | null)?.then === "function") {
          throw new Error("A change can't wait: it runs as one transaction.");
        }
        if (last === undefined) {
          throw new Error("A change must record its event.");
        }
        db.exec("COMMIT");
      } catch (error) {
        // SQLite may have rolled back by itself (a full disk): a ROLLBACK
        // then would fail and hide the error that caused it.
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      } finally {
        // Whatever the body left running can't write now.
        db.exec("PRAGMA query_only = ON");
      }
      const number = last;
      for (const listener of listeners) {
        queueMicrotask(() => {
          // Unsubscribed or closed meanwhile: it hears nothing.
          if (listeners.has(listener)) listener(number);
        });
      }
      return result;
    },

    eventsAfter: (number, limit = 500) =>
      (
        after.all(number, limit) as {
          number: number;
          type: string;
          agent_id: string | null;
          payload: string;
          created_at: string;
        }[]
      ).map((row) => ({
        number: row.number,
        type: row.type,
        agent: row.agent_id,
        payload: JSON.parse(row.payload) as unknown,
        at: row.created_at,
      })),

    onCommit: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    close: () => {
      listeners.clear();
      db.close();
    },
  };
  return self;
}
