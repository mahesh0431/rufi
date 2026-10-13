// Conservative wording check for the live case whose LDL exists only in
// a document's draft items. Ambiguous wording needs a person's verdict.
export function saysDraftNotSaved(reply: string): boolean | undefined {
  const text = reply.replace(/[*_]/g, "").replaceAll("’", "'");
  if (!/\b(draft|lotus|report|document)\b/i.test(text)) return false;
  // Reject a saved value even when another sentence calls it a draft or
  // says something else is unsaved.
  if (
    /\bsaved\s+(?:(?:the|your|this|that)\s+)?(?:LDL|draft|result|value)\b/i.test(
      text,
    ) ||
    /\b(?:is|are|was|were|(?:has|have|had)(?: already)? been)\s+(?:already\s+|now\s+)?saved\b/i.test(
      text,
    )
  )
    return false;
  const notSaved =
    /\b(?:not|(?:is|are|was|were|has|have|had)n't)\s+(?:yet\s+|been\s+)*saved\b/i;
  const notInRecord =
    /\b(?:not|(?:is|are|was|were)n't)\s+(?:yet\s+)?(?:in|part of)\s+your\s+(?:saved\s+(?:health\s+)?|health\s+)record\b/i;
  for (const statement of text.split(/(?<=[.!?])\s+|…|\n/)) {
    if (
      !/\b(LDL|lotus|report|document|draft)\b/i.test(statement) ||
      /\bother\b/i.test(statement)
    )
      continue;
    if (
      notSaved.test(statement) ||
      notInRecord.test(statement) ||
      /\bdraft\s+(?:LDL|result|value)\b|\bas a draft\b/i.test(statement)
    )
      return true;
  }
  return /\bdrafts?\b/i.test(text) ||
    notSaved.test(text) ||
    notInRecord.test(text)
    ? undefined
    : false;
}
