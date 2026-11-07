import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { rehypeVisuals, visualHtml } from "./visual-blocks.ts";

const VISUAL = '<svg viewBox="0 0 10 10"><circle r="4"/></svg>';

/** Each fence of a reply as the reply's parts see it: a visual, or code. */
function fences(text: string, streaming = true) {
  const pipeline = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeVisuals, { streaming });
  const tree = pipeline.runSync(pipeline.parse(text), text);
  const found: unknown[] = [];
  const visit = (node: Parameters<typeof visualHtml>[0]) => {
    if (node.tagName === "pre") {
      const visual = node.properties?.["dataVisual"];
      found.push(visual === undefined ? "code" : [visual, visualHtml(node)]);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return found;
}

describe("a reply's visuals", () => {
  it("draws a rufi-visual fence in its place once it closes, with its HTML as written", () => {
    const html = `${VISUAL}\n\n<style>circle{fill:var(--accent)}</style>`;
    const text = `Your HbA1c went down.\n\n\`\`\`rufi-visual\n${html}\n\`\`\`\n\nIt is now under 6.0 %.`;
    expect(fences(text)).toEqual([["draw", html]]);
  });

  it("waits while a visual is open, until its own closing fence or the reply's end", () => {
    expect(fences("Here:\n```rufi-visual\n<svg>")).toEqual([["wait", "<svg>"]]);
    expect(fences("Here:\n```rufi-visual\n<svg>", false)).toEqual([
      ["draw", "<svg>"],
    ]);
    // A shorter fence, or one of the other character, doesn't close it.
    expect(fences("````rufi-visual\n<p>\n```\n~~~~")).toEqual([
      ["wait", "<p>\n```\n~~~~"],
    ]);
    expect(fences("~~~rufi-visual extra\n<p>\n~~~~  ")).toEqual([
      ["draw", "<p>"],
    ]);
  });

  it("leaves every other fence as code, a rufi-visual shown as code inside one too, or inside a list", () => {
    for (const text of [
      "````markdown\n```rufi-visual\n<p>\n```\n````",
      "```html\n<p>\n```",
      "```rufi-visuals\n<p>\n```",
      "    ```rufi-visual\n    <p>",
      "- One:\n\n  ```rufi-visual\n  <p>\n  ```",
      "> ```rufi-visual\n> <p>\n> ```",
    ]) {
      expect(fences(text)).toEqual(["code"]);
    }
  });
});
