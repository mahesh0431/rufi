// A reply's visuals, found in its one Markdown document (ADR 0034). A visual
// is a fenced code block whose info string starts with the word
// `rufi-visual`, at the reply's top level, as CommonMark reads it. Any other
// fence stays code, with whatever it holds, so a visual's fence shown as code
// is never taken for a visual. A visual is whole once its closing fence, of
// the same character and at least as long, is in the text; one still open
// runs to the end, as a fence does.
//
// A rehype step marks each visual's `pre` with `data-visual`: "draw" once
// it is whole or the reply ended, else "wait". The reply's `pre` part draws
// it from there, so the reply stays one document: a link before a visual
// still finds its definition after it.

/** The little of a hast node this step reads and marks. */
interface Node {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  value?: string;
  position?: {
    start: { offset?: number | undefined };
    end: { offset?: number | undefined };
  };
}

const OPENING = /^ {0,3}(`{3,}|~{3,})/;

/** Whether a fence, as written, ends with its own closing line. */
function closes(source: string): boolean {
  const lines = source.split("\n");
  const fence = OPENING.exec(lines[0] ?? "")?.[1];
  if (fence === undefined || lines.length < 2) return false;
  const closing = new RegExp(
    `^ {0,3}${fence[0] === "`" ? "`" : "~"}{${String(fence.length)},}[ \\t]*$`,
  );
  return closing.test(lines.at(-1) ?? "");
}

const isVisual = (code: Node | undefined) =>
  code?.type === "element" &&
  code.tagName === "code" &&
  Array.isArray(code.properties?.["className"]) &&
  code.properties["className"].includes("language-rufi-visual");

/** The visual's HTML: its code's text, as the fence holds it. */
export const visualHtml = (pre: Node) =>
  (pre.children?.[0]?.children ?? [])
    .map((text) => text.value ?? "")
    .join("")
    .replace(/\n$/, "");

/** The rehype step: `streaming` while the reply is still being written. */
export function rehypeVisuals({ streaming }: { streaming: boolean }) {
  return (tree: Node, file: { value: unknown }) => {
    const source = String(file.value);
    for (const node of tree.children ?? []) {
      if (node.tagName !== "pre" || !isVisual(node.children?.[0])) continue;
      const { start, end } = node.position ?? { start: {}, end: {} };
      const whole =
        !streaming ||
        (start.offset !== undefined &&
          end.offset !== undefined &&
          closes(source.slice(start.offset, end.offset)));
      node.properties = {
        ...node.properties,
        dataVisual: whole ? "draw" : "wait",
      };
    }
  };
}
