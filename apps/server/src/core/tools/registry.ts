// Rufi's tools: plain functions with a Zod schema, free of any agent's types,
// so Codex now and an MCP host later are thin adapters over the same list.
import { z } from "zod";
import type { Store } from "../store/database.ts";

/** What a tool gets from Rufi, never from the model. */
export interface ToolContext {
  /** The record, or undefined when Rufi has none yet. */
  store: Store | undefined;
  /** The active person; chosen by Rufi (CLI flag, later the conversation). */
  personId: string | undefined;
}

export interface Tool<Input extends z.ZodType = z.ZodType> {
  name: string;
  /** Written for the model; every limit the tool enforces is stated here. */
  description: string;
  input: Input;
  /** Who may call it; maps to MCP Apps' `visibility` later. */
  callers: "model" | "ui" | "both";
  readOnly: boolean;
  destructive: boolean;
  /** Valid inputs, shown in tools.json and to the model after a mistake. */
  examples: readonly z.input<Input>[];
  run: (input: z.output<Input>, context: ToolContext) => unknown;
}

/** A tool's answer that isn't a result, in words the model can act on. */
export class Refusal extends Error {}

/** Kept generic per tool, then stored in one list. */
export const defineTool = <Input extends z.ZodType>(tool: Tool<Input>): Tool =>
  tool;

interface Issue {
  path: string;
  expected: string;
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
    const parsed = tool.input.safeParse(input, { reportInput: true });
    if (!parsed.success) {
      return reject(
        `The input for ${name} isn't valid.`,
        parsed.error.issues.map(toIssue),
        tool.examples[0],
      );
    }
    try {
      const result: unknown = await tool.run(parsed.data, context());
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

function toIssue(issue: z.core.$ZodIssue): Issue {
  const expected =
    "expected" in issue && typeof issue.expected === "string"
      ? issue.expected
      : issue.code;
  return {
    path: issue.path.map(String).join("."),
    expected,
    got: describeInput(issue.input),
    fix: issue.message,
  };
}

function describeInput(input: unknown): string {
  if (input === undefined) return "nothing";
  const text = JSON.stringify(input);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** The JSON Schema of a tool's input, as tools.json and the agent get it. */
export function inputSchema(tool: Tool): Record<string, unknown> {
  const schema: Record<string, unknown> = z.toJSONSchema(tool.input, {
    io: "input",
  });
  delete schema["$schema"]; // the dialect; agents don't need it
  return schema;
}
