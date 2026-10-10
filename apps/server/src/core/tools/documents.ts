// get_documents: the active person's documents, read only. No document: the
// list, newest first. A document: its pages. A document and a page: that
// page as the AI sees it (the image, and the PDF's own text when it has
// some), from the same page service the reader uses. Lists come in parts
// with a continuation, so a read can always be finished. The person is
// Rufi's choice; the AI names only a document of theirs and a page.
import { Schema } from "effect";
import type { Entry } from "../documents/notebook.ts";
import { readings } from "../documents/reading.ts";
import { defineTool, Refusal, WithImage } from "./registry.ts";

/** Documents, pages or draft items in one answer at most; the description says the same. */
export const PART = { documents: 50, pages: 100, items: 100 };

const Input = Schema.Struct({
  document: Schema.optionalKey(
    Schema.String.annotate({
      description: "A document's id, from the list. Leave it out for the list.",
    }),
  ),
  page: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).annotate({
      description:
        "A page of that document, 1, 2, 3...: you get the page's image and its own text when it has some.",
    }),
  ),
  after: Schema.optionalKey(
    Schema.String.annotate({
      description: "The `next` of the previous answer, to read on.",
    }),
  ),
});

/** What a person sees when the AI uses it. */
function shown(input: unknown): string {
  const sent = (input ?? {}) as Record<string, unknown>;
  if (typeof sent["page"] === "number") {
    return `Looked at page ${String(sent["page"])} of a document`;
  }
  return typeof sent["document"] === "string"
    ? "Read a document"
    : "Read your documents";
}

export const getDocuments = defineTool({
  name: "get_documents",
  shown,
  description: `The active person's documents (lab reports, prescriptions, letters they added), read only. Without document: the list, newest first, each with its id, when it was added, its files and pages, and its reading's status: "not_read" (not read yet: it waits for the user's yes or their Read it), "reading" (Rufi's reader is reading it now; its items come when it ends), "done" or "failed". With document: its version (it rises when its draft items change), its pages (each with what the reader found: its state, its facts such as dates, lab, report number and the name printed on it, and its issues) and its draft items: what the reader read, each with its id, version, page, status (not saved, saved with how and into which record, or dismissed), fields exactly as printed (a date on the item is its own; without one, the page's first printed date is used when it is saved), and why it may be unsure. Draft items are not saved: they are not the record and count in no answer until the user saves them. With document and page: that page as an image, with the page's own text when the PDF has some (use it for exact characters); a photo or a scan is the image alone. At most ${String(PART.documents)} documents, ${String(PART.pages)} pages or ${String(PART.items)} draft items come back; when there are more, the answer has "next": pass it as after to read on. Rufi chooses the person, not you.`,
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
        .where("person_id", "=", personId);
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
      return {
        documents: part.map((d) => ({
          id: d.id,
          added_at: d.added_at,
          kind: d.kind,
          date: d.date,
          status: statuses.get(d.id)?.status ?? "not_read",
          files: files
            .filter((f) => f.document_id === d.id)
            .map((f) => ({ name: f.file_name, pages: f.pages })),
        })),
        ...(rows.length > PART.documents && { next: part.at(-1)?.id }),
      };
    }

    const document = await db
      .selectFrom("documents")
      .select(["id", "added_at", "kind", "date", "version"])
      .where("person_id", "=", personId)
      .where("id", "=", input.document)
      .executeTakeFirst();
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
      const about = {
        document: document.id,
        page: view.position,
        of: view.pages,
        file: view.fileName,
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
          return {
            page: p.position,
            file: p.file_name,
            page_in_file: p.page_in_file,
            ...(p.state !== null && { state: p.state }),
            ...(p.state_why !== null && { why: p.state_why }),
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
          "unsure",
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
          return {
            id: d.id,
            version: d.version,
            page: d.page,
            status: d.status === "pending" ? "not saved" : d.status,
            ...(d.status === "saved" && {
              saved_as: d.saved_as,
              record: d.record_id,
            }),
            ...(JSON.parse(d.fields) as object),
            ...(unsure.length > 0 && { unsure }),
          };
        }),
        more: rows.length > PART.items ? offset + PART.items : undefined,
      };
    };
    const about = {
      id: document.id,
      added_at: document.added_at,
      kind: document.kind,
      date: document.date,
      version: document.version,
      status: status?.status ?? "not_read",
      ...(status?.status === "reading" && {
        reading: `saved ${String(status.saved)} of ${String(status.of)} pages so far; its draft items come when it ends`,
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
  shown: "Asked Rufi to read a document again",
  description:
    "Reads a document again where its reading failed, when the user asks you to: a reading that failed continues where it stopped; a finished reading reads only its pages that couldn't be read or weren't looked at, and never changes the draft items already read. Only in a message from the user, never in a turn a Rufi event started. The reading runs in the background; its line comes in the chat when it ends.",
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
