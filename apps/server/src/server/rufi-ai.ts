// Rufi AI's replies, through the agent package (docs/adr/0024). Today's chat
// (server/chat.ts) still decides what goes to the AI and when: it claims the
// rows, runs Rufi's reader first, and writes the screen's transcript. Each
// chat's own agent, Rufi AI, keeps its conversation and turns in the
// package. A hand-over goes into the package's queue without its words: the
// package claims them here, and only the hand-over still waiting for its
// outcome gives them, so the package never sends one again by itself. What
// the package shows of a conversation as it comes reaches the chat as the
// agent's events; the end of a turn is applied from the package's events
// too, with Rufi's cursor, when the chat didn't save it.
import type { Agent, Opening } from "@rufi/agents/agents";
import {
  NotOpened as NotOpenedHere,
  type McpRegistration,
  type ProviderEvent,
  type TurnEnd as Ended,
} from "@rufi/agents/provider";
import type { StoredEvent } from "@rufi/agents/store";
import { v7 as uuid } from "uuid";
import {
  NotOpened,
  NotSent,
  Stopped,
  type AgentEvent,
  type Model,
  type TurnEnd,
} from "../agent/runtime.ts";
import { chatAgents } from "../core/chat/agents.ts";
import type { ChatRow, Transcripts } from "../core/chat/transcript.ts";
import { startAgents, type AgentSystem, type Apply } from "./agents.ts";

/** What Rufi AI does, as it comes: its thread is its conversation. */
export type RufiAiEvent = Exclude<AgentEvent, { type: "message" }> & {
  /** Its item's place in its turn, as the package keeps it. */
  position?: number;
};

/** What the chat gives Rufi AI, and hears from it. */
export interface RufiAiHost {
  onEvent: (event: RufiAiEvent) => void;
  /** Resolves once what the chat was told so far is saved. */
  saved: () => Promise<void>;
}

/** What a chat's conversation is given each time it opens. */
interface ChatOpening {
  instructions: string;
  /** The version of the rules in `instructions`. */
  version: string;
  tools: McpRegistration;
  /** A new conversation's earlier history, read as it opens. */
  seed: () => Promise<string | undefined>;
}

/** Rufi AI for today's chat, by each chat's thread: its conversation. */
export interface RufiAi {
  provider: string;
  /** The models the provider offers now. */
  models: (signal?: AbortSignal) => Promise<Model[]>;
  /**
   * Opens the chat's conversation now, if it isn't open: its own, opened
   * again first when its rules changed (`reload`), or a new one (`fresh`).
   * One the provider no longer has is replaced by a new one. Returns its
   * thread. Throws NotOpened when it didn't open.
   */
  open: (
    chat: ChatRow,
    opening: ChatOpening,
    how: { fresh: boolean; reload: boolean },
  ) => Promise<string>;
  /** Whether a reply starts or runs in the thread now. */
  running: (threadId: string) => boolean;
  /** The running reply that may still use Rufi's tools, unless it stops. */
  activeTurn: (threadId: string) => string | undefined;
  /**
   * Starts a reply to `input`, its parts in order; resolves once it has
   * started. Throws NotSent when the AI surely didn't get it; any other
   * error leaves that unknown.
   */
  send: (
    threadId: string,
    message: {
      id: string;
      sender: string;
      input: string[];
      model?: string;
      effort: string;
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  /**
   * Passes a message into the running reply; returns that reply's turn.
   * Throws NotSent when it surely didn't reach it.
   */
  steer: (
    threadId: string,
    message: { id: string; text: string },
  ) => Promise<{ turnId: string }>;
  /**
   * Stops the running reply (only when it is `turnId`, if given); `end`
   * says why, when Rufi decided it.
   */
  stop: (threadId: string, turnId?: string, end?: TurnEnd) => Promise<void>;
  /** Takes no more: what is under way is settled as far as it can be. */
  close: () => Promise<void>;
}

/** A hand-over waiting for its outcome, by the package's input id. */
interface Pending {
  agent: string;
  kind: "steer" | "queue";
  parts: string[];
  done: PromiseWithResolvers<string | undefined>;
}

/** How a turn ended, as today's chat shows it. */
function endOf(end: Ended): TurnEnd {
  switch (end.status) {
    case "done":
      return { status: "completed" };
    case "stopped":
      return { status: "interrupted", reason: "stopped", text: "Stopped." };
    case "failed":
      return {
        status: "failed",
        reason:
          end.reason === "signed_out"
            ? "sign_in"
            : end.reason === "process_died" || end.reason === "other"
              ? "provider_failed"
              : end.reason,
        ...(end.text !== undefined && { text: end.text }),
        ...(end.resetsAt !== undefined && { resetsAt: end.resetsAt }),
        ...(end.reason === "process_died" && { died: true as const }),
      };
  }
}

/** A provider event as one of today's agent events, in `threadId`. */
function eventOf(
  threadId: string,
  event: Exclude<ProviderEvent, { type: "turnUsage" }>,
): RufiAiEvent {
  const turnId = event.turn;
  switch (event.type) {
    case "turnStarted":
      return { threadId, type: "turnStarted", turnId };
    case "text":
    case "note":
      return {
        threadId,
        type: event.type,
        turnId,
        itemId: event.item,
        delta: event.delta,
        ...(event.done && { done: true }),
      };
    case "thinking":
      return {
        threadId,
        type: "thinking",
        turnId,
        itemId: event.item,
        delta: event.delta,
      };
    case "question":
      return {
        threadId,
        type: "question",
        turnId,
        itemId: event.item,
        title: event.title,
        options: [...event.options],
      };
    case "reasoning":
      return {
        threadId,
        type: "reasoning",
        turnId,
        itemId: event.item,
        summary: event.summary,
        details: event.payload,
      };
    case "step":
      return {
        threadId,
        type: "activity",
        turnId,
        itemId: event.item,
        activity: event.kind,
        title: event.title,
        ...(event.detail !== undefined && { detail: event.detail }),
        status: event.status,
        ...(event.payload !== undefined && { details: event.payload }),
      };
    case "usage":
      return {
        threadId,
        type: "usage",
        turnId,
        tokens: event.tokens,
        window: event.window,
      };
    case "turnEnded":
      return { threadId, type: "turnEnded", turnId, end: endOf(event.end) };
  }
}

/** The agent system, with each chat's Rufi AI on it. */
export async function startRufiAi(
  options: Omit<
    Parameters<typeof startAgents>[0],
    "host" | "live" | "apply" | "opened"
  > & { transcripts: Transcripts },
): Promise<AgentSystem & { rufiAi: (host: RufiAiHost) => RufiAi }> {
  const { store, transcripts, adapters } = options;
  const kept = chatAgents(options.record, options.now);
  /** The chat, once it runs. */
  let chat: RufiAiHost | undefined;
  /** What each agent's conversation opens with, as its chat last gave it. */
  const openings = new Map<string, ChatOpening>();
  const pending = new Map<string, Pending>();
  /** Each open conversation's agent, by its thread. */
  const threads = new Map<string, string>();
  /** The agent's events come from this thread from now on. */
  const follow = (agent: string, ref: string) => {
    for (const [thread, owner] of threads) {
      if (owner === agent) threads.delete(thread);
    }
    threads.set(ref, agent);
  };
  /** Rufi's own end for a turn it stopped, by the provider's turn. */
  const ends = new Map<string, TurnEnd>();
  let closed = false;

  const opening = async (
    agent: Agent,
    kind: "resume" | "new",
  ): Promise<Opening> => {
    const given = openings.get(agent.id);
    if (!given) throw new Error("Rufi AI's chat hasn't opened it.");
    const seed = kind === "new" ? await given.seed() : undefined;
    return {
      instructions: given.instructions,
      tools: given.tools,
      ...(seed !== undefined && { seed }),
    };
  };

  /** The hand-over gets its outcome; nothing claims it again. */
  const settle = (input: string, outcome: string | undefined | Error) => {
    const waiting = pending.get(input);
    if (!waiting) return;
    pending.delete(input);
    if (outcome instanceof Error) waiting.done.reject(outcome);
    else waiting.done.resolve(outcome);
  };

  const live = (
    agent: string,
    ref: string,
    event: ProviderEvent,
    position?: number,
  ) => {
    if (threads.get(ref) !== agent) return;
    // A turn's own usage is for the usage tool; the chat shows the context.
    if (event.type === "turnUsage") return;
    if (event.type === "turnEnded") {
      const own = ends.get(event.turn);
      ends.delete(event.turn);
      if (own && event.end.status === "stopped") {
        chat?.onEvent({
          threadId: ref,
          type: "turnEnded",
          turnId: event.turn,
          end: own,
        });
        return;
      }
    }
    chat?.onEvent({
      ...eventOf(ref, event),
      ...(position !== undefined && { position }),
    });
  };

  // A root's turn from the package's events, after what the chat was told
  // was saved: its start when the chat didn't save it, the record of its
  // whole answer, and its end when the chat didn't save it
  // (transcripts.applyStart, applyEnd).
  const apply: Apply = async (event, advance) => {
    if (event.type !== "turn.started" && event.type !== "turn.ended") {
      return false;
    }
    if (event.agent === null) return false;
    const owner = await kept.owner(event.agent);
    if (!owner?.root) return false;
    const row = await transcripts.chat(owner.personId);
    if (row?.id !== owner.chatId) return false;
    await chat?.saved();
    if (event.type === "turn.started") {
      const { ref } = event.payload as { ref: string };
      await transcripts.applyStart(
        row,
        ref,
        { id: row.threadId ?? "", model: row.model ?? row.threadModel ?? "" },
        advance,
      );
      return true;
    }
    const { ref, item, ...end } = event.payload as Ended & {
      ref: string;
      item?: string;
    };
    await transcripts.applyEnd(
      row,
      ref,
      endOf(end),
      end.status === "done"
        ? { text: end.answer, ...(item !== undefined && { item }) }
        : undefined,
      advance,
    );
    return true;
  };

  const system = await startAgents({
    ...options,
    host: {
      opening,
      // Only the hand-over waiting for its outcome gives its words; a steer
      // only into the turn it was meant for.
      claim: ({ agent, input }) => {
        const waiting = pending.get(input);
        if (!waiting || closed) return Promise.resolve({ status: "gone" });
        if (
          waiting.kind === "steer" &&
          system.agents.current(agent)?.status !== "running"
        ) {
          settle(input, new NotSent("That reply has ended."));
          return Promise.resolve({ status: "gone" });
        }
        return Promise.resolve({ status: "claimed", parts: waiting.parts });
      },
    },
    live,
    apply,
    // A root's new conversation is its chat's thread from now on.
    opened: async ({ agent, provider, ref }) => {
      const owner = await kept.owner(agent);
      const row = owner?.root && (await transcripts.chat(owner.personId));
      if (!row || row.id !== owner.chatId) return;
      // Once the pointer moves, the old thread's events can't find the
      // chat: they are saved first.
      await chat?.saved();
      await transcripts.setThread(row, {
        id: ref,
        provider,
        model: system.agents.get(agent)?.model ?? "",
        tools: openings.get(agent)?.version ?? "",
      });
      follow(agent, ref);
    },
  });
  const { agents } = system;
  // A chat's replies' steps show from the agent database, by its own agent.
  transcripts.readSteps({
    of: (agent, agentTurns) =>
      Map.groupBy(agents.items(agent, agentTurns), (item) => item.turn),
    details: (agent, agentTurn, id) => {
      const found = agents.item(agent, agentTurn, id);
      return found && { details: found.payload };
    },
  });

  /** What became of the hand-overs, from the package's events. */
  const outcome = (event: StoredEvent) => {
    const payload = event.payload as {
      ref?: string | null;
      inputs: string[];
      input: string;
      held: string;
      text: string;
    };
    switch (event.type) {
      case "turn.started":
        for (const input of payload.inputs) {
          settle(input, payload.ref ?? undefined);
        }
        return;
      // Also when it comes after the turn's end.
      case "input.delivered":
        settle(payload.input, payload.ref ?? undefined);
        return;
      case "input.held":
        settle(
          payload.input,
          payload.held === "failed"
            ? new NotSent(payload.text)
            : new NotSent(payload.text, {
                cause: new NotOpened(payload.text),
              }),
        );
        return;
      // A queued input the provider surely didn't get goes again, claimed
      // here again; a steer that missed its turn waits in Rufi's queue.
      case "input.waiting":
        if (pending.get(payload.input)?.kind === "steer") {
          settle(payload.input, new NotSent("That reply has ended."));
        }
        return;
      case "input.not_sure":
        settle(payload.input, new Error("Not sure this reached the AI."));
        return;
      case "input.dropped":
      case "input.removed":
        settle(
          payload.input,
          new NotSent("Stopped.", { cause: new Stopped() }),
        );
    }
  };
  let seen = store.highWater();
  const unfollow = store.onCommit(() => {
    for (;;) {
      const events = store.eventsAfter(seen);
      if (events.length === 0) return;
      for (const event of events) {
        seen = event.number;
        outcome(event);
      }
    }
  });

  /** A hand-over into the agent's queue; resolves with its turn. */
  const handOver = (
    agent: string,
    kind: Pending["kind"],
    sender: string,
    parts: string[],
  ) => {
    const id = uuid();
    const done = Promise.withResolvers<string | undefined>();
    pending.set(id, { agent, kind, parts, done });
    try {
      agents.send(agent, { id, sender, kind });
    } catch (error) {
      pending.delete(id);
      throw new NotSent("Rufi couldn't hand it over.", { cause: error });
    }
    return done.promise;
  };

  const agentOf = (threadId: string) => {
    const agent = threads.get(threadId);
    if (agent === undefined) {
      throw new NotSent("The AI's conversation isn't open.");
    }
    return agent;
  };

  const rufiAi = (host: RufiAiHost): RufiAi => {
    chat = host;
    closed = false;
    const provider = adapters[0]?.id ?? "";
    return {
      provider,

      models: async (signal) => {
        const adapter = adapters.find((one) => one.id === provider);
        const offered = adapter ? await adapter.models(signal) : [];
        return offered.map(({ id, name }) => ({ id, name }));
      },

      open: async (row, given, how) => {
        const agent = await system.root(row.id);
        openings.set(agent, given);
        // What it opens with: the chat's model and effort.
        const now = agents.get(agent);
        if (now) {
          agents.configure(agent, {
            model: row.model ?? now.model,
            effort: row.effort,
          });
        }
        if (how.fresh || how.reload) await agents.reopen(agent, how.fresh);
        let ref: string;
        try {
          ref = await agents.open(agent);
        } catch (error) {
          if (error instanceof NotOpenedHere) {
            throw new NotOpened(error.message, { cause: error });
          }
          throw error;
        }
        follow(agent, ref);
        // The chat's thread is its conversation.
        const stored = await transcripts.chat(row.personId);
        if (stored && stored.threadId !== ref) {
          await chat?.saved();
          await transcripts.setThread(stored, {
            id: ref,
            provider: agents.get(agent)?.provider ?? provider,
            model: agents.get(agent)?.model ?? "",
            tools: given.version,
          });
        }
        return ref;
      },

      running: (threadId) => {
        const agent = threads.get(threadId);
        return agent !== undefined && agents.current(agent) !== undefined;
      },

      activeTurn: (threadId) => {
        const agent = threads.get(threadId);
        const current = agent === undefined ? undefined : agents.current(agent);
        return current?.status === "running" ? current.ref : undefined;
      },

      send: async (threadId, message, signal) => {
        const agent = agentOf(threadId);
        if (signal?.aborted) {
          throw new NotSent("Stopped.", { cause: new Stopped() });
        }
        const now = agents.get(agent);
        if (!now) throw new NotSent("Rufi AI isn't there.");
        // A new model or effort goes with this reply, in the same conversation.
        agents.configure(agent, {
          model: message.model ?? now.model,
          effort: message.effort,
        });
        await handOver(agent, "queue", message.sender, message.input);
      },

      steer: async (threadId, message) => {
        const turnId = await handOver(agentOf(threadId), "steer", "person", [
          message.text,
        ]);
        if (turnId === undefined)
          throw new Error("The steer's reply is unknown.");
        return { turnId };
      },

      stop: async (threadId, turnId, end) => {
        const agent = threads.get(threadId);
        if (agent === undefined) return;
        const current = agents.current(agent);
        const ref = current?.status === "starting" ? undefined : current?.ref;
        if (turnId !== undefined && ref !== turnId) return;
        if (end && ref !== undefined) ends.set(ref, end);
        await agents.stop(agent, turnId === undefined ? "person" : "rufi");
      },

      // A hand-over the package hasn't claimed doesn't go any more; one it
      // has may have reached the AI.
      close: () => {
        closed = true;
        for (const input of pending.keys()) {
          settle(
            input,
            agents.input(input)?.state === "waiting"
              ? new NotSent("Stopped.", { cause: new Stopped() })
              : new Error("Rufi closed while handing it over."),
          );
        }
        return Promise.resolve();
      },
    };
  };

  return {
    ...system,
    rufiAi,
    close: async () => {
      unfollow();
      await system.close();
      const failed: unknown[] = [];
      for (const adapter of adapters) {
        try {
          await adapter.close();
        } catch (error) {
          failed.push(error);
        }
      }
      if (failed.length > 0) {
        throw new AggregateError(
          failed,
          `Some providers didn't close: ${failed.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
        );
      }
    },
  };
}
