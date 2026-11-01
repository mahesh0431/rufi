// Rufi's skills: the AI's instructions for each job, as standard SKILL.md
// files (a front matter with `name` and `description`, then the body). They
// ship with Rufi in this folder; the agent gets them as files in its own
// home, and Rufi's MCP server offers the same text as resources. A skill
// may carry other files beside its SKILL.md, from where they live.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export interface Skill {
  name: string;
  /** When to read it: what the AI sees before it opens the file. */
  description: string;
  /** The whole SKILL.md, front matter included. */
  text: string;
  /** Other files beside its SKILL.md, by name. */
  files: Readonly<Record<string, string>>;
}

const FRONT_MATTER = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/;

/** One skill's file, checked: its name is its folder's. */
function parseSkill(folder: string, text: string): Skill {
  const match = FRONT_MATTER.exec(text);
  if (match?.[1] !== folder || match[2] === undefined) {
    throw new Error(`The skill in ${folder} needs a name and a description.`);
  }
  return { name: match[1], description: match[2], text, files: {} };
}

const here = new URL("./", import.meta.url);
const require = createRequire(import.meta.url);

/** What a skill carries beside its SKILL.md, from where each file lives. */
const FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  analysis: {
    // Rufi paper, a look for the pages the AI makes: the brand package's.
    "paper.css": require.resolve("@rufi/brand/paper.css"),
    // How to write a trend, from its components (pnpm visuals:md).
    "visuals.md": fileURLToPath(new URL("analysis/visuals.md", here)),
  },
};

/** Every skill Rufi ships, by name. */
export const SKILLS: readonly Skill[] = readdirSync(here, {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .map((name) => ({
    ...parseSkill(
      name,
      readFileSync(new URL(`${name}/SKILL.md`, here), "utf8"),
    ),
    files: Object.fromEntries(
      Object.entries(FILES[name] ?? {}).map(([file, path]) => [
        file,
        readFileSync(path, "utf8"),
      ]),
    ),
  }));
