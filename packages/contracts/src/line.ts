// A test's line: its values over time, as both screens draw them. A result
// is on its test's line when it has a calendar date and a number in the
// test's unit, as the AI saved them (docs/adr/0028). Each value keeps its
// label as printed, or its comparator with the test's numbers, its date as
// the record keeps it and its range as printed: what a chart says about a
// point is what the record holds. Rufi adds no flag and reads nothing from
// the printed range.
import type {
  LineValue,
  ResultRow,
  ShownRow,
  TestRow,
  TestValue,
} from "./record.ts";

/**
 * Whether a date is a calendar date at the record's precision (YYYY,
 * YYYY-MM, YYYY-MM-DD or YYYY-MM-DDTHH:MM): the only dates a line places.
 * Other words, such as "2026 (date unclear)", stay in the list of values.
 */
const isCalendarDate = (date: string): boolean =>
  /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2})?)?)?$/.test(date);

/**
 * Whether a result is on its test's line: a calendar date and a number in
 * the test's unit. The others are only in the test's list of values.
 */
export const onTheLine = (row: ResultRow) =>
  row.test_number !== undefined &&
  row.measured !== undefined &&
  isCalendarDate(row.measured.date);

/**
 * Results as their test's line, in the order given (oldest first): each at
 * its numbers in the test's unit; labelled as printed when those are the
 * printed numbers, else by its comparator and the test's numbers (nothing
 * reads the printed words); its range named with its printed unit and,
 * from `labOf`, its lab, so a range never reads in another unit.
 */
export function lineOf(
  rows: readonly ShownRow[],
  labOf: (id: string) => string | undefined = () => undefined,
): LineValue[] {
  return rows.flatMap((row) => {
    if ("problem" in row || row.kind !== "result" || !onTheLine(row)) {
      return [];
    }
    const { test_number: number, test_second_number: second } = row;
    if (number === undefined || row.measured === undefined) return [];
    const printed = number === row.number && second === row.second_number;
    const numbers =
      second === undefined
        ? String(number)
        : `${String(number)}/${String(second)}`;
    const lab = labOf(row.id);
    return [
      {
        value: printed ? row.value : `${row.comparator ?? ""}${numbers}`,
        number,
        ...(second !== undefined && { second_number: second }),
        ...(row.flag !== undefined && { flag: row.flag }),
        ...(row.range !== undefined && {
          range: `${[row.range, row.unit].filter(Boolean).join(" ")}${lab === undefined ? "" : ` · ${lab}`}`,
        }),
        measured: row.measured,
      },
    ];
  });
}

/** A test's line's name: its name and the unit its numbers are in. */
export const lineTitle = (test: TestRow) =>
  test.unit === undefined ? test.name : `${test.name} (${test.unit})`;

/** A test's page's values, newest first, as its line, oldest first. */
export const lineOfPage = (values: readonly TestValue[]) => {
  const labs = new Map(
    values.flatMap(({ row, report }) =>
      report?.issuer === undefined ? [] : [[row.id, report.issuer] as const],
    ),
  );
  return lineOf(values.map(({ row }) => row).toReversed(), (id) =>
    labs.get(id),
  );
};
