// The shared page service: one page of a person's document as the AI sees
// it. A PDF page is drawn as an image in the worker, with the page's own text
// when the PDF has text; a JPEG or PNG is used as it is; a HEIC through its
// display copy (JPEG). Drawn pages are a cache: made again when missing,
// never backed up. get_documents reads pages here, for every agent.
import { readFile } from "node:fs/promises";
import type { Store } from "../store/database.ts";
import { fileGate, type FileGate } from "./gate.ts";
import { draw, inspect } from "./inspect.ts";
import {
  displayPath,
  keepCached,
  keepDisplay,
  originalPath,
  pagePath,
  pageTextPath,
} from "./originals.ts";

interface PageImage {
  mediaType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

/** A page of a document, by its position (1, 2, 3...) in the document. */
export type PageView = {
  position: number;
  /** The document's number of pages. */
  pages: number;
  /** The name of the file the page is in, as it was added. */
  fileName: string;
} & (
  | {
      ok: true;
      image: PageImage;
      /** The PDF page's own text, plain; undefined for a scan or a photo. */
      text: string | undefined;
    }
  /** The page couldn't be drawn (a broken page in a PDF, or too slow). */
  | { ok: false; reason: "couldnt_prepare" }
);

const readIfThere = (path: string) =>
  readFile(path).then(
    (bytes) => new Uint8Array(bytes),
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    },
  );

/**
 * Keeps what was made from the file `fileId` (a drawn page, a display
 * copy), inside the file gate and only while the file is still live: what
 * was made from a file a delete removed meanwhile is dropped.
 */
export type Publish = (
  fileId: string,
  keep: () => Promise<void>,
) => Promise<void>;

/** Publish through `gate`, checking the file in `store`. */
export const publisher =
  (store: Store, gate: FileGate): Publish =>
  (fileId, keep) =>
    gate.shared(async () => {
      const live = await store.query
        .selectFrom("files")
        .select("id")
        .where("id", "=", fileId)
        .executeTakeFirst();
      if (live) await keep();
    });

/** A HEIC's display copy (JPEG), made again when it's missing. */
export async function displayCopy(
  home: string,
  fileId: string,
  publish: Publish,
): Promise<Uint8Array> {
  const kept = await readIfThere(displayPath(home, fileId));
  if (kept) return kept;
  const made = await inspect(await readFile(originalPath(home, fileId)));
  if (!made.ok || !made.display) {
    throw new Error("The photo's display copy couldn't be made.");
  }
  const display = made.display;
  await publish(fileId, () => keepDisplay(home, fileId, display));
  return display;
}

/**
 * A PDF page drawn, at full size when `full`, and its text, from the cache
 * or drawn now and kept.
 */
async function drawn(
  home: string,
  fileId: string,
  page: number,
  full: boolean,
  publish: Publish,
): Promise<{ png: Uint8Array; text: string | undefined } | undefined> {
  const png = await readIfThere(pagePath(home, fileId, page, full));
  const meta = await readIfThere(pageTextPath(home, fileId, page));
  if (png && meta) {
    const { text } = JSON.parse(new TextDecoder().decode(meta)) as {
      text: string | null;
    };
    return { png, text: text ?? undefined };
  }
  const made = await draw(
    await readFile(originalPath(home, fileId)),
    page,
    full,
  );
  if (!made.ok) return undefined;
  // The text last: a page counts as kept once both are there.
  await publish(fileId, async () => {
    await keepCached(pagePath(home, fileId, page, full), made.png);
    await keepCached(
      pageTextPath(home, fileId, page),
      new TextEncoder().encode(JSON.stringify({ text: made.text ?? null })),
    );
  });
  return made;
}

export function pages(store: Store, home: string, gate: FileGate = fileGate()) {
  const db = store.query;
  const publish = publisher(store, gate);
  return {
    /**
     * How many pages the person's document has; 0 when it isn't theirs or
     * was deleted (its pages hold no file).
     */
    count: async (personId: string, documentId: string): Promise<number> => {
      const row = await db
        .selectFrom("document_pages")
        .select((eb) => eb.fn.countAll<number>().as("pages"))
        .where("person_id", "=", personId)
        .where("document_id", "=", documentId)
        .where("file_id", "is not", null)
        .executeTakeFirstOrThrow();
      return row.pages;
    },

    /**
     * Page `position` of the person's document `documentId`, a PDF's drawn
     * at full size when `full` (a photo is always whole); undefined when
     * that person has no such document or page.
     */
    page: async (
      personId: string,
      documentId: string,
      position: number,
      full = false,
    ): Promise<PageView | undefined> => {
      const all = await db
        .selectFrom("document_pages as p")
        .innerJoin("files as f", "f.id", "p.file_id")
        .select([
          "p.position",
          "p.file_id",
          "p.page_in_file",
          "p.file_name",
          "f.media_type",
        ])
        .where("p.person_id", "=", personId)
        .where("p.document_id", "=", documentId)
        .orderBy("p.position")
        .execute();
      const row = all.find((p) => p.position === position);
      if (row?.file_id == null) return undefined;
      const about = {
        position,
        pages: all.length,
        fileName: row.file_name,
      };
      switch (row.media_type) {
        case "image/jpeg":
        case "image/png":
          return {
            ...about,
            ok: true,
            image: {
              mediaType: row.media_type,
              bytes: new Uint8Array(
                await readFile(originalPath(home, row.file_id)),
              ),
            },
            text: undefined,
          };
        case "image/heic":
        case "image/heif":
          return {
            ...about,
            ok: true,
            image: {
              mediaType: "image/jpeg",
              bytes: await displayCopy(home, row.file_id, publish),
            },
            text: undefined,
          };
        default: {
          const made = await drawn(
            home,
            row.file_id,
            row.page_in_file,
            full,
            publish,
          );
          if (!made) return { ...about, ok: false, reason: "couldnt_prepare" };
          return {
            ...about,
            ok: true,
            image: { mediaType: "image/png", bytes: made.png },
            text: made.text,
          };
        }
      }
    },
  };
}

export type Pages = ReturnType<typeof pages>;
