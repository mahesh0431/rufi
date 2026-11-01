import { readFile } from "node:fs/promises";
import { visualsPrompt } from "@rufi/contracts/visuals";
import { expect, it } from "vitest";
import { VISUALS_MD } from "./visuals-md.ts";

it("visuals.md matches the trend's components (run pnpm visuals:md)", async () => {
  expect(await readFile(VISUALS_MD, "utf8")).toBe(visualsPrompt());
});
