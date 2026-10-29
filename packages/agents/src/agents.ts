// Runs agents: each agent's provider conversation, its turns, and what
// happens in them, kept in the agent database (./store.ts) as the provider
// reports it. An agent the host hasn't admitted never runs. A call to the
// host's tools is placed only in a turn the package admitted and hasn't
// closed, a turn the provider began by itself included.
//
// What waits to be sent, and when it goes, is the queue's (a later step): it
// calls start and steer here, one at a time for each agent.
import { randomUUID } from "node:crypto";
import {
  Missing,
  type Conversation,
  type Delivery,
  type Input,
  type McpRegistration,
  type ProviderAdapter,
  type ProviderEvent,
  type SteerOutcome,
  type TurnEnd,
} from "./provider.ts";
import type { AgentStore, Change } from "./store.ts";

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
}

/** An input, and who sent it, as the host names them or an agent's id. */
export interface Sent extends Input {
  sender: string;
}

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
   * Starts a turn with `input` on an admitted agent that runs none, opening
   * its conversation first. Delivered: the turn is admitted when the
   * provider says it started. Not delivered: the input waits again.
   * Throws NotOpened when the conversation can't open.
   */
  start: (agent: string, input: Sent) => Promise<Delivery>;
  /** Puts `input` into the agent's running turn. */
  steer: (agent: string, input: Sent) => Promise<SteerOutcome>;
  /**
   * Stops the agent's turn: closed to new calls at once, then stopped by
   * the provider. A start not yet with the provider doesn't go.
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
  /** Who asked to stop the current turn. */
  stopBy?: string;
  /** Calls waiting for a turn's admission, by the provider's reference. */
  waiting: Map<string, (() => void)[]>;
  /** Text and notes as they stream, by turn and item, until whole. */
  streams: Map<
    string,
    { turn: string; item: string; type: "text" | "note"; text: string }
  >;
}

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

export function createAgents(options: {
  store: AgentStore;
  adapters: readonly ProviderAdapter[];
  host: Host;
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

  function addInput(
    { event }: Change,
    live: Live,
    input: Sent,
    kind: "steer" | "queue",
  ): void {
    const at = now();
    db.prepare(
      `INSERT INTO queue (id, agent_id, sender, kind, parts, position, state, conversation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM queue WHERE agent_id = ?), 'handing_over', ?, ?, ?)`,
    ).run(
      input.id,
      live.id,
      input.sender,
      kind,
      JSON.stringify(input.parts),
      live.id,
      live.number,
      at,
      at,
    );
    event("input.handing_over", live.id, { input: input.id });
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
    },

    get,

    start: async (id, input) => {
      const agent = get(id);
      if (!agent?.admitted) throw new Error(`Agent ${id} isn't admitted.`);
      const live = liveOf(agent);
      if (live.starting || live.current) {
        throw new Error(`Agent ${id} runs a turn already.`);
      }
      const starting: Starting = {
        input: input.id,
        settled: Promise.withResolvers(),
      };
      live.starting = starting;
      let delivery: Delivery | undefined;
      try {
        const conversation = await conversationOf(live, agent);
        if (starting.stopBy !== undefined) {
          delivery = {
            status: "not_delivered",
            text: "Stopped before it started.",
          };
          return delivery;
        }
        const turn = randomUUID();
        store.change((change) => {
          db.prepare(
            "INSERT INTO turns (id, agent_id, conversation, model, effort, status, started_at) VALUES (?, ?, ?, ?, ?, 'starting', ?)",
          ).run(turn, id, live.number, agent.model, agent.effort, now());
          addInput(change, live, input, "queue");
        });
        starting.turn = turn;
        delivery = await conversation.startTurn({
          input,
          model: agent.model,
          effort: agent.effort,
        });
        if (delivery.status === "not_delivered") {
          const { reason, text } = delivery;
          store.change(({ event }) => {
            db.prepare(
              "UPDATE queue SET state = 'waiting', held = ?, held_text = ?, conversation = NULL, updated_at = ? WHERE id = ?",
            ).run(reason ?? null, reason ? text : null, now(), input.id);
            db.prepare("DELETE FROM turns WHERE id = ?").run(turn);
            event("turn.not_started", id, {
              turn,
              input: input.id,
              reason,
              text,
            });
          });
        }
        return delivery;
      } finally {
        // Delivered or uncertain, it is admitted when the provider says it
        // started; otherwise it didn't go.
        if (
          live.starting === starting &&
          delivery?.status !== "delivered" &&
          delivery?.status !== "uncertain"
        ) {
          live.starting = undefined;
          starting.settled.resolve();
        }
      }
    },

    steer: async (id, input) => {
      const agent = get(id);
      const live = agent && lives.get(id);
      const current = live?.current;
      if (!live?.conversation || !current || live.stopBy !== undefined) {
        throw new Error(`Agent ${id} runs no turn to steer.`);
      }
      store.change((change) => {
        addInput(change, live, input, "steer");
      });
      const outcome = await live.conversation.steer({
        input,
        turn: current.ref,
      });
      if (outcome.status === "uncertain") return outcome;
      if (lives.get(id) !== live) return outcome;
      const turn =
        outcome.status === "next_turn"
          ? turnOf(live, outcome.turn)?.id
          : current.turn;
      store.change(({ event }) => {
        if (outcome.status === "not_delivered") {
          db.prepare(
            "UPDATE queue SET state = 'waiting', conversation = NULL, updated_at = ? WHERE id = ? AND state = 'handing_over'",
          ).run(now(), input.id);
        } else {
          db.prepare(
            "UPDATE queue SET state = 'delivered', turn_id = ?, updated_at = ? WHERE id = ? AND state = 'handing_over'",
          ).run(turn ?? null, now(), input.id);
        }
        event(`input.${outcome.status}`, id, { input: input.id, turn });
      });
      return outcome;
    },

    stop: async (id, by) => {
      const live = lives.get(id);
      if (!live) return;
      const starting = live.starting;
      if (starting) {
        starting.stopBy ??= by;
        if (starting.turn !== undefined) closeTurn(live, starting.turn);
        await starting.settled.promise;
      }
      const current = live.current;
      if (!current || !live.conversation) return;
      if (live.stopBy === undefined) {
        live.stopBy = by;
        closeTurn(live, current.turn);
      }
      await live.conversation.stop(current.ref);
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
