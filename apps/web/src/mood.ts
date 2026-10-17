// The sidebar dog's face: one rule from what Rufi is doing to an expression.
// The first line that applies wins. The face reacts to Rufi's own work,
// never to a health result.
import type { ExpressionKey } from "@rufi/brand/mark";

/** What is going on in Rufi now; each from what the screens already read. */
export interface Flags {
  /** Rufi's AI can't be used: signed out, or the plan can't be used. */
  signedOut?: boolean;
  /** The chat's last reply failed, until the next one starts. */
  failed?: boolean;
  /** A message of the person's waits for them to send it again or change it. */
  needsYou?: boolean;
  /** A document is being read. */
  reading?: boolean;
  /** The AI is working on a reply. */
  working?: boolean;
  /** A reply or a reading just finished, for a few seconds. */
  justDone?: boolean;
  /** A follow-up is due that the person hasn't seen yet. */
  newNotice?: boolean;
  /** The chat is new and empty. */
  emptyChat?: boolean;
}

const RULE: readonly [keyof Flags, ExpressionKey][] = [
  ["signedOut", "resting"],
  ["failed", "sorry"],
  ["needsYou", "question"],
  ["reading", "reading"],
  ["working", "thinking"],
  ["justDone", "done"],
  ["newNotice", "alert"],
  ["emptyChat", "hello"],
];

export function moodOf(flags: Flags): ExpressionKey {
  return RULE.find(([flag]) => flags[flag] === true)?.[1] ?? "calm";
}
