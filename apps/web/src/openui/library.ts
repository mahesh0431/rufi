// Rufi AI's replies are OpenUI Lang (https://github.com/thesysdev/openui),
// drawn by OpenUI's renderer with OpenUI's chat library, extended the way its
// docs say (`library.extend`) with a few parts of Rufi's own:
// - Trend and TrendPoint: one test's values over time, spaced by date (OpenUI's
//   LineChart spaces its points evenly), with a table of every value;
// - Page: an HTML page the AI made in its folder, shown whole in a locked
//   frame (OpenUI's open-ended HTML pattern: one component, a sandboxed frame);
// - Diagram: Mermaid text, drawn in Rufi's diagram frame;
// - TextContent, MarkDownRenderer, Callout, Steps and Card, OpenUI's own
//   with the same props, drawn so every link opens by Rufi's rule (parts.tsx),
//   and Image, for the AI's picture files.
// Without JSX, so `pnpm openui:md` can load it in Node and write the prompt
// Rufi AI is told (apps/server/src/core/chat/openui.md); the screens give
// the renderers (reply.tsx).
//
// Replies keep their text as the AI wrote it, and props are positional, so
// Rufi's parts are frozen: they keep their names, the order of their props
// and what each means. A new prop goes only at the end, with a default.
import "@rufi/contracts/jitless";
import {
  createParser,
  defineComponent,
  type ComponentRenderer,
  type ElementNode,
  type PromptOptions,
} from "@openuidev/react-lang";
import {
  openuiChatAdditionalRules,
  openuiChatLibrary,
  openuiChatPromptOptions,
} from "@openuidev/react-ui/genui-lib";
import { z } from "zod";

/** One value of a trend, as the record keeps it; Trend draws it. */
const pointProps = z.object({
  date: z.string(),
  value: z.string(),
  number: z.number().nullable().optional(),
  flag: z.string().nullable().optional(),
  range: z.string().nullable().optional(),
  second: z.number().nullable().optional(),
});
const TrendPoint = defineComponent({
  name: "TrendPoint",
  props: pointProps,
  description:
    'One value, as the record keeps it. date: its date at its precision (2026, 2026-05 or 2026-05-20), its words when it has no date, or "". value: as printed ("11.9", "<5"). number: the number the record keeps for it; left out when it keeps none. flag, range: as printed. second: a blood pressure\'s second number.',
  component: () => null,
});

const trendProps = z.object({
  title: z.string(),
  points: z.array(TrendPoint.ref),
  unit: z.string().nullable().optional(),
});
export type TrendProps = z.infer<typeof trendProps>;

/** What the screens draw Rufi's parts with; Node gives none. */
export interface Renderers {
  Trend: ComponentRenderer<TrendProps>;
  Page: ComponentRenderer<{ path: string; title: string }>;
  Diagram: ComponentRenderer<{ source: string }>;
  TextContent: ComponentRenderer;
  MarkDownRenderer: ComponentRenderer;
  Image: ComponentRenderer;
  Card: ComponentRenderer;
  Callout: ComponentRenderer;
  Steps: ComponentRenderer;
}

const nothing = () => null;
const NONE: Renderers = {
  Trend: nothing,
  Page: nothing,
  Diagram: nothing,
  TextContent: nothing,
  MarkDownRenderer: nothing,
  Image: nothing,
  Card: nothing,
  Callout: nothing,
  Steps: nothing,
};

/** OpenUI's part of this name in its chat library, drawn by Rufi. */
function ownPart(
  name:
    | "TextContent"
    | "MarkDownRenderer"
    | "Image"
    | "Card"
    | "Callout"
    | "Steps",
  component: ComponentRenderer,
) {
  const part = openuiChatLibrary.components[name];
  if (!part) throw new Error(`OpenUI's chat library has no ${name}.`);
  return { ...part, component };
}

/** Rufi's reply library: OpenUI's chat library with Rufi's parts. */
export function replyLibrary(draw: Renderers = NONE) {
  const Trend = defineComponent({
    name: "Trend",
    props: trendProps,
    description:
      "One test's values over time, in one unit: Rufi draws them spaced by their dates, with a table of every value under it. Use it, not LineChart, for one test over time. title: the test's name; unit: as saved.",
    component: draw.Trend,
  });
  const Page = defineComponent({
    name: "Page",
    props: z.object({ path: z.string(), title: z.string() }),
    description:
      "An HTML page you made in your folder, shown whole in the reply, with Open to show it large. path: its path in your folder, such as reports/results-2026.html. title: a noun that names it.",
    component: draw.Page,
  });
  const Diagram = defineComponent({
    name: "Diagram",
    props: z.object({ source: z.string() }),
    description:
      "A diagram Rufi draws from Mermaid text (a flowchart, a sequence, a timeline), in Rufi's colours. source: the Mermaid text, its lines joined with \\n.",
    component: draw.Diagram,
  });
  return openuiChatLibrary.extend({
    components: {
      add: [
        { component: Trend, slots: ["Card.children"] },
        TrendPoint,
        { component: Page, slots: ["Card.children"] },
        { component: Diagram, slots: ["Card.children"] },
      ],
      override: [
        ownPart("TextContent", draw.TextContent),
        ownPart("MarkDownRenderer", draw.MarkDownRenderer),
        ownPart("Image", draw.Image),
        ownPart("Card", draw.Card),
        ownPart("Callout", draw.Callout),
        ownPart("Steps", draw.Steps),
      ],
    },
  });
}

const isElement = (node: unknown): node is ElementNode =>
  typeof node === "object" &&
  node !== null &&
  (node as { type?: unknown }).type === "element";

/** A part of the JSON schema OpenUI makes of the library. */
interface Schema {
  type?: string | string[];
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  anyOf?: Schema[];
  oneOf?: Schema[];
  $ref?: string;
}

/** The parts a place in the schema takes, by name; none when it names none. */
const partsTaken = (schema: Schema): string[] =>
  (schema.anyOf ?? schema.oneOf ?? [schema]).flatMap((option) =>
    option.$ref?.startsWith("#/$defs/")
      ? [option.$ref.slice("#/$defs/".length)]
      : [],
  );

const TYPES: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number",
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  null: (value) => value === null,
  array: Array.isArray,
  object: (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value),
};

/** A place the schema says nothing about, such as a table column's data. */
const isFree = (schema: Schema) =>
  !schema.$ref &&
  !schema.anyOf &&
  !schema.oneOf &&
  schema.type === undefined &&
  !schema.enum &&
  !schema.items &&
  !schema.properties;

/**
 * Whether a value fits its place in the library's schema: a part only where
 * that part may go (anywhere in a free place), each part's props by its own
 * schema wherever it sits, plain values by their type, nothing coerced. An
 * expression (a variable, an action) is OpenUI's to read, and null is a prop
 * left out.
 */
function fits(
  value: unknown,
  schema: Schema = {},
  defs: Record<string, Schema>,
): boolean {
  if (value === null) return true;
  if (isElement(value)) {
    const def = defs[value.typeName];
    return (
      def !== undefined &&
      (isFree(schema) || partsTaken(schema).includes(value.typeName)) &&
      Object.entries(value.props).every(([name, prop]) =>
        fits(prop, def.properties?.[name], defs),
      )
    );
  }
  if (typeof value === "object" && "k" in value) return true;
  const options = schema.anyOf ?? schema.oneOf;
  if (options) return options.some((option) => fits(value, option, defs));
  if (schema.$ref) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const types = schema.type === undefined ? [] : [schema.type].flat();
  if (types.length > 0 && !types.some((type) => TYPES[type]?.(value))) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((item) => fits(item, schema.items, defs));
  }
  if (typeof value === "object") {
    return Object.entries(value).every(([name, item]) =>
      fits(item, schema.properties?.[name], defs),
    );
  }
  return true;
}

/** Reads a reply as OpenUI parses it with the library it was made for. */
export function replyReader(library: ReturnType<typeof replyLibrary>) {
  const schema = library.toJSONSchema();
  return {
    parser: createParser(schema, "Card"),
    defs: (schema as { $defs?: Record<string, Schema> }).$defs ?? {},
  };
}

/**
 * A finished reply: `drawn` when OpenUI's parse is whole (nothing cut off,
 * every name used is defined and every name defined is used, no errors)
 * and its tree fits the library's schema, from its Card down; `words` when
 * it has no OpenUI at all; otherwise `broken`, never drawn in part (a value
 * could go missing: OpenUI doesn't check which part sits in a part's place).
 */
export function shapeOf(
  reader: ReturnType<typeof replyReader>,
  text: string,
): "drawn" | "words" | "broken" {
  const { root, meta } = reader.parser.parse(text);
  if (root === null) return "words";
  const whole =
    !meta.incomplete &&
    meta.unresolved.length === 0 &&
    meta.orphaned.length === 0 &&
    meta.errors.every((error) => error.severity === "warning");
  return whole && fits(root, { $ref: "#/$defs/Card" }, reader.defs)
    ? "drawn"
    : "broken";
}

/** OpenUI's chat rule Rufi leaves out: Rufi never makes up health data. */
const MADE_UP_DATA = "When asked about data, generate realistic/plausible data";

const PREAMBLE = `# How your answer is shown

Rufi's chat draws your answer with OpenUI. Write your whole final answer in openui-lang, the declarative UI language below, and nothing else: no Markdown around it and no code fence. Rufi draws it as it is written. Notes you write while you work, before your answer, are a sentence or two of plain text.`;

const RULES = [
  "Every value, date and range you show comes from the user's health record, a document in this chat or a source you cite, as it is kept there. Never invent, round off or fill in a value, not even as an example.",
  "For one test's values over time, use Trend with a TrendPoint per value, taken from the record: its date, its value as printed, the number the record keeps for it, and its flag and range as printed. Use the other charts for other comparisons.",
  "Links go in TextContent as Markdown links, [words](address): a web page by its https address, and a page of Rufi by its rufi:/ address as your instructions say. A Card's sources and @OpenUrl take the same addresses.",
  "A page or a picture you made is a file in your folder: show a page with Page(path, title) and a picture with Image(alt, path).",
  "Buttons and follow-ups send their words to you as the user's message, and a form sends its values. Offer only what you can do for the user in Rufi.",
];

const EXAMPLE = `Example — One test over time, from the user's record (fictional values):

root = Card([header, intro, trend, followUps])
header = CardHeader("Haemoglobin", "Your last three results")
intro = TextContent("Your haemoglobin went up this year and reached the lab's range in August. The values are from [your Sunrise Labs report](rufi:/documents/doc-1).")
trend = Trend("Haemoglobin", [p1, p2, p3], "g/dL")
p1 = TrendPoint("2026-02-10", "11.2", 11.2, "L", "12.0-15.5")
p2 = TrendPoint("2026-05-20", "11.9", 11.9, "L", "12.0-15.5")
p3 = TrendPoint("2026-08-12", "12.6", 12.6, null, "12.0-15.5")
followUps = FollowUpBlock([f1, f2])
f1 = FollowUpItem("What can raise my haemoglobin?")
f2 = FollowUpItem("Show my ferritin too")`;

/** How Rufi AI writes a reply: OpenUI's chat options, with Rufi's. */
function replyPromptOptions(): PromptOptions {
  const rules = openuiChatAdditionalRules.filter(
    (rule) => rule !== MADE_UP_DATA,
  );
  if (rules.length === openuiChatAdditionalRules.length) {
    throw new Error(
      `OpenUI's chat rules changed: "${MADE_UP_DATA}" is gone. Check which rule to leave out now.`,
    );
  }
  return {
    ...openuiChatPromptOptions,
    preamble: PREAMBLE,
    additionalRules: [...rules, ...RULES],
    examples: [...(openuiChatPromptOptions.examples ?? []), EXAMPLE],
  };
}

/** What Rufi AI is told about OpenUI Lang, from the library itself. */
export const replyPrompt = (): string =>
  `${replyLibrary().prompt(replyPromptOptions())}\n`;
