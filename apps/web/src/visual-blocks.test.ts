import { describe, expect, it } from "vitest";
import { replyParts } from "./visual-blocks.ts";

const VISUAL = '<svg viewBox="0 0 10 10"><circle r="4"/></svg>';

describe("a reply's visuals", () => {
  it("takes a rufi-visual fence out of the Markdown, in its place, whole once it closes", () => {
    const text = [
      "Your HbA1c went down.",
      "",
      "```rufi-visual",
      VISUAL,
      "",
      "<style>circle{fill:var(--accent)}</style>",
      "```",
      "",
      "It is now under 6.0 %.",
    ].join("\n");
    expect(replyParts(text)).toEqual([
      { kind: "markdown", text: "Your HbA1c went down.\n" },
      {
        kind: "visual",
        html: `${VISUAL}\n\n<style>circle{fill:var(--accent)}</style>`,
        whole: true,
      },
      { kind: "markdown", text: "\nIt is now under 6.0 %." },
    ]);
  });

  it("keeps a visual open until its own closing fence, as it is written", () => {
    expect(replyParts("Here:\n```rufi-visual\n<svg>")).toEqual([
      { kind: "markdown", text: "Here:" },
      { kind: "visual", html: "<svg>", whole: false },
    ]);
    // A shorter fence, or one of the other character, doesn't close it.
    expect(replyParts("````rufi-visual\n<p>\n```\n~~~~")).toEqual([
      { kind: "visual", html: "<p>\n```\n~~~~", whole: false },
    ]);
  });

  it("leaves every other fence in the Markdown, a rufi-visual shown as code inside one too", () => {
    const shown = "````markdown\n```rufi-visual\n<p>\n```\n````";
    expect(replyParts(shown)).toEqual([{ kind: "markdown", text: shown }]);
    for (const text of [
      "```html\n<p>\n```",
      "```rufi-visuals\n<p>\n```",
      "    ```rufi-visual\n    <p>",
      "``` rufi-visual ` \n<p>\n```",
    ]) {
      expect(replyParts(text)).toEqual([{ kind: "markdown", text }]);
    }
  });
});
