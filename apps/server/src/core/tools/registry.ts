// Rufi's tools: plain functions with an Effect Schema, free of any agent's
// types, so Codex now and an MCP host later are thin adapters over the same list.
import { Result, Schema, SchemaIssue } from "effect";
import type { Store } from "../store/database.ts";

/** What a tool gets from Rufi, never from the model. */
export interface ToolContext {
  /** The record, or undefined when Rufi has none yet. */
  store: Store | undefined;
  /** The active person; chosen by Rufi (CLI flag, later the conversation). */
  personId: string | undefined;
}

/** A tool's input: decoded without services, like JSON. */
type Input = Schema.Codec<unknown, unknown>;

export interface Tool<In extends Input = Input> {
  name: string;
  /** Written for the model; every limit the tool enforces is stated here. */
  description: string;
  input: In;
  /** Who may call it; maps to MCP Apps' `visibility` later. */
  callers: "model" | "ui" | "both";
  readOnly: boolean;
  destructive: boolean;
  /** Valid inputs, shown in tools.json and to the model after a mistake. */
  examples: readonly In["Encoded"][];
  run: (input: In["Type"], context: ToolContext) => unknown;
}

/** A tool's answer that isn't a result, in words the model can act on. */
export class Refusal extends Error {}

/** Kept generic per tool, then stored in one list. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one list of differently typed tools
export const defineTool = <In extends Input>(tool: Tool<In>): Tool =>
  tool as unknown as Tool;

/** The input of a tool that takes none: an object with no keys. */
export const NoInput = Schema.Record(
  Schema.String,
  Schema.Never.annotate({ message: "This tool takes no input; leave it out" }),
);

interface Issue {
  path: string;
  got: string;
  fix: string;
}

/** One answer for the agent; `stopTurn` says Rufi should end the turn. */
export interface ToolAnswer {
  ok: boolean;
  /** JSON, for the model. */
  text: string;
  stopTurn?: string;
}

/** Rejections a turn may have before Rufi stops it, so the model can't loop. */
export const REJECTIONS_PER_TURN = 3;

/**
 * A caller for one turn. Bad input, an unknown tool and a refusal each come
 * back as the error envelope and use up one of the turn's rejections.
 */
export function toolCaller(
  tools: readonly Tool[],
  context: () => ToolContext,
  log: (line: string) => void,
): (name: string, input: unknown) => Promise<ToolAnswer> {
  let left = REJECTIONS_PER_TURN;
  const reject = (
    error: string,
    issues: Issue[] = [],
    example?: unknown,
  ): ToolAnswer => {
    left = Math.max(0, left - 1);
    return {
      ok: false,
      text: JSON.stringify({
        ok: false,
        error,
        issues,
        example,
        rejections_left: left,
      }),
      ...(left === 0 && {
        stopTurn: "The AI kept making requests Rufi couldn't accept.",
      }),
    };
  };
  return async (name, input) => {
    const tool = tools.find(
      (candidate) => candidate.name === name && candidate.callers !== "ui",
    );
    if (!tool) {
      const names = tools.filter((t) => t.callers !== "ui").map((t) => t.name);
      return reject(
        `There is no tool called ${name}. Rufi's tools: ${names.join(", ")}.`,
      );
    }
    const parsed = Schema.decodeUnknownResult(tool.input, STRICT)(input);
    if (Result.isFailure(parsed)) {
      return reject(
        `The input for ${name} isn't valid.`,
        issuesOf(parsed.failure.issue, input),
        tool.examples[0],
      );
    }
    try {
      const result: unknown = await tool.run(parsed.success, context());
      return { ok: true, text: JSON.stringify({ ok: true, result }) };
    } catch (error) {
      if (error instanceof Refusal) return reject(error.message);
      // The detail is for Rufi's log; the model only learns it failed.
      log(`tool ${name} failed: ${(error as Error).stack ?? String(error)}`);
      return {
        ok: false,
        text: JSON.stringify({
          ok: false,
          error: `Rufi couldn't run ${name}.`,
        }),
      };
    }
  };
}

/** Unknown keys are mistakes, and every mistake is reported at once. */
const STRICT = { onExcessProperty: "error", errors: "all" } as const;

const standardIssues = SchemaIssue.makeFormatterStandardSchemaV1();

function issuesOf(issue: SchemaIssue.Issue, input: unknown): Issue[] {
  return standardIssues(issue).issues.map(({ path = [], message }) => {
    const keys = path.map((key) => (typeof key === "object" ? key.key : key));
    return {
      path: keys.map(String).join("."),
      got: describeInput(valueAt(input, keys)),
      fix: message,
    };
  });
}

function valueAt(input: unknown, keys: readonly PropertyKey[]): unknown {
  let value = input;
  for (const key of keys) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

function describeInput(input: unknown): string {
  if (input === undefined) return "nothing";
  const text = JSON.stringify(input);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** The JSON Schema of a tool's input, as tools.json and the agent get it. */
export function inputSchema(tool: Tool): Record<string, unknown> {
  const { schema, definitions } = Schema.toJsonSchemaDocument(tool.input, {
    onExcessProperty: "error",
  });
  // `properties` comes first and is always there: the shape Codex already
  // takes for a tool without input.
  const json: Record<string, unknown> =
    schema["type"] === "object"
      ? { type: "object", properties: {}, ...schema }
      : { ...schema };
  if (Object.keys(definitions).length > 0) json["$defs"] = definitions;
  return json;
}
