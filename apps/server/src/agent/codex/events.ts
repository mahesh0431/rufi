// Codex's items and turn endings for Rufi: one activity line per thing the
// agent did, with what the agent reported about it, and why a reply ended.
// Nothing is reworded or cut: a screen shows the line, and opens to all the
// agent gave about it.
import type { ActivityKind, AgentEvent, TurnEnd } from "../runtime.ts";
import type { CodexErrorInfo } from "./protocol/v2/CodexErrorInfo.ts";
import type { RateLimitSnapshot } from "./protocol/v2/RateLimitSnapshot.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { Turn } from "./protocol/v2/Turn.ts";
import type { TurnError } from "./protocol/v2/TurnError.ts";

type Activity = Pick<
  Extract<AgentEvent, { type: "activity" }>,
  "activity" | "title" | "detail" | "status"
>;

/** A line with the item's own text, else its type: Codex's own word for it. */
const line = (
  item: { type: string },
  activity: ActivityKind,
  text: string | null | undefined,
  detail: string | null | undefined,
  status: Activity["status"],
): Activity => ({
  activity,
  title: text || item.type,
  ...(detail && { detail }),
  status,
});

/** A tool call's arguments as its detail; none when it took none. */
const argumentsOf = (args: unknown) => {
  const text = JSON.stringify(args);
  return text === "{}" || text === "null" ? undefined : text;
};

/** Codex's status words in Rufi's three. */
function statusOf(status: string | undefined, ended: boolean) {
  if (status === "failed" || status === "declined") return "failed";
  if (status === "completed" || ended) return "done";
  return "running";
}

/**
 * The activity line for an item, as it starts (`ended` false) or ends;
 * undefined for what isn't one: messages and reasoning. Its title is what
 * the agent reported (the command, `server.tool`, the paths, the query),
 * and its detail the next part (the arguments, the exit code, the page).
 */
export function activityOf(
  item: ThreadItem,
  ended: boolean,
): Activity | undefined {
  switch (item.type) {
    case "userMessage":
    case "agentMessage":
    case "reasoning":
      return undefined;
    case "mcpToolCall":
      return line(
        item,
        "tool",
        `${item.server}.${item.tool}`,
        argumentsOf(item.arguments),
        item.error ? "failed" : statusOf(item.status, ended),
      );
    case "dynamicToolCall":
      return line(
        item,
        "tool",
        item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        argumentsOf(item.arguments),
        item.success === false ? "failed" : statusOf(item.status, ended),
      );
    case "commandExecution":
      return line(
        item,
        "command",
        item.command,
        // Codex gives none while the command runs.
        typeof (item.exitCode as unknown) === "number"
          ? `exit ${String(item.exitCode)}`
          : undefined,
        statusOf(item.status, ended),
      );
    case "webSearch":
      // The words or the page may only be known once it has finished.
      return line(
        item,
        "web_search",
        item.query,
        item.action?.type === "openPage" || item.action?.type === "findInPage"
          ? item.action.url
          : undefined,
        statusOf(undefined, ended),
      );
    case "fileChange":
      return line(
        item,
        "file_change",
        item.changes.map((change) => change.path).join(", "),
        undefined,
        statusOf(item.status, ended),
      );
    case "collabAgentToolCall":
      return line(
        item,
        "sub_agent",
        item.tool,
        item.prompt,
        statusOf(item.status, ended),
      );
    case "subAgentActivity":
      return line(
        item,
        "sub_agent",
        item.agentPath,
        item.kind,
        statusOf(item.kind === "completed" ? "completed" : undefined, ended),
      );
    case "plan":
      return line(
        item,
        "other",
        item.text,
        undefined,
        statusOf(undefined, ended),
      );
    case "imageView":
      return line(
        item,
        "other",
        item.path,
        undefined,
        statusOf(undefined, ended),
      );
    case "contextCompaction":
      return line(
        item,
        "compaction",
        undefined,
        undefined,
        statusOf(undefined, ended),
      );
    case "imageGeneration": {
      // A picture Codex generated and saved shows in the reply, by its
      // path, whole.
      const failed =
        item.failure !== null || statusOf(item.status, ended) === "failed";
      const prompt = item.revisedPrompt;
      if (failed) return line(item, "picture", prompt, undefined, "failed");
      if (!ended) return line(item, "picture", prompt, undefined, "running");
      return line(item, "picture", prompt, item.savedPath, "done");
    }
    case "hookPrompt":
    case "functionCallOutput":
    case "sleep":
    case "enteredReviewMode":
    case "exitedReviewMode":
      break;
  }
  // Any other, also a type newer than the generated protocol: its type.
  return line(item, "other", undefined, undefined, statusOf(undefined, ended));
}

/** The message's own text: the last text part (earlier ones are Rufi's context). */
export function messageText(
  content: readonly { type: string; text?: string }[],
): string {
  const texts = content.filter((part) => part.type === "text");
  return texts.at(-1)?.text ?? "";
}

/**
 * How a turn ended. Only `completed` counts as success. `limits` is the
 * latest usage snapshot Codex sent, for a usage limit's reset time.
 */
export function endOf(
  turn: Pick<Turn, "status" | "error">,
  limits?: RateLimitSnapshot,
): TurnEnd {
  switch (turn.status) {
    case "completed":
      return { status: "completed" };
    case "interrupted":
      return { status: "interrupted", reason: "stopped", text: "Stopped." };
    case "failed":
      return failure(turn.error, limits);
    case "inProgress":
      return {
        status: "failed",
        reason: "provider_failed",
        text: "Codex ended the turn unfinished.",
      };
  }
}

/**
 * A failed turn: the service's own words, as Codex gave them (none when it
 * gave none: the screen says the reply didn't finish); and Rufi's reason,
 * for what it does next (wait for the sign-in or the limit, retry).
 */
function failure(
  error: TurnError | null,
  limits: RateLimitSnapshot | undefined,
): TurnEnd {
  const reason = reasonOf(error?.codexErrorInfo ?? null);
  const resetsAt = reason === "usage_limit" ? resetOf(limits) : undefined;
  return {
    status: "failed",
    reason,
    ...(error?.message && { text: error.message }),
    ...(resetsAt && { resetsAt }),
  };
}

function reasonOf(info: CodexErrorInfo | null): TurnEnd["reason"] {
  if (info === "unauthorized") return "sign_in";
  if (info === "usageLimitExceeded") return "usage_limit";
  if (info === "rateLimitExceeded") return "rate_limit";
  // A connection that failed, with the HTTP status when there was one. A
  // 401 comes after Codex renewed its sign-in and was refused again: the
  // sign-in isn't accepted.
  if (typeof info === "object" && info !== null) {
    if ("activeTurnNotSteerable" in info) return "provider_failed";
    const status = Object.values(info).map(
      (value) => (value as { httpStatusCode?: unknown } | null)?.httpStatusCode,
    );
    return status.includes(401) ? "sign_in" : "connection";
  }
  return "provider_failed";
}

/** The reset time of a window that is used up, as ISO 8601. */
function resetOf(limits: RateLimitSnapshot | undefined): string | undefined {
  for (const window of [limits?.primary, limits?.secondary]) {
    if (window && window.usedPercent >= 100 && window.resetsAt !== null) {
      return new Date(window.resetsAt * 1000).toISOString();
    }
  }
  return undefined;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * What Codex says about a call to Rufi's tools in its `_meta` (0.159.3): its
 * id, its thread, and its turn in the turn metadata.
 */
export function callOf(meta: unknown): {
  callId: string | undefined;
  threadId: string | undefined;
  turnId: string | undefined;
} {
  const fields = record(meta);
  return {
    callId: text(fields["callId"]),
    threadId: text(fields["threadId"]),
    turnId: text(record(fields["x-codex-turn-metadata"])["turn_id"]),
  };
}
