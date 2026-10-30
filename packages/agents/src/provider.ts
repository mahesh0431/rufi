// The provider boundary: what every provider's adapter does, so the agent
// system above it never names a provider. An adapter runs conversations on
// its provider (Codex, Claude) and reports what happens in them as events.
// What waits to be sent, and what was sent, is the agent system's: an
// adapter keeps no queue of its own and never sends an input twice. An
// input counts as sent once it is handed over; nobody asks the provider
// later whether it arrived. How an adapter keeps its processes is its own
// business. tests/contract.ts is the suite every adapter passes;
// tests/fake-provider.ts stands in for one in the package's own tests.

/** The family of models a provider runs; a change of family starts afresh. */
export type Family = "openai" | "anthropic";

export interface ProviderModel {
  id: string;
  name: string;
  /** The efforts it takes, as the provider names them; none for some. */
  efforts: readonly string[];
  /** The provider's default effort, when it gives one. */
  defaultEffort?: string;
}

/** Where a conversation gets Rufi's tools: the MCP door and the agent's key. */
export interface McpRegistration {
  url: string;
  key: string;
}

/** What goes to the provider in one go, by the stable id Rufi gave it. */
export interface Input {
  id: string;
  /** Its parts in order (Rufi's notes, then the message), as written. */
  parts: readonly string[];
}

export interface OpenOptions {
  /** The conversation to pick up again, by its reference; none starts one. */
  resume?: string;
  /** The working folder. */
  cwd: string;
  /** Rufi's instructions, given at every open; the adapter keeps none. */
  instructions: string;
  model: string;
  effort: string;
  /** Rufi's tools, registered at every open. */
  tools: McpRegistration;
  /**
   * Earlier history as text, for a new conversation. It goes in front of the
   * first input, never during open, so nothing of Rufi's is in the
   * conversation before Rufi has kept its reference.
   */
  seed?: string;
  /** Where the conversation's events go, in order. */
  onEvent: (event: ProviderEvent) => void;
  signal?: AbortSignal;
}

/** A resume found no conversation by that reference: only a new one can go on. */
export class Missing extends Error {}

/**
 * A conversation didn't open for another reason: it may well be there, so
 * it isn't replaced. Signed out says the sign-in must come first.
 */
export class NotOpened extends Error {
  readonly reason: "signed_out" | "other";
  constructor(
    message: string,
    options?: ErrorOptions & { reason?: "signed_out" | "other" },
  ) {
    super(message, options);
    this.reason = options?.reason ?? "other";
  }
}

/**
 * What became of an input handed to the provider: it counts as sent once
 * handed over. Not delivered only when the provider surely didn't take it,
 * so it may go again; missing, when the provider no longer has the
 * conversation, so only a new one can take it. When the hand-over failed
 * after the input may have gone, startTurn and steer reject with the error:
 * the input counts as sent all the same.
 */
export type Delivery =
  | { status: "delivered" }
  | {
      status: "not_delivered";
      reason?: "signed_out" | "missing";
      text: string;
    };

/**
 * What became of a steer. Delivered: the provider took it, into its turn
 * or into a turn it begins by itself, whose turnStarted names it. Not
 * delivered: its turn had ended, or the provider refused it; it starts the
 * next turn.
 */
export type SteerOutcome =
  | { status: "delivered" }
  | { status: "not_delivered"; text: string };

export interface TurnStart {
  input: Input;
  /** The turn's model and effort; the conversation keeps them after it. */
  model: string;
  effort: string;
}

export interface Steer {
  input: Input;
  /** The running turn it is for; another turn doesn't take it. */
  turn: string;
}

export interface Conversation {
  /** The provider's reference, kept to resume it. */
  readonly ref: string;
  /** Starts a turn when none runs. */
  startTurn: (start: TurnStart) => Promise<Delivery>;
  /** Puts an input into the running turn. */
  steer: (steer: Steer) => Promise<SteerOutcome>;
  /**
   * Stops the turn, if it still runs, within a bound: interrupted, or else
   * its process is ended. Resolves once its turnEnded event is given, after
   * which nothing more of it comes.
   */
  stop: (turn: string) => Promise<void>;
  /** Lets go of the conversation, stopping a running turn first. */
  close: () => Promise<void>;
}

/** One window of the provider's usage limits, when it reports them. */
export interface UsageWindow {
  /** Its length in minutes, when the provider says. */
  minutes?: number;
  usedPercent: number;
  /** When it resets (ISO 8601), when the provider says. */
  resetsAt?: string;
}

export interface ProviderAdapter {
  /** Rufi's name for it, kept with each conversation it opens. */
  readonly id: string;
  readonly family: Family;
  /** The models the provider offers now. */
  models: (signal?: AbortSignal) => Promise<readonly ProviderModel[]>;
  /**
   * Starts a conversation, or resumes one. Throws Missing when a resume
   * finds nothing, NotOpened for any other failure.
   */
  open: (options: OpenOptions) => Promise<Conversation>;
  /**
   * Removes a conversation, not open, by its reference; one already gone
   * counts as removed.
   */
  delete: (ref: string) => Promise<void>;
  /** Usage now and when limits reset; empty when the provider says nothing. */
  usage: () => Promise<readonly UsageWindow[]>;
  /**
   * The provider's id of a call to Rufi's tools, from the call's `_meta`:
   * the same on a repeat, unique in its conversation. Nothing when the
   * call has none, and it is refused.
   */
  callOf: (meta: unknown) => string | undefined;
  /** Ends the adapter's processes and everything they started. */
  close: () => Promise<void>;
}

/** What a step is about. */
export type StepKind =
  | "tool"
  | "command"
  | "web_search"
  | "file_change"
  | "sub_agent"
  | "compaction"
  /** A picture the agent made; its detail is the file's path, whole. */
  | "picture"
  | "other";

/**
 * Why a turn failed. Signed out: the sign-in couldn't be kept for the
 * turn, and the input isn't sent again.
 */
export type FailReason =
  | "signed_out"
  | "usage_limit"
  | "rate_limit"
  | "connection"
  | "process_died"
  | "other";

export type TurnEnd =
  /** The turn ended normally; `answer` is its last answer, whole. */
  | { status: "done"; answer: string }
  | { status: "stopped" }
  | {
      status: "failed";
      reason: FailReason;
      /** The provider's own words, when it gave any. */
      text?: string;
      /** When a usage limit resets (ISO 8601), when the provider says. */
      resetsAt?: string;
    };

/**
 * What happens in a conversation, in order. Every event names its turn by
 * the provider's reference; a turn's events come between its turnStarted
 * and its turnEnded, except usage. Payloads are as the provider reported
 * them, plain JSON, with images left out.
 */
export type ProviderEvent =
  /** A turn started, with the inputs that started it. */
  | { type: "turnStarted"; turn: string; inputs: readonly string[] }
  /** Part of the agent's answer, as it streams; `done` once it is whole. */
  | { type: "text"; turn: string; item: string; delta: string; done?: true }
  /** Part of the agent's progress note, as it streams; `done` once whole. */
  | { type: "note"; turn: string; item: string; delta: string; done?: true }
  /** A question for whoever sent the input; the answer is their next one. */
  | {
      type: "question";
      turn: string;
      item: string;
      title: string;
      options: readonly string[];
    }
  /** The agent's reasoning as it streams: empty when it starts thinking. */
  | { type: "thinking"; turn: string; item: string; delta: string }
  /** The agent's reasoning for a step, whole: its summary, and all it gave. */
  | {
      type: "reasoning";
      turn: string;
      item: string;
      summary: string;
      payload: unknown;
    }
  /**
   * One thing the agent did, when it starts and again when it ends: its
   * title and detail as reported (the command and its exit code, the tool
   * and its arguments), and all the provider gave about it so far.
   */
  | {
      type: "step";
      turn: string;
      item: string;
      kind: StepKind;
      title: string;
      detail?: string;
      status: "running" | "done" | "failed";
      payload?: unknown;
    }
  /**
   * How much of the model's context the conversation used: the last
   * request's tokens, and the model's window when known. It may come
   * outside a turn, naming the last one.
   */
  | { type: "usage"; turn: string; tokens: number; window: number | null }
  | { type: "turnEnded"; turn: string; end: TurnEnd };
