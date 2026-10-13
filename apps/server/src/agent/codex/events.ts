// Codex's items and turn endings in Rufi's words: one activity line per thing
// the agent did, and why a reply ended. Skill reads verify the files before
// quieting a command; other items need no filesystem access.
import { realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type {
  ActivityKind,
  AgentEvent,
  AgentTools,
  TurnEnd,
} from "../runtime.ts";
import type { RateLimitSnapshot } from "./protocol/v2/RateLimitSnapshot.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { Turn } from "./protocol/v2/Turn.ts";
import type { TurnError } from "./protocol/v2/TurnError.ts";

/** An activity line's detail is one short line. */
const DETAIL_CHARS = 300;

type Activity = Pick<
  Extract<AgentEvent, { type: "activity" }>,
  "activity" | "title" | "detail" | "status"
>;

const line = (
  activity: ActivityKind,
  title: string,
  detail: string | undefined,
  status: Activity["status"],
): Activity => {
  const short = detail?.replace(/\s+/g, " ").trim();
  return {
    activity,
    title,
    ...(short && {
      detail:
        short.length > DETAIL_CHARS
          ? `${short.slice(0, DETAIL_CHARS - 1)}…`
          : short,
    }),
    status,
  };
};

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
 * Literal shell words only: quoting and escaping, without shell operations;
 * in a shell's script, also one `{a,b}` group of skill-folder names.
 */
const PART =
  /"((?:[^"\\$`]|\\["\\$`])*)"|'([^']*)'|\\([^\r\n])|\{([a-z0-9-]+(?:,[a-z0-9-]+)+)\}|([^\s"'\\$`;&|<>()*?[\]{}~#!]+)/y;

/** The words of a command, each group expanded in place; undefined for any other. */
function literalWords(script: string, braces = false): string[] | undefined {
  // Space around the words, a final newline too, is no part of them. A
  // newline between them is no literal word, so it ends the check.
  const command = script.trim();
  const words: string[] = [];
  // The word so far, as each of its expansions, and whether it has a group.
  let word: string[] | undefined;
  let grouped = false;
  for (let at = 0; at < command.length;) {
    if (/[ \t]/.test(command[at] ?? "")) {
      if (word !== undefined) words.push(...word);
      word = undefined;
      grouped = false;
      at++;
      continue;
    }
    PART.lastIndex = at;
    const part = PART.exec(command);
    if (!part) return undefined;
    const so = word ?? [""];
    if (part[4] !== undefined) {
      if (!braces || grouped) return undefined;
      grouped = true;
      const names = part[4].split(",");
      word = so.flatMap((start) => names.map((name) => start + name));
    } else {
      const text =
        part[1]?.replace(/\\(["\\$`])/g, "$1") ??
        part[2] ??
        part[3] ??
        part[5] ??
        "";
      word = so.map((start) => start + text);
    }
    at = PART.lastIndex;
  }
  if (word !== undefined) words.push(...word);
  return words;
}

/** `a`, `a and b`, `a, b and c`. */
const and = (words: readonly string[]) =>
  words.length < 2
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words.at(-1) ?? ""}`;

/**
 * The skills a command only reads, by name: exactly `cat` and regular skill
 * files under the canonical root (a shell's script may name several with
 * one `{a,b}` group in a path); undefined for any other command.
 */
function skillsRead(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
  root: string | undefined,
): string[] | undefined {
  if (root === undefined) return undefined;
  let words = literalWords(item.command);
  // Codex presents its argv as a shell-quoted command. Unwrap only its
  // ordinary shell invocation, then check the whole script again.
  if (
    words?.length === 3 &&
    /^\/bin\/(?:zsh|bash)$/.test(words[0] ?? "") &&
    (words[1] === "-lc" || words[1] === "-c")
  ) {
    words = literalWords(words[2] ?? "", true);
  }
  if (words?.[0] !== "cat" || words.length < 2) return undefined;
  const names: string[] = [];
  for (const path of words.slice(1)) {
    if (path.startsWith("-")) return undefined;
    try {
      const full = realpathSync(resolve(item.cwd, path));
      const name = /^([a-z0-9-]+)\/SKILL\.md$/.exec(relative(root, full))?.[1];
      if (name === undefined || !statSync(full).isFile()) return undefined;
      names.push(name);
    } catch {
      // An unverifiable file keeps the ordinary command and its details.
      return undefined;
    }
  }
  return [...new Set(names)];
}

/** Rufi's skills and their names on screen. */
export interface SkillFiles {
  /** Their canonical folder, once Rufi has prepared it. */
  folder: string | undefined;
  /** Each one's heading, by name. */
  headings: ReadonlyMap<string, string>;
}

/**
 * The activity line for an item, as it starts (`ended` false) or ends;
 * undefined for what isn't activity: messages, replies and reasoning. A
 * tool's name is never shown: Rufi's own tools say what they did, in plain
 * words and with no detail, and any other is "Used a tool". A command that
 * only reads Rufi's skills says which, by their headings (their names
 * when they have none); any other shows the command.
 */
export function activityOf(
  item: ThreadItem,
  ended: boolean,
  tools?: AgentTools,
  skills: SkillFiles = { folder: undefined, headings: new Map() },
): Activity | undefined {
  switch (item.type) {
    case "userMessage":
    case "agentMessage":
    case "reasoning":
      return undefined;
    case "mcpToolCall": {
      const status = statusOf(item.status, ended);
      const rufi =
        item.server === tools?.server
          ? tools.specs.find((spec) => spec.name === item.tool)
          : undefined;
      // Rufi's own tools say what they did; their input stays out of the
      // line (a save shows its own receipt). Any other shows its arguments.
      return rufi
        ? line("tool", rufi.shown(item.arguments), undefined, status)
        : line("tool", "Used a tool", argumentsOf(item.arguments), status);
    }
    case "dynamicToolCall":
      return line(
        "tool",
        "Used a tool",
        argumentsOf(item.arguments),
        item.success === false ? "failed" : statusOf(item.status, ended),
      );
    case "commandExecution": {
      const read = skillsRead(item, skills.folder);
      return read
        ? line(
            "command",
            `Read Rufi's instructions: ${and(read.map((name) => skills.headings.get(name) ?? name))}`,
            undefined,
            statusOf(item.status, ended),
          )
        : line(
            "command",
            "Ran a command",
            item.command,
            statusOf(item.status, ended),
          );
    }
    case "webSearch":
      // The words or the page may only be known once it has finished.
      return item.action?.type === "openPage" ||
        item.action?.type === "findInPage"
        ? line(
            "web_search",
            item.action.type === "openPage"
              ? "Opened a web page"
              : "Searched in a web page",
            item.action.url ?? item.query,
            statusOf(undefined, ended),
          )
        : line(
            "web_search",
            "Searched the web",
            item.query,
            statusOf(undefined, ended),
          );
    case "fileChange":
      return line(
        "file_change",
        "Changed files",
        item.changes.map((change) => change.path).join(", "),
        statusOf(item.status, ended),
      );
    case "collabAgentToolCall":
      return line(
        "sub_agent",
        "Worked with a sub-agent",
        item.prompt ?? item.tool,
        statusOf(item.status, ended),
      );
    case "subAgentActivity":
      return line(
        "sub_agent",
        "A sub-agent worked",
        item.agentPath,
        statusOf(item.kind === "completed" ? "completed" : undefined, ended),
      );
    case "plan":
      return line(
        "other",
        "Updated its plan",
        undefined,
        statusOf(undefined, ended),
      );
    case "imageView":
      return line(
        "other",
        "Looked at an image",
        item.path,
        statusOf(undefined, ended),
      );
    case "contextCompaction":
      return line(
        "compaction",
        "Compacted its memory of the chat",
        undefined,
        statusOf(undefined, ended),
      );
    case "imageGeneration": {
      // A picture Codex generated and saved shows in the reply: its path is
      // kept whole, never shortened like a detail.
      const failed =
        item.failure !== null || statusOf(item.status, ended) === "failed";
      if (failed) {
        return line("picture", "Couldn't make a picture", undefined, "failed");
      }
      if (!ended)
        return line("picture", "Making a picture", undefined, "running");
      return item.savedPath
        ? {
            activity: "picture",
            title: "Made a picture",
            detail: item.savedPath,
            status: "done",
          }
        : line(
            "picture",
            "Made a picture Rufi couldn't keep",
            undefined,
            "done",
          );
    }
    case "hookPrompt":
    case "functionCallOutput":
    case "sleep":
    case "enteredReviewMode":
    case "exitedReviewMode":
      return cantDisplay(item.type, ended);
  }
  // A type newer than the generated protocol.
  return cantDisplay(String((item as { type: unknown }).type), ended);
}

const cantDisplay = (type: string, ended: boolean) =>
  line(
    "other",
    "The AI did something Rufi can't display",
    type,
    statusOf(undefined, ended),
  );

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

function failure(
  error: TurnError | null,
  limits: RateLimitSnapshot | undefined,
): TurnEnd {
  const info = error?.codexErrorInfo;
  const failed = (reason: TurnEnd["reason"], text: string): TurnEnd => ({
    status: "failed",
    ...(reason && { reason }),
    text,
  });
  if (info === "unauthorized") {
    return failed(
      "sign_in",
      "ChatGPT didn't accept Rufi's sign-in. Sign in again.",
    );
  }
  if (info === "usageLimitExceeded") {
    const resetsAt = resetOf(limits);
    return {
      ...failed(
        "usage_limit",
        "Your ChatGPT plan's usage limit has been reached.",
      ),
      ...(resetsAt && { resetsAt }),
    };
  }
  if (info === "rateLimitExceeded") {
    return failed(
      "rate_limit",
      "ChatGPT is limiting requests right now. Try again shortly.",
    );
  }
  if (
    typeof info === "object" &&
    info !== null &&
    !("activeTurnNotSteerable" in info)
  ) {
    return failed(
      "connection",
      "Couldn't reach ChatGPT. Check the connection and try again.",
    );
  }
  if (info === "contextWindowExceeded") {
    return failed("provider_failed", "The chat is too long for the model.");
  }
  return failed(
    "provider_failed",
    info === "serverOverloaded" || info === "internalServerError"
      ? "ChatGPT is having trouble. Try again shortly."
      : error?.message || "The AI couldn't finish.",
  );
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
