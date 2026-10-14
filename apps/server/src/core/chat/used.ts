// Used: the reads of the health record in one reply, built each time it is
// shown from Rufi's own record of each call to its read tools, never stored
// apart: exact whatever the agent reports. Only calls Rufi answered are
// here; a read cut off before its answer is a stopped step in Activity.
// Commands, web pages and sub-agents are in Activity only.
import type { Read } from "@rufi/contracts";
import { shownFor } from "../tools/registry.ts";
import { TOOLS } from "../tools/tools.ts";

/** A call to one of Rufi's tools, as tool_calls keeps it (its JSON read in SQL). */
export interface Call {
  tool: string;
  ok: number;
  /** What the AI sent (JSON). */
  input: string;
  /** From the answer: records given back, whether all of them, the error. */
  returned: number | null;
  complete: number | null;
  error: string | null;
}

/** The reply's reads, in the order Rufi got the calls; saves are left out. */
export const usedOf = (calls: readonly Call[]): Read[] =>
  calls.flatMap((call) => fromCall(call) ?? []);

function fromCall(call: Call): Read | undefined {
  const tool = TOOLS.find((candidate) => candidate.name === call.tool);
  // A save, or a call to no tool at all: nothing was read.
  if (!tool?.readOnly) return undefined;
  const title = shownFor(tool, sent(call.input));
  if (call.ok === 0) return { title, outcome: "failed", note: call.error };
  const count =
    call.returned === null
      ? null
      : `${String(call.returned)} ${call.returned === 1 ? "record" : "records"}`;
  if (call.complete === 0) {
    return {
      title,
      outcome: "capped",
      note: `${count ?? "Some records"} · capped: more came after these`,
    };
  }
  return { title, outcome: "done", note: count };
}

/** What the AI sent, or nothing when it wasn't JSON. */
function sent(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}
