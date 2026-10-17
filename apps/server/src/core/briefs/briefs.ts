// Visit briefs (docs/help/visit-brief.md): a dated page the AI writes from
// the saved record, made with create_brief in Rufi's chat. A brief never
// changes. It keeps the record version the AI read it from, so a later save
// shows as "the record changed since", and each record it cites with that
// record's version, so its Sources show what it rested on. The AI cites in
// plain words; the Sources list is built here from the cited records, and
// the AI's Markdown is never parsed.
import { Schema } from "effect";
import { sql, type Kysely, type Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import { localTime, shownDate } from "../record/dates.ts";
import { KINDS, kindNamed, type Kind, type Row } from "../record/kinds.ts";
import { isCurrent, recordVersion, recordVersions } from "../record/read.ts";
import type { Tables } from "../store/tables.ts";

const kindNames = KINDS.map((kind) => kind.name) as [string, ...string[]];

export const BriefInput = Schema.Struct({
  markdown: Schema.String.annotate({
    description:
      "The brief in Markdown: short sections, every fact from a record you cite, questions labelled as questions. No links or images.",
  }).check(Schema.isMinLength(1)),
  record_version: Schema.Int.annotate({
    description:
      "The record_version get_overview gave you before you read the record for this brief.",
  }).check(Schema.isGreaterThanOrEqualTo(0)),
  cited: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(kindNames).annotate({
        description: "The record's kind, as get_records names it.",
      }),
      id: Schema.String.annotate({
        description: "The record's id, from get_overview or get_records.",
      }).check(
        Schema.isTrimmed(),
        Schema.isMinLength(1),
        Schema.isMaxLength(100),
      ),
    }),
  )
    .annotate({
      description:
        "Every saved record the brief's facts come from, at least one.",
    })
    .check(Schema.isMinLength(1)),
});
export type BriefInput = typeof BriefInput.Type;

/** A brief Rufi refused; nothing of it was written. */
export class BriefRefused extends Error {
  readonly problems: { path: string; got: string; fix: string }[];
  constructor(
    message: string,
    problems: { path: string; got: string; fix: string }[] = [],
  ) {
    super(message);
    this.problems = problems;
  }
}

export interface Made {
  /** The brief's id; its line in the chat has the same id. */
  id: string;
  /** Its line in the chat. */
  line: string;
  /** False when this call made it before: nothing new was written. */
  fresh: boolean;
}

interface Where {
  personId: string;
  chatId: string;
  /** The turn that made it, when it is still known. */
  turnId: string | null;
  /** The agent's id for the call. */
  callId: string;
  now: string;
}

interface Cited {
  kind: string;
  id: string;
  /** The save that last changed it when cited; null: none had. */
  version: string | null;
}

/**
 * Checks a brief and writes it in `trx`, or throws BriefRefused with every
 * problem. Run it in the transaction that adds its line.
 */
export async function createBrief(
  trx: Transaction<Tables>,
  where: Where,
  input: BriefInput,
): Promise<Made> {
  // The same record once, in the order the AI cited it.
  const wanted = [
    ...new Map(input.cited.map((c) => [`${c.kind}:${c.id}`, c])).values(),
  ];
  const earlier = await trx
    .selectFrom("briefs as b")
    .innerJoin("transcript_entries as e", (join) =>
      join.onRef("e.person_id", "=", "b.person_id").onRef("e.id", "=", "b.id"),
    )
    .select(["b.id", "b.markdown", "b.record_version", "b.cited", "e.text"])
    .where("b.chat_id", "=", where.chatId)
    .where("b.call_id", "=", where.callId)
    .executeTakeFirst();
  if (earlier) {
    const same =
      earlier.markdown === input.markdown &&
      earlier.record_version === input.record_version &&
      JSON.stringify(
        (JSON.parse(earlier.cited) as Cited[]).map(({ kind, id }) => ({
          kind,
          id,
        })),
      ) === JSON.stringify(wanted.map(({ kind, id }) => ({ kind, id })));
    if (!same) {
      throw new BriefRefused(
        "This call was already used for another brief, so nothing was made. Make a new call.",
      );
    }
    return { id: earlier.id, line: earlier.text, fresh: false };
  }

  const problems: BriefRefused["problems"] = [];
  const now = await recordVersion(trx, where.personId);
  if (input.record_version > now) {
    problems.push({
      path: "record_version",
      got: String(input.record_version),
      fix: "Rufi gave no such record version. Read get_overview and give its record_version.",
    });
  }
  const versions = await recordVersions(
    trx,
    where.personId,
    wanted,
    input.record_version,
  );
  for (const [index, cited] of input.cited.entries()) {
    const kind = kindNamed(cited.kind) as Kind;
    const saved = await recordOf(trx, kind, where.personId, cited.id);
    const row =
      saved &&
      (await rowAt(trx, kind, where.personId, {
        ...cited,
        version: versions.get(`${cited.kind}:${cited.id}`) ?? null,
      }));
    const wrong = !saved
      ? `No ${kind.noun} with this id is saved in this person's record. Cite only saved records you read with get_overview or get_records.`
      : !row
        ? `No ${kind.noun} with this id was saved at this record version. Read get_overview and write the brief again from that version.`
        : row["removed"] === 1
          ? `This ${kind.noun} was removed from the record. Leave it out of the brief.`
          : undefined;
    if (wrong) {
      problems.push({
        path: `cited.${String(index)}.id`,
        got: JSON.stringify(cited.id),
        fix: wrong,
      });
    }
  }
  if (problems.length > 0) {
    throw new BriefRefused(
      "Nothing was made. Fix these and make the brief again.",
      problems,
    );
  }

  const cited: Cited[] = wanted.map(({ kind, id }) => ({
    kind,
    id,
    version: versions.get(`${kind}:${id}`) ?? null,
  }));
  const id = uuid();
  await trx
    .insertInto("briefs")
    .values({
      id,
      person_id: where.personId,
      chat_id: where.chatId,
      turn_id: where.turnId,
      call_id: where.callId,
      markdown: input.markdown,
      record_version: input.record_version,
      cited: JSON.stringify(cited),
      created_at: where.now,
    })
    .execute();
  const count = cited.length;
  return {
    id,
    line: `Visit brief · Made ${shownDate(localTime(where.now).slice(0, 10))} · ${String(count)} ${count === 1 ? "record" : "records"} cited`,
    fresh: true,
  };
}

/** One record a brief cites, as its page shows it. */
interface Source {
  /** The record's kind in words: "Medicine use", "Result". */
  kind: string;
  /** The record as the brief cited it: "HbA1c 6.8 % · 12 Aug 2026". */
  what: string;
  /** Where that record came from, in words. */
  from: string;
  /** A save changed this record after the brief cited it. */
  changedSince: boolean;
  /** The record to open: this one, or the result that amends it now; null once removed. */
  record: { kind: string; id: string } | null;
}

export interface Brief {
  id: string;
  createdAt: string;
  markdown: string;
  /** A save after the brief raised the record version. */
  changedSince: boolean;
  sources: Source[];
}

/** A brief of the person's, with its Sources; undefined when there is none. */
export async function readBrief(
  query: Kysely<Tables>,
  personId: string,
  briefId: string,
): Promise<Brief | undefined> {
  const brief = await query
    .selectFrom("briefs")
    .selectAll()
    .where("person_id", "=", personId)
    .where("id", "=", briefId)
    .executeTakeFirst();
  if (!brief) return undefined;
  const cited = JSON.parse(brief.cited) as Cited[];
  const now = await recordVersions(query, personId, cited);
  const sources: Source[] = [];
  for (const record of cited) {
    const kind = kindNamed(record.kind) as Kind;
    const row = await rowAt(query, kind, personId, record);
    if (!row) continue;
    sources.push({
      kind: capital(kind.noun),
      what: summary(kind, row),
      from: await sourceOf(query, personId, kind, row, record.version),
      changedSince:
        now.get(`${record.kind}:${record.id}`) !== record.version ||
        (kind.name === "result" &&
          (await amendedSince(
            query,
            personId,
            record.id,
            brief.record_version,
          ))),
      record: await toOpen(query, kind, personId, record.id),
    });
  }
  return {
    id: brief.id,
    createdAt: brief.created_at,
    markdown: brief.markdown,
    changedSince: (await recordVersion(query, personId)) > brief.record_version,
    sources,
  };
}

async function recordOf(
  query: Kysely<Tables>,
  kind: Kind,
  personId: string,
  id: string,
): Promise<Row | undefined> {
  const { rows } =
    await sql<Row>`SELECT * FROM ${sql.table(kind.table)} WHERE person_id = ${personId} AND id = ${id}`.execute(
      query,
    );
  return rows[0];
}

/**
 * The record a source opens: the cited one while it is in the record; for a
 * result amended since, the result that amends it now, following each
 * amendment; null when there is none (removed).
 */
async function toOpen(
  query: Kysely<Tables>,
  kind: Kind,
  personId: string,
  id: string,
): Promise<{ kind: string; id: string } | null> {
  const { rows } =
    await sql`SELECT 1 FROM ${sql.table(kind.table)} r WHERE r.person_id = ${personId} AND r.id = ${id} AND ${isCurrent(kind, "r")}`.execute(
      query,
    );
  if (rows.length > 0) return { kind: kind.name, id };
  if (kind.name !== "result") return null;
  const newer = await query
    .selectFrom("results")
    .select("id")
    .where("person_id", "=", personId)
    .where("replaces_id", "=", id)
    .where("removed", "=", 0)
    .executeTakeFirst();
  return newer ? toOpen(query, kind, personId, newer.id) : null;
}

/**
 * A save after the brief's record version changed a result that amends this
 * one, or one that amends that (added, changed or removed since).
 */
async function amendedSince(
  query: Kysely<Tables>,
  personId: string,
  id: string,
  recordVersion: number,
): Promise<boolean> {
  const { rows } = await sql<{ id: string }>`
    WITH RECURSIVE amending(id) AS (
      SELECT id FROM results WHERE person_id = ${personId} AND replaces_id = ${id}
      UNION
      SELECT r.id FROM results r JOIN amending a ON r.replaces_id = a.id
      WHERE r.person_id = ${personId}
    )
    SELECT id FROM amending`.execute(query);
  const amending = rows.map((row) => ({ kind: "result", id: row.id }));
  const then = await recordVersions(query, personId, amending, recordVersion);
  const now = await recordVersions(query, personId, amending);
  return amending.some(
    ({ kind, id }) => then.get(`${kind}:${id}`) !== now.get(`${kind}:${id}`),
  );
}

/**
 * A cited record as it was when cited: as its version's save left it; with
 * no version, as it was before its first save, or as it is when no save has
 * changed it. A later add has no before row: it did not exist then.
 */
async function rowAt(
  query: Kysely<Tables>,
  kind: Kind,
  personId: string,
  cited: Cited,
): Promise<Row | undefined> {
  const changes = query
    .selectFrom("record_changes as c")
    .innerJoin("operations as o", (join) =>
      join
        .onRef("o.person_id", "=", "c.person_id")
        .onRef("o.id", "=", "c.operation_id"),
    )
    .select(["c.before", "c.after"])
    .where("c.person_id", "=", personId)
    .where("c.kind", "=", cited.kind)
    .where("c.record_id", "=", cited.id);
  if (cited.version !== null) {
    const change = await changes
      .where("c.operation_id", "=", cited.version)
      .executeTakeFirst();
    return change && (JSON.parse(change.after) as Row);
  }
  const first = await changes.orderBy("o.seq").executeTakeFirst();
  if (first)
    return first.before ? (JSON.parse(first.before) as Row) : undefined;
  return recordOf(query, kind, personId, cited.id);
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A record in one line: its label, its date and its state. */
function summary(kind: Kind, row: Row): string {
  const column = kind.fields[kind.dated]?.column ?? kind.dated;
  const date = row[column];
  const state = row["status"];
  return [
    // A statement's label carries its date; here it shows once, after it.
    kind.label(kind.name === "none_known" ? { ...row, asserted: null } : row),
    typeof date === "string" && date !== "next_visit" && shownDate(date),
    typeof state === "string" && state !== "unknown" && state,
    kind.name === "result" && row["replaces_id"] !== null && "amended",
  ]
    .filter((part) => typeof part === "string" && part !== "")
    .join(" · ");
}

/** The longest part of a message a source shows, in characters. */
const WORDS_MAX = 140;

/**
 * Where a record came from when it was cited (its version: the save that
 * last changed it then, null for none), in words: each of its sources then
 * (a document's page, with the report it was read from; the user's message
 * it rests on).
 */
async function sourceOf(
  query: Kysely<Tables>,
  personId: string,
  kind: Kind,
  row: Row,
  version: string | null,
): Promise<string> {
  // Saves up to the cited version; none when no save had changed it.
  const upTo =
    version === null
      ? sql<number>`0`
      : sql<number>`(SELECT seq FROM operations WHERE id = ${version})`;
  const order = (operation: "s.operation_id" | "s.removed_by") =>
    sql<number>`(SELECT seq FROM operations WHERE id = ${sql.ref(operation)})`;
  const sources = await query
    .selectFrom("record_sources as s")
    .leftJoin("document_pages as p", (join) =>
      join
        .onRef("p.person_id", "=", "s.person_id")
        .onRef("p.document_id", "=", "s.document_id")
        .onRef("p.position", "=", "s.page"),
    )
    .leftJoin("documents as d", (join) =>
      join
        .onRef("d.person_id", "=", "s.person_id")
        .onRef("d.id", "=", "s.document_id"),
    )
    .leftJoin("transcript_entries as e", (join) =>
      join
        .onRef("e.person_id", "=", "s.person_id")
        .onRef("e.id", "=", "s.entry_id"),
    )
    .select(["s.page", "p.file_name", "d.deleted_at", "e.text", "e.created_at"])
    .where("s.person_id", "=", personId)
    .where("s.kind", "=", kind.name)
    .where("s.record_id", "=", String(row["id"]))
    .where(
      sql<boolean>`(s.operation_id IS NULL OR ${order("s.operation_id")} <= ${upTo})`,
    )
    .where(
      sql<boolean>`(s.removed_by IS NULL OR ${order("s.removed_by")} > ${upTo})`,
    )
    .orderBy(sql`${order("s.operation_id")} NULLS FIRST`)
    .orderBy(sql.ref("s.rowid"))
    .execute();
  const reportId = row["report_id"];
  const report =
    typeof reportId === "string"
      ? await query
          .selectFrom("reports")
          .select(["issuer", "collected"])
          .where("person_id", "=", personId)
          .where("id", "=", reportId)
          .executeTakeFirst()
      : undefined;
  const words = sources.map((source) => {
    if (source.text !== null && source.created_at !== null) {
      const said =
        source.text.length > WORDS_MAX
          ? `${source.text.slice(0, WORDS_MAX - 1)}…`
          : source.text;
      return `Your message, ${shownDate(localTime(source.created_at).slice(0, 10))}: “${said}”`;
    }
    const page = `${source.file_name ?? "A document"}, page ${String(source.page)}`;
    return source.deleted_at === null ? page : `Document deleted (${page})`;
  });
  if (report && sources.some((source) => source.file_name !== null)) {
    words.unshift(
      `${report.issuer ?? "A"} report${report.collected === null ? "" : `, collected ${shownDate(report.collected)}`}`,
    );
  }
  return words.length > 0
    ? words.join(" · ")
    : "Saved before Rufi kept sources";
}
