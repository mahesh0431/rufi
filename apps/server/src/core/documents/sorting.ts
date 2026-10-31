// Sorting an add (docs/adr/0019): Rufi AI reads the reader's page copies,
// splits the add into documents (one per report or paper: its kind, date,
// pages and, for a report, its lab and number) and drafts each result with
// its page, in one sort_documents call. Code decides none of it. It keeps
// only what must never go wrong: whose add it is, that every page ends in
// one document, that a page a saved result cites stays where it is, and
// that a draft names the reading it was drafted from, one with a copy of
// its page (jobs and page_copies, the person's own); it is kept as the
// draft's job_id, so a draft from an older copy than its page's current one
// shows out of date. Rufi AI sorts what its readers saved (save-reading.ts),
// in any of its turns. A sort is written in one transaction
// with its stored tool call, which is its trace: the same call again gets
// its answer.
//
// The add is the document as the person added it, with the documents split
// from it (documents.from_document). Every document of an add shares its
// page positions: a page keeps its place in the add when a split moves it.
// A page is not sorted yet while its current copy (the one from its latest
// finished reading) isn't (page_copies.sorted_at). A sort marks the pages
// it names; how much of an add to sort at once is Rufi AI's call.
import { Schema } from "effect";
import { sql, type Kysely, type Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";
import { Refusal, type Issue } from "../tools/registry.ts";
import { ranges } from "./naming.ts";

type Trx = Transaction<Tables>;
type Db = Kysely<Tables> | Trx;

const Text = (max: number, description: string) =>
  Schema.String.annotate({ description }).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
  );

const Printed = (description: string) =>
  Schema.optionalKey(Text(200, `${description}, exactly as printed.`));

const Id = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
);

const Page = Schema.Int.check(Schema.isGreaterThan(0));

/** A date at its precision: YYYY, YYYY-MM or YYYY-MM-DD. */
const PrecisionDate = Schema.String.check(
  Schema.isPattern(/^\d{4}(-\d{2}(-\d{2})?)?$/),
);

/** A date as printed on the page, with its label. */
const PrintedDate = Schema.Struct({
  label: Text(100, "The words printed with the date: 'Collected', 'Date'."),
  date: Text(100, "The date exactly as printed: '14/08/2026 09:20'."),
  iso: Schema.optionalKey(
    PrecisionDate.annotate({
      description:
        "The same date as YYYY-MM-DD (or YYYY-MM, YYYY), when the order of day and month is certain; leave it out when it isn't.",
    }),
  ),
});

/** One document of the add, as Rufi AI sorts it. */
const SortedDocument = Schema.Struct({
  id: Schema.optionalKey(
    Id.annotate({
      description:
        "Which of the add's documents this is (its id from get_documents; the add's own id for its first document), each named once. Leave it out to make a new document, such as a page read again that is a paper of its own.",
    }),
  ),
  pages: Schema.Array(Page)
    .check(Schema.isMinLength(1), Schema.isMaxLength(1_000))
    .annotate({
      description:
        "The pages it gets, by their number in the add (as get_documents gives them). A named document keeps the pages it has that you don't give elsewhere.",
    }),
  kind: Schema.optionalKey(
    Schema.Literals(["lab_report", "prescription", "letter", "other"]).annotate(
      {
        description:
          "Its kind: needed for a new document; for a named one, left out it stays as it is.",
      },
    ),
  ),
  date: Schema.optionalKey(
    PrecisionDate.annotate({
      description:
        "Its date at the precision known (YYYY-MM-DD, YYYY-MM or YYYY): a report's collection date, a prescription's or letter's own date. Leave it out when none is printed, or to keep a named document's.",
    }),
  ),
  lab: Printed(
    "A report's lab or clinic (left out, a named document keeps its own)",
  ),
  report_number: Printed(
    "A report's number (left out, a named document keeps its own)",
  ),
});

/** One draft: a current result or a measurement, as printed on its page. */
const Draft = Schema.Struct({
  page: Page.annotate({ description: "The page it is printed on." }),
  reading: Id.annotate({
    description:
      "The reading of the page's copy you drafted it from: that copy's reading in get_documents.",
  }),
  test_name: Text(200, "The test's or measurement's name, exactly as printed."),
  value_text: Text(
    100,
    "The value as the page's copy prints it, as it would be saved: '<0.5', '1,25'; as characters, not the copy's HTML or Markdown ('<0.5', not '&lt;0.5'). Where the reader marked a digit unclear ('1[0?]4'), your reading ('104'), with worth_a_look saying why.",
  ),
  comparator: Schema.optionalKey(
    Schema.Literals(["<", "<=", ">", ">="]).annotate({
      description: "The comparator printed before the value, if any.",
    }),
  ),
  value_number: Schema.optionalKey(
    Schema.Finite.annotate({
      description:
        "The value as a plain number, when it is one: '1,25' is 1.25.",
    }),
  ),
  unit: Printed("The unit"),
  reference_range: Printed("The reference range"),
  flag_text: Printed("The flag ('H', 'Low')"),
  context_text: Printed("The method or context ('Fasting', 'Calculated')"),
  date: Schema.optionalKey(
    PrintedDate.annotate({
      description:
        "When the sample was taken or the measurement made, as printed: its report's collection date, or the visit's date.",
    }),
  ),
  quote: Text(
    300,
    'The words it comes from, for the person to see beside it: its row\'s words as printed, cells separated by " | ", without the copy\'s HTML or Markdown ("TSH | ~~5.3 H~~ [handwritten: 5.8] | mIU/L", not "<td>TSH</td><td><s>5.3 H</s>…"), with the reader\'s marks kept.',
  ),
  worth_a_look: Schema.optionalKey(
    Text(
      300,
      "Why the person should look at it, in a few plain words: a digit is unclear, written by hand, crossed out, far from earlier results. Leave it out when it is plain.",
    ),
  ),
});

export const SortInput = Schema.Struct({
  document: Id.annotate({
    description: "A document of the add, from get_documents.",
  }),
  documents: Schema.Array(SortedDocument)
    .check(Schema.isMinLength(1), Schema.isMaxLength(500))
    .annotate({
      description:
        "The documents of the pages you sort now, each with its pages. Pages you leave out that aren't sorted yet wait for a later call.",
    }),
  drafts: Schema.Array(Draft).check(Schema.isMaxLength(5_000)).annotate({
    description:
      "The drafts of the pages in documents, in page order and in the order printed. They replace those pages' drafts the person hasn't touched.",
  }),
});
export type SortInput = typeof SortInput.Type;

/** Whose sort, in which chat, by which call of the AI's. */
export interface SortScope {
  personId: string;
  chatId: string;
  /** The agent's id of the turn the call came in. */
  agentTurnId: string;
  callId: string;
}

export interface SortAnswer {
  sorted: true;
  documents: {
    id: string;
    kind: string;
    date: string | null;
    pages: string;
    drafts: number;
    worth_a_look: number;
    /** Drafts from an older copy of their page than its current one. */
    out_of_date?: number;
  }[];
  note: string;
}

/** A page of an add as the sort sees it. */
interface AddPage {
  documentId: string;
  position: number;
  fileId: string;
  pageInFile: number;
  fileName: string;
  /** Its current copy: from its latest finished reading. */
  copy:
    | { jobId: string; outcome: string; text: string; sorted: boolean }
    | undefined;
}

/** The add a document belongs to: the document as added. */
export async function addOf(
  db: Db,
  personId: string,
  documentId: string,
): Promise<
  | {
      id: string;
      addedAt: string;
      addedFrom: string;
      /** When a message sent it; null while it waits unsent in the box. */
      sentAt: string | null;
      deleted: boolean;
    }
  | undefined
> {
  const document = await db
    .selectFrom("documents")
    .select(["id", "from_document"])
    .where("person_id", "=", personId)
    .where("id", "=", documentId)
    .executeTakeFirst();
  if (!document) return undefined;
  const add = await db
    .selectFrom("documents")
    .select(["id", "added_at", "added_from", "sent_at", "deleted_at"])
    .where("person_id", "=", personId)
    .where("id", "=", document.from_document ?? document.id)
    .executeTakeFirstOrThrow();
  return {
    id: add.id,
    addedAt: add.added_at,
    addedFrom: add.added_from,
    sentAt: add.sent_at,
    deleted: add.deleted_at !== null,
  };
}

/** The live documents of an add, the add first if it is live. */
export async function documentsOf(db: Db, personId: string, addId: string) {
  return db
    .selectFrom("documents")
    .select([
      "id",
      "kind",
      "date",
      "issuer",
      "report_number",
      "version",
      "from_document",
    ])
    .where("person_id", "=", personId)
    .where((eb) =>
      eb.or([eb("id", "=", addId), eb("from_document", "=", addId)]),
    )
    .where("deleted_at", "is", null)
    .orderBy("from_document")
    .orderBy("id")
    .execute();
}

/**
 * Each live page of the add's documents, with its current copy (the copy
 * from its latest finished reading) and whether that reading was sorted.
 * `text` says whether the copies' words are wanted.
 */
export async function pagesOf(
  db: Db,
  personId: string,
  documentIds: readonly string[],
  text = true,
): Promise<AddPage[]> {
  if (documentIds.length === 0) return [];
  const pages = await db
    .selectFrom("document_pages")
    .select(["document_id", "position", "file_id", "page_in_file", "file_name"])
    .where("person_id", "=", personId)
    .where("document_id", "in", documentIds)
    .where("file_id", "is not", null)
    .orderBy("position")
    .execute();
  const copies = await db
    .selectFrom("page_copies as c")
    .innerJoin("jobs as j", (join) =>
      join
        .onRef("j.person_id", "=", "c.person_id")
        .onRef("j.id", "=", "c.job_id"),
    )
    .innerJoin("document_pages as p", (join) =>
      join
        .onRef("p.person_id", "=", "c.person_id")
        .onRef("p.file_id", "=", "c.file_id")
        .onRef("p.page_in_file", "=", "c.page_in_file"),
    )
    .select([
      "c.file_id",
      "c.page_in_file",
      "c.job_id",
      "c.outcome",
      "c.sorted_at",
      "j.created_at",
    ])
    .$if(text, (q) => q.select("c.copy"))
    .where("c.person_id", "=", personId)
    .where("p.document_id", "in", documentIds)
    .where("j.state", "=", "done")
    .orderBy("j.created_at")
    .orderBy("j.id")
    .execute();
  const current = new Map<string, (typeof copies)[number]>();
  for (const copy of copies) {
    current.set(`${copy.file_id}:${String(copy.page_in_file)}`, copy);
  }
  return pages.map((p) => {
    const copy = current.get(`${p.file_id ?? ""}:${String(p.page_in_file)}`);
    return {
      documentId: p.document_id,
      position: p.position,
      fileId: p.file_id ?? "",
      pageInFile: p.page_in_file,
      fileName: p.file_name,
      copy: copy && {
        jobId: copy.job_id,
        outcome: copy.outcome,
        text: (copy as { copy?: string }).copy ?? "",
        sorted: copy.sorted_at !== null,
      },
    };
  });
}

/**
 * Where each of the person's live documents is in its add: its pages, the
 * add's number of pages, and "pages 3–4 of 5" when it isn't the whole add.
 */
export async function placesOf(
  db: Db,
  personId: string,
): Promise<Map<string, { positions: number[]; of: number; words: string }>> {
  const documents = await db
    .selectFrom("documents")
    .select(["id", "from_document", "deleted_at"])
    .where("person_id", "=", personId)
    .execute();
  const addOf = new Map(documents.map((d) => [d.id, d.from_document ?? d.id]));
  const pages = await db
    .selectFrom("document_pages")
    .select(["document_id", "position"])
    .where("person_id", "=", personId)
    .orderBy("position")
    .execute();
  const counts = new Map<string, number>();
  for (const page of pages) {
    const add = addOf.get(page.document_id) ?? page.document_id;
    counts.set(add, (counts.get(add) ?? 0) + 1);
  }
  const places = new Map<
    string,
    { positions: number[]; of: number; words: string }
  >();
  for (const document of documents) {
    if (document.deleted_at !== null) continue;
    const positions = pages
      .filter((p) => p.document_id === document.id)
      .map((p) => p.position);
    const of = counts.get(addOf.get(document.id) ?? document.id) ?? 0;
    places.set(document.id, {
      positions,
      of,
      words: pagesWords(positions, of),
    });
  }
  return places;
}

/** Pages whose copy waits for Rufi AI: copied by a reading not sorted yet. */
export const notSorted = (pages: readonly AddPage[]) =>
  pages.filter((p) => p.copy !== undefined && !p.copy.sorted);

export function sorting(
  store: Store,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;

  /**
   * Splits the add and writes its drafts, as the call says, in one
   * transaction; refused with every problem, and nothing written, when a
   * must-keep fails. The same call again gets the first answer.
   */
  const sort = async (
    scope: SortScope,
    input: SortInput,
    within?: Trx,
  ): Promise<SortAnswer> =>
    within
      ? sortIn(within, scope, input)
      : db.transaction().execute((trx) => sortIn(trx, scope, input));

  const sortIn = async (
    trx: Trx,
    scope: SortScope,
    input: SortInput,
  ): Promise<SortAnswer> => {
    const { personId } = scope;
    // The same call again: its kept answer.
    const earlier = await trx
      .selectFrom("tool_calls")
      .select("answer")
      .where("person_id", "=", personId)
      .where("chat_id", "=", scope.chatId)
      .where("call_id", "=", scope.callId)
      .where("tool", "=", "sort_documents")
      .where("ok", "=", 1)
      .executeTakeFirst();
    if (earlier) {
      return (JSON.parse(earlier.answer) as { result: SortAnswer }).result;
    }

    // Pages move between documents below; their drafts move with them in
    // the same transaction, and the links are checked at its end.
    await sql`PRAGMA defer_foreign_keys = ON`.execute(trx);

    const add = await addOf(trx, personId, input.document);
    const given = await trx
      .selectFrom("documents")
      .select("deleted_at")
      .where("person_id", "=", personId)
      .where("id", "=", input.document)
      .executeTakeFirst();
    // Unsent, it waits in the chat box: not the AI's yet.
    if (!add || given?.deleted_at !== null || add.sentAt === null) {
      throw new Refusal(
        "There is no such document for this person: read the list with get_documents for its id.",
      );
    }
    const reading = await trx
      .selectFrom("jobs as j")
      .innerJoin("documents as d", (join) =>
        join
          .onRef("d.person_id", "=", "j.person_id")
          .onRef("d.id", "=", "j.document_id"),
      )
      .select("j.id")
      .where("j.person_id", "=", personId)
      .where("j.state", "in", ["queued", "running"])
      .where((eb) =>
        eb.or([eb("d.id", "=", add.id), eb("d.from_document", "=", add.id)]),
      )
      .executeTakeFirst();
    if (reading) {
      throw new Refusal(
        "The reader is reading pages of this add now. Sort it once its reading has ended.",
      );
    }

    const documents = await documentsOf(trx, personId, add.id);
    const pages = await pagesOf(
      trx,
      personId,
      documents.map((d) => d.id),
    );
    const waiting = notSorted(pages);
    const problems: Issue[] = [];
    const problem = (path: string, got: unknown, fix: string) =>
      problems.push({ path, got: JSON.stringify(got), fix });

    // Every page named once, of this add.
    const named = new Map<number, number>();
    for (const [index, group] of input.documents.entries()) {
      for (const page of group.pages) {
        const at = `documents.${String(index)}.pages`;
        if (!pages.some((p) => p.position === page)) {
          problem(
            at,
            page,
            `This add has no page ${String(page)}; its pages are ${ranges(pages.map((p) => p.position))}.`,
          );
        } else if (named.has(page)) {
          problem(
            at,
            page,
            `documents.${String(named.get(page))} already holds page ${String(page)}: every page goes in one document.`,
          );
        } else named.set(page, index);
      }
    }
    if (waiting.length === 0 && named.size === 0) {
      throw new Refusal("Nothing in this add is left to sort.");
    }

    // Each group is the document it names, or a new one.
    const holder = new Map(pages.map((p) => [p.position, p.documentId]));
    const claimed = new Map<string, number>();
    for (const [index, group] of input.documents.entries()) {
      const at = `documents.${String(index)}`;
      if (group.id === undefined) {
        if (group.kind === undefined) {
          problem(
            `${at}.kind`,
            undefined,
            "A new document needs its kind. To add these pages to one of the add's documents, give its id instead.",
          );
        }
        continue;
      }
      const document = documents.find((d) => d.id === group.id);
      if (!document) {
        problem(
          `${at}.id`,
          group.id,
          `This add has no document with this id; its documents are ${documents.map((d) => d.id).join(", ")}. Leave id out to make a new document.`,
        );
        continue;
      }
      const twice = claimed.get(group.id);
      if (twice !== undefined) {
        problem(
          `${at}.id`,
          group.id,
          `documents.${String(twice)} already names this document: name each document once.`,
        );
        continue;
      }
      claimed.set(group.id, index);
    }
    // The add's own document stays: it holds the add's readings.
    if (
      !claimed.has(add.id) &&
      pages.some((p) => p.documentId === add.id) &&
      pages
        .filter((p) => p.documentId === add.id)
        .every((p) => named.has(p.position))
    ) {
      problem(
        "documents",
        add.id,
        `Every page of the add's first document moves to a new one. Name it (id ${add.id}) for one of the documents instead.`,
      );
    }
    const ids = input.documents.map((group) => group.id ?? uuid());

    // A page a saved result cites stays in its document.
    const moves = [...named].flatMap(([page, index]) => {
      const from = holder.get(page);
      const to = ids[index];
      return from !== undefined && from !== to ? [{ page, from, index }] : [];
    });
    if (moves.length > 0) {
      const cited = await trx
        .selectFrom("record_sources")
        .select(["document_id", "page"])
        .where("person_id", "=", personId)
        .where("type", "=", "document_page")
        .where("document_id", "in", [...new Set(moves.map((m) => m.from))])
        .execute();
      for (const move of moves) {
        if (
          cited.some((c) => c.document_id === move.from && c.page === move.page)
        ) {
          problem(
            `documents.${String(move.index)}.pages`,
            move.page,
            `Page ${String(move.page)} is a source of results saved in the record, so it stays in the document it is in: sort it there, or tell the user it can't move.`,
          );
        }
      }
    }

    // Each draft on a named page that has a copy, naming a reading of the
    // person's with a copy of that page.
    const readings = [...new Set(input.drafts.map((d) => d.reading))];
    const copied =
      readings.length === 0
        ? []
        : await trx
            .selectFrom("page_copies")
            .select(["job_id", "file_id", "page_in_file"])
            .where("person_id", "=", personId)
            .where("job_id", "in", readings)
            .execute();
    for (const [index, draft] of input.drafts.entries()) {
      const at = `drafts.${String(index)}`;
      const page = pages.find((p) => p.position === draft.page);
      if (!named.has(draft.page)) {
        problem(
          `${at}.page`,
          draft.page,
          `Page ${String(draft.page)} isn't in any of the documents of this call: a draft goes with its page's document.`,
        );
      } else if (!page?.copy) {
        problem(
          `${at}.page`,
          draft.page,
          `Page ${String(draft.page)} has no copy from the reader, so nothing can be drafted from it. Look at it with get_documents and tell the user.`,
        );
      } else if (
        !copied.some(
          (c) =>
            c.job_id === draft.reading &&
            c.file_id === page.fileId &&
            c.page_in_file === page.pageInFile,
        )
      ) {
        problem(
          `${at}.reading`,
          draft.reading,
          `This reading has no copy of page ${String(draft.page)}: name the reading of the copy you drafted it from, as get_documents gives it.`,
        );
      }
    }
    if (problems.length > 0) {
      throw new Refusal(
        "Nothing was sorted. Fix these and try again.",
        problems,
      );
    }

    // The documents: the named ones with the fields given, the others new.
    const at = now();
    for (const [index, group] of input.documents.entries()) {
      const id = ids[index] ?? "";
      const given = {
        ...(group.kind !== undefined && { kind: group.kind }),
        ...(group.date !== undefined && { date: group.date }),
        ...(group.lab !== undefined && { issuer: group.lab }),
        ...(group.report_number !== undefined && {
          report_number: group.report_number,
        }),
      };
      if (group.id !== undefined) {
        await trx
          .updateTable("documents")
          .set((eb) => ({ ...given, version: eb("version", "+", 1) }))
          .where("person_id", "=", personId)
          .where("id", "=", id)
          .execute();
      } else {
        await trx
          .insertInto("documents")
          .values({
            id,
            person_id: personId,
            added_at: add.addedAt,
            added_from: add.addedFrom,
            // Sent with the add it came from.
            sent_at: add.sentAt,
            kind: group.kind ?? "other",
            date: null,
            issuer: null,
            report_number: null,
            ...given,
            version: 1,
            from_document: add.id,
          })
          .execute();
      }
    }

    // Pages that move go with their drafts the person kept (fixed, set
    // aside); untouched drafts of every named page give way to the call's.
    for (const [page, index] of named) {
      const from = holder.get(page) ?? "";
      const to = ids[index] ?? "";
      await trx
        .deleteFrom("draft_items")
        .where("person_id", "=", personId)
        .where("document_id", "=", from)
        .where("page", "=", page)
        .where("status", "=", "pending")
        .where("version", "=", 1)
        .execute();
      if (from === to) continue;
      await trx
        .updateTable("document_pages")
        .set({ document_id: to })
        .where("person_id", "=", personId)
        .where("document_id", "=", from)
        .where("position", "=", page)
        .execute();
      await trx
        .updateTable("draft_items")
        .set((eb) => ({ document_id: to, version: eb("version", "+", 1) }))
        .where("person_id", "=", personId)
        .where("document_id", "=", from)
        .where("page", "=", page)
        .execute();
      await trx
        .updateTable("documents")
        .set((eb) => ({ version: eb("version", "+", 1) }))
        .where("person_id", "=", personId)
        .where("id", "=", from)
        .where("id", "not in", ids)
        .execute();
    }
    // A document of the add left with no page is gone: its pages and their
    // drafts are in the others now.
    for (const document of documents) {
      if (ids.includes(document.id)) continue;
      const still = await trx
        .selectFrom("document_pages")
        .select("position")
        .where("person_id", "=", personId)
        .where("document_id", "=", document.id)
        .executeTakeFirst();
      if (!still) {
        await trx
          .updateTable("documents")
          .set({ deleted_at: at })
          .where("person_id", "=", personId)
          .where("id", "=", document.id)
          .execute();
      }
    }

    const seq = new Map<number, number>();
    for (const draft of input.drafts) {
      const index = named.get(draft.page) ?? 0;
      const next =
        seq.get(draft.page) ??
        (
          await trx
            .selectFrom("draft_items")
            .select((eb) => eb.fn.max<number | null>("seq").as("last"))
            .where("person_id", "=", personId)
            .where("page", "=", draft.page)
            .where("document_id", "in", ids)
            .executeTakeFirst()
        )?.last ??
        0;
      seq.set(draft.page, next + 1);
      const { page: _page, quote, worth_a_look, ...fields } = draft;
      await trx
        .insertInto("draft_items")
        .values({
          id: uuid(),
          person_id: personId,
          document_id: ids[index] ?? "",
          page: draft.page,
          seq: next + 1,
          job_id: draft.reading,
          kind: "lab_result",
          version: 1,
          status: "pending",
          fields: JSON.stringify(fields),
          original: JSON.stringify(fields),
          unsure: JSON.stringify(
            worth_a_look === undefined ? [] : [worth_a_look],
          ),
          quote,
          created_at: at,
        })
        .execute();
    }

    // The pages sorted now: the waiting ones the call names.
    for (const page of waiting) {
      if (!page.copy || !named.has(page.position)) continue;
      await trx
        .updateTable("page_copies")
        .set({ sorted_at: at })
        .where("person_id", "=", personId)
        .where("file_id", "=", page.fileId)
        .where("page_in_file", "=", page.pageInFile)
        .where("job_id", "=", page.copy.jobId)
        .execute();
    }
    // Each document as it is now, with all its pages.
    const after = await documentsOf(trx, personId, add.id);
    const held = await trx
      .selectFrom("document_pages")
      .select(["document_id", "position"])
      .where("person_id", "=", personId)
      .where("document_id", "in", ids)
      .execute();
    const old = (draft: SortInput["drafts"][number]) =>
      pages.find((p) => p.position === draft.page)?.copy?.jobId !==
      draft.reading;
    const answer: SortAnswer = {
      sorted: true,
      documents: input.documents.map((_, index) => {
        const id = ids[index] ?? "";
        const document = after.find((d) => d.id === id);
        const drafts = input.drafts.filter((d) => named.get(d.page) === index);
        const outOfDate = drafts.filter(old).length;
        return {
          id,
          kind: document?.kind ?? "other",
          date: document?.date ?? null,
          pages: ranges(
            held.filter((p) => p.document_id === id).map((p) => p.position),
          ),
          drafts: drafts.length,
          worth_a_look: drafts.filter((d) => d.worth_a_look !== undefined)
            .length,
          ...(outOfDate > 0 && { out_of_date: outOfDate }),
        };
      }),
      note: `Sorted. Nothing is saved: the drafts wait for the user on each document's page.${input.drafts.some(old) ? " Drafts counted out_of_date came from an older copy of their page than its current one: they can't be saved. Read the copies again with get_documents and sort those pages again." : ""} Tell the user in a few lines what you found.`,
    };
    return answer;
  };

  return {
    sort,
  };
}

/**
 * The person's live documents whose pages wait for Rufi AI to sort them:
 * their copy comes from a reading it hasn't sorted.
 */
export async function unsorted(db: Db, personId: string): Promise<Set<string>> {
  const documents = await db
    .selectFrom("documents")
    .select("id")
    .where("person_id", "=", personId)
    .where("deleted_at", "is", null)
    .execute();
  return new Set(
    notSorted(
      await pagesOf(
        db,
        personId,
        documents.map((d) => d.id),
        false,
      ),
    ).map((p) => p.documentId),
  );
}

/** "pages 1–2 of 5", "page 5 of 5", or "" for a document that is its whole add. */
function pagesWords(positions: readonly number[], of: number): string {
  if (positions.length === of) return "";
  return `${positions.length === 1 ? "page" : "pages"} ${ranges(positions)} of ${String(of)}`;
}
