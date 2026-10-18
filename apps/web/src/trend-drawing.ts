// A result's values over time, worked out for drawing: where each value and
// the dates go on a chart of a given size. Neutral by design: the chart shows
// where a value sits, and the lab's own words say what it means. A value the
// lab flagged (its printed flag, such as High or Low) gets a ring; Rufi adds
// no flag and reads nothing from the printed range, which is written as it
// came.
import type { ResultRow, ShownRow } from "@rufi/contracts/record";
import { printedDate } from "./dates.ts";

/** A calendar date ("2026", "2026-05", "2026-05-20T08:30") as a time to space values by. */
function timeOf(date: string): number {
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0] = date
    .split(/[-T:]/)
    .map(Number);
  return Date.UTC(year, month - 1, day, hour, minute);
}

/** A value with a date and a number: one the chart can place. */
type Placed = ResultRow & {
  number: number;
  measured: NonNullable<ResultRow["measured"]>;
};

/**
 * The values a chart can place, oldest first as the series has them: those
 * with a calendar date and a number. The others stay in the table.
 */
function placedOf(values: readonly ShownRow[]): Placed[] {
  return values.filter(
    (value): value is Placed =>
      !("problem" in value) &&
      value.kind === "result" &&
      value.number !== undefined &&
      value.measured !== undefined &&
      /^\d{4}/.test(value.measured.date),
  );
}

interface TrendPoint {
  x: number;
  y: number;
  /** The value as the chart writes it above its point. */
  text: string;
  /** The lab printed a flag with it: drawn with a ring. */
  flagged: boolean;
  /** The newest value: drawn filled. */
  last: boolean;
  /** Whether its value is written above it (none where they would crowd). */
  labelled: boolean;
}

interface TrendLine {
  /** SVG path data. */
  d: string;
  /** The second number of a two-value result (blood pressure): dashed. */
  second: boolean;
  points: TrendPoint[];
}

export interface TrendDrawing {
  width: number;
  height: number;
  /** The plot's right edge. */
  right: number;
  /** The newest value's range as printed, written at the top right. */
  range?: string;
  lines: TrendLine[];
  /** Dates under the values, where they don't crowd. */
  dates: { x: number; text: string; anchor: "start" | "middle" | "end" }[];
  /** What a screen reader says: every value, its date and the range. */
  said: string;
}

/** The room around the plot, for labels; a small trend has none. */
const ROOM = {
  large: { left: 44, right: 24, top: 22, bottom: 22 },
  mini: { left: 3, right: 4, top: 3, bottom: 3 },
};
/** Values and dates written closer than this would crowd. */
const VALUE_GAP = 30;
const DATE_GAP = 84;

/** Which of these positions get a label: the last always, the others only where they don't crowd it or each other. */
function spaced(xs: number[], gap: number): boolean[] {
  const shown = xs.map(() => false);
  let previous = -Infinity;
  const last = xs.length - 1;
  xs.forEach((x, i) => {
    if (i === last || (x - previous >= gap && (xs[last] ?? x) - x >= gap)) {
      shown[i] = true;
      previous = x;
    }
  });
  return shown;
}

/**
 * The chart of a result's values. The scale fits the values, so a wide
 * range can't flatten the line. Time is spaced by date; one value sits in
 * the middle. A two-value result (blood pressure) has a second line.
 */
export function drawTrend(
  title: string,
  values: readonly ShownRow[],
  size: { width: number; height: number; mini?: boolean },
): TrendDrawing | undefined {
  const placed = placedOf(values);
  const newest = placed.at(-1);
  if (newest === undefined) return undefined;
  const { width, height } = size;
  const mini = size.mini === true;
  const room = mini ? ROOM.mini : ROOM.large;
  const left = room.left;
  const right = width - room.right;
  const top = room.top;
  const bottom = height - room.bottom;

  let d0 = Infinity;
  let d1 = -Infinity;
  for (const value of placed) {
    for (const number of [value.number, value.second_number ?? value.number]) {
      d0 = Math.min(d0, number);
      d1 = Math.max(d1, number);
    }
  }
  const spread = Math.max(d1 - d0, Math.abs(d1) * 0.1 || 1);
  const v0 = d0 - spread * 0.3;
  const v1 = d1 + spread * 0.3;
  const t0 = timeOf(placed[0]?.measured.date ?? newest.measured.date);
  const t1 = timeOf(newest.measured.date);
  const x = (date: string) =>
    left + (t1 === t0 ? 0.5 : (timeOf(date) - t0) / (t1 - t0)) * (right - left);
  const y = (value: number) =>
    top + (1 - (value - v0) / (v1 - v0)) * (bottom - top);

  const xs = placed.map((value) => x(value.measured.date));
  const labelled = spaced(xs, VALUE_GAP);
  // Each value with its place in `placed`, so nothing is searched for again.
  const indexed = placed.map((row, at) => ({ row, at }));
  const seconds = indexed.filter(({ row }) => row.second_number !== undefined);
  const line = (
    rows: readonly { row: Placed; at: number }[],
    number: (row: Placed) => number,
    text: (row: Placed) => string,
    second: boolean,
  ): TrendLine => {
    const points = rows.map(({ row, at }, i) => ({
      x: xs[at] ?? left,
      y: y(number(row)),
      text: text(row),
      flagged: !second && row.flag !== undefined,
      last: i === rows.length - 1,
      labelled: !mini && (labelled[at] ?? false),
    }));
    return {
      d: points
        .map(
          (point, i) =>
            `${i === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
        )
        .join(" "),
      second,
      points,
    };
  };
  const two = seconds.length > 0;
  const lines = [
    line(
      indexed,
      (row) => row.number,
      (row) => (two ? String(row.number) : row.value),
      false,
    ),
    ...(two
      ? [
          line(
            seconds,
            (row) => row.second_number ?? row.number,
            (row) => String(row.second_number),
            true,
          ),
        ]
      : []),
  ];

  const dated = spaced(xs, DATE_GAP);
  const said = `${title} over time: ${placed
    .map((value) => `${value.value} on ${printedDate(value.measured.date)}`)
    .join(
      ", ",
    )}${newest.range === undefined ? "" : `. Lab range ${newest.range}`}`;
  return {
    width,
    height,
    right,
    ...(!mini &&
      newest.range !== undefined && { range: `Lab range ${newest.range}` }),
    lines,
    dates: mini
      ? []
      : placed.flatMap((value, i) => {
          const at = xs[i] ?? left;
          if (!dated[i]) return [];
          const anchor =
            i === 0 && at - left < 30 && placed.length > 1
              ? "start"
              : i === placed.length - 1 && right - at < 30
                ? "end"
                : "middle";
          return [{ x: at, text: printedDate(value.measured.date), anchor }];
        }),
    said,
  };
}
