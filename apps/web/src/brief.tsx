// A visit brief's page: the AI's Markdown as it wrote it, dated, with the
// Sources Rufi built from the records it cites, each opening its record,
// Copy and View PDF. Under its title, where it came from (Rufi builds the
// line): made by Rufi's AI, on which day, from the record up to which save,
// and not medically validated, so a doctor reading it copied or as a PDF
// knows. View PDF shows the PDF Rufi makes of it (core/briefs/pdf.ts): on
// the Mac in a popup, in the iPhone app in Quick Look. A brief never
// changes; when a later save changed the record, the page says so.
import type { Person } from "@rufi/contracts";
import type { Brief, BriefSource } from "@rufi/contracts/briefs";
import { Link } from "@tanstack/react-router";
import { Copy, FileText, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { Dog } from "./dog.tsx";
import { FilePopup, FileShown } from "./documents.tsx";
import { onPhone, tell } from "./phone.ts";
import { useBrief } from "./reads.ts";
import { isPageKind } from "./record.tsx";
import { SettingsLink } from "./settings-link.tsx";
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
  const [pdf, setPdf] = useState(false);
  return (
    <>
      {/* On a phone, the buttons go under the title. */}
      <div className="mb-3.5 flex flex-wrap items-start gap-3">
        <span className="hidden pt-1 print:block">
          <Dog size={24} />
        </span>
        <div className="min-w-56 flex-1">
          <h2 className="text-[1.375rem] font-bold">Visit brief</h2>
          <p className="text-muted">{brief.origin}</p>
        </div>
        <div className="flex items-start gap-3 print:hidden">
          <CopyButton text={() => asText(brief)} />
          <Button
            icon={FileText}
            onClick={() => {
              // On a phone, the app shows it in Quick Look.
              if (onPhone) tell({ type: "brief_pdf", briefId: brief.id });
              else setPdf(true);
            }}
          >
            View PDF
          </Button>
        </div>
      </div>
      {pdf && (
        <FilePopup
          title={<b className="text-[0.875rem]">Visit brief · PDF</b>}
          close={() => {
            setPdf(false);
          }}
        >
          <FileShown
            path={`/api/people/${encodeURIComponent(person.id)}/briefs/${encodeURIComponent(brief.id)}/pdf`}
            mediaType="application/pdf"
            name="Visit brief.pdf"
          />
        </FilePopup>
      )}
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
              className="grid break-inside-avoid grid-cols-[110px_1fr] gap-x-3 border-t border-line px-3.5 py-2 first:border-t-0"
            >
              <span className="text-muted">{source.kind}</span>
              <span className="break-words">
                <Cited personId={person.id} source={source} />
                {source.changedSince && (
                  <span className="ml-1.5 text-xs text-muted">
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

/**
 * A source's record, as a link that opens it on its page (a result on the
 * page of its category, a "no known allergies" statement on Allergies, the
 * profile in Settings › Profile); as
 * words alone when it is no longer in the record.
 */
function Cited({
  personId,
  source: { what, record },
}: {
  personId: string;
  source: BriefSource;
}) {
  const look = "rounded-md text-accent-ink hover:bg-accent-soft";
  const page = record?.kind === "none_known" ? "allergy" : record?.kind;
  if (record && page === "follow_up") {
    return (
      <Link
        to="/people/$personId/follow-ups"
        params={{ personId }}
        search={{ open: record.id }}
        className={look}
      >
        {what}
      </Link>
    );
  }
  if (record && page === "visit") {
    return (
      <Link
        to="/people/$personId/visits/$visitId"
        params={{ personId, visitId: record.id }}
        className={look}
      >
        {what}
      </Link>
    );
  }
  if (record && page === "profile") {
    return (
      <SettingsLink group="profile" className={look}>
        {what}
      </SettingsLink>
    );
  }
  if (record && page && (page === "result" || isPageKind(page))) {
    return (
      <Link
        to="/people/$personId/record/$kind"
        params={{ personId, kind: page }}
        search={{ open: record.id }}
        className={look}
      >
        {what}
      </Link>
    );
  }
  return what;
}

/** The brief as plain text, to paste anywhere: where it came from, the brief and its Sources. */
function asText(brief: Brief): string {
  const sources = brief.sources.map(
    (source) => `- ${source.kind}: ${source.what} (${source.from})`,
  );
  return [
    `Visit brief\n${brief.origin}`,
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
      {/* Kept in place to be read out when it says something; while empty, it
          takes no room. */}
      <span
        role="status"
        className="self-center text-xs text-muted empty:-me-3"
      >
        {said}
      </span>
      <Button
        icon={Copy}
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
        Copy
      </Button>
    </>
  );
}
