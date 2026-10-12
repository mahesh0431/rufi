// Rufi's tools: plain functions with an Effect Schema, free of any agent's
// types, so Codex now and an MCP host later are thin adapters over the same list.
import { Result, Schema, SchemaIssue } from "effect";
import { errorCode, type Log } from "../../platform/logs.ts";
import type { BriefInput, Made } from "../briefs/briefs.ts";
import type { Pages } from "../documents/pages.ts";
import type { DismissInput, Dismissed } from "../record/items.ts";
import type { SaveRequest, Saved } from "../record/save.ts";
import type { Store } from "../store/database.ts";
import type { ReadRequest, TrackRequest } from "../work/open-work.ts";

/** What a tool gets from Rufi, never from the model. */
export interface ToolContext {
  /** The record, or undefined when Rufi has none yet. */
  store: Store | undefined;
  /** The active person; chosen by Rufi (CLI flag, or the chat's). */
  personId: string | undefined;
  /** The chat the AI is in, when it is in one; chosen by Rufi. */
  chatId?: string | undefined;
  /** The agent's id for this call, when it gave one. */
  callId?: string | undefined;
  /** The person's document pages as the AI sees them. */
  pages?: Pages | undefined;
  /**
   * Saves changes to the record with their receipt: only in Rufi's own
   * chat, where the chat and the user's messages are Rufi's.
   */
  save?: ((input: SaveRequest, callId: string) => Promise<Saved>) | undefined;
  /** Dismisses draft items with a receipt line: only in Rufi's own chat. */
  dismiss?:
    | ((input: DismissInput, callId: string) => Promise<Dismissed>)
    | undefined;
  /**
   * Reads a document's failed pages again, at the person's request: only
   * in Rufi's own chat, in a turn the person started.
   */
  retryReading?: ((documentId: string) => Promise<number[]>) | undefined;
  /** Makes a visit brief with its line: only in Rufi's own chat. */
  brief?: ((input: BriefInput, callId: string) => Promise<Made>) | undefined;
  /**
   * The person's open work, read and changed in this reply: only in Rufi's
   * own chat, which gives the reply and the call.
   */
  work?:
    | {
        read: (input: ReadRequest) => Promise<unknown>;
        track: (input: TrackRequest, callId: string) => Promise<unknown>;
      }
    | undefined;
}

/** A tool's input: decoded without services, like JSON. */
type Input = Schema.Codec<unknown, unknown>;

export interface Tool<In extends Input = Input> {
  name: string;
  /** Written for the model; every limit the tool enforces is stated here. */
  description: string;
  /**
   * What a person sees when the AI uses it, in plain words; from what the
   * AI sent when the words depend on it ("Read your results in 2026").
   */
  shown: string | ((input: unknown) => string);
  input: In;
  /** Who may call it; maps to MCP Apps' `visibility` later. */
  callers: "model" | "ui" | "both";
  readOnly: boolean;
  destructive: boolean;
  /** Valid inputs, shown in tools.json and to the model after a mistake. */
  examples: readonly In["Encoded"][];
  run: (input: In["Type"], context: ToolContext) => unknown;
}

/**
 * A tool's answer that isn't a result, in words the model can act on, with
 * each problem in its input.
 */
export class Refusal extends Error {
  readonly issues: Issue[];
  constructor(message: string, issues: Issue[] = []) {
    super(message);
    this.issues = issues;
  }
}

/** A tool's words for one call, from what the AI sent. */
export const shownFor = (tool: Tool, input: unknown) =>
  typeof tool.shown === "string" ? tool.shown : tool.shown(input);

/** Kept generic per tool, then stored in one list. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one list of differently typed tools
export const defineTool = <In extends Input>(tool: Tool<In>): Tool =>
  tool as unknown as Tool;

/** The input of a tool that takes none: an object with no keys. */
export const NoInput = Schema.Record(
  Schema.String,
  Schema.Never.annotate({ message: "This tool takes no input; leave it out" }),
);

export interface Issue {
  path: string;
  got: string;
  fix: string;
}

/** A tool's result with an image for the model beside it (a document page). */
export class WithImage {
  readonly result: unknown;
  readonly image: { mediaType: string; bytes: Uint8Array };
  constructor(result: unknown, image: WithImage["image"]) {
    this.result = result;
    this.image = image;
  }
}

/** One answer for the agent; `stopTurn` says Rufi should end the turn. */
export interface ToolAnswer {
  ok: boolean;
  /** JSON, for the model. */
  text: string;
  /** Images the model sees after the text, as data: URLs. Never stored. */
  images?: readonly string[];
  stopTurn?: string;
}

/** Rejections a turn may have before Rufi stops it, so the model can't loop. */
export const REJECTIONS_PER_TURN = 3;

/**
 * A caller for one turn. Bad input, an unknown tool and a refusal each come
 * back as the error envelope and use up one of the turn's `rejections`.
 */
export function toolCaller(
  tools: readonly Tool[],
  context: () => ToolContext,
  log: Log,
  rejections = REJECTIONS_PER_TURN,
): (name: string, input: unknown, callId?: string) => Promise<ToolAnswer> {
  let left = rejections;
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
  return async (name, input, callId) => {
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
      const result: unknown = await tool.run(parsed.success, {
        ...context(),
        callId,
      });
      if (result instanceof WithImage) {
        const { mediaType, bytes } = result.image;
        return {
          ok: true,
          text: JSON.stringify({ ok: true, result: result.result }),
          images: [
            `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
          ],
        };
      }
      return { ok: true, text: JSON.stringify({ ok: true, result }) };
    } catch (error) {
      if (error instanceof Refusal) return reject(error.message, error.issues);
      // The model only learns it failed; the log gets the tool and the error's code.
      log("tool.failed", { tool: name, error: errorCode(error) });
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
  return jsonSchemaOf(tool.input);
}

/** The JSON Schema of an input, with its definitions in `$defs`. */
export function jsonSchemaOf(input: Input): Record<string, unknown> {
  const { schema, definitions } = Schema.toJsonSchemaDocument(input, {
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
