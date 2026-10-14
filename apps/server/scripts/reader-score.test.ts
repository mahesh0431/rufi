import { describe, expect, it } from "vitest";
import { PRESCRIPTION } from "../tests/pack/reports.ts";
import { chooseItems, scoreItems, type Draft } from "./reader-score.ts";

const draft = (
  test: string,
  value: string,
  iso?: string,
  more: Partial<Draft["fields"]> = {},
): Draft => ({
  page: 1,
  fields: {
    test_name: test,
    value_text: value,
    ...(Number.isFinite(Number(value)) && { value_number: Number(value) }),
    ...(iso !== undefined && { date: { iso } }),
    ...more,
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
  it("counts a value wrong when its number or comparator isn't the key's, also when its printed text is right", () => {
    const key = [
      { page: 1, test: "TSH", value: "4,6", number: 4.6 },
      {
        page: 1,
        test: "CRP",
        value: "<5",
        number: 5,
        comparator: "<" as const,
      },
      { page: 1, test: "Protein", value: "Trace", number: null },
      { page: 1, test: "pH", value: "6.0", number: 6 },
    ];
    const score = scoreItems(key, [
      draft("TSH", "4,6", undefined, { value_number: 46 }),
      draft("CRP", "<5", undefined, { value_number: 5 }),
      {
        ...draft("Protein", "Trace", undefined, { value_number: 1 }),
        unsure: true,
      },
      draft("pH", "6.0"),
    ]);
    expect(score).toMatchObject({
      correct: 1,
      wrongFlagged: 1,
      wrongSilent: 2,
      wrong: [
        "p1 TSH: number 46 for 4.6",
        "p1 CRP: comparator none for <",
        "p1 Protein: number 1 for none (unsure)",
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
