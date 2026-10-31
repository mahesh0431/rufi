// Rufi's tools: plain functions with an Effect Schema, free of any agent's
// types, so the MCP server (server/mcp.ts) is a thin adapter over the list.
import { Result, Schema, SchemaIssue } from "effect";
import { errorCode, type Log } from "../../platform/logs.ts";
import type { BriefInput, Made } from "../briefs/briefs.ts";
import type { Pages } from "../documents/pages.ts";
import type { SetReaderInput } from "../documents/readers.ts";
import type {
  SaveReadingAnswer,
  SaveReadingInput,
} from "../documents/save-reading.ts";
import type { SortAnswer, SortInput } from "../documents/sorting.ts";
import type { DismissInput, Dismissed } from "../record/items.ts";
import type { SaveRequest, Saved } from "../record/save.ts";
import type { Store } from "../store/database.ts";
import type {
  AgentStatusInput,
  ReadAgentInput,
  SendAgentInput,
  SetAgentModelInput,
  StartAgentInput,
  StopAgentInput,
  WaitingMessagesInput,
} from "./agents.ts";

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
  /**
   * Sorts an add into documents and writes its drafts (sort_documents):
   * only in Rufi's own chat; in a Rufi-started turn only its request's
   * pages.
   */
  sort?:
    | ((input: SortInput, callId: string) => Promise<SortAnswer>)
    | undefined;
  /** Makes a visit brief with its line: only in Rufi's own chat. */
  brief?: ((input: BriefInput, callId: string) => Promise<Made>) | undefined;
  /** Saves a whole reading (save_reading): only in Rufi's own chat. */
  saveReading?:
    | ((input: SaveReadingInput, callId: string) => Promise<SaveReadingAnswer>)
    | undefined;
  /** Sets the agent that reads documents (set_reader): only in Rufi's own chat. */
  setReader?:
    | ((input: SetReaderInput, callId: string) => Promise<unknown>)
    | undefined;
  /** What the calling agent does with agents: only in Rufi's own chat. */
  agents?: AgentTools | undefined;
}

/** The calling agent's agents (core/tools/agents.ts). */
export interface AgentTools {
  /** A child of the caller, started by this call: its id is the call's. */
  start: (input: StartAgentInput, callId: string) => Promise<unknown>;
  /** The agents below the caller, as they are now. */
  status: (input: AgentStatusInput) => unknown;
  /** A message from the caller to an agent below it, or to its parent. */
  send: (input: SendAgentInput, callId: string) => unknown;
  /** A page of the conversation of an agent in the caller's chat. */
  read: (input: ReadAgentInput) => Promise<unknown>;
  /** Stops an agent below the caller, or itself; with children, all below it too. */
  stop: (input: StopAgentInput) => unknown;
  /** Whether an agent is in the caller's chat. */
  inChat: (agent: string) => boolean;
  /** Whether an agent is at work: not yet run, running or going on. */
  runs: (agent: string) => boolean;
  /** What waits for the caller and the agents below it: listed or changed. */
  waiting: (input: WaitingMessagesInput) => Promise<unknown>;
  /** An idle agent below the caller, on another model from its next turn. */
  setModel: (input: SetAgentModelInput) => Promise<unknown>;
  /** Each provider's usage now and when its limits reset, as it reported them. */
  usage: () => Promise<unknown>;
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

/** One answer for the agent. */
export interface ToolAnswer {
  ok: boolean;
  /** JSON, for the model. */
  text: string;
  /** Images the model sees after the text, in base64. Never stored. */
  images?: readonly { mimeType: string; data: string }[];
  /** Kept already, with what the call changed: the chat keeps it no more. */
  kept?: true;
  /** What the chat keeps of the call, when not the call as it came. */
  keep?: { input: unknown; answer: { ok: boolean; text: string } };
}

/** A tool as an agent is told about it. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
}

export const specOf = (tool: Tool): ToolSpec => ({
  name: tool.name,
  description: tool.description,
  inputSchema: inputSchema(tool),
  readOnly: tool.readOnly,
  destructive: tool.destructive,
});

/** A tool's result as the answer the AI gets. */
export const answerOf = (result: unknown): ToolAnswer => ({
  ok: true,
  text: JSON.stringify({ ok: true, result }),
});

/**
 * The caller of some tools. Bad input, an unknown tool and a refusal each
 * come back as the error envelope; what the AI does next is its call.
 */
export function toolCaller(
  tools: readonly Tool[],
  context: () => ToolContext,
  log: Log,
): (
  name: string,
  input: unknown,
  callId?: string,
  /** What this call alone runs with, over the turn's context. */
  own?: Partial<ToolContext>,
) => Promise<ToolAnswer> {
  const reject = (
    error: string,
    issues: Issue[] = [],
    example?: unknown,
  ): ToolAnswer => ({
    ok: false,
    text: JSON.stringify({ ok: false, error, issues, example }),
  });
  return async (name, input, callId, own) => {
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
        ...own,
        callId,
      });
      if (result instanceof WithImage) {
        const { mediaType, bytes } = result.image;
        return {
          ok: true,
          text: JSON.stringify({ ok: true, result: result.result }),
          images: [
            {
              mimeType: mediaType,
              data: Buffer.from(bytes).toString("base64"),
            },
          ],
        };
      }
      return answerOf(result);
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
