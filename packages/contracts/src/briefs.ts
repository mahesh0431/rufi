// What a visit brief's page gets from Rufi's local API.
import { Schema } from "effect";

/** One record a brief cites, as Rufi has it saved. */
export const BriefSource = Schema.Struct({
  /** The record's kind in words: "Medicine use", "Result". */
  kind: Schema.String,
  /** The record as the brief cited it: "HbA1c 6.8 % · 12 Aug 2026". */
  what: Schema.String,
  /** Where that record came from, in words. */
  from: Schema.String,
  /** A save changed this record after the brief cited it. */
  changedSince: Schema.Boolean,
  /** The record to open: this one, or the result that amends it now; null once removed. */
  record: Schema.NullOr(
    Schema.Struct({ kind: Schema.String, id: Schema.String }),
  ),
});
export type BriefSource = typeof BriefSource.Type;

/** A visit brief: the AI's Markdown as written, and its Sources built by Rufi. */
export const Brief = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  markdown: Schema.String,
  /** A save after the brief was made changed the record. */
  changedSince: Schema.Boolean,
  sources: Schema.Array(BriefSource),
});
export type Brief = typeof Brief.Type;

export const BriefPage = Schema.Struct({ brief: Brief });
