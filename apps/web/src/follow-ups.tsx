// The person's follow-ups by when they are due (docs/help/follow-ups.md):
// overdue, due now, coming up, later, at the next visit, no date, then done
// and dropped. Where each stands is the core's due rules, read each minute
// while the page shows, so it crosses midnight by itself. A row shows the
// record it is about, which opens on its kind's page, and opens in place to
// its sources and history. The page only shows: changes start in the chat,
// with Ask Rufi on a row.
import type { Person } from "@rufi/contracts";
import type {
  DueClass,
  FollowUpRow,
  FollowUps,
  RecordRow,
  ShownRow,
} from "@rufi/contracts/record";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { boxFor } from "./boxes.ts";
import { printedDate } from "./dates.ts";
import { useShowChat } from "./panel.ts";
import {
  cellsOf,
  chipOf,
  isPageKind,
  RowDetail,
  rowElementId,
} from "./record.tsx";
import { useFollowUps, useRecordDetail } from "./reads.ts";
import { Problem } from "./ui.tsx";

type Group = FollowUps["groups"][number]["group"];

const HEADINGS: Record<Group, string> = {
  overdue: "Overdue",
  due: "Due now",
  coming_up: "Coming up",
  later: "Later",
  next_visit: "At the next visit",
  no_date: "No date",
  done: "Done",
  dropped: "Dropped",
};

/** The local day of `at`, as stored dates write it: "2026-10-11". */
function dayOf(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

/**
 * A due as people read it, at its precision, with today and tomorrow as
 * words: "Sep 2026", "today at 16:00", "tomorrow", "3 Dec 2026".
 */
function dueDate(date: string, now: Date): string {
  const time = /T(\d{2}:\d{2})$/.exec(date)?.[1];
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = date.slice(0, 10);
  const named =
    day === dayOf(now)
      ? "today"
      : day === dayOf(tomorrow)
        ? "tomorrow"
        : printedDate(day);
  return time === undefined ? named : `${named} at ${time}`;
}

/**
 * When a follow-up is due, from where it stands at the local time `now`:
 * "Overdue · was due Sep 2026", "Due this month", "Due today at 16:00",
 * "Due tomorrow", "Due 3 Nov 2026". A rough date stays rough.
 */
export function whenDue(
  group: Group | DueClass,
  due: FollowUpRow["due"],
  now: Date,
): string {
  if (due === "next_visit") return "At the next visit";
  if (due === undefined) return "No date";
  const date = due.date;
  switch (group) {
    case "overdue":
      return `Overdue · was due ${dueDate(date, now)}`;
    case "due":
      if (date.length === 4) return "Due this year";
      if (date.length === 7) return "Due this month";
      return `Due ${dueDate(date, now)}`;
    case "done":
    case "dropped":
      return `Was due ${dueDate(date, now)}`;
    // Not due yet. A date can't stand at the next visit or at no date.
    case "coming_up":
    case "later":
    case "next_visit":
    case "no_date":
      return date.length === 4 ? `Due in ${date}` : `Due ${dueDate(date, now)}`;
  }
}

export function FollowUpsPage({
  person,
  opened,
}: {
  person: Person;
  /** A follow-up's id to open and bring into view (from Needs you). */
  opened?: string;
}) {
  const followUps = useFollowUps(person.id);
  const [open, setOpen] = useState<string | null>(opened ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const showChat = useShowChat(person.id);
  const loaded = followUps.data !== undefined;

  // The follow-up asked for, into view once the page has it.
  useEffect(() => {
    if (loaded && opened !== undefined) {
      document
        .getElementById(rowElementId("follow_up", opened))
        ?.scrollIntoView({ block: "center" });
    }
  }, [loaded, opened]);

  if (followUps.data === undefined) {
    return (
      <div className="mx-auto max-w-[790px] px-6 py-8">
        {followUps.error && (
          <Problem
            error={followUps.error}
            retry={() => void followUps.refetch()}
          />
        )}
      </div>
    );
  }
  const ask = (row: RecordRow) => {
    if (boxFor(person.id).append("", [chipOf(row)])) {
      setProblem(null);
      showChat();
    } else {
      setProblem("A message is being sent: add this again in a moment.");
    }
  };
  // Today and tomorrow as of this read, which comes each minute.
  const now = new Date(followUps.dataUpdatedAt);
  const { groups } = followUps.data;
  return (
    <div className="mx-auto max-w-[790px] px-6 py-8">
      <p className="mb-5 text-muted">
        What to do, and when. Changes start in the chat: <b>Ask Rufi</b> on a
        row.
      </p>
      {groups.length === 0 && (
        <p className="text-muted">
          No follow-ups yet. Tell Rufi in the chat, for example “Remind me to
          recheck my HbA1c in December”.
        </p>
      )}
      {groups.map(({ group, rows }) => (
        <section
          key={group}
          aria-labelledby={`group-${group}`}
          className="mb-6"
        >
          <h2 id={`group-${group}`} className="mb-2 px-0.5 font-semibold">
            {HEADINGS[group]}{" "}
            <span className="font-normal text-muted">
              {group === "coming_up" && "next 30 days · "}
              {rows.length}
            </span>
          </h2>
          <ul className="rounded-xl border border-line bg-surface">
            {rows.map((row) => (
              <FollowUpView
                key={row.id}
                personId={person.id}
                group={group}
                row={row}
                now={now}
                open={open === row.id}
                onOpen={() => {
                  setOpen(open === row.id ? null : row.id);
                }}
                onAsk={ask}
              />
            ))}
          </ul>
        </section>
      ))}
      {problem !== null && (
        <p role="alert" className="mt-2 px-0.5 text-muted">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * One follow-up: what, the record it is about, its outcome when closed,
 * and when it is due. The group says whether it is open, so only Done and
 * Dropped say it again.
 */
function FollowUpView({
  personId,
  group,
  row,
  now,
  open,
  onOpen,
  onAsk,
}: {
  personId: string;
  group: Group;
  row: ShownRow;
  now: Date;
  open: boolean;
  onOpen: () => void;
  onAsk: (row: RecordRow) => void;
}) {
  if ("problem" in row || row.kind !== "follow_up") {
    return (
      <li className="border-t border-line px-3 py-2 text-muted italic first:border-t-0">
        Can't show this row.
      </li>
    );
  }
  const closed = group === "done" || group === "dropped";
  return (
    <li
      id={rowElementId(row.kind, row.id)}
      className="border-t border-line first:border-t-0"
    >
      <div
        className={`group grid items-center gap-3 px-3 py-2 ${closed ? "grid-cols-[1fr_auto_minmax(13rem,auto)_auto]" : "grid-cols-[1fr_minmax(13rem,auto)_auto]"} ${open ? "bg-accent-soft" : "hover:bg-side"}`}
      >
        <span className="min-w-0">
          <button
            type="button"
            aria-expanded={open}
            onClick={onOpen}
            className="text-left font-semibold"
          >
            {row.title}
          </button>
          {row.about && (
            <About
              personId={personId}
              kind={row.about.kind}
              id={row.about.id}
            />
          )}
          {closed && row.outcome !== undefined && (
            <span className="block text-[12.5px] text-muted">
              Outcome: {row.outcome}
            </span>
          )}
        </span>
        {closed && <span>{group === "done" ? "Done" : "Dropped"}</span>}
        <span className="whitespace-nowrap text-muted">
          {whenDue(group, row.due, now)}
        </span>
        <button
          type="button"
          onClick={() => {
            onAsk(row);
          }}
          className="rounded-lg border border-line bg-surface px-2 py-px text-xs whitespace-nowrap text-accent-ink opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100"
        >
          Ask Rufi
        </button>
      </div>
      {open && <RowDetail personId={personId} row={row} />}
    </li>
  );
}

/**
 * The record a follow-up is about, by its label and date, read through the
 * record's own detail; it opens on its kind's page. A result amended since
 * keeps the values the follow-up was about, says what it was amended to,
 * and opens the current one, following each amendment; `said` is the label
 * of the record the follow-up names, once an amendment is followed.
 */
function About({
  personId,
  kind,
  id,
  said,
}: {
  personId: string;
  kind: string;
  id: string;
  said?: string;
}) {
  const detail = useRecordDetail(personId, kind, id);
  const row = detail.data?.row;
  if (row === undefined || "problem" in row || !isPageKind(kind)) {
    return detail.error ? (
      <span className="block text-[12.5px] text-muted">
        About: a record Rufi can't show
      </span>
    ) : null;
  }
  const cells = cellsOf(row);
  const label = [cells.title, cells.date].filter(Boolean).join(" · ");
  const newer = detail.data?.replacedBy;
  if (newer !== undefined && !("problem" in newer)) {
    return (
      <About
        personId={personId}
        kind={kind}
        id={newer.id}
        said={said ?? label}
      />
    );
  }
  const shown =
    said === undefined
      ? label
      : `${said} · amended to ${cells.value ?? cells.title}`;
  return (
    <span className="block text-[12.5px] text-muted">
      About:{" "}
      {detail.data?.removed ? (
        `${shown} (removed from your record)`
      ) : (
        <Link
          to="/people/$personId/record/$kind"
          params={{ personId, kind }}
          search={{ open: id }}
          className="rounded-md text-accent-ink hover:bg-accent-soft"
        >
          {shown}
        </Link>
      )}
    </span>
  );
}
