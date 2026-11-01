// Writes visuals.md, beside the analysis skill, from the components a reply's
// trend is made of (@rufi/contracts/visuals). A test checks the committed copy.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { visualsPrompt } from "@rufi/contracts/visuals";

export const VISUALS_MD = join(
  import.meta.dirname,
  "../src/core/skills/analysis/visuals.md",
);

if (import.meta.main) await writeFile(VISUALS_MD, visualsPrompt());
