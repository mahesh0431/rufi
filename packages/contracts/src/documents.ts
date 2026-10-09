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
  status: Schema.Literal("not_read"),
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
