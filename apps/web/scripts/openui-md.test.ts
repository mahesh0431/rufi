import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { replyPrompt } from "../src/openui/library.ts";
import { OPENUI_MD } from "./openui-md.ts";

it("openui.md matches the reply library (run pnpm openui:md)", async () => {
  expect(await readFile(OPENUI_MD, "utf8")).toBe(replyPrompt());
});
