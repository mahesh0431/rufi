// get_records: the active person's records of one kind, optionally between
// two dates, as stored: removed records and earlier versions too, marked.
// The person is Rufi's choice; the AI can't name one, and nothing else can
// be read. The AI counts, compares and finds trends in the records itself.
import { Schema } from "effect";
import { sql } from "kysely";
import { dateProblem } from "../record/dates.ts";
import { fieldsOf } from "../record/read.ts";
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
});

/** Each kind with the field its dates are compared with. */
const datedBy = KINDS.map((kind) => `${kind.name} by ${kind.dated}`).join(", ");

/** A kind's records in plain words: "medicine uses", "allergies". */
const plural = (kind: Kind) =>
  kind.noun.endsWith("y") ? `${kind.noun.slice(0, -1)}ies` : `${kind.noun}s`;

/** What a read asked for, in plain words: "results from 2024 to 2026-03". */
export function asked(
  kind: string | null,
  from: string | null,
  to: string | null,
): string | null {
  const named = kind === null ? undefined : kindNamed(kind);
  if (!named) return null;
  return [
    plural(named),
    from !== null && `from ${from}`,
    to !== null && `to ${to}`,
  ]
    .filter((part) => part !== false)
    .join(" ");
}

export const getRecords = defineTool({
  name: "get_records",
  shown: "Read your records",
  description: `The active person's records of one kind (${names.join(", ")}), as stored: each with its id and fields as save_changes takes them, also the records removed from the record ("removed": true) and results replaced by an amended one ("replaced_by": the amended result's id). Newest first, undated last. With from or to, only records dated in that period: ${datedBy}. A record dated at a lower precision is read when its year or month overlaps the period ("2026" is in from 2026-03); a record with no date is read only without from and to. At most ${String(LIMITS.records)} records and ${String(LIMITS.bytes / 1000)} KB of records (as UTF-8 JSON) come back. When a cap leaves records out, the answer says "complete": false and "capped": narrow the dates and read again. Read only: nothing changes. Count, compare and find trends in the records yourself. Rufi chooses the person, not you.`,
  input: Input,
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [
    { kind: "result", from: "2024" },
    { kind: "symptom", from: "2026-01", to: "2026-06" },
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
      ORDER BY ${calendar} DESC, ${date} IS NULL, ${date} DESC, r.rowid DESC
      LIMIT ${LIMITS.records + 1}`.execute(store.query);
    const records: Record<string, unknown>[] = [];
    let bytes = 0;
    let capped = false;
    for (const row of rows) {
      const record = {
        id: row["id"],
        ...fieldsOf(kind, row),
        ...(typeof row["asserted"] === "string" && {
          asserted: row["asserted"],
        }),
        ...(row["removed"] === 1 && { removed: true }),
        ...(typeof row["replaced_by"] === "string" && {
          replaced_by: row["replaced_by"],
        }),
      };
      bytes += Buffer.byteLength(JSON.stringify(record));
      if (records.length === LIMITS.records || bytes > LIMITS.bytes) {
        capped = true;
        break;
      }
      records.push(record);
    }
    return {
      kind: kind.name,
      ...(input.from !== undefined && { from: input.from }),
      ...(input.to !== undefined && { to: input.to }),
      records,
      returned: records.length,
      complete: !capped,
      ...(capped && {
        capped: `Narrow the dates: more records matched than the ${records.length === LIMITS.records ? `${String(LIMITS.records)} records` : `${String(LIMITS.bytes / 1000)} KB`} that come back at most. These are the newest ${String(records.length)}.`,
      }),
    };
  },
});
