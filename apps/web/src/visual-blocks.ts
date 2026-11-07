// A reply's text in its parts: Markdown, and the visuals in it (ADR 0034).
// A visual is a fenced code block whose info string starts with the word
// `rufi-visual`, at the reply's top level, as CommonMark reads a fence: up to
// three spaces, then three or more backticks or tildes, closed by a line of
// the same character, at least as many, and nothing else. Any other fence
// stays in the Markdown, with whatever it holds, so a visual's fence shown
// as code is never taken for a visual. A visual is whole once its closing
// fence is in the text; one still open runs to the end, as a fence does.
export type ReplyPart =
  | { kind: "markdown"; text: string }
  | { kind: "visual"; html: string; whole: boolean };

const OPENING = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function replyParts(text: string): ReplyPart[] {
  const lines = text.split("\n");
  const parts: ReplyPart[] = [];
  let markdown: string[] = [];
  const flush = () => {
    if (markdown.length > 0)
      parts.push({ kind: "markdown", text: markdown.join("\n") });
    markdown = [];
  };
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? "";
    const opening = OPENING.exec(line);
    const fence = opening?.[1] ?? "";
    const info = (opening?.[2] ?? "").trim();
    // A backtick fence's info string has no backtick: that is inline code.
    if (opening === null || (fence.startsWith("`") && info.includes("`"))) {
      markdown.push(line);
      at += 1;
      continue;
    }
    const closing = new RegExp(
      `^ {0,3}${fence[0] === "`" ? "`" : "~"}{${String(fence.length)},}\\s*$`,
    );
    let end = at + 1;
    while (end < lines.length && !closing.test(lines[end] ?? "")) end += 1;
    if (info.split(/\s+/)[0] !== "rufi-visual") {
      markdown.push(...lines.slice(at, end + 1));
    } else {
      flush();
      parts.push({
        kind: "visual",
        html: lines.slice(at + 1, end).join("\n"),
        whole: end < lines.length,
      });
    }
    at = end + 1;
  }
  flush();
  return parts;
}
