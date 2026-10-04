// The chat: joins the agent and Rufi's transcripts. What the agent does is
// saved first and shown from what was saved; messages wait in the agent's own
// queue, and Rufi saves each one when the agent starts it.
import type { Conversation, WaitingMessage } from "@rufi/contracts";
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
import type { ConversationRow, Transcripts } from "../core/chat/transcript.ts";
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
    /** A caller for one turn of one person's conversation. */
    caller: (
      personId: string,
      conversationId: string,
    ) => (name: string, input: unknown) => Promise<ToolAnswer>;
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
  /** One action at a time per conversation (send, steer, run now). */
  const lanes = new Map<string, Promise<unknown>>();
  /** Actions under way, so Stop can end them while they get ready. */
  const acting = new Map<string, Set<AbortController>>();
  /** A new thread's earlier conversation, until its first message is sent. */
  const pendingContext = new Map<string, string>();
  /** Steers sent, so their message is saved as a steer; by message id. */
  const steers = new Map<string, string>(); // message id -> thread id
  /** Each running turn's tool caller, by thread. */
  const callers = new Map<
    string,
    {
      turnId: string;
      call: (name: string, input: unknown) => Promise<ToolAnswer>;
    }
  >();
  /** Messages already given their reply text, so a question starts a new paragraph. */
  const replied = new Set<string>();
  const waitingListeners = new Map<string, Set<() => void>>();
  /** Turns with a part Rufi couldn't save: stopped, and ended as failed. */
  const unsaved = new Set<string>();

  const host: AgentHost = {
    onEvent: (event) => {
      saving = saving.then(() =>
        save(event).catch((error: unknown) => {
          log("chat.save_failed", {
            kind: event.type,
            error: errorCode(error),
          });
          // A transcript with a hole is never shown as a whole reply.
          if (
            event.type === "waitingChanged" ||
            event.type === "turnEnded" ||
            unsaved.has(event.turnId)
          ) {
            return;
          }
          unsaved.add(event.turnId);
          agent
            .stop(event.threadId, event.turnId)
            .catch((stopError: unknown) => {
              log("chat.save_failed", {
                kind: "stop",
                error: errorCode(stopError),
              });
            });
        }),
      );
    },
    callTool: async (threadId, turnId, name, input) => {
      let caller = callers.get(threadId);
      if (caller?.turnId !== turnId) {
        const conversation = await transcripts.byThread(threadId);
        if (!conversation) {
          return {
            ok: false,
            text: JSON.stringify({
              ok: false,
              error: "No conversation is open.",
            }),
          };
        }
        caller = {
          turnId,
          call: deps.tools.caller(conversation.personId, conversation.id),
        };
        callers.set(threadId, caller);
      }
      return caller.call(name, input);
    },
  };
  const agent = deps.agent(host);

  /** Stores one agent event; listeners see it once stored. */
  async function save(event: AgentEvent): Promise<void> {
    const conversation = await transcripts.byThread(event.threadId);
    if (!conversation) {
      log("chat.unknown_thread", { kind: event.type });
      return;
    }
    if (event.type !== "waitingChanged" && unsaved.has(event.turnId)) {
      // What was saved stays as it is; nothing more of this reply is added.
      if (event.type !== "turnEnded") return;
      unsaved.delete(event.turnId);
      await transcripts.endTurn(conversation, event.turnId, {
        status: "failed",
        reason: "save_failed",
        text: "Rufi couldn't save all of this reply, so it stopped it.",
      });
      return;
    }
    switch (event.type) {
      case "turnStarted":
        await transcripts.startTurn(
          conversation,
          event.turnId,
          conversation.threadModel ?? conversation.model,
        );
        return;
      case "message": {
        const steer = steers.delete(event.id);
        await transcripts.addMessage(conversation, {
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
          conversation,
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
        await transcripts.appendReply(
          conversation,
          event.turnId,
          event.itemId,
          text,
        );
        return;
      }
      case "activity":
        await transcripts.setActivity(
          conversation,
          event.turnId,
          event.itemId,
          {
            activity: event.activity,
            title: event.title,
            ...(event.detail !== undefined && { detail: event.detail }),
            status: event.status,
          },
        );
        return;
      case "turnEnded":
        if (callers.get(event.threadId)?.turnId === event.turnId) {
          callers.delete(event.threadId);
        }
        for (const [id, threadId] of steers) {
          if (threadId === event.threadId) steers.delete(id);
        }
        await transcripts.endTurn(conversation, event.turnId, event.end);
        return;
      case "waitingChanged":
        for (const listener of waitingListeners.get(conversation.id) ?? []) {
          listener();
        }
        return;
    }
  }

  /**
   * The conversation as stored now: an earlier action may have given it a
   * new thread or model since the request read it.
   */
  async function latest(
    conversation: ConversationRow,
  ): Promise<ConversationRow> {
    const row = await transcripts.conversation(
      conversation.personId,
      conversation.id,
    );
    if (!row) throw new ChatRefusal("That conversation isn't there any more.");
    return row;
  }

  /**
   * Runs `action` after the conversation's earlier actions, on the
   * conversation as stored then; Stop can end it.
   */
  function inLane<T>(
    conversation: ConversationRow,
    action: (fresh: ConversationRow, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const op = new AbortController();
    const ops = acting.get(conversation.id) ?? new Set();
    ops.add(op);
    acting.set(conversation.id, ops);
    const previous = lanes.get(conversation.id) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const fresh = await latest(conversation);
        if (op.signal.aborted) throw new Stopped();
        return action(fresh, op.signal);
      })
      .finally(() => {
        ops.delete(op);
        if (lanes.get(conversation.id) === run) lanes.delete(conversation.id);
      });
    lanes.set(conversation.id, run);
    return run;
  }

  async function settings(
    conversation: ConversationRow,
  ): Promise<ThreadSettings> {
    const region = await transcripts.setting("emergency_region");
    return {
      model: conversation.model,
      instructions: `${safetyInstructions(region)}\n\n${deps.tools.instructions}`,
    };
  }

  /** Whether the conversation's thread can go on: same agent, model and tools. */
  const current = (conversation: ConversationRow) =>
    conversation.threadId !== null &&
    conversation.threadProvider === agent.provider &&
    conversation.threadModel === conversation.model &&
    conversation.threadTools === deps.tools.version;

  /**
   * The conversation's thread, open in the agent. A thread is picked up again
   * only here, when the person acts; a new one starts when it's missing, can't
   * be resumed, or the agent, model or tools changed.
   */
  async function threadFor(
    conversation: ConversationRow,
    signal: AbortSignal,
  ): Promise<string> {
    const threadSettings = await settings(conversation);
    if (current(conversation) && conversation.threadId !== null) {
      const threadId = conversation.threadId;
      if (agent.loaded(threadId)) return threadId;
      try {
        await agent.resumeThread(threadId, threadSettings, signal);
        // What a crash kept Rufi from saving, from the agent's own record.
        fillGaps(conversation, threadId);
        return threadId;
      } catch (error) {
        if (error instanceof Stopped) throw error;
        log("chat.resume_failed", { error: errorCode(error) });
      }
    }
    // The old thread's events are saved first: once the pointer moves, they
    // can't find the conversation, and the new thread's seed needs them.
    await saving;
    const modelChanged =
      conversation.threadModel !== null &&
      conversation.threadModel !== conversation.model;
    const { threadId, model } = await agent.startThread(threadSettings, signal);
    await transcripts.setThread(conversation, {
      id: threadId,
      provider: agent.provider,
      model,
      tools: deps.tools.version,
    });
    conversation.threadId = threadId;
    conversation.threadProvider = agent.provider;
    conversation.threadModel = model;
    conversation.threadTools = deps.tools.version;
    const earlier = await transcripts.lastMessages(
      conversation,
      NEW_THREAD_MESSAGES,
    );
    if (earlier.length > 0) {
      pendingContext.set(
        conversation.id,
        newThreadContext(earlier, modelChanged),
      );
    } else {
      pendingContext.delete(conversation.id);
    }
    return threadId;
  }

  /**
   * Saves the messages the thread ran that Rufi has not, in line with the
   * events, so a message is never saved twice. A failure is logged; the
   * thread goes on.
   */
  function fillGaps(conversation: ConversationRow, threadId: string): void {
    const fill = async () => {
      for (const message of await agent.startedMessages(threadId)) {
        if (await transcripts.hasMessage(message.id)) continue;
        await transcripts.addMessage(conversation, {
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

  /** The conversation's thread, when it is the agent's (no new one is made). */
  const threadOf = (conversation: ConversationRow) =>
    current(conversation) ? conversation.threadId : null;

  return {
    agent,

    /** The allowed models the provider offers now, and any allowlist problem. */
    models: offered,

    /** A new conversation on the first allowed model the provider offers. */
    create: async (personId: string, title: string): Promise<Conversation> => {
      const model = (await offered()).models[0]?.id;
      if (model === undefined) {
        throw new ChatRefusal("None of the allowed models is offered now.");
      }
      const row = await transcripts.createConversation(
        personId,
        title,
        agent.provider,
        model,
      );
      const { id, provider, createdAt } = row;
      return { id, title, provider, model, createdAt };
    },

    /**
     * Sends a message: it runs now, or waits its turn in the agent's queue.
     * It enters the transcript when the agent starts it.
     */
    send: (conversation: ConversationRow, text: string) =>
      inLane(conversation, async (conversation, signal) => {
        const threadId = await threadFor(conversation, signal);
        const id = uuid();
        const context = pendingContext.get(conversation.id);
        await agent.send(
          threadId,
          { id, text, ...(context !== undefined && { context }) },
          signal,
        );
        pendingContext.delete(conversation.id);
        return { id };
      }),

    /** Passes a message into the running reply; saved as a steer. */
    steer: (conversation: ConversationRow, text: string) =>
      inLane(conversation, async (conversation) => {
        const threadId = threadOf(conversation);
        if (threadId === null || !agent.running(threadId)) {
          throw new ChatRefusal("No reply is running to steer.");
        }
        const id = uuid();
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
          transcripts.addMessage(conversation, {
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
    stop: async (conversation: ConversationRow) => {
      for (const op of acting.get(conversation.id) ?? []) op.abort();
      const threadId = threadOf(await latest(conversation));
      if (threadId !== null) await agent.stop(threadId);
    },

    waiting: {
      list: async (
        conversation: ConversationRow,
      ): Promise<WaitingMessage[]> => {
        const threadId = threadOf(await latest(conversation));
        return threadId === null ? [] : agent.waiting.list(threadId);
      },
      edit: (conversation: ConversationRow, id: string, text: string) =>
        withThread(conversation, (threadId) =>
          agent.waiting.edit(threadId, id, text),
        ),
      remove: (conversation: ConversationRow, id: string) =>
        withThread(conversation, (threadId) =>
          agent.waiting.remove(threadId, id),
        ),
      reorder: (conversation: ConversationRow, ids: string[]) =>
        withThread(conversation, (threadId) =>
          agent.waiting.reorder(threadId, ids),
        ),
      /** Runs one now; this is the person acting, so the thread is picked up. */
      runNow: (conversation: ConversationRow, id: string) =>
        inLane(conversation, async (conversation, signal) => {
          const threadId = threadOf(conversation);
          if (threadId === null) {
            throw new ChatRefusal("That message isn't waiting any more.");
          }
          if (!agent.loaded(threadId)) {
            await agent.resumeThread(
              threadId,
              await settings(conversation),
              signal,
            );
            fillGaps(conversation, threadId);
          }
          await agent.waiting.runNow(threadId, id, signal);
        }),
      subscribe: (conversationId: string, listener: () => void) => {
        const set = waitingListeners.get(conversationId) ?? new Set();
        set.add(listener);
        waitingListeners.set(conversationId, set);
        return () => {
          set.delete(listener);
          if (set.size === 0) waitingListeners.delete(conversationId);
        };
      },
    },

    /**
     * Chooses the conversation's model. Only when no reply runs and no
     * message waits: the new model comes with a new thread.
     */
    selectModel: (conversation: ConversationRow, model: string) =>
      inLane(conversation, async (conversation) => {
        const { models } = await offered();
        if (!models.some((m) => m.id === model)) {
          throw new ChatRefusal(
            "That model isn't allowed or isn't offered now.",
          );
        }
        const threadId = threadOf(conversation);
        // What the thread did is saved before the model changes.
        await saving;
        if (threadId !== null) {
          if (agent.running(threadId)) {
            throw new ChatRefusal("Stop the reply before changing the model.");
          }
          if ((await agent.waiting.list(threadId)).length > 0) {
            throw new ChatRefusal(
              "Run or delete the waiting messages before changing the model.",
            );
          }
        }
        await transcripts.setModel(conversation, model);
      }),

    /** Waits for what is being saved, then ends the agent. */
    close: async () => {
      await agent.close();
      await saving;
    },
  };

  async function offered(): Promise<{ models: Model[]; error?: string }> {
    const allowlist = await deps.allowlist();
    const models = allowedModels(await agent.models(), allowlist.models);
    return {
      models,
      ...(allowlist.error !== undefined && { error: allowlist.error }),
    };
  }

  /** A change to the waiting messages of the conversation's thread. */
  async function withThread(
    conversation: ConversationRow,
    change: (threadId: string) => Promise<void>,
  ): Promise<void> {
    const threadId = threadOf(await latest(conversation));
    if (threadId === null) {
      throw new ChatRefusal("That message isn't waiting any more.");
    }
    await change(threadId);
  }
}

/** What a new thread is told first: the note, then the last messages. */
function newThreadContext(
  earlier: readonly { from: "user" | "ai"; text: string }[],
  modelChanged: boolean,
): string {
  const note = `${modelChanged ? "The model changed and a new thread started." : "A new thread started."} Older history is available through read_conversation.`;
  const messages = earlier
    .map(({ from, text }) => `${from === "user" ? "User" : "AI"}: ${text}`)
    .join("\n\n");
  return `${note}\n\nThe last messages of this conversation, oldest first:\n\n${messages}`;
}
