// How Rufi names documents and their pages in its words, the same in every
// module: a document's name, its pages as ranges, and what the AI is told of
// a deleted document.

/** A document's name for a person: its file, or "3 photos". */
export function documentName(files: readonly string[]): string {
  const distinct = [...new Set(files)];
  if (distinct.length <= 1) return distinct[0] ?? "A document";
  return `${String(distinct.length)} photos`;
}

/** Pages as "1–4, 6". */
export function ranges(positions: readonly number[]): string {
  const parts: [number, number][] = [];
  for (const p of [...positions].sort((a, b) => a - b)) {
    const last = parts.at(-1);
    if (last && last[1] === p - 1) last[1] = p;
    else parts.push([p, p]);
  }
  return parts
    .map(([a, b]) => (a === b ? String(a) : `${String(a)}–${String(b)}`))
    .join(", ");
}

/**
 * What the AI is told of a deleted document, wherever it meets one: its
 * instructions, its reads and a deleted chip. The same words everywhere.
 */
export const DELETED_DOCUMENT =
  "Its pages are unavailable: don't use or quote anything you read from them before, also when the user asks. Records saved from it are facts like any other until the user removes them: read them with get_records, as they are now, and say the original was deleted. A deleted file doesn't mean its records are wrong.";
