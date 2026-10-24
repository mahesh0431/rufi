// A page of the person's health record: newest first, in groups as the
// paper has them (on Lab results, a report's lab results whole or a day of
// lab results typed in the chat; on Measurements, the day they were taken;
// one row each for the other kinds), more as the person scrolls. A row opens in
// place to its sources, its history and, for a result, its values over
// time, drawn and as a table; a result row has a small trend after its
// value. The page only shows: changes start in the chat, with Ask Rufi on a
// row (or a report's heading): its chip goes in the chat box, and the page
// stays.
import type { Person } from "@rufi/contracts";
import type {
  PageKind,
  ResultCategory,
  RecordChange,
  RecordGroup,
  RecordRow,
  ResultRow,
  ShownRow,
  VisitRow,
} from "@rufi/contracts/record";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AskRufi, AskRufiEmpty } from "./ask.tsx";
import { printedDate, printedTime } from "./dates.ts";
import type { BoxChip } from "./draft.ts";
import { askRufi } from "./panel.ts";
import { useRecordDetail, useRecordPages, useSeries } from "./reads.ts";
import { Trend } from "./trend.tsx";
import { Button, buttonLook, EmptyState, ICON, Problem } from "./ui.tsx";

/** The pages, in the sidebar's order, by their title: results have two. */
export const KIND_TITLES: Record<PageKind, string> = {
  lab_result: "Lab results",
  measurement: "Measurements",
  medicine_use: "Medicines",
  visit: "Visits",
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
  visit: "Visit",
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

/** A stored date at its own precision, with its time when it has one. */
const dated = (when?: { date: string }) =>
  when === undefined ? undefined : printedDate(when.date);

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

/** A visit's setting, as a person says it. */
const SETTINGS: Record<VisitRow["setting"], string> = {
  clinic: "Clinic",
  online: "Online",
  home: "Home visit",
  hospital: "Hospital stay",
  unknown: "",
};

/** A visit's name: its doctor and place, or why they went. */
export const visitTitle = (row: VisitRow) =>
  [row.doctor, row.place].filter(Boolean).join(" · ") || row.reason || "Visit";

/** A visit's setting and date, as its page's heading says them. */
export const visitWhen = (row: VisitRow) =>
  [SETTINGS[row.setting], cellsOf(row).date].filter(Boolean).join(" · ");

interface Cells {
  /** What the row is, as its chip names it. */
  title: string;
  /** A result's name, shown apart from its value so values line up. */
  name?: string;
  value?: string;
  /** A word after the title. */
  note?: string;
  detail?: string;
  status?: string;
  date?: string;
}

/** A row's cells; `groupDate`: the group's date, not shown again on its rows. */
export function cellsOf(row: RecordRow, groupDate?: string): Cells {
  switch (row.kind) {
    case "result": {
      // Its own date (and time) only when its group's doesn't say it.
      const measured = row.measured?.date;
      return {
        title: join(row.test, row.value, row.unit),
        name: row.test,
        value: join(row.value, row.unit),
        ...(row.replaces !== undefined && { note: "amended" }),
        ...(row.range !== undefined && { detail: row.range }),
        status: [row.flag, row.context].filter(Boolean).join(" · "),
        // Only a date that differs from its group's; on its group's day,
        // only its time.
        ...(measured !== undefined &&
          measured !== groupDate && {
            date: measured.startsWith(`${groupDate ?? ""}T`)
              ? measured.slice(11)
              : dated(row.measured),
          }),
      };
    }
    case "medicine_use":
      return {
        title: join(row.name, row.strength),
        detail: [row.amount, row.schedule].filter(Boolean).join(" · "),
        status: STATUS[row.status] ?? "",
        date: span(row.started, row.ended) ?? "",
      };
    case "visit":
      return {
        title: visitTitle(row),
        detail: [
          row.reason,
          row.cited !== undefined &&
            `${String(row.cited)} ${row.cited === 1 ? "record" : "records"} from it`,
        ]
          .filter(Boolean)
          .join(" · "),
        status: SETTINGS[row.setting],
        date: row.ended
          ? `${dated(row.date) ?? "?"} to ${dated(row.ended) ?? ""}`
          : (dated(row.date) ?? ""),
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

/** What a row is called: a result by its category. */
export const nounOf = (row: RecordRow) =>
  row.kind === "result"
    ? row.category === "measurement"
      ? "Measurement"
      : "Lab result"
    : NOUNS[row.kind];

/** The page a row shows on: a result's by its category. */
export const pageOf = (row: RecordRow): PageKind | undefined => {
  if (row.kind === "result") {
    return row.category === "measurement" ? "measurement" : "lab_result";
  }
  return isPageKind(row.kind) ? row.kind : undefined;
};

/** A row as a chip in the chat box. */
export const chipOf = (row: RecordRow): BoxChip => ({
  pointer: { type: "record", kind: row.kind, id: row.id },
  label: cellsOf(row).title,
  detail: `${nounOf(row)} in your health record`,
});

/**
 * A report's group as one chip: the report, whose results the AI reads.
 * The group's id is "report:" and the report's id; the core names the chip.
 */
const reportChip = (group: RecordGroup): BoxChip => {
  const heading = groupHeading(group);
  return {
    pointer: { type: "report", id: group.id.slice("report:".length) },
    label: `${heading.name} · ${heading.detail}`,
    detail: "",
  };
};

/**
 * A group's heading: a report, lab results typed in the chat, the day
 * measurements were taken, or no date.
 */
function groupHeading(group: RecordGroup) {
  const when = group.date === undefined ? undefined : printedDate(group.date);
  const n = group.rows.length;
  if (group.type === "day") {
    const count = `${String(n)} ${n === 1 ? "measurement" : "measurements"}`;
    return { name: when ?? "No date", detail: count };
  }
  const count = `${String(n)} ${n === 1 ? "result" : "results"}`;
  if (group.type === "report") {
    return {
      name: group.issuer ?? "Report",
      detail: [when ?? "no date", count].join(" · "),
    };
  }
  if (when === undefined) return { name: "No date", detail: count };
  return { name: "Typed in the chat", detail: `${when} · ${count}` };
}

/** A row's element id, to bring it into view. */
export const rowElementId = (kind: string, id: string) => `row-${kind}-${id}`;

/**
 * A kind's page; `opened`: the id of a row to open and bring into view (a
 * follow-up's About links here), read on page by page until it is there.
 */
export function RecordPage({
  person,
  kind,
  opened,
}: {
  person: Person;
  kind: PageKind;
  opened?: string;
}) {
  const pages = useRecordPages(person.id, kind);
  const [open, setOpen] = useState<string | null>(null);
  const sought = useRef(opened);
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

  // The row asked for: more pages until it is loaded, then open and into
  // view, once, by its own kind (Allergies also shows a statement).
  const loaded = pages.data?.pages;
  useEffect(() => {
    const id = sought.current;
    if (id === undefined || loaded === undefined) return;
    const there = loaded
      .flatMap((page) => page.groups.flatMap((group) => group.rows))
      .find((row) => row.id === id);
    if (there) {
      sought.current = undefined;
      setOpen(`${there.kind}:${id}`);
      document
        .getElementById(rowElementId(there.kind, id))
        ?.scrollIntoView({ block: "center" });
    } else if (!hasNextPage) {
      sought.current = undefined;
    } else if (!isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [loaded, hasNextPage, isFetchingNextPage, fetchNextPage]);

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
  const trends: Partial<Record<string, readonly ResultRow[]>> =
    Object.fromEntries(
      pages.data.pages.flatMap((page) => Object.entries(page.trends ?? {})),
    );
  const results = kind === "lab_result" || kind === "measurement";
  const row = (shown: ShownRow, groupDate?: string) => (
    <RowView
      key={`${shown.kind}:${shown.id}`}
      personId={person.id}
      row={shown}
      trend={trends[shown.id]}
      groupDate={groupDate}
      open={open === `${shown.kind}:${shown.id}`}
      onOpen={() => {
        const key = `${shown.kind}:${shown.id}`;
        setOpen(open === key ? null : key);
      }}
      onAsk={(chosen) => {
        askRufi(person.id, [chipOf(chosen)]);
      }}
    />
  );
  return (
    <div className="mx-auto max-w-[790px] px-6 py-8">
      {results && (
        <p className="mb-3 text-muted">
          {kind === "measurement"
            ? "By the day they were taken, newest first."
            : "As printed, newest first."}{" "}
          Changes start in the chat: <b className="font-semibold">Ask Rufi</b>{" "}
          on a row.
        </p>
      )}
      {groups.length === 0 ? (
        <EmptyState action={<AskRufiEmpty personId={person.id} />}>
          Nothing here yet.
        </EmptyState>
      ) : results ? (
        groups.map((group) => {
          const heading = groupHeading(group);
          return (
            <section
              key={group.id}
              aria-label={`${heading.name} · ${heading.detail}`}
              className="mb-3 rounded-xl border border-line bg-surface"
            >
              <h2 className="group flex items-center gap-1 border-b border-line px-3 py-2 font-semibold">
                <span className="min-w-0 flex-1">
                  {heading.name}{" "}
                  <span className="font-normal text-muted">
                    · {heading.detail}
                  </span>
                </span>
                {group.type === "report" && (
                  <AskRufi
                    aria-label={`Ask Rufi about this report: ${heading.name} · ${heading.detail}`}
                    onClick={() => {
                      askRufi(person.id, [reportChip(group)]);
                    }}
                  />
                )}
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
            icon={ChevronDown}
            onClick={() => void fetchNextPage()}
            busy={isFetchingNextPage && "Loading…"}
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
    </div>
  );
}

function RowView({
  personId,
  row,
  trend,
  groupDate,
  open,
  onOpen,
  onAsk,
}: {
  personId: string;
  row: ShownRow;
  /** A result's small trend: its latest values up to it. */
  trend: readonly ResultRow[] | undefined;
  groupDate: string | undefined;
  open: boolean;
  onOpen: () => void;
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
  const result = cells.value !== undefined;
  return (
    <li
      id={rowElementId(row.kind, row.id)}
      className="border-t border-line first:border-t-0"
    >
      <div
        className={`group grid items-center gap-2 px-3 py-2 ${result ? "grid-cols-[1.1fr_0.9fr_96px_0.8fr_0.8fr_0.7fr_auto]" : "grid-cols-[1.4fr_1fr_0.8fr_1fr_auto]"} ${open ? "bg-accent-soft" : "hover:bg-side"}`}
      >
        {row.kind === "visit" ? (
          // A visit has a page of its own: the doctor's words and what came from it.
          <Link
            to="/people/$personId/visits/$visitId"
            params={{ personId, visitId: row.id }}
            className="min-w-0 text-left font-semibold"
          >
            {cells.title}
          </Link>
        ) : (
          <button
            type="button"
            aria-expanded={open}
            onClick={onOpen}
            className="min-w-0 text-left font-semibold"
          >
            {cells.name ?? cells.title}
            {cells.note !== undefined && (
              <span className="font-normal text-muted"> {cells.note}</span>
            )}
          </button>
        )}
        {result && <span>{cells.value}</span>}
        {result && (
          <span>
            {trend && row.kind === "result" && (
              <Trend mini title={row.test} values={trend} />
            )}
          </span>
        )}
        <span className="text-muted">{cells.detail}</span>
        <span>{cells.status}</span>
        <span className="text-muted">{cells.date}</span>
        <span className="text-right">
          <AskRufi
            onClick={() => {
              onAsk(row);
            }}
          />
        </span>
      </div>
      {open && row.kind !== "visit" && (
        <RowDetail personId={personId} row={row} />
      )}
    </li>
  );
}

/** A field's value in a change, as a person reads it. */
function valueOf(value: unknown): string {
  if (value === undefined || value === null) return "not known";
  if (typeof value === "object" && "date" in value) {
    return printedDate(String(value.date));
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

export function RowDetail({
  personId,
  row,
}: {
  personId: string;
  row: RecordRow;
}) {
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
      {removed && (
        <p className="pt-2 text-muted">Removed from your health record.</p>
      )}
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
                  : source.type === "visit"
                    ? source.visit
                    : source.entry
              }
              className="py-0.5"
            >
              {source.type === "visit" ? (
                source.removed ? (
                  <span className="text-muted">
                    Visit removed ({source.label})
                  </span>
                ) : (
                  <>
                    Visit · {source.label}{" "}
                    <Link
                      to="/people/$personId/visits/$visitId"
                      params={{ personId, visitId: source.visit }}
                      className={buttonLook({ look: "quiet" })}
                    >
                      <ArrowUpRight size={ICON} aria-hidden />
                      Open
                    </Link>
                  </>
                )
              ) : source.type === "document" && source.deleted ? (
                <span className="text-muted">
                  Document deleted ({source.file}, page {source.page})
                </span>
              ) : source.type === "document" ? (
                <>
                  {source.file} · page {source.page}{" "}
                  <Link
                    to="/people/$personId/documents/$documentId"
                    params={{ personId, documentId: source.document }}
                    className={buttonLook({ look: "quiet" })}
                  >
                    <ArrowUpRight size={ICON} aria-hidden />
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
        <SeriesTable
          personId={personId}
          test={row.test}
          unit={row.unit}
          category={row.category}
        />
      )}
    </div>
  );
}

/** A test's current values in one unit over time, drawn and as a table. */
function SeriesTable({
  personId,
  test,
  unit,
  category,
}: {
  personId: string;
  test: string;
  unit: string | undefined;
  category: ResultCategory;
}) {
  const series = useSeries(personId, test, unit, category);
  if (series.data === undefined) {
    return series.error ? (
      <Problem error={series.error} retry={() => void series.refetch()} />
    ) : null;
  }
  const title = unit === undefined ? test : `${test} (${unit})`;
  // A lab's columns, unless no value has a range or a note (most
  // measurements).
  const lab = series.data.values.some(
    (value) =>
      !isBad(value) &&
      value.kind === "result" &&
      (value.range ?? value.flag ?? value.context) !== undefined,
  );
  return (
    <>
      <h3 className="mt-3 mb-1 text-xs font-semibold text-muted">
        {title} over time
      </h3>
      <Trend title={title} values={series.data.values} />
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="py-1 font-normal">Measured</th>
            <th className="py-1 font-normal">Value</th>
            {lab && <th className="py-1 font-normal">Lab range</th>}
            {lab && <th className="py-1 font-normal">Lab note</th>}
          </tr>
        </thead>
        <tbody>
          {series.data.values.map((value) =>
            isBad(value) || value.kind !== "result" ? (
              <tr key={value.id} className="border-t border-line">
                <td colSpan={lab ? 4 : 2} className="py-1 text-muted italic">
                  Can't show this row.
                </td>
              </tr>
            ) : (
              <tr key={value.id} className="border-t border-line">
                <td className="py-1">{dated(value.measured) ?? "No date"}</td>
                <td className="py-1">{join(value.value, value.unit)}</td>
                {lab && <td className="py-1">{value.range}</td>}
                {lab && (
                  <td className="py-1">
                    {[value.flag, value.context].filter(Boolean).join(" · ")}
                  </td>
                )}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </>
  );
}
