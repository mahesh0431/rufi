// The words of the AI's thinking line in Activity: what it is thinking
// about now.

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
