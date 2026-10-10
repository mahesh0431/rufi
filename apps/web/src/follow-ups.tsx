// The person's follow-ups by when they are due (docs/help/follow-ups.md):
// overdue, due now, coming up, later, at the next visit, no date, then done
// and dropped. Where each stands is the core's due rules, read each minute
// while the page shows, so it crosses midnight by itself. The page only
// shows: changes start in the chat, with Ask Rufi on a row.
import type { Person } from "@rufi/contracts";
import type {
  DueClass,
  FollowUpRow,
  FollowUps,
  RecordRow,
} from "@rufi/contracts/record";
import { useState } from "react";
import { boxFor } from "./boxes.ts";
import { printedDate } from "./dates.ts";
import { useShowChat } from "./panel.ts";
import { chipOf, RowView } from "./record.tsx";
import { useFollowUps } from "./reads.ts";
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

/** A due as people read it, at its precision: "Sep 2026", "3 Dec 2026 at 14:30". */
function dueDate(date: string): string {
  const time = /T(\d{2}:\d{2})$/.exec(date)?.[1];
  const day = printedDate(date.slice(0, 10));
  return time === undefined ? day : `${day} at ${time}`;
}

/**
 * When a follow-up is due, from where it stands: "Overdue · was due Sep
 * 2026", "Due this month", "Due today at 14:30", "Due 3 Nov 2026". A rough
 * date stays rough.
 */
export function whenDue(group: Group | DueClass, due: FollowUpRow["due"]) {
  if (due === "next_visit") return "At the next visit";
  if (due === undefined) return "No date";
  const date = due.date;
  const time = /T(\d{2}:\d{2})$/.exec(date)?.[1];
  switch (group) {
    case "overdue":
      return `Overdue · was due ${dueDate(date)}`;
    case "due":
      if (date.length === 4) return "Due this year";
      if (date.length === 7) return "Due this month";
      return time === undefined ? "Due today" : `Due today at ${time}`;
    case "done":
    case "dropped":
      return `Was due ${dueDate(date)}`;
    // Not due yet. A date can't stand at the next visit or at no date.
    case "coming_up":
    case "later":
    case "next_visit":
    case "no_date":
      return date.length === 4 ? `Due in ${date}` : `Due ${dueDate(date)}`;
  }
}

export function FollowUpsPage({ person }: { person: Person }) {
  const followUps = useFollowUps(person.id);
  const [open, setOpen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const showChat = useShowChat(person.id);

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
            {rows.map((row) => {
              const key = `${row.kind}:${row.id}`;
              return (
                <RowView
                  key={key}
                  personId={person.id}
                  row={row}
                  {...(row.kind === "follow_up" &&
                    !("problem" in row) && { when: whenDue(group, row.due) })}
                  open={open === key}
                  onOpen={() => {
                    setOpen(open === key ? null : key);
                  }}
                  onAsk={ask}
                />
              );
            })}
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
