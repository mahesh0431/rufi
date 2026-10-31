// A trend in a reply: the AI's `openui-lang` block (@rufi/contracts/visuals),
// drawn by Rufi as the record page draws a result over time (trend.tsx),
// with a table of every value under it, so what was drawn is plain to see.
// While the reply is written, it draws what has come. Once the reply ended,
// it draws only a whole block (OpenUI's own parse: nothing cut off, every
// name used is defined and every name defined is used, no errors);
// otherwise the block shows as its text with a line, never as a partial
// trend. Display only: no tools, no actions, nothing the AI wrote runs.
// First: zod's settings, before OpenUI's packages build their schemas.
import "@rufi/contracts/jitless";
import {
  createLibrary,
  Renderer,
  type ElementNode,
  type OpenUIError,
} from "@openuidev/react-lang";
import { Point, readTrend, Trend as TrendPart } from "@rufi/contracts/visuals";
import { useMemo, useState, type ReactNode } from "react";
import { printedDate } from "./dates.ts";
import { Trend } from "./trend.tsx";
import {
  isCalendarDate,
  placedOf,
  timeOf,
  type TrendValue,
} from "./trend-drawing.ts";

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

function TrendView({
  props,
}: {
  props: { title: string; points: unknown[]; unit?: string | null };
}) {
  const given = byDate(
    (Array.isArray(props.points) ? props.points : [])
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

const library = createLibrary({
  root: "Trend",
  components: [
    { ...TrendPart, component: TrendView },
    { ...Point, component: () => null },
  ],
});
/**
 * The block `source` as a trend; `children` is the block as code, shown
 * instead when a finished block can't be drawn whole.
 */
export function Visual({
  source,
  streaming,
  children,
}: {
  source: string;
  streaming: boolean;
  children: ReactNode;
}) {
  const parsedWhole = useMemo(
    () => streaming || readTrend(source).whole,
    [source, streaming],
  );
  const [errors, setErrors] = useState<readonly OpenUIError[]>([]);
  if (!parsedWhole || (!streaming && errors.length > 0)) {
    return (
      <>
        {children}
        <p className="text-muted">This trend couldn't be drawn.</p>
      </>
    );
  }
  return (
    <Renderer.Root
      response={source}
      library={library}
      isStreaming={streaming}
      onError={setErrors}
      publishObservability={false}
    >
      <Renderer.Content />
    </Renderer.Root>
  );
}
