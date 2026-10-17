// Sorting an add (docs/adr/0019): Rufi AI reads the reader's page copies,
// splits the add into documents (one per report or paper: its kind, date,
// pages and, for a report, its lab and number) and drafts each result with
// its page, in one sort_documents call. Code decides none of it. It keeps
// only what must never go wrong: whose add it is, that every page ends in
// one document, that a page a saved result cites stays where it is, that a
// Rufi-started turn sorts only the pages its request is for, and the page
// check: a draft's value, as printed, is in its page's copy. A sort is
// written in one transaction, with its request consumed; the stored tool
// call is its trace.
//
// The add is the document as the person added it, with the documents split
// from it (documents.from_document). Every document of an add shares its
// page positions: a page keeps its place in the add when a split moves it.
// A page is not sorted yet while its current copy (the one from its latest
// finished reading) comes from a reading Rufi AI hasn't sorted
// (jobs.sorted_at).
import { Schema } from "effect";
import { sql, type Kysely, type Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import { addRow } from "../chat/queue.ts";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";
import { Refusal, type Issue } from "../tools/registry.ts";
import { documentName, ranges } from "./reading.ts";

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
  pages: Schema.Array(Page)
    .check(Schema.isMinLength(1), Schema.isMaxLength(1_000))
    .annotate({
      description:
        "Its pages, by their number in the add (as get_documents gives them).",
    }),
  kind: Schema.Literals(["lab_report", "prescription", "letter", "other"]),
  date: Schema.optionalKey(
    PrecisionDate.annotate({
      description:
        "Its date at the precision known (YYYY-MM-DD, YYYY-MM or YYYY): a report's collection date, a prescription's or letter's own date. Leave it out when none is printed.",
    }),
  ),
  lab: Printed("A report's lab or clinic"),
  report_number: Printed("A report's number"),
});

/** One draft: a current result or a measurement, as printed on its page. */
const Draft = Schema.Struct({
  page: Page.annotate({ description: "The page it is printed on." }),
  test_name: Text(200, "The test's or measurement's name, exactly as printed."),
  value_text: Text(
    100,
    "The value exactly as in the page's copy, marks included: '<0.5', '1,25', '1[0?]4'. Rufi checks it is in that page's copy.",
  ),
  comparator: Schema.optionalKey(
    Schema.Literals(["<", "<=", ">", ">="]).annotate({
      description: "The comparator printed before the value, if any.",
    }),
  ),
  value_number: Schema.optionalKey(
    Schema.Finite.annotate({
      description:
        "The value as a plain number, when it is one: '1,25' is 1.25. Your reading of a marked digit goes here.",
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
    "The words it comes from, as in the page's copy (its row), for the person to see beside it.",
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
        "The documents the add holds, each with its pages. Every page not sorted yet must be in one of them.",
    }),
  drafts: Schema.Array(Draft)
    .check(Schema.isMaxLength(5_000))
    .annotate({
      description:
        "The drafts of the pages in documents, in page order and in the order printed. They replace those pages' drafts the person hasn't touched.",
    }),
});
export type SortInput = typeof SortInput.Type;

/** Who may sort what: a person's turn their adds; a Rufi turn its request's pages. */
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
  }[];
  note: string;
}

/** HTML entities a copy may hold, as their characters. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  micro: "µ",
  deg: "°",
  plusmn: "±",
  le: "≤",
  ge: "≥",
};

/**
 * Text as the page check compares it: HTML entities as their characters,
 * Markdown escapes and emphasis taken off, tags as a space, spacing made
 * one space. Marks such as [?], [unclear: ...] and ~~...~~ stay.
 */
export function comparable(text: string): string {
  return text
    .normalize("NFC")
    .replace(/<[^<>\n]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      }
      if (name.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/[\s ]+/g, " ")
    .trim();
}

const WORD = /[\p{L}\p{N}]/u;

/**
 * The page check: whether `value` is in `copy`, both made comparable, at
 * word boundaries (not inside a longer number or word). It checks only
 * that the printed value is on the page, not what it means.
 */
export function onPage(value: string, copy: string): boolean {
  const needle = comparable(value);
  if (needle === "") return false;
  const hay = comparable(copy);
  for (
    let at = hay.indexOf(needle);
    at !== -1;
    at = hay.indexOf(needle, at + 1)
  ) {
    const before = hay[at - 1];
    const after = hay[at + needle.length];
    const edge = (c: string | undefined, inner: string | undefined) =>
      c === undefined ||
      !WORD.test(c) ||
      inner === undefined ||
      !WORD.test(inner);
    if (edge(before, needle[0]) && edge(after, needle.at(-1))) return true;
  }
  return false;
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

const KIND_WORDS = {
  lab_report: "lab report",
  prescription: "prescription",
  letter: "letter",
  other: "document",
} as const;

/** The add a document belongs to: the document as added. */
export async function addOf(
  db: Db,
  personId: string,
  documentId: string,
): Promise<
  | { id: string; addedAt: string; addedFrom: string; deleted: boolean }
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
    .select(["id", "added_at", "added_from", "deleted_at"])
    .where("person_id", "=", personId)
    .where("id", "=", document.from_document ?? document.id)
    .executeTakeFirstOrThrow();
  return {
    id: add.id,
    addedAt: add.added_at,
    addedFrom: add.added_from,
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
    .where((eb) => eb.or([eb("id", "=", addId), eb("from_document", "=", addId)]))
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
      "j.sorted_at",
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

/** Waits between a failed sorting turn and the next try. */
export const SORT_WAITS_MS = [30_000, 60_000, 120_000];

/** Rufi's note for the AI that asks for a sort, with the reading's end. */
export function sortNote(about: {
  name: string;
  documentId: string;
  copied: number;
  unreadable: readonly number[];
  notLooked: readonly number[];
}): string {
  return [
    `A document reading finished: ${about.name} (document ${about.documentId}), ${String(about.copied)} ${about.copied === 1 ? "page" : "pages"} copied by the reader, not sorted yet.`,
    ...(about.unreadable.length > 0
      ? [`The reader couldn't read pages ${ranges(about.unreadable)}.`]
      : []),
    ...(about.notLooked.length > 0
      ? [
          `The reader didn't look at pages ${ranges(about.notLooked)}; Retry reads them.`,
        ]
      : []),
    "Sort it now, as the sorting-documents skill says: read its page copies with get_documents, then split it into documents and write its drafts with one sort_documents call. Save nothing. Then tell the user in a few lines what you found and that nothing is saved; if you can't tell something, ask instead.",
  ].join("\n");
}

export function sorting(
  store: Store,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;

  /** The request the Rufi turn `agentTurnId` was handed, if it is a sort. */
  const requestOfTurn = async (
    trx: Trx,
    scope: SortScope,
  ): Promise<
    | { origin: "person" }
    | { origin: "rufi"; request: { id: string; documentId: string } | undefined }
  > => {
    const turn = await trx
      .selectFrom("turns")
      .select(["id", "origin"])
      .where("chat_id", "=", scope.chatId)
      .where("agent_turn_id", "=", scope.agentTurnId)
      .executeTakeFirst();
    if (turn?.origin !== "rufi") return { origin: "person" };
    const request = await trx
      .selectFrom("sort_requests as r")
      .innerJoin("chat_queue as q", (join) =>
        join
          .onRef("q.person_id", "=", "r.person_id")
          .onRef("q.id", "=", "r.queue_id"),
      )
      .select(["r.id", "r.document_id"])
      .where("r.person_id", "=", scope.personId)
      .where("q.turn_id", "=", turn.id)
      .where("r.state", "=", "open")
      .executeTakeFirst();
    return {
      origin: "rufi",
      request: request && { id: request.id, documentId: request.document_id },
    };
  };

  /** Ends the add's other open requests: nothing is left to sort. */
  const closeOthers = async (
    trx: Trx,
    personId: string,
    addId: string,
    keep: string | undefined,
  ) => {
    const open = await trx
      .selectFrom("sort_requests")
      .select(["id", "queue_id"])
      .where("person_id", "=", personId)
      .where("document_id", "=", addId)
      .where("state", "in", ["open", "asked", "failed"])
      .$if(keep !== undefined, (q) => q.where("id", "!=", keep ?? ""))
      .execute();
    for (const request of open) {
      await trx
        .updateTable("sort_requests")
        .set({ state: "void", retry_at: null, ended_at: now() })
        .where("person_id", "=", personId)
        .where("id", "=", request.id)
        .execute();
      if (request.queue_id !== null) {
        await trx
          .updateTable("chat_queue")
          .set({ state: "removed", held: null, updated_at: now() })
          .where("person_id", "=", personId)
          .where("id", "=", request.queue_id)
          .where("state", "=", "waiting")
          .execute();
      }
    }
  };

  /**
   * Splits the add and writes its drafts, as the call says, in one
   * transaction; refused with every problem, and nothing written, when a
   * must-keep fails. The same call again gets the first answer.
   */
  const sort = async (
    scope: SortScope,
    input: SortInput,
  ): Promise<SortAnswer> =>
    db.transaction().execute(async (trx) => {
      const { personId } = scope;
      const earlier = await trx
        .selectFrom("sort_requests")
        .select("answer")
        .where("person_id", "=", personId)
        .where("call_id", "=", scope.callId)
        .executeTakeFirst();
      if (earlier?.answer) return JSON.parse(earlier.answer) as SortAnswer;

      // Pages move between documents below; their drafts move with them in
      // the same transaction, and the links are checked at its end.
      await sql`PRAGMA defer_foreign_keys = ON`.execute(trx);

      const add = await addOf(trx, personId, input.document);
      if (!add || add.deleted) {
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
          "The reader is reading pages of this add now. Sort it once its reading has ended: Rufi asks you then.",
        );
      }
      const turn = await requestOfTurn(trx, scope);
      if (turn.origin === "rufi") {
        if (turn.request?.documentId !== add.id) {
          throw new Refusal(
            "This turn was started by Rufi, not by the user, and it isn't the sort of this add, so nothing can be sorted in it. Explain or ask; the user asks in a message of their own.",
          );
        }
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
        problems.push({ path, got: JSON.stringify(got) ?? "", fix });

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
      const left = waiting.filter((p) => !named.has(p.position));
      if (left.length > 0) {
        problem(
          "documents",
          ranges(left.map((p) => p.position)),
          `Pages ${ranges(left.map((p) => p.position))} aren't sorted yet: put each of them in one of the documents too.`,
        );
      }
      if (turn.origin === "rufi") {
        const placed = [...named.keys()].filter(
          (page) => !waiting.some((p) => p.position === page),
        );
        if (placed.length > 0) {
          problem(
            "documents",
            ranges(placed),
            `Pages ${ranges(placed)} were sorted before. In a turn Rufi started you sort only the pages not sorted yet; the user can ask you to change the others.`,
          );
        }
      }
      if (waiting.length === 0 && named.size === 0) {
        throw new Refusal("Nothing in this add is left to sort.");
      }

      // Which document each group becomes: the add for the group with most
      // of its pages, then each other document for the group with most of
      // its pages; any other group is a new document of the add.
      const holder = new Map(pages.map((p) => [p.position, p.documentId]));
      const chosen = new Map<number, string>();
      const taken = new Set<string>();
      const choose = (documentId: string) => {
        let best: number | undefined;
        let most = 0;
        for (const [index, group] of input.documents.entries()) {
          if (chosen.has(index)) continue;
          const held = group.pages.filter(
            (page) => holder.get(page) === documentId,
          ).length;
          if (held > most) {
            most = held;
            best = index;
          }
        }
        if (best !== undefined) {
          chosen.set(best, documentId);
          taken.add(documentId);
        }
      };
      for (const document of documents) choose(document.id);

      // A page a saved result cites stays in its document.
      const moves = [...named].flatMap(([page, index]) => {
        const from = holder.get(page);
        const to = chosen.get(index);
        return from !== undefined && from !== to ? [{ page, from, index }] : [];
      });
      if (moves.length > 0) {
        const cited = await trx
          .selectFrom("record_sources")
          .select(["document_id", "page"])
          .where("person_id", "=", personId)
          .where("type", "=", "document_page")
          .where(
            "document_id",
            "in",
            [...new Set(moves.map((m) => m.from))],
          )
          .execute();
        for (const move of moves) {
          if (
            cited.some(
              (c) => c.document_id === move.from && c.page === move.page,
            )
          ) {
            problem(
              `documents.${String(move.index)}.pages`,
              move.page,
              `Page ${String(move.page)} is a source of results saved in the record, so it stays in the document it is in: sort it there, or tell the user it can't move.`,
            );
          }
        }
      }

      // Each draft on a named page that has a copy, its value on that copy.
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
        } else if (!onPage(draft.value_text, page.copy.text)) {
          problem(
            `${at}.value_text`,
            draft.value_text,
            `"${draft.value_text}" isn't in page ${String(draft.page)}'s copy. Give the value exactly as the copy prints it, marks included (your reading of an unclear digit goes in value_number), or leave the draft out.`,
          );
        }
      }
      if (problems.length > 0) {
        throw new Refusal("Nothing was sorted. Fix these and try again.", problems);
      }

      // The documents: the chosen ones changed, the others new.
      const at = now();
      const ids = input.documents.map((_, index) => chosen.get(index) ?? uuid());
      for (const [index, group] of input.documents.entries()) {
        const id = ids[index] ?? "";
        const values = {
          kind: group.kind,
          date: group.date ?? null,
          issuer: group.lab ?? null,
          report_number: group.report_number ?? null,
        };
        if (chosen.has(index)) {
          await trx
            .updateTable("documents")
            .set((eb) => ({ ...values, version: eb("version", "+", 1) }))
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
              ...values,
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
        const page = pages.find((p) => p.position === draft.page);
        const index = named.get(draft.page) ?? 0;
        const next =
          seq.get(draft.page) ??
          ((
            await trx
              .selectFrom("draft_items")
              .select((eb) => eb.fn.max<number | null>("seq").as("last"))
              .where("person_id", "=", personId)
              .where("page", "=", draft.page)
              .where("document_id", "in", ids)
              .executeTakeFirst()
          )?.last ?? 0);
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
            job_id: page?.copy?.jobId ?? "",
            kind: "lab_result",
            version: 1,
            status: "pending",
            fields: JSON.stringify(fields),
            original: JSON.stringify(fields),
            unsure: JSON.stringify(worth_a_look === undefined ? [] : [worth_a_look]),
            quote,
            report: null,
            created_at: at,
          })
          .execute();
      }

      // The readings whose pages are sorted now, and the request it answers.
      const jobs = [
        ...new Set(waiting.flatMap((p) => (p.copy ? [p.copy.jobId] : []))),
      ];
      if (jobs.length > 0) {
        await trx
          .updateTable("jobs")
          .set({ sorted_at: at })
          .where("person_id", "=", personId)
          .where("id", "in", jobs)
          .execute();
      }
      const answer: SortAnswer = {
        sorted: true,
        documents: input.documents.map((group, index) => {
          const drafts = input.drafts.filter(
            (d) => named.get(d.page) === index,
          );
          return {
            id: ids[index] ?? "",
            kind: group.kind,
            date: group.date ?? null,
            pages: ranges(group.pages),
            drafts: drafts.length,
            worth_a_look: drafts.filter((d) => d.worth_a_look !== undefined)
              .length,
          };
        }),
        note: "Sorted. Nothing is saved: the drafts wait for the user on each document's page. Tell the user in a few lines what you found.",
      };
      const request =
        turn.origin === "rufi" ? turn.request?.id : undefined;
      if (request !== undefined) {
        await trx
          .updateTable("sort_requests")
          .set({
            state: "done",
            call_id: scope.callId,
            answer: JSON.stringify(answer),
            retry_at: null,
            error: null,
            ended_at: at,
          })
          .where("person_id", "=", personId)
          .where("id", "=", request)
          .execute();
      } else {
        await trx
          .insertInto("sort_requests")
          .values({
            id: uuid(),
            person_id: personId,
            document_id: add.id,
            job_id: null,
            state: "done",
            queue_id: null,
            tries: 0,
            call_id: scope.callId,
            answer: JSON.stringify(answer),
            created_at: at,
            ended_at: at,
          })
          .execute();
      }
      await closeOthers(trx, personId, add.id, request);
      return answer;
    });

  /**
   * At a reading's normal end, inside its end line's transaction: a request
   * to sort its add, handed to the AI as the queue row `queueId` (written
   * with the line). Older requests of the add give way to it.
   */
  const ask = async (
    trx: Trx,
    run: { personId: string; documentId: string; jobId: string },
    queueId: string,
  ) => {
    const add = await addOf(trx, run.personId, run.documentId);
    if (!add) return;
    await closeOthers(trx, run.personId, add.id, undefined);
    await trx
      .insertInto("sort_requests")
      .values({
        id: uuid(),
        person_id: run.personId,
        document_id: add.id,
        job_id: run.jobId,
        state: "open",
        queue_id: queueId,
        tries: 0,
        created_at: now(),
      })
      .execute();
  };

  /** A request's row again, waiting at the end of the queue (held when `held`). */
  const requeue = async (
    trx: Trx,
    request: { id: string; person_id: string; queue_id: string | null },
    held: "paused" | null,
  ) => {
    const old = await trx
      .selectFrom("chat_queue")
      .select(["chat_id", "text", "event_id"])
      .where("person_id", "=", request.person_id)
      .where("id", "=", request.queue_id ?? "")
      .executeTakeFirst();
    if (!old) return;
    const id = uuid();
    await addRow(
      trx,
      { personId: request.person_id, id: old.chat_id },
      {
        id,
        origin: "rufi",
        text: old.text,
        ...(old.event_id !== null && { eventId: old.event_id }),
      },
      now(),
    );
    await trx
      .updateTable("chat_queue")
      .set({ state: "removed", held: null, updated_at: now() })
      .where("person_id", "=", request.person_id)
      .where("id", "=", request.queue_id ?? "")
      .where("state", "=", "waiting")
      .execute();
    if (held !== null) {
      await trx
        .updateTable("chat_queue")
        .set({ held })
        .where("id", "=", id)
        .execute();
    }
    await trx
      .updateTable("sort_requests")
      .set({ queue_id: id, retry_at: null })
      .where("id", "=", request.id)
      .execute();
  };

  return {
    sort,
    ask,

    /**
     * Rufi's own work on the requests, after a turn ended, at start and as
     * retries fall due: a turn that sorted is done (the call consumed it);
     * one that completed without sorting waits for the person; one the
     * person stopped waits for them to go on; a failed turn, or a hand-over
     * that failed, is tried again after a wait, three times, then waits for
     * Retry. Returns the people whose chat has a row to hand over now, and
     * when the next try falls due.
     */
    tend: async (): Promise<{ people: string[]; wake: string | undefined }> =>
      db.transaction().execute(async (trx) => {
        const at = now();
        const people = new Set<string>();
        const open = await trx
          .selectFrom("sort_requests as r")
          .leftJoin("chat_queue as q", (join) =>
            join
              .onRef("q.person_id", "=", "r.person_id")
              .onRef("q.id", "=", "r.queue_id"),
          )
          .leftJoin("turns as t", (join) =>
            join
              .onRef("t.person_id", "=", "q.person_id")
              .onRef("t.id", "=", "q.turn_id"),
          )
          .select([
            "r.id",
            "r.person_id",
            "r.queue_id",
            "r.tries",
            "r.retry_at",
            "q.state as row",
            "q.held",
            "q.held_text",
            "t.status as turn",
            "t.end_reason",
            "t.end_text",
          ])
          .where("r.state", "=", "open")
          .execute();
        let wake: string | undefined;
        for (const request of open) {
          const failed = async (why: string) => {
            const wait = SORT_WAITS_MS[request.tries];
            if (wait === undefined) {
              await trx
                .updateTable("sort_requests")
                .set({ state: "failed", error: why, ended_at: at })
                .where("id", "=", request.id)
                .execute();
              await trx
                .updateTable("chat_queue")
                .set({ state: "removed", held: null, updated_at: at })
                .where("id", "=", request.queue_id ?? "")
                .where("state", "=", "waiting")
                .execute();
              return;
            }
            const due = new Date(Date.parse(at) + wait).toISOString();
            await trx
              .updateTable("sort_requests")
              .set({ tries: request.tries + 1, retry_at: due, error: why })
              .where("id", "=", request.id)
              .execute();
            wake = wake === undefined || due < wake ? due : wake;
          };
          if (request.retry_at !== null) {
            if (request.retry_at > at) {
              wake =
                wake === undefined || request.retry_at < wake
                  ? request.retry_at
                  : wake;
            } else {
              await requeue(trx, request, null);
              people.add(request.person_id);
            }
            continue;
          }
          if (request.row === "waiting") {
            if (request.held === "failed") {
              await failed(request.held_text ?? "Rufi couldn't hand it to the AI");
            } else if (request.held !== "paused") people.add(request.person_id);
            continue;
          }
          if (request.row === "handing_over") continue;
          if (request.row === "removed" || request.row === null) {
            // The person took it out of the queue: it waits for Retry.
            await trx
              .updateTable("sort_requests")
              .set({ state: "failed", error: null, ended_at: at })
              .where("id", "=", request.id)
              .execute();
            continue;
          }
          if (request.row === "not_sure" || request.turn === null) {
            await failed("Rufi stopped while it handed it to the AI");
            continue;
          }
          if (request.turn === "running") continue;
          if (request.turn === "completed") {
            // Rufi AI answered without sorting: it asked the person.
            await trx
              .updateTable("sort_requests")
              .set({ state: "asked", ended_at: at })
              .where("id", "=", request.id)
              .execute();
            continue;
          }
          if (request.end_reason === "stopped") {
            await requeue(trx, request, "paused");
            continue;
          }
          await failed(request.end_text ?? "the AI stopped");
        }
        return { people: [...people], wake };
      }),

    /**
     * The person's Retry of an add's sort that waits (failed, asked or
     * stopped): its tries start again and it goes at the end of the queue.
     * Returns whether there was one.
     */
    retry: async (personId: string, documentId: string): Promise<boolean> =>
      db.transaction().execute(async (trx) => {
        const add = await addOf(trx, personId, documentId);
        if (!add || add.deleted) {
          throw new Refusal("There is no such document for this person.");
        }
        const request = await trx
          .selectFrom("sort_requests")
          .select(["id", "person_id", "queue_id", "state"])
          .where("person_id", "=", personId)
          .where("document_id", "=", add.id)
          .where("state", "in", ["open", "asked", "failed"])
          .orderBy("created_at", "desc")
          .executeTakeFirst();
        if (!request) return false;
        await trx
          .updateTable("sort_requests")
          .set({ state: "open", tries: 0, error: null, ended_at: null })
          .where("id", "=", request.id)
          .execute();
        await requeue(trx, request, null);
        return true;
      }),

    /**
     * Each live document's sorting, for the person's lists: sorting (its
     * request waits to go or runs), waiting (it waits for the person:
     * stopped, asked, or its tries used) with why, or none.
     */
    states: async (
      personId: string,
    ): Promise<
      Map<string, { state: "sorting" | "waiting"; why: string | null }>
    > => {
      const requests = await db
        .selectFrom("sort_requests as r")
        .leftJoin("chat_queue as q", (join) =>
          join
            .onRef("q.person_id", "=", "r.person_id")
            .onRef("q.id", "=", "r.queue_id"),
        )
        .select(["r.document_id", "r.state", "r.error", "r.retry_at", "q.held"])
        .where("r.person_id", "=", personId)
        .where("r.state", "in", ["open", "asked", "failed"])
        .execute();
      const documents = await db
        .selectFrom("documents")
        .select(["id", "from_document"])
        .where("person_id", "=", personId)
        .where("deleted_at", "is", null)
        .execute();
      const pages = await pagesOf(
        db,
        personId,
        documents.map((d) => d.id),
        false,
      );
      const states = new Map<
        string,
        { state: "sorting" | "waiting"; why: string | null }
      >();
      for (const request of requests) {
        const state: { state: "sorting" | "waiting"; why: string | null } =
          request.state === "asked"
            ? { state: "waiting", why: "Rufi AI asked you about it in the chat" }
            : request.state === "failed"
              ? { state: "waiting", why: request.error }
              : request.held === "paused"
                ? {
                    state: "waiting",
                    why: "It goes on after your next message in the chat",
                  }
                : request.retry_at !== null
                  ? { state: "waiting", why: request.error }
                  : { state: "sorting", why: null };
        for (const document of documents) {
          if ((document.from_document ?? document.id) !== request.document_id)
            continue;
          if (
            notSorted(pages).some((p) => p.documentId === document.id)
          ) {
            states.set(document.id, state);
          }
        }
      }
      return states;
    },
  };
}

export type Sorting = ReturnType<typeof sorting>;

/** "pages 1–2 of 5", "page 5 of 5", or "" for a document that is its whole add. */
export function pagesWords(
  positions: readonly number[],
  of: number,
): string {
  if (positions.length === of) return "";
  return `${positions.length === 1 ? "page" : "pages"} ${ranges(positions)} of ${String(of)}`;
}

/** The chat's line once a reading ended with pages to sort. */
export function sortLine(about: {
  files: readonly string[];
  targets: readonly number[];
  pages: number;
  unreadable: number;
  notLooked: number;
}): string {
  const name = documentName(about.files);
  const head =
    about.targets.length === about.pages
      ? `Read ${name} · ${String(about.pages)} ${about.pages === 1 ? "page" : "pages"}`
      : `Read ${name} again · ${about.targets.length === 1 ? "page" : "pages"} ${ranges(about.targets)}`;
  const parts = [
    head,
    ...(about.unreadable > 0
      ? [
          `${String(about.unreadable)} ${about.unreadable === 1 ? "page" : "pages"} couldn't be read`,
        ]
      : []),
    ...(about.notLooked > 0
      ? [
          `${String(about.notLooked)} ${about.notLooked === 1 ? "page" : "pages"} not looked at`,
        ]
      : []),
  ];
  return `${parts.join(" · ")}. Rufi AI is sorting it.`;
}

export { KIND_WORDS };
