// When a medicine's doses fall (docs/adr/0031): its times on the days its
// rule gives, from its start to its until, on the Mac's local time.
import { describe, expect, it } from "vitest";
import { dosesOn, latestDose, laterDose, type Timing } from "./doses.ts";

/** A local time on the Mac, never through UTC. */
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min);

/** Amoxicillin 1-0-1 × 5 days, from tonight 21:00 to the morning of 6 Nov. */
const amoxicillin: Timing = {
  times: ["08:00", "21:00"],
  days: null,
  started: "2026-11-01T21:00",
  until: "2026-11-06T08:00",
};

/** Every local dose from 1 to 30 Nov, read one day at a time. */
const november = (timing: Timing) =>
  Array.from({ length: 30 }, (_, i) => dosesOn(timing, at(2026, 11, i + 1)))
    .flat()
    .map((dose) => dose.toLocaleString("sv"));

describe("doses", () => {
  it("gives a course's ten doses, from its first to its last", () => {
    expect(november(amoxicillin)).toEqual([
      "2026-11-01 21:00:00",
      ...["02", "03", "04", "05"].flatMap((d) => [
        `2026-11-${d} 08:00:00`,
        `2026-11-${d} 21:00:00`,
      ]),
      "2026-11-06 08:00:00",
    ]);
  });

  it("includes every time of an until's day when it is a day", () => {
    const doses = november({ ...amoxicillin, until: "2026-11-06" });
    expect(doses.at(-1)).toBe("2026-11-06 21:00:00");
    expect(doses).toHaveLength(11);
  });

  it("gives a weekly rule's day only", () => {
    const vitaminD: Timing = {
      times: ["09:00"],
      days: "FREQ=WEEKLY;BYDAY=SU",
      started: null,
      until: null,
    };
    expect(november(vitaminD)).toEqual(
      ["01", "08", "15", "22", "29"].map((d) => `2026-11-${d} 09:00:00`),
    );
  });

  it("keeps a saved every-2-days rule on the same days, whichever day asks", () => {
    const iron: Timing = {
      times: ["08:00"],
      days: "DTSTART;VALUE=DATE:20261101\nRRULE:FREQ=DAILY;INTERVAL=2",
      started: null,
      until: null,
    };
    const expected = ["01", "03", "05", "07"].map(
      (d) => `2026-11-${d} 08:00:00`,
    );
    expect(november(iron).slice(0, 4)).toEqual(expected);
    // Asked from a later day, and as the latest dose before a time.
    expect(dosesOn(iron, at(2026, 11, 4))).toEqual([]);
    expect(latestDose(iron, at(2026, 11, 1), at(2026, 11, 4, 23))).toEqual(
      at(2026, 11, 3, 8),
    );
  });

  it("gives the latest dose after a time, only up to now and the until", () => {
    // Saved at 18:10: tonight's 21:00 is the first.
    expect(
      latestDose(amoxicillin, at(2026, 11, 1, 18, 10), at(2026, 11, 1, 20, 59)),
    ).toBe(undefined);
    expect(
      latestDose(amoxicillin, at(2026, 11, 1, 18, 10), at(2026, 11, 1, 21)),
    ).toEqual(at(2026, 11, 1, 21));
    // Already told 21:00: nothing more that night.
    expect(
      latestDose(amoxicillin, at(2026, 11, 1, 21), at(2026, 11, 1, 23)),
    ).toBe(undefined);
    // Days later, only the latest, and none after the last dose.
    expect(
      latestDose(amoxicillin, at(2026, 11, 1, 21), at(2026, 11, 4, 9)),
    ).toEqual(at(2026, 11, 4, 8));
    expect(
      latestDose(amoxicillin, at(2026, 11, 1, 21), at(2026, 11, 9)),
    ).toEqual(at(2026, 11, 6, 8));
  });

  it("tells whether a dose falls after a day", () => {
    expect(laterDose(amoxicillin, at(2026, 11, 5))).toBe(true);
    expect(laterDose(amoxicillin, at(2026, 11, 6))).toBe(false);
    const weekly: Timing = {
      times: ["09:00"],
      days: "FREQ=WEEKLY;BYDAY=SU",
      started: null,
      until: null,
    };
    expect(laterDose(weekly, at(2026, 11, 2))).toBe(true);
  });

  it("gives no doses for no times, or a rule it doesn't take", () => {
    expect(november({ ...amoxicillin, times: null })).toEqual([]);
    for (const days of [
      "FREQ=HOURLY",
      "FREQ=DAILY;BYHOUR=9",
      "FREQ=DAILY;COUNT=3",
      "every day",
    ]) {
      expect(november({ ...amoxicillin, days })).toEqual([]);
    }
  });
});
