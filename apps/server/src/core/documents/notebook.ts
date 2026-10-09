// The reader's notebook: one entry per page of a document, and one note for
// the whole document, kept in the database while a reading runs, so neither
// a compaction nor a crash loses the work. Only save_page writes it, through
// `save` here: the page's entry and the note together, for the running job's
// current run, only for that job's target pages, and only for a page the run
// has looked at since its last compaction. A refusal changes nothing.
import { Schema } from "effect";
import type { Store } from "../store/database.ts";
import { Refusal } from "../tools/registry.ts";

const Text = (max: number, description: string) =>
  Schema.String.annotate({ description }).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
  );

const Printed = (description: string) =>
  Schema.optionalKey(Text(200, `${description}, exactly as printed.`));

/** A date on the page with the words printed next to it. */
const PrintedDate = Schema.Struct({
  label: Text(100, "The words printed with the date: 'Collected', 'Reported'."),
  date: Text(100, "The date exactly as printed: '14/08/2026 08:10'."),
});

/** One result read from a page, in Rufi's result fields, as printed. */
const Item = Schema.Struct({
  test_name: Text(200, "The test's name, exactly as printed."),
  value_text: Text(
    100,
    "The value exactly as printed: '<5', '4,6', 'Negative'.",
  ),
  comparator: Schema.optionalKey(
    Schema.Literals(["<", "<=", ">", ">="]).annotate({
      description: "The comparator printed before the value, if any.",
    }),
  ),
  value_number: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "The value as a plain number, when it is one: '4,6' is 4.6.",
    }),
  ),
  unit: Printed("The unit"),
  reference_range: Printed("The reference range"),
  flag_text: Printed("The flag ('H', 'Low')"),
  context_text: Printed("The method or context ('Fasting', 'Calculated')"),
  date: Schema.optionalKey(PrintedDate),
  column: Schema.optionalKey(
    Schema.Literals(["current", "earlier"]).annotate({
      description: "'earlier' for a column of earlier results.",
    }),
  ),
  from_page: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).annotate({
      description:
        "The page another fact of this item came from, such as its date on page 1.",
    }),
  ),
  unsure: Schema.optionalKey(
    Text(300, "Why you aren't sure of this item; leave it out when you are."),
  ),
});

/** A page's entry, as the reader saves it with save_page. */
export const Entry = Schema.Struct({
  outcome: Schema.Literals(["read", "nothing_here", "unreadable"]).annotate({
    description:
      "read: you read the page (it may have no results); nothing_here: a blank or empty page; unreadable: you couldn't read it (say why).",
  }),
  why: Schema.optionalKey(Text(300, "Why the page is unreadable.")),
  facts: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.optionalKey(
        Schema.Literals(["lab_report", "prescription", "letter", "other"]),
      ),
      dates: Schema.optionalKey(Schema.Array(PrintedDate)),
      issuer: Printed("The lab or clinic"),
      name: Printed("The patient's name on the page"),
      report_number: Printed("The report number"),
      report_status: Printed("The report's status ('Final', 'Amended')"),
    }),
  ),
  rows_seen: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "How many result rows you see on this page.",
    }),
  ),
  items: Schema.Array(Item),
  issues: Schema.optionalKey(
    Schema.Array(
      Text(
        300,
        "Something that needs the person: another name, an unclear date.",
      ),
    ),
  ),
});
export type Entry = typeof Entry.Type;

/** The note for the whole document, written again whole when it changes. */
export const Note = Text(2_000, "Your one short note for the whole document.");

/**
 * One run of a job: the reader thread Rufi started for it, bound by code to
 * the person, the document and the job's current attempt.
 */
export interface Run {
  jobId: string;
  attempt: number;
  personId: string;
  documentId: string;
  /** The pages this job reads, by position. */
  targets: readonly number[];
  /** Pages looked at with get_page since the run began or last compacted. */
  lookedAt: Set<number>;
  /** Set before the reading finishes: nothing more is written. */
  closed: boolean;
}

/** Pages as "1–4, 6". */
const ranges = (positions: readonly number[]) => {
  const parts: string[] = [];
  for (const p of [...positions].sort((a, b) => a - b)) {
    const last = parts.at(-1);
    const end = last === undefined ? undefined : Number(last.split("–").at(-1));
    if (last !== undefined && end === p - 1) {
      parts[parts.length - 1] = `${last.split("–")[0] ?? ""}–${String(p)}`;
    } else parts.push(String(p));
  }
  return parts.join(", ");
};

export function notebook(
  store: Store,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;

  /** Where the reading stands, as the reader is told after each look and save. */
  const progress = async (run: Run) => {
    const rows = await db
      .selectFrom("document_pages")
      .select(["position", "entry_job_id"])
      .where("person_id", "=", run.personId)
      .where("document_id", "=", run.documentId)
      .where("entry", "is not", null)
      .execute();
    const mine = new Set(
      rows.filter((r) => r.entry_job_id === run.jobId).map((r) => r.position),
    );
    const note = await db
      .selectFrom("documents")
      .select("reader_note")
      .where("person_id", "=", run.personId)
      .where("id", "=", run.documentId)
      .executeTakeFirst();
    return {
      saved: ranges(rows.map((r) => r.position)),
      still_to_save: ranges(run.targets.filter((p) => !mine.has(p))),
      note: note?.reader_note ?? null,
    };
  };

  return {
    progress,

    /** The page's current entry, or null when it has none. */
    entry: async (run: Run, position: number): Promise<Entry | null> => {
      const row = await db
        .selectFrom("document_pages")
        .select("entry")
        .where("person_id", "=", run.personId)
        .where("document_id", "=", run.documentId)
        .where("position", "=", position)
        .executeTakeFirst();
      return row?.entry ? (JSON.parse(row.entry) as Entry) : null;
    },

    /**
     * Writes page `position`'s entry, replacing an earlier one, and the note
     * when given (left out, the note stays as it was), in one transaction.
     * Refused, with nothing written: a closed run, a page outside the
     * document or the job's targets, a page not looked at in this run, and a
     * job that isn't running this attempt any more.
     */
    save: async (
      run: Run,
      position: number,
      entry: Entry,
      note: string | undefined,
    ) => {
      if (run.closed)
        throw new Refusal("This reading has ended; nothing more is saved.");
      if (!run.targets.includes(position)) {
        throw new Refusal(
          `Page ${String(position)} isn't one of the pages this reading saves (${ranges(run.targets)}).`,
        );
      }
      if (!run.lookedAt.has(position)) {
        throw new Refusal(
          `Look at page ${String(position)} with get_page first, then save it.`,
        );
      }
      await db.transaction().execute(async (trx) => {
        const job = await trx
          .selectFrom("jobs")
          .select(["state", "attempt"])
          .where("person_id", "=", run.personId)
          .where("id", "=", run.jobId)
          .where("document_id", "=", run.documentId)
          .executeTakeFirst();
        if (job?.state !== "running" || job.attempt !== run.attempt) {
          throw new Refusal(
            "This reading isn't running any more; nothing more is saved.",
          );
        }
        const written = await trx
          .updateTable("document_pages")
          .set({
            entry: JSON.stringify(entry),
            entry_job_id: run.jobId,
            entry_at: now(),
          })
          .where("person_id", "=", run.personId)
          .where("document_id", "=", run.documentId)
          .where("position", "=", position)
          .executeTakeFirst();
        if (written.numUpdatedRows !== 1n) {
          throw new Refusal(`This document has no page ${String(position)}.`);
        }
        if (note !== undefined) {
          await trx
            .updateTable("documents")
            .set({ reader_note: note })
            .where("person_id", "=", run.personId)
            .where("id", "=", run.documentId)
            .execute();
        }
      });
      return progress(run);
    },
  };
}

export type Notebook = ReturnType<typeof notebook>;
