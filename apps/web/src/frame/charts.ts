// A visual's charts (ADR 0037), drawn by Rufi in the visual's frame. The
// AI writes each chart as a Chart.js config in JSON, where the chart goes
// (<script type="application/json" data-rufi-chart>); the frame's page puts
// a canvas in its place, holding the JSON as text, before anything is live.
// Here it is parsed, and only its type, data and options go to Chart.js:
// JSON holds no function, nothing is loaded or revived, and nothing is merged
// deeply. Rufi owns how a chart sizes and moves, its series' look where the
// AI gave none, and its tooltip, which says only what the record holds: a
// point's date as written, at its precision, and its value as printed (its
// "text"). A chart that can't be drawn is reported as the visual's error, so
// the screen says part of it didn't load.
import {
  Chart,
  type ChartTheme,
  seriesLook,
  themeAt,
  themeCharts,
} from "../charts.ts";
import { printedDate } from "../dates.ts";

type Json = Record<string, unknown>;

/** A chart's text size, in pixels, at the screens' default text size. */
const DEFAULT_SIZE = 11;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A point the AI gave its value as printed: the only kind with a tooltip. */
const textOf = (raw: unknown) =>
  isObject(raw) && typeof raw["text"] === "string" ? raw["text"] : undefined;

interface Item {
  raw: unknown;
  dataset: { label?: unknown; indexAxis?: unknown };
  chart: { options: { indexAxis?: unknown } };
}

/**
 * Rufi's tooltip: the point's date as written, at its precision, from its
 * index field (y for a horizontal chart), and its value as printed. With no
 * date as written there is no title: never a coordinate turned into one.
 */
const callbacks = {
  title: (items: Item[]) => {
    const item = items[0];
    if (!item || !isObject(item.raw)) return "";
    const axis = item.dataset.indexAxis ?? item.chart.options.indexAxis;
    const date = item.raw[axis === "y" ? "y" : "x"];
    return typeof date === "string" ? printedDate(date) : "";
  },
  label: (item: Item) => {
    const text = textOf(item.raw) ?? "";
    const label = item.dataset.label;
    return typeof label === "string" && label !== ""
      ? `${label}: ${text}`
      : text;
  },
};

/** One chart, from its canvas's JSON. */
function chartOn(canvas: HTMLCanvasElement, theme: ChartTheme): void {
  const given: unknown = JSON.parse(
    canvas.getAttribute("data-rufi-chart") ?? "",
  );
  if (
    !isObject(given) ||
    typeof given["type"] !== "string" ||
    !isObject(given["data"])
  ) {
    throw new Error("A chart's JSON needs its type and data.");
  }
  const type = given["type"];
  const data = given["data"];
  const options = isObject(given["options"]) ? given["options"] : {};
  options["responsive"] = true;
  options["maintainAspectRatio"] = true;
  options["animation"] = false;
  // A chart's shape (the AI's, else Chart.js's 2:1) at the default text
  // size; a larger text makes it taller by as much, so its labels never
  // squash the plot.
  const shape =
    typeof options["aspectRatio"] === "number" ? options["aspectRatio"] : 2;
  options["aspectRatio"] = shape * Math.min(1, DEFAULT_SIZE / theme.size);
  const plugins = isObject(options["plugins"]) ? options["plugins"] : {};
  options["plugins"] = plugins;
  const legend = isObject(plugins["legend"]) ? plugins["legend"] : {};
  plugins["legend"] = legend;
  legend["labels"] = {
    ...(isObject(legend["labels"]) ? legend["labels"] : {}),
    usePointStyle: true,
  };
  plugins["tooltip"] = {
    ...(isObject(plugins["tooltip"]) ? plugins["tooltip"] : {}),
    filter: (item: { raw: unknown }) => textOf(item.raw) !== undefined,
    callbacks,
  };
  const datasets = Array.isArray(data["datasets"]) ? data["datasets"] : [];
  datasets.forEach((dataset: unknown, index) => {
    if (!isObject(dataset)) return;
    // A series' own tooltip callbacks come before the chart's: Rufi's
    // there too.
    if (isObject(dataset["tooltip"])) {
      dataset["tooltip"] = { ...dataset["tooltip"], callbacks };
    }
    if (
      dataset["borderColor"] !== undefined ||
      dataset["backgroundColor"] !== undefined
    ) {
      return;
    }
    const look = typeof dataset["type"] === "string" ? dataset["type"] : type;
    Object.assign(dataset, seriesLook(index, look, theme));
  });
  if (!canvas.hasAttribute("aria-label")) {
    const names = datasets.flatMap((dataset: unknown) =>
      isObject(dataset) && typeof dataset["label"] === "string"
        ? [dataset["label"]]
        : [],
    );
    canvas.setAttribute("aria-label", `Chart: ${names.join(", ")}`);
  }
  new Chart(canvas, { type, data, options } as never);
}

/**
 * Draws every chart in the visual, in the theme as it is now: once it is in
 * the body (the frame's page calls it), and again on a new theme.
 */
export function draw(): void {
  const theme = themeAt(document.body);
  themeCharts(theme);
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>(
    "canvas[data-rufi-chart]",
  )) {
    try {
      Chart.getChart(canvas)?.destroy();
      chartOn(canvas, theme);
    } catch (error) {
      reportError(error);
    }
  }
}

// A new theme: the card script has painted it (its listener came first), so
// every chart is drawn again from its JSON. Chart.js copies a theme's
// colours into a chart's scales when it first draws it, so an update alone
// would keep the old ones there.
addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (
    event.source !== window.parent ||
    !isObject(message) ||
    message["type"] !== "rufi-visual-theme"
  ) {
    return;
  }
  draw();
});
