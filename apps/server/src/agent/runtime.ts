// The agent adapter: Rufi talks to a coding agent through this, so the agent
// behind it (Codex now) can change without the rest of Rufi changing.
import { Context, Effect } from "effect";

export type TurnEvent =
  /** Part of the reply, as it streams. */
  | { type: "text"; delta: string }
  /** One plain line about something the agent did ("ran: ls"). */
  | { type: "activity"; text: string }
  /** Something the agent did that Rufi can't display yet. */
  | { type: "unknown"; what: string }
  /** A question for the user; the answer is their next message. */
  | { type: "question"; title: string; options: string[] };

export interface TurnResult {
  status: "completed" | "failed" | "interrupted";
  /** Why it didn't complete, in plain words. */
  reason?: string;
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
  /** What the agent is told about using them. */
  instructions: string;
  /** A caller for one turn; it counts the turn's rejected calls. */
  forTurn: () => (name: string, input: unknown) => Promise<ToolAnswer>;
}

/** A tool's answer for the agent; `stopTurn` asks Rufi to end the turn. */
export interface ToolAnswer {
  ok: boolean;
  /** JSON, for the model. */
  text: string;
  stopTurn?: string;
}

export interface AgentRuntime {
  /** Starts a conversation, or picks one up again by id; returns its id. */
  open: (conversationId?: string) => Promise<string>;
  /** Runs one turn; `onEvent` gets the reply and activity as they happen. */
  turn: (
    conversationId: string,
    text: string,
    onEvent: (event: TurnEvent) => void,
  ) => Promise<TurnResult>;
  /** Stops the running turn, ending any program it started. */
  stop: () => Promise<void>;
  /** Ends the agent process and everything it started. */
  close: () => Promise<void>;
}

/** The agent, for as long as it's needed; closing it ends what it started. */
export class Agent extends Context.Service<Agent, AgentRuntime>()(
  "rufi/Agent",
) {}

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
 * scope), the agent is asked to stop and the call is awaited until it has
 * really ended, so nothing it started outlives the command. `onStop` runs
 * first, for a word to the person.
 */
export const agentCall = <A>(
  agent: AgentRuntime,
  call: () => Promise<A>,
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
        Promise.allSettled([
          Promise.resolve().then(() => agent.stop()),
          pending,
        ]),
        new Promise((resolve) => setTimeout(resolve, limitMs).unref()),
      ]);
    });
  });
