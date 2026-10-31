// The record as the AI reads it in get_overview: the current records of
// each kind, and the latest saves with what each changed, so the AI can
// find a record to change and save the reverse of a save.
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";
import { sql, type Kysely } from "kysely";
import { ageOn } from "./dates.ts";
import {
  KINDS,
  kindNamed,
  unitColumn,
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
    case "amount":
      return { value, unit: row[unitColumn(field)] ?? undefined };
  }
}

/**
 * Whether the record in `alias` is current: not removed and, for a result,
 * not replaced by an amended result that isn't removed. Every read of the
 * current record (Overview, the record's pages, tiles, series) uses this.
 */
export function isCurrent(kind: Kind, alias: string) {
  const row = sql.ref(alias);
  const removed = sql`${sql.ref(`${alias}.removed`)} = 0`;
  if (kind.name !== "result") return sql<boolean>`${removed}`;
  return sql<boolean>`(${removed} AND NOT EXISTS (SELECT 1 FROM results n WHERE n.person_id = ${row}.person_id AND n.replaces_id = ${row}.id AND n.removed = 0))`;
}

/** What a change changed: only those fields, before and after. */
export function changed(kind: Kind, before: Row, after: Row) {
  const differs = (name: string) => {
    const field = kind.fields[name] as Field;
    return (
      JSON.stringify(given(field, before)) !==
      JSON.stringify(given(field, after))
    );
  };
  return {
    before: fieldsOf(kind, before, differs),
    after: fieldsOf(kind, after, differs),
  };
}

/** The fields a record has, by the names save_changes uses. */
export function fieldsOf(
  kind: Kind,
  row: Row,
  only?: (name: string) => boolean,
) {
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
 * overview's latest_results, the profile in its own part.
 */
export async function currentRecords(store: Store, personId: string) {
  const record: Record<string, unknown> = {};
  for (const kind of KINDS) {
    if (kind.name === "result" || kind.single) continue;
    const { rows } =
      await sql<Row>`SELECT * FROM ${sql.table(kind.table)} r WHERE person_id = ${personId} AND ${isCurrent(kind, "r")} ORDER BY rowid DESC LIMIT ${RECORDS_SHOWN + 1}`.execute(
        store.query,
      );
    if (rows.length === 0) continue;
    record[kind.name] = {
      items: rows.slice(0, RECORDS_SHOWN).map((row) => ({
        id: row["id"],
        // A visit's words can be pages long: get_records gives them.
        ...fieldsOf(kind, row, (name) => name !== "as_written"),
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
    .leftJoin("transcript_entries as e", (join) =>
      join.onRef("e.person_id", "=", "o.person_id").onRef("e.id", "=", "o.id"),
    )
    .select([
      "o.id",
      "o.origin",
      "o.created_at",
      sql<string>`coalesce(o.receipt, e.text)`.as("text"),
    ])
    .where("o.person_id", "=", personId)
    .orderBy("o.seq", "desc")
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
    // The pages and Visits the save added to its records or took off them:
    // what its reverse takes off or links again.
    const sources = await store.query
      .selectFrom("record_sources")
      .select([
        "kind",
        "record_id",
        "document_id",
        "page",
        "visit_id",
        "removed_by",
      ])
      .where("person_id", "=", personId)
      // A message or a form's entry isn't taken off by a reverse.
      .where("type", "in", ["document_page", "visit"])
      .where((eb) =>
        eb.or([
          eb("operation_id", "=", save.id),
          eb("removed_by", "=", save.id),
        ]),
      )
      .orderBy(sql.ref("rowid"))
      .execute();
    // A record this save added has the added page as a source too: a link
    // to it, an item saved as another source of it, has only that item's.
    const added = new Set(
      changes
        .filter((change) => change.action === "add")
        .map((change) => `${change.kind}:${change.record_id}`),
    );
    const linkedItems = await store.query
      .selectFrom("draft_items")
      .select(["record_id", "document_id", "page"])
      .where("person_id", "=", personId)
      .where("operation_id", "=", save.id)
      .where("saved_as", "=", "another_source")
      .execute();
    shown.push({
      at: save.created_at,
      // Where it was made: in the chat, or what the person entered in the
      // welcome, on the profile page or in Settings.
      made_in: save.origin,
      receipt: save.text,
      // One link or remove_source of several sources is a history row for
      // each: shown once, with them all.
      changes: changes
        .filter(
          (change, i) =>
            (change.action !== "link" && change.action !== "unlink") ||
            changes.findIndex(
              (other) =>
                other.kind === change.kind &&
                other.record_id === change.record_id &&
                other.action === change.action,
            ) === i,
        )
        .map((change) => {
          const kind = kindNamed(change.kind) as Kind;
          const after = JSON.parse(change.after) as Row;
          const before =
            change.before === null
              ? undefined
              : (JSON.parse(change.before) as Row);
          const ownLinks =
            change.action === "link" &&
            added.has(`${change.kind}:${change.record_id}`);
          const from = sources
            .filter(
              (s) =>
                s.kind === change.kind &&
                s.record_id === change.record_id &&
                (s.removed_by === save.id) === (change.action === "unlink") &&
                (!ownLinks ||
                  linkedItems.some(
                    (item) =>
                      item.record_id === s.record_id &&
                      item.document_id === s.document_id &&
                      item.page === s.page,
                  )),
            )
            .map((s) =>
              s.visit_id === null
                ? { document: s.document_id, page: s.page }
                : { visit: s.visit_id },
            );
          const base = {
            kind: change.kind,
            id: change.record_id,
            action: change.action,
            ...(from.length > 0 && change.action !== "add" && { from }),
          };
          if (change.action !== "change" || !before) {
            return change.action === "add"
              ? { ...base, fields: fieldsOf(kind, after) }
              : base;
          }
          return { ...base, ...changed(kind, before, after) };
        }),
    });
  }
  return shown;
}

type Reads = Kysely<Tables>;

/**
 * The person's profile as get_overview gives it: its id, the values given,
 * in save_changes' shape, with their age today (`today`, 'YYYY-MM-DD')
 * from the birth date, and the fields not set.
 */
export async function profileOf(query: Reads, personId: string, today: string) {
  const kind = kindNamed("profile") as Kind;
  const { rows } =
    await sql<Row>`SELECT * FROM profile_rows WHERE person_id = ${personId} AND id = ${personId}`.execute(
      query,
    );
  const row = rows[0];
  if (!row) return undefined;
  const fields = fieldsOf(kind, row);
  const birth = row["birth_date"];
  const [youngest, oldest] =
    typeof birth === "string" ? ageOn(birth, today) : [];
  return {
    id: row["id"],
    ...fields,
    ...(oldest !== undefined && {
      age_today:
        youngest === oldest
          ? oldest
          : `${String(youngest)} or ${String(oldest)}`,
    }),
    not_set: Object.keys(kind.fields).filter((name) => !(name in fields)),
  };
}

/**
 * The person's record version: how many saves their record has had. Every
 * save raises it, so a brief made from an older version knows the record
 * changed since.
 */
export async function recordVersion(query: Reads, personId: string) {
  const { n } = await query
    .selectFrom("operations")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("person_id", "=", personId)
    .executeTakeFirstOrThrow();
  return n;
}

/**
 * Each record's version: the id of the last save that changed it, or null
 * when no save has (a record from before Rufi kept saves). With asOf,
 * only the person's first asOf saves count. Keyed "kind:id".
 */
export async function recordVersions(
  query: Reads,
  personId: string,
  records: readonly { kind: string; id: string }[],
  asOf?: number,
): Promise<Map<string, string | null>> {
  const versions = new Map<string, string | null>(
    records.map(({ kind, id }) => [`${kind}:${id}`, null]),
  );
  if (records.length === 0) return versions;
  let history = query
    .selectFrom("record_changes as c")
    .innerJoin("operations as o", (join) =>
      join
        .onRef("o.person_id", "=", "c.person_id")
        .onRef("o.id", "=", "c.operation_id"),
    )
    .select(["c.kind", "c.record_id", "c.operation_id"])
    .where("c.person_id", "=", personId)
    .where(
      "c.record_id",
      "in",
      records.map(({ id }) => id),
    );
  if (asOf !== undefined) {
    history = history.where(
      "o.id",
      "in",
      query
        .selectFrom("operations")
        .select("id")
        .where("person_id", "=", personId)
        .orderBy("seq")
        .limit(asOf),
    );
  }
  // In the order of saves, even if the Mac's clock moved back.
  const changes = await history.orderBy("o.seq").execute();
  // Oldest first: the last one a record has wins.
  for (const change of changes) {
    const key = `${change.kind}:${change.record_id}`;
    if (versions.has(key)) versions.set(key, change.operation_id);
  }
  return versions;
}
