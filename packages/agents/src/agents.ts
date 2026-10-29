// Runs agents: each agent's provider conversation, its turns, and what
// happens in them, kept in the agent database (./store.ts) as the provider
// reports it. An agent the host hasn't admitted never runs. A call to the
// host's tools is placed only in a turn the package admitted and hasn't
// closed, a turn the provider began by itself included.
//
// Every agent's inputs wait in one queue, and one dispatcher for each agent
// hands them over: the first waiting input starts a turn, a steer goes into
// the running turn at once, a queued input waits for the turn to end. An
// input the host keeps is claimed from it first. What became of an input
// rests on what the provider showed: one it may have taken is never sent
// again by itself, and while one is with the provider nothing else starts.
import { randomUUID } from "node:crypto";
import {
  Missing,
  NotOpened,
  type Conversation,
  type Delivery,
  type McpRegistration,
  type ProviderAdapter,
  type ProviderEvent,
  type Received,
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
  /** Waiting, or claimed by this same hand-over before: its words. */
  | { status: "claimed" | "already_claimed"; parts: readonly string[] }
  /** Removed, sent or not sure: it doesn't go. */
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
   * Claims an input the host keeps, before it goes to the provider: one
   * host transaction marks it handing over to this agent's conversation and
   * gives back its words. Nothing: another hand-over has it, and the host's
   * recovery at start settles it.
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
}

/** Why a waiting input isn't handed over by itself. */
export type Hold = "signed_out" | "open_failed" | "failed" | "restarts";

/** A call to the host's tools, placed in the open turn it left. */
export interface Placed {
  agent: string;
  /** The package's turn. */
  turn: string;
  conversation: number;
  /** The provider's call id. */
  call: string;
}

export interface Agents {
  /** Adds an agent, not admitted: it runs only once the host admits it. */
  create: (agent: NewAgent) => Agent;
  /** The host keeps the agent's owner now, so it may run. Again does nothing. */
  admit: (id: string) => void;
  get: (id: string) => Agent | undefined;
  /**
   * Puts an input in the agent's queue, behind those waiting. It goes when
   * the agent can take it; the sender is never told no.
   */
  send: (agent: string, input: Sent) => void;
  /**
   * Starts handing inputs over, at start: first asks the providers about
   * those a crash left with them, then hands over what waits.
   */
  dispatch: () => Promise<void>;
  /** Lifts these inputs' holds, so they go again. */
  release: (inputs: readonly string[]) => void;
  /** The sign-in is back: inputs held as signed out go again. */
  signedIn: () => void;
  /**
   * Stops the agent's turn: closed to new calls at once, then stopped by
   * the provider; the inputs waiting for it go on after. A start not yet
   * with the provider doesn't go, and its input is dropped.
   */
  stop: (agent: string, by: string) => Promise<void>;
  /**
   * The admitted, open turn a call to the host's tools left, from the
   * call's `_meta`, as the agent's adapter vouches for it. A call from a
   * turn the provider began by itself waits for its admission until
   * `signal` aborts. Nothing: the call is refused.
   */
  place: (
    agent: string,
    meta: unknown,
    signal: AbortSignal,
  ) => Promise<Placed | undefined>;
  /**
   * Removes these agents, everything below them and all they kept, then
   * lets go of their conversations. Again does nothing.
   */
  forget: (agents: readonly string[]) => Promise<void>;
  /**
   * Lets go of every open conversation. A turn still running is left as a
   * crash leaves it, for the restart to carry on.
   */
  close: () => Promise<void>;
}

/** An agent's conversation and turns while this process runs it. */
interface Live {
  id: string;
  /** The conversation number its events must name. */
  number: number;
  conversation?: Conversation;
  /** A start not yet admitted. */
  starting?: Starting;
  /** The turn running now, once admitted. */
  current?: { turn: string; ref: string };
  /** The provider's reference for the turn that ended last. */
  last?: string;
  /** Who asked to stop the current turn. */
  stopBy?: string;
  /** Calls waiting for a turn's admission, by the provider's reference. */
  waiting: Map<string, (() => void)[]>;
  /** Text and notes as they stream, by turn and item, until whole. */
  streams: Map<
    string,
    { turn: string; item: string; type: "text" | "note"; text: string }
  >;
  /** Its dispatcher runs; asked again meanwhile, it looks again. */
  pumping: boolean;
  asks: number;
}

/** A waiting input, as the queue keeps it. */
interface Waiting {
  id: string;
  kind: "steer" | "queue";
  parts: string | null;
}

/** Where an input goes next. */
type Move =
  | { state: "delivered"; turn: string | null }
  /** Back in line: a steer first, a queued input in its place. */
  | { state: "waiting"; first?: true }
  | { state: "held"; held: Hold; text: string }
  | { state: "not_sure" }
  | { state: "dropped" }
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

export function createAgents(options: {
  store: AgentStore;
  adapters: readonly ProviderAdapter[];
  host: Host;
  /** What the dispatcher couldn't put on an input. */
  onError: (error: unknown) => void;
}): Agents {
  const { store, host } = options;
  const { db } = store;
  const adapters = new Map(options.adapters.map((a) => [a.id, a]));
  const lives = new Map<string, Live>();

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

  function liveOf(agent: Agent): Live {
    let live = lives.get(agent.id);
    if (!live) {
      live = {
        id: agent.id,
        number: agent.conversation,
        waiting: new Map(),
        streams: new Map(),
        pumping: false,
        asks: 0,
      };
      lives.set(agent.id, live);
    }
    return live;
  }

  /**
   * The agent's conversation, opened now if it isn't. Only `resume`: the
   * one it has, or nothing when the provider no longer has it.
   */
  async function conversationOf(
    live: Live,
    agent: Agent,
  ): Promise<Conversation>;
  async function conversationOf(
    live: Live,
    agent: Agent,
    only: "resume",
  ): Promise<Conversation | undefined>;
  async function conversationOf(
    live: Live,
    agent: Agent,
    only?: "resume",
  ): Promise<Conversation | undefined> {
    if (live.conversation) return live.conversation;
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
        return live.conversation;
      } catch (error) {
        if (!(error instanceof Missing)) throw error;
      }
    }
    if (only === "resume") return undefined;
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
    return conversation;
  }

  /** What the provider reports, kept as it comes, for the conversation open now. */
  function ingest(live: Live, number: number, event: ProviderEvent): void {
    if (lives.get(live.id) !== live || live.number !== number) return;
    switch (event.type) {
      case "turnStarted":
        admitTurn(live, event.turn, event.inputs);
        return;
      case "text":
      case "note": {
        const key = `${event.turn}/${event.item}`;
        const stream = live.streams.get(key) ?? {
          turn: event.turn,
          item: event.item,
          type: event.type,
          text: "",
        };
        stream.text += event.delta;
        live.streams.set(key, stream);
        if (event.done) {
          live.streams.delete(key);
          saveItem(live, event.turn, event.item, {
            type: stream.type,
            text: stream.text,
          });
        }
        return;
      }
      // Only as it streams; the reasoning comes whole.
      case "thinking":
        return;
      case "question":
        saveItem(live, event.turn, event.item, {
          type: "question",
          title: event.title,
          payload: { options: event.options },
        });
        return;
      case "reasoning":
        saveItem(live, event.turn, event.item, {
          type: "reasoning",
          text: event.summary,
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
      case "turnEnded":
        endTurn(live, event.turn, event.end);
        return;
    }
  }

  /**
   * A turn started: the package's own start, or one the provider began by
   * itself with steers it was handed. Admitted once, in one transaction:
   * its row, its inputs delivered with it, and the agent running.
   */
  function admitTurn(live: Live, ref: string, inputs: readonly string[]): void {
    if (turnOf(live, ref)) return;
    const starting =
      live.starting && inputs.includes(live.starting.input)
        ? live.starting
        : undefined;
    const closed = starting?.stopBy !== undefined;
    const turn = store.change(({ event }) => {
      const at = now();
      let id = starting?.turn;
      if (id === undefined) {
        id = randomUUID();
        const agent = row(live.id);
        if (!agent) throw new Error(`No agent ${live.id}.`);
        db.prepare(
          "INSERT INTO turns (id, agent_id, conversation, provider_turn, model, effort, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)",
        ).run(id, live.id, live.number, ref, agent.model, agent.effort, at);
      } else {
        db.prepare(
          "UPDATE turns SET provider_turn = ?, status = ? WHERE id = ?",
        ).run(ref, closed ? "stopping" : "running", id);
      }
      db.prepare(
        "UPDATE queue SET state = 'delivered', turn_id = ?, updated_at = ? WHERE agent_id = ? AND state = 'handing_over' AND id IN (SELECT value FROM json_each(?))",
      ).run(id, at, live.id, JSON.stringify(inputs));
      db.prepare(
        "UPDATE agents SET status = 'running', stopped_by = NULL, updated_at = ? WHERE id = ?",
      ).run(at, live.id);
      event("turn.started", live.id, {
        turn: id,
        inputs,
        by: starting ? "package" : "provider",
      });
      return id;
    });
    live.current = { turn, ref };
    if (starting) {
      live.stopBy = starting.stopBy;
      live.starting = undefined;
      starting.settled.resolve();
    }
    for (const wake of live.waiting.get(ref) ?? []) wake();
    live.waiting.delete(ref);
    pump(live.id);
  }

  function saveItem(
    live: Live,
    ref: string,
    item: string,
    fields: {
      type: "text" | "note" | "question" | "reasoning" | "step";
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
    store.change(({ event }) => {
      const at = now();
      db.prepare(
        `INSERT INTO items (turn_id, id, position, type, kind, title, detail, status, text, payload, created_at, updated_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM items WHERE turn_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (turn_id, id) DO UPDATE SET kind = excluded.kind, title = excluded.title, detail = excluded.detail,
           status = excluded.status, text = excluded.text, payload = excluded.payload, updated_at = excluded.updated_at`,
      ).run(
        turn.id,
        item,
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
  function endTurn(live: Live, ref: string, end: TurnEnd): void {
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
    const stopBy =
      end.status === "stopped" ? (live.stopBy ?? "provider") : null;
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
      db.prepare(
        "UPDATE agents SET status = ?, result = ?, stopped_by = ?, updated_at = ? WHERE id = ?",
      ).run(
        end.status,
        end.status === "done"
          ? end.answer
          : end.status === "failed"
            ? (end.text ?? end.reason)
            : null,
        stopBy,
        at,
        live.id,
      );
      event("turn.ended", live.id, { turn: turn.id, ...end });
    });
    if (live.current?.ref === ref) {
      live.current = undefined;
      live.stopBy = undefined;
    }
    live.last = ref;
    pump(live.id);
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
        "SELECT id, kind, parts FROM queue WHERE agent_id = ? AND state = 'waiting' AND held IS NULL ORDER BY position",
      )
      .all(agent) as unknown as Waiting[];
  const stateOf = (input: string) =>
    (
      db.prepare("SELECT state FROM queue WHERE id = ?").get(input) as
        | { state: string }
        | undefined
    )?.state;
  const handingOver = (agent: string) =>
    db
      .prepare(
        "SELECT 1 FROM queue WHERE agent_id = ? AND state = 'handing_over' LIMIT 1",
      )
      .get(agent) !== undefined;

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
      if (start !== undefined) {
        db.prepare(
          "DELETE FROM turns WHERE id = ? AND status = 'starting'",
        ).run(start);
      }
      switch (to.state) {
        case "delivered":
          db.prepare(
            "UPDATE queue SET state = 'delivered', turn_id = ?, updated_at = ? WHERE id = ?",
          ).run(to.turn, at, input);
          break;
        case "waiting":
          db.prepare(
            `UPDATE queue SET state = 'waiting', conversation = NULL, updated_at = ?,
               position = CASE WHEN ? THEN (SELECT COALESCE(MIN(position), 1) - 1 FROM queue WHERE agent_id = ? AND state = 'waiting') ELSE position END
             WHERE id = ?`,
          ).run(at, to.first ? 1 : 0, live.id, input);
          break;
        case "held":
          db.prepare(
            "UPDATE queue SET state = 'waiting', held = ?, held_text = ?, conversation = NULL, updated_at = ? WHERE id = ?",
          ).run(to.held, to.text, at, input);
          break;
        case "not_sure":
        case "dropped":
        case "removed":
          db.prepare(
            "UPDATE queue SET state = ?, updated_at = ? WHERE id = ?",
          ).run(to.state, at, input);
      }
      const { state, ...rest } = to;
      event(`input.${state}`, live.id, { input, ...rest });
    });
  }

  /** What the provider received of an input, as far as it can tell. */
  const ask = async (conversation: Conversation, input: string) =>
    (
      await conversation
        .reconcile([input])
        .catch(() => new Map<string, Received>())
    ).get(input) ?? "unknown";

  /**
   * Where an input the provider may have taken goes, by what it says now:
   * one it didn't get waits again, a steer first in line.
   */
  const byAnswer = (
    received: Received,
    turn: string | null,
    steer = false,
  ): Move =>
    received === "received"
      ? { state: "delivered", turn }
      : received === "not_received"
        ? { state: "waiting", ...(steer && { first: true as const }) }
        : { state: "not_sure" };

  /**
   * Runs the agent's dispatcher, one at a time for each agent: asked again
   * while it runs, it looks again once it's done.
   */
  function pump(id: string): void {
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
    const { current } = live;
    if (current) {
      // Running: steers go in at once, in order; queued inputs wait.
      for (const input of waitingOf(live.id)) {
        if (live.current !== current || live.stopBy !== undefined) return;
        if (input.kind === "steer") await steerWith(live, input);
      }
      return;
    }
    // Just finished: nothing starts while a steer may still be taken.
    if (handingOver(live.id)) return;
    const first = waitingOf(live.id)[0];
    if (first) await startWith(live, agent, first);
  }

  /** The input's words: its own, or the host's claim. Nothing: it doesn't go now. */
  async function claimed(
    live: Live,
    input: Waiting,
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
      move(live, input.id, "waiting", {
        state: "held",
        held: "failed",
        text: message(error),
      });
      live.asks += 1;
      return undefined;
    }
    if (answer?.status === "gone") {
      move(live, input.id, "waiting", { state: "removed" });
      live.asks += 1;
      return undefined;
    }
    return answer?.parts;
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
      const stopped = () => starting.stopBy !== undefined;
      const parts = stopped() ? undefined : await claimed(live, input);
      if (stopped() || lives.get(live.id) !== live) {
        move(live, input.id, "waiting", { state: "dropped" });
        return;
      }
      if (!parts) return;
      const turn = randomUUID();
      store.change(({ event }) => {
        const at = now();
        db.prepare(
          "INSERT INTO turns (id, agent_id, conversation, model, effort, status, started_at) VALUES (?, ?, ?, ?, ?, 'starting', ?)",
        ).run(turn, live.id, live.number, agent.model, agent.effort, at);
        db.prepare(
          "UPDATE queue SET state = 'handing_over', conversation = ?, updated_at = ? WHERE id = ?",
        ).run(live.number, at, input.id);
        event("input.handing_over", live.id, {
          input: input.id,
          conversation: live.number,
        });
      });
      starting.turn = turn;
      const delivery = await conversation
        .startTurn({
          input: { id: input.id, parts },
          model: agent.model,
          effort: agent.effort,
        })
        .catch((error: unknown): Delivery => ({
          status: "uncertain",
          text: message(error),
        }));
      if (delivery.status === "delivered") {
        pending = true;
        return;
      }
      // Admitted already: the provider said it started.
      if (stateOf(input.id) !== "handing_over") return;
      const to: Move =
        delivery.status === "not_delivered"
          ? {
              state: "held",
              held: delivery.reason === "signed_out" ? "signed_out" : "failed",
              text: delivery.text,
            }
          : byAnswer(await ask(conversation, input.id), null);
      move(live, input.id, "handing_over", to, turn);
      // A refused input doesn't keep the rest waiting.
      if (to.state === "held" && to.held === "failed") live.asks += 1;
    } finally {
      if (!pending && live.starting === starting) {
        live.starting = undefined;
        starting.settled.resolve();
      }
    }
  }

  /**
   * Steers a waiting input into the running turn. Its outcome may come only
   * once the turn has ended; later steers go in meanwhile, in order.
   */
  async function steerWith(live: Live, input: Waiting): Promise<void> {
    const { current, conversation } = live;
    if (!current || !conversation) return;
    const parts = await claimed(live, input);
    // The turn ended meanwhile: the input starts the next one.
    if (
      !parts ||
      lives.get(live.id) !== live ||
      live.current !== current ||
      live.stopBy !== undefined
    ) {
      return;
    }
    store.change(({ event }) => {
      db.prepare(
        "UPDATE queue SET state = 'handing_over', conversation = ?, updated_at = ? WHERE id = ?",
      ).run(live.number, now(), input.id);
      event("input.handing_over", live.id, {
        input: input.id,
        conversation: live.number,
      });
    });
    conversation
      .steer({ input: { id: input.id, parts }, turn: current.ref })
      .catch((error: unknown): SteerOutcome => ({
        status: "uncertain",
        text: message(error),
      }))
      .then(async (outcome) => {
        if (lives.get(live.id) !== live) return;
        const to: Move =
          outcome.status === "delivered"
            ? { state: "delivered", turn: current.turn }
            : outcome.status === "next_turn"
              ? {
                  state: "delivered",
                  turn: turnOf(live, outcome.turn)?.id ?? null,
                }
              : outcome.status === "not_delivered"
                ? // A steer that missed its turn goes first, and starts the next.
                  { state: "waiting", first: true }
                : byAnswer(
                    await ask(conversation, input.id),
                    current.turn,
                    true,
                  );
        move(live, input.id, "handing_over", to);
        pump(live.id);
      })
      .catch(options.onError);
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

  return {
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
          "INSERT INTO agents (id, parent_id, root_id, title, provider, model, effort, tools, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

    send: (id, input) => {
      if (!row(id)) throw new Error(`No agent ${id}.`);
      if (stateOf(input.id) !== undefined) return;
      store.change(({ event }) => {
        const at = now();
        db.prepare(
          `INSERT INTO queue (id, agent_id, sender, kind, parts, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM queue WHERE agent_id = ?), ?, ?)`,
        ).run(
          input.id,
          id,
          input.sender,
          input.kind,
          input.parts === undefined ? null : JSON.stringify(input.parts),
          id,
          at,
          at,
        );
        event("input.added", id, { input: input.id, kind: input.kind });
      });
      pump(id);
    },

    dispatch: async () => {
      // What a crash left with a provider: asked by the conversation it
      // went to; an older one's can't be told here.
      const left = db
        .prepare(
          "SELECT queue.id, queue.agent_id AS agent, queue.conversation FROM queue JOIN agents ON agents.id = queue.agent_id WHERE queue.state = 'handing_over' AND agents.admitted = 1 ORDER BY queue.position",
        )
        .all() as { id: string; agent: string; conversation: number }[];
      for (const id of new Set(left.map((input) => input.agent))) {
        const agent = get(id);
        if (!agent) continue;
        const live = liveOf(agent);
        if (live.starting || live.current || live.pumping) continue;
        const inputs = left.filter((input) => input.agent === id);
        const asked = inputs
          .filter((input) => input.conversation === agent.conversation)
          .map((input) => input.id);
        const conversation =
          asked.length > 0
            ? await conversationOf(live, agent, "resume").catch(() => undefined)
            : undefined;
        const answers = conversation
          ? await conversation
              .reconcile(asked)
              .catch(() => new Map<string, Received>())
          : new Map<string, Received>();
        for (const input of inputs) {
          move(
            live,
            input.id,
            "handing_over",
            byAnswer(answers.get(input.id) ?? "unknown", null),
          );
        }
      }
      // A start the provider never said had started didn't run.
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
      const waiting = db
        .prepare(
          "SELECT DISTINCT agent_id AS id FROM queue WHERE state = 'waiting' AND held IS NULL",
        )
        .all() as { id: string }[];
      for (const { id } of waiting) pump(id);
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

    signedIn: () => {
      lift(
        db
          .prepare(
            "SELECT id, agent_id AS agent FROM queue WHERE held = 'signed_out'",
          )
          .all() as { id: string; agent: string }[],
      );
    },

    stop: async (id, by) => {
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
        if (!conversation) return;
        if (current) {
          if (live.stopBy === undefined) {
            live.stopBy = by;
            closeTurn(live, current.turn);
          }
          await conversation.stop(current.ref);
        } else if (live.last !== undefined && handingOver(id)) {
          // Its turn has ended, but steers handed over for it may still be
          // taken: the provider settles them now.
          await conversation.stop(live.last);
        }
      } finally {
        // What waits for the agent goes on.
        pump(id);
      }
    },

    place: async (id, meta, signal) => {
      const live = lives.get(id);
      const placed = live?.conversation?.placeCall(meta);
      if (!live || !placed) return undefined;
      for (;;) {
        const turn = turnOf(live, placed.turn);
        if (turn) {
          return turn.status === "running"
            ? {
                agent: id,
                turn: turn.id,
                conversation: live.number,
                call: placed.call,
              }
            : undefined;
        }
        if (signal.aborted || lives.get(id) !== live) return undefined;
        await new Promise<void>((resolve) => {
          const wake = () => {
            signal.removeEventListener("abort", wake);
            resolve();
          };
          signal.addEventListener("abort", wake);
          live.waiting.set(placed.turn, [
            ...(live.waiting.get(placed.turn) ?? []),
            wake,
          ]);
        });
      }
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
      if (tree.length === 0) return;
      store.change(({ event }) => {
        db.prepare(
          "DELETE FROM agents WHERE id IN (SELECT value FROM json_each(?))",
        ).run(JSON.stringify(tree));
        event("agents.forgotten", null, { agents: tree });
      });
      for (const id of tree) {
        const live = lives.get(id);
        lives.delete(id);
        await live?.conversation?.close();
      }
    },

    close: async () => {
      const open = [...lives.values()];
      lives.clear();
      for (const live of open) await live.conversation?.close();
    },
  };
}
