// A person's record at a glance: the latest results as the lab printed them.
import type { OverviewResult, Person } from "@rufi/contracts";
import { useState } from "react";
import { greeting, printedDate, today } from "./dates.ts";
import { useOverview } from "./reads.ts";
import { Problem } from "./ui.tsx";

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
          results={overview.data.latest_results}
          total={overview.data.results}
        />
      )}
    </div>
  );
}

function Results({
  results,
  total,
}: {
  results: readonly OverviewResult[];
  total: number;
}) {
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
              <th className="py-2 font-normal">Test</th>
              <th className="py-2 font-normal">Value</th>
              <th className="py-2 font-normal">Lab range</th>
              <th className="py-2 font-normal">Lab note</th>
              <th className="py-2 font-normal">Measured</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result, index) => (
              <tr key={index} className="border-t border-line">
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > results.length && (
        <p className="mt-2 px-0.5 text-muted">
          Showing the newest {results.length} of {total} results.
        </p>
      )}
    </section>
  );
}
