// Rufi's charts, with Chart.js: the parts Rufi draws with (line, bar and
// scatter charts; linear, category and time scales, the time scale through
// date-fns; the filler, legend and tooltip), and Rufi's look for them, from
// the theme's CSS variables where the chart is. A canvas can't read CSS
// variables, so a chart takes its colours and text size from `themeAt` each
// time the theme changes. No colour says anything about a value: series are
// told apart by colour and by shape (ADR 0037).
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  type PointStyle,
  type TimeUnit,
  ScatterController,
  TimeScale,
  Tooltip,
  _adapters,
} from "chart.js";
import "chartjs-adapter-date-fns";

Chart.register(
  LineController,
  BarController,
  ScatterController,
  LineElement,
  PointElement,
  BarElement,
  LinearScale,
  CategoryScale,
  TimeScale,
  Filler,
  Legend,
  Tooltip,
);
// A time axis's labels stay level, and Chart.js leaves out the ones that
// don't fit, rather than tilting every month's.
Chart.defaults.scales.time.ticks.maxRotation = 0;
Chart.defaults.scales.time.ticks.autoSkipPadding = 12;

// A time axis's step always moves on, or the chart fails. Chart.js adds
// its step until the axis's end; date-fns adds a day or a month only whole,
// and gives an unknown unit ("days") back unchanged, so half a day or a
// "days" step would add nothing and Chart.js would add it for ever. A step
// that doesn't move on throws instead, and the visual says part of it
// didn't load, as for any chart that fails.
const { add } = _adapters._date.prototype as {
  add: (time: number, amount: number, unit: TimeUnit) => number | Date;
};
_adapters._date.override({
  add(time, amount, unit) {
    const next = +add.call(this, time, amount, unit);
    if (!(next > time)) {
      throw new Error(
        `A time step of ${String(amount)} ${unit} doesn't move on.`,
      );
    }
    return next;
  },
});

export { Chart };

/** Rufi's theme where a chart is, worked out to what a canvas takes. */
export interface ChartTheme {
  ink: string;
  muted: string;
  line: string;
  accent: string;
  accentSoft: string;
  surface: string;
  font: string;
  /** A chart's text, as the Mac's trend labels: 0.6875rem, in pixels. */
  size: number;
}

/** The theme's variables where `element` is, as a chart takes them. */
export function themeAt(element: Element): ChartTheme {
  const style = getComputedStyle(element);
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    ink: read("--ink"),
    muted: read("--muted"),
    line: read("--line"),
    accent: read("--accent"),
    accentSoft: read("--accent-soft"),
    surface: read("--surface"),
    font: read("--font-ui"),
    size: Math.round((Number.isFinite(root) ? root : 16) * 0.6875),
  };
}

/** Every chart's defaults: labels, grid lines and text in Rufi's theme. */
export function themeCharts(theme: ChartTheme): void {
  Chart.defaults.color = theme.muted;
  Chart.defaults.borderColor = theme.line;
  Chart.defaults.font.family = theme.font;
  Chart.defaults.font.size = theme.size;
}

/** The six point shapes, in turn, that tell series apart with colour. */
const SHAPES: PointStyle[] = [
  "circle",
  "triangle",
  "rect",
  "rectRot",
  "crossRot",
  "star",
];

/**
 * The look of a chart's `index`th series, of chart type `type`: ink,
 * accent, then muted, then the same three dashed; each series its own point
 * shape. Bars, which have no shape, differ by fill: solid, soft, outline.
 */
export function seriesLook(
  index: number,
  type: string,
  theme: ChartTheme,
): Record<string, unknown> {
  const colour = [theme.ink, theme.accent, theme.muted][index % 3] ?? theme.ink;
  if (type === "bar") {
    const fill = [colour, theme.accentSoft, "transparent"][index % 3];
    return { backgroundColor: fill, borderColor: colour, borderWidth: 1.5 };
  }
  return {
    borderColor: colour,
    backgroundColor: colour,
    pointBackgroundColor: theme.surface,
    pointBorderColor: colour,
    pointStyle: SHAPES[index % SHAPES.length] ?? "circle",
    pointRadius: 3.5,
    pointHoverRadius: 5,
    borderWidth: 1.5,
    ...(index >= 3 && { borderDash: [4, 3] }),
  };
}
