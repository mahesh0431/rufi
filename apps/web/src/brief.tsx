// A visit brief's page: the AI's Markdown as it wrote it, dated, with the
// Sources Rufi built from the records it cites, and Copy. A brief never
// changes; when a later save changed the record, the page says so.
import type { Person } from "@rufi/contracts";
import type { Brief } from "@rufi/contracts/briefs";
import { Copy, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { printedTime } from "./dates.ts";
import { useBrief } from "./reads.ts";
import { Marked } from "./transcript.tsx";
import { Button, Problem } from "./ui.tsx";

export function BriefPage({
  person,
  briefId,
}: {
  person: Person;
  briefId: string;
}) {
  const brief = useBrief(person.id, briefId);
  return (
    <div className="mx-auto max-w-[790px] px-6 py-8">
      {brief.data === undefined ? (
        brief.error && (
          <Problem error={brief.error} retry={() => void brief.refetch()} />
        )
      ) : (
        <Shown brief={brief.data} person={person} />
      )}
    </div>
  );
}

function Shown({ brief, person }: { brief: Brief; person: Person }) {
  const made = `Made ${printedTime(brief.createdAt)}, from ${person.displayName}'s saved record`;
  return (
    <>
      <div className="mb-3.5 flex items-start gap-3">
        <div className="flex-1">
          <h2 className="text-[22px] font-bold">Visit brief</h2>
          <p className="text-muted">{made}</p>
        </div>
        <CopyButton text={() => asText(brief, made)} />
      </div>
      {brief.changedSince && (
        <p
          role="status"
          className="mb-3.5 flex items-start gap-2.5 rounded-lg border border-line bg-side px-3 py-2"
        >
          <Info size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          The record changed since this brief was made. The brief stays as it
          was; ask Rufi in the chat for a new one to include the changes.
        </p>
      )}
      <article
        aria-label="The brief"
        className="reply rounded-xl border border-line bg-surface px-5 py-4 [&>:first-child]:mt-0"
      >
        <Marked text={brief.markdown} links={false} />
      </article>
      <section aria-labelledby="sources" className="mt-6">
        <h3 id="sources" className="font-semibold">
          Sources
        </h3>
        <p className="mb-2 text-muted">
          The records this brief rests on, as Rufi has them saved.
        </p>
        <ol className="rounded-xl border border-line bg-surface">
          {brief.sources.map((source, index) => (
            <li
              // A brief's Sources never change.
              key={index}
              className="grid grid-cols-[110px_1fr] gap-x-3 border-t border-line px-3.5 py-2 first:border-t-0"
            >
              <span className="text-muted">{source.kind}</span>
              <span className="break-words">
                {source.what}
                {source.changedSince && (
                  <span className="ml-1.5 text-xs text-accent-ink">
                    changed since
                  </span>
                )}
              </span>
              <span className="col-start-2 text-xs break-words text-muted">
                {source.from}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

/** The brief as plain text, to paste anywhere: its date, the brief and its Sources. */
function asText(brief: Brief, made: string): string {
  const sources = brief.sources.map(
    (source) => `- ${source.kind}: ${source.what} (${source.from})`,
  );
  return [
    `Visit brief · ${made}`,
    brief.markdown,
    ["Sources", ...sources].join("\n"),
  ].join("\n\n");
}

function CopyButton({ text }: { text: () => string }) {
  const [said, setSaid] = useState<"Copied" | "Couldn't copy" | undefined>();
  // What happened shows for two seconds.
  useEffect(() => {
    if (said === undefined) return;
    const timer = setTimeout(() => {
      setSaid(undefined);
    }, 2_000);
    return () => {
      clearTimeout(timer);
    };
  }, [said]);
  return (
    <>
      <span role="status" className="self-center text-xs text-muted">
        {said}
      </span>
      <Button
        onClick={() => {
          navigator.clipboard.writeText(text()).then(
            () => {
              setSaid("Copied");
            },
            () => {
              setSaid("Couldn't copy");
            },
          );
        }}
      >
        <Copy size={14} aria-hidden />
        Copy
      </Button>
    </>
  );
}
