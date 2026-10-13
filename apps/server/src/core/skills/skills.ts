// Rufi's skills: the AI's instructions for each job, as standard SKILL.md
// files (a front matter with `name` and `description`, then the body). They
// ship with Rufi in this folder; the agent gets them as files in its own
// home, and Rufi's MCP server offers the same text as resources.
import { readdirSync, readFileSync } from "node:fs";

export interface Skill {
  name: string;
  /** When to read it: what the AI sees before it opens the file. */
  description: string;
  /** The whole SKILL.md, front matter included. */
  text: string;
}

const FRONT_MATTER = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/;

/** One skill's file, checked: its name is its folder's. */
function parseSkill(folder: string, text: string): Skill {
  const match = FRONT_MATTER.exec(text);
  if (match?.[1] !== folder || match[2] === undefined) {
    throw new Error(`The skill in ${folder} needs a name and a description.`);
  }
  return { name: match[1], description: match[2], text };
}

const here = new URL("./", import.meta.url);

/** Every skill Rufi ships, by name. */
export const SKILLS: readonly Skill[] = readdirSync(here, {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .map((name) =>
    parseSkill(name, readFileSync(new URL(`${name}/SKILL.md`, here), "utf8")),
  );
