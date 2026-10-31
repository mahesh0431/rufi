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
import type { Store } from "../store/database.ts";
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
  /** The document's pages no reading has copied yet. */
  not_read?: string;
  note: string;
}

/** A value Rufi keeps by its length only, never its words. */
function sized(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `(${String(text.length)} characters)`;
}

const fields = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const OUTCOMES: readonly unknown[] = PageCopy.outcome.literals;

/** The names in save_reading's input: a kept path keeps only these. */
const NAMES = new Set(["document", "pages", "page", "outcome", "copy", "why"]);

/**
 * What Rufi keeps of a save_reading call's input, also a refused one's of
 * any shape: the document when it is one of the person's (`known`), and
 * each page's number and outcome; everything else by its length, never its
 * words.
 */
export function keptReading(input: unknown, known: boolean): unknown {
  const { document, pages } = fields(input);
  return {
    document: known ? document : sized(document),
    pages: Array.isArray(pages)
      ? pages.map((entry: unknown) => {
          const { page, outcome, copy, why } = fields(entry);
          return {
            page: typeof page === "number" ? page : sized(page),
            outcome: OUTCOMES.includes(outcome) ? outcome : sized(outcome),
            copy: sized(copy),
            why: sized(why),
          };
        })
      : sized(pages),
  };
}

/**
 * What Rufi keeps of a save_reading call it didn't save, and of its answer:
 * the input as keptReading keeps it, and each problem the answer names with
 * its path in the input's own names and numbers, any other part (an unknown
 * field's name) and what it got by their length. The AI gets the answer
 * whole.
 */
export async function keptUnsaved(
  store: Store | undefined,
  personId: string,
  input: unknown,
  answer: { ok: boolean; text: string },
) {
  const { document } = fields(input);
  const known =
    typeof document === "string" &&
    (await store?.query
      .selectFrom("documents")
      .select("id")
      .where("person_id", "=", personId)
      .where("id", "=", document)
      .executeTakeFirst()) !== undefined;
  const said = JSON.parse(answer.text) as { issues?: Issue[] };
  const path = (at: string) =>
    at
      .split(".")
      .map((part) =>
        // A name of its own, a number, or nothing (the input itself).
        NAMES.has(part) || /^\d*$/.test(part) ? part : sized(part),
      )
      .join(".");
  return {
    input: keptReading(input, known),
    answer: {
      ok: answer.ok,
      text: said.issues
        ? JSON.stringify({
            ...said,
            issues: said.issues.map((issue) => ({
              ...issue,
              path: path(issue.path),
              got: sized(issue.got),
            })),
          })
        : answer.text,
    },
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
    const rows = await trx
      .selectFrom("document_pages as p")
      .select([
        "p.position",
        (eb) =>
          eb
            .exists(
              eb
                .selectFrom("page_copies as c")
                .innerJoin("jobs as j", (join) =>
                  join
                    .onRef("j.person_id", "=", "c.person_id")
                    .onRef("j.id", "=", "c.job_id"),
                )
                .select("c.job_id")
                .whereRef("c.person_id", "=", "p.person_id")
                .whereRef("c.file_id", "=", "p.file_id")
                .whereRef("c.page_in_file", "=", "p.page_in_file")
                // A finished reading's copy, as sorting counts it.
                .where("j.state", "=", "done"),
            )
            .as("copied"),
      ])
      .where("p.person_id", "=", personId)
      .where("p.document_id", "=", document.id)
      .where("p.file_id", "is not", null)
      .orderBy("p.position")
      .execute();
    const pages = rows.map((p) => p.position);
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

    // A reader's run, written whole: running, its copies, then its end. The
    // document's pages no finished reading has copied are its pages too, so
    // they show as not looked at, never as read, until a reading saves them.
    const at = now();
    const saved = input.pages.map((p) => p.page);
    const missing = rows
      .filter((p) => !p.copied && !saved.includes(p.position))
      .map((p) => p.position);
    const targets = [...saved, ...missing].sort((a, b) => a - b);
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
      pages: ranges(saved),
      ...(unreadable.length > 0 && { unreadable: ranges(unreadable) }),
      ...(missing.length > 0 && { not_read: ranges(missing) }),
      note:
        missing.length > 0
          ? `Saved. No reading has copied pages ${ranges(missing)} yet: they show as not looked at until one saves them. Rufi AI sorts what you saved; a short line on what you read is a good way to end.`
          : "Saved. Rufi AI sorts it from here; a short line on what you read is a good way to end.",
    };
  };
}
