// When a medicine's doses fall (docs/adr/0031): the one rule that Today and
// the notice claim share. A dose is each of its local times on each day its
// rule gives (every day when none), from its start to its until at their
// precision. The days come from rrule.js, given only calendar days: UTC
// midnights in, UTC year, month and day out, never a clock time. Rufi joins
// each day with each time as a local date-time, as follow-ups do. Every
// question is bounded; nothing here is stored.
import { createRequire } from "node:module";
import { shownDate } from "../record/dates.ts";
import { dueSpan } from "../record/due.ts";

// rrule.js is CommonJS for Node, typed as ES modules.
const { RRule, rrulestr } = createRequire(import.meta.url)(
  "rrule",
) as typeof import("rrule");
type Rule = InstanceType<typeof RRule>;

/** A medicine's timing, as stored. */
export interface Timing {
  /** Local times of day, 'HH:MM'; null: no doses. */
  times: readonly string[] | null;
  /** An RFC 5545 rule for the days; null: every day. */
  days: string | null;
  /** The first dose, at its precision; null: from always. */
  started: string | null;
  /** The last dose, at its precision; null: forever. */
  until: string | null;
}

/**
 * The days a rule with no DTSTART counts from. For the forms that don't
 * depend on a start (every day, named weekdays, a named day of the month)
 * any day gives the same days; it is never a dose.
 */
const REFERENCE = new Date(Date.UTC(2000, 0, 1));

/** What each frequency may say besides itself and DTSTART. */
const FORMS: Readonly<Record<number, readonly string[]>> = {
  [RRule.DAILY]: ["interval"],
  [RRule.WEEKLY]: ["interval", "byweekday"],
  [RRule.MONTHLY]: ["interval", "bymonthday"],
};

/**
 * The rule for `days`, with whether it named its start; undefined for a
 * rule outside the forms Rufi takes, or one that doesn't parse.
 */
function ruleOf(days: string | null): { rule: Rule; from?: Date } | undefined {
  let parsed: unknown;
  try {
    // rrule.js 2.8 reads a date-only DTSTART only without VALUE=DATE.
    parsed = rrulestr(
      (days ?? "FREQ=DAILY").replace(/DTSTART;VALUE=DATE:/i, "DTSTART:"),
    );
  } catch {
    // Shown as saved, with no doses.
    return undefined;
  }
  if (!(parsed instanceof RRule)) return undefined;
  const { dtstart, tzid, freq, ...rest } = parsed.origOptions;
  const allowed = FORMS[freq ?? -1];
  if (allowed === undefined || tzid != null) return undefined;
  for (const [key, value] of Object.entries(rest)) {
    if (value != null && !allowed.includes(key)) return undefined;
  }
  // A start day only: a DTSTART with a time isn't one of the forms.
  if (dtstart != null && dtstart.getTime() % 86_400_000 !== 0) return undefined;
  return {
    rule: new RRule({ ...parsed.origOptions, dtstart: dtstart ?? REFERENCE }),
    ...(dtstart != null && { from: dtstart }),
  };
}

/** A local day as the UTC midnight rrule.js counts in. */
const calendarDay = (local: Date) =>
  new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));

/** A rule's day at each time, as local date-times, earliest first. */
const dosesAt = (day: Date, times: readonly string[]) =>
  times
    .map((time) => {
      const [hour = 0, minute = 0] = time.split(":").map(Number);
      return new Date(
        day.getUTCFullYear(),
        day.getUTCMonth(),
        day.getUTCDate(),
        hour,
        minute,
      );
    })
    .toSorted((a, b) => a.getTime() - b.getTime());

/** The first and last moments doses can fall in, from start and until. */
function bounds(timing: Timing): { first?: Date; last?: Date } {
  const start = dueSpan(timing.started);
  const end = dueSpan(timing.until);
  // An until with a time includes that time; a day, month or year all of it.
  const timed = timing.until?.includes("T") ?? false;
  return {
    ...(start && { first: start.from }),
    ...(end && {
      last: timed ? end.from : new Date(end.overdueFrom.getTime() - 1),
    }),
  };
}

/** What every question starts from: none when there are no doses. */
function read(timing: Timing) {
  const found =
    timing.times && timing.times.length > 0 ? ruleOf(timing.days) : undefined;
  if (!found || !timing.times) return undefined;
  const { first, last } = bounds(timing);
  const times = timing.times;
  const inside = (dose: Date) =>
    (!first || dose >= first) && (!last || dose <= last);
  return { rule: found.rule, times, first, last, inside };
}

/** The doses on the local day `day`, earliest first. */
export function dosesOn(timing: Timing, day: Date): Date[] {
  const found = read(timing);
  if (!found) return [];
  const midnight = calendarDay(day);
  if (found.rule.between(midnight, midnight, true).length === 0) return [];
  return dosesAt(midnight, found.times).filter(found.inside);
}

/** The latest dose after `from` and up to `now`; undefined when none. */
export function latestDose(
  timing: Timing,
  from: Date,
  now: Date,
): Date | undefined {
  const found = read(timing);
  if (!found) return undefined;
  const upTo = found.last && found.last < now ? found.last : now;
  // The latest day with a dose by then: today's may all be later.
  let day = found.rule.before(calendarDay(upTo), true);
  let dose: Date | undefined;
  for (let tries = 0; day && !dose && tries < 2; tries++) {
    dose = dosesAt(day, found.times).findLast((d) => d <= upTo);
    if (!dose) day = found.rule.before(day, false);
  }
  if (!dose || dose <= from || (found.first && dose < found.first))
    return undefined;
  return dose;
}

/** Whether a dose falls after the local day `day`. */
export function laterDose(timing: Timing, day: Date): boolean {
  const found = read(timing);
  if (!found) return false;
  const tomorrow = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate() + 1,
  );
  const from = found.first && found.first > tomorrow ? found.first : tomorrow;
  // The first day with a dose from then: that day's may all be earlier.
  let next = found.rule.after(calendarDay(from), true);
  let dose: Date | undefined;
  for (let tries = 0; next && !dose && tries < 2; tries++) {
    dose = dosesAt(next, found.times).find((d) => d >= from);
    if (!dose) next = found.rule.after(next, false);
  }
  return dose !== undefined && (!found.last || dose <= found.last);
}

/**
 * A rule's days in plain words ("every week on Sunday"), with the day it
 * counts from when it names one; undefined when rrule.js can't say it fully,
 * so the rule shows as saved.
 */
export function daysWords(days: string): string | undefined {
  const found = ruleOf(days);
  if (!found?.rule.isFullyConvertibleToText()) return undefined;
  const from = found.from && shownDate(found.from.toISOString().slice(0, 10));
  return `${found.rule.toText()}${from ? `, from ${from}` : ""}`;
}
