// What the Documents page gets from Rufi's local API.
import { Schema } from "effect";

export const MediaType = Schema.Literals([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);
export type MediaType = typeof MediaType.Type;

export const DocumentKind = Schema.Literals([
  "lab_report",
  "prescription",
  "letter",
  "other",
]);
export type DocumentKind = typeof DocumentKind.Type;

/** One original file of a document: a PDF, or one photo. */
export const DocumentFile = Schema.Struct({
  /** The sha256 of its bytes. */
  id: Schema.String,
  /** Its name as it was added. */
  name: Schema.String,
  mediaType: MediaType,
  /** A PDF's pages; a photo is one. */
  pages: Schema.Int,
});
export type DocumentFile = typeof DocumentFile.Type;

export const DocumentSummary = Schema.Struct({
  id: Schema.String,
  addedAt: Schema.String,
  /** As read; null until Rufi reads documents. */
  kind: Schema.NullOr(DocumentKind),
  /** The document's date as read, at its precision; null until read. */
  date: Schema.NullOr(Schema.String),
  /** not_read: no reading yet (it waits for the person's yes, or Read it). */
  status: Schema.Literals(["not_read", "reading", "done", "failed"]),
  /** The latest reading: pages saved of those it reads, and its drafts. */
  reading: Schema.NullOr(
    Schema.Struct({
      saved: Schema.Int,
      of: Schema.Int,
      /** Draft items not saved or dismissed yet. */
      results: Schema.Int,
      /** Of those, the ones marked unsure. */
      toCheck: Schema.Int,
      /** Retry would read something: a failed reading, or failed pages. */
      canRetry: Schema.Boolean,
      /** Why it failed, in words for the person. */
      error: Schema.NullOr(Schema.String),
    }),
  ),
  /** In page order. */
  files: Schema.Array(DocumentFile),
});
export type DocumentSummary = typeof DocumentSummary.Type;

/** A person's documents, newest first. */
export const Documents = Schema.Struct({
  documents: Schema.Array(DocumentSummary),
});

/** A file of an add that was the same content as one already added. */
const AlreadyAdded = Schema.Struct({
  name: Schema.String,
  documentId: Schema.String,
});

/** What an add did: the new documents, and the files already there. */
export const Added = Schema.Struct({
  added: Schema.Array(Schema.String),
  already: Schema.Array(AlreadyAdded),
});
export type Added = typeof Added.Type;

/** "Read it": `yes` when the person said yes just now. */
export const ReadIt = Schema.Struct({ yes: Schema.Boolean });

/** A reading that waits or runs, for the strip above the chat box. */
export const ReadingNow = Schema.Struct({
  documentId: Schema.String,
  /** The document's file, or "3 photos". */
  name: Schema.String,
  state: Schema.Literals(["running", "waiting"]),
  /** What a waiting reading waits for; null: its turn. */
  waiting: Schema.NullOr(
    Schema.Literals(["sign_in", "usage_limit", "turned_off"]),
  ),
  /** When a usage limit resets. */
  waitUntil: Schema.NullOr(Schema.String),
  /** It ran before: reading again after a restart or a retry. */
  again: Schema.Boolean,
  saved: Schema.Int,
  of: Schema.Int,
  /** When this run started, while it runs. */
  runAt: Schema.NullOr(Schema.String),
});
export type ReadingNow = typeof ReadingNow.Type;

export const Readings = Schema.Struct({ readings: Schema.Array(ReadingNow) });

const PrintedDate = Schema.Struct({
  label: Schema.String,
  date: Schema.String,
});

/** One result as the reader saved it, as printed. */
const ReadItem = Schema.Struct({
  test_name: Schema.String,
  value_text: Schema.String,
  unit: Schema.optionalKey(Schema.String),
  reference_range: Schema.optionalKey(Schema.String),
  flag_text: Schema.optionalKey(Schema.String),
  context_text: Schema.optionalKey(Schema.String),
  date: Schema.optionalKey(PrintedDate),
  column: Schema.optionalKey(Schema.Literals(["current", "earlier"])),
  from_page: Schema.optionalKey(Schema.Int),
  unsure: Schema.optionalKey(Schema.String),
});

/** A page's entry in the reader's notebook. */
const ReadEntry = Schema.Struct({
  outcome: Schema.Literals(["read", "nothing_here", "unreadable"]),
  why: Schema.optionalKey(Schema.String),
  facts: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.optionalKey(Schema.String),
      dates: Schema.optionalKey(Schema.Array(PrintedDate)),
      issuer: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
      report_number: Schema.optionalKey(Schema.String),
      report_status: Schema.optionalKey(Schema.String),
    }),
  ),
  rows_seen: Schema.optionalKey(Schema.Int),
  items: Schema.Array(ReadItem),
  issues: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ReadEntry = typeof ReadEntry.Type;

/** A document's reading as Open shows it: the reader's work, read only. */
export const ReadingView = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["not_read", "reading", "done", "failed"]),
  saved: Schema.Int,
  of: Schema.Int,
  runAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  /** The reader's one note for the whole document. */
  note: Schema.NullOr(Schema.String),
  pages: Schema.Array(
    Schema.Struct({
      position: Schema.Int,
      /** Once a reading that read it ended; null while it waits. */
      state: Schema.NullOr(
        Schema.Literals([
          "read",
          "nothing_here",
          "unreadable",
          "not_looked_at",
        ]),
      ),
      why: Schema.NullOr(Schema.String),
      entry: Schema.NullOr(ReadEntry),
      /** Rufi's checks of the entry: they flag, never change it. */
      checks: Schema.NullOr(
        Schema.Struct({
          incomplete: Schema.optionalKey(
            Schema.Struct({ rows_seen: Schema.Int, items: Schema.Int }),
          ),
          items: Schema.Array(
            Schema.Struct({ item: Schema.Int, why: Schema.String }),
          ),
        }),
      ),
    }),
  ),
  /** The AI use of its runs, as the AI reported it. */
  usage: Schema.NullOr(
    Schema.Struct({
      totalTokens: Schema.Int,
      cachedInputTokens: Schema.Int,
      looks: Schema.Int,
      saves: Schema.Int,
      compactions: Schema.Int,
    }),
  ),
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
});
export type ReadingView = typeof ReadingView.Type;

/** A draft item's printed fields that a fix can change, and their limits. */
export const FIXABLE = {
  test_name: 200,
  value_text: 100,
  unit: 200,
  reference_range: 200,
  flag_text: 200,
  context_text: 200,
} as const;
export type Fixable = keyof typeof FIXABLE;

/** A lab result's fields on a draft item, as printed. */
const DraftFields = Schema.Struct({
  test_name: Schema.String,
  value_text: Schema.String,
  comparator: Schema.optionalKey(Schema.String),
  value_number: Schema.optionalKey(Schema.Number),
  unit: Schema.optionalKey(Schema.String),
  reference_range: Schema.optionalKey(Schema.String),
  flag_text: Schema.optionalKey(Schema.String),
  context_text: Schema.optionalKey(Schema.String),
  date: Schema.optionalKey(PrintedDate),
  column: Schema.optionalKey(Schema.Literals(["current", "earlier"])),
  from_page: Schema.optionalKey(Schema.Int),
});

/** What the reader read and the person hasn't saved yet: never the record. */
export const DraftItem = Schema.Struct({
  id: Schema.String,
  /** Rises with each fix; a fix names the version it was made on. */
  version: Schema.Int,
  page: Schema.Int,
  status: Schema.Literals(["pending", "saved", "dismissed"]),
  /** The fields now: the reader's, or the person's fix. */
  fields: DraftFields,
  /** The reader's fields, never changed. */
  original: DraftFields,
  /** Why it may be wrong: the reader's words and Rufi's checks. */
  unsure: Schema.Array(Schema.String),
});
export type DraftItem = typeof DraftItem.Type;

/** A document's pages and draft items, for the document page. */
export const DocumentItems = Schema.Struct({
  pages: Schema.Array(
    Schema.Struct({
      position: Schema.Int,
      /** Once a reading that read it ended; null while it waits. */
      state: Schema.NullOr(
        Schema.Literals([
          "read",
          "nothing_here",
          "unreadable",
          "not_looked_at",
        ]),
      ),
      why: Schema.NullOr(Schema.String),
      /** The reader counted more or fewer rows than it read. */
      incomplete: Schema.NullOr(
        Schema.Struct({ rows_seen: Schema.Int, items: Schema.Int }),
      ),
    }),
  ),
  /** In page order, then as on the page. */
  items: Schema.Array(DraftItem),
});
export type DocumentItems = typeof DocumentItems.Type;

const fixed = (field: Fixable) =>
  Schema.optionalKey(Schema.String.check(Schema.isMaxLength(FIXABLE[field])));

/** A fix: the item's version it was made on, and the fields it changes. */
export const FixItem = Schema.Struct({
  version: Schema.Int,
  fields: Schema.Struct({
    test_name: fixed("test_name"),
    value_text: fixed("value_text"),
    unit: fixed("unit"),
    reference_range: fixed("reference_range"),
    flag_text: fixed("flag_text"),
    context_text: fixed("context_text"),
  }),
});
export type FixItem = typeof FixItem.Type;
