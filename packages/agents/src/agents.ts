// Runs agents: each agent's provider conversation, its turns, and what
// happens in them, kept in the agent database (./store.ts) as the provider
// reports it, and shown to the host as it comes. An agent the host hasn't
// admitted never runs. A call to the host's tools belongs to its agent and
// goes under its running turn, until a Stop closes it.
//
// Every agent's inputs wait in one queue, and one dispatcher for each agent
// hands them over: the first waiting input starts a turn, a steer goes into
// the running turn at once, a queued input waits for the turn to end. An
// input the host keeps is claimed from it as it goes. An input counts as
// sent once it is handed over; only one the provider surely didn't take
// goes again.
import { randomUUID } from "node:crypto";
import {
  Missing,
  NotOpened,
  type Conversation,
  type Delivery,
  type McpRegistration,
  type ProviderAdapter,
  type ProviderEvent,
  type SteerOutcome,
  type TurnEnd,
} from "./provider.ts";
import type { AgentStore } from "./store.ts";

export type AgentStatus =
  | "idle"
  | "running"
  | "continuing"
  | "done"
  | "stopped"
  | "failed";

export interface Agent {
  id: string;
  /** Its parent; null for a root. */
  parent: string | null;
  root: string;
  title: string;
  /** What its next turn runs on: the adapter, model and effort. */
  provider: string;
  model: string;
  effort: string;
  /** The host's tools it may use. */
  tools: readonly string[];
  cwd: string;
  /** Its provider conversation's number: 0 before any. */
  conversation: number;
  admitted: boolean;
  status: AgentStatus;
  /** Its latest result: its last answer, or why it failed. */
  result: string | null;
  stoppedBy: string | null;
}

export interface NewAgent {
  /** Given by the host: the starting call's id, or its own for a root. */
  id: string;
  /** Its parent; none for a root. */
  parent?: string;
  title: string;
  provider: string;
  model: string;
  effort: string;
  /** The host's tools it may use: a child's are among its parent's. */
  tools: readonly string[];
  cwd: string;
  /** A provider conversation it takes over, by its reference: its first. */
  adopt?: string;
}

/** What the host gives a conversation each time it opens. */
export interface Opening {
  instructions: string;
  tools: McpRegistration;
  /** Earlier history as text, for a new conversation (the seed). */
  seed?: string;
}

/** The host's answer when it is asked for an input it keeps. */
export type Claim =
  /** It waited: its words. */
  | { status: "claimed"; parts: readonly string[] }
  /** It doesn't wait any more: it doesn't go. */
  | { status: "gone" };

/** What the package asks of the host, and waits for. */
export interface Host {
  /** What an agent's conversation opens with: resumed, or new. */
  opening: (agent: Agent, kind: "resume" | "new") => Promise<Opening>;
  /**
   * Keeps a new conversation's reference (the host's ledger), before any of
   * the host's content goes into it; resolves once it is saved.
   */
  ledger: (entry: {
    agent: string;
    conversation: number;
    provider: string;
    ref: string;
  }) => Promise<void>;
  /**
   * Claims an input the host keeps, as it goes to the provider: one host
   * transaction marks it taken and gives back its words. Nothing: the host
   * is closing, and it waits for the next start.
   */
  claim: (claim: {
    agent: string;
    conversation: number;
    input: string;
  }) => Promise<Claim | undefined>;
}

/** An input for an agent. */
export interface Sent {
  /** Its stable id: sent again, it does nothing. */
  id: string;
  /** Who sent it, as the host names them, or the sending agent's id. */
  sender: string;
  /** Steer: as soon as a turn can take it. Queue: after this turn. */
  kind: "steer" | "queue";
  /** What is sent; none when the host keeps the words and claims give them. */
  parts?: readonly string[];
  /** A message one agent wrote to another (its done messages are the package's). */
  about?: "wrote";
  /** What the sending agent wrote, in its own words, without the line around them. */
  said?: string;
  /**
   * The person wrote it: the agent's restarts in a row count from none
   * again, and what the last one held goes.
   */
  person?: true;
}

/** Why an input from one agent to another came. */
export type About = "done" | "stopped" | "failed" | "asked" | "wrote";

/**
 * A message from another agent among what an agent took, as its events
 * carry it: its input, who sent it, by the name they had then, why, and
 * what they said in their own words.
 */
export interface AgentMessage {
  input: string;
  agent: string;
  title: string;
  about: About;
  said: string;
}

/** An input waiting for its agent, as `waiting` lists it. */
export interface WaitingInput {
  id: string;
  /** Who sent it, as the host names them, or the sending agent's id. */
  sender: string;
  kind: "steer" | "queue";
  /** Its words; none when the host keeps them. */
  parts: string[] | null;
  about: About | null;
  held: Hold | null;
  heldText: string | null;
}

/**
 * Why a waiting input isn't handed over by itself. Stopped: a Stop came
 * before it went.
 */
export type Hold =
  | "signed_out"
  | "open_failed"
  | "failed"
  | "stopped"
  | "restarts";

/**
 * The agent's turn in this process: starting, with the input it starts
 * with, or admitted, by the provider's reference, and stopping once its
 * Stop is under way.
 */
export type Current =
  | { status: "starting"; input: string }
  | { status: "running" | "stopping"; turn: string; ref: string };

/** A call to the host's tools, under its agent's running turn. */
export interface Placed {
  agent: string;
  /** The package's turn. */
  turn: string;
  /** The provider's reference for that turn. */
  ref: string;
  conversation: number;
  /** The provider's call id. */
  call: string;
}

/** One turn of an agent, as the package keeps it. */
export interface KeptTurn {
  id: string;
  /** The provider's reference for it, once it started. */
  ref: string | null;
  status: string;
  /** Why it stopped or failed. */
  reason: string | null;
  /** Its final answer whole, or the provider's words when it failed. */
  result: string | null;
  /**
   * What it used, as its provider counted it once it ended: input tokens
   * (all, and of those, from the cache) and the tokens written.
   */
  used: { input: number; cached: number; output: number } | null;
  startedAt: string;
  endedAt: string | null;
  /** What it took, in order: who sent each, and its words, unless the host keeps them. */
  inputs: {
    id: string;
    sender: string;
    parts: string[] | null;
    /** When it was delivered: at the turn's start, or as it was steered in. */
    at: string;
  }[];
  /** What it reported, in order. */
  items: Item[];
  /** What it asked, kept apart from the items they came with, in order. */
  questions: {
    item: string;
    /** Its order among its item's questions: 1, 2... */
    number: number;
    title: string;
    options: string[];
    at: string;
  }[];
}

/** One thing a turn reported, as the package kept it. */
export interface Item {
  /** The provider's reference for its turn. */
  turn: string;
  /** The number of the agent's conversation its turn ran in. */
  conversation: number;
  /** The provider's item id. */
  id: string;
  /** Its place in its turn, from when the turn first reported it. */
  position: number;
  type: "text" | "note" | "reasoning" | "step";
  kind: string | null;
  title: string | null;
  detail: string | null;
  /** A step's, as reported; `done` for text, a note or a reasoning once whole. */
  status: string | null;
  text: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Agents {
  /** Adds an agent, not admitted: it runs only once the host admits it. */
  create: (agent: NewAgent) => Agent;
  /** The host keeps the agent's owner now, so it may run. Again does nothing. */
  admit: (id: string) => void;
  get: (id: string) => Agent | undefined;
  /** Every agent the database keeps, admitted or not. */
  list: () => string[];
  /** Every agent below this one, at any depth, oldest first. */
  below: (id: string) => string[];
  /**
   * The agent's turns, the latest `limit` before the turn `before` (or the
   * latest), oldest first, and the first of them when there are earlier
   * ones: the `before` of the page before.
   */
  history: (
    agent: string,
    page: { before?: string; limit: number },
  ) => { turns: KeptTurn[]; earlier: string | null };
  /**
   * Where an input is in its agent's queue, who sent it and, from another
   * agent, why; nothing when the queue has none.
   */
  input: (id: string) =>
    | {
        agent: string;
        state: string;
        held: Hold | null;
        sender: string;
        about: About | null;
      }
    | undefined;
  /** The messages from other agents among these inputs, in their order. */
  messages: (inputs: readonly string[]) => AgentMessage[];
  /** What waits for the agent, held too, in the order it goes. */
  waiting: (agent: string) => WaitingInput[];
  /** The agent's turn now, if one starts or runs. */
  current: (agent: string) => Current | undefined;
  /**
   * What these turns of the agent reported, by the provider's references,
   * each turn's items in order; without what the provider gave about each.
   * Text, a note or a reasoning still streaming is there as far as it came.
   */
  items: (agent: string, turns: readonly string[]) => Item[];
  /** Which of these turns of the agent, by the provider's references, it keeps. */
  known: (agent: string, turns: readonly string[]) => string[];
  /** One item, with everything the provider gave about it. */
  item: (
    agent: string,
    turn: string,
    id: string,
  ) => (Item & { payload: unknown }) | undefined;
  /**
   * Opens the admitted agent's conversation now, if it isn't open: its
   * own, or a new one when it has none or the provider no longer has it.
   * Returns its reference.
   */
  open: (agent: string) => Promise<string>;
  /**
   * Lets go of the agent's conversation while nothing of it is under way,
   * so that it opens again with what the host gives then: its own, or a
   * new one when `fresh`. Refused while a turn starts or runs, or an input
   * is with the provider.
   */
  reopen: (agent: string, fresh?: boolean) => Promise<void>;
  /**
   * What the agent's next turns run on; for a root, also the host's tools
   * it may use (a child's are set when it starts). On another provider, its
   * next turn starts a new conversation there.
   */
  configure: (
    agent: string,
    settings: {
      provider?: string;
      model: string;
      effort: string;
      tools?: readonly string[];
    },
  ) => void;
  /**
   * Puts an input in the agent's queue, behind those waiting. It goes when
   * the agent can take it; the sender is never told no.
   */
  send: (agent: string, input: Sent) => void;
  /**
   * Starts handing inputs over, once the host has finished starting: first
   * what a crash left handed over counts as sent, a start's turn stopped by
   * the restart; a turn that ran carries on, up to `continues` restarts in
   * a row (none by default); then what waits goes. Nothing goes to a
   * provider before it. Again does nothing.
   */
  dispatch: (options?: { continues?: number }) => Promise<void>;
  /** Lifts these inputs' holds, so they go again. */
  release: (inputs: readonly string[]) => void;
  /** These waiting inputs never go: removed. Others stay as they are. */
  remove: (inputs: readonly string[]) => void;
  /**
   * New words for a waiting input whose words the package keeps. False:
   * it isn't waiting any more, or the host keeps its words.
   */
  edit: (input: string, parts: readonly string[]) => boolean;
  /**
   * The agent's waiting inputs among `inputs`, in this order, in the places
   * they had between them; the others keep theirs.
   */
  reorder: (agent: string, inputs: readonly string[]) => void;
  /**
   * The waiting input goes in as a steer, its hold lifted: into the running
   * turn at once, or first when none runs.
   */
  steer: (input: string) => void;
  /** The sign-in is back: inputs held as signed out go again. */
  signedIn: () => void;
  /**
   * Stops the agent's turn: closed to new calls at once, then stopped by
   * the provider; the inputs waiting for it go on after. A start not yet
   * with the provider doesn't go: its input waits, held as stopped. With
   * children, every agent below it stops too, and what waits for any of
   * them is dropped (held as stopped); until they have stopped, what one
   * of them sends another, its done message too, is dropped the same way.
   */
  stop: (
    agent: string,
    by: string,
    options?: { children?: boolean },
  ) => Promise<void>;
  /**
   * Where a call of the agent's to the host's tools goes: its running turn,
   * with the call's id from its `_meta`. Nothing: no turn runs, a Stop
   * closed it, or the call has no id; the call is refused.
   */
  place: (agent: string, meta: unknown) => Placed | undefined;
  /**
   * Removes these agents, everything below them and all they kept, then
   * lets go of their conversations, each one even when another fails.
   * Again tries those that failed.
   */
  forget: (agents: readonly string[]) => Promise<void>;
  /**
   * Lets go of every open conversation. A turn still running is left as a
   * crash leaves it, for the restart to carry on.
   */
  close: () => Promise<void>;
}

/** An item's columns, as `Item`. */
const ITEM = `turns.provider_turn AS turn, turns.conversation, items.id, items.position, items.type, items.kind,
  items.title, items.detail, items.status, items.text,
  items.created_at AS createdAt, items.updated_at AS updatedAt`;

/** What a turn used, as kept, without the provider's own count. */
function usedOf(kept: string | null): KeptTurn["used"] {
  if (kept === null) return null;
  const { input, cached, output } = JSON.parse(kept) as NonNullable<
    KeptTurn["used"]
  >;
  return { input, cached, output };
}

/** An agent's conversation and turns while this process runs it. */
interface Live {
  id: string;
  /** The conversation number its events must name. */
  number: number;
  conversation?: Conversation;
  /** The provider its open conversation is on. */
  provider?: string;
  /** A start not yet admitted. */
  starting?: Starting;
  /** The turn running now, once admitted. */
  current?: { turn: string; ref: string };
  /**
   * Who asked to stop the current turn. It stays while a Stop is under
   * way, also past the turn's end.
   */
  stopBy?: string;
  /** Stops under way. */
  stops: number;
  /** Text, notes and reasoning as they stream, by turn and item, until whole. */
  streams: Map<
    string,
    {
      turn: string;
      item: string;
      type: "text" | "note" | "reasoning";
      text: string;
      /** When it began. */
      at: string;
    }
  >;
  /** The item of each turn's last text, its answer, by the provider's turn. */
  answers: Map<string, string>;
  /** Each running turn's items, by the provider's references: their places. */
  places: Map<string, Map<string, number>>;
  /** Its dispatcher runs; asked again meanwhile, it looks again. */
  pumping: boolean;
  asks: number;
}

/** A waiting input, as the queue keeps it. */
interface Waiting {
  id: string;
  kind: "steer" | "queue";
  sender: string;
  parts: string | null;
}

/**
 * The line before a steered input, so the agent adds it to its work; it
 * names the agent that steers, when one does.
 */
const steerLine = (by?: { title: string; id: string }) =>
  `You're being steered${by ? ` by ${by.title} (${by.id})` : ""}: don't drop what you're working on unless you have to; take this into account.`;

/** A start a Stop cut before it went: it waits, held. */
const STOPPED = { state: "held", held: "stopped", text: "Stopped." } as const;

/** What an agent a restart cut is told first, to carry on. */
const CONTINUE = "Rufi stopped suddenly (restart). Please continue.";

/** Where an input goes next. */
type Move =
  | { state: "delivered"; turn: string }
  /**
   * Back in line: in its place, or first. Next: it waits for the next turn,
   * also when it was a steer.
   */
  | { state: "waiting"; first?: true; next?: true }
  | { state: "held"; held: Hold; text: string }
  | { state: "removed" };

interface Starting {
  input: string;
  /** Its turn row, once written. */
  turn?: string;
  /** Who stopped it before it was admitted. */
  stopBy?: string;
  /** Settled once it is admitted, or didn't go. */
  settled: PromiseWithResolvers<void>;
}

interface AgentRow {
  id: string;
  parent_id: string | null;
  root_id: string;
  title: string;
  provider: string;
  model: string;
  effort: string;
  tools: string;
  cwd: string;
  provider_ref: string | null;
  conversation: number;
  admitted: number;
  status: AgentStatus;
  result: string | null;
  stopped_by: string | null;
  continues: number;
}

const toAgent = (row: AgentRow): Agent => ({
  id: row.id,
  parent: row.parent_id,
  root: row.root_id,
  title: row.title,
  provider: row.provider,
  model: row.model,
  effort: row.effort,
  tools: JSON.parse(row.tools) as string[],
  cwd: row.cwd,
  conversation: row.conversation,
  admitted: row.admitted === 1,
  status: row.status,
  result: row.result,
  stoppedBy: row.stopped_by,
});

const now = () => new Date().toISOString();

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * What an agent said when its turn ended, in its own words: its whole
 * answer and its questions with their options, in plain words, or why it
 * failed; nothing when it stopped.
 */
function saidAtEnd(
  end: TurnEnd,
  questions: readonly { title: string; options: readonly string[] }[],
): string {
  switch (end.status) {
    case "done":
      return [
        end.answer,
        ...questions.map((question) =>
          [
            question.title,
            ...question.options.map((option) => `- ${option}`),
          ].join("\n"),
        ),
      ]
        .filter((part) => part !== "")
        .join("\n\n");
    case "stopped":
      return "";
    case "failed":
      return end.text ?? end.reason;
  }
}

/**
 * What an agent's parent is told when its turn ends, in its done message:
 * its title and id, then what it said, or how it stopped or failed.
 */
function doneText(
  agent: Agent,
  end: TurnEnd,
  by: string | null,
  said: string,
  asked: boolean,
): string {
  const who = `${agent.title} (${agent.id})`;
  switch (end.status) {
    case "done":
      return [`${who} ${asked ? "asks" : "done"}:`, said]
        .filter((part) => part !== "")
        .join("\n\n");
    case "stopped":
      return `${who} stopped${by === null ? "" : ` (by ${by})`}.`;
    case "failed":
      return `${who} failed: ${said}.`;
  }
}

export function createAgents(options: {
  store: AgentStore;
  adapters: readonly ProviderAdapter[];
  host: Host;
  /** What the dispatcher couldn't put on an input, or a provider couldn't say. */
  onError: (error: unknown) => void;
  /**
   * Each event of an agent's open conversation (by its reference), as the
   * provider reports it, once the package has kept what it keeps of it,
   * with its item's place in its turn: for showing only. What happened is
   * in the package's events.
   */
  live?: (
    agent: string,
    conversation: string,
    event: ProviderEvent,
    position?: number,
  ) => void;
}): Agents {
  const { store, host } = options;
  const { db } = store;
  const adapters = new Map(options.adapters.map((a) => [a.id, a]));
  const lives = new Map<string, Live>();
  /** Agents a Stop with children is stopping now, and how many such Stops. */
  const trees = new Map<string, number>();
  /** Both stop together now: what one sends the other is dropped. */
  const together = (agent: string, sender: string) =>
    trees.has(agent) && trees.has(sender);
  /** Dispatch has begun: it settles what a crash left, once. */
  let begun = false;
  /** Inputs go to providers only once dispatch has settled that. */
  let dispatching = false;
  /** Conversations of agents no longer run here, until they have closed. */
  const closing = new Set<Conversation>();

  const row = (id: string) =>
    db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
      | AgentRow
      | undefined;
  const get = (id: string) => {
    const found = row(id);
    return found && toAgent(found);
  };
  const turnOf = (live: Live, ref: string) =>
    db
      .prepare(
        "SELECT id, status FROM turns WHERE agent_id = ? AND conversation = ? AND provider_turn = ?",
      )
      .get(live.id, live.number, ref) as
      | { id: string; status: string }
      | undefined;

  /**
   * The agent isn't run here any more: nothing of its live state goes on.
   * Its conversation is to close.
   */
  function revoke(id: string): void {
    const live = lives.get(id);
    if (!live) return;
    lives.delete(id);
    if (live.conversation) closing.add(live.conversation);
  }

  /** Closes every conversation still to close, each even when one fails. */
  async function letGo(): Promise<void> {
    const failed: unknown[] = [];
    for (const conversation of closing) {
      try {
        await conversation.close();
        closing.delete(conversation);
      } catch (error) {
        failed.push(error);
      }
    }
    if (failed.length > 0) {
      throw new AggregateError(failed, "Some conversations didn't close.");
    }
  }

  function liveOf(agent: Agent): Live {
    let live = lives.get(agent.id);
    if (!live) {
      live = {
        id: agent.id,
        number: agent.conversation,
        stops: 0,
        streams: new Map(),
        answers: new Map(),
        places: new Map(),
        pumping: false,
        asks: 0,
      };
      lives.set(agent.id, live);
    }
    return live;
  }

  /** The agent's conversation, opened now if it isn't. */
  async function conversationOf(
    live: Live,
    agent: Agent,
  ): Promise<Conversation> {
    if (live.conversation) {
      if (live.provider === agent.provider) return live.conversation;
      // Its provider changed: a new conversation, on the new one.
      closing.add(live.conversation);
      live.conversation = undefined;
      letGo().catch(options.onError);
    }
    const adapter = adapters.get(agent.provider);
    if (!adapter) throw new Error(`No provider ${agent.provider} to run on.`);
    const open = async (number: number, resume?: string) => {
      const opening = await host.opening(
        agent,
        resume === undefined ? "new" : "resume",
      );
      return adapter.open({
        ...opening,
        ...(resume !== undefined && { resume }),
        cwd: agent.cwd,
        model: agent.model,
        effort: agent.effort,
        onEvent: (event) => {
          ingest(live, number, event);
        },
      });
    };
    /** Keeps what opened only while the agent is still run here. */
    const keep = async (conversation: Conversation) => {
      if (lives.get(agent.id) !== live) {
        await conversation.close();
        throw new Error(`Agent ${agent.id} was forgotten.`);
      }
      return conversation;
    };
    const ref = row(agent.id)?.provider_ref;
    if (ref != null) {
      try {
        live.conversation = await keep(await open(agent.conversation, ref));
        live.provider = agent.provider;
        return live.conversation;
      } catch (error) {
        if (!(error instanceof Missing)) throw error;
      }
    }
    // A new conversation, under the next number: a number is never given
    // to two, even when an open is cut off.
    const number = store.change(({ event }) => {
      db.prepare(
        "UPDATE agents SET conversation = conversation + 1, provider_ref = NULL, updated_at = ? WHERE id = ?",
      ).run(now(), agent.id);
      const next = row(agent.id)?.conversation ?? 0;
      event("conversation.opening", agent.id, { conversation: next });
      return next;
    });
    live.number = number;
    const conversation = await keep(await open(number));
    try {
      await host.ledger({
        agent: agent.id,
        conversation: number,
        provider: agent.provider,
        ref: conversation.ref,
      });
    } catch (error) {
      await conversation.close();
      throw error;
    }
    await keep(conversation);
    store.change(({ event }) => {
      db.prepare(
        "UPDATE agents SET provider_ref = ?, updated_at = ? WHERE id = ?",
      ).run(conversation.ref, now(), agent.id);
      event("conversation.opened", agent.id, {
        conversation: number,
        ref: conversation.ref,
      });
    });
    live.conversation = conversation;
    live.provider = agent.provider;
    return conversation;
  }

  /**
   * What the provider reports for the conversation open now: kept as it
   * comes, then shown to the host.
   */
  function ingest(live: Live, number: number, event: ProviderEvent): void {
    if (lives.get(live.id) !== live || live.number !== number) return;
    keep(live, event);
    const ref = live.conversation?.ref;
    if (!options.live || ref === undefined) return;
    const position =
      "item" in event
        ? live.places.get(event.turn)?.get(event.item)
        : undefined;
    try {
      options.live(live.id, ref, event, position);
    } catch (error) {
      options.onError(error);
    }
  }

  function keep(live: Live, event: ProviderEvent): void {
    // An item's place is where its turn first reported it.
    if ("item" in event && turnOf(live, event.turn)) {
      const places = live.places.get(event.turn) ?? new Map<string, number>();
      if (!places.has(event.item)) places.set(event.item, places.size + 1);
      live.places.set(event.turn, places);
    }
    switch (event.type) {
      case "turnStarted":
        admitTurn(live, event.turn, event.inputs);
        return;
      case "text":
      case "note":
      case "thinking": {
        const key = `${event.turn}/${event.item}`;
        const stream = live.streams.get(key) ?? {
          turn: event.turn,
          item: event.item,
          type: event.type === "thinking" ? "reasoning" : event.type,
          text: "",
          at: now(),
        };
        stream.text += event.delta;
        live.streams.set(key, stream);
        if (event.type === "text") live.answers.set(event.turn, event.item);
        if (event.type !== "thinking" && event.done) {
          live.streams.delete(key);
          saveItem(live, event.turn, event.item, {
            type: stream.type,
            text: stream.text,
            status: "done",
          });
        }
        return;
      }
      // Apart from the item it came with, which it never changes.
      case "question": {
        const turn = turnOf(live, event.turn);
        if (!turn) return;
        store.change(({ event: record }) => {
          db.prepare(
            `INSERT INTO questions (turn_id, item_id, number, title, options, created_at)
             VALUES (?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM questions WHERE turn_id = ? AND item_id = ?), ?, ?, ?)`,
          ).run(
            turn.id,
            event.item,
            turn.id,
            event.item,
            event.title,
            JSON.stringify(event.options),
            now(),
          );
          record("question.saved", live.id, {
            turn: turn.id,
            item: event.item,
          });
        });
        return;
      }
      // Whole: it replaces what streamed.
      case "reasoning":
        live.streams.delete(`${event.turn}/${event.item}`);
        saveItem(live, event.turn, event.item, {
          type: "reasoning",
          text: event.summary,
          status: "done",
          payload: event.payload,
        });
        return;
      case "step":
        saveItem(live, event.turn, event.item, {
          type: "step",
          kind: event.kind,
          title: event.title,
          detail: event.detail,
          status: event.status,
          payload: event.payload,
        });
        return;
      case "usage": {
        const turn = turnOf(live, event.turn);
        if (!turn) return;
        store.change(({ event: record }) => {
          db.prepare("UPDATE turns SET usage = ? WHERE id = ?").run(
            JSON.stringify({ tokens: event.tokens, window: event.window }),
            turn.id,
          );
          record("turn.usage", live.id, { turn: turn.id });
        });
        return;
      }
      case "turnUsage": {
        const turn = turnOf(live, event.turn);
        if (!turn) return;
        const { input, cached, output, payload } = event;
        store.change(({ event: record }) => {
          db.prepare("UPDATE turns SET used = ? WHERE id = ?").run(
            JSON.stringify({ input, cached, output, reported: payload }),
            turn.id,
          );
          record("turn.usage", live.id, { turn: turn.id });
        });
        return;
      }
      case "turnEnded":
        endTurn(live, event.turn, event.end);
        return;
    }
  }

  /**
   * A turn started: the package's own start, or one the provider began by
   * itself with steers it was handed. Admitted once, in one transaction:
   * its row, its inputs in it, and the agent running.
   */
  function admitTurn(live: Live, ref: string, inputs: readonly string[]): void {
    if (turnOf(live, ref)) return;
    const starting =
      live.starting && inputs.includes(live.starting.input)
        ? live.starting
        : undefined;
    // A turn begun while a Stop is under way is closed from the start.
    const stopBy = starting?.stopBy ?? live.stopBy;
    const closed = stopBy !== undefined;
    const turn = store.change(({ event }) => {
      const at = now();
      let id = starting?.turn;
      if (id === undefined) {
        id = randomUUID();
        const agent = row(live.id);
        if (!agent) throw new Error(`No agent ${live.id}.`);
        db.prepare(
          "INSERT INTO turns (id, agent_id, conversation, provider_turn, model, effort, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          live.id,
          live.number,
          ref,
          agent.model,
          agent.effort,
          closed ? "stopping" : "running",
          at,
        );
      } else {
        db.prepare(
          "UPDATE turns SET provider_turn = ?, status = ? WHERE id = ?",
        ).run(ref, closed ? "stopping" : "running", id);
      }
      db.prepare(
        "UPDATE queue SET state = 'delivered', turn_id = ?, updated_at = ? WHERE agent_id = ? AND state IN ('handing_over', 'delivered') AND id IN (SELECT value FROM json_each(?))",
      ).run(id, at, live.id, JSON.stringify(inputs));
      db.prepare(
        "UPDATE agents SET status = 'running', stopped_by = NULL, updated_at = ? WHERE id = ?",
      ).run(at, live.id);
      const messages = messagesIn(inputs);
      event("turn.started", live.id, {
        turn: id,
        ref,
        inputs,
        by: starting ? "package" : "provider",
        ...(messages.length > 0 && { messages }),
      });
      return id;
    });
    live.current = { turn, ref };
    if (starting) {
      live.stopBy = stopBy;
      live.starting = undefined;
      starting.settled.resolve();
    }
    pump(live.id);
  }

  function saveItem(
    live: Live,
    ref: string,
    item: string,
    fields: {
      type: "text" | "note" | "reasoning" | "step";
      kind?: string;
      title?: string;
      detail?: string;
      status?: string;
      text?: string;
      payload?: unknown;
    },
  ): void {
    const turn = turnOf(live, ref);
    if (!turn) return;
    const position = live.places.get(ref)?.get(item);
    store.change(({ event }) => {
      const at = now();
      db.prepare(
        `INSERT INTO items (turn_id, id, position, type, kind, title, detail, status, text, payload, created_at, updated_at)
         VALUES (?, ?, COALESCE(?, (SELECT COALESCE(MAX(position), 0) + 1 FROM items WHERE turn_id = ?)), ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (turn_id, id) DO UPDATE SET kind = excluded.kind, title = excluded.title, detail = excluded.detail,
           status = excluded.status, text = excluded.text, payload = excluded.payload, updated_at = excluded.updated_at`,
      ).run(
        turn.id,
        item,
        position ?? null,
        turn.id,
        fields.type,
        fields.kind ?? null,
        fields.title ?? null,
        fields.detail ?? null,
        fields.status ?? null,
        fields.text ?? null,
        fields.payload === undefined ? null : JSON.stringify(fields.payload),
        at,
        at,
      );
      event("item.saved", live.id, { turn: turn.id, item, type: fields.type });
    });
  }

  /** A turn ended, as the provider said: the turn's end, and the agent's status. */
  /**
   * A turn ended. One a restart cut (`restarts`: how many in a row it may
   * carry on after) carries on: a continue goes first, and its parent hears
   * nothing yet. At the cap it stops, and what waits for it is held.
   */
  function endTurn(
    live: Live,
    ref: string,
    end: TurnEnd,
    restarts?: number,
  ): void {
    const answer = live.answers.get(ref);
    live.answers.delete(ref);
    const turn = turnOf(live, ref);
    if (!turn || !["running", "stopping"].includes(turn.status)) return;
    // What streamed without being whole is kept as far as it came.
    for (const [key, stream] of live.streams) {
      if (stream.turn !== ref) continue;
      live.streams.delete(key);
      saveItem(live, ref, stream.item, {
        type: stream.type,
        text: stream.text,
      });
    }
    live.places.delete(ref);
    const stopBy =
      end.status === "stopped" ? (live.stopBy ?? "provider") : null;
    const agent = get(live.id);
    const parent = agent?.parent ?? null;
    const continues = row(live.id)?.continues ?? 0;
    const continuing = restarts !== undefined && continues < restarts;
    store.change(({ event }) => {
      const at = now();
      db.prepare(
        "UPDATE turns SET status = ?, reason = ?, result = ?, ended_at = ? WHERE id = ?",
      ).run(
        end.status,
        end.status === "failed" ? end.reason : stopBy,
        end.status === "done"
          ? end.answer
          : end.status === "failed"
            ? (end.text ?? null)
            : null,
        at,
        turn.id,
      );
      // A done turn starts the count of restarts in a row again.
      db.prepare(
        "UPDATE agents SET status = ?, result = ?, stopped_by = ?, continues = ?, updated_at = ? WHERE id = ?",
      ).run(
        continuing ? "continuing" : end.status,
        end.status === "done"
          ? end.answer
          : end.status === "failed"
            ? (end.text ?? end.reason)
            : null,
        continuing ? null : stopBy,
        end.status === "done" ? 0 : continuing ? continues + 1 : continues,
        at,
        live.id,
      );
      // A whole answer names the item it streamed as, when it did.
      const item = end.status === "done" ? answer : undefined;
      event("turn.ended", live.id, { turn: turn.id, ref, ...end, item });
      if (continuing) {
        // Rufi's line, first: a restart finds it there and adds no other.
        const input = `continue:${turn.id}`;
        db.prepare(
          `INSERT INTO queue (id, agent_id, sender, kind, parts, position, created_at, updated_at)
           VALUES (?, ?, 'rufi', 'queue', ?, (SELECT COALESCE(MIN(position), 1) - 1 FROM queue WHERE agent_id = ?), ?, ?)`,
        ).run(input, live.id, JSON.stringify([CONTINUE]), live.id, at, at);
        event("input.added", live.id, { input, kind: "queue" });
        return;
      }
      // At the cap, nothing starts it by itself: what waits is held.
      if (restarts !== undefined && restarts > 0) {
        const text = `Stopped after ${String(restarts)} restarts in a row.`;
        const held = db
          .prepare(
            "SELECT id FROM queue WHERE agent_id = ? AND state = 'waiting' AND held IS NULL ORDER BY position",
          )
          .all(live.id) as { id: string }[];
        for (const { id } of held) {
          db.prepare(
            "UPDATE queue SET held = 'restarts', held_text = ?, updated_at = ? WHERE id = ?",
          ).run(text, at, id);
          event("input.held", live.id, { input: id, held: "restarts", text });
        }
      }
      // Its parent hears how it went: a steer from it, until it takes it.
      if (agent && parent !== null) {
        const questions = (
          db
            .prepare(
              "SELECT title, options FROM questions WHERE turn_id = ? ORDER BY rowid",
            )
            .all(turn.id) as { title: string; options: string }[]
        ).map((question) => ({
          title: question.title,
          options: JSON.parse(question.options) as string[],
        }));
        const about: About =
          end.status === "done"
            ? questions.length > 0
              ? "asked"
              : "done"
            : end.status;
        const input = `done:${turn.id}`;
        const said = saidAtEnd(end, questions);
        // Inside a tree that stops, it is kept but wakes nobody.
        const dropped = together(parent, live.id);
        db.prepare(
          `INSERT INTO queue (id, agent_id, sender, kind, parts, about, said, state, held, held_text, position, created_at, updated_at)
           VALUES (?, ?, ?, 'steer', ?, ?, ?, 'waiting', ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM queue WHERE agent_id = ?), ?, ?)`,
        ).run(
          input,
          parent,
          live.id,
          JSON.stringify([
            doneText(agent, end, stopBy, said, questions.length > 0),
          ]),
          about,
          said,
          dropped ? STOPPED.held : null,
          dropped ? STOPPED.text : null,
          parent,
          at,
          at,
        );
        event("input.added", parent, { input, kind: "steer", about });
        if (dropped) {
          event("input.held", parent, {
            input,
            held: STOPPED.held,
            text: STOPPED.text,
          });
        }
      }
    });
    if (parent !== null) pump(parent);
    if (live.current?.ref === ref) {
      live.current = undefined;
      if (live.stops === 0) live.stopBy = undefined;
    }
    pump(live.id);
  }

  /** An input of the agent's is with the provider, its answer not back yet. */
  const handingOver = (agent: string) =>
    db
      .prepare(
        "SELECT 1 FROM queue WHERE agent_id = ? AND state = 'handing_over' LIMIT 1",
      )
      .get(agent) !== undefined;

  /**
   * The provider no longer has the agent's conversation: it is let go of,
   * and the next turn opens a new one.
   */
  function lose(live: Live, conversation: Conversation): void {
    if (live.conversation !== conversation) return;
    live.conversation = undefined;
    closing.add(conversation);
    store.change(({ event }) => {
      db.prepare(
        "UPDATE agents SET provider_ref = NULL, updated_at = ? WHERE id = ? AND provider_ref = ?",
      ).run(now(), live.id, conversation.ref);
      event("conversation.lost", live.id, { conversation: live.number });
    });
    letGo().catch(options.onError);
  }

  /** Closes a turn to new calls: its stop is under way. */
  function closeTurn(live: Live, turn: string): void {
    store.change(({ event }) => {
      db.prepare(
        "UPDATE turns SET status = 'stopping' WHERE id = ? AND status IN ('starting', 'running')",
      ).run(turn);
      event("turn.stopping", live.id, { turn });
    });
  }

  const waitingOf = (agent: string) =>
    db
      .prepare(
        "SELECT id, kind, sender, parts FROM queue WHERE agent_id = ? AND state = 'waiting' AND held IS NULL ORDER BY position",
      )
      .all(agent) as unknown as Waiting[];
  /** The messages from other agents among some inputs, in their order. */
  const messagesIn = (inputs: readonly string[]): AgentMessage[] =>
    (
      db
        .prepare(
          "SELECT queue.id AS input, queue.sender AS agent, agents.title, queue.about, queue.said FROM queue JOIN agents ON agents.id = queue.sender WHERE queue.id IN (SELECT value FROM json_each(?)) AND queue.about IS NOT NULL",
        )
        .all(JSON.stringify(inputs)) as unknown as (Omit<
        AgentMessage,
        "said"
      > & { said: string | null })[]
    )
      .map(({ said, ...message }) => ({ ...message, said: said ?? "" }))
      .sort((a, b) => inputs.indexOf(a.input) - inputs.indexOf(b.input));
  const stateOf = (input: string) =>
    (
      db.prepare("SELECT state FROM queue WHERE id = ?").get(input) as
        | { state: string }
        | undefined
    )?.state;

  /**
   * Moves an input on from the state it is in, with its event, and drops
   * the start it was handed over for, if one; else does nothing.
   */
  function move(
    live: Live,
    input: string,
    from: "waiting" | "handing_over",
    to: Move,
    start?: string,
  ): void {
    if (stateOf(input) !== from) return;
    store.change(({ event }) => {
      const at = now();
      switch (to.state) {
        case "delivered":
          db.prepare(
            "UPDATE queue SET state = 'delivered', turn_id = ?, updated_at = ? WHERE id = ?",
          ).run(to.turn, at, input);
          break;
        case "waiting":
          db.prepare(
            `UPDATE queue SET state = 'waiting', conversation = NULL, turn_id = NULL, updated_at = ?,
               kind = CASE WHEN ? THEN 'queue' ELSE kind END,
               position = CASE WHEN ? THEN (SELECT COALESCE(MIN(position), 1) - 1 FROM queue WHERE agent_id = ? AND state = 'waiting') ELSE position END
             WHERE id = ?`,
          ).run(at, to.next ? 1 : 0, to.first ? 1 : 0, live.id, input);
          break;
        case "held":
          db.prepare(
            "UPDATE queue SET state = 'waiting', held = ?, held_text = ?, conversation = NULL, turn_id = NULL, updated_at = ? WHERE id = ?",
          ).run(to.held, to.text, at, input);
          break;
        case "removed":
          db.prepare(
            "UPDATE queue SET state = 'removed', turn_id = NULL, updated_at = ? WHERE id = ?",
          ).run(at, input);
      }
      if (start !== undefined) {
        db.prepare(
          "DELETE FROM turns WHERE id = ? AND status = 'starting'",
        ).run(start);
      }
      const { state, ...rest } = to;
      // Delivered names its turn by the provider's reference too, and
      // another agent's message by what it is.
      const ref =
        to.state === "delivered"
          ? (
              db
                .prepare("SELECT provider_turn AS ref FROM turns WHERE id = ?")
                .get(to.turn) as { ref: string | null } | undefined
            )?.ref
          : undefined;
      const [message] = to.state === "delivered" ? messagesIn([input]) : [];
      event(`input.${state}`, live.id, {
        input,
        ...rest,
        ref,
        ...(message && { message }),
      });
    });
  }

  /**
   * Runs the agent's dispatcher, one at a time for each agent: asked again
   * while it runs, it looks again once it's done.
   */
  function pump(id: string): void {
    if (!dispatching) return;
    const agent = get(id);
    if (!agent?.admitted) return;
    const live = liveOf(agent);
    live.asks += 1;
    if (live.pumping) return;
    live.pumping = true;
    const run = async () => {
      try {
        let seen;
        do {
          seen = live.asks;
          await next(live);
        } while (seen !== live.asks && lives.get(id) === live);
      } finally {
        live.pumping = false;
      }
    };
    run().catch(options.onError);
  }

  /** Hands over what the agent can take now, as the delivery table says. */
  async function next(live: Live): Promise<void> {
    const agent = get(live.id);
    if (!agent?.admitted || lives.get(live.id) !== live) return;
    // Starting: steers go in once it is admitted.
    if (live.starting) return;
    // Stopping: what waits goes on once the Stop has finished.
    if (live.stops > 0) return;
    const { current } = live;
    if (current) {
      // Running: steers go in at once, in order; queued inputs wait.
      for (const input of waitingOf(live.id)) {
        if (live.current !== current || live.stopBy !== undefined) return;
        if (input.kind === "steer") await steerWith(live, input);
      }
      return;
    }
    const first = waitingOf(live.id)[0];
    if (first) await startWith(live, agent, first);
  }

  /**
   * Marks the input handing over to the agent's conversation, for `turn`:
   * from here a crash counts it as sent. A start's turn row is written with
   * it.
   */
  function handOver(
    live: Live,
    input: Waiting,
    turn: string,
    start?: Agent,
  ): void {
    store.change(({ event }) => {
      const at = now();
      if (start) {
        db.prepare(
          "INSERT INTO turns (id, agent_id, conversation, model, effort, status, started_at) VALUES (?, ?, ?, ?, ?, 'starting', ?)",
        ).run(turn, live.id, live.number, start.model, start.effort, at);
      }
      db.prepare(
        "UPDATE queue SET state = 'handing_over', conversation = ?, turn_id = ?, updated_at = ? WHERE id = ?",
      ).run(live.number, turn, at, input.id);
      event("input.handing_over", live.id, {
        input: input.id,
        conversation: live.number,
      });
    });
  }

  /**
   * The words of an input handing over: its own, or the host's claim.
   * Nothing: it doesn't go now, and it has moved on (with the start it was
   * handed over for, if one).
   */
  async function claimed(
    live: Live,
    input: Waiting,
    start?: string,
  ): Promise<readonly string[] | undefined> {
    if (input.parts !== null) return JSON.parse(input.parts) as string[];
    let answer: Claim | undefined;
    try {
      answer = await host.claim({
        agent: live.id,
        conversation: live.number,
        input: input.id,
      });
    } catch (error) {
      move(
        live,
        input.id,
        "handing_over",
        { state: "held", held: "failed", text: message(error) },
        start,
      );
      live.asks += 1;
      return undefined;
    }
    if (answer?.status === "claimed") return answer.parts;
    // Gone: removed or sent meanwhile. Nothing: the host is closing.
    move(
      live,
      input.id,
      "handing_over",
      answer?.status === "gone" ? { state: "removed" } : { state: "waiting" },
      start,
    );
    live.asks += 1;
    return undefined;
  }

  /** Starts a turn with the first waiting input. */
  async function startWith(
    live: Live,
    agent: Agent,
    input: Waiting,
  ): Promise<void> {
    const starting: Starting = {
      input: input.id,
      settled: Promise.withResolvers(),
    };
    live.starting = starting;
    // Delivered: it waits for the provider to say the turn started.
    let pending = false;
    try {
      let conversation: Conversation;
      try {
        conversation = await conversationOf(live, agent);
      } catch (error) {
        if (lives.get(live.id) !== live) return;
        move(live, input.id, "waiting", {
          state: "held",
          held:
            error instanceof NotOpened
              ? error.reason === "signed_out"
                ? "signed_out"
                : "open_failed"
              : "failed",
          text: message(error),
        });
        return;
      }
      const stopped = () =>
        starting.stopBy !== undefined || lives.get(live.id) !== live;
      if (stopped()) {
        move(live, input.id, "waiting", STOPPED);
        return;
      }
      const turn = randomUUID();
      handOver(live, input, turn, agent);
      starting.turn = turn;
      const parts = await claimed(live, input, turn);
      if (!parts) return;
      if (stopped()) {
        move(live, input.id, "handing_over", STOPPED, turn);
        return;
      }
      let delivery: Delivery;
      try {
        delivery = await conversation.startTurn({
          input: { id: input.id, parts },
          model: agent.model,
          effort: agent.effort,
        });
      } catch (error) {
        // It may have gone: it counts as sent, and its turn failed, as if
        // the provider had said so. A turn it started meanwhile runs on.
        if (stateOf(input.id) === "handing_over") {
          ingest(live, live.number, {
            type: "turnStarted",
            turn,
            inputs: [input.id],
          });
          ingest(live, live.number, {
            type: "turnEnded",
            turn,
            end: { status: "failed", reason: "other", text: message(error) },
          });
        }
        return;
      }
      if (delivery.status === "delivered") {
        pending = true;
        return;
      }
      // Its conversation is gone: the input goes first, in a new one.
      if (delivery.reason === "missing") {
        lose(live, conversation);
        move(
          live,
          input.id,
          "handing_over",
          { state: "waiting", first: true },
          turn,
        );
        live.asks += 1;
        return;
      }
      move(
        live,
        input.id,
        "handing_over",
        {
          state: "held",
          held: delivery.reason === "signed_out" ? "signed_out" : "failed",
          text: delivery.text,
        },
        turn,
      );
      // A refused input doesn't keep the rest waiting.
      if (delivery.reason === undefined) live.asks += 1;
    } finally {
      if (!pending && live.starting === starting) {
        live.starting = undefined;
        starting.settled.resolve();
      }
    }
  }

  /**
   * Steers a waiting input into the running turn; later steers go in
   * meanwhile, in order. One the provider didn't take, as its turn had
   * ended, starts the next turn.
   */
  async function steerWith(live: Live, input: Waiting): Promise<void> {
    const { current, conversation } = live;
    if (!current || !conversation) return;
    handOver(live, input, current.turn);
    const parts = await claimed(live, input);
    if (!parts || lives.get(live.id) !== live) return;
    // Back first in line; dropped when the agent stops with others.
    const missed = (): Move =>
      trees.has(live.id)
        ? STOPPED
        : { state: "waiting", first: true, next: true };
    if (live.current !== current || live.stopBy !== undefined) {
      move(live, input.id, "handing_over", missed());
      live.asks += 1;
      return;
    }
    const sender = get(input.sender);
    conversation
      .steer({
        input: {
          id: input.id,
          parts: [
            steerLine(sender && { title: sender.title, id: sender.id }),
            ...parts,
          ],
        },
        turn: current.ref,
      })
      .then(
        (outcome: SteerOutcome): Move =>
          outcome.status === "delivered"
            ? { state: "delivered", turn: current.turn }
            : missed(),
        // It may have gone: it counts as sent.
        (): Move => ({ state: "delivered", turn: current.turn }),
      )
      .then((to) => {
        if (lives.get(live.id) !== live) return;
        move(live, input.id, "handing_over", to);
        pump(live.id);
      })
      .catch(options.onError);
  }

  /**
   * Stops one agent's turn: closed to new calls at once, then stopped by
   * the provider; a start not yet with the provider doesn't go.
   */
  async function stopOne(id: string, by: string): Promise<void> {
    const live = lives.get(id);
    if (!live) return;
    try {
      const starting = live.starting;
      if (starting) {
        starting.stopBy ??= by;
        if (starting.turn !== undefined) closeTurn(live, starting.turn);
        await starting.settled.promise;
      }
      const { current, conversation } = live;
      if (!conversation || !current) return;
      if (live.stopBy === undefined) {
        live.stopBy = by;
        closeTurn(live, current.turn);
      }
      const { ref } = current;
      live.stops += 1;
      try {
        await conversation.stop(ref);
        // A turn the provider began meanwhile with a steer was closed
        // when admitted, and is stopped too.
        const started = live.current;
        if (started && started.ref !== ref) {
          await conversation.stop(started.ref);
        }
      } finally {
        live.stops -= 1;
        if (live.stops === 0 && !live.current) live.stopBy = undefined;
      }
    } finally {
      // What waits for the agent goes on.
      pump(id);
    }
  }

  /** Lifts these inputs' holds, and their agents look again. */
  function lift(inputs: readonly { id: string; agent: string }[]): void {
    if (inputs.length === 0) return;
    store.change(({ event }) => {
      for (const { id, agent } of inputs) {
        db.prepare(
          "UPDATE queue SET held = NULL, held_text = NULL, updated_at = ? WHERE id = ?",
        ).run(now(), id);
        event("input.released", agent, { input: id });
      }
    });
    for (const agent of new Set(inputs.map((input) => input.agent))) {
      pump(agent);
    }
  }

  const api: Agents = {
    create: (agent) => {
      store.change(({ event }) => {
        let root = agent.id;
        if (agent.parent !== undefined) {
          const parent = get(agent.parent);
          if (!parent) throw new Error(`No agent ${agent.parent}.`);
          if (!agent.tools.every((tool) => parent.tools.includes(tool))) {
            throw new Error("A child's tools are among its parent's.");
          }
          root = parent.root;
        }
        const at = now();
        db.prepare(
          "INSERT INTO agents (id, parent_id, root_id, title, provider, model, effort, tools, cwd, provider_ref, conversation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          agent.id,
          agent.parent ?? null,
          root,
          agent.title,
          agent.provider,
          agent.model,
          agent.effort,
          JSON.stringify(agent.tools),
          agent.cwd,
          agent.adopt ?? null,
          agent.adopt === undefined ? 0 : 1,
          at,
          at,
        );
        event("agent.created", agent.id, {
          parent: agent.parent ?? null,
          title: agent.title,
        });
      });
      const made = get(agent.id);
      if (!made) throw new Error(`No agent ${agent.id}.`);
      return made;
    },

    admit: (id) => {
      const agent = get(id);
      if (!agent) throw new Error(`No agent ${id}.`);
      if (agent.admitted) return;
      store.change(({ event }) => {
        db.prepare(
          "UPDATE agents SET admitted = 1, updated_at = ? WHERE id = ?",
        ).run(now(), id);
        event("agent.admitted", id, {});
      });
      pump(id);
    },

    get,

    list: () =>
      (db.prepare("SELECT id FROM agents").all() as { id: string }[]).map(
        ({ id }) => id,
      ),

    input: (id) =>
      db
        .prepare(
          "SELECT agent_id AS agent, state, held, sender, about FROM queue WHERE id = ?",
        )
        .get(id) as
        | {
            agent: string;
            state: string;
            held: Hold | null;
            sender: string;
            about: About | null;
          }
        | undefined,

    messages: messagesIn,

    waiting: (agent) =>
      (
        db
          .prepare(
            "SELECT id, sender, kind, parts, about, held, held_text FROM queue WHERE agent_id = ? AND state = 'waiting' ORDER BY position",
          )
          .all(agent) as {
          id: string;
          sender: string;
          kind: "steer" | "queue";
          parts: string | null;
          about: About | null;
          held: Hold | null;
          held_text: string | null;
        }[]
      ).map(({ parts, held_text: heldText, ...input }) => ({
        ...input,
        parts: parts === null ? null : (JSON.parse(parts) as string[]),
        heldText,
      })),

    current: (id) => {
      const live = lives.get(id);
      if (live?.starting) {
        return { status: "starting", input: live.starting.input };
      }
      if (!live?.current) return undefined;
      return {
        status: live.stopBy === undefined ? "running" : "stopping",
        ...live.current,
      };
    },

    below: (id) =>
      (
        db
          .prepare(
            `WITH RECURSIVE tree (id) AS (
               SELECT id FROM agents WHERE parent_id = ?
               UNION ALL SELECT agents.id FROM agents JOIN tree ON agents.parent_id = tree.id
             ) SELECT agents.id FROM agents JOIN tree ON tree.id = agents.id ORDER BY agents.rowid`,
          )
          .all(id) as { id: string }[]
      ).map((row) => row.id),

    history: (agent, { before, limit }) => {
      const found = db
        .prepare(
          `SELECT id, provider_turn AS ref, status, reason, result, used,
             started_at AS startedAt, ended_at AS endedAt
           FROM turns WHERE agent_id = ?
             AND (? IS NULL OR rowid < (SELECT rowid FROM turns WHERE id = ? AND agent_id = ?))
           ORDER BY rowid DESC LIMIT ?`,
        )
        .all(
          agent,
          before ?? null,
          before ?? null,
          agent,
          limit + 1,
        ) as unknown as (Omit<KeptTurn, "inputs" | "items" | "used"> & {
        used: string | null;
      })[];
      const page = found.slice(0, limit).toReversed();
      const refs = page.flatMap((turn) =>
        turn.ref === null ? [] : [turn.ref],
      );
      const items = Map.groupBy(
        refs.length === 0 ? [] : api.items(agent, refs),
        (item) => item.turn,
      );
      const inputs = db.prepare(
        "SELECT id, sender, parts, updated_at AS at FROM queue WHERE turn_id = ? ORDER BY position",
      );
      const questions = db.prepare(
        "SELECT item_id AS item, number, title, options, created_at AS at FROM questions WHERE turn_id = ? ORDER BY rowid",
      );
      return {
        turns: page.map((turn) => ({
          ...turn,
          used: usedOf(turn.used),
          inputs: (
            inputs.all(turn.id) as {
              id: string;
              sender: string;
              parts: string | null;
              at: string;
            }[]
          ).map((input) => ({
            ...input,
            parts:
              input.parts === null
                ? null
                : (JSON.parse(input.parts) as string[]),
          })),
          items: turn.ref === null ? [] : (items.get(turn.ref) ?? []),
          questions: (
            questions.all(turn.id) as {
              item: string;
              number: number;
              title: string;
              options: string;
              at: string;
            }[]
          ).map((question) => ({
            ...question,
            options: JSON.parse(question.options) as string[],
          })),
        })),
        earlier: found.length > limit ? (page[0]?.id ?? null) : null,
      };
    },

    items: (agent, turns) => {
      if (turns.length === 0) return [];
      const saved = db
        .prepare(
          `SELECT ${ITEM} FROM items JOIN turns ON turns.id = items.turn_id
           WHERE turns.agent_id = ? AND turns.provider_turn IN (SELECT value FROM json_each(?))
           ORDER BY turns.started_at, turns.rowid, items.position`,
        )
        .all(agent, JSON.stringify(turns)) as unknown as Item[];
      // The running turn, the last to start, streams what isn't saved yet.
      const live = lives.get(agent);
      const running = live?.current?.ref;
      if (!live || running === undefined || !turns.includes(running)) {
        return saved;
      }
      const streaming = [...live.streams.values()].flatMap((stream) => {
        const position = live.places.get(running)?.get(stream.item);
        if (stream.turn !== running || position === undefined) return [];
        return [
          {
            turn: running,
            conversation: live.number,
            id: stream.item,
            position,
            type: stream.type,
            kind: null,
            title: null,
            detail: null,
            status: null,
            text: stream.text,
            createdAt: stream.at,
            updatedAt: now(),
          } satisfies Item,
        ];
      });
      const last = (item: Item) => Number(item.turn === running);
      return [...saved, ...streaming].toSorted((a, b) =>
        last(a) && last(b) ? a.position - b.position : last(a) - last(b),
      );
    },

    known: (agent, turns) =>
      turns.length === 0
        ? []
        : (
            db
              .prepare(
                "SELECT provider_turn AS ref FROM turns WHERE agent_id = ? AND provider_turn IN (SELECT value FROM json_each(?))",
              )
              .all(agent, JSON.stringify(turns)) as { ref: string }[]
          ).map((turn) => turn.ref),

    item: (agent, turn, id) => {
      const found = db
        .prepare(
          `SELECT ${ITEM}, items.payload FROM items JOIN turns ON turns.id = items.turn_id
           WHERE turns.agent_id = ? AND turns.provider_turn = ? AND items.id = ?`,
        )
        .get(agent, turn, id) as
        | (Item & { payload: string | null })
        | undefined;
      return (
        found && {
          ...found,
          payload:
            found.payload === null
              ? null
              : (JSON.parse(found.payload) as unknown),
        }
      );
    },

    open: async (id) => {
      const agent = get(id);
      if (!agent?.admitted) throw new Error(`Agent ${id} isn't admitted.`);
      return (await conversationOf(liveOf(agent), agent)).ref;
    },

    reopen: async (id, fresh = false) => {
      if (!row(id)) throw new Error(`No agent ${id}.`);
      const live = lives.get(id);
      if (live?.starting || live?.current || handingOver(id)) {
        throw new Error(`Agent ${id}'s conversation is in use.`);
      }
      if (fresh && row(id)?.provider_ref != null) {
        store.change(({ event }) => {
          db.prepare(
            "UPDATE agents SET provider_ref = NULL, updated_at = ? WHERE id = ?",
          ).run(now(), id);
          event("conversation.left", id, {});
        });
      }
      if (live?.conversation) {
        closing.add(live.conversation);
        live.conversation = undefined;
        await letGo();
      }
    },

    configure: (id, { provider, model, effort, tools }) => {
      const agent = get(id);
      if (!agent) throw new Error(`No agent ${id}.`);
      if (tools !== undefined && agent.parent !== null) {
        throw new Error("A child's tools are set when it starts.");
      }
      const moved = provider !== undefined && provider !== agent.provider;
      if (moved && !adapters.has(provider)) {
        throw new Error(`No provider ${provider} to run on.`);
      }
      const retooled =
        tools !== undefined &&
        JSON.stringify(tools) !== JSON.stringify(agent.tools);
      if (
        !moved &&
        agent.model === model &&
        agent.effort === effort &&
        !retooled
      ) {
        return;
      }
      // On another provider, its conversation there is new: the one it
      // had isn't resumed, and a turn running in it goes on.
      store.change(({ event }) => {
        db.prepare(
          `UPDATE agents SET provider = ?, model = ?, effort = ?, tools = ?, updated_at = ?,
             provider_ref = CASE WHEN ? THEN NULL ELSE provider_ref END
           WHERE id = ?`,
        ).run(
          moved ? provider : agent.provider,
          model,
          effort,
          JSON.stringify(retooled ? tools : agent.tools),
          now(),
          moved ? 1 : 0,
          id,
        );
        event("agent.configured", id, {
          ...(moved && { provider }),
          model,
          effort,
          ...(retooled && { tools }),
        });
      });
    },

    send: (id, input) => {
      const kept = row(id);
      if (!kept) throw new Error(`No agent ${id}.`);
      if (stateOf(input.id) !== undefined) return;
      const dropped = together(id, input.sender);
      // The person, or its parent, writing to it lifts a hold at the cap.
      const lifts = input.person === true || input.sender === kept.parent_id;
      store.change(({ event }) => {
        const at = now();
        if (input.person) {
          db.prepare(
            "UPDATE agents SET continues = 0, updated_at = ? WHERE id = ?",
          ).run(at, id);
        }
        if (lifts) {
          const held = db
            .prepare(
              "SELECT id FROM queue WHERE agent_id = ? AND state = 'waiting' AND held = 'restarts'",
            )
            .all(id) as { id: string }[];
          for (const { id: lifted } of held) {
            db.prepare(
              "UPDATE queue SET held = NULL, held_text = NULL, updated_at = ? WHERE id = ?",
            ).run(at, lifted);
            event("input.released", id, { input: lifted });
          }
        }
        db.prepare(
          `INSERT INTO queue (id, agent_id, sender, kind, parts, about, said, held, held_text, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM queue WHERE agent_id = ?), ?, ?)`,
        ).run(
          input.id,
          id,
          input.sender,
          input.kind,
          input.parts === undefined ? null : JSON.stringify(input.parts),
          input.about ?? null,
          input.said ?? null,
          dropped ? STOPPED.held : null,
          dropped ? STOPPED.text : null,
          id,
          at,
          at,
        );
        event("input.added", id, {
          input: input.id,
          kind: input.kind,
          ...(input.about && { about: input.about }),
        });
        if (dropped) {
          event("input.held", id, {
            input: input.id,
            held: STOPPED.held,
            text: STOPPED.text,
          });
        }
      });
      pump(id);
    },

    dispatch: ({ continues = 0 } = {}) => {
      // Once: a start this process made is never taken for a crash's.
      if (begun) return Promise.resolve();
      begun = true;
      // What a crash left handed over counts as sent: a steer in the turn
      // it went to, a start in its turn, stopped by the restart.
      const left = db
        .prepare(
          "SELECT queue.id, queue.agent_id AS agent, queue.turn_id AS turn, turns.status FROM queue JOIN turns ON turns.id = queue.turn_id WHERE queue.state = 'handing_over' ORDER BY queue.position",
        )
        .all() as { id: string; agent: string; turn: string; status: string }[];
      for (const input of left) {
        const agent = get(input.agent);
        if (!agent) continue;
        const live = liveOf(agent);
        if (input.status !== "starting") {
          move(live, input.id, "handing_over", {
            state: "delivered",
            turn: input.turn,
          });
          continue;
        }
        live.starting = {
          input: input.id,
          turn: input.turn,
          settled: Promise.withResolvers(),
        };
        admitTurn(live, input.turn, [input.id]);
        live.stopBy = "restart";
        endTurn(live, input.turn, { status: "stopped" });
      }
      // A turn that ran when Rufi stopped carries on; one a Stop was
      // ending stops.
      const ran = db
        .prepare(
          "SELECT agent_id AS agent, provider_turn AS ref, status FROM turns WHERE status IN ('running', 'stopping') ORDER BY rowid",
        )
        .all() as { agent: string; ref: string; status: string }[];
      for (const turn of ran) {
        const agent = get(turn.agent);
        if (!agent) continue;
        const live = liveOf(agent);
        live.stopBy = "restart";
        endTurn(
          live,
          turn.ref,
          { status: "stopped" },
          turn.status === "running" ? continues : undefined,
        );
        live.stopBy = undefined;
      }
      // A start that never got its input this far didn't run.
      const unstarted = db
        .prepare(
          "SELECT id, agent_id AS agent FROM turns WHERE status = 'starting'",
        )
        .all() as { id: string; agent: string }[];
      if (unstarted.length > 0) {
        store.change(({ event }) => {
          for (const { id, agent } of unstarted) {
            db.prepare("DELETE FROM turns WHERE id = ?").run(id);
            event("turn.not_started", agent, { turn: id });
          }
        });
      }
      dispatching = true;
      const waiting = db
        .prepare(
          "SELECT DISTINCT agent_id AS id FROM queue WHERE state = 'waiting' AND held IS NULL",
        )
        .all() as { id: string }[];
      for (const { id } of waiting) pump(id);
      return Promise.resolve();
    },

    release: (inputs) => {
      lift(
        db
          .prepare(
            "SELECT id, agent_id AS agent FROM queue WHERE id IN (SELECT value FROM json_each(?)) AND held IS NOT NULL",
          )
          .all(JSON.stringify(inputs)) as { id: string; agent: string }[],
      );
    },

    remove: (inputs) => {
      const found = db
        .prepare(
          "SELECT id, agent_id AS agent FROM queue WHERE id IN (SELECT value FROM json_each(?)) AND state = 'waiting'",
        )
        .all(JSON.stringify(inputs)) as { id: string; agent: string }[];
      if (found.length === 0) return;
      store.change(({ event }) => {
        for (const { id, agent } of found) {
          db.prepare(
            "UPDATE queue SET state = 'removed', held = NULL, held_text = NULL, updated_at = ? WHERE id = ?",
          ).run(now(), id);
          event("input.removed", agent, { input: id });
        }
      });
    },

    edit: (input, parts) => {
      const found = db
        .prepare(
          "SELECT agent_id AS agent FROM queue WHERE id = ? AND state = 'waiting' AND parts IS NOT NULL",
        )
        .get(input) as { agent: string } | undefined;
      if (!found) return false;
      store.change(({ event }) => {
        db.prepare(
          "UPDATE queue SET parts = ?, updated_at = ? WHERE id = ?",
        ).run(JSON.stringify(parts), now(), input);
        event("input.edited", found.agent, { input });
      });
      return true;
    },

    reorder: (agent, inputs) => {
      const waiting = db
        .prepare(
          "SELECT id, position FROM queue WHERE agent_id = ? AND state = 'waiting' AND id IN (SELECT value FROM json_each(?)) ORDER BY position",
        )
        .all(agent, JSON.stringify(inputs)) as {
        id: string;
        position: number;
      }[];
      const known = new Set(waiting.map((input) => input.id));
      const order = [...new Set(inputs)].filter((id) => known.has(id));
      if (order.every((id, index) => waiting[index]?.id === id)) return;
      store.change(({ event }) => {
        for (const [index, id] of order.entries()) {
          db.prepare(
            "UPDATE queue SET position = ?, updated_at = ? WHERE id = ?",
          ).run(waiting[index]?.position ?? index, now(), id);
        }
        event("input.reordered", agent, { inputs: order });
      });
      pump(agent);
    },

    steer: (input) => {
      const found = db
        .prepare(
          "SELECT agent_id AS agent FROM queue WHERE id = ? AND state = 'waiting'",
        )
        .get(input) as { agent: string } | undefined;
      if (!found) return;
      store.change(({ event }) => {
        db.prepare(
          `UPDATE queue SET kind = 'steer', held = NULL, held_text = NULL, updated_at = ?,
             position = (SELECT MIN(position) - 1 FROM queue WHERE agent_id = ? AND state = 'waiting')
           WHERE id = ?`,
        ).run(now(), found.agent, input);
        event("input.steered", found.agent, { input });
      });
      pump(found.agent);
    },

    signedIn: () => {
      lift(
        db
          .prepare(
            "SELECT id, agent_id AS agent FROM queue WHERE held = 'signed_out'",
          )
          .all() as { id: string; agent: string }[],
      );
    },

    stop: async (id, by, options) => {
      if (!options?.children) return stopOne(id, by);
      const tree = [id, ...api.below(id)];
      for (const agent of tree) trees.set(agent, (trees.get(agent) ?? 0) + 1);
      try {
        // What waits for any of them never goes by itself.
        for (const agent of tree) {
          const found = get(agent);
          if (!found) continue;
          const live = liveOf(found);
          for (const input of waitingOf(agent)) {
            move(live, input.id, "waiting", STOPPED);
          }
        }
        const stopped = await Promise.allSettled(
          tree.map((agent) => stopOne(agent, by)),
        );
        for (const result of stopped) {
          if (result.status === "rejected") throw result.reason;
        }
      } finally {
        for (const agent of tree) {
          const count = (trees.get(agent) ?? 1) - 1;
          if (count > 0) trees.set(agent, count);
          else trees.delete(agent);
        }
      }
    },

    place: (id, meta) => {
      const live = lives.get(id);
      const current = live?.current;
      // The provider of the conversation the call came from.
      const provider = live?.provider ?? row(id)?.provider;
      const call =
        provider === undefined
          ? undefined
          : adapters.get(provider)?.callOf(meta);
      if (
        !live ||
        !current ||
        live.stopBy !== undefined ||
        call === undefined
      ) {
        return undefined;
      }
      return {
        agent: id,
        turn: current.turn,
        ref: current.ref,
        conversation: live.number,
        call,
      };
    },

    forget: async (ids) => {
      const tree = db
        .prepare(
          `WITH RECURSIVE tree (id) AS (
             SELECT id FROM agents WHERE id IN (SELECT value FROM json_each(?))
             UNION SELECT agents.id FROM agents JOIN tree ON agents.parent_id = tree.id
           ) SELECT id FROM tree`,
        )
        .all(JSON.stringify(ids))
        .map((found) => found["id"] as string);
      if (tree.length > 0) {
        store.change(({ event }) => {
          db.prepare(
            "DELETE FROM agents WHERE id IN (SELECT value FROM json_each(?))",
          ).run(JSON.stringify(tree));
          event("agents.forgotten", null, { agents: tree });
        });
      }
      for (const id of tree) revoke(id);
      await letGo();
    },

    close: async () => {
      for (const id of lives.keys()) revoke(id);
      await letGo();
    },
  };
  return api;
}
