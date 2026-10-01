// The agent adapter: Rufi talks to a coding agent through this, so the agent
// behind it (Codex now) can change without the rest of Rufi changing.

export type TurnEvent =
  /** Part of the reply, as it streams. */
  | { type: "text"; delta: string }
  /** One plain line about something the agent did ("ran: ls"). */
  | { type: "activity"; text: string }
  /** Something the agent did that Rufi can't display yet. */
  | { type: "unknown"; what: string };

export interface TurnResult {
  status: "completed" | "failed" | "interrupted";
  /** Why it didn't complete, in plain words. */
  reason?: string;
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
