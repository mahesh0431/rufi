// What `rufi start` and the Rufi app (apps/desktop) say to each other on the
// private channel the app starts it with (Node's IPC channel, never the
// terminal). Each side decodes what it receives with these schemas.
import { Schema } from "effect";

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
]);
export type ToApp = typeof ToApp.Type;

/** What the app asks an owned Rufi: a fresh link, for a new window. */
export const FromApp = Schema.Struct({ type: Schema.Literal("link") });
export type FromApp = typeof FromApp.Type;
