// The chat: joins the agent and Rufi's transcripts. What the agent does is
// saved first and shown from what was saved. What waits to go to the AI is
// in Rufi's own queue (core/chat/queue.ts): the chat puts its rows, in
// order, into Rufi AI's queue in the agent package, which hands them over
// and claims each one's words from Rufi's queue just before (server/
// rufi-ai.ts). A message that sends files goes like any other, with Rufi's
// note naming those not read yet: Rufi AI has them read by agents of its
// own. Rufi AI is the chat's own agent; its thread is its conversation. It
// calls Rufi's tools through Rufi's MCP server, with a key for its chat;
// each call is bound to the reply it was made in.
import {
  CLAUDE_SIGNED_OUT,
  MODELS,
  modelOf,
  SIGNED_OUT,
  type Chip,
  type Effort,
  type ModelId,
  type Pointer,
  type ProviderStatus,
} from "@rufi/contracts";
import { Stopped } from "../agent/runtime.ts";
import { NOT_A_MODEL, UNKNOWN_PROVIDER } from "../core/chat/models.ts";
import {
  QueueRefusal,
  type ChatQueue,
  type HandOver,
} from "../core/chat/queue.ts";
import { refsForAi } from "../core/chat/refs.ts";
import type { ChatRow, Step, Transcripts } from "../core/chat/transcript.ts";
import type { Readings } from "../core/documents/reading.ts";
import type { ToolAnswer, ToolSpec } from "../core/tools/registry.ts";
import type { CallScope, TurnScope } from "../core/tools/tools.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import { agentDoor } from "./door.ts";
import type { McpKeys } from "./mcp.ts";
import type {
  ChatOpening,
  OpeningAgent,
  RufiAi,
  RufiAiEvent,
  RufiAiHost,
} from "./rufi-ai.ts";

/** How many earlier messages a new conversation starts with. */
const NEW_THREAD_MESSAGES = 10;

export interface ChatDeps {
  transcripts: Transcripts;
  queue: ChatQueue;
  /** A provider's sign-in now, as it reports it. */
  signIn: (provider: string) => Promise<ProviderStatus>;
  /** Rufi AI, given where its events go. */
  agent: (host: RufiAiHost) => RufiAi;
  /** Rufi's MCP endpoint for the chat's agents: its address and its keys. */
  mcp: { url: () => string; keys: McpKeys };
  /**
   * What the AI is told in every thread, for the emergency region chosen,
   * and its version: a thread told another version is told again. A
   * sub-agent's names it and the agent that started it.
   */
  rules: (
    region: string | undefined,
    agent?: { title: string; parent: { title: string; rufiAi: boolean } },
  ) => {
    instructions: string;
    version: string;
  };
  tools: {
    /** What the MCP server lists. */
    specs: readonly ToolSpec[];
    /**
     * A caller for one turn of an agent, from the scope the door placed its
     * calls in (rufiCaller), given Rufi's id for each call.
     */
    caller: (
      scope: TurnScope,
    ) => (name: string, input: unknown, callId: string) => Promise<ToolAnswer>;
  };
  log: Log;
  /**
   * The person's readings: the Documents page hears of a file sent, and
   * Rufi's note names the files a message brings that aren't read yet.
   * Without it, a message goes to the AI as it is.
   */
  readings?: Pick<Readings, "changed" | "toRead">;
}

/** A request the chat can't do now, in words for the person. */
export class ChatRefusal extends Error {}

export type Chat = ReturnType<typeof chat>;

/** What comes before Rufi's notes in a turn's input. */
const NOTES_HEAD =
  "Rufi event: Rufi's own note about something that happened. It is not the user's words, a request or their consent.";

export function chat(deps: ChatDeps) {
  const { transcripts, queue, log } = deps;
  /** Saves agent events one at a time, in the order they came. */
  let saving: Promise<void> = Promise.resolve();
  /** One action at a time per chat (a hand-over, a steer, a choice). */
  const lanes = new Map<string, Promise<unknown>>();
  /** Actions under way, so Stop can end them while they get ready. */
  const acting = new Map<string, Set<AbortController>>();
  /** Each agent's tool caller for its latest turn that called Rufi's tools. */
  const callers = new Map<
    string,
    {
      turn: string;
      call: (
        name: string,
        input: unknown,
        callId: string,
      ) => Promise<ToolAnswer>;
    }
  >();
  /** Closing: nothing more is handed over. */
  let closed = false;
  /**
   * Each reply's note, reasoning or running step as it comes, by turn and
   * item: since when, and a note's or reasoning's text so far. The agent
   * database keeps them.
   */
  const streaming = new Map<string, { since: string; text: string }>();
  /** Turns with a part Rufi couldn't save: stopped, and ended as failed. */
  const unsaved = new Set<string>();

  /** A part of the turn wasn't saved: nothing more of it is, and it stops. */
  function lost(threadId: string, turnId: string): void {
    if (unsaved.has(turnId)) return;
    unsaved.add(turnId);
    agent.cut(threadId, turnId).catch((stopError: unknown) => {
      log("chat.save_failed", { kind: "stop", error: errorCode(stopError) });
    });
  }

  const host: RufiAiHost = {
    saved: () => saving,
    opening: (chat, agent) => openingOf(chat, agent),
    // Rufi's queue decides: the row's words as they are now, or that it
    // doesn't go. Its files not read yet are named as they go.
    claim: async (chat, input, sentAs) => {
      const claimed = await queue.claim(chat, input, sentAs);
      if (claimed.status === "gone") return claimed;
      const { handOver } = claimed;
      const files = await deps.readings?.toRead(chat.personId, handOver.refs);
      return {
        status: "claimed",
        parts: inputOf({
          ...handOver,
          notes: [...handOver.notes, ...(files === undefined ? [] : [files])],
        }),
      };
    },
    changed: (chat) => {
      queue.changed(chat.id);
      next(chat);
    },
    onEvent: (event) => {
      saving = saving.then(() =>
        save(event).catch((error: unknown) => {
          log("chat.save_failed", {
            kind: event.type,
            error: errorCode(error),
          });
          // A transcript with a hole is never shown as a whole reply; the
          // context used and what is only shown are no part of it.
          if (
            event.type === "turnEnded" ||
            event.type === "usage" ||
            event.type === "note" ||
            event.type === "thinking" ||
            event.type === "reasoning" ||
            event.type === "activity"
          ) {
            return;
          }
          lost(event.threadId, event.turnId);
        }),
      );
    },
  };

  /**
   * One call to Rufi's tools, as the door placed it in its agent's admitted
   * turn: it runs for that turn, whatever comes after. Origin and what the
   * turn may do come from Rufi's own record.
   */
  async function callTool(
    scope: CallScope,
    tool: string,
    input: unknown,
  ): Promise<ToolAnswer> {
    const { callId, thread, ref } = scope;
    // What the agent did before the call is stored first: the user's
    // message a save rests on, and the turn its receipt belongs to.
    await saving;
    let caller = callers.get(scope.agent);
    if (caller?.turn !== scope.turn) {
      caller = {
        turn: scope.turn,
        call: deps.tools.caller(scope),
      };
      callers.set(scope.agent, caller);
    }
    const startedAt = transcripts.now();
    const answer = await caller.call(tool, input, callId);
    // Kept before the AI has it: Rufi keeps every answer the AI got (a
    // write keeps its own, with what it changed; a reading not saved, without
    // its page text).
    try {
      if (!answer.kept) {
        await transcripts.recordToolCall(
          scope.chat,
          {
            agent: scope.agent,
            agentTurn: scope.turn,
            ref,
            callId,
            tool,
            input: answer.keep?.input ?? input,
            startedAt,
          },
          answer.keep?.answer ?? answer,
        );
      }
    } catch (error) {
      log("chat.save_failed", { kind: "tool_call", error: errorCode(error) });
      lost(thread, ref);
      return {
        ok: false,
        text: JSON.stringify({
          ok: false,
          error: "Rufi couldn't keep this call, so it stopped the reply.",
        }),
      };
    }
    return answer;
  }

  const agent = deps.agent(host);
  const door = agentDoor({
    mcp: deps.mcp,
    specs: deps.tools.specs,
    place: (id, meta) => agent.place(id, meta),
    run: callTool,
    log,
  });

  /** Stores one agent event; listeners see it once stored. */
  async function save(event: RufiAiEvent): Promise<void> {
    const chat = await transcripts.byThread(event.threadId);
    if (!chat) {
      log("chat.unknown_thread", { kind: event.type });
      return;
    }
    if (unsaved.has(event.turnId)) {
      // What was saved stays as it is; nothing more of this reply is added.
      if (event.type !== "turnEnded") return;
      unsaved.delete(event.turnId);
      await transcripts.endTurn(chat, event.turnId, {
        status: "failed",
        reason: "save_failed",
        text: "Rufi couldn't save all of this reply, so it stopped it.",
      });
      next(chat);
      return;
    }
    switch (event.type) {
      case "turnStarted": {
        // The rows it took are sent now, with the turn, on the chat's model,
        // which can't change while a reply starts or runs.
        await transcripts.startTurn(
          chat,
          event.turnId,
          {
            id: event.threadId,
            model: chat.model ?? chat.threadModel ?? "",
            effort: chat.effort,
          },
          event.inputs,
          event.messages,
        );
        if (event.inputs.length > 0) queue.changed(chat.id);
        return;
      }
      case "text":
        await transcripts.appendReply(
          chat,
          event.turnId,
          event.itemId,
          event.delta,
          event.done === true,
        );
        return;
      // The question is part of the reply, so it is never lost; it is kept
      // apart from the answer's text.
      case "question":
        await transcripts.addQuestion(chat, event.turnId, event.itemId, {
          title: event.title,
          options: event.options,
        });
        return;
      // Steps, notes and reasoning are kept by the agent database, and
      // only shown here as they come.
      case "note":
      case "thinking": {
        const key = `${event.turnId}/${event.itemId}`;
        const so = streaming.get(key) ?? { since: transcripts.now(), text: "" };
        so.text += event.delta;
        streaming.set(key, so);
        const done = event.type === "note" && event.done === true;
        if (done) streaming.delete(key);
        await show(chat, event, {
          type: event.type === "note" ? "note" : "reasoning",
          text: so.text,
          status: done ? "done" : null,
          since: so.since,
        });
        return;
      }
      case "reasoning":
        await show(chat, event, {
          type: "reasoning",
          text: event.summary,
          status: "done",
          since:
            streaming.get(`${event.turnId}/${event.itemId}`)?.since ??
            transcripts.now(),
        });
        streaming.delete(`${event.turnId}/${event.itemId}`);
        return;
      case "activity": {
        const key = `${event.turnId}/${event.itemId}`;
        const since = streaming.get(key)?.since ?? transcripts.now();
        if (event.status === "running") streaming.set(key, { since, text: "" });
        else streaming.delete(key);
        await show(chat, event, {
          type: "step",
          kind: event.activity,
          title: event.title,
          detail: event.detail ?? null,
          status: event.status,
          since,
          ...(event.agent !== undefined && { agent: event.agent }),
        });
        return;
      }
      case "usage":
        await transcripts.setContext(chat, event.threadId, {
          tokens: event.tokens,
          window: event.window,
        });
        return;
      // The agent database keeps it.
      case "turnUsage":
        return;
      case "turnEnded":
        await transcripts.endTurn(chat, event.turnId, event.end);
        // Its steps as the agent database keeps them now it ended.
        for (const key of streaming.keys()) {
          if (key.startsWith(`${event.turnId}/`)) streaming.delete(key);
        }
        await transcripts.show(chat, event.turnId);
        // The turn and its writes have ended: the next rows may go.
        next(chat);
        return;
    }
  }

  /** One step of a reply as it is now, shown and not stored here. */
  async function show(
    chat: ChatRow,
    event: RufiAiEvent & { turnId: string; itemId: string },
    step: Pick<Step, "type" | "status"> &
      Partial<Pick<Step, "kind" | "title" | "detail" | "text" | "agent">> & {
        since: string;
      },
  ): Promise<void> {
    const { since, ...rest } = step;
    await transcripts.show(chat, event.turnId, [
      {
        id: event.itemId,
        position: event.position ?? 0,
        kind: null,
        title: null,
        detail: null,
        text: null,
        ...rest,
        createdAt: since,
        updatedAt: transcripts.now(),
      },
    ]);
  }

  /** Puts the chat's next rows in Rufi AI's queue, after what is being saved. */
  function next(chat: ChatRow): void {
    if (closed) return;
    setImmediate(() => {
      carry(chat).catch((error: unknown) => {
        // A Stop meanwhile: the next change puts them in.
        if (error instanceof Stopped) return;
        log("chat.dispatch_failed", { error: errorCode(error) });
      });
    });
  }

  /**
   * Puts the chat's waiting rows in Rufi AI's queue, in the chat's lane, in
   * Rufi's order: what Rufi keeps decides what goes, and the package hands
   * them over, each as the person sent it: into the running reply (steer)
   * or after it (queue). A conversation told older rules opens again
   * first, once Rufi AI is idle. Signed out, nothing goes: what waits is
   * held with the line on how to sign in.
   */
  const carry = (chat: ChatRow) =>
    inLane(chat, async (stored) => {
      let fresh = stored;
      if (closed) return;
      const provider = providerOf(stored);
      if (provider === undefined) return;
      const { state } = await deps.signIn(provider);
      if (state === "signed_out") {
        await queue.signedOut(
          fresh,
          provider === "claude" ? CLAUDE_SIGNED_OUT : SIGNED_OUT,
        );
        return;
      }
      if (state !== "signed_in") return;
      // Held as signed out, they go now the sign-in is back.
      await queue.signedIn(fresh);
      const rows = (await queue.waiting(fresh)).filter(
        (row) => row.held === null,
      );
      const ahead = rows.filter((row) => {
        const there = agent.input(row.id);
        return there?.state === "waiting" && there.held === null;
      });
      const idle =
        ahead.length === 0 &&
        !(await agent.busy(fresh)) &&
        (await queue.list(fresh)).items.every(
          (item) => item.state !== "handing_over",
        );
      // A conversation told older rules is told again, once nothing runs.
      const { version } = deps.rules(
        await transcripts.setting("emergency_region"),
      );
      const told = await agent.rules(fresh);
      if (told !== undefined && told !== version) {
        if (!idle) return;
        await agent.reopen(fresh, false);
      }
      const first = rows[0];
      if (!first) return;
      try {
        if (fresh.model === null) {
          const start = MODELS[0];
          await transcripts.setModel(fresh, start.id, start.provider);
          fresh = { ...fresh, model: start.id, modelProvider: start.provider };
        }
        await agent.configure(fresh);
      } catch (error) {
        await queue.hold(fresh, first.id, textOf(error));
        return;
      }
      const order: string[] = [];
      const added: { id: string; sender: string; kind: "queue" | "steer" }[] =
        [];
      for (const row of rows) {
        const there = agent.input(row.id);
        // Rufi's row goes: a hold the package kept on it lifts too.
        if (there?.state === "waiting") {
          if (there.held !== null) agent.release([row.id]);
          order.push(row.id);
          continue;
        }
        // With the AI, or settled: the package's events say what became
        // of it.
        if (there) continue;
        added.push({ id: row.id, sender: row.origin, kind: row.kind });
        order.push(row.id);
      }
      await agent.queue(fresh, added, order);
    });

  /**
   * The chat as stored now: an earlier action may have given it a
   * new thread or model since the request read it.
   */
  async function latest(chat: ChatRow): Promise<ChatRow> {
    const row = await transcripts.chat(chat.personId);
    if (!row) throw new ChatRefusal("That chat isn't there any more.");
    return row;
  }

  /** An action a Stop of the chat stops from now on. */
  function stoppable(chat: ChatRow): AbortController {
    const op = new AbortController();
    const ops = acting.get(chat.id) ?? new Set();
    ops.add(op);
    acting.set(chat.id, ops);
    return op;
  }

  /**
   * Runs `action` after the chat's earlier actions, on the
   * chat as stored then; Stop can end it.
   */
  function inLane<T>(
    chat: ChatRow,
    action: (fresh: ChatRow, signal: AbortSignal) => Promise<T>,
    op = stoppable(chat),
  ): Promise<T> {
    const ops = acting.get(chat.id) ?? new Set();
    ops.add(op);
    acting.set(chat.id, ops);
    const previous = lanes.get(chat.id) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const fresh = await latest(chat);
        if (op.signal.aborted) throw new Stopped();
        return action(fresh, op.signal);
      })
      .finally(() => {
        ops.delete(op);
        if (lanes.get(chat.id) === run) lanes.delete(chat.id);
      });
    lanes.set(chat.id, run);
    return run;
  }

  /**
   * What a conversation of one of the chat's agents opens with now: the
   * current rules, its tools with the agent's key, and for a new one the
   * chat's last messages, read once the old conversation's events are
   * saved (Rufi AI's only: a sub-agent has its task).
   */
  async function openingOf(
    chat: ChatRow,
    own: OpeningAgent,
  ): Promise<ChatOpening> {
    const region = await transcripts.setting("emergency_region");
    const { instructions, version } = own.parent
      ? deps.rules(region, { title: own.title, parent: own.parent })
      : deps.rules(region);
    return {
      instructions,
      version,
      tools: door.registration(own.id, own.tools),
      seed: async () => {
        await saving;
        const earlier = await transcripts.lastMessages(
          chat,
          NEW_THREAD_MESSAGES,
        );
        return earlier.length > 0 ? newThreadContext(earlier) : undefined;
      },
    };
  }

  /** Takes a message into the queue by its id, which owns the ids. */
  async function accept(
    chat: ChatRow,
    id: string,
    text: string,
    refs: readonly Pointer[],
    kind: "steer" | "queue",
  ): Promise<void> {
    try {
      await queue.accept(chat, id, text, refs, kind);
    } catch (error) {
      if (error instanceof QueueRefusal) throw new ChatRefusal(error.message);
      throw error;
    }
    // Its files are sent now: the Documents page lists them.
    if (refs.some((ref) => ref.type === "document")) {
      deps.readings?.changed(chat.personId);
    }
    next(chat);
  }

  /** Whether a reply the person started runs in the chat now. */
  return {
    agent,

    /**
     * At a start, before Rufi AI's queue hands anything over: each chat's
     * waiting rows go in, in Rufi's order.
     */
    carryAll: async () => {
      for (const { id } of await transcripts.people()) {
        const row = await transcripts.chat(id);
        if (row) await carry(row);
      }
    },

    /**
     * Sends a message: it is taken into the queue by the send's id, and the
     * box emptied, in one step, before anything goes; the chat shows it
     * waiting. While a reply the person started runs, it goes into that
     * reply; otherwise in its turn. The same id again finds the message it
     * made, and changes nothing. Signed out, nothing is taken: the text
     * stays in the box.
     */
    /**
     * Takes the person's message: while a reply runs, it goes into it
     * (steer) or after it (queue), as they chose.
     */
    send: async (
      chat: ChatRow,
      id: string,
      text: string,
      refs: readonly Pointer[] = [],
      kind: "steer" | "queue" = "steer",
    ) => {
      await mustBeSignedIn(chat);
      await accept(chat, id, text, refs, kind);
      return { id };
    },

    /**
     * Stops the running reply, or a hand-over getting ready. What waits goes
     * on after.
     */
    stop: async (chat: ChatRow) => {
      for (const op of acting.get(chat.id) ?? []) op.abort();
      await agent.stop(await latest(chat));
    },

    // Each change is Rufi's first, then Rufi AI's queue's by the same id.
    queue: {
      list: (chat: ChatRow) => queue.list(chat),
      /** The words a row goes with are taken as it goes: Rufi's only. */
      edit: (chat: ChatRow, id: string, text: string) =>
        refused(() => queue.edit(chat, id, text)),
      remove: async (chat: ChatRow, id: string) => {
        await refused(() => queue.remove(chat, id));
        agent.remove([id]);
      },
      reorder: async (chat: ChatRow, ids: readonly string[]) => {
        await refused(() => queue.reorder(chat, ids));
        next(chat);
      },
      /** The person steers a waiting row into the running reply. */
      steer: async (chat: ChatRow, id: string) => {
        await mustBeSignedIn(chat);
        await refused(() => queue.steer(chat, id));
        agent.steer(id);
        next(chat);
      },
      /** The person sends a row Rufi didn't: first in line. */
      send: async (chat: ChatRow, id: string) => {
        await mustBeSignedIn(chat);
        await refused(() => queue.send(chat, id));
        next(chat);
      },
      /**
       * The person's choice for a message whose AI thread didn't open, for
       * the hold they saw: the same thread again, or a new one. In the
       * chat's lane, after any hand-over under way; a choice made on an
       * older hold changes nothing.
       */
      recover: async (
        chat: ChatRow,
        id: string,
        hold: string,
        choice: "retry" | "new_thread",
      ) => {
        await mustBeSignedIn(chat);
        await inLane(chat, async (fresh) => {
          const newThread = choice === "new_thread";
          // Never while a reply runs: it would lose that reply's thread. The
          // hold stays, and the screens read the queue again.
          if (newThread && (await busy(fresh))) {
            queue.changed(fresh.id);
            return;
          }
          await refused(() => queue.recover(fresh, id, hold, newThread));
          // The old conversation's calls are placed no more.
          if (newThread) await agent.reopen(fresh, true);
        });
        next(chat);
      },
      subscribe: (chatId: string, listener: () => void) =>
        queue.subscribe(chatId, listener),
    },

    /**
     * A Rufi event in a person's chat: its producer's outcome (`write`), the
     * line and, when it asks the AI, its note in the queue, in one
     * transaction. The note goes in a turn of its own, in its place in the
     * queue; it is never the person's words.
     */
    event: async (
      personId: string,
      event: Parameters<Transcripts["addEvent"]>[1],
      write?: Parameters<Transcripts["addEvent"]>[2],
    ) => {
      const chat = await transcripts.chat(personId);
      if (!chat) throw new ChatRefusal("That person has no chat.");
      await transcripts.addEvent(chat, event, write);
      queue.changed(chat.id);
      next(chat);
    },

    /**
     * Chooses the chat's model. Only when no reply runs or is starting:
     * the next reply runs on it, in the same thread.
     */
    selectModel: (chat: ChatRow, model: ModelId) =>
      inLane(chat, async (chat) => {
        const chosen = modelOf(model);
        if (!chosen) throw new ChatRefusal(NOT_A_MODEL);
        await idle(chat, "the model");
        await transcripts.setModel(chat, model, chosen.provider);
      }),

    /**
     * Chooses the chat's effort, from its next reply on, in the same
     * thread. Only when no reply runs or is starting.
     */
    selectEffort: (chat: ChatRow, effort: Effort) =>
      inLane(chat, async (chat) => {
        await idle(chat, "the effort");
        await transcripts.setEffort(chat, effort);
      }),

    /** Waits for what is being saved, then ends the agent. */
    close: async () => {
      closed = true;
      for (const ops of acting.values()) for (const op of ops) op.abort();
      await agent.close();
      await Promise.allSettled(lanes.values());
      await saving;
    },
  };

  /** Whether a reply runs or is starting; what the thread did is saved first. */
  async function busy(chat: ChatRow): Promise<boolean> {
    await saving;
    const { items } = await queue.list(chat);
    return (
      (await agent.busy(chat)) ||
      items.some((item) => item.state === "handing_over")
    );
  }

  /** Refuses to change `what` while a reply runs or is starting. */
  async function idle(chat: ChatRow, what: string): Promise<void> {
    if (await busy(chat)) {
      throw new ChatRefusal(`Stop the reply before changing ${what}.`);
    }
  }

  /**
   * The provider the chat's next turn runs on: its model's, kept with the
   * choice; before it has one, a new chat's. A chosen model whose provider
   * Rufi doesn't know has none, and goes nowhere else.
   */
  function providerOf(chat: ChatRow): string | undefined {
    if (chat.model === null) return MODELS[0].provider;
    return chat.modelProvider ?? undefined;
  }

  /**
   * Without a sign-in, nothing the person sends is taken: signed out when
   * the chat's provider says so, else its error as it came.
   */
  async function mustBeSignedIn(chat: ChatRow): Promise<void> {
    const provider = providerOf(chat);
    if (provider === undefined) throw new ChatRefusal(UNKNOWN_PROVIDER);
    const { state, text } = await deps.signIn(provider);
    if (state === "signed_out") {
      throw new ChatRefusal(
        provider === "claude" ? CLAUDE_SIGNED_OUT : SIGNED_OUT,
      );
    }
    if (state === "unavailable") {
      throw new ChatRefusal(
        text ?? "Rufi couldn't ask the AI how it's signed in.",
      );
    }
  }

  /** A change to the queue; its refusals are the chat's. */
  async function refused<T>(change: () => Promise<T>): Promise<T> {
    try {
      return await change();
    } catch (error) {
      if (error instanceof QueueRefusal) throw new ChatRefusal(error.message);
      throw error;
    }
  }
}

/** Why a hand-over failed, in words for the person. */
const textOf = (error: unknown) =>
  error instanceof Error ? error.message : "The AI couldn't take it.";

/** A turn's input: Rufi's notes, then the message. */
function inputOf(handOver: HandOver): string[] {
  const { notes } = handOver;
  return [
    ...(notes.length === 0 ? [] : [`${NOTES_HEAD}\n\n${notes.join("\n\n")}`]),
    ...(handOver.text === undefined
      ? []
      : [withRefs(handOver.text, handOver.refs)]),
  ];
}

/** A message as the AI gets it: the person's words, then their references. */
function withRefs(text: string, chips: readonly Chip[]): string {
  const list = refsForAi(chips);
  if (list === undefined) return text;
  return text === "" ? list : `${text}\n\n${list}`;
}

const WHO = {
  user: "User",
  ai: "AI",
  note: "AI (a progress note)",
  rufi: "Rufi",
} as const;

/** What a new conversation is told first: the note, then the last messages. */
function newThreadContext(
  earlier: readonly {
    /** An agent's message: Rufi's line in it names the agent. */
    from: keyof typeof WHO | "agent";
    text: string;
    unfinished?: boolean;
  }[],
): string {
  const note =
    "A new thread started. Older history is available through read_chat.";
  const messages = earlier
    .map(({ from, text, unfinished }) =>
      from === "agent"
        ? text
        : `${WHO[from]}${unfinished ? " (this reply didn't finish)" : ""}: ${text}`,
    )
    .join("\n\n");
  return `${note}\n\nThe last messages of this chat, oldest first:\n\n${messages}`;
}
