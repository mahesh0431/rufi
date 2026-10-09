// Dates as Rufi prints them: "12 Aug 2026", at the precision known. A month
// or a year alone stays that way; nothing is invented. Text that isn't a date
// is shown as it is.
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-08-12" → "12 Aug 2026"; "2026-08" → "Aug 2026"; "2026" → "2026". */
export function printedDate(value: string): string {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return value;
  const [, year = "", month, day] = match;
  const name = month === undefined ? undefined : MONTHS[Number(month) - 1];
  if (month !== undefined && name === undefined) return value;
  if (name === undefined) return year;
  return day === undefined
    ? `${name} ${year}`
    : `${String(Number(day))} ${name} ${year}`;
}

/** "Sunday, 4 October" for today's greeting. */
export function today(now: Date): string {
  return now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** Good morning, afternoon or evening, by the hour. */
export function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** An ISO time as "at 18:30 on 4 Oct 2026", in this Mac's time zone. */
export function printedTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `at ${pad(at.getHours())}:${pad(at.getMinutes())} on ${String(at.getDate())} ${MONTHS[at.getMonth()] ?? ""} ${String(at.getFullYear())}`;
}

/** An ISO time's day as "4 Oct 2026", in this Mac's time zone. */
export function printedDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${String(at.getDate())} ${MONTHS[at.getMonth()] ?? ""} ${String(at.getFullYear())}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The day of an ISO time in this Mac's time zone, to tell days apart. */
export function dayOf(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getFullYear())}-${String(at.getMonth())}-${String(at.getDate())}`;
}

/**
 * The chat's line before a day's first message, in this Mac's time zone:
 * "Today", "Yesterday", "Thu 8 Oct", and the year when it isn't this one.
 */
export function dayLine(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  if (dayOf(iso) === dayOf(now.toISOString())) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayOf(iso) === dayOf(yesterday.toISOString())) return "Yesterday";
  const day = `${WEEKDAYS[at.getDay()] ?? ""} ${String(at.getDate())} ${MONTHS[at.getMonth()] ?? ""}`;
  return at.getFullYear() === now.getFullYear()
    ? day
    : `${day} ${String(at.getFullYear())}`;
}
