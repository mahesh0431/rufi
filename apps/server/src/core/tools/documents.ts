// get_documents: the active person's documents, read only. No document: the
// list, newest first. A document: its pages. A document and a page: that
// page as the AI sees it (the image, and the PDF's own text when it has
// some), from the same page service the reader uses. Lists come in parts
// with a continuation, so a read can always be finished. The person is
// Rufi's choice; the AI names only a document of theirs and a page.
import { Schema } from "effect";
import { defineTool, Refusal, WithImage } from "./registry.ts";

/** Documents or pages in one answer at most; the description says the same. */
export const PART = { documents: 50, pages: 100 };

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
  description: `The active person's documents (lab reports, prescriptions, letters they added), read only. Without document: the list, newest first, each with its id, when it was added, its files and pages, and its status ("not_read": not read yet). With document: its pages. With document and page: that page as an image, with the page's own text when the PDF has some (use it for exact characters); a photo or a scan is the image alone. At most ${String(PART.documents)} documents or ${String(PART.pages)} pages come back; when there are more, the answer has "next": pass it as after to read on. Documents are not the record: nothing in them counts as saved. Rufi chooses the person, not you.`,
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
      return {
        documents: part.map((d) => ({
          id: d.id,
          added_at: d.added_at,
          kind: d.kind,
          date: d.date,
          status: "not_read",
          files: files
            .filter((f) => f.document_id === d.id)
            .map((f) => ({ name: f.file_name, pages: f.pages })),
        })),
        ...(rows.length > PART.documents && { next: part.at(-1)?.id }),
      };
    }

    const document = await db
      .selectFrom("documents")
      .select(["id", "added_at", "kind", "date"])
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

    const from = input.after === undefined ? 0 : Number(input.after);
    if (!Number.isInteger(from) || from < 0) {
      throw new Refusal("That `after` isn't from this document's pages.");
    }
    const rows = await db
      .selectFrom("document_pages")
      .select(["position", "file_name", "page_in_file"])
      .where("person_id", "=", personId)
      .where("document_id", "=", document.id)
      .where("position", ">", from)
      .orderBy("position")
      .limit(PART.pages + 1)
      .execute();
    const part = rows.slice(0, PART.pages);
    return {
      document: {
        id: document.id,
        added_at: document.added_at,
        kind: document.kind,
        date: document.date,
        status: "not_read",
      },
      pages: part.map((p) => ({
        page: p.position,
        file: p.file_name,
        page_in_file: p.page_in_file,
      })),
      ...(rows.length > PART.pages && {
        next: String(part.at(-1)?.position ?? from),
      }),
    };
  },
});
