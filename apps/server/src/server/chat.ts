// The chat: joins the agent and Rufi's transcripts. What the agent does is
// saved first and shown from what was saved. What waits to go to the AI is
// in Rufi's own queue (core/chat/queue.ts): the dispatcher here hands the AI
// one turn's rows at a time, claimed in the database before the AI is
// called, and the next only after that turn and its writes have ended.
import type { Chip, Effort, Pointer } from "@rufi/contracts";
import {
  NotSent,
  Stopped,
  type AgentEvent,
  type AgentHost,
  type AgentRuntime,
  type Model,
  type ThreadSettings,
  type ToolAnswer,
} from "../agent/runtime.ts";
import type { Allowlist } from "../core/chat/models.ts";
import { allowedModels } from "../core/chat/models.ts";
import {
  QueueRefusal,
  type ChatQueue,
  type HandOver,
} from "../core/chat/queue.ts";
import { refsForAi, RefRefusal } from "../core/chat/refs.ts";
import { safetyInstructions } from "../core/chat/safety.ts";
import type { ChatRow, Transcripts } from "../core/chat/transcript.ts";
import { errorCode, type Log } from "../platform/logs.ts";

/** How many earlier messages a new thread starts with. */
const NEW_THREAD_MESSAGES = 10;

export interface ChatDeps {
  transcripts: Transcripts;
  queue: ChatQueue;
  /** Whether the AI can be reached with the person's sign-in now. */
  signedIn: () => Promise<boolean>;
  /** Makes the agent, given where its events go and how its tools run. */
  agent: (host: AgentHost) => AgentRuntime;
  allowlist: () => Promise<Allowlist>;
  tools: {
    /** Names the tool set; a thread keeps the one it started with. */
    version: string;
    /** How the AI uses them, after the safety instructions. */
    instructions: string;
    /**
     * A caller for one turn of a chat; the agent gives each call's id. A
     * turn a Rufi event started can only read.
     */
    caller: (
      chat: ChatRow,
      agentTurnId: string,
      origin: "person" | "rufi",
    ) => (name: string, input: unknown, callId: string) => Promise<ToolAnswer>;
  };
  log: Log;
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
  /** A new thread's earlier chat, until its first message is sent. */
  const pendingContext = new Map<string, string>();
  /**
   * Steers sent, so their message is saved as a steer with its own words
   * and chips (the AI got the reference list too); by message id.
   */
  const steers = new Map<
    string,
    { threadId: string; text: string; refs: Chip[] }
  >();
  /** Each running turn's tool caller and chat, by thread. */
  const callers = new Map<
    string,
    {
      turnId: string;
      chat: ChatRow;
      call: (
        name: string,
        input: unknown,
        callId: string,
      ) => Promise<ToolAnswer>;
    }
  >();
  /** The hand-over each thread's next turn starts with, by thread. */
  const handing = new Map<string, string>();
  /** The hand-over each running turn started with, by agent turn. */
  const handedTo = new Map<string, string>();
  /** Closing: nothing more is handed over. */
  let closed = false;
  /** Messages already given their reply text, so a question starts a new paragraph. */
  const replied = new Set<string>();
  /** Turns with a part Rufi couldn't save: stopped, and ended as failed. */
  const unsaved = new Set<string>();

  /** A part of the turn wasn't saved: nothing more of it is, and it stops. */
  function lost(threadId: string, turnId: string): void {
    if (unsaved.has(turnId)) return;
    unsaved.add(turnId);
    agent.stop(threadId, turnId).catch((stopError: unknown) => {
      log("chat.save_failed", { kind: "stop", error: errorCode(stopError) });
    });
  }

  const host: AgentHost = {
    onEvent: (event) => {
      saving = saving.then(() =>
        save(event).catch((error: unknown) => {
          log("chat.save_failed", {
            kind: event.type,
            error: errorCode(error),
          });
          // A transcript with a hole is never shown as a whole reply.
          if (event.type === "turnEnded") return;
          lost(event.threadId, event.turnId);
        }),
      );
    },
    callTool: async (threadId, turnId, name, input, callId) => {
      // What the agent did before the call is stored first: the user's
      // message a save rests on, and the turn its receipt belongs to.
      await saving;
      let caller = callers.get(threadId);
      if (caller?.turnId !== turnId) {
        const chat = await transcripts.byThread(threadId);
        if (!chat) {
          return {
            ok: false,
            text: JSON.stringify({
              ok: false,
              error: "No chat is open.",
            }),
          };
        }
        caller = {
          turnId,
          chat,
          call: deps.tools.caller(
            chat,
            turnId,
            await transcripts.origin(chat, turnId),
          ),
        };
        callers.set(threadId, caller);
      }
      const startedAt = transcripts.now();
      const answer = await caller.call(name, input, callId);
      // Kept before the AI has it: Used must show every read the AI got.
      try {
        await transcripts.recordToolCall(caller.chat, turnId, {
          callId,
          tool: name,
          input,
          answer,
          startedAt,
        });
      } catch (error) {
        log("chat.save_failed", { kind: "tool_call", error: errorCode(error) });
        lost(threadId, turnId);
        return {
          ok: false,
          text: JSON.stringify({
            ok: false,
            error: "Rufi couldn't keep this call, so it stopped the reply.",
          }),
        };
      }
      return answer;
    },
  };
  const agent = deps.agent(host);

  /** Stores one agent event; listeners see it once stored. */
  async function save(event: AgentEvent): Promise<void> {
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
      await endHandOver(chat, event.turnId);
      next(chat);
      return;
    }
    switch (event.type) {
      case "turnStarted": {
        // Rufi starts every turn: its rows are sent now, with the turn.
        const handOver = handing.get(event.threadId);
        handing.delete(event.threadId);
        if (handOver !== undefined) handedTo.set(event.turnId, handOver);
        await transcripts.startTurn(
          chat,
          event.turnId,
          { id: event.threadId, model: chat.threadModel ?? chat.model ?? "" },
          handOver,
        );
        if (handOver !== undefined) queue.changed(chat.id);
        return;
      }
      case "message": {
        // A hand-over's message entered with its turn; a steer is saved
        // here when the agent shows it first.
        const steer = steers.get(event.id);
        if (steer) {
          steers.delete(event.id);
          await transcripts.addMessage(chat, {
            id: event.id,
            kind: "steer",
            text: steer.text,
            agentTurnId: event.turnId,
            refs: steer.refs,
          });
        }
        return;
      }
      case "text":
        replied.add(event.itemId);
        await transcripts.appendReply(
          chat,
          event.turnId,
          event.itemId,
          event.delta,
        );
        return;
      case "question": {
        // The question is part of the reply, so it is never lost.
        const options = event.options.map((option) => `\n- ${option}`).join("");
        const text = `${replied.has(event.itemId) ? "\n\n" : ""}**${event.title}**${options}`;
        replied.add(event.itemId);
        await transcripts.appendReply(chat, event.turnId, event.itemId, text);
        return;
      }
      case "activity":
        await transcripts.setActivity(chat, event.turnId, event.itemId, {
          activity: event.activity,
          title: event.title,
          ...(event.detail !== undefined && { detail: event.detail }),
          status: event.status,
          ...(event.details !== undefined && { details: event.details }),
        });
        return;
      case "thinking":
        await transcripts.appendReasoning(
          chat,
          event.turnId,
          event.itemId,
          event.delta,
        );
        return;
      case "reasoning":
        await transcripts.addReasoning(chat, event.turnId, event.itemId, {
          summary: event.summary,
          details: event.details,
        });
        return;
      case "turnEnded":
        if (callers.get(event.threadId)?.turnId === event.turnId) {
          callers.delete(event.threadId);
        }
        for (const [id, steer] of steers) {
          if (steer.threadId === event.threadId) steers.delete(id);
        }
        await transcripts.endTurn(chat, event.turnId, event.end);
        await endHandOver(chat, event.turnId);
        // The turn and its writes have ended: the next rows may go.
        next(chat);
        return;
    }
  }

  /**
   * A turn ended: rows it started with that Rufi couldn't mark sent (their
   * start wasn't saved) are not sure, never handed over again.
   */
  async function endHandOver(chat: ChatRow, turnId: string): Promise<void> {
    const handOver = handedTo.get(turnId);
    handedTo.delete(turnId);
    if (handOver !== undefined) await queue.unknown(chat, handOver);
  }

  /** Hands the chat's next rows over, after what is being saved. */
  function next(chat: ChatRow): void {
    if (closed) return;
    setImmediate(() => {
      dispatch(chat).catch((error: unknown) => {
        // A Stop before the claim: nothing was handed over.
        if (error instanceof Stopped) return;
        log("chat.dispatch_failed", { error: errorCode(error) });
      });
    });
  }

  /**
   * Hands over the next turn's rows, in the chat's lane: only when no
   * reply runs. The rows are claimed in the database first; the AI either
   * starts their turn (they are sent with it), surely didn't get them (they
   * wait again, the person's held with the reason), or nobody knows (not
   * sure, and the chat pauses).
   */
  const dispatch = (chat: ChatRow) =>
    inLane(chat, async (stored, signal) => {
      let fresh = stored;
      if (closed) return;
      const known = threadOf(fresh);
      if (known !== null && agent.running(known)) return;
      const handOver = await queue.claim(fresh, await deps.signedIn());
      if (!handOver) return;
      let threadId: string;
      try {
        if (fresh.model === null) {
          const { models } = await offered();
          const first = models[0]?.id;
          if (first === undefined) {
            throw new ChatRefusal("None of the allowed models is offered now.");
          }
          await transcripts.setModel(fresh, first);
          fresh = { ...fresh, model: first };
        }
        threadId = await threadFor(fresh, signal);
      } catch (error) {
        // A Stop, or Rufi closing: the rows simply wait again.
        const quiet = error instanceof Stopped || closed;
        await queue.notTaken(
          fresh,
          handOver.id,
          quiet ? undefined : textOf(error),
        );
        if (!quiet) next(fresh);
        return;
      }
      const context = pendingContext.get(fresh.id);
      handing.set(threadId, handOver.id);
      try {
        await agent.send(
          threadId,
          {
            id: handOver.id,
            input: inputOf(handOver, context),
            effort: fresh.effort,
          },
          signal,
        );
        pendingContext.delete(fresh.id);
      } catch (error) {
        if (error instanceof NotSent) {
          handing.delete(threadId);
          const stopped = error.cause instanceof Stopped || closed;
          await queue.notTaken(
            fresh,
            handOver.id,
            stopped ? undefined : error.message,
          );
          if (!stopped) next(fresh);
          return;
        }
        log("chat.handover_unknown", { error: errorCode(error) });
        // Its turn may have started meanwhile: that is saved first.
        await saving;
        await queue.unknown(fresh, handOver.id);
      }
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

  /**
   * Runs `action` after the chat's earlier actions, on the
   * chat as stored then; Stop can end it.
   */
  function inLane<T>(
    chat: ChatRow,
    action: (fresh: ChatRow, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const op = new AbortController();
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

  async function settings(chat: ChatRow): Promise<ThreadSettings> {
    const region = await transcripts.setting("emergency_region");
    return {
      // Set before a thread starts: the first message chooses one.
      model: chat.model ?? "",
      effort: chat.effort,
      instructions: `${safetyInstructions(region)}\n\n${deps.tools.instructions}`,
    };
  }

  /** Whether the chat's thread can go on: same agent, model and tools. */
  const current = (chat: ChatRow) =>
    chat.threadId !== null &&
    chat.threadProvider === agent.provider &&
    chat.threadModel === chat.model &&
    chat.threadTools === deps.tools.version;

  /**
   * The chat's thread, open in the agent. A thread is picked up again
   * only here, when the person acts; a new one starts when it's missing, can't
   * be resumed, or the agent, model or tools changed.
   */
  async function threadFor(
    chat: ChatRow,
    signal: AbortSignal,
  ): Promise<string> {
    const threadSettings = await settings(chat);
    if (current(chat) && chat.threadId !== null) {
      const threadId = chat.threadId;
      if (agent.loaded(threadId)) return threadId;
      try {
        await agent.resumeThread(threadId, threadSettings, signal);
        // What a crash kept Rufi from saving, from the agent's own record.
        fillGaps(chat, threadId);
        return threadId;
      } catch (error) {
        if (error instanceof Stopped) throw error;
        log("chat.resume_failed", { error: errorCode(error) });
      }
    }
    // The old thread's events are saved first: once the pointer moves, they
    // can't find the chat, and the new thread's seed needs them.
    await saving;
    const modelChanged =
      chat.threadModel !== null && chat.threadModel !== chat.model;
    const { threadId, model } = await agent.startThread(threadSettings, signal);
    await transcripts.setThread(chat, {
      id: threadId,
      provider: agent.provider,
      model,
      tools: deps.tools.version,
    });
    chat.threadId = threadId;
    chat.threadProvider = agent.provider;
    chat.threadModel = model;
    chat.threadTools = deps.tools.version;
    const earlier = await transcripts.lastMessages(chat, NEW_THREAD_MESSAGES);
    if (earlier.length > 0) {
      pendingContext.set(chat.id, newThreadContext(earlier, modelChanged));
    } else {
      pendingContext.delete(chat.id);
    }
    return threadId;
  }

  /**
   * Saves the messages the thread ran that Rufi has not, in line with the
   * events, so a message is never saved twice. A failure is logged; the
   * thread goes on.
   */
  function fillGaps(chat: ChatRow, threadId: string): void {
    const fill = async () => {
      for (const message of await agent.startedMessages(threadId)) {
        if (await transcripts.hasMessage(message.id)) continue;
        // Rows Rufi handed over are filled from the queue, by their origin.
        if (await transcripts.fillHandOver(chat, message.id)) {
          queue.changed(chat.id);
          continue;
        }
        // A steer a crash kept from being saved.
        await transcripts.addMessage(chat, {
          id: message.id,
          kind: "message",
          text: message.text,
        });
      }
    };
    saving = saving.then(fill).catch((error: unknown) => {
      log("chat.save_failed", { kind: "fill", error: errorCode(error) });
    });
  }

  /** The chat's thread, when it is the agent's (no new one is made). */
  const threadOf = (chat: ChatRow) => (current(chat) ? chat.threadId : null);

  return {
    agent,

    /** The allowed models the provider offers now, and any allowlist problem. */
    models: offered,

    /**
     * Takes a message and its references into the queue by the send's id,
     * and empties the box, in one step; it goes to the AI in its turn. The
     * same id again finds the message it made.
     */
    send: async (
      chat: ChatRow,
      id: string,
      text: string,
      refs: readonly Pointer[] = [],
    ) => {
      try {
        await queue.accept(chat, id, text, refs);
      } catch (error) {
        if (error instanceof QueueRefusal) throw new ChatRefusal(error.message);
        throw error;
      }
      next(chat);
      return { id };
    },

    /**
     * Passes a message into the running reply; saved as a steer. When the
     * reply has ended, it is refused: it never becomes a waiting message.
     */
    steer: (
      chat: ChatRow,
      id: string,
      text: string,
      refs: readonly Pointer[] = [],
    ) =>
      inLane(chat, async (chat) => {
        const threadId = threadOf(chat);
        if (threadId === null || !agent.running(threadId)) {
          throw new ChatRefusal(STEER_ENDED);
        }
        let chips: Chip[];
        try {
          chips = await transcripts.chips(chat.personId, refs);
        } catch (error) {
          if (error instanceof RefRefusal) throw new ChatRefusal(error.message);
          throw error;
        }
        steers.set(id, { threadId, text, refs: chips });
        let turnId: string;
        try {
          ({ turnId } = await agent.steer(threadId, {
            id,
            text: withRefs(text, chips),
          }));
        } catch (error) {
          steers.delete(id);
          if (error instanceof NotSent || !agent.running(threadId)) {
            throw new ChatRefusal(STEER_ENDED);
          }
          throw error;
        }
        // In line with the events: the agent may have shown it already.
        const saved = saving.then(() =>
          transcripts.addMessage(chat, {
            id,
            kind: "steer",
            text,
            agentTurnId: turnId,
            refs: chips,
          }),
        );
        saving = saved.then(
          () => undefined,
          () => undefined,
        );
        await saved;
        return { id };
      }),

    /**
     * Stops the running reply, or a hand-over getting ready. The pause is
     * stored first, so nothing more goes to the AI until the person sends,
     * also when stopping fails.
     */
    stop: async (chat: ChatRow) => {
      await queue.pause(chat);
      for (const op of acting.get(chat.id) ?? []) op.abort();
      const threadId = threadOf(await latest(chat));
      if (threadId !== null) await agent.stop(threadId);
    },

    queue: {
      list: (chat: ChatRow) => queue.list(chat),
      edit: (chat: ChatRow, id: string, text: string) =>
        refused(() => queue.edit(chat, id, text)),
      remove: (chat: ChatRow, id: string) =>
        refused(() => queue.remove(chat, id)),
      reorder: (chat: ChatRow, ids: readonly string[]) =>
        refused(() => queue.reorder(chat, ids)),
      /** The person sends one row now: first in line, and the pause ends. */
      sendNow: async (chat: ChatRow, id: string) => {
        await refused(() => queue.sendNow(chat, id));
        next(chat);
      },
      subscribe: (chatId: string, listener: () => void) =>
        queue.subscribe(chatId, listener),
    },

    /**
     * A Rufi event in a person's chat: its producer's outcome (`write`), the
     * line and, when it asks the AI, its note in the queue, in one
     * transaction. The note goes
     * in its turn, or with the person's next message while the chat is
     * paused; it is never the person's words.
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
     * the new model comes with a new thread, and waiting rows go to it.
     */
    selectModel: (chat: ChatRow, model: string) =>
      inLane(chat, async (chat) => {
        const { models } = await offered();
        if (!models.some((m) => m.id === model)) {
          throw new ChatRefusal(
            "That model isn't allowed or isn't offered now.",
          );
        }
        await idle(chat, "the model");
        await transcripts.setModel(chat, model);
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
      await agent.close();
      await Promise.allSettled(lanes.values());
      await saving;
    },
  };

  /**
   * Refuses to change `what` while a reply runs or is starting; what the
   * thread did is saved first.
   */
  async function idle(chat: ChatRow, what: string): Promise<void> {
    const threadId = threadOf(chat);
    await saving;
    const { items } = await queue.list(chat);
    if (
      (threadId !== null && agent.running(threadId)) ||
      items.some((item) => item.state === "handing_over")
    ) {
      throw new ChatRefusal(`Stop the reply before changing ${what}.`);
    }
  }

  async function offered(): Promise<{ models: Model[]; error?: string }> {
    const allowlist = await deps.allowlist();
    const models = allowedModels(await agent.models(), allowlist.models);
    return {
      models,
      ...(allowlist.error !== undefined && { error: allowlist.error }),
    };
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

const STEER_ENDED =
  "The reply had ended, so this wasn't passed into it. Send it as a new message.";

/** Why a hand-over failed, in words for the person. */
const textOf = (error: unknown) =>
  error instanceof Error ? error.message : "The AI couldn't take it.";

/** A turn's input: a new thread's earlier chat, Rufi's notes, the message. */
function inputOf(handOver: HandOver, context: string | undefined): string[] {
  return [
    ...(context === undefined ? [] : [context]),
    ...(handOver.notes.length === 0
      ? []
      : [`${NOTES_HEAD}\n\n${handOver.notes.join("\n\n")}`]),
    ...(handOver.text === undefined
      ? []
      : [withRefs(handOver.text, handOver.refs)]),
  ];
}

/** A message as the AI gets it: the person's words, then their references. */
function withRefs(text: string, chips: readonly Chip[]): string {
  const list = refsForAi(chips);
  return list === undefined ? text : `${text}\n\n${list}`;
}

const WHO = { user: "User", ai: "AI", rufi: "Rufi" } as const;

/** What a new thread is told first: the note, then the last messages. */
function newThreadContext(
  earlier: readonly {
    from: "user" | "ai" | "rufi";
    text: string;
    unfinished?: boolean;
  }[],
  modelChanged: boolean,
): string {
  const note = `${modelChanged ? "The model changed and a new thread started." : "A new thread started."} Older history is available through read_chat.`;
  const messages = earlier
    .map(
      ({ from, text, unfinished }) =>
        `${WHO[from]}${unfinished ? " (this reply didn't finish)" : ""}: ${text}`,
    )
    .join("\n\n");
  return `${note}\n\nThe last messages of this chat, oldest first:\n\n${messages}`;
}
