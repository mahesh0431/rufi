// A person's record at a glance: the latest results as the lab printed them.
// A result goes into the chat as a chip: "+ Add to chat" on its row, or
// several ticked at once.
import type { OverviewResult, Person } from "@rufi/contracts";
import { useState } from "react";
import { boxFor } from "./boxes.ts";
import { useShowChat } from "./panel.ts";
import { greeting, printedDate, today } from "./dates.ts";
import type { BoxChip } from "./draft.ts";
import { useOverview } from "./reads.ts";
import { Button, Problem } from "./ui.tsx";

export function OverviewPage({ person }: { person: Person }) {
  const overview = useOverview(person.id);
  // The greeting and date as the page opened.
  const [now] = useState(() => new Date());
  return (
    <div className="mx-auto max-w-[790px] px-6 py-8">
      <p className="text-muted">{today(now)}</p>
      <h1 className="mb-6 text-[22px] font-bold">
        {greeting(now)}, {person.displayName}
      </h1>
      {overview.data === undefined && overview.error ? (
        <Problem error={overview.error} retry={() => void overview.refetch()} />
      ) : overview.data === undefined ? null : overview.data.results === 0 ? (
        <p className="text-muted">
          Your latest results will be shown here when your record has some.
        </p>
      ) : (
        <Results
          personId={person.id}
          results={overview.data.latest_results}
          total={overview.data.results}
        />
      )}
    </div>
  );
}

/** A result as a chip: what the row shows. */
const chipOf = (result: OverviewResult): BoxChip => ({
  pointer: { type: "record", kind: "result", id: result.id },
  label: [result.test, result.value, result.unit].filter(Boolean).join(" "),
  detail: "Result in your record",
});

function Results({
  personId,
  results,
  total,
}: {
  personId: string;
  results: readonly OverviewResult[];
  total: number;
}) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const showChat = useShowChat(personId);
  const addToChat = (chosen: readonly OverviewResult[]) => {
    if (boxFor(personId).append("", chosen.map(chipOf))) {
      setTicked(new Set());
      setProblem(null);
      showChat();
    } else {
      setProblem("A message is being sent: add these again in a moment.");
    }
  };
  const selecting = ticked.size > 0;
  return (
    <section aria-labelledby="latest">
      <h2 id="latest" className="mb-2 px-0.5 font-semibold">
        Latest results{" "}
        <span className="font-normal text-muted">as printed by the lab</span>
      </h2>
      <div className="rounded-xl border border-line bg-surface px-3">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="w-7 py-2 font-normal">
                <span className="sr-only">Choose</span>
              </th>
              <th className="py-2 font-normal">Test</th>
              <th className="py-2 font-normal">Value</th>
              <th className="py-2 font-normal">Lab range</th>
              <th className="py-2 font-normal">Lab note</th>
              <th className="py-2 font-normal">Measured</th>
              <th className="py-2 font-normal">
                <span className="sr-only">Add to chat</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => {
              const on = ticked.has(result.id);
              return (
                <tr
                  key={result.id}
                  className={`group border-t border-line ${on ? "bg-accent-soft" : "hover:bg-side"}`}
                >
                  <td className="py-2.5">
                    <input
                      type="checkbox"
                      aria-label={`Choose ${result.test}`}
                      checked={on}
                      onChange={() => {
                        const next = new Set(ticked);
                        if (on) next.delete(result.id);
                        else next.add(result.id);
                        setTicked(next);
                      }}
                      className={`size-[15px] accent-accent ${selecting ? "" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"}`}
                    />
                  </td>
                  <td className="py-2.5">
                    <span className="font-semibold">{result.test}</span>
                    {result.amended && (
                      <span className="text-muted"> amended</span>
                    )}
                  </td>
                  <td className="py-2.5">
                    {[result.value, result.unit].filter(Boolean).join(" ")}
                  </td>
                  <td className="py-2.5">{result.range}</td>
                  <td className="py-2.5">{result.flag}</td>
                  <td className="py-2.5">
                    {[
                      result.measured && printedDate(result.measured),
                      result.context,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                  <td className="py-2.5 text-right">
                    {!selecting && (
                      <button
                        type="button"
                        onClick={() => {
                          addToChat([result]);
                        }}
                        className="rounded-lg border border-line bg-surface px-2 py-px text-xs whitespace-nowrap text-accent-ink opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100"
                      >
                        + Add to chat
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {total > results.length && (
        <p className="mt-2 px-0.5 text-muted">
          Showing the newest {results.length} of {total} results.
        </p>
      )}
      {problem !== null && (
        <p role="alert" className="mt-2 px-0.5 text-muted">
          {problem}
        </p>
      )}
      {selecting && (
        <div className="sticky bottom-20 mt-3 flex items-center gap-2.5 rounded-xl bg-surface px-3 py-2 shadow-float">
          <span className="flex-1 font-semibold">{ticked.size} chosen</span>
          <Button
            onClick={() => {
              setTicked(new Set());
            }}
          >
            Clear
          </Button>
          <Button
            look="main"
            onClick={() => {
              addToChat(results.filter((r) => ticked.has(r.id)));
            }}
          >
            Add {ticked.size} to chat
          </Button>
        </div>
      )}
    </section>
  );
}
