// The agent adapter: Rufi talks to a coding agent through this, so the agent
// behind it (Codex now) can change without the rest of Rufi changing. The
// agent keeps its own threads and its own queue of waiting messages; Rufi
// keeps the conversation (core/chat).
import { Effect } from "effect";

/** What one line of activity is about. */
export type ActivityKind =
  | "tool"
  | "command"
  | "web_search"
  | "file_change"
  | "sub_agent"
  | "other";

/** Why a reply didn't complete, as a screen can act on it. */
type EndReason =
  | "stopped"
  | "timeout"
  | "usage_limit"
  | "rate_limit"
  | "sign_in"
  | "connection"
  | "provider_failed";

export interface TurnEnd {
  status: "completed" | "interrupted" | "failed";
  reason?: EndReason;
  /** Why it didn't complete, in plain words. */
  text?: string;
  /** When a usage limit resets (ISO 8601), when the provider says. */
  resetsAt?: string;
}

/** What the agent does, as it happens. Every event names its thread and turn. */
export type AgentEvent = { threadId: string } & (
  | { type: "turnStarted"; turnId: string }
  /** A message of the user's reached the agent; `id` is the one Rufi gave it. */
  | { type: "message"; turnId: string; id: string; text: string }
  /** Part of a reply, as it streams; `itemId` tells replies apart. */
  | { type: "text"; turnId: string; itemId: string; delta: string }
  /** A question for the user; the answer is their next message. */
  | {
      type: "question";
      turnId: string;
      itemId: string;
      title: string;
      options: string[];
    }
  /** One thing the agent did, when it starts and again when it ends. */
  | {
      type: "activity";
      turnId: string;
      itemId: string;
      activity: ActivityKind;
      title: string;
      detail?: string;
      status: "running" | "done" | "failed";
    }
  | { type: "turnEnded"; turnId: string; end: TurnEnd }
  /** The waiting messages changed; read them again. */
  | { type: "waitingChanged" }
);

/** A Stop that came while Rufi was getting ready to send. */
export class Stopped extends Error {
  constructor() {
    super("Stopped.");
  }
}

/** A message the agent holds until the running reply has ended. */
export interface WaitingMessage {
  /** The agent's id for the waiting entry. */
  id: string;
  /** The id Rufi gave the message. */
  messageId: string;
  text: string;
}

export interface Model {
  id: string;
  name: string;
}

/** Rufi's tools as an agent gets them; the registry in core/tools fills it. */
export interface AgentTools {
  /** Shown to the agent as `<namespace>.<tool>`. */
  namespace: string;
  specs: readonly {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
}

/** A tool's answer for the agent; `stopTurn` asks Rufi to end the turn. */
export interface ToolAnswer {
  ok: boolean;
  /** JSON, for the model. */
  text: string;
  stopTurn?: string;
}

/** What a thread starts with. The agent keeps it for the thread's life. */
export interface ThreadSettings {
  model: string;
  /** Rufi's instructions: safety first, then how to use the tools. */
  instructions: string;
}

export interface AgentRuntime {
  provider: string;
  /** The models the provider offers now. */
  models: (signal?: AbortSignal) => Promise<Model[]>;
  /** Starts a thread with Rufi's tools; returns its id and the model it got. */
  startThread: (
    settings: ThreadSettings,
    signal?: AbortSignal,
  ) => Promise<{ threadId: string; model: string }>;
  /**
   * Picks an existing thread up again. The agent may start what waits in its
   * queue as it does; `running` says a reply is running after it.
   */
  resumeThread: (
    threadId: string,
    settings: ThreadSettings,
    signal?: AbortSignal,
  ) => Promise<{ model: string; running: boolean }>;
  /** Whether the thread is open in the agent now. */
  loaded: (threadId: string) => boolean;
  /** Whether a reply is running in the thread now. */
  running: (threadId: string) => boolean;
  /**
   * Sends a message. It runs now if nothing runs or waits, else it waits its
   * turn; a queue paused by Stop starts again, oldest first. `context` goes
   * before the message (a new thread's earlier conversation).
   */
  send: (
    threadId: string,
    message: { id: string; text: string; context?: string },
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Passes a message into the running reply; returns that reply's turn id. */
  steer: (
    threadId: string,
    message: { id: string; text: string },
  ) => Promise<{ turnId: string }>;
  /** Stops the running reply and what it started; waiting messages wait. */
  stop: (threadId: string) => Promise<void>;
  waiting: {
    list: (threadId: string) => Promise<WaitingMessage[]>;
    edit: (threadId: string, id: string, text: string) => Promise<void>;
    remove: (threadId: string, id: string) => Promise<void>;
    reorder: (threadId: string, ids: string[]) => Promise<void>;
    /** Runs one waiting message now; those after it follow in order. */
    runNow: (threadId: string, id: string) => Promise<void>;
  };
  /**
   * The user's messages the thread has run, oldest first, with the ids Rufi
   * gave them: to fill what a crash kept Rufi from saving.
   */
  startedMessages: (
    threadId: string,
  ) => Promise<{ id: string; text: string }[]>;
  /** Ends the agent process and everything it started. */
  close: () => Promise<void>;
}

/** What the agent needs from Rufi while it runs. */
export interface AgentHost {
  onEvent: (event: AgentEvent) => void;
  /** Runs one of Rufi's tools for a turn; Rufi knows whose thread it is. */
  callTool: (
    threadId: string,
    turnId: string,
    name: string,
    input: unknown,
  ) => Promise<ToolAnswer>;
}

/**
 * How long Rufi waits for a stopped call to end. It covers the slowest path
 * with its own deadlines: renewing the sign-in (Keychain reads and writes up
 * to 60 s each, OpenAI up to three tries of 20 s), whose new token must be
 * saved before Rufi exits. Reaching it means a bug; the agent is then closed
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
  limitMs = STOP_LIMIT_MS,
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
        new Promise((resolve) => setTimeout(resolve, limitMs).unref()),
      ]);
    });
  });
