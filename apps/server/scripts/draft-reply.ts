// Whether a reply about a value that is only in a document's draft items
// says so. True: a sentence about the LDL or the document says it isn't
// saved, or calls it a draft. False: it answers from the record alone, or
// claims the value is saved. Undefined: code can't tell; a person judges.

/** It isn't saved, or isn't in the record. */
const NOT_SAVED =
  /\b(?:not|\w+n't)\s+(?:yet\s+|been\s+)*saved\b|\b(?:not|\w+n't)\s+(?:yet\s+)?(?:in|part of)\s+your\s+(?:saved\s+|health\s+)+record\b/i;
/** It is called a draft. */
const DRAFT = /\bdraft\s+(?:LDL|result|value)\b|\bas a draft\b/i;
/** It is said to be saved. */
const SAVED =
  /\bsaved\s+(?:(?:the|your|this|that)\s+)?(?:LDL|draft|result|value)\b|\b(?:is|are|was|were|been)\s+(?:already\s+|now\s+)?saved\b/i;

export function saysDraftNotSaved(reply: string): boolean | undefined {
  const text = reply.replace(/[*_]/g, "").replaceAll("’", "'");
  if (!/\b(?:draft|lotus|report|document)\b/i.test(text)) return false;
  // "saved" outside a denial ("no saved LDL", "no LDL … saved" are ones
  // too): a claim, or wording code can't judge.
  const rest = text
    .replace(new RegExp(NOT_SAVED, "gi"), "")
    .replace(/\bno\s+(?:saved\s+)?LDL\b[^.!?…]*/gi, "");
  if (SAVED.test(rest)) return false;
  if (/\bsaved\b/i.test(rest)) return undefined;
  for (const sentence of text.split(/(?<=[.!?])\s+|…|\n/)) {
    const about =
      /\b(?:LDL|lotus|report|document|draft)\b/i.test(sentence) &&
      !/\bother\b/i.test(sentence);
    if (about && (NOT_SAVED.test(sentence) || DRAFT.test(sentence))) {
      return true;
    }
  }
  return /\bdrafts?\b/i.test(text) || NOT_SAVED.test(text) ? undefined : false;
}
