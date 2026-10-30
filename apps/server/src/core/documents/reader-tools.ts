// What every reader has: its tools' caller, bound by code to one run (one
// person, one document, the job's current attempt), and how server/reader.ts
// runs a reader. Rufi's reader copies pages (copy-reader.ts).
import type { Log } from "../../platform/logs.ts";
import { specOf, toolCaller, type Tool } from "../tools/registry.ts";
import type { Run } from "./notebook.ts";

/** A reader's tools for one run: their catalog for its MCP endpoint, and its caller. */
export function readerCaller(run: Run, tools: readonly Tool[], log: Log) {
  return {
    specs: tools.map(specOf),
    call: toolCaller(
      tools,
      () => ({ store: undefined, personId: run.personId }),
      log,
    ),
  };
}

/** What a reader's run gets from the reading: as readings.about tells it. */
interface About {
  /** The display name of the person the document was added for. */
  person: string;
  pages: number;
  files: readonly string[];
  targets: readonly number[];
  /** Targets this job saved in an earlier run. */
  saved: readonly number[];
}

/**
 * How a reader reads (server/reader.ts runs it): its instructions, its
 * message for a run, its tools bound to the run, and the version stored
 * with a reading. Rufi's reader copies pages (copy-reader.ts).
 */
export interface ReaderKind {
  instructions: string;
  input: (about: About) => string;
  tools: (run: Run, log: Log) => ReturnType<typeof readerCaller>;
  version: object;
}
