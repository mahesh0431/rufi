// A Trend in a reply (openui/library.ts), drawn as the record page draws a
// result over time (trend.tsx), with a table of every value under it, so
// what was drawn is plain to see. Values in the order of their dates,
// whatever order the AI gave; those with no calendar date last, in the
// table, marked Not drawn.
import type { ComponentRenderProps, ElementNode } from "@openuidev/react-lang";
import { printedDate } from "../dates.ts";
import { Trend } from "../trend.tsx";
import {
  isCalendarDate,
  placedOf,
  timeOf,
  type TrendValue,
} from "../trend-drawing.ts";
import type { TrendProps } from "./library.ts";

/** One value as the block gives it, with nothing it left out or set to null. */
interface Given {
  date: string;
  value: string;
  number?: number;
  flag?: string;
  range?: string;
  second?: number;
}

const isElement = (node: unknown): node is ElementNode =>
  typeof node === "object" && node !== null && "props" in node;

/** The value as a trend reads it: a date only when it is a calendar date. */
const asTrendValue = (given: Given): TrendValue => ({
  value: given.value,
  ...(given.number !== undefined && { number: given.number }),
  ...(given.second !== undefined && { second_number: given.second }),
  ...(given.flag !== undefined && { flag: given.flag }),
  ...(given.range !== undefined && { range: given.range }),
  ...(isCalendarDate(given.date) && { measured: { date: given.date } }),
});

/** A point's props, with null as left out, so a missing number is never drawn at 0. */
function givenOf(props: Record<string, unknown>): Given {
  const text = (key: string) =>
    typeof props[key] === "string" ? props[key] : undefined;
  const number = (key: string) =>
    typeof props[key] === "number" ? props[key] : undefined;
  const given: Given = { date: text("date") ?? "", value: text("value") ?? "" };
  for (const [key, value] of [
    ["number", number("number")],
    ["flag", text("flag")],
    ["range", text("range")],
    ["second", number("second")],
  ] as const) {
    if (value !== undefined) Object.assign(given, { [key]: value });
  }
  return given;
}

/** Oldest first by date, whatever order the block gave; those with no calendar date last. */
const byDate = (values: readonly Given[]) =>
  values.toSorted((a, b) => {
    const [x, y] = [isCalendarDate(a.date), isCalendarDate(b.date)];
    if (!x || !y) return Number(!x) - Number(!y);
    return timeOf(a.date) - timeOf(b.date);
  });

export function TrendView({ props }: ComponentRenderProps<TrendProps>) {
  const given = byDate(
    (Array.isArray(props.points) ? (props.points as unknown[]) : [])
      .filter(isElement)
      .map((node) => givenOf(node.props)),
  );
  const values = given.map(asTrendValue);
  const drawn = new Set<TrendValue>(placedOf(values));
  const title =
    typeof props.unit === "string" && props.unit !== ""
      ? `${props.title} (${props.unit})`
      : props.title;
  const lab = given.some((g) => g.range !== undefined || g.flag !== undefined);
  return (
    <figure className="my-2">
      <h3>{title} over time</h3>
      <Trend title={title} values={values} />
      <table>
        <thead>
          <tr>
            <th>Measured</th>
            <th>Value</th>
            {lab && <th>Lab range</th>}
            {lab && <th>Lab note</th>}
          </tr>
        </thead>
        <tbody>
          {given.map((g, i) => (
            <tr key={i}>
              <td>
                {isCalendarDate(g.date)
                  ? printedDate(g.date)
                  : g.date || "No date"}
              </td>
              <td>
                {[g.value, props.unit].filter(Boolean).join(" ")}
                {!drawn.has(values[i] as TrendValue) && (
                  <span className="text-muted"> · Not drawn</span>
                )}
              </td>
              {lab && <td>{g.range}</td>}
              {lab && <td>{g.flag}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
