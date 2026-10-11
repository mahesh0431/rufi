// get_records: the active person's records of one kind, optionally between
// two dates or exactly by id, as stored: removed records and earlier
// versions too, marked, each with its version and its sources. A read that
// a cap cuts short goes on with a continuation, so it can always be
// finished (docs/adr/0006). The person is Rufi's choice; the AI can't name
// one, and nothing else can be read. The AI counts, compares and finds
// trends in the records itself.
import { Schema } from "effect";
import { sql } from "kysely";
import { dateProblem, shownDate } from "../record/dates.ts";
import { fieldsOf, recordVersions } from "../record/read.ts";
import { KINDS, kindNamed, type Kind, type Row } from "../record/kinds.ts";
import { defineTool, Refusal } from "./registry.ts";

/** The caps the description states; the read stops at the same numbers. */
export const LIMITS = {
  /** Records given back at most. */
  records: 200,
  /** Bytes of records (as UTF-8 JSON) given back at most: under what the agent passes on to the model whole. */
  bytes: 32_000,
};

const names = KINDS.map((kind) => kind.name) as [string, ...string[]];

const Bound = (description: string) =>
  Schema.optionalKey(
    // Described before the check: a description after it isn't in the JSON schema.
    Schema.String.annotate({ description }).check(
      Schema.makeFilter((text: string) => dateProblem(text)),
    ),
  );

const Input = Schema.Struct({
  kind: Schema.Literals(names).annotate({
    description: "The kind of record, as save_changes names it.",
  }),
  from: Bound(
    "The earliest date to read, YYYY, YYYY-MM or YYYY-MM-DD; leave it out for no start.",
  ),
  to: Bound(
    "The latest date to read, YYYY, YYYY-MM or YYYY-MM-DD; leave it out for no end.",
  ),
  category: Schema.optionalKey(
    Schema.Literals(["lab", "measurement"]).annotate({
      description:
        "Results only: just lab results or just measurements; leave it out for both.",
    }),
  ),
  ids: Schema.optionalKey(
    Schema.Array(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    )
      .check(Schema.isMinLength(1), Schema.isMaxLength(LIMITS.records))
      .annotate({
        description: `Exactly these records, by id (at most ${String(LIMITS.records)}); not with from, to or after.`,
      }),
  ),
  after: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The `next` of the previous answer, to read on with the same kind, category, from and to.",
    }),
  ),
}).check(
  Schema.makeFilter(
    (input: {
      kind: string;
      category?: unknown;
      ids?: unknown;
      from?: unknown;
      to?: unknown;
      after?: unknown;
    }) =>
      input.category !== undefined && input.kind !== "result"
        ? "Give category only with kind result."
        : input.ids !== undefined &&
            (input.category !== undefined ||
              input.from !== undefined ||
              input.to !== undefined ||
              input.after !== undefined)
          ? "Give ids alone, or category, from, to and after without ids."
          : undefined,
  ),
);

/** Each kind with the field its dates are compared with. */
const datedBy = KINDS.map((kind) => `${kind.name} by ${kind.dated}`).join(", ");

/** The period a read's dates open: from "2026-01-01" starts 2026. */
function opened(date: string): string {
  let start = date;
  while (/^\d{4}(-\d{2})*-01$/.test(start)) start = start.slice(0, -3);
  return start;
}

/** The period a read's dates close: to "2026-12-31" ends 2026. */
function closed(date: string): string {
  let end = date;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
  // Day 0 of the next month is the last day of this one.
  if (
    day &&
    Number(day[3]) ===
      new Date(Date.UTC(Number(day[1]), Number(day[2]), 0)).getUTCDate()
  ) {
    end = end.slice(0, 7);
  }
  if (/^\d{4}-12$/.test(end)) end = end.slice(0, 4);
  return end;
}

/** A read's dates in words: "in 2026", "since Mar 2024", "from 2024 to 8 Oct 2026". */
function period(from: string | undefined, to: string | undefined) {
  if (from !== undefined && to !== undefined) {
    const start = opened(from);
    if (start === closed(to)) {
      return `${start.length > 7 ? "on" : "in"} ${shownDate(start)}`;
    }
    return `from ${shownDate(from)} to ${shownDate(to)}`;
  }
  if (from !== undefined) return `since ${shownDate(from)}`;
  if (to !== undefined) return `up to ${shownDate(to)}`;
  return undefined;
}

/** A date the AI sent, when it is one. */
const dateIn = (value: unknown) =>
  typeof value === "string" && dateProblem(value) === undefined
    ? value
    : undefined;

/** What a read of results of one category is called. */
const CATEGORY_NOUNS: Record<string, string> = {
  lab: "lab results",
  measurement: "measurements",
};

/** A read in plain words, from what the AI sent: "Read your lab results in 2026". */
function shown(input: unknown): string {
  const sent = (input ?? {}) as Record<string, unknown>;
  const kind =
    typeof sent["kind"] === "string" ? kindNamed(sent["kind"]) : undefined;
  if (!kind) return "Read your records";
  const when = period(dateIn(sent["from"]), dateIn(sent["to"]));
  const nouns =
    (typeof sent["category"] === "string" &&
      CATEGORY_NOUNS[sent["category"]]) ||
    kind.nouns;
  return `Read your ${nouns}${when === undefined ? "" : ` ${when}`}`;
}

export const getRecords = defineTool({
  name: "get_records",
  shown,
  description: `The active person's records of one kind (${names.join(", ")}), as stored: each with its id, its version (the save that last changed it; null when none did), its fields as save_changes takes them and its sources (the user's message, or a document's page), also the records removed from the record ("removed": true) and results replaced by an amended one ("replaced_by": the amended result's id). Newest first, undated last. For results, category reads only lab results or only measurements; without it, both. With from or to, only records dated in that period: ${datedBy}. A record dated at a lower precision is read when its year or month overlaps the period ("2026" is in from 2026-03); a record with no date is read only without from and to. With ids, exactly those records. At most ${String(LIMITS.records)} records and ${String(LIMITS.bytes / 1000)} KB of records (as UTF-8 JSON) come back at once (a single larger record comes back on its own); when there are more, the answer says "complete": false and gives "next": pass it as after, with the same kind, category, from and to, to read on until "complete" is true. Read only: nothing changes. Count, compare and find trends in the records yourself. Rufi chooses the person, not you.`,
  input: Input,
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [
    { kind: "result", from: "2024" },
    { kind: "result", category: "measurement", from: "2026-09" },
    { kind: "symptom", from: "2026-01", to: "2026-06" },
    { kind: "result", ids: ["0199a0f2-0000-7000-8000-00000000000a"] },
  ],
  run: async (input, { store, personId }) => {
    if (!store) return { note: "Rufi has no records yet." };
    if (personId === undefined) {
      throw new Refusal(
        "No person is chosen in Rufi, so the record can't be read. Ask the user which person they mean.",
      );
    }
    const kind = kindNamed(input.kind) as Kind;
    const field = kind.fields[kind.dated];
    const date = sql.ref(`r.${field?.column ?? kind.dated}`);
    // A calendar date, not 'next_visit' or none.
    const calendar = sql`${date} GLOB '[0-9][0-9][0-9][0-9]*'`;
    // A date at the precision both have: "2026" overlaps from 2026-03.
    const atBoth = (bound: string) =>
      sql`substr(${date}, 1, min(length(${date}), ${bound.length}))`;
    // The order, and where a continuation goes on: after the record it names.
    const isCalendar = sql<number>`coalesce(${calendar}, 0)`;
    const isUndated = sql<number>`(${date} IS NULL)`;
    const sortDate = sql<string>`coalesce(${date}, '')`;
    let after = sql``;
    if (input.after !== undefined) {
      const { rows: last } = await sql<{
        c: number;
        n: number;
        d: string;
        r: number;
      }>`SELECT ${isCalendar} AS c, ${isUndated} AS n, ${sortDate} AS d, r.rowid AS r FROM ${sql.table(kind.table)} r WHERE r.person_id = ${personId} AND r.id = ${input.after}`.execute(
        store.query,
      );
      const at = last[0];
      if (!at) {
        throw new Refusal(
          "That `after` isn't from this read: read again without it.",
        );
      }
      after = sql`AND (${isCalendar} < ${at.c}
        OR (${isCalendar} = ${at.c} AND ${isUndated} > ${at.n})
        OR (${isCalendar} = ${at.c} AND ${isUndated} = ${at.n} AND ${sortDate} < ${at.d})
        OR (${isCalendar} = ${at.c} AND ${isUndated} = ${at.n} AND ${sortDate} = ${at.d} AND r.rowid < ${at.r}))`;
    }
    const exactly =
      input.ids === undefined
        ? sql``
        : sql`AND r.id IN (${sql.join(input.ids)})`;
    const ofCategory =
      input.category === undefined
        ? sql``
        : sql`AND r.category = ${input.category}`;
    const { rows } = await sql<Row>`
      SELECT r.*${
        kind.name === "result"
          ? sql`, (SELECT n.id FROM results n WHERE n.person_id = r.person_id AND n.replaces_id = r.id AND n.removed = 0 ORDER BY n.rowid DESC LIMIT 1) AS replaced_by`
          : sql``
      }
      FROM ${sql.table(kind.table)} r
      WHERE r.person_id = ${personId}
      ${
        input.from === undefined && input.to === undefined
          ? sql``
          : sql`AND ${calendar}`
      }
      ${input.from === undefined ? sql`` : sql`AND ${atBoth(input.from)} >= substr(${input.from}, 1, length(${date}))`}
      ${input.to === undefined ? sql`` : sql`AND ${atBoth(input.to)} <= substr(${input.to}, 1, length(${date}))`}
      ${after}
      ${exactly}
      ${ofCategory}
      ORDER BY ${calendar} DESC, ${date} IS NULL, ${date} DESC, r.rowid DESC
      LIMIT ${LIMITS.records + 1}`.execute(store.query);
    const ids = rows.map((row) => String(row["id"]));
    const versions = await recordVersions(
      store.query,
      personId,
      ids.map((id) => ({ kind: kind.name, id })),
    );
    const sources =
      ids.length === 0
        ? []
        : await store.query
            .selectFrom("record_sources as s")
            .leftJoin("document_pages as p", (join) =>
              join
                .onRef("p.person_id", "=", "s.person_id")
                .onRef("p.document_id", "=", "s.document_id")
                .onRef("p.position", "=", "s.page"),
            )
            .select([
              "s.record_id",
              "s.type",
              "s.entry_id",
              "s.document_id",
              "s.page",
              "p.file_name",
            ])
            .where("s.person_id", "=", personId)
            .where("s.kind", "=", kind.name)
            .where("s.record_id", "in", ids)
            .where("s.removed_by", "is", null)
            .orderBy(sql.ref("s.rowid"))
            .execute();
    const records: Record<string, unknown>[] = [];
    let bytes = 0;
    let capped = false;
    for (const row of rows) {
      const id = String(row["id"]);
      const mine = sources.filter((source) => source.record_id === id);
      const record = {
        id: row["id"],
        version: versions.get(`${kind.name}:${id}`) ?? null,
        ...fieldsOf(kind, row),
        ...(typeof row["asserted"] === "string" && {
          asserted: row["asserted"],
        }),
        ...(row["removed"] === 1 && { removed: true }),
        ...(typeof row["replaced_by"] === "string" && {
          replaced_by: row["replaced_by"],
        }),
        ...(mine.length > 0 && {
          sources: mine.map((source) =>
            source.type === "message"
              ? { message: source.entry_id }
              : {
                  document: source.document_id,
                  page: source.page,
                  file: source.file_name,
                },
          ),
        }),
      };
      bytes += Buffer.byteLength(JSON.stringify(record));
      // The first record always comes back, so next always moves on.
      if (
        records.length === LIMITS.records ||
        (bytes > LIMITS.bytes && records.length > 0)
      ) {
        capped = true;
        break;
      }
      records.push(record);
    }
    const missing = input.ids?.filter((id) => !ids.includes(id)) ?? [];
    return {
      kind: kind.name,
      ...(input.category !== undefined && { category: input.category }),
      ...(input.from !== undefined && { from: input.from }),
      ...(input.to !== undefined && { to: input.to }),
      records,
      returned: records.length,
      complete: !capped,
      ...(missing.length > 0 && { not_found: missing }),
      ...(capped && {
        next: records.at(-1)?.["id"],
        capped: `More records matched than come back at once (${records.length === LIMITS.records ? `${String(LIMITS.records)} records` : `${String(LIMITS.bytes / 1000)} KB`}). These are the next ${String(records.length)}: read on with after set to next.`,
      }),
    };
  },
});
