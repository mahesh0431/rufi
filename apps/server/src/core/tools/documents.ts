// get_documents: the active person's documents, read only. No document: the
// list, newest first. A document: its pages, its add and its drafts. A
// document and a page: that page as the AI sees it (the image, the PDF's own
// text when it has some, and the reader's copy), from the same page service
// the reader uses. A document and copies: the reader's copies of its add's
// pages, for sorting (sort_documents). Lists come in parts
// with a continuation, so a read can always be finished. The person is
// Rufi's choice; the AI names only a document of theirs and a page.
import type { DraftItem } from "@rufi/contracts/documents";
import { Schema } from "effect";
import { DELETED_DOCUMENT, ranges } from "../documents/naming.ts";
import { readerValues } from "../documents/items.ts";
import type { Entry } from "../documents/notebook.ts";
import { readings } from "../documents/reading.ts";
import {
  addOf,
  documentsOf,
  notSorted,
  pagesOf,
  placesOf,
  sorting,
  SortInput,
} from "../documents/sorting.ts";
import { defineTool, Refusal, WithImage } from "./registry.ts";

type Fields = DraftItem["fields"];

/** Documents, pages or draft items in one answer at most; the description says the same. */
export const PART = { documents: 50, pages: 100, items: 100, copies: 20 };

const Input = Schema.Struct({
  document: Schema.optionalKey(
    Schema.String.annotate({
      description: "A document's id, from the list. Leave it out for the list.",
    }),
  ),
  page: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).annotate({
      description:
        "A page of that document, by its number: you get the page's image, its own text when it has some, and the reader's copy.",
    }),
  ),
  copies: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "true with document: the reader's copy of every page of what the user added with it (its add), for sorting it.",
    }),
  ),
  after: Schema.optionalKey(
    Schema.String.annotate({
      description: "The `next` of the previous answer, to read on.",
    }),
  ),
});

export const getDocuments = defineTool({
  name: "get_documents",
  description: `The active person's documents (lab reports, prescriptions, letters they added), read only. Without document: the list, newest first, each with its id, when it was added, its kind and date (as sorted), its files and pages, its reading's status: "not_read" (never read; retry_reading reads it), "reading" (Rufi's reader is copying its pages now), "done" or "failed", and its sorting when it waits for it: "sorting" (Rufi asked you to sort it) or "not sorted yet". One add (what the user added at once: a PDF, or photos together) can be several documents once sorted: such a document names its pages in the add ("pages 3–4 of 5"). With document: its version (it rises when a sort, a reading or a fix changes its draft items or pages), kind, date, lab and report number, its add (every document of it, with their pages, and the pages not sorted yet), its pages (each with its number in the add, its state and whether it is sorted; an older reading's facts and issues) and its draft items: what you or an older reader drafted, each with its id, version, page, status (not saved, saved with how and into which record, or dismissed), fields exactly as printed or as the user fixed them on the document's page (a fixed item has fixed_by_user, and drafted: what was drafted in each field the user changed, null where none), the words it came from (quote), why it is worth a look, and out_of_date when its page was read again since. An older reader's item without a date of its own is saved with its page's first printed date. Draft items are not saved: they are not the record and count in no answer until the user saves them. With document and page: that page as an image, with the page's own text when the PDF has some and the reader's copy (use them for exact characters); a photo or a scan is the image and the copy. With document and copies: the reader's copy of every page of its add, as Markdown, exactly as printed, with the reader's marks where something is unclear (2[3?]6, [unclear: ...], ~~crossed out~~, [handwritten: ...]). At most ${String(PART.documents)} documents, ${String(PART.pages)} pages, ${String(PART.items)} draft items or ${String(PART.copies)} copies come back; when there are more, the answer has "next": pass it as after to read on. Rufi chooses the person, not you.`,
  input: Input,
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [
    {},
    { document: "01a12345-0000-7000-8000-000000000000" },
    {
      document: "01a12345-0000-7000-8000-000000000000",
      page: 1,
    },
    { document: "01a12345-0000-7000-8000-000000000000", copies: true },
  ],
  run: async (input, { store, personId, pages }) => {
    if (!store) return { note: "Rufi has no documents yet." };
    if (personId === undefined) {
      throw new Refusal(
        "No person is chosen in Rufi, so documents can't be read. Ask the user which person they mean.",
      );
    }
    const db = store.query;
    if (input.document === undefined) {
      if (input.page !== undefined) {
        throw new Refusal("A page needs its document: give document too.");
      }
      let query = db
        .selectFrom("documents")
        .select(["id", "added_at", "kind", "date"])
        .where("person_id", "=", personId)
        .where("deleted_at", "is", null);
      if (input.after !== undefined) {
        const last = await db
          .selectFrom("documents")
          .select(["added_at", "id"])
          .where("person_id", "=", personId)
          .where("id", "=", input.after)
          .executeTakeFirst();
        if (!last) throw new Refusal("That `after` isn't from this list.");
        query = query.where((eb) =>
          eb.or([
            eb("added_at", "<", last.added_at),
            eb.and([
              eb("added_at", "=", last.added_at),
              eb("id", "<", last.id),
            ]),
          ]),
        );
      }
      const rows = await query
        .orderBy("added_at", "desc")
        .orderBy("id", "desc")
        .limit(PART.documents + 1)
        .execute();
      const part = rows.slice(0, PART.documents);
      const files = await db
        .selectFrom("document_pages")
        .select(["document_id", "file_name"])
        .select((eb) => eb.fn.countAll<number>().as("pages"))
        .where("person_id", "=", personId)
        .where(
          "document_id",
          "in",
          part.length > 0 ? part.map((d) => d.id) : [""],
        )
        .groupBy(["document_id", "file_id", "file_name"])
        .orderBy("document_id")
        .orderBy((eb) => eb.fn.min("position"))
        .execute();
      const statuses = await readings(store).statuses(personId);
      const sorts = await sorting(store).states(personId);
      const places = await placesOf(db, personId);
      return {
        documents: part.map((d) => ({
          id: d.id,
          added_at: d.added_at,
          kind: d.kind,
          date: d.date,
          status: statuses.get(d.id)?.status ?? "not_read",
          ...(sorts.has(d.id) && {
            sorting:
              sorts.get(d.id)?.state === "sorting"
                ? "sorting"
                : "not sorted yet",
          }),
          ...(places.get(d.id)?.words && { pages: places.get(d.id)?.words }),
          files: files
            .filter((f) => f.document_id === d.id)
            .map((f) => ({ name: f.file_name, pages: f.pages })),
        })),
        ...(rows.length > PART.documents && { next: part.at(-1)?.id }),
      };
    }

    const document = await db
      .selectFrom("documents")
      .select([
        "id",
        "added_at",
        "kind",
        "date",
        "issuer",
        "report_number",
        "version",
        "deleted_at",
      ])
      .where("person_id", "=", personId)
      .where("id", "=", input.document)
      .executeTakeFirst();
    if (document?.deleted_at != null) {
      throw new Refusal(
        `The user deleted this document from Rufi: its pages and draft items are gone. ${DELETED_DOCUMENT}`,
      );
    }
    if (!document) {
      throw new Refusal(
        "There is no such document for this person: read the list for its id.",
      );
    }

    if (input.page !== undefined) {
      if (!pages) throw new Refusal("Rufi can't show pages here.");
      const view = await pages.page(personId, document.id, input.page);
      if (!view) {
        const count = await pages.count(personId, document.id);
        throw new Refusal(
          `This document has no page ${String(input.page)}; its pages are 1–${String(count)}.`,
        );
      }
      const copy = (await pagesOf(db, personId, [document.id])).find(
        (p) => p.position === input.page,
      )?.copy;
      const about = {
        document: document.id,
        page: view.position,
        of: view.pages,
        file: view.fileName,
        ...(copy && {
          copy: copy.text,
          ...(copy.outcome !== "read" && { copied_as: copy.outcome }),
        }),
      };
      if (!view.ok) {
        return {
          ...about,
          image: "This page couldn't be prepared, so there is no image.",
        };
      }
      return new WithImage(
        { ...about, ...(view.text !== undefined && { text: view.text }) },
        view.image,
      );
    }

    // The reader's copies of the add's pages, in parts: "copies:N".
    const add = await addOf(db, personId, document.id);
    const siblings = add ? await documentsOf(db, personId, add.id) : [];
    const addPages = await pagesOf(
      db,
      personId,
      siblings.map((d) => d.id),
      input.copies === true,
    );
    if (input.copies === true) {
      if (input.after !== undefined && !/^copies:\d{1,9}$/.test(input.after)) {
        throw new Refusal("That `after` isn't from these copies.");
      }
      const from = input.after === undefined ? 0 : Number(input.after.slice(7));
      const shown = addPages
        .filter((p) => p.position > from)
        .slice(0, PART.copies);
      const more = addPages.some(
        (p) => p.position > (shown.at(-1)?.position ?? from),
      );
      return {
        add: add?.id,
        copies: shown.map((p) => ({
          page: p.position,
          document: p.documentId,
          file: p.fileName,
          page_in_file: p.pageInFile,
          ...(p.copy
            ? {
                outcome: p.copy.outcome,
                sorted: p.copy.sorted,
                copy: p.copy.text,
              }
            : { copy: null, note: "The reader has no copy of this page." }),
        })),
        ...(more && {
          next: `copies:${String(shown.at(-1)?.position ?? from)}`,
        }),
      };
    }

    // Pages first, then draft items, each in parts: "pages:N", "items:N".
    const parsed =
      input.after === undefined
        ? ["first", "0"]
        : /^(pages|items):(\d{1,9})$/.exec(input.after)?.slice(1);
    if (!parsed) throw new Refusal("That `after` isn't from this document.");
    const [part, at] = parsed;
    const from = Number(at);
    const status = (await readings(store).statuses(personId)).get(document.id);
    const counted = await db
      .selectFrom("draft_items")
      .select((eb) => eb.fn.countAll<number>().as("items"))
      .where("person_id", "=", personId)
      .where("document_id", "=", document.id)
      .executeTakeFirstOrThrow();
    const pagesPart = async () => {
      const rows = await db
        .selectFrom("document_pages")
        .select([
          "position",
          "file_name",
          "page_in_file",
          "state",
          "state_why",
          "entry",
        ])
        .where("person_id", "=", personId)
        .where("document_id", "=", document.id)
        .where("position", ">", part === "pages" ? from : 0)
        .orderBy("position")
        .limit(PART.pages + 1)
        .execute();
      const shown = rows.slice(0, PART.pages);
      return {
        pages: shown.map((p) => {
          const entry =
            p.state && p.entry ? (JSON.parse(p.entry) as Entry) : undefined;
          const copy = addPages.find((a) => a.position === p.position)?.copy;
          return {
            page: p.position,
            file: p.file_name,
            page_in_file: p.page_in_file,
            ...(p.state !== null && { state: p.state }),
            ...(p.state_why !== null && { why: p.state_why }),
            ...(copy && { sorted: copy.sorted }),
            ...(entry?.facts && { facts: entry.facts }),
            ...(entry?.issues && { issues: entry.issues }),
          };
        }),
        more: rows.length > PART.pages ? shown.at(-1)?.position : undefined,
      };
    };
    const itemsPart = async (offset: number) => {
      const rows = await db
        .selectFrom("draft_items")
        .select([
          "id",
          "version",
          "page",
          "status",
          "fields",
          "original",
          "unsure",
          "quote",
          "job_id",
          "saved_as",
          "record_id",
        ])
        .where("person_id", "=", personId)
        .where("document_id", "=", document.id)
        .orderBy("page")
        .orderBy("seq")
        .orderBy("created_at")
        .limit(PART.items + 1)
        .offset(offset)
        .execute();
      const shown = rows.slice(0, PART.items);
      return {
        items: shown.map((d) => {
          const unsure = JSON.parse(d.unsure) as string[];
          const fields = JSON.parse(d.fields) as Fields;
          const drafted = readerValues(
            fields,
            JSON.parse(d.original) as Fields,
          );
          const copy = addPages.find((p) => p.position === d.page)?.copy;
          return {
            id: d.id,
            version: d.version,
            page: d.page,
            status: d.status === "pending" ? "not saved" : d.status,
            ...(d.status === "saved" && {
              saved_as: d.saved_as,
              record: d.record_id,
            }),
            ...fields,
            ...(d.quote !== null && { quote: d.quote }),
            ...(Object.keys(drafted).length > 0 && {
              fixed_by_user: true,
              drafted,
            }),
            ...(unsure.length > 0 && { worth_a_look: unsure }),
            ...(d.quote !== null &&
              copy !== undefined &&
              copy.jobId !== d.job_id && { out_of_date: true }),
          };
        }),
        more: rows.length > PART.items ? offset + PART.items : undefined,
      };
    };
    const waiting = notSorted(addPages);
    const about = {
      id: document.id,
      added_at: document.added_at,
      kind: document.kind,
      date: document.date,
      ...(document.issuer !== null && { lab: document.issuer }),
      ...(document.report_number !== null && {
        report_number: document.report_number,
      }),
      version: document.version,
      status: status?.status ?? "not_read",
      ...(status?.status === "reading" && {
        reading: `copied ${String(status.saved)} of ${String(status.of)} pages so far; it is sorted when the reading ends`,
      }),
      ...(add &&
        (siblings.length > 1 || waiting.length > 0) && {
          add: {
            id: add.id,
            pages: addPages.length,
            documents: siblings.map((d) => ({
              id: d.id,
              kind: d.kind,
              date: d.date,
              pages: ranges(
                addPages
                  .filter((p) => p.documentId === d.id)
                  .map((p) => p.position),
              ),
            })),
            ...(waiting.length > 0 && {
              not_sorted: ranges(waiting.map((p) => p.position)),
            }),
          },
        }),
      ...(status?.error && { failed: status.error }),
      draft_items: counted.items,
    };
    if (part === "items") {
      const items = await itemsPart(from);
      return {
        document: about,
        items: items.items,
        ...(items.more !== undefined && {
          next: `items:${String(items.more)}`,
        }),
      };
    }
    const listed = await pagesPart();
    if (part === "pages") {
      return {
        document: about,
        pages: listed.pages,
        next:
          listed.more !== undefined
            ? `pages:${String(listed.more)}`
            : counted.items > PART.items
              ? `items:${String(PART.items)}`
              : undefined,
      };
    }
    const items = await itemsPart(0);
    const next =
      listed.more !== undefined
        ? `pages:${String(listed.more)}`
        : items.more !== undefined
          ? `items:${String(items.more)}`
          : undefined;
    return {
      document: about,
      pages: listed.pages,
      items: items.items,
      ...(items.items.length > 0 && {
        note: "These draft items are not saved: they are not the user's record yet.",
      }),
      ...(next !== undefined && { next }),
    };
  },
});

export const retryReading = defineTool({
  name: "retry_reading",
  description:
    "Reads a document again where its reading failed, when the user asks you to: a reading that failed continues where it stopped; a finished reading reads only its pages that couldn't be read or weren't looked at, and never changes the draft items already read; a document never read is read in full. Only in a message from the user, never in a turn a Rufi event started. The reading runs in the background; its line comes in the chat when it ends.",
  input: Schema.Struct({
    document: Schema.String.annotate({
      description: "The document's id, from get_documents.",
    }),
  }),
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [{ document: "01a12345-0000-7000-8000-000000000000" }],
  run: async ({ document }, { retryReading: retry }) => {
    if (!retry) throw new Refusal("Rufi can't read documents here.");
    const pages = await retry(document);
    return {
      queued: true,
      pages,
      note: "The reading runs in the background; Rufi shows its line in the chat when it ends.",
    };
  },
});

export const sortDocuments = defineTool({
  name: "sort_documents",
  description: `Sorts what the user added into documents and writes its drafts, from the reader's page copies (get_documents with copies), as the sorting-documents skill says. One call for the whole add: documents (each one of the add's documents by its id, or a new one with no id; its pages by their number in the add; its kind, its date, and a report's lab and number, which for a named document stay as they are when left out) and drafts (each a current lab result or a measurement as printed, with its page, its date, the words it comes from and, when it is worth the user's look, why). Every page not sorted yet goes in one document; pages you don't name stay where they are. The add's own id names its first document: the first sort names it for one of the documents. A draft's value_text must be on its page's copy as printed, or the whole call is refused; where the reader marked a digit unclear ("1[0?]4"), give your reading ("104") and say why in worth_a_look. The drafts replace the drafts of the named pages that the user hasn't fixed or set aside. A page that a saved result cites stays in its document. Nothing is saved to the record: drafts wait for the user. In a turn Rufi started for a sort, you sort only the pages not sorted yet, each into a document that keeps its kind, date, lab and number, or into a new one, and nothing else changes; in the user's own turn you can also change how pages were sorted ("pages 3 and 4 are one letter"). All or nothing; the same call again gets the same answer.`,
  input: SortInput,
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [
    {
      document: "01a12345-0000-7000-8000-000000000000",
      documents: [
        {
          id: "01a12345-0000-7000-8000-000000000000",
          pages: [1, 2],
          kind: "lab_report",
          date: "2026-05-04",
          lab: "Example Clinic Lab",
          report_number: "EX-100",
        },
        { pages: [3], kind: "prescription", date: "2026-05-10" },
      ],
      drafts: [
        {
          page: 1,
          test_name: "Sodium",
          value_text: "139",
          value_number: 139,
          unit: "mmol/L",
          reference_range: "135 – 145",
          date: { label: "Collected", date: "04/05/2026", iso: "2026-05-04" },
          quote: "Sodium 139 mmol/L 135 – 145",
        },
        {
          page: 1,
          test_name: "Potassium",
          value_text: "4.2",
          value_number: 4.2,
          unit: "mmol/L",
          date: { label: "Collected", date: "04/05/2026", iso: "2026-05-04" },
          quote: "Potassium 4.[2?] mmol/L",
          worth_a_look: "a digit is unclear",
        },
      ],
    },
  ],
  run: async (input, { sort, callId }) => {
    if (!sort || callId === undefined) {
      throw new Refusal("Documents can be sorted only in Rufi's own chat.");
    }
    return sort(input, callId);
  },
});
