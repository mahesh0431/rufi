// The due rules (plan part 6), on the Mac's local time: a date is due during
// its year, month, day (or from its time to the end of its day) and overdue
// after it; coming up when it is due within 30 days.
import { describe, expect, it } from "vitest";
import { classify } from "./due.ts";

/** A local time on the Mac, never through UTC. */
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min);

describe("classify", () => {
  it.each([
    // A year: due all of it, overdue from 1 January after.
    ["2026", at(2025, 6, 1), "later"],
    ["2026", at(2025, 12, 31, 23, 59), "coming_up"],
    ["2026", at(2026, 1, 1), "due"],
    ["2026", at(2026, 12, 31, 23, 59), "due"],
    ["2026", at(2027, 1, 1), "overdue"],
    // A month: due all of it, also when Rufi starts mid-month.
    ["2026-12", at(2026, 10, 11, 14, 20), "later"],
    ["2026-12", at(2026, 11, 30, 23, 59), "coming_up"],
    ["2026-12", at(2026, 12, 1), "due"],
    ["2026-12", at(2026, 12, 15, 9, 0), "due"],
    ["2026-12", at(2026, 12, 31, 23, 59), "due"],
    ["2026-12", at(2027, 1, 1), "overdue"],
    // A day: from its midnight to the next.
    ["2026-12-03", at(2026, 12, 2, 23, 59), "coming_up"],
    ["2026-12-03", at(2026, 12, 3), "due"],
    ["2026-12-03", at(2026, 12, 3, 0, 30), "due"],
    ["2026-12-03", at(2026, 12, 3, 23, 59), "due"],
    ["2026-12-03", at(2026, 12, 4), "overdue"],
    // A time: from that time to the end of its day.
    ["2026-12-03T14:30", at(2026, 12, 3, 14, 29), "coming_up"],
    ["2026-12-03T14:30", at(2026, 12, 3, 14, 30), "due"],
    ["2026-12-03T14:30", at(2026, 12, 3, 23, 59), "due"],
    ["2026-12-03T14:30", at(2026, 12, 4), "overdue"],
    // Coming up: due within the next 30 days.
    ["2026-11-10", at(2026, 10, 11, 14, 20), "coming_up"],
    ["2026-11-11", at(2026, 10, 11, 14, 20), "later"],
    // Never due.
    ["next_visit", at(2030, 1, 1), "next_visit"],
    [null, at(2030, 1, 1), "no_date"],
  ] as const)("%s at %o is %s", (due, now, expected) => {
    expect(classify(due, now)).toBe(expected);
  });
});
