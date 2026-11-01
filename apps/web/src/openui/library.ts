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
// longer fits the library draws what works and says part isn't shown.
import "@rufi/contracts/jitless";
import { split, tokenize } from "@openuidev/lang-core";
import { REPLY_MARKS } from "@rufi/contracts/instructions";
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

/** The kinds of OpenUI's expressions (lang-core's `ASTNode`). */
const EXPRESSIONS = new Set([
  "Comp",
  "Str",
  "Num",
  "Bool",
  "Null",
  "Arr",
  "Obj",
  "Ref",
  "Ph",
  "StateRef",
  "RuntimeRef",
  "BinOp",
  "UnaryOp",
  "Ternary",
  "Member",
  "Index",
  "Assign",
]);

/** An expression OpenUI keeps in the tree to read later, such as an action. */
const isExpression = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  "k" in value &&
  typeof value.k === "string" &&
  EXPRESSIONS.has(value.k);

/**
 * Whether a value fits its place in the library's schema: a part only where
 * that part may go (anywhere in a free place), each part's props by its own
 * schema wherever it sits, plain values by their type, nothing coerced. An
 * expression (a variable, an action) is OpenUI's to read, and null is a prop
 * left out. A free place draws a value, a part or a list of them: OpenUI
 * draws nothing for an object there, such as `{value: "18 ng/mL"}` in a
 * table cell.
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
  if (isExpression(value)) return true;
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
  if (typeof value === "object" && isFree(schema)) return false;
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

/** OpenUI's token types (lang-core's `T`) that `allRead` passes over. */
const NEWLINE = 0;
const END = 13;

/**
 * Whether each piece of a reply's text is in a statement, as OpenUI's own
 * tokenizer and splitter read it: words outside its statements OpenUI
 * passes over without a word.
 */
function allRead(text: string): boolean {
  const tokens = tokenize(text);
  const read = split(tokens).reduce(
    (count, statement) => count + 2 + statement.tokens.length,
    0,
  );
  const found = tokens.filter((token) => {
    const type: number = token.t;
    return type !== NEWLINE && type !== END;
  }).length;
  return read === found;
}

/**
 * A finished reply: `drawn` when OpenUI's parse reports no problem (nothing
 * cut off, every name used is defined and every name defined is used, no
 * errors), no text is outside its statements (allRead) and its tree fits
 * the library's schema, from its Card down; `words` when it has no OpenUI
 * at all; otherwise `partial`: OpenUI draws what works and leaves out what
 * it can't, so the reply says part of it isn't shown and keeps its whole
 * text a click away. The screens also mark it partial when drawing it fails
 * (reply.tsx). Rufi doesn't account for every character: other text OpenUI
 * passes over is OpenUI's to handle.
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
    meta.errors.length === 0;
  return whole &&
    allRead(text) &&
    fits(root, { $ref: "#/$defs/Card" }, reader.defs)
    ? "drawn"
    : "partial";
}

/** OpenUI's chat rule Rufi leaves out: Rufi never makes up health data. */
const MADE_UP_DATA = "When asked about data, generate realistic/plausible data";

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
    // Rufi's own reply instructions go where these marks are: the core puts
    // them in (core/chat/replies.ts), Rufi's text or the user's edit.
    preamble: REPLY_MARKS.preamble,
    additionalRules: [...rules, REPLY_MARKS.rules],
    examples: [
      ...(openuiChatPromptOptions.examples ?? []),
      REPLY_MARKS.example,
    ],
  };
}

/** What Rufi AI is told about OpenUI Lang, from the library itself. */
export const replyPrompt = (): string =>
  `${replyLibrary().prompt(replyPromptOptions())}\n`;
