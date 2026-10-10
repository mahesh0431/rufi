// A kind's page of the person's record: newest first, in groups as the paper
// has them (a report whole, a day of results typed in the chat, or one row
// each for the other kinds), more as the person scrolls. A row opens in
// place to its sources, its history and, for a result, its values over
// time. The page only shows: changes start in the chat, with Ask Rufi on a
// row, or several ticked at once.
import type { Person } from "@rufi/contracts";
import type {
  PageKind,
  RecordChange,
  RecordGroup,
  RecordRow,
  ShownRow,
} from "@rufi/contracts/record";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { boxFor } from "./boxes.ts";
import { printedDate, printedTime } from "./dates.ts";
import type { BoxChip } from "./draft.ts";
import { useShowChat } from "./panel.ts";
import { useRecordDetail, useRecordPages, useSeries } from "./reads.ts";
import { Button, Problem } from "./ui.tsx";

/** The kinds with a page, in the sidebar's order, by their page title. */
export const KIND_TITLES: Record<PageKind, string> = {
  result: "Results",
  medicine_use: "Medicines",
  prescription: "Prescriptions",
  condition: "Conditions",
  allergy: "Allergies",
  symptom: "Symptoms",
  care_event: "Care events",
};

export const isPageKind = (kind: string): kind is PageKind =>
  Object.hasOwn(KIND_TITLES, kind);

const NOUNS: Record<RecordRow["kind"], string> = {
  result: "Result",
  medicine_use: "Medicine",
  prescription: "Prescription",
  condition: "Condition",
  allergy: "Allergy",
  symptom: "Symptom",
  care_event: "Care event",
  none_known: "Statement",
  follow_up: "Follow-up",
};

const isBad = (row: ShownRow): row is Exclude<ShownRow, RecordRow> =>
  "problem" in row;

const join = (...parts: (string | undefined | false)[]) =>
  parts.filter((part) => typeof part === "string" && part !== "").join(" ");

const dated = (when?: { date: string }) =>
  when === undefined ? undefined : printedDate(when.date.slice(0, 10));

/** From one date to another, as known. */
const span = (from?: { date: string }, to?: { date: string }) =>
  from && to
    ? `${dated(from) ?? ""} to ${dated(to) ?? ""}`
    : from
      ? `since ${dated(from) ?? ""}`
      : to
        ? `until ${dated(to) ?? ""}`
        : undefined;

const STATUS: Record<string, string> = {
  current: "Taking now",
  paused: "Paused",
  stopped: "Stopped",
  completed: "Completed",
  ongoing: "Ongoing",
  resolved: "Resolved",
  active: "Active",
  inactive: "Inactive",
  planned: "Planned",
  done: "Done",
  not_done: "Not done",
  open: "Open",
  dropped: "Dropped",
};

interface Cells {
  /** What the row is, as its chip names it. */
  title: string;
  /** A word after the title. */
  note?: string;
  detail?: string;
  status?: string;
  date?: string;
}

/** A row's cells; `groupDate`: the group's date, not shown again on its rows. */
function cellsOf(row: RecordRow, groupDate?: string): Cells {
  switch (row.kind) {
    case "result": {
      const measured = row.measured?.date.slice(0, 10);
      return {
        title: join(row.test, row.value, row.unit),
        ...(row.replaces !== undefined && { note: "amended" }),
        ...(row.range !== undefined && { detail: row.range }),
        status: [row.flag, row.context].filter(Boolean).join(" · "),
        // Only a date that differs from its group's.
        ...(measured !== undefined &&
          measured !== groupDate && { date: printedDate(measured) }),
      };
    }
    case "medicine_use":
      return {
        title: join(row.name, row.strength),
        detail: [row.amount, row.schedule].filter(Boolean).join(" · "),
        status: STATUS[row.status] ?? "",
        date: span(row.started, row.ended) ?? "",
      };
    case "prescription":
      return {
        title: join(row.item, row.strength),
        detail: [row.amount, row.schedule, row.period]
          .filter(Boolean)
          .join(" · "),
        status: row.prescriber ?? "",
        date: dated(row.issued) ?? "",
      };
    case "symptom":
      return {
        title: row.name,
        detail: [row.severity, row.location].filter(Boolean).join(" · "),
        status: STATUS[row.status] ?? "",
        date: span(row.onset, row.ended) ?? "",
      };
    case "condition":
      return {
        title: row.name,
        detail: row.certainty === "unknown" ? "" : row.certainty,
        status: STATUS[row.status] ?? "",
        date: dated(row.recognised) ?? "",
      };
    case "allergy":
      return {
        title: row.substance,
        detail: row.reaction ?? "",
        status: STATUS[row.status] ?? "",
        date: dated(row.reacted) ?? "",
      };
    case "care_event":
      return {
        title: row.name,
        detail: [row.type, row.provider].filter(Boolean).join(" · "),
        status: STATUS[row.status] ?? "",
        date: dated(row.date) ?? "",
      };
    case "none_known":
      return {
        title: "No known allergies",
        date:
          row.asserted === undefined
            ? ""
            : `as of ${printedDate(row.asserted)}`,
      };
    case "follow_up":
      return {
        title: row.title,
        detail: row.outcome ?? "",
        status: STATUS[row.status] ?? "",
        date:
          row.due === undefined
            ? ""
            : row.due === "next_visit"
              ? "at the next visit"
              : (dated(row.due) ?? ""),
      };
  }
}

/** A row as a chip in the chat box. */
export const chipOf = (row: RecordRow): BoxChip => ({
  pointer: { type: "record", kind: row.kind, id: row.id },
  label: cellsOf(row).title,
  detail: `${NOUNS[row.kind]} in your record`,
});

/** A group's heading: a report, results typed in the chat, or no date. */
function groupHeading(group: RecordGroup) {
  const when = group.date === undefined ? undefined : printedDate(group.date);
  const count = `${String(group.rows.length)} ${group.rows.length === 1 ? "result" : "results"}`;
  if (group.type === "report") {
    return {
      name: group.issuer ?? "Report",
      detail: [when ?? "no date", count].join(" · "),
    };
  }
  if (when === undefined) return { name: "No date", detail: count };
  return { name: "Typed in the chat", detail: `${when} · ${count}` };
}

export function RecordPage({
  person,
  kind,
}: {
  person: Person;
  kind: PageKind;
}) {
  const pages = useRecordPages(person.id, kind);
  const [open, setOpen] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const showChat = useShowChat(person.id);
  const more = useRef<HTMLButtonElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;

  // More load as the end of the list comes into view.
  useEffect(() => {
    const end = more.current;
    if (!end || !hasNextPage) return;
    const seen = new IntersectionObserver((entries) => {
      if (
        entries.some((entry) => entry.isIntersecting) &&
        !isFetchingNextPage
      ) {
        void fetchNextPage();
      }
    });
    seen.observe(end);
    return () => {
      seen.disconnect();
    };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const addToChat = (rows: readonly RecordRow[]) => {
    if (boxFor(person.id).append("", rows.map(chipOf))) {
      setTicked(new Set());
      setProblem(null);
      showChat();
    } else {
      setProblem("A message is being sent: add these again in a moment.");
    }
  };
  const tick = (row: RecordRow) => {
    const next = new Set(ticked);
    if (next.has(row.id)) next.delete(row.id);
    else next.add(row.id);
    setTicked(next);
  };

  if (pages.data === undefined) {
    return (
      <div className="mx-auto max-w-[790px] px-6 py-8">
        {pages.error && (
          <Problem error={pages.error} retry={() => void pages.refetch()} />
        )}
      </div>
    );
  }
  const groups = pages.data.pages.flatMap((page) => page.groups);
  const results = kind === "result";
  const row = (shown: ShownRow, groupDate?: string) => (
    <RowView
      key={`${shown.kind}:${shown.id}`}
      personId={person.id}
      row={shown}
      groupDate={groupDate}
      open={open === `${shown.kind}:${shown.id}`}
      onOpen={() => {
        const key = `${shown.kind}:${shown.id}`;
        setOpen(open === key ? null : key);
      }}
      ticked={ticked.has(shown.id)}
      selecting={ticked.size > 0}
      onTick={tick}
      onAsk={(chosen) => {
        addToChat([chosen]);
      }}
    />
  );
  return (
    <div className="mx-auto max-w-[790px] px-6 py-8">
      {groups.length === 0 ? (
        <p className="text-muted">Nothing here yet.</p>
      ) : results ? (
        groups.map((group) => {
          const heading = groupHeading(group);
          return (
            <section
              key={group.id}
              aria-label={`${heading.name} · ${heading.detail}`}
              className="mb-3 rounded-xl border border-line bg-surface"
            >
              <h2 className="border-b border-line px-3 py-2 font-semibold">
                {heading.name}{" "}
                <span className="font-normal text-muted">
                  · {heading.detail}
                </span>
              </h2>
              <ul>{group.rows.map((shown) => row(shown, group.date))}</ul>
            </section>
          );
        })
      ) : (
        <ul className="rounded-xl border border-line bg-surface">
          {groups.flatMap((group) => group.rows.map((shown) => row(shown)))}
        </ul>
      )}
      {hasNextPage && (
        <div className="mt-2 text-center">
          <Button
            ref={more}
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            Show more
          </Button>
        </div>
      )}
      {pages.error && groups.length > 0 && (
        <div className="mt-2">
          <Problem error={pages.error} retry={() => void pages.refetch()} />
        </div>
      )}
      {problem !== null && (
        <p role="alert" className="mt-2 px-0.5 text-muted">
          {problem}
        </p>
      )}
      {ticked.size > 0 && (
        <div className="sticky bottom-4 mt-3 flex items-center gap-2.5 rounded-xl bg-surface px-3 py-2 shadow-float">
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
              // In the page's order, as the screen shows them.
              addToChat(
                groups
                  .flatMap((group) => group.rows)
                  .filter(
                    (shown): shown is RecordRow =>
                      ticked.has(shown.id) && !isBad(shown),
                  ),
              );
            }}
          >
            Add {ticked.size} to chat
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * A row, which opens in place to its detail. `when` stands for the row's
 * own date; without `onTick`, it can't be chosen.
 */
export function RowView({
  personId,
  row,
  groupDate,
  when,
  open,
  onOpen,
  ticked = false,
  selecting = false,
  onTick,
  onAsk,
}: {
  personId: string;
  row: ShownRow;
  groupDate?: string | undefined;
  when?: string;
  open: boolean;
  onOpen: () => void;
  ticked?: boolean;
  selecting?: boolean;
  onTick?: (row: RecordRow) => void;
  onAsk: (row: RecordRow) => void;
}) {
  if (isBad(row)) {
    return (
      <li className="border-t border-line px-3 py-2 text-muted italic first:border-t-0">
        Can't show this row.
      </li>
    );
  }
  const cells = cellsOf(row, groupDate);
  return (
    <li className="border-t border-line first:border-t-0">
      <div
        className={`group grid grid-cols-[20px_1.4fr_1fr_0.8fr_1fr_auto] items-center gap-2 px-3 py-2 ${open || ticked ? "bg-accent-soft" : "hover:bg-side"}`}
      >
        {onTick ? (
          <input
            type="checkbox"
            aria-label={`Choose ${cells.title}`}
            checked={ticked}
            onChange={() => {
              onTick(row);
            }}
            className={`size-[15px] accent-accent ${selecting ? "" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"}`}
          />
        ) : (
          <span />
        )}
        <button
          type="button"
          aria-expanded={open}
          onClick={onOpen}
          className="min-w-0 text-left font-semibold"
        >
          {cells.title}
          {cells.note !== undefined && (
            <span className="font-normal text-muted"> {cells.note}</span>
          )}
        </button>
        <span className="text-muted">{cells.detail}</span>
        <span>{cells.status}</span>
        <span className="text-muted">{when ?? cells.date}</span>
        <span className="text-right">
          {!selecting && (
            <button
              type="button"
              onClick={() => {
                onAsk(row);
              }}
              className="rounded-lg border border-line bg-surface px-2 py-px text-xs whitespace-nowrap text-accent-ink opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100"
            >
              Ask Rufi
            </button>
          )}
        </span>
      </div>
      {open && <RowDetail personId={personId} row={row} />}
    </li>
  );
}

/** A field's value in a change, as a person reads it. */
function valueOf(value: unknown): string {
  if (value === undefined || value === null) return "not known";
  if (typeof value === "object" && "date" in value) {
    return printedDate(String(value.date).slice(0, 10));
  }
  if (typeof value === "object" && "kind" in value) return "another record";
  if (value === "next_visit") return "the next visit";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : JSON.stringify(value);
}

const ACTIONS: Record<RecordChange["action"], string> = {
  add: "Added",
  change: "Changed",
  remove: "Removed",
  restore: "Put back",
  link: "Another source added",
  unlink: "A source taken off",
};

function RowDetail({ personId, row }: { personId: string; row: RecordRow }) {
  const detail = useRecordDetail(personId, row.kind, row.id);
  if (detail.data === undefined) {
    return detail.error ? (
      <div className="px-3 py-2">
        <Problem error={detail.error} retry={() => void detail.refetch()} />
      </div>
    ) : null;
  }
  const { sources, history, replaces, replacedBy, entered, removed } =
    detail.data;
  const versionLabel = (version: ShownRow) =>
    isBad(version) ? "Can't show this row." : cellsOf(version).title;
  return (
    <div className="border-t border-line px-3 pt-1 pb-3">
      {row.kind === "result" && (
        <p className="pt-2 text-muted">
          {[
            row.measured && `Measured ${dated(row.measured) ?? ""}`,
            entered && `entered in Rufi ${printedTime(entered)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {removed && <p className="pt-2 text-muted">Removed from your record.</p>}
      <h3 className="mt-3 mb-1 text-xs font-semibold text-muted">Sources</h3>
      {sources.length === 0 ? (
        <p className="text-muted">None kept: saved before Rufi kept sources.</p>
      ) : (
        <ul>
          {sources.map((source) => (
            <li
              key={
                source.type === "document"
                  ? `${source.document}:${String(source.page)}`
                  : source.entry
              }
              className="py-0.5"
            >
              {source.type === "document" ? (
                <>
                  {source.file} · page {source.page}{" "}
                  <Link
                    to="/people/$personId/documents/$documentId"
                    params={{ personId, documentId: source.document }}
                    className="rounded-md px-1 text-accent-ink hover:bg-accent-soft"
                  >
                    Open
                  </Link>
                </>
              ) : (
                <>
                  You said: “{source.text}”{" "}
                  <span className="text-muted">{printedTime(source.at)}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3 className="mt-3 mb-1 text-xs font-semibold text-muted">History</h3>
      {history.length === 0 ? (
        <p className="text-muted">
          No saves yet: it came before Rufi kept them.
        </p>
      ) : (
        <ol>
          {history.map((change, index) => (
            <li key={`${change.save}:${String(index)}`} className="py-0.5">
              <span className="text-muted">{printedTime(change.at)}</span> ·{" "}
              {ACTIONS[change.action]}
              {change.action === "add" &&
                (change.fromMessage
                  ? ", from your message"
                  : ", from a document")}
              {change.fields.map((field) => (
                <span key={field.field} className="block pl-4">
                  {field.field} {valueOf(field.before)} → {valueOf(field.after)}
                </span>
              ))}
            </li>
          ))}
        </ol>
      )}
      {replaces && (
        <>
          <h3 className="mt-3 mb-1 text-xs font-semibold text-muted">
            Replaces
          </h3>
          <p>
            {versionLabel(replaces)}{" "}
            <span className="text-muted">(the earlier version, kept)</span>
          </p>
        </>
      )}
      {replacedBy && (
        <>
          <h3 className="mt-3 mb-1 text-xs font-semibold text-muted">
            Replaced by
          </h3>
          <p>{versionLabel(replacedBy)}</p>
        </>
      )}
      {row.kind === "result" && (
        <SeriesTable personId={personId} test={row.test} unit={row.unit} />
      )}
    </div>
  );
}

/** A test's current values in one unit over time, as a table. */
function SeriesTable({
  personId,
  test,
  unit,
}: {
  personId: string;
  test: string;
  unit: string | undefined;
}) {
  const series = useSeries(personId, test, unit);
  if (series.data === undefined) {
    return series.error ? (
      <Problem error={series.error} retry={() => void series.refetch()} />
    ) : null;
  }
  const title = unit === undefined ? test : `${test} (${unit})`;
  return (
    <>
      <h3 className="mt-3 mb-1 text-xs font-semibold text-muted">
        {title} over time
      </h3>
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="py-1 font-normal">Measured</th>
            <th className="py-1 font-normal">Value</th>
            <th className="py-1 font-normal">Lab range</th>
            <th className="py-1 font-normal">Lab note</th>
          </tr>
        </thead>
        <tbody>
          {series.data.values.map((value) =>
            isBad(value) || value.kind !== "result" ? (
              <tr key={value.id} className="border-t border-line">
                <td colSpan={4} className="py-1 text-muted italic">
                  Can't show this row.
                </td>
              </tr>
            ) : (
              <tr key={value.id} className="border-t border-line">
                <td className="py-1">{dated(value.measured) ?? "No date"}</td>
                <td className="py-1">{join(value.value, value.unit)}</td>
                <td className="py-1">{value.range}</td>
                <td className="py-1">
                  {[value.flag, value.context].filter(Boolean).join(" · ")}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </>
  );
}
