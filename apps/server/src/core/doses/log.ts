// The dose log (docs/adr/0033): what a person said happened to a dose of
// one of their medicines, kept as it came, outside the record. A log is
// only ever added: no save writes it, and nothing here changes or removes a
// row. Its id is made where it was logged and kept across a retry, so the
// same log sent again is stored once. A dose's state is its log with the
// latest logged_at (then received_at), so a log made offline sits in its
// place when it arrives later; the rows themselves are the history.
import type { DoseLogRow, LogDose } from "@rufi/contracts/record";
import { sql, type Kysely } from "kysely";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";

/** The medicine isn't one of the person's. */
export class NoSuchMedicine extends Error {
  constructor() {
    super("There is no such medicine.");
  }
}

/** Another log, or another person's, already has this id. */
export class IdTaken extends Error {
  constructor() {
    super("Another dose log already has this id.");
  }
}

/** Who logged a dose: 'mac', 'rufi_ai' or 'app:<paired app id>'. */
type LoggedBy = string;

type Row = Tables["dose_log"];

/** The order a dose's logs were made in: the last decides. */
const LOGGED_ORDER = sql`julianday(d.logged_at), julianday(d.received_at), d.rowid`;

/** Whether a stored row is the log sent: who sent it and when it came aside. */
const sameLog = (row: Row, personId: string, log: LogDose) =>
  row.person_id === personId &&
  row.medicine_use_id === log.medicineUseId &&
  row.dose_at === log.doseAt &&
  row.state === log.state &&
  row.taken_at === (log.takenAt ?? null) &&
  row.logged_at === log.loggedAt;

/**
 * Each dose's latest log from `from` to `to` (local dose times, inclusive),
 * by `${medicine_use_id} ${dose_at}`; an undo last is left in, as cleared.
 */
export async function latestLogs(
  db: Kysely<Tables>,
  personId: string,
  from: string,
  to: string,
): Promise<Map<string, Row>> {
  const { rows } = await sql<Row>`SELECT d.* FROM dose_log d
    WHERE d.person_id = ${personId} AND d.dose_at BETWEEN ${from} AND ${to}
    ORDER BY ${LOGGED_ORDER}`.execute(db);
  return new Map(rows.map((row) => [doseKey(row), row]));
}

/** A dose of one medicine, as `latestLogs` keys it. */
export const doseKey = (
  row: Pick<Row, "medicine_use_id" | "dose_at">,
): string => `${row.medicine_use_id} ${row.dose_at}`;

/**
 * The person's logs for doses on the local days `from` to `to`
 * ('YYYY-MM-DD', inclusive), of one medicine or all, by dose, then in the
 * order they were logged; each with its medicine as it is now.
 */
export async function listDoses(
  db: Kysely<Tables>,
  personId: string,
  from: string,
  to: string,
  medicineUseId?: string,
): Promise<DoseLogRow[]> {
  const { rows } = await sql<
    Row & { name: string; strength: string | null }
  >`SELECT d.*, m.name, m.strength FROM dose_log d
    JOIN medicine_uses m ON m.person_id = d.person_id AND m.id = d.medicine_use_id
    WHERE d.person_id = ${personId}
      AND d.dose_at BETWEEN ${`${from}T00:00`} AND ${`${to}T23:59`}
      AND (${medicineUseId ?? null} IS NULL OR d.medicine_use_id = ${medicineUseId ?? null})
    ORDER BY d.dose_at, ${LOGGED_ORDER}`.execute(db);
  return rows.map((row) => ({
    id: row.id,
    medicine: {
      id: row.medicine_use_id,
      name: row.name,
      ...(row.strength !== null && { strength: row.strength }),
    },
    doseAt: row.dose_at,
    state: row.state as DoseLogRow["state"],
    ...(row.taken_at !== null && { takenAt: row.taken_at }),
    loggedAt: row.logged_at,
    receivedAt: row.received_at,
    by: row.logged_by,
  }));
}

export type DoseLog = ReturnType<typeof doseLog>;

export function doseLog(store: Store, now: () => Date = () => new Date()) {
  const listeners = new Map<string, Set<() => void>>();
  const changed = (personId: string) => {
    for (const listener of listeners.get(personId) ?? []) listener();
  };

  return {
    /**
     * Stores a log for the person, by `by`: "added", or "already" when this
     * id holds the same log. Refuses another log under the id, and a
     * medicine that isn't the person's, storing nothing.
     */
    add: async (
      personId: string,
      log: LogDose,
      by: LoggedBy,
    ): Promise<"added" | "already"> => {
      const answer = await store.query.transaction().execute(async (trx) => {
        const found = await trx
          .selectFrom("dose_log")
          .selectAll()
          .where("id", "=", log.id)
          .executeTakeFirst();
        if (found) {
          if (sameLog(found, personId, log)) return "already" as const;
          throw new IdTaken();
        }
        const medicine = await trx
          .selectFrom("medicine_uses")
          .select("id")
          .where("person_id", "=", personId)
          .where("id", "=", log.medicineUseId)
          .executeTakeFirst();
        if (!medicine) throw new NoSuchMedicine();
        await trx
          .insertInto("dose_log")
          .values({
            id: log.id,
            person_id: personId,
            medicine_use_id: log.medicineUseId,
            dose_at: log.doseAt,
            state: log.state,
            taken_at: log.takenAt ?? null,
            logged_at: log.loggedAt,
            received_at: now().toISOString(),
            logged_by: by,
          })
          .execute();
        return "added" as const;
      });
      if (answer === "added") changed(personId);
      return answer;
    },

    /** The person's logs (`listDoses`). */
    list: (
      personId: string,
      from: string,
      to: string,
      medicineUseId?: string,
    ): Promise<DoseLogRow[]> =>
      listDoses(store.query, personId, from, to, medicineUseId),

    /** Tells the person's listeners that what rings or shows changed. */
    changed,

    /**
     * Calls `listener` after each log stored for the person, and when their
     * reminder setting changes.
     */
    subscribe: (personId: string, listener: () => void): (() => void) => {
      const set = listeners.get(personId) ?? new Set();
      set.add(listener);
      listeners.set(personId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(personId);
      };
    },
  };
}
