// The agent adapter: Rufi talks to a coding agent through this, so the agent
// behind it (Codex now) can change without the rest of Rufi changing.
import { Context } from "effect";

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
