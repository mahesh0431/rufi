// The agent adapter: Rufi talks to a coding agent through this, so the agent
// behind it (Codex now) can change without the rest of Rufi changing. The
// agent keeps its own threads; Rufi keeps the chat and what waits to go to
// the AI (core/chat), and starts one turn at a time.
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

/** What one line of activity is about. */
export type ActivityKind =
  | "tool"
  | "command"
  | "web_search"
  | "file_change"
  | "sub_agent"
  | "compaction"
  /** A picture the agent made; its detail is the file's path, whole. */
  | "picture"
  /** The agent's progress note: its words, as they came. */
  | "note"
  | "other";

/** Why a reply didn't complete, as a screen can act on it. */
type EndReason =
  | "stopped"
  | "timeout"
  | "usage_limit"
  | "rate_limit"
  | "sign_in"
  | "connection"
  | "provider_failed"
  /** Rufi couldn't save the reply, so it stopped it. */
  | "save_failed";

export interface TurnEnd {
  status: "completed" | "interrupted" | "failed";
  reason?: EndReason;
  /**
   * Why it didn't complete: an error from the service in its own words,
   * else Rufi's.
   */
  text?: string;
  /** When a usage limit resets (ISO 8601), when the provider says. */
  resetsAt?: string;
  /** The agent's process ended under the turn: it crashed, or Rufi ended it. */
  died?: true;
}

/** What the agent does, as it happens. Every event names its thread and turn. */
export type AgentEvent = { threadId: string } & (
  | { type: "turnStarted"; turnId: string }
  /** A message of the user's reached the agent; `id` is the one Rufi gave it. */
  | { type: "message"; turnId: string; id: string; text: string }
  /** Part of a reply, as it streams; `itemId` tells replies apart. */
  /** Part of the agent's answer, as it streams; `done` once it is whole. */
  | {
      type: "text";
      turnId: string;
      itemId: string;
      delta: string;
      done?: true;
    }
  /**
   * Part of the agent's progress note (a message the agent marks as
   * commentary, not its answer), as it streams; `done` once it is whole.
   */
  | {
      type: "note";
      turnId: string;
      itemId: string;
      delta: string;
      done?: true;
    }
  /** A question for the user; the answer is their next message. */
  | {
      type: "question";
      turnId: string;
      itemId: string;
      title: string;
      options: string[];
    }
  /**
   * One thing the agent did, when it starts and again when it ends: its
   * `title` and `detail` as the agent reported them (the command and its
   * exit code, the tool and its arguments). `details` is everything the
   * agent gave about it so far (what it sent and got back), as it came;
   * plain JSON, in the agent's own shape.
   */
  | {
      type: "activity";
      turnId: string;
      itemId: string;
      activity: ActivityKind;
      title: string;
      detail?: string;
      status: "running" | "done" | "failed";
      details?: unknown;
    }
  /**
   * The agent's reasoning for a step as it goes: an empty `delta` when it
   * starts thinking, then each part of its summary as it streams.
   */
  | { type: "thinking"; turnId: string; itemId: string; delta: string }
  /**
   * The agent's reasoning for a step, once it is whole: the summary it gave
   * (empty when none), and everything it gave as it came (plain JSON).
   */
  | {
      type: "reasoning";
      turnId: string;
      itemId: string;
      summary: string;
      details: unknown;
    }
  | { type: "turnEnded"; turnId: string; end: TurnEnd }
  /**
   * How much of the model's context the thread used, as the agent last
   * reported it: the last request's tokens, and the model's context window
   * (null when the agent doesn't know it). It may come outside a reply.
   */
  | { type: "usage"; turnId: string; tokens: number; window: number | null }
  /**
   * What the reply used, across all its requests, as the agent counted it,
   * once it ends: the input tokens (all of them, and of those, how many came
   * from the cache) and the tokens written. `payload` is the agent's own
   * count, as it came.
   */
  | {
      type: "turnUsage";
      turnId: string;
      input: number;
      cached: number;
      output: number;
      payload: unknown;
    }
);

/** A Stop that came while Rufi was getting ready to send. */
export class Stopped extends Error {
  constructor() {
    super("Stopped.");
  }
}

/**
 * The agent couldn't open a thread it has: the thread may well be there,
 * so it isn't replaced; the message waits with the agent's reason.
 */
export class NotOpened extends Error {}

/**
 * The agent has no thread by that id (its files are gone, or it is another
 * folder's): only a new thread can reply.
 */
export class ThreadNotFound extends NotOpened {}

/**
 * A thread that is there but didn't take its new instructions: it must not
 * reply until it has them.
 */
export class NotReloaded extends NotOpened {
  constructor(
    message = "The AI couldn't take Rufi's new instructions, so it can't reply now. Try again.",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * A message the agent surely didn't get: Rufi never asked it, or the agent
 * refused it. Any other failure of a send leaves it unknown.
 */
export class NotSent extends Error {}

/** The provider says it isn't signed in: only signing in again ends it. */
export class SignedOut extends Error {}

export interface Model {
  id: string;
  name: string;
}

/** An MCP server of Rufi's for one thread: its address and the thread's key. */
export interface McpServer {
  url: string;
  key: string;
}

/**
 * Where the chat's AI works: its folder, the only place its commands can
 * write, and the paths they can never read (the record's database and
 * Rufi's other ways in to it).
 */
export interface AgentSandbox {
  folder: string;
  unreadable: readonly string[];
}

/**
 * The sandbox with the person's own keychains denied too, under the HOME
 * the AI's commands get (else this account's): Claude keeps its sign-in in
 * one, and a command reading a keychain opens its file itself (ADR 0016).
 * On macOS only, where the Keychain is: on Linux there is no such folder,
 * and Codex's sandbox there (bubblewrap) can't deny a path whose folder
 * isn't there, so no conversation would open.
 */
export const withKeychains = (
  sandbox: AgentSandbox,
  userHome: string | undefined,
): AgentSandbox =>
  process.platform === "darwin"
    ? {
        ...sandbox,
        unreadable: [
          ...sandbox.unreadable,
          join(userHome ?? homedir(), "Library", "Keychains"),
        ],
      }
    : sandbox;

/**
 * One of Rufi's skills, as the agent reads it: its SKILL.md, by name, and
 * the files beside it.
 */
export interface AgentSkill {
  name: string;
  text: string;
  files: Readonly<Record<string, string>>;
}

/**
 * What a thread starts or is picked up with. The agent keeps its
 * instructions in the thread's history: new ones reach it only by
 * reloadThread.
 */
export interface ThreadSettings {
  model: string;
  /**
   * How hard the AI thinks, from the thread's first turn on, also those a
   * resume starts by itself; without it, the agent's default.
   */
  effort?: string;
  /** Rufi's core instructions: safety first, then the rules and the skills' index. */
  instructions: string;
  /** Where the thread gets Rufi's tools, given again each time it is resumed. */
  tools?: McpServer;
  /** Its working folder, in the AI's folder; without it, the AI's folder. */
  cwd?: string;
}

export interface AgentRuntime {
  provider: string;
  /** The models the provider offers now. */
  models: (signal?: AbortSignal) => Promise<Model[]>;
  /**
   * Starts a thread with Rufi's tools; returns its id and the model it got.
   * Its preparation and first send share a signal and readiness decision.
   */
  startThread: (
    settings: ThreadSettings,
    signal?: AbortSignal,
  ) => Promise<{ threadId: string; model: string }>;
  /**
   * Picks an existing thread up again; `running` says a reply is running in
   * it. It starts nothing. A thread already open keeps what it was given.
   * Throws ThreadNotFound when the agent has no such thread, NotOpened when
   * it couldn't open it for another reason.
   */
  resumeThread: (
    threadId: string,
    settings: ThreadSettings,
    signal?: AbortSignal,
  ) => Promise<{ model: string; running: boolean }>;
  /**
   * Gives an idle thread new instructions: it is closed if open, picked up
   * again with `settings` (what the agent starts from again after it
   * compacts), and `note` (the new rules whole, saying they replace the
   * earlier ones) is added to its history, which still holds the rules it
   * was first given. Returns once the agent has stored the note; throws when
   * any part of that didn't happen.
   */
  reloadThread: (
    threadId: string,
    settings: ThreadSettings,
    note: string,
    signal?: AbortSignal,
  ) => Promise<{ model: string }>;
  /** Whether the thread is open in the agent now. */
  loaded: (threadId: string) => boolean;
  /** Whether a reply is running in the thread now. */
  running: (threadId: string) => boolean;
  /**
   * The running reply that may still use Rufi's tools: its turn id, or
   * nothing when no reply runs or it is stopping.
   */
  activeTurn: (threadId: string) => string | undefined;
  /**
   * Starts a reply to `input` (its parts in order: a new thread's earlier
   * chat, Rufi's notes, the person's message), by the id Rufi gives it. Only
   * when no reply runs. `model` and `effort` are the AI's from this reply
   * on, in the same thread; without them, the thread keeps its own. Throws
   * NotSent when the agent surely didn't get it.
   */
  send: (
    threadId: string,
    message: { id: string; input: string[]; model?: string; effort?: string },
    signal?: AbortSignal,
  ) => Promise<void>;
  /**
   * Passes a message into the running reply; returns that reply's turn id.
   * Throws NotSent when it surely didn't reach the agent: no reply runs,
   * the agent refused it, or Rufi couldn't get to the agent (signed out).
   */
  steer: (
    threadId: string,
    message: { id: string; text: string },
  ) => Promise<{ turnId: string }>;
  /**
   * Stops the running reply (only when it is `turnId`, if given) and what it
   * started; `end` says why, when Rufi decided it.
   */
  stop: (threadId: string, turnId?: string, end?: TurnEnd) => Promise<void>;
  /** Ends the agent process and everything it started. */
  close: () => Promise<void>;
}

/** What the agent needs from Rufi while it runs. */
export interface AgentHost {
  onEvent: (event: AgentEvent) => void;
}

/**
 * How long Rufi waits for a stopped call to end. Each agent's own Stop has
 * deadlines well within it; reaching it means a bug. The agent is then closed
 * with the scope that holds it.
 */
const STOP_LIMIT_MS = 5 * 60_000;

/**
 * One agent call as an Effect. When it is interrupted (Ctrl-C, a closing
 * scope), `stop` is called and the call is awaited until it has really
 * ended, so nothing it started outlives the command. `onStop` runs first, for
 * a word to the person.
 */
export const agentCall = <A>(
  call: () => Promise<A>,
  stop: () => Promise<void>,
  onStop?: () => void,
) =>
  Effect.callback<A, unknown>((resume) => {
    const pending = call();
    pending.then(
      (value) => {
        resume(Effect.succeed(value));
      },
      (error: unknown) => {
        resume(Effect.fail(error));
      },
    );
    return Effect.promise(async () => {
      onStop?.();
      // Only that they have ended matters, not how.
      await Promise.race([
        Promise.allSettled([Promise.resolve().then(stop), pending]),
        new Promise((resolve) => setTimeout(resolve, STOP_LIMIT_MS).unref()),
      ]);
    });
  });
