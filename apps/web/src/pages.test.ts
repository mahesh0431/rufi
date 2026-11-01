import { expect, test } from "vitest";
import { pageOf } from "./pages.ts";

// Codex's report is covered on the screen (e2e/reading.spec.ts); Claude's,
// as the adapter keeps it (claude/adapter.ts), here.
test("a Claude step shows the page its get_documents result had as an image, and a Read of a picture none", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png" },
  };
  expect(
    pageOf({
      use: {
        type: "tool_use",
        name: "mcp__rufi__get_documents",
        input: { document: "doc-1", page: 2 },
      },
      result: {
        type: "tool_result",
        content: [image, { type: "text", text: "{}" }],
      },
    }),
  ).toEqual({ document: "doc-1", page: 2, full: false });
  expect(
    pageOf({
      use: {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/a/dot.png" },
      },
      result: { type: "tool_result", content: [image] },
    }),
  ).toBeUndefined();
});
