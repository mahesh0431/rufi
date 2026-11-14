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

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A point the AI gave its value as printed: the only kind with a tooltip. */
const textOf = (raw: unknown) =>
  isObject(raw) && typeof raw["text"] === "string" ? raw["text"] : undefined;

/** The series Rufi gave its look, with their place and type. */
const styled = new WeakMap<object, { index: number; type: string }>();

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
    callbacks: {
      title: (items: { raw: unknown }[]) => {
        const raw = items[0]?.raw;
        return isObject(raw) && typeof raw["x"] === "string"
          ? printedDate(raw["x"])
          : undefined;
      },
      label: (item: { raw: unknown; dataset: { label?: unknown } }) => {
        const text = textOf(item.raw) ?? "";
        const label = item.dataset.label;
        return typeof label === "string" && label !== ""
          ? `${label}: ${text}`
          : text;
      },
    },
  };
  const datasets = Array.isArray(data["datasets"]) ? data["datasets"] : [];
  datasets.forEach((dataset: unknown, index) => {
    if (
      !isObject(dataset) ||
      dataset["borderColor"] !== undefined ||
      dataset["backgroundColor"] !== undefined
    ) {
      return;
    }
    const look = {
      index,
      type: typeof dataset["type"] === "string" ? dataset["type"] : type,
    };
    styled.set(dataset, look);
    Object.assign(dataset, seriesLook(look.index, look.type, theme));
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
 * Draws every chart in the visual, once it is in the body; the frame's page
 * calls it.
 */
export function draw(): void {
  const theme = themeAt(document.body);
  themeCharts(theme);
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>(
    "canvas[data-rufi-chart]",
  )) {
    try {
      chartOn(canvas, theme);
    } catch (error) {
      reportError(error);
    }
  }
}

// A new theme: the card script has painted it (its listener came first), so
// every chart takes the new colours and size, and draws again.
addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (
    event.source !== window.parent ||
    !isObject(message) ||
    message["type"] !== "rufi-visual-theme"
  ) {
    return;
  }
  const theme = themeAt(document.body);
  themeCharts(theme);
  for (const chart of Object.values(Chart.instances)) {
    for (const dataset of chart.data.datasets) {
      const look = styled.get(dataset);
      if (look)
        Object.assign(dataset, seriesLook(look.index, look.type, theme));
    }
    chart.update();
  }
});

export { Chart };
