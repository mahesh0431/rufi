// A result's values over time, worked out for drawing: where each value,
// the lab's range and the dates go on a chart of a given size. Neutral by
// design: the chart shows where a value sits, and the lab's own flag and
// note say what it means, in words. A value outside the range it was printed
// with gets a ring; Rufi adds no flag.
import type { ResultRow, ShownRow } from "@rufi/contracts/record";
import { printedDate } from "./dates.ts";

/** One edge of a printed range: its number, and how the lab printed it. */
interface Edge {
  value: number;
  text: string;
}

/** A printed range as numbers: "30 - 400", "<10" or ">40"; none when it isn't one of these. */
export interface Range {
  low?: Edge;
  high?: Edge;
}

const NUMBER = String.raw`(-?\d+(?:\.\d+)?)`;
const BETWEEN = new RegExp(
  String.raw`^\s*${NUMBER}\s*[-–—]\s*${NUMBER}(?![\d.])`,
);
const BOUND = new RegExp(String.raw`^\s*(<=?|≤|>=?|≥)\s*${NUMBER}(?![\d.])`);

const edge = (text: string): Edge => ({ value: Number(text), text });

/**
 * A printed range's numbers: "4.0 - 5.6" and "30–400 µg/L" are both edges,
 * "<10" only a high one, ">40" only a low one. Anything else ("Negative",
 * "see note") is no range: no band and no ring, and the table still shows
 * it as printed.
 */
export function rangeOf(printed: string | undefined): Range | undefined {
  if (printed === undefined) return undefined;
  const between = BETWEEN.exec(printed);
  if (between) {
    const [, low = "", high = ""] = between;
    return Number(low) <= Number(high)
      ? { low: edge(low), high: edge(high) }
      : undefined;
  }
  const bound = BOUND.exec(printed);
  if (bound) {
    const [, sign = "", number = ""] = bound;
    return sign.startsWith("<") || sign === "≤"
      ? { high: edge(number) }
      : { low: edge(number) };
  }
  return undefined;
}

/**
 * Whether a value is outside the range printed with it: only when that is
 * certain, so "<5" against a range from 3 is not ringed.
 */
export function isOutside(row: ResultRow): boolean {
  const range = rangeOf(row.range);
  if (row.number === undefined || range === undefined) return false;
  const below = row.comparator === ">" || row.comparator === ">=";
  const above = row.comparator === "<" || row.comparator === "<=";
  return (
    (range.low !== undefined && !below && row.number < range.low.value) ||
    (range.high !== undefined && !above && row.number > range.high.value)
  );
}

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
  /** Outside the range printed with it: drawn with a ring. */
  outside: boolean;
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
  /** The plot's left and right edge. */
  left: number;
  right: number;
  /** The newest value's range, as a pale band within the plot. */
  band?: { y: number; height: number };
  /** Range edges near the values, each a dashed line with its number. */
  edges: { y: number; text: string }[];
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
 * The chart of a result's values. The scale fits the values, and a range
 * edge comes in only when it is near them, so a wide range (30 to 400)
 * can't flatten the line. Time is spaced by date; one value sits in the
 * middle. A two-value result (blood pressure) has a second line.
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

  const seconds = placed.filter(
    (value): value is Placed & { second_number: number } =>
      value.second_number !== undefined,
  );
  const numbers = [
    ...placed.map((value) => value.number),
    ...seconds.map((value) => value.second_number),
  ];
  const d0 = Math.min(...numbers);
  const d1 = Math.max(...numbers);
  const spread = Math.max(d1 - d0, Math.abs(d1) * 0.1 || 1);
  let v0 = d0 - spread * 0.3;
  let v1 = d1 + spread * 0.3;
  const range = rangeOf(newest.range);
  const near = [range?.low, range?.high].filter(
    (end): end is Edge =>
      end !== undefined && end.value >= d0 - spread && end.value <= d1 + spread,
  );
  for (const end of near) {
    v0 = Math.min(v0, end.value - spread * 0.15);
    v1 = Math.max(v1, end.value + spread * 0.15);
  }
  const t0 = timeOf(placed[0]?.measured.date ?? newest.measured.date);
  const t1 = timeOf(newest.measured.date);
  const x = (date: string) =>
    left + (t1 === t0 ? 0.5 : (timeOf(date) - t0) / (t1 - t0)) * (right - left);
  const y = (value: number) =>
    top + (1 - (value - v0) / (v1 - v0)) * (bottom - top);
  const clamp = (at: number) => Math.max(top, Math.min(bottom, at));

  const band =
    range === undefined
      ? undefined
      : (() => {
          const high = clamp(range.high ? y(range.high.value) : top);
          const low = clamp(range.low ? y(range.low.value) : bottom);
          return low > high ? { y: high, height: low - high } : undefined;
        })();

  const xs = placed.map((value) => x(value.measured.date));
  const labelled = spaced(xs, VALUE_GAP);
  const line = (
    rows: readonly Placed[],
    number: (row: Placed) => number,
    text: (row: Placed) => string,
    second: boolean,
  ): TrendLine => {
    const points = rows.map((row, i) => {
      const at = placed.indexOf(row);
      return {
        x: x(row.measured.date),
        y: y(number(row)),
        text: text(row),
        outside: !second && isOutside(row),
        last: i === rows.length - 1,
        labelled: !mini && (labelled[at] ?? false),
      };
    });
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
      placed,
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
    left,
    right,
    ...(band && { band }),
    edges: mini
      ? []
      : near
          .map((end) => ({ y: y(end.value), text: end.text }))
          .filter((end) => end.y >= top && end.y <= bottom),
    ...(!mini &&
      newest.range !== undefined &&
      range !== undefined && { range: `Lab range ${newest.range}` }),
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
