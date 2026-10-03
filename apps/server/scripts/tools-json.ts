// Writes tools.json from the tool registry. A test checks the committed copy.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toolsJson } from "../src/core/tools/tools.ts";

export const TOOLS_JSON = join(import.meta.dirname, "../tools.json");

if (import.meta.main) await writeFile(TOOLS_JSON, toolsJson());
