// What `rufi start` and the Rufi app (apps/desktop) say to each other on the
// private channel the app starts it with (Node's IPC channel, never the
// terminal). Each side decodes what it receives with these schemas.
import { Schema } from "effect";

/**
 * The header that carries the chosen appearance (system, light or dark) on
 * the pages the core serves and on its settings: the app's windows take it,
 * so the Mac's material around the page matches the page.
 */
export const APPEARANCE_HEADER = "x-rufi-appearance";

/**
 * One person's follow-ups that just became due or overdue, as counts: the
 * app shows them as a Mac notice. No title or name ever goes in one.
 */
export const PersonNotices = Schema.Struct({
  personId: Schema.String,
  due: Schema.Int,
  overdue: Schema.Int,
});
export type PersonNotices = typeof PersonNotices.Type;

/** What `rufi start` tells the app. */
export const ToApp = Schema.Union([
  /** It started Rufi and runs it until the channel closes. */
  Schema.Struct({ type: Schema.Literal("owned"), url: Schema.String }),
  /** Rufi already runs with this data folder; the command then ends. */
  Schema.Struct({ type: Schema.Literal("attached"), url: Schema.String }),
  /** Rufi couldn't start; the message is for the person. */
  Schema.Struct({ type: Schema.Literal("failed"), message: Schema.String }),
  /** A fresh link, the answer to the app's "link". */
  Schema.Struct({ type: Schema.Literal("link"), url: Schema.String }),
  /** The answer to the app's "claim-notices": the people to tell, if any. */
  Schema.Struct({
    type: Schema.Literal("notices"),
    people: Schema.Array(PersonNotices),
  }),
]);
export type ToApp = typeof ToApp.Type;

/**
 * What the app asks an owned Rufi: a fresh link, for a new window; or the
 * follow-up notices due now (docs/adr/0012), which Rufi marks as told.
 */
export const FromApp = Schema.Union([
  Schema.Struct({ type: Schema.Literal("link") }),
  Schema.Struct({ type: Schema.Literal("claim-notices") }),
]);
export type FromApp = typeof FromApp.Type;
