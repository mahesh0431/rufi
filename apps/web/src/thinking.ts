// The words of the AI's thinking line: what it is thinking about now, and
// how long it thought.

/**
 * The latest heading of a reasoning summary (a paragraph that starts in
 * bold), else its first line, without the bold.
 */
export function latestHeading(summary: string): string {
  const paragraphs = summary
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const line =
    (
      paragraphs.findLast((paragraph) => paragraph.startsWith("**")) ??
      paragraphs[0] ??
      ""
    ).split("\n")[0] ?? "";
  return line.replaceAll("**", "").trim();
}

/** "Thought for 8 s", from when the thinking started to when it ended. */
export function thoughtFor(from: string, to: string): string {
  const seconds = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (seconds < 1) return "Thought briefly";
  if (seconds < 60) return `Thought for ${String(seconds)} s`;
  const rest = seconds % 60;
  return `Thought for ${String(Math.floor(seconds / 60))} min${rest > 0 ? ` ${String(rest)} s` : ""}`;
}
