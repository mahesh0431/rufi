// Used: what Rufi saw the AI read in one reply, built from that reply's own
// saved activity each time it is shown, never stored apart. Reads of the
// record come from Rufi's own record of each call to its tools, so they are
// exact whatever the agent reports; the rest from the reply's activity lines.
import type { Read } from "@rufi/contracts";
import { shownFor } from "../tools/registry.ts";
import { TOOLS } from "../tools/tools.ts";

/** A call to one of Rufi's tools, as tool_calls keeps it (its JSON read in SQL). */
export interface Call {
  call_id: string;
  tool: string;
  ok: number;
  /** What the AI sent (JSON). */
  input: string;
  /** From the answer: records given back, whether all of them, the error. */
  returned: number | null;
  complete: number | null;
  error: string | null;
}

/** An activity line, as transcript_entries keeps it. */
export interface Line {
  agent_item_id: string | null;
  activity: string | null;
  text: string;
  detail: string | null;
  status: string | null;
  /** 1 when the agent gave what the activity sent and got back. */
  captured: number;
}

/** The kinds of activity that read something; changing files reads nothing. */
const READS = new Set(["tool", "command", "web_search", "sub_agent"]);

/**
 * The reply's reads in the order they happened: each activity line, or the
 * calls to Rufi's tools it stands for (same id), then any call no line
 * stands for. Saves are left out: their receipts show them.
 */
export function usedOf(lines: readonly Line[], calls: readonly Call[]): Read[] {
  const used: Read[] = [];
  const shown = new Set<Call>();
  const add = (call: Call) => {
    shown.add(call);
    const read = fromCall(call);
    if (read) used.push(read);
  };
  for (const line of lines) {
    const own = calls.filter((call) => call.call_id === line.agent_item_id);
    if (own.length > 0) own.forEach(add);
    else if (line.activity !== null && READS.has(line.activity)) {
      used.push(fromLine(line));
    }
  }
  for (const call of calls) if (!shown.has(call)) add(call);
  return used;
}

function fromCall(call: Call): Read | undefined {
  const tool = TOOLS.find((candidate) => candidate.name === call.tool);
  // A save, or a call to no tool at all: nothing was read.
  if (!tool?.readOnly) return undefined;
  // The same words as the call's activity line: "Read your results in 2026".
  const read = { title: shownFor(tool, sent(call.input)), detail: null };
  if (call.ok === 0) return { ...read, outcome: "failed", note: call.error };
  const count =
    call.returned === null
      ? null
      : `${String(call.returned)} ${call.returned === 1 ? "record" : "records"}`;
  if (call.complete === 0) {
    return {
      ...read,
      outcome: "capped",
      note: `${count ?? "Some records"} · capped: more came after these`,
    };
  }
  return { ...read, outcome: "done", note: count };
}

/** What the AI sent, or nothing when it wasn't JSON. */
function sent(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function fromLine(line: Line): Read {
  const outcome =
    line.status === "failed"
      ? "failed"
      : line.status === "done"
        ? line.captured === 1
          ? "done"
          : "unknown"
        : "stopped";
  return {
    title: line.text,
    detail: line.detail,
    outcome,
    note:
      outcome === "unknown"
        ? "The AI's agent didn't say what came back."
        : null,
  };
}
