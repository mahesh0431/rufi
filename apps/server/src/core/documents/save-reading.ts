// A reading saved whole: a reading agent copies each page into its working
// folder, splits its notes by page itself and calls save_reading once. In
// the call's transaction (the chat's, which keeps the call) Rufi writes what
// a reader's run writes: a reading (`jobs`), its copy of each page with the
// page's bookkeeping (copies.ts), and its normal end (reading.ts), so its
// pages wait to be sorted as an old reader's do. Code reads none of the
// words. It keeps only what must never go wrong: whose document it is, that
// it wasn't deleted first, and that each page is the document's, once. What
// Rufi keeps of the call holds no page text: deleting the document takes its
// words with it. The same call again gets its kept answer.
import { Schema } from "effect";
import type { Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Tables } from "../store/tables.ts";
import { Refusal, type Issue } from "../tools/registry.ts";
import { PageCopy, writeCopy } from "./copies.ts";
import { DELETED_DOCUMENT, ranges } from "./naming.ts";
import { finishIn } from "./reading.ts";

type Trx = Transaction<Tables>;

const Page = Schema.Int.check(Schema.isGreaterThan(0));

export const SaveReadingInput = Schema.Struct({
  document: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ).annotate({ description: "The document you read, by its id." }),
  pages: Schema.Array(
    Schema.Struct({
      page: Page.annotate({
        description:
          "The page's number, as get_documents gives it for this document.",
      }),
      outcome: PageCopy.outcome,
      copy: PageCopy.copy,
      why: PageCopy.why,
    }),
  )
    .check(Schema.isMinLength(1), Schema.isMaxLength(1_000))
    .annotate({
      description:
        "Your copy of each page you read, each page once: the part of your notes for that page.",
    }),
});
export type SaveReadingInput = typeof SaveReadingInput.Type;

/** Whose reading, in which chat, by which call of the AI's. */
export interface SaveReadingScope {
  personId: string;
  chatId: string;
  callId: string;
}

export interface SaveReadingAnswer {
  saved: true;
  /** The reading's id: its copies name it in get_documents. */
  reading: string;
  pages: string;
  unreadable?: string;
  note: string;
}

/**
 * What Rufi keeps of a save_reading call's input, also a refused one's:
 * each page's copy by its length, never its words.
 */
export function keptReading(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const { pages } = input as { pages?: unknown };
  if (!Array.isArray(pages)) return input;
  return {
    ...input,
    pages: pages.map((page: unknown) =>
      typeof page === "object" && page !== null && "copy" in page
        ? {
            ...page,
            copy: `(${String(String(page.copy).length)} characters)`,
          }
        : page,
    ),
  };
}

/**
 * Saves a whole reading in `trx`, as the call says; refused with every
 * problem, and nothing written, when a must-keep fails. The same call again
 * gets the first answer.
 */
export function saveReading(
  now: () => string = () => new Date().toISOString(),
) {
  return async (
    scope: SaveReadingScope,
    input: SaveReadingInput,
    trx: Trx,
  ): Promise<SaveReadingAnswer> => {
    const { personId } = scope;
    const earlier = await trx
      .selectFrom("tool_calls")
      .select("answer")
      .where("person_id", "=", personId)
      .where("chat_id", "=", scope.chatId)
      .where("call_id", "=", scope.callId)
      .where("tool", "=", "save_reading")
      .where("ok", "=", 1)
      .executeTakeFirst();
    if (earlier) {
      return (JSON.parse(earlier.answer) as { result: SaveReadingAnswer })
        .result;
    }

    const document = await trx
      .selectFrom("documents")
      .select(["id", "deleted_at"])
      .where("person_id", "=", personId)
      .where("id", "=", input.document)
      // Unsent, it waits in the chat box: not the AI's yet.
      .where("sent_at", "is not", null)
      .executeTakeFirst();
    if (document?.deleted_at != null) {
      throw new Refusal(
        `The user deleted this document from Rufi, so its reading isn't saved. ${DELETED_DOCUMENT}`,
      );
    }
    if (!document) {
      throw new Refusal(
        "There is no such document for this person: check its id with get_documents.",
      );
    }
    const pages = (
      await trx
        .selectFrom("document_pages")
        .select("position")
        .where("person_id", "=", personId)
        .where("document_id", "=", document.id)
        .where("file_id", "is not", null)
        .orderBy("position")
        .execute()
    ).map((p) => p.position);
    const problems: Issue[] = [];
    const seen = new Map<number, number>();
    for (const [index, { page }] of input.pages.entries()) {
      const at = `pages.${String(index)}.page`;
      if (!pages.includes(page)) {
        problems.push({
          path: at,
          got: JSON.stringify(page),
          fix: `This document has no page ${String(page)}; its pages are ${ranges(pages)}.`,
        });
      } else if (seen.has(page)) {
        problems.push({
          path: at,
          got: JSON.stringify(page),
          fix: `pages.${String(seen.get(page))} already holds page ${String(page)}: give each page once.`,
        });
      } else seen.set(page, index);
    }
    if (problems.length > 0) {
      throw new Refusal(
        "Nothing was saved. Fix these and try again.",
        problems,
      );
    }

    // A reader's run, written whole: running, its copies, then its end.
    const at = now();
    const targets = input.pages.map((p) => p.page);
    const run = {
      jobId: uuid(),
      attempt: 1,
      personId,
      documentId: document.id,
      targets,
    };
    await trx
      .insertInto("jobs")
      .values({
        id: run.jobId,
        person_id: personId,
        kind: "document_read",
        document_id: document.id,
        state: "running",
        attempt: run.attempt,
        targets: JSON.stringify(targets),
        retries: 0,
        started_at: at,
        run_at: at,
        created_at: at,
      })
      .execute();
    for (const { page, ...copy } of input.pages) {
      await writeCopy(trx, run, page, copy, at);
    }
    await finishIn(trx, run, at);

    const unreadable = input.pages
      .filter((p) => p.outcome === "unreadable")
      .map((p) => p.page);
    return {
      saved: true,
      reading: run.jobId,
      pages: ranges(targets),
      ...(unreadable.length > 0 && { unreadable: ranges(unreadable) }),
      note: "Saved. Rufi AI sorts it from here: end with one short line on what you read.",
    };
  };
}
