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
import { recordVersion, recordVersions } from "../record/read.ts";
import type { Tables } from "../store/tables.ts";

/** The longest brief, in characters; the tool's description says the same. */
const MARKDOWN_MAX = 20_000;
/** Records one brief cites at most; the tool's description says the same. */
export const CITED_MAX = 200;

const kindNames = KINDS.map((kind) => kind.name) as [string, ...string[]];

export const BriefInput = Schema.Struct({
  markdown: Schema.String.annotate({
    description: `The brief in Markdown, at most ${String(MARKDOWN_MAX)} characters: short sections, every fact from a record you cite, questions labelled as questions. No links or images.`,
  }).check(Schema.isMinLength(1), Schema.isMaxLength(MARKDOWN_MAX)),
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
      description: `Every saved record the brief's facts come from, 1 to ${String(CITED_MAX)}.`,
    })
    .check(Schema.isMinLength(1), Schema.isMaxLength(CITED_MAX)),
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
  for (const [index, cited] of input.cited.entries()) {
    const kind = kindNamed(cited.kind) as Kind;
    const row = await recordOf(trx, kind, where.personId, cited.id);
    const wrong = !row
      ? `No ${kind.noun} with this id is saved in this person's record. Cite only saved records you read with get_overview or get_records.`
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

  const versions = await recordVersions(trx, where.personId, wanted);
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
    line: `Visit brief · ${shownDate(localTime(where.now).slice(0, 10))} · ${String(count)} ${count === 1 ? "record" : "records"} cited`,
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
      from: await sourceOf(query, personId, row),
      changedSince: now.get(`${record.kind}:${record.id}`) !== record.version,
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
 * A cited record as it was when cited: as its version's save left it; with
 * no version, as it was before its first save, or as it is when no save has
 * changed it.
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
  const first = await changes
    .orderBy("o.created_at")
    .orderBy("o.id")
    .executeTakeFirst();
  return first?.before
    ? (JSON.parse(first.before) as Row)
    : recordOf(query, kind, personId, cited.id);
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A record in one line: its label, its date and its state. */
function summary(kind: Kind, row: Row): string {
  const column = kind.fields[kind.dated]?.column ?? kind.dated;
  const date = row[column];
  const state = row["status"];
  return [
    kind.label(row),
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
 * Where a record came from, in words: the report it was read from, or the
 * user's message it rests on.
 */
// TODO(saving draft items): read the record's typed sources (a document
// page, a message; several per record) once records have them.
async function sourceOf(
  query: Kysely<Tables>,
  personId: string,
  row: Row,
): Promise<string> {
  const reportId = row["report_id"];
  if (typeof reportId === "string") {
    const report = await query
      .selectFrom("reports")
      .select(["document_id", "issuer", "collected"])
      .where("person_id", "=", personId)
      .where("id", "=", reportId)
      .executeTakeFirst();
    if (report) {
      const files = await query
        .selectFrom("document_pages")
        .select("file_name")
        .distinct()
        .where("person_id", "=", personId)
        .where("document_id", "=", report.document_id)
        .orderBy("file_name")
        .execute();
      return [
        `${report.issuer ?? "A"} report${report.collected === null ? "" : `, collected ${shownDate(report.collected)}`}`,
        ...files.map((file) => file.file_name),
      ].join(" · ");
    }
  }
  const entryId = row["source_entry_id"];
  if (typeof entryId === "string") {
    const message = await query
      .selectFrom("transcript_entries")
      .select(["text", "created_at"])
      .where("person_id", "=", personId)
      .where("id", "=", entryId)
      .executeTakeFirst();
    if (message) {
      const words =
        message.text.length > WORDS_MAX
          ? `${message.text.slice(0, WORDS_MAX - 1)}…`
          : message.text;
      return `Your message, ${shownDate(localTime(message.created_at).slice(0, 10))}: “${words}”`;
    }
  }
  return "Saved before Rufi kept sources";
}
