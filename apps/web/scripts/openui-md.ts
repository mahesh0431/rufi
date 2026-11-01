// Writes openui.md, what Rufi AI is told about writing its reply in OpenUI
// Lang: the prompt OpenUI generates from Rufi's reply library
// (src/openui/library.ts). A test checks the committed copy.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replyPrompt } from "../src/openui/library.ts";

export const OPENUI_MD = join(
  import.meta.dirname,
  "../../server/src/core/chat/openui.md",
);

if (import.meta.main) await writeFile(OPENUI_MD, replyPrompt());
