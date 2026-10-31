// A reader's page copies. A copy is the page as printed, the reader's marks
// for what was unclear included, stored as it came: code never reads its
// words. It is known by its file page (the person, the file, the page in
// the file) and its reading's job, not by the document the page is in now.
// save_reading writes a whole reading's at once (save-reading.ts); in the
// same transaction the page's notebook says which reading saved it last.
import { Schema } from "effect";
import type { Transaction } from "kysely";
import type { Tables } from "../store/tables.ts";
import { Refusal } from "../tools/registry.ts";

/** What the reader saves for a page: how the copy went, and the copy. */
export const PageCopy = {
  outcome: Schema.Literals(["read", "nothing_here", "unreadable"]).annotate({
    description:
      "read: you copied the page; nothing_here: a blank page; unreadable: you couldn't read it (say why, and copy what you could).",
  }),
  copy: Schema.String.check(Schema.isMaxLength(100_000)).annotate({
    description:
      "The page as Markdown, exactly as printed, with your marks where something is unclear. HTML tables are allowed where cells are merged.",
  }),
  why: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(300),
    ).annotate({ description: "Why the page is unreadable." }),
  ),
};

export interface SavedCopy {
  outcome: "read" | "nothing_here" | "unreadable";
  copy: string;
  why?: string;
}

/** The reading a copy is saved for: whose, which document, its job and run. */
export interface ReadingRun {
  personId: string;
  documentId: string;
  jobId: string;
  attempt: number;
}

/**
 * In `trx`: a reading's copy of page `position`, replacing the one an
 * earlier save of it wrote, and the page's notebook: the reading that saved
 * it, and no entry. Refused when the document has no such page.
 */
export async function writeCopy(
  trx: Transaction<Tables>,
  run: ReadingRun,
  position: number,
  saved: SavedCopy,
  at: string,
) {
  const page = await trx
    .selectFrom("document_pages")
    .select(["file_id", "page_in_file"])
    .where("person_id", "=", run.personId)
    .where("document_id", "=", run.documentId)
    .where("position", "=", position)
    .executeTakeFirst();
  if (!page?.file_id) {
    throw new Refusal(`This document has no page ${String(position)}.`);
  }
  const values = {
    attempt: run.attempt,
    outcome: saved.outcome,
    copy: saved.copy,
    why: saved.why ?? null,
    saved_at: at,
  };
  await trx
    .insertInto("page_copies")
    .values({
      person_id: run.personId,
      file_id: page.file_id,
      page_in_file: page.page_in_file,
      job_id: run.jobId,
      ...values,
    })
    .onConflict((oc) =>
      oc
        .columns(["person_id", "file_id", "page_in_file", "job_id"])
        .doUpdateSet(values),
    )
    .execute();
  await trx
    .updateTable("document_pages")
    .set({
      entry: null,
      entry_job_id: run.jobId,
      entry_attempt: run.attempt,
      entry_at: at,
      entry_checks: null,
    })
    .where("person_id", "=", run.personId)
    .where("document_id", "=", run.documentId)
    .where("position", "=", position)
    .execute();
}
