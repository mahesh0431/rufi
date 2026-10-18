// A person's documents: adding files, listing them, and finding a file's
// bytes to show. Adding keeps every original exactly as it came, synced to
// disk before one transaction writes the files, the documents and their
// pages. Several photos added together can be one document, pages in the
// order they were added; a PDF is always a document of its own. The same
// content for the same person is never added twice.
import { createHash } from "node:crypto";
import type {
  Added,
  DocumentFile,
  DocumentSummary,
  MediaType,
} from "@rufi/contracts/documents";
import { sql } from "kysely";
import { v7 as uuid } from "uuid";
import type { Store } from "../store/database.ts";
import { fileGate, type FileGate } from "./gate.ts";
import { inspect, type Inspected } from "./inspect.ts";
import { displayCopy, publisher } from "./pages.ts";
import type { Readings } from "./reading.ts";
import { placesOf, sorting } from "./sorting.ts";
import {
  displayPath,
  isFileId,
  keepDisplay,
  keepOriginal,
  originalPath,
} from "./originals.ts";

export interface NewFile {
  /** Its name as it was added. */
  name: string;
  bytes: Uint8Array;
}

/** A file Rufi doesn't take; nothing of that add was kept. */
export class NotADocument extends Error {
  readonly file: string;
  readonly reason: Exclude<Inspected, { ok: true }>["reason"];
  constructor(file: string, reason: NotADocument["reason"]) {
    super(`${file} wasn't added (${reason}).`);
    this.file = file;
    this.reason = reason;
  }
}

interface Looked extends NewFile {
  id: string;
  mediaType: MediaType;
  pages: number;
  /** A HEIC's display copy. */
  display: Uint8Array | undefined;
}

const isPhoto = (file: Looked) => file.mediaType !== "application/pdf";

export function documents(
  store: Store,
  home: string,
  now: () => string = () => new Date().toISOString(),
  /** Reads what is added. */
  reads?: Readings,
  /** Shared with backups, the export, drawn pages and deletes. */
  gate: FileGate = fileGate(),
) {
  const db = store.query;
  const publish = publisher(store, gate);

  /**
   * The person's document that already holds the file `id`, if any. A
   * deleted document's pages hold no file.
   */
  const holding = async (personId: string, id: string) =>
    (
      await db
        .selectFrom("document_pages")
        .select("document_id")
        .where("person_id", "=", personId)
        .where("file_id", "=", id)
        .limit(1)
        .executeTakeFirst()
    )?.document_id;

  return {
    /**
     * Adds `files` for the person, in order. `together`: the photos among
     * them become one document; otherwise each its own. A file that isn't a
     * PDF, JPEG, PNG or HEIC, or doesn't open, refuses the whole add
     * (NotADocument). The same content as a document already there, or as
     * an earlier file of this add, is left out and named in `already`.
     * `from`: where the person added them.
     */
    add: async (
      personId: string,
      files: readonly NewFile[],
      together: boolean,
      from: "documents_page" | "chat" = "documents_page",
    ): Promise<Added> => {
      const looked: Looked[] = [];
      const already: { name: string; documentId: string }[] = [];
      /** Files given twice in this add: named once their document is known. */
      const repeats: { name: string; id: string }[] = [];
      for (const file of files) {
        const id = createHash("sha256").update(file.bytes).digest("hex");
        const there = await holding(personId, id);
        if (there !== undefined) {
          already.push({ name: file.name, documentId: there });
          continue;
        }
        if (looked.some((f) => f.id === id)) {
          repeats.push({ name: file.name, id });
          continue;
        }
        const found = await inspect(file.bytes);
        if (!found.ok) throw new NotADocument(file.name, found.reason);
        looked.push({
          ...file,
          id,
          mediaType: found.mediaType,
          pages: found.pages,
          display: found.display,
        });
      }

      // In the order the files came: each PDF its own document; the photos
      // one document where the first of them was, or each its own.
      const groups: Looked[][] = [];
      let photos: Looked[] | undefined;
      for (const file of looked) {
        if (!together || !isPhoto(file)) groups.push([file]);
        else if (photos) photos.push(file);
        else groups.push((photos = [file]));
      }
      const at = now();
      const added = groups.map(() => uuid());
      // Inside the gate from the first byte to the commit: a delete of the
      // same bytes meanwhile never removes them under this add.
      await gate.shared(async () => {
        // Every original is on disk before any row points to it.
        for (const file of looked) {
          await keepOriginal(home, file.id, file.bytes);
          if (file.display) await keepDisplay(home, file.id, file.display);
        }
        await db.transaction().execute(async (trx) => {
          for (const file of looked) {
            await trx
              .insertInto("files")
              .values({
                id: file.id,
                size: file.bytes.byteLength,
                media_type: file.mediaType,
                created_at: at,
              })
              .onConflict((oc) => oc.column("id").doNothing())
              .execute();
          }
          for (const [index, group] of groups.entries()) {
            const documentId = added[index] ?? "";
            await trx
              .insertInto("documents")
              .values({
                id: documentId,
                person_id: personId,
                added_at: at,
                added_from: from,
                version: 0,
              })
              .execute();
            let position = 0;
            for (const file of group) {
              for (let page = 1; page <= file.pages; page++) {
                await trx
                  .insertInto("document_pages")
                  .values({
                    person_id: personId,
                    document_id: documentId,
                    position: ++position,
                    file_id: file.id,
                    page_in_file: page,
                    file_name: file.name,
                  })
                  .execute();
              }
            }
            await reads?.queueNew(trx, personId, documentId);
          }
        });
      });
      if (added.length > 0) reads?.changed(personId);
      for (const { name, id } of repeats) {
        const index = groups.findIndex((g) => g.some((f) => f.id === id));
        already.push({ name, documentId: added[index] ?? "" });
      }
      return { added, already };
    },

    /**
     * The person's documents, newest first, each with its files in page
     * order; the documents Rufi AI split from one add by their first page.
     */
    list: async (personId: string): Promise<DocumentSummary[]> => {
      const rows = await db
        .selectFrom("documents as d")
        .innerJoin("document_pages as p", (join) =>
          join
            .onRef("p.person_id", "=", "d.person_id")
            .onRef("p.document_id", "=", "d.id"),
        )
        .innerJoin("files as f", "f.id", "p.file_id")
        .select([
          "d.id",
          "d.added_at",
          "d.kind",
          "d.date",
          "d.issuer",
          "p.file_id",
          "p.file_name",
          "f.media_type",
        ])
        .where("d.person_id", "=", personId)
        .where("d.deleted_at", "is", null)
        .orderBy("d.added_at", "desc")
        .orderBy(sql`COALESCE(d.from_document, d.id)`, "desc")
        .orderBy(
          sql`(SELECT MIN(q.position) FROM document_pages q WHERE q.person_id = d.person_id AND q.document_id = d.id)`,
        )
        .orderBy("p.position")
        .execute();
      const statuses = await reads?.statuses(personId);
      const sorts = await sorting(store, now).states(personId);
      const places = await placesOf(db, personId);
      type File = { -readonly [K in keyof DocumentFile]: DocumentFile[K] };
      const list: (Omit<DocumentSummary, "files"> & { files: File[] })[] = [];
      for (const row of rows) {
        if (row.file_id === null) continue;
        let document = list.at(-1);
        if (document?.id !== row.id) {
          const reading = statuses?.get(row.id);
          document = {
            id: row.id,
            addedAt: row.added_at,
            kind: row.kind as DocumentSummary["kind"],
            date: row.date,
            lab: row.issuer,
            place: (() => {
              const place = places.get(row.id);
              return place && place.words !== ""
                ? { pages: place.positions, of: place.of }
                : null;
            })(),
            sorting: sorts.get(row.id) ?? null,
            status: reading?.status ?? "not_read",
            reading: reading
              ? {
                  saved: reading.saved,
                  of: reading.of,
                  results: reading.results,
                  hasPending: reading.hasPending,
                  toCheck: reading.toCheck,
                  itemsSaved: reading.itemsSaved,
                  itemsSetAside: reading.itemsSetAside,
                  canRetry: reading.canRetry,
                  error: reading.error,
                }
              : null,
            files: [],
          };
          list.push(document);
        }
        const file = document.files.at(-1);
        if (file?.id === row.file_id) file.pages++;
        else {
          document.files.push({
            id: row.file_id,
            name: row.file_name,
            mediaType: row.media_type as MediaType,
            pages: 1,
          });
        }
      }
      return list;
    },

    /**
     * The file `fileId` of the person's document `documentId`, to show: the
     * original's path and type, or, for a HEIC with `display`, its JPEG copy,
     * made again when it's missing. Undefined when that document of that
     * person has no such file.
     */
    file: async (
      personId: string,
      documentId: string,
      fileId: string,
      display: boolean,
    ): Promise<{ path: string; mediaType: string } | undefined> => {
      if (!isFileId(fileId)) return undefined;
      const found = await db
        .selectFrom("document_pages as p")
        .innerJoin("files as f", "f.id", "p.file_id")
        .select("f.media_type")
        .where("p.person_id", "=", personId)
        .where("p.document_id", "=", documentId)
        .where("p.file_id", "=", fileId)
        .limit(1)
        .executeTakeFirst();
      if (!found) return undefined;
      const heic =
        found.media_type === "image/heic" || found.media_type === "image/heif";
      if (!display || !heic) {
        return {
          path: originalPath(home, fileId),
          mediaType: found.media_type,
        };
      }
      // Made again when it's missing.
      await displayCopy(home, fileId, publish);
      return { path: displayPath(home, fileId), mediaType: "image/jpeg" };
    },
  };
}

export type Documents = ReturnType<typeof documents>;
