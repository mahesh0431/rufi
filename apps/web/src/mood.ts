// The sidebar dog's face: a few states the screens already know, and the
// face Rufi's AI chose in its reply (show_face). The first line that applies
// wins. The face is about Rufi's own work and the conversation, never a
// health result.
import type { Face } from "@rufi/contracts";
import type { ExpressionKey } from "@rufi/brand/mark";

/** What is going on in Rufi now; each from what the screens already read. */
export interface Flags {
  /** Rufi's AI can't be used (signed out), or Rufi can't be reached. */
  away?: boolean;
  /** The chat's last reply failed, until the next one starts. */
  failed?: boolean;
  /** The face Rufi's AI chose in the latest reply, until the next starts. */
  chosen?: Face | undefined;
  /** A document is being read. */
  reading?: boolean;
  /** The AI is working on a reply. */
  working?: boolean;
  /** A reply or a reading just finished, for a few seconds. */
  justDone?: boolean;
  /** The chat is new and empty. */
  emptyChat?: boolean;
}

export function moodOf(flags: Flags): ExpressionKey {
  if (flags.away === true) return "resting";
  if (flags.failed === true) return "sorry";
  if (flags.chosen !== undefined) return flags.chosen;
  if (flags.reading === true) return "reading";
  if (flags.working === true) return "thinking";
  if (flags.justDone === true) return "done";
  if (flags.emptyChat === true) return "hello";
  return "calm";
}
