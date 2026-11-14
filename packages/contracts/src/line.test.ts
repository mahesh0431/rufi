import { describe, expect, it } from "vitest";
import { lineOf, lineOfPage } from "./line.ts";
import type { ResultRow } from "./record.ts";

/** A fictional creatinine result. */
const crea = (
  id: string,
  date: string | undefined,
  value: string,
  more: Partial<ResultRow> = {},
): ResultRow => ({
  kind: "result",
  id,
  test: "Creatinine",
  value,
  category: "lab",
  unit: "mg/dL",
  ...(date !== undefined && { measured: { date } }),
  in_test: "tst-crea",
  ...more,
});

describe("a test's line", () => {
  it("puts each result at its numbers in the test's unit, labelled as printed when those are the printed ones, else by its comparator and the test's numbers", () => {
    expect(
      lineOf(
        [
          crea("c1", "2026-03-01", "1.0", {
            number: 1,
            test_number: 1,
            range: "0.6 - 1.1",
          }),
          // Another lab's unit, converted.
          crea("c2", "2026-06-01", "<45", {
            comparator: "<",
            number: 45,
            unit: "µmol/L",
            test_number: 0.5,
            range: "45 - 90",
            flag: "L",
          }),
        ],
        (id) => (id === "c2" ? "Northgate Labs" : undefined),
      ),
    ).toEqual([
      {
        value: "1.0",
        number: 1,
        range: "0.6 - 1.1 mg/dL",
        measured: { date: "2026-03-01" },
      },
      {
        value: "<0.5",
        number: 0.5,
        flag: "L",
        range: "45 - 90 µmol/L · Northgate Labs",
        measured: { date: "2026-06-01" },
      },
    ]);
  });

  it("keeps a date at the precision the record has, and leaves out a value with no number in the test's unit or no calendar date", () => {
    const line = lineOf([
      crea("c1", "2025", "0.9", { number: 0.9, test_number: 0.9 }),
      crea("c2", "2025-03", "1.1", { number: 1.1, test_number: 1.1 }),
      crea("c3", "2025-04-02T08:30", "1.2", { number: 1.2, test_number: 1.2 }),
      // The AI couldn't compare it.
      crea("c4", "2025-05-01", "8", { number: 8, unit: "mmol/L" }),
      crea("c5", undefined, "1.0", { number: 1, test_number: 1 }),
      crea("c6", "2026 (date unclear)", "1.0", { number: 1, test_number: 1 }),
    ]);
    expect(line.map((value) => value.measured.date)).toEqual([
      "2025",
      "2025-03",
      "2025-04-02T08:30",
    ]);
  });

  it("has a blood pressure's second number in the test's unit, and its label from both", () => {
    expect(
      lineOf([
        crea("b1", "2026-09-20", "16.8/10.9", {
          test: "Blood pressure",
          number: 16.8,
          second_number: 10.9,
          unit: "kPa",
          test_number: 126,
          test_second_number: 82,
        }),
      ]),
    ).toEqual([
      {
        value: "126/82",
        number: 126,
        second_number: 82,
        measured: { date: "2026-09-20" },
      },
    ]);
  });

  it("on a test's page, runs oldest first, each range with the lab it was printed by", () => {
    const line = lineOfPage([
      {
        row: crea("c2", "2026-06-01", "1.1", {
          number: 1.1,
          test_number: 1.1,
          range: "0.6 - 1.1",
        }),
        report: { issuer: "Sunrise Labs" },
      },
      {
        row: crea("c1", "2026-03-01", "0.9", { number: 0.9, test_number: 0.9 }),
        report: null,
      },
    ]);
    expect(line.map(({ value, range }) => [value, range])).toEqual([
      ["0.9", undefined],
      ["1.1", "0.6 - 1.1 mg/dL · Sunrise Labs"],
    ]);
  });
});
