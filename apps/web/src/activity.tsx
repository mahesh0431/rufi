// A step of a reply's Activity, opened: everything the AI's agent gave about
// it, read from the core when it opens (never sent with the chat), shown as
// it came. A command shows its command, folder, exit code, time and output;
// a tool call its arguments and result; anything else the agent's own JSON.
// Long text shows 12 lines, then all of it on request.
import { EntryDetails } from "@rufi/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { read } from "./api.ts";
import { chatPath } from "./live.ts";
import { Problem } from "./ui.tsx";

/** Lines a long output shows before "Show all". */
const FOLDED_LINES = 12;

/** A long line cut in its middle, so its start and its end (a file's name) show. */
export function middleCut(text: string, max = 64): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const head = Math.floor(max * 0.4);
  return `${line.slice(0, head)}…${line.slice(line.length - (max - head - 1))}`;
}

/** How long something took, from milliseconds: "0.4s", "9.1s", "1m 36s". */
export function took(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
}

/** The step's details, as the agent gave them; read again when it changes. */
export function StepDetails({
  personId,
  id,
  version,
}: {
  personId: string;
  id: string;
  /** When the step last changed: its details may have grown. */
  version: string;
}) {
  const details = useQuery({
    queryKey: ["entry", personId, id, version],
    queryFn: () =>
      read(
        EntryDetails,
        "GET",
        `${chatPath(personId)}/entries/${encodeURIComponent(id)}`,
      ),
  });
  if (details.error) {
    return (
      <Problem error={details.error} retry={() => void details.refetch()} />
    );
  }
  if (!details.data) return <p className="text-muted">Loading…</p>;
  const item = details.data.details;
  if (item === null || typeof item !== "object") {
    return <p className="text-muted">Rufi kept no details for this step.</p>;
  }
  return <Reported item={item as Record<string, unknown>} />;
}

const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown) =>
  typeof value === "number" ? value : undefined;
const json = (value: unknown) => JSON.stringify(value, null, 2);

function Reported({ item }: { item: Record<string, unknown> }) {
  const ms = number(item["durationMs"]);
  if (item["type"] === "commandExecution") {
    const exit = number(item["exitCode"]);
    const facts = [
      text(item["cwd"]) && `Folder: ${String(item["cwd"])}`,
      exit !== undefined && `Exit code: ${String(exit)}`,
      ms !== undefined && `Took ${took(ms)}`,
    ].filter(Boolean);
    const output = text(item["aggregatedOutput"]);
    return (
      <>
        <Folded label="Command" text={text(item["command"]) ?? ""} />
        {facts.length > 0 && <p>{facts.join(" · ")}</p>}
        {output && <Folded label="Output" text={output} />}
      </>
    );
  }
  if (item["type"] === "mcpToolCall") {
    const result = item["result"] as { content?: unknown } | null;
    const parts = Array.isArray(result?.content)
      ? (result.content as { type?: unknown; text?: unknown }[])
      : [];
    const said = parts.flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    );
    const error = (item["error"] as { message?: unknown } | null)?.message;
    return (
      <>
        <Folded label="Arguments" text={json(item["arguments"])} />
        {said.length > 0 && <Folded label="Result" text={said.join("\n\n")} />}
        {typeof error === "string" && <Folded label="Error" text={error} />}
        {ms !== undefined && <p>Took {took(ms)}</p>}
      </>
    );
  }
  return <Folded label="As the agent reported it" text={json(item)} />;
}

/** Text as it came, in a block: 12 lines, then all of it on request. */
function Folded({ label, text: whole }: { label: string; text: string }) {
  const [all, setAll] = useState(false);
  const lines = whole.split("\n");
  const long = lines.length > FOLDED_LINES;
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-ink">{label}</p>
      <pre className="mt-0.5 rounded-md bg-side px-2 py-1.5 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">
        {long && !all ? lines.slice(0, FOLDED_LINES).join("\n") : whole}
      </pre>
      {long && (
        <button
          type="button"
          onClick={() => {
            setAll(!all);
          }}
          className="mt-0.5 cursor-pointer text-xs text-accent-ink underline"
        >
          {all ? "Show less" : `Show all ${String(lines.length)} lines`}
        </button>
      )}
    </div>
  );
}
