// A result's values over time as a calm line: an ink line, a ring on a value
// the lab flagged, the newest value filled, and the lab's range as printed.
// No red, amber or green: the lab's flag and note say what it means, in
// words. Large in an open row, small after a row's value.
import { drawTrend, type TrendValue } from "./trend-drawing.ts";

const LARGE = { width: 640, height: 150 };
const MINI = { width: 88, height: 22, mini: true };

export function Trend({
  title,
  values,
  mini = false,
}: {
  /** What the values are, as the chart's spoken label starts. */
  title: string;
  values: readonly TrendValue[];
  mini?: boolean;
}) {
  const drawing = drawTrend(title, values, mini ? MINI : LARGE);
  if (drawing === undefined) return null;
  const { width, height } = drawing;
  return (
    <svg
      role="img"
      aria-label={drawing.said}
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      className={`block h-auto max-w-full overflow-visible ${mini ? "" : "my-2"}`}
    >
      {drawing.range !== undefined && (
        <Label x={drawing.right} y={11} anchor="end">
          {drawing.range}
        </Label>
      )}
      {drawing.lines.map((line) => (
        <g key={line.second ? "second" : "first"}>
          <path
            className="fill-none stroke-ink"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={line.second ? "4 3" : undefined}
            d={line.d}
          />
          {line.points.map((point, i) => (
            <g key={i}>
              {point.flagged && (
                <circle
                  className="fill-none stroke-ink opacity-55"
                  strokeWidth={1}
                  cx={point.x}
                  cy={point.y}
                  r={mini ? 4 : 7}
                />
              )}
              <circle
                className={`stroke-ink ${point.last ? "fill-ink" : "fill-surface"}`}
                strokeWidth={1.5}
                cx={point.x}
                cy={point.y}
                r={mini ? 1.8 : 3}
              />
              {point.labelled && (
                <text
                  className="fill-ink text-[11.5px] font-semibold tabular-nums"
                  x={point.x}
                  y={point.y - (point.flagged ? 11 : 8)}
                  textAnchor="middle"
                >
                  {point.text}
                </text>
              )}
            </g>
          ))}
        </g>
      ))}
      {drawing.dates.map((date) => (
        <Label key={date.x} x={date.x} y={height - 5} anchor={date.anchor}>
          {date.text}
        </Label>
      ))}
    </svg>
  );
}

function Label({
  x,
  y,
  anchor,
  children,
}: {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  children: string;
}) {
  return (
    <text className="fill-muted text-[11px]" x={x} y={y} textAnchor={anchor}>
      {children}
    </text>
  );
}
