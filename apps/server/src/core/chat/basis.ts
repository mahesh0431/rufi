// What an answer rests on (Basis): the AI ends a reply with a fenced code
// block tagged `rufi-basis` holding How. The reply is stored as it came; this
// one rule splits it when it is read, on the Markdown tree, never by reading
// the words: every block tagged exactly `rufi-basis` leaves the answer, and
// the last one is How.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

type Node = ReturnType<typeof fromMarkdown>["children"][number];
type Code = Extract<Node, { type: "code" }>;

/** The info string that marks How. */
const BASIS_TAG = "rufi-basis";

/**
 * A reply as it is shown: the answer without its rufi-basis blocks, and the
 * How of the last one. A reply that hasn't finished (still streaming, or
 * stopped) also loses a fence opening it was cut in, such as "```rufi-ba",
 * so no half block shows.
 */
export function splitBasis(
  text: string,
  finished: boolean,
): { answer: string; how: string | undefined } {
  const blocks: Code[] = [];
  const visit = (node: Node | ReturnType<typeof fromMarkdown>) => {
    if (node.type === "code" && node.lang === BASIS_TAG && !node.meta) {
      blocks.push(node);
      return;
    }
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(
    fromMarkdown(text, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }),
  );
  let answer = text;
  for (const block of blocks.toReversed()) {
    const start = block.position?.start.offset ?? 0;
    const end = block.position?.end.offset ?? start;
    answer = answer.slice(0, start) + answer.slice(end);
  }
  answer = answer.trimEnd();
  if (!finished) answer = withoutOpening(answer);
  const how = blocks.at(-1)?.value.trim();
  return { answer, how: how === "" ? undefined : how };
}

/**
 * The text without a last line that may be the start of a rufi-basis fence:
 * backticks or tildes, then nothing or the start of the tag.
 */
function withoutOpening(text: string): string {
  const cut = text.lastIndexOf("\n") + 1;
  const last = /^ {0,3}(`+|~+)(.*)$/.exec(text.slice(cut));
  if (!last || !BASIS_TAG.startsWith((last[2] ?? "").trim())) return text;
  return text.slice(0, cut).trimEnd();
}
