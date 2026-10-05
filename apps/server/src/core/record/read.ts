// The record as the AI reads it in get_overview: the current records of
// each kind, and the latest saves with what each changed, so the AI can
// find a record to change and save the reverse of a save.
import type { Store } from "../store/database.ts";
import { sql } from "kysely";
import {
  KINDS,
  kindNamed,
  wordsColumn,
  type Field,
  type Kind,
  type Row,
} from "./kinds.ts";

/** Records of one kind shown at most; the tool's description says the same. */
export const RECORDS_SHOWN = 50;
/** Latest saves shown. */
export const SAVES_SHOWN = 5;

/** A field of a stored record in the shape save_changes takes it. */
function given(field: Field, row: Row): unknown {
  const value = row[field.column];
  if (value === null || value === undefined) return undefined;
  switch (field.type) {
    case "value":
      return value;
    case "boolean":
      return value === 1;
    case "due":
    case "date":
      // A due date is a date, or the next visit.
      if (value === "next_visit") return value;
      return { date: value, words: row[wordsColumn(field)] ?? undefined };
    case "link":
      return { kind: row["linked_kind"], id: value };
  }
}

/** The fields a record has, by the names save_changes uses. */
function fieldsOf(kind: Kind, row: Row, only?: (name: string) => boolean) {
  const fields: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(kind.fields)) {
    if (only && !only(name)) continue;
    const value = given(field, row);
    if (value !== undefined) fields[name] = value;
  }
  return fields;
}

/**
 * The person's records that aren't removed, by kind; results are in the
 * overview's latest_results.
 */
export async function currentRecords(store: Store, personId: string) {
  const record: Record<string, unknown> = {};
  for (const kind of KINDS) {
    if (kind.name === "result") continue;
    const { rows } =
      await sql<Row>`SELECT * FROM ${sql.table(kind.table)} WHERE person_id = ${personId} AND removed = 0 ORDER BY rowid DESC LIMIT ${RECORDS_SHOWN + 1}`.execute(
        store.query,
      );
    if (rows.length === 0) continue;
    record[kind.name] = {
      items: rows.slice(0, RECORDS_SHOWN).map((row) => ({
        id: row["id"],
        ...fieldsOf(kind, row),
        ...(typeof row["asserted"] === "string" && {
          asserted: row["asserted"],
        }),
      })),
      ...(rows.length > RECORDS_SHOWN && { more: true }),
    };
  }
  return record;
}

/** The person's latest saves, newest first, each with what it changed. */
export async function recentSaves(store: Store, personId: string) {
  const saves = await store.query
    .selectFrom("operations as o")
    .innerJoin("transcript_entries as e", (join) =>
      join.onRef("e.person_id", "=", "o.person_id").onRef("e.id", "=", "o.id"),
    )
    .select(["o.id", "o.created_at", "e.text"])
    .where("o.person_id", "=", personId)
    .orderBy("o.created_at", "desc")
    .orderBy("o.id", "desc")
    .limit(SAVES_SHOWN)
    .execute();
  const shown = [];
  for (const save of saves) {
    const changes = await store.query
      .selectFrom("record_changes")
      .select(["kind", "record_id", "action", "before", "after"])
      .where("person_id", "=", personId)
      .where("operation_id", "=", save.id)
      .orderBy("seq")
      .execute();
    shown.push({
      at: save.created_at,
      receipt: save.text,
      changes: changes.map((change) => {
        const kind = kindNamed(change.kind) as Kind;
        const after = JSON.parse(change.after) as Row;
        const before =
          change.before === null
            ? undefined
            : (JSON.parse(change.before) as Row);
        const base = {
          kind: change.kind,
          id: change.record_id,
          action: change.action,
        };
        if (change.action !== "change" || !before) {
          return change.action === "add"
            ? { ...base, fields: fieldsOf(kind, after) }
            : base;
        }
        // Only what the change changed, before and after.
        const changed = (name: string) => {
          const field = kind.fields[name] as Field;
          return (
            JSON.stringify(given(field, before)) !==
            JSON.stringify(given(field, after))
          );
        };
        return {
          ...base,
          before: fieldsOf(kind, before, changed),
          after: fieldsOf(kind, after, changed),
        };
      }),
    });
  }
  return shown;
}
