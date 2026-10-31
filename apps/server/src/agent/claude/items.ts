// What Claude does in a turn, for the provider boundary's events: each
// content block as Claude reported it, by Claude's own ids, with images left
// out; and its usage, as Claude counted it. Nothing is reworded or cut: a
// screen shows the line, and opens to all Claude gave about it.
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderEvent,
  StepKind,
  UsageWindow,
} from "@rufi/agents/provider";

/**
 * A content block, read loosely: its types come from the Anthropic SDK,
 * which Rufi doesn't install (pnpm-workspace.yaml).
 */
export interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** A message's content blocks; none when its content is plain text. */
export const blocksOf = (message: unknown): Block[] => {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
};

type Step = Extract<ProviderEvent, { type: "step" }>;

/** The argument a tool's line shows, by Claude's tool. */
const SHOWN: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Glob: "pattern",
  Grep: "pattern",
  WebSearch: "query",
  WebFetch: "url",
  Skill: "skill",
};

const KINDS: Record<string, StepKind> = {
  Bash: "command",
  Write: "file_change",
  Edit: "file_change",
  WebSearch: "web_search",
  WebFetch: "web_search",
};

/**
 * A tool call's line: a command is its command; Rufi's tools are
 * `server.tool` with their arguments; any other is the tool's name with
 * what it was given.
 */
export function lineOf(use: Block): Pick<Step, "kind" | "title" | "detail"> {
  const name = use.name ?? "tool";
  const input = use.input ?? {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    return {
      kind: "tool",
      title: `${mcp[1] ?? ""}.${mcp[2] ?? ""}`,
      ...detailOf(argumentsOf(input)),
    };
  }
  const command = input["command"];
  if (name === "Bash" && typeof command === "string") {
    return { kind: "command", title: command };
  }
  const shown = input[SHOWN[name] ?? ""];
  return {
    kind: KINDS[name] ?? "other",
    title: name,
    ...detailOf(typeof shown === "string" ? shown : argumentsOf(input)),
  };
}

const detailOf = (detail: string | undefined) =>
  detail === undefined ? {} : { detail };

/** A tool call's arguments as text; none when it took none. */
const argumentsOf = (input: Record<string, unknown>) => {
  const text = JSON.stringify(input);
  return text === "{}" ? undefined : text;
};

/**
 * `value` with every image's and document's bytes left out, also those of
 * a document's own pictures: what they were stays, and how big they were
 * doesn't matter to a line.
 */
export function withoutImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutImages);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).map(([key, inner]) => {
    if (key === "source" && inner !== null && typeof inner === "object") {
      const { data: _bytes, ...rest } = inner as Record<string, unknown>;
      return [key, withoutImages(rest)];
    }
    return [key, withoutImages(inner)];
  });
  return Object.fromEntries(entries);
}

/** A request's or a turn's token counts, as Claude reports them. */
export interface Counts {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** The input tokens the model read: all of them, cached or not. */
const inputOf = (counts: Counts) =>
  (counts.input_tokens ?? 0) +
  (counts.cache_read_input_tokens ?? 0) +
  (counts.cache_creation_input_tokens ?? 0);

/** How much of the context a request used: what it read and wrote. */
export const contextOf = (counts: Counts) =>
  inputOf(counts) + (counts.output_tokens ?? 0);

/** A turn's usage, from its result's `usage`, which is the turn's own. */
export function turnUsageOf(
  turn: string,
  usage: Counts,
): Extract<ProviderEvent, { type: "turnUsage" }> {
  return {
    type: "turnUsage",
    turn,
    input: inputOf(usage),
    cached: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    payload: usage,
  };
}

/** How long each of Claude's limit windows is. */
const MINUTES: Record<string, number> = {
  five_hour: 300,
  seven_day: 10_080,
  seven_day_opus: 10_080,
  seven_day_sonnet: 10_080,
};

interface Window {
  utilization?: number;
  resetsAt?: number;
}

/**
 * Usage now, from Claude's latest rate-limit event: each window it names,
 * how much is used and when it resets. Its `unifiedWindows`, which the
 * SDK's type leaves out, holds every window; else the event's own one.
 */
export function windowsOf(info: SDKRateLimitInfo): UsageWindow[] {
  const unified = (info as { unifiedWindows?: Record<string, Window> })
    .unifiedWindows;
  const windows: [string, Window][] = unified
    ? Object.entries(unified)
    : info.rateLimitType === undefined
      ? []
      : [[info.rateLimitType, info]];
  return windows.flatMap(([type, { utilization, resetsAt }]) => {
    if (typeof utilization !== "number") return [];
    const minutes = MINUTES[type];
    return [
      {
        ...(minutes !== undefined && { minutes }),
        usedPercent: Math.round(utilization * 10_000) / 100,
        ...(typeof resetsAt === "number" && {
          resetsAt: new Date(resetsAt * 1000).toISOString(),
        }),
      },
    ];
  });
}
