// What Rufi AI may draw in a reply: an `openui-lang` block (OpenUI Lang,
// https://github.com/thesysdev/openui) naming these components, which the
// screens draw with Rufi's own trend (apps/web/src/visual.tsx). The AI learns
// them from visuals.md beside the analysis skill, written from this file by
// `pnpm visuals:md`.
//
// Replies keep their blocks as written, and a block's props are positional,
// so this contract is frozen: `Trend` and `Point` keep their names, the order
// of their props and what each means. A new prop goes only at the end, with
// a default. A change that would alter what an old block means gets a new
// component name, and the old one stays.
import "./jitless.ts";
import {
  createLibrary,
  createParser,
  defineComponent,
  type ElementNode,
} from "@openuidev/lang-core";
import { z } from "zod";

/** One value of a trend, as the record keeps it. */
export const Point = defineComponent({
  name: "Point",
  props: z.object({
    date: z.string(),
    value: z.string(),
    number: z.number().nullable().optional(),
    flag: z.string().nullable().optional(),
    range: z.string().nullable().optional(),
    second: z.number().nullable().optional(),
  }),
  description:
    'One value, as the record keeps it. date: its date at its precision (2026, 2026-05 or 2026-05-20), its words when it has no date, or "". value: as printed ("11.9", "<5"). number: the number the record keeps for it; left out when it keeps none. flag, range: as printed. second: a blood pressure\'s second number.',
  component: null,
});

/** One test's values over time. */
export const Trend = defineComponent({
  name: "Trend",
  props: z.object({
    title: z.string(),
    points: z.array(Point.ref),
    unit: z.string().nullable().optional(),
  }),
  description:
    "One test's values over time, in one unit. Rufi draws them by date, with a table of every value under it. title: the test's name; unit: as saved.",
  component: null,
});

export const visuals = createLibrary({
  root: "Trend",
  components: [Trend, Point],
});

const parser = createParser(visuals.toJSONSchema(), "Trend");

const isElement = (node: unknown): node is ElementNode =>
  typeof node === "object" && node !== null && "props" in node;

/** A Point with each prop as its schema has it (null is left out; nothing is coerced). */
const isPoint = (node: unknown): node is ElementNode =>
  isElement(node) &&
  node.typeName === "Point" &&
  Point.props.safeParse(node.props).success;

const trendFields = Trend.props.omit({ points: true });

/**
 * Whether a parsed block is what the components say: a Trend whose points
 * are all Points, every prop by its schema. OpenUI's parse doesn't check the
 * root's component, which component sits in a point's place, or a scalar
 * inside a prop that may be null.
 */
function fitsContract(root: ElementNode | null): boolean {
  if (root?.typeName !== "Trend") return false;
  const points = root.props["points"];
  return (
    trendFields.safeParse(root.props).success &&
    Array.isArray(points) &&
    points.every(isPoint)
  );
}

/**
 * A block as OpenUI parses it: `whole` when nothing is cut off, every name
 * used is defined and every name defined is used, nothing is wrong, and it
 * is a Trend of Points as the components say; and its points' props, as
 * the block gives them.
 */
export function readTrend(source: string): {
  whole: boolean;
  points: Record<string, unknown>[];
} {
  const { root, meta } = parser.parse(source);
  const points = root?.props["points"];
  return {
    whole:
      !meta.incomplete &&
      meta.unresolved.length === 0 &&
      meta.orphaned.length === 0 &&
      meta.errors.length === 0 &&
      fitsContract(root),
    points: (Array.isArray(points) ? points : []).flatMap((point: unknown) =>
      isElement(point) ? [point.props] : [],
    ),
  };
}

const PREAMBLE = `# A trend in your reply

A trend is one test's values over time. Rufi draws it in your reply from a short program in openui-lang, the language below. Write the program in a fenced code block marked \`openui-lang\`, with your Markdown around it.

Each block is a whole program on its own: to change a trend you showed before, write a new, complete block. One trend per block; for two tests, write two blocks.`;

const EXAMPLE = `\`\`\`openui-lang
root = Trend("Haemoglobin", [p1, p2, p3], "g/dL")
p1 = Point("2026-02-10", "11.2", 11.2, "L", "12.0-15.5")
p2 = Point("2026-05-20", "11.9", 11.9, "L", "12.0-15.5")
p3 = Point("2026-08-12", "12.6", 12.6, null, "12.0-15.5")
\`\`\``;

/** visuals.md: how to write a trend, from the components above. */
export const visualsPrompt = (): string =>
  `${visuals.prompt({
    preamble: PREAMBLE,
    additionalRules: [
      "Take each value from the record: its date, its value as printed, the number the record keeps for it, and its flag and range as printed. Rufi draws a value that has a date and a number, and lists every value in the table.",
    ],
    examples: [EXAMPLE],
    toolCalls: false,
    bindings: false,
    builtinFunctions: false,
  })}\n`;
