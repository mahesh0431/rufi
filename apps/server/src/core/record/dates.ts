// Dates in the record: a date or time only as the user said it, at the
// precision they said it, with their words kept. The AI turns the words into
// a date; Rufi checks the date is a real one and is no later than the
// message it rests on, where the date must have happened by then.

/** 'YYYY', 'YYYY-MM', 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' (local time). */
const SHAPE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2}))?)?)?$/;

/** Why `text` isn't a date Rufi keeps; undefined when it is one. */
export function dateProblem(text: string): string | undefined {
  const match = SHAPE.exec(text);
  if (!match) {
    return "Use YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DDTHH:MM (local time, no time zone), at the precision the user gave.";
  }
  const [, year, month, day, hour, minute] = match;
  if (month !== undefined && (Number(month) < 1 || Number(month) > 12)) {
    return `${text} isn't a real month.`;
  }
  if (day !== undefined) {
    // Day 0 of the next month is the last day of this one.
    const last = new Date(
      Date.UTC(Number(year), Number(month), 0),
    ).getUTCDate();
    if (Number(day) < 1 || Number(day) > last) {
      return `${text} isn't a real date.`;
    }
  }
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59)) {
    return `${text} isn't a real time.`;
  }
  return undefined;
}

/** An ISO time as the Mac's local 'YYYY-MM-DDTHH:MM'. */
export function localTime(iso: string): string {
  const at = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** Whether `date` (at its precision) is later than the local time `anchor`. */
export const isAfter = (date: string, anchor: string) =>
  date > anchor.slice(0, date.length);

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

/** A date for a person, at its precision: "2019", "Sep 2026", "28 Sep 2026", "28 Sep 2026 08:30". */
export function shownDate(date: string): string {
  const match = SHAPE.exec(date);
  if (!match) return date;
  const [, year = "", month, day, hour, minute] = match;
  const name = month === undefined ? "" : MONTHS[Number(month) - 1];
  if (name === undefined || name === "") return year;
  if (day === undefined) return `${name} ${year}`;
  const time = hour === undefined ? "" : ` ${hour}:${minute ?? "00"}`;
  return `${String(Number(day))} ${name} ${year}${time}`;
}
