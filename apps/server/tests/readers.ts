// Rufi AI has a file read, on the scripted Codex (tests/fake-codex.ts): its
// turn on `message` starts a reader for the document Rufi's note names, the
// reader saves `pages` of it, and the reader's result wakes Rufi AI, which
// makes `then` (its sort). Each call has an id of its own, as Codex gives
// them; a second reading in a test needs another message and title.
import type { Scenario } from "./fake-codex.ts";

type Calls = NonNullable<Scenario["calls"]>;

/** A page as a reader saves it with save_reading. */
export interface ReaderPage {
  page: number;
  outcome: "read" | "unreadable" | "nothing_here";
  copy: string;
  why?: string;
}

/** The scripted calls of one reading: Scenario's callsByText. */
export function readThen(
  message: string,
  pages: readonly ReaderPage[],
  then: Calls = [],
  title = "Reading",
): Record<string, Calls> {
  return {
    [message]: [
      {
        id: `start-${title}`,
        tool: "start_agent",
        arguments: {
          title,
          task: `${title}: read (document $document) with the reading-documents skill.`,
          tools: ["get_documents", "save_reading"],
        },
      },
    ],
    [`${title}: read`]: [
      {
        id: `save-${title}`,
        tool: "save_reading",
        arguments: { document: "$document", pages },
      },
    ],
    [`${title} (`]: then,
  };
}

/** A page of the fictional report as a reader copies it. */
export const readOf = (page: number, value = "13.2"): ReaderPage => ({
  page,
  outcome: "read",
  copy: `# Sunrise Labs\n\nCollected: 12 Aug 2026\n\n| Test | Result | Unit | Range |\n| --- | --- | --- | --- |\n| Haemoglobin | ${value} | g/dL | 12.0-15.0 |`,
});
