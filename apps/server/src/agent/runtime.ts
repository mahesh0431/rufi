// The agent adapter: Rufi talks to a coding agent through this, so the agent
// behind it (Codex now) can change without the rest of Rufi changing. The
// agent keeps its own threads; Rufi keeps the chat and what waits to go to
// the AI (core/chat), and starts one turn at a time.
import { Effect } from "effect";

/** What one line of activity is about. */
export type ActivityKind =
  | "tool"
  | "command"
  | "web_search"
  | "file_change"
  | "sub_agent"
  | "compaction"
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
  /**
   * One thing the agent did, when it starts and again when it ends.
   * `details` is everything the agent gave about it so far (what it sent and
   * got back), as it came; plain JSON, in the agent's own shape.
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
);

/** A Stop that came while Rufi was getting ready to send. */
export class Stopped extends Error {
  constructor() {
    super("Stopped.");
  }
}

/**
 * A message the agent surely didn't get: Rufi never asked it, or the agent
 * refused it. Any other failure of a send leaves it unknown.
 */
export class NotSent extends Error {}

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
    /** What a person sees when the AI uses it, in plain words, from what the AI sent. */
    shown: (input: unknown) => string;
    inputSchema: Record<string, unknown>;
  }[];
}

/** A tool's answer for the agent; `stopTurn` asks Rufi to end the turn. */
export interface ToolAnswer {
  ok: boolean;
  /** JSON, for the model. */
  text: string;
  /** Images the model sees after the text, as data: URLs. */
  images?: readonly string[];
  stopTurn?: string;
}

/** What a thread starts with. The agent keeps it for the thread's life. */
export interface ThreadSettings {
  model: string;
  /**
   * How hard the AI thinks, from the thread's first turn on, also those a
   * resume starts by itself; without it, the agent's default.
   */
  effort?: string;
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
   * Picks an existing thread up again; `running` says a reply is running in
   * it. It starts nothing.
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
   * Starts a reply to `input` (its parts in order: a new thread's earlier
   * chat, Rufi's notes, the person's message), by the id Rufi gives it. Only
   * when no reply runs. `effort` is how hard the AI thinks, from this reply
   * on; without it, the thread keeps its own. Throws NotSent when the agent
   * surely didn't get it.
   */
  send: (
    threadId: string,
    message: { id: string; input: string[]; effort?: string },
    signal?: AbortSignal,
  ) => Promise<void>;
  /**
   * Passes a message into the running reply; returns that reply's turn id.
   * Throws NotSent when no reply runs or the agent refused it.
   */
  steer: (
    threadId: string,
    message: { id: string; text: string },
  ) => Promise<{ turnId: string }>;
  /** Stops the running reply (only when it is `turnId`, if given) and what it started. */
  stop: (threadId: string, turnId?: string) => Promise<void>;
  /**
   * The messages the thread has run, oldest first, with the ids Rufi gave
   * them: to fill what a crash kept Rufi from saving.
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
  /**
   * Runs one of Rufi's tools for a turn; Rufi knows whose thread it is.
   * `callId` is the agent's id for the call: the same call again has it too.
   */
  callTool: (
    threadId: string,
    turnId: string,
    name: string,
    input: unknown,
    callId: string,
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

/**
 * A Rufi sub-agent's one task: a locked-down AI thread that Rufi starts for
 * background work (a document's reader). It sees only its own instructions,
 * its input and exactly the tools it is given; it has no chat history, no
 * workspace and no network, and saves nothing of its own.
 */
export interface SubAgentTask {
  model: string;
  effort: string;
  /** Its whole instructions: they replace the agent's own, not add to them. */
  instructions: string;
  /** Its one message: what to do. */
  input: string;
  tools: AgentTools;
  /** Runs one of its tools; the task's owner binds them to their data. */
  callTool: (
    name: string,
    input: unknown,
    callId: string,
  ) => Promise<ToolAnswer>;
  /** The agent summarised the thread: what the sub-agent saw before is gone. */
  onCompaction: () => void;
  /** How long the whole turn may take. */
  deadlineMs: number;
}

/** How a sub-agent's turn ended, as Rufi saw it. */
export interface SubAgentOutcome {
  /** Only `completed` means the turn ended normally. */
  end: TurnEnd;
  /** How often the agent summarised the thread during the turn. */
  compactions: number;
  /** The turn's tokens, as the agent reported them last. */
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  };
}

/** Runs one sub-agent task to its end; a Stop (signal) interrupts it. */
export type RunSubAgent = (
  task: SubAgentTask,
  signal?: AbortSignal,
) => Promise<SubAgentOutcome>;
