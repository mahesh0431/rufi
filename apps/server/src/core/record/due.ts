// When a follow-up is due (docs/help/follow-ups.md): the one rule that
// Follow-ups, Needs you and the notices share. A date is due during its
// year, month or day, or from its time to the end of its day, and overdue
// after it; a rough date is never made into a day. Times are the Mac's local
// time, never read through UTC. Nothing here is stored.

export type DueClass =
  | "overdue"
  | "due"
  /** Due within the next 30 days. */
  | "coming_up"
  | "later"
  | "next_visit"
  | "no_date";

/** How far ahead "coming up" looks, in days. */
const COMING_UP_DAYS = 30;

const SHAPE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2}))?)?)?$/;

/** Where a follow-up due `due` stands at the local time `now`. */
export function classify(due: string | null, now: Date): DueClass {
  if (due === "next_visit") return "next_visit";
  const match = due === null ? null : SHAPE.exec(due);
  // A stored due Rufi doesn't know is never due; its row shows as it is.
  if (!match) return "no_date";
  const [, y, month, day, hour, minute] = match;
  const year = Number(y);
  const m = Number(month);
  const d = Number(day);
  // The Date constructor reads its parts as local time.
  const [from, overdueFrom] =
    month === undefined
      ? [new Date(year, 0, 1), new Date(year + 1, 0, 1)]
      : day === undefined
        ? [new Date(year, m - 1, 1), new Date(year, m, 1)]
        : [
            new Date(year, m - 1, d, Number(hour ?? 0), Number(minute ?? 0)),
            new Date(year, m - 1, d + 1),
          ];
  if (now >= overdueFrom) return "overdue";
  if (now >= from) return "due";
  const ahead = new Date(now);
  ahead.setDate(ahead.getDate() + COMING_UP_DAYS);
  return from <= ahead ? "coming_up" : "later";
}
