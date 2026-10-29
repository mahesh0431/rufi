// The provider boundary: what every provider's adapter does, so the agent
// system above it never names a provider. An adapter runs conversations on
// its provider (Codex, Claude) and reports what happens in them as events.
// What waits to be sent, and what was sent, is the agent system's: an
// adapter keeps no queue of its own and never sends an input twice. How it
// keeps its processes is its own business. tests/contract.ts is the suite
// every adapter passes; tests/fake-provider.ts stands in for one in the
// package's own tests.

/** The family of models a provider runs; a change of family starts afresh. */
export type Family = "openai" | "anthropic";

export interface ProviderModel {
  id: string;
  name: string;
  /** The efforts it takes, as the provider names them. */
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
   * Earlier history as text, for a new conversation: the provider has it
   * before the first input.
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
 * What became of an input handed to the provider. Not delivered: surely not
 * received (it may go again). Uncertain: it may have arrived; it is never
 * sent again by itself, and reconcile may tell.
 */
export type Delivery =
  | { status: "delivered" }
  | { status: "not_delivered"; reason?: "signed_out"; text: string }
  | { status: "uncertain"; text: string };

/**
 * What became of a steer. Started the next turn: the provider began a new
 * turn with it, whose turnStarted event, given first, names it.
 */
export type SteerOutcome =
  | { status: "delivered" }
  | { status: "not_delivered"; text: string }
  | { status: "uncertain"; text: string }
  | { status: "next_turn"; turn: string };

/** Whether the provider received an input, as far as it can tell. */
export type Received = "received" | "not_received" | "unknown";

/** A call to Rufi's tools, as the adapter places it. */
export interface PlacedCall {
  /** The open turn it left, by the provider's reference. */
  turn: string;
  /** The provider's call id: the same on a repeat, unique in the conversation. */
  call: string;
}

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
  /**
   * Puts an input into the running turn. The outcome may come only when
   * the turn ends; until then the input is with the provider.
   */
  steer: (steer: Steer) => Promise<SteerOutcome>;
  /**
   * Stops the turn, if it still runs, within a bound: interrupted, or else
   * its process is ended. Resolves once its turnEnded event is given, after
   * which nothing more of it comes. A steer the provider held and didn't
   * take is answered not delivered first.
   */
  stop: (turn: string) => Promise<void>;
  /** Which of these inputs the provider received. */
  reconcile: (ids: readonly string[]) => Promise<ReadonlyMap<string, Received>>;
  /**
   * The open turn a call to Rufi's tools left, from the call's `_meta`, as
   * the adapter vouches for it; nothing when it can't place the call in an
   * open turn of this conversation, and the call is refused.
   */
  placeCall: (meta: unknown) => PlacedCall | undefined;
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
  /** Usage now and when limits reset; empty when the provider says nothing. */
  usage: () => Promise<readonly UsageWindow[]>;
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
 * and its turnEnded. Payloads are as the provider reported them, plain
 * JSON, with images left out.
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
