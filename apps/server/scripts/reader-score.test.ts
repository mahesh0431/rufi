import { describe, expect, it } from "vitest";
import { PRESCRIPTION } from "../tests/pack/reports.ts";
import { chooseItems, scoreItems, type Draft } from "./reader-score.ts";

const draft = (test: string, value: string, iso?: string): Draft => ({
  page: 1,
  fields: {
    test_name: test,
    value_text: value,
    ...(iso !== undefined && { date: { iso } }),
  },
  unsure: false,
});

describe("the reader pack's score", () => {
  it("counts a measurement's wrong date apart from its value: the collection date given to the visit's measurements, and a date given to one with none", () => {
    const score = scoreItems(PRESCRIPTION.key.items, [
      draft("Blood pressure", "130/85", "2026-10-01"),
      draft("Weight", "72", "2026-10-05"),
      draft("Height", "160", "2026-10-01"),
      // A lab value's own date isn't scored.
      draft("TSH", "4.8"),
    ]);
    expect(score).toEqual({
      correct: 4,
      missed: 0,
      wrongFlagged: 0,
      wrongSilent: 0,
      extra: 0,
      wrongItemDates: 2,
      wrong: [
        "p1 Blood pressure: date 2026-10-01 for 2026-10-05",
        "p1 Height: date 2026-10-01 for none",
      ],
    });
  });
});

describe("the reader pack's documents", () => {
  it("reads a document named with --only once, also when both sets have it", () => {
    const shared = { name: "prescription" };
    const dense = [{ name: "big_300_2_pages" }, shared];
    const pack = [{ name: "cbc" }, shared];
    expect(
      chooseItems(dense, pack, { only: ["prescription"], all: false }),
    ).toEqual([shared]);
    expect(chooseItems(dense, pack, { all: false })).toBe(dense);
    expect(chooseItems(dense, pack, { all: true })).toBe(pack);
  });
});
