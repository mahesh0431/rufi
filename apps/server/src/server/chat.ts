// The chat: joins the agent and Rufi's transcripts. What the agent does is
// saved first and shown from what was saved; messages wait in the agent's own
// queue, and Rufi saves each one when the agent starts it.
import type { Effort, WaitingMessage } from "@rufi/contracts";
import { v7 as uuid } from "uuid";
import {
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
import { safetyInstructions } from "../core/chat/safety.ts";
import type { ChatRow, Transcripts } from "../core/chat/transcript.ts";
import { errorCode, type Log } from "../platform/logs.ts";

/** How many earlier messages a new thread starts with. */
const NEW_THREAD_MESSAGES = 10;

export interface ChatDeps {
  transcripts: Transcripts;
  /** Makes the agent, given where its events go and how its tools run. */
  agent: (host: AgentHost) => AgentRuntime;
  allowlist: () => Promise<Allowlist>;
  tools: {
    /** Names the tool set; a thread keeps the one it started with. */
    version: string;
    /** How the AI uses them, after the safety instructions. */
    instructions: string;
    /** A caller for one turn of a chat; the agent gives each call's id. */
    caller: (
      chat: ChatRow,
      agentTurnId: string,
    ) => (name: string, input: unknown, callId: string) => Promise<ToolAnswer>;
  };
  log: Log;
}

/** A request the chat can't do now, in words for the person. */
export class ChatRefusal extends Error {}

export type Chat = ReturnType<typeof chat>;

export function chat(deps: ChatDeps) {
  const { transcripts, log } = deps;
  /** Saves agent events one at a time, in the order they came. */
  let saving: Promise<void> = Promise.resolve();
  /** One action at a time per chat (send, steer, run now). */
  const lanes = new Map<string, Promise<unknown>>();
  /** Actions under way, so Stop can end them while they get ready. */
  const acting = new Map<string, Set<AbortController>>();
  /** A new thread's earlier chat, until its first message is sent. */
  const pendingContext = new Map<string, string>();
  /** Steers sent, so their message is saved as a steer; by message id. */
  const steers = new Map<string, string>(); // message id -> thread id
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
  /** Messages already given their reply text, so a question starts a new paragraph. */
  const replied = new Set<string>();
  const waitingListeners = new Map<string, Set<() => void>>();
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
          if (event.type === "waitingChanged" || event.type === "turnEnded") {
            return;
          }
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
          call: deps.tools.caller(chat, turnId),
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
    if (event.type !== "waitingChanged" && unsaved.has(event.turnId)) {
      // What was saved stays as it is; nothing more of this reply is added.
      if (event.type !== "turnEnded") return;
      unsaved.delete(event.turnId);
      await transcripts.endTurn(chat, event.turnId, {
        status: "failed",
        reason: "save_failed",
        text: "Rufi couldn't save all of this reply, so it stopped it.",
      });
      return;
    }
    switch (event.type) {
      case "turnStarted":
        await transcripts.startTurn(chat, event.turnId, {
          id: event.threadId,
          model: chat.threadModel ?? chat.model ?? "",
        });
        return;
      case "message": {
        const steer = steers.delete(event.id);
        await transcripts.addMessage(chat, {
          id: event.id,
          kind: steer ? "steer" : "message",
          text: event.text,
          agentTurnId: event.turnId,
        });
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
        for (const [id, threadId] of steers) {
          if (threadId === event.threadId) steers.delete(id);
        }
        await transcripts.endTurn(chat, event.turnId, event.end);
        return;
      case "waitingChanged":
        for (const listener of waitingListeners.get(chat.id) ?? []) {
          listener();
        }
        return;
    }
  }

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
     * Sends a message, by the id Rufi gives it (the send's own, from a box):
     * it runs now, or waits its
     * turn in the agent's queue. It enters the transcript when the agent
     * starts it.
     */
    send: (chat: ChatRow, text: string, id: string = uuid()) =>
      inLane(chat, async (stored, signal) => {
        let chat = stored;
        if (chat.model === null) {
          const { models } = await offered();
          const first = models[0]?.id;
          if (first === undefined) {
            throw new ChatRefusal("None of the allowed models is offered now.");
          }
          await transcripts.setModel(chat, first);
          chat = { ...chat, model: first };
        }
        const threadId = await threadFor(chat, signal);
        const context = pendingContext.get(chat.id);
        await agent.send(
          threadId,
          {
            id,
            text,
            effort: chat.effort,
            ...(context !== undefined && { context }),
          },
          signal,
        );
        pendingContext.delete(chat.id);
        return { id };
      }),

    /** Passes a message into the running reply; saved as a steer. */
    steer: (chat: ChatRow, text: string, id: string = uuid()) =>
      inLane(chat, async (chat) => {
        const threadId = threadOf(chat);
        if (threadId === null || !agent.running(threadId)) {
          throw new ChatRefusal("No reply is running to steer.");
        }
        steers.set(id, threadId);
        let turnId: string;
        try {
          ({ turnId } = await agent.steer(threadId, { id, text }));
        } catch (error) {
          steers.delete(id);
          throw error;
        }
        // In line with the events: the agent may have shown it already.
        const saved = saving.then(() =>
          transcripts.addMessage(chat, {
            id,
            kind: "steer",
            text,
            agentTurnId: turnId,
          }),
        );
        saving = saved.then(
          () => undefined,
          () => undefined,
        );
        await saved;
        return { id };
      }),

    /** Stops the running reply, or a send still getting ready. Waiting messages wait. */
    stop: async (chat: ChatRow) => {
      for (const op of acting.get(chat.id) ?? []) op.abort();
      const threadId = threadOf(await latest(chat));
      if (threadId !== null) await agent.stop(threadId);
    },

    waiting: {
      list: async (chat: ChatRow): Promise<WaitingMessage[]> => {
        const threadId = threadOf(await latest(chat));
        return threadId === null ? [] : agent.waiting.list(threadId);
      },
      edit: (chat: ChatRow, id: string, text: string) =>
        withThread(chat, (threadId) => agent.waiting.edit(threadId, id, text)),
      remove: (chat: ChatRow, id: string) =>
        withThread(chat, (threadId) => agent.waiting.remove(threadId, id)),
      reorder: (chat: ChatRow, ids: string[]) =>
        withThread(chat, (threadId) => agent.waiting.reorder(threadId, ids)),
      /** Runs one now; this is the person acting, so the thread is picked up. */
      runNow: (chat: ChatRow, id: string) =>
        inLane(chat, async (chat, signal) => {
          const threadId = threadOf(chat);
          if (threadId === null) {
            throw new ChatRefusal("That message isn't waiting any more.");
          }
          if (!agent.loaded(threadId)) {
            await agent.resumeThread(threadId, await settings(chat), signal);
            fillGaps(chat, threadId);
          }
          await agent.waiting.runNow(threadId, id, signal);
        }),
      subscribe: (chatId: string, listener: () => void) => {
        const set = waitingListeners.get(chatId) ?? new Set();
        set.add(listener);
        waitingListeners.set(chatId, set);
        return () => {
          set.delete(listener);
          if (set.size === 0) waitingListeners.delete(chatId);
        };
      },
    },

    /**
     * Chooses the chat's model. Only when no reply runs and no
     * message waits: the new model comes with a new thread.
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
     * thread. Only when no reply runs and no message waits.
     */
    selectEffort: (chat: ChatRow, effort: Effort) =>
      inLane(chat, async (chat) => {
        await idle(chat, "the effort");
        await transcripts.setEffort(chat, effort);
      }),

    /** Waits for what is being saved, then ends the agent. */
    close: async () => {
      await agent.close();
      await saving;
    },
  };

  /**
   * Refuses to change `what` while a reply runs or a message waits; what
   * the thread did is saved first.
   */
  async function idle(chat: ChatRow, what: string): Promise<void> {
    const threadId = threadOf(chat);
    await saving;
    if (threadId === null) return;
    if (agent.running(threadId)) {
      throw new ChatRefusal(`Stop the reply before changing ${what}.`);
    }
    if ((await agent.waiting.list(threadId)).length > 0) {
      throw new ChatRefusal(
        `Run or delete the waiting messages before changing ${what}.`,
      );
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

  /** A change to the waiting messages of the chat's thread. */
  async function withThread(
    chat: ChatRow,
    change: (threadId: string) => Promise<void>,
  ): Promise<void> {
    const threadId = threadOf(await latest(chat));
    if (threadId === null) {
      throw new ChatRefusal("That message isn't waiting any more.");
    }
    await change(threadId);
  }
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
