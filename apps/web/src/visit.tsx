// A Visit's page: the doctor's words as written, the records saved from it
// (From this visit), then its Sources and History as any record shows
// them. The page only shows: changes start in the chat, with Ask Rufi.
import type { Person } from "@rufi/contracts";
import type { RecordRow, ShownRow } from "@rufi/contracts/record";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { AskRufi } from "./ask.tsx";
import { askRufi } from "./panel.ts";
import { useRecordDetail } from "./reads.ts";
import {
  cellsOf,
  chipOf,
  nounOf,
  pageOf,
  RowDetail,
  visitTitle,
  visitWhen,
} from "./record.tsx";
import { Marked } from "./transcript.tsx";
import { buttonLook, EmptyState, ICON, Problem } from "./ui.tsx";

export function VisitPage({
  person,
  visitId,
}: {
  person: Person;
  visitId: string;
}) {
  const detail = useRecordDetail(person.id, "visit", visitId);
  if (detail.data === undefined) {
    return (
      <div className="mx-auto max-w-[790px] px-6 py-8">
        {detail.error && (
          <Problem error={detail.error} retry={() => void detail.refetch()} />
        )}
      </div>
    );
  }
  const { row, removed, fromVisit = [] } = detail.data;
  if ("problem" in row || row.kind !== "visit") {
    return (
      <div className="mx-auto max-w-[790px] px-6 py-8 text-muted italic">
        Can't show this visit.
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-[790px] px-6 py-8">
      <div className="mb-3.5">
        <h2 className="flex items-start gap-3 text-[22px] font-bold">
          <span className="min-w-0 flex-1">{visitTitle(row)}</span>
          <AskRufi
            onClick={() => {
              askRufi(person.id, [chipOf(row)]);
            }}
          />
        </h2>
        <p className="text-muted">{visitWhen(row)}</p>
      </div>
      {removed && (
        <p className="mb-3.5 text-muted">Removed from your health record.</p>
      )}
      <section aria-labelledby="words">
        <h3 id="words" className="mb-1 font-semibold">
          The doctor's words
        </h3>
        <article className="reply rounded-xl border border-line bg-surface px-5 py-4 [&>:first-child]:mt-0">
          <Marked text={row.as_written} links={false} />
        </article>
      </section>
      <section aria-labelledby="from-visit" className="mt-6">
        <h3 id="from-visit" className="mb-1 font-semibold">
          From this visit
        </h3>
        {fromVisit.length === 0 ? (
          <EmptyState>Nothing saved from this visit yet.</EmptyState>
        ) : (
          <ul className="rounded-xl border border-line bg-surface">
            {fromVisit.map((saved) => (
              <FromVisit
                key={`${saved.kind}:${saved.id}`}
                personId={person.id}
                row={saved}
              />
            ))}
          </ul>
        )}
      </section>
      <section className="mt-3 rounded-xl border border-line bg-surface">
        <RowDetail personId={person.id} row={row} />
      </section>
    </div>
  );
}

/** A record saved from the visit, with Open to its row on its page. */
function FromVisit({ personId, row }: { personId: string; row: ShownRow }) {
  if ("problem" in row) {
    return (
      <li className="border-t border-line px-3 py-2 text-muted italic first:border-t-0">
        Can't show this row.
      </li>
    );
  }
  const cells = cellsOf(row);
  return (
    <li className="flex items-center gap-2 border-t border-line px-3 py-2 first:border-t-0">
      <span className="w-28 shrink-0 text-muted">{nounOf(row)}</span>
      <span className="min-w-0 flex-1 font-semibold">{cells.title}</span>
      <span>{cells.status}</span>
      <OpenRow personId={personId} row={row} />
    </li>
  );
}

/** Open: the row on its page, opened (a follow-up on Follow-ups). */
function OpenRow({ personId, row }: { personId: string; row: RecordRow }) {
  const look = buttonLook({ look: "quiet" });
  const label = (
    <>
      <ArrowUpRight size={ICON} aria-hidden />
      Open
    </>
  );
  if (row.kind === "follow_up") {
    return (
      <Link
        to="/people/$personId/follow-ups"
        params={{ personId }}
        search={{ open: row.id }}
        className={look}
      >
        {label}
      </Link>
    );
  }
  const page = pageOf(row);
  if (!page) return null;
  return (
    <Link
      to="/people/$personId/record/$kind"
      params={{ personId, kind: page }}
      search={{ open: row.id }}
      className={look}
    >
      {label}
    </Link>
  );
}
