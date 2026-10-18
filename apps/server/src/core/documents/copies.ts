// The reader's page copies, for a reader that copies each page as Markdown
// (copy-reader.ts) rather than writing entries in its notebook. A copy is
// the page as printed, the reader's marks for what was unclear included,
// stored as it came: code never reads its words. It is known by its file
// page (the person, the file, the page in the file) and its reading's job,
// not by the document the page is in now. Only save_page writes it, through
// `save` here, under the notebook's rules (notebook.ts): for the running
// job's current attempt, a target page, and a page looked at since the
// last compaction. In the same transaction the page's notebook says which
// run saved it last, as for an entry, so a reading resumes, fails and
// finishes by the same rules.
import { Schema } from "effect";
import type { Store } from "../store/database.ts";
import { Refusal } from "../tools/registry.ts";
import { mayWrite, stillRunning, type Run } from "./notebook.ts";
import { ranges } from "./naming.ts";

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

interface SavedCopy {
  outcome: "read" | "nothing_here" | "unreadable";
  copy: string;
  why?: string;
}

export function copies(
  store: Store,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;

  /** This reading's copies of the document's pages, by position. */
  const mine = async (run: Run) =>
    db
      .selectFrom("page_copies as c")
      .innerJoin("document_pages as p", (join) =>
        join
          .onRef("p.person_id", "=", "c.person_id")
          .onRef("p.file_id", "=", "c.file_id")
          .onRef("p.page_in_file", "=", "c.page_in_file"),
      )
      .select(["p.position", "c.outcome", "c.copy", "c.why"])
      .where("c.person_id", "=", run.personId)
      .where("c.job_id", "=", run.jobId)
      .where("p.document_id", "=", run.documentId)
      .orderBy("p.position")
      .execute();

  /** Where the reading stands, as the reader is told after each look and save. */
  const progress = async (run: Run) => {
    const saved = new Set((await mine(run)).map((c) => c.position));
    return {
      saved: ranges([...saved]),
      still_to_save: ranges(run.targets.filter((p) => !saved.has(p))),
    };
  };

  return {
    progress,

    /** The copy this reading saved for page `position`, or null. */
    copy: async (run: Run, position: number): Promise<SavedCopy | null> => {
      const found = (await mine(run)).find((c) => c.position === position);
      if (!found) return null;
      return {
        outcome: found.outcome as SavedCopy["outcome"],
        copy: found.copy,
        ...(found.why !== null && { why: found.why }),
      };
    },

    /**
     * Writes this reading's copy of page `position`, replacing the one an
     * earlier save of this reading wrote, in one transaction with the
     * page's notebook: the run that saved it, and no entry. Refused, with
     * nothing written, as notebook.save refuses.
     */
    save: async (run: Run, position: number, saved: SavedCopy) => {
      mayWrite(run, position);
      await db.transaction().execute(async (trx) => {
        await stillRunning(trx, run);
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
        const at = now();
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
      });
      return progress(run);
    },
  };
}

export type Copies = ReturnType<typeof copies>;
