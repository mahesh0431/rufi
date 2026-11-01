// Rufi AI's replies are OpenUI Lang (https://github.com/thesysdev/openui),
// drawn by OpenUI's renderer with OpenUI's chat library. Its parts are
// OpenUI's own; some are drawn by Rufi with the same props, as the docs'
// `library.extend` allows: TextContent, MarkDownRenderer, Callout, Steps and
// Card, so every link opens by Rufi's rule (parts.tsx), and Image, for the
// AI's picture files.
// Without JSX, so `pnpm openui:md` can load it in Node and write the prompt
// Rufi AI is told (apps/server/src/core/chat/openui.md); the screens give
// the renderers (reply.tsx).
//
// Replies keep their text as the AI wrote it, and props are positional: a
// part Rufi draws keeps OpenUI's name and props, and an old reply that no
// longer fits the library shows as its text.
import "@rufi/contracts/jitless";
import {
  createParser,
  type ComponentRenderer,
  type ElementNode,
  type PromptOptions,
} from "@openuidev/react-lang";
import {
  openuiChatAdditionalRules,
  openuiChatLibrary,
  openuiChatPromptOptions,
} from "@openuidev/react-ui/genui-lib";

/** What the screens draw Rufi's parts with; Node gives none. */
export interface Renderers {
  TextContent: ComponentRenderer;
  MarkDownRenderer: ComponentRenderer;
  Image: ComponentRenderer;
  Card: ComponentRenderer;
  Callout: ComponentRenderer;
  Steps: ComponentRenderer;
}

const nothing = () => null;
const NONE: Renderers = {
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

/** Rufi's reply library: OpenUI's chat library, some parts drawn by Rufi. */
export function replyLibrary(draw: Renderers = NONE) {
  return openuiChatLibrary.extend({
    components: {
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
 * it has no OpenUI at all; otherwise `partial`: OpenUI draws what works and
 * drops the smallest broken piece, so the reply says part of it isn't shown
 * and keeps its whole text a click away. The schema check catches what
 * OpenUI's parser lets through, such as another part where a value goes.
 */
export function shapeOf(
  reader: ReturnType<typeof replyReader>,
  text: string,
): "drawn" | "words" | "partial" {
  const { root, meta } = reader.parser.parse(text);
  if (root === null) return "words";
  const whole =
    !meta.incomplete &&
    meta.unresolved.length === 0 &&
    meta.orphaned.length === 0 &&
    meta.errors.every((error) => error.severity === "warning");
  return whole && fits(root, { $ref: "#/$defs/Card" }, reader.defs)
    ? "drawn"
    : "partial";
}

/** OpenUI's chat rule Rufi leaves out: Rufi never makes up health data. */
const MADE_UP_DATA = "When asked about data, generate realistic/plausible data";

const PREAMBLE = `# How your answer is shown

Rufi's chat draws your answer with OpenUI. Write your whole final answer in openui-lang, the declarative UI language below, and nothing else: no Markdown around it and no code fence. Rufi draws it as it is written. Notes you write while you work, before your answer, are a sentence or two of plain text.`;

const RULES = [
  "Every value, date and range you show comes from the user's health record, a document in this chat or a source you cite, as it is kept there. Never invent, round off or fill in a value, not even as an example. A value a chart can't take as a number, such as \"<5\", stays as printed in the text or a table.",
  "A chart of health values is a picture of them, and its labels and hover round numbers: show the values it draws as kept too, in a Table or the text, with their units and as printed.",
  "Links go in TextContent as Markdown links, [words](address): a web page by its https address, and a page of Rufi by its rufi:/ address as your instructions say. A Card's sources and @OpenUrl take the same addresses.",
  "A picture you made is a file in your folder: show it with Image(alt, path).",
  "Buttons and follow-ups send their words to you as the user's message, and a form sends its values. Offer only what you can do for the user in Rufi.",
  "Build a reply from OpenUI's parts, as its examples do: a section under an InlineHeader, with a Separator between sections; a list of points as a ListBlock, each ListItem a short title with its detail as the subtitle; a sequence as Steps. Markdown in TextContent is for running text.",
  "Colours carry meaning: never colour a health value good or bad by your own judgement; for a result, show the lab's own flag as printed.",
];

const EXAMPLE = `Example — One test over time, from the user's record (fictional values):

root = Card([header, intro, chart, values, followUps])
header = CardHeader("Haemoglobin", "Your last three results")
intro = TextContent("Your haemoglobin went up this year and reached the lab's range (12.0-15.5 g/dL) in August. The values are from [your Sunrise Labs report](rufi:/documents/doc-1).")
chart = LineChart(["10 Feb 2026", "20 May 2026", "12 Aug 2026"], [Series("Haemoglobin (g/dL)", [11.2, 11.9, 12.6])])
values = Table([Col("Date", ["10 Feb 2026", "20 May 2026", "12 Aug 2026"]), Col("Haemoglobin", ["11.2 g/dL", "11.9 g/dL", "12.6 g/dL"]), Col("Lab range", ["12.0-15.5", "12.0-15.5", "12.0-15.5"]), Col("Flag", ["L", "L", ""])])
followUps = Buttons([Button("What can raise my haemoglobin?", @ToAssistant("What can raise my haemoglobin?"), "secondary"), Button("Show my ferritin too", @ToAssistant("Show my ferritin too"), "secondary")], "row")`;

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
