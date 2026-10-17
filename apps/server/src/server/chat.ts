// The chat: joins the agent and Rufi's transcripts. What the agent does is
// saved first and shown from what was saved. What waits to go to the AI is
// in Rufi's own queue (core/chat/queue.ts): the dispatcher here hands the AI
// one turn's rows at a time, claimed in the database before the AI is
// called, and the next only after that turn and its writes have ended. The
// AI calls Rufi's tools through Rufi's MCP server, with a key for its thread;
// each call is bound to the reply it was made in.
import {
  SIGNED_OUT,
  type Chip,
  type Effort,
  type Pointer,
} from "@rufi/contracts";
import {
  NotOpened,
  NotSent,
  Stopped,
  ThreadNotFound,
  type AgentEvent,
  type AgentHost,
  type AgentRuntime,
  type Model,
  type ThreadSettings,
} from "../agent/runtime.ts";
import { rulesNote } from "../core/chat/instructions.ts";
import { allowedModels } from "../core/chat/models.ts";
import {
  QueueRefusal,
  type ChatQueue,
  type HandOver,
} from "../core/chat/queue.ts";
import { refsForAi, RefRefusal } from "../core/chat/refs.ts";
import type { ChatRow, Transcripts } from "../core/chat/transcript.ts";
import type { ToolAnswer, ToolSpec } from "../core/tools/registry.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import type { McpCall, McpKeys } from "./mcp.ts";

/** How many earlier messages a new thread starts with. */
const NEW_THREAD_MESSAGES = 10;

export interface ChatDeps {
  transcripts: Transcripts;
  queue: ChatQueue;
  /** Whether the AI can be reached with the person's sign-in now. */
  signedIn: () => Promise<boolean>;
  /** Makes the agent, given where its events go. */
  agent: (host: AgentHost) => AgentRuntime;
  allowlist: readonly string[];
  /** Rufi's MCP endpoint for the chat: its address and its keys. */
  mcp: { url: () => string; keys: McpKeys };
  /**
   * What the AI is told in every thread, for the emergency region chosen,
   * and its version: a thread told another version is told again.
   */
  rules: (region: string | undefined) => {
    instructions: string;
    version: string;
  };
  tools: {
    /** What the MCP server lists. */
    specs: readonly ToolSpec[];
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
  /** Each thread's key to Rufi's MCP server, for this run of Rufi. */
  const keys = new Map<string, string>();
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
          // A transcript with a hole is never shown as a whole reply; the
          // context used is no part of it.
          if (event.type === "turnEnded" || event.type === "usage") return;
          lost(event.threadId, event.turnId);
        }),
      );
    },
  };

  /**
   * One call to Rufi's tools through the MCP server, with a key of `chatId`.
   * It is admitted only for the reply running in the chat's thread now, and
   * not once Stop was pressed; it then runs for that reply, whatever comes
   * after. Origin and what the reply may do come from Rufi's own record.
   */
  async function callTool(chatId: string, call: McpCall): Promise<ToolAnswer> {
    const { threadId, turnId, callId } = call;
    const refuse = (reason: "no_call" | "no_reply", error: string) => {
      log("mcp.refused", { reason });
      return { ok: false, text: JSON.stringify({ ok: false, error }) };
    };
    if (
      threadId === undefined ||
      turnId === undefined ||
      callId === undefined
    ) {
      return refuse("no_call", "Rufi's tools take calls only from a reply.");
    }
    if (agent.activeTurn(threadId) !== turnId) {
      return refuse("no_reply", "No reply is running.");
    }
    // What the agent did before the call is stored first: the user's
    // message a save rests on, and the turn its receipt belongs to.
    await saving;
    let caller = callers.get(threadId);
    if (caller?.turnId !== turnId) {
      const chat = await transcripts.byThread(threadId);
      if (!chat) return refuse("no_reply", "No reply is running.");
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
    // The thread is the key's own chat's, also for a caller kept from before.
    if (caller.chat.id !== chatId) {
      return refuse("no_reply", "No reply is running.");
    }
    const startedAt = transcripts.now();
    const answer = await caller.call(call.tool, call.input, callId);
    // Kept before the AI has it: Rufi keeps every answer the AI got.
    try {
      await transcripts.recordToolCall(caller.chat, turnId, {
        callId,
        tool: call.tool,
        input: call.input,
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
    if (answer.stopTurn !== undefined) {
      agent
        .stop(threadId, turnId, { status: "failed", text: answer.stopTurn })
        .catch((error: unknown) => {
          log("chat.save_failed", { kind: "stop", error: errorCode(error) });
        });
    }
    return answer;
  }

  /** A key that opens the chat's tools, for one of its threads. */
  const issueKey = (chat: ChatRow) =>
    deps.mcp.keys.issue({
      tools: deps.tools.specs,
      call: (call) => callTool(chat.id, call),
    });

  /** The thread's tools: its key from this run, or a new one. */
  function toolsOf(chat: ChatRow, threadId: string) {
    let key = keys.get(threadId);
    if (key === undefined) {
      key = issueKey(chat);
      keys.set(threadId, key);
    }
    return { url: deps.mcp.url(), key };
  }

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
        // The model it was sent with: the chat's, which can't change while
        // a reply starts or runs.
        await transcripts.startTurn(
          chat,
          event.turnId,
          { id: event.threadId, model: chat.model ?? chat.threadModel ?? "" },
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
      case "note":
        await transcripts.appendNote(
          chat,
          event.turnId,
          event.itemId,
          event.delta,
          event.done === true,
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
      case "usage":
        await transcripts.setContext(chat, event.threadId, {
          tokens: event.tokens,
          window: event.window,
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
   * wait again, the person's held with the reason; when the AI's thread
   * didn't open, for the person to choose Try again or New thread), or
   * nobody knows (not sure, and the chat pauses).
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
          const models = await offered();
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
          error instanceof NotOpened,
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
            // A new model goes with the next reply, in the same thread.
            ...(fresh.model !== null && { model: fresh.model }),
            effort: fresh.effort,
          },
          signal,
        );
        pendingContext.delete(fresh.id);
      } catch (error) {
        if (error instanceof NotSent) {
          handing.delete(threadId);
          const stopped = error.cause instanceof Stopped || closed;
          // Codex was replaced and the thread is gone: the rows wait again,
          // and their next hand-over starts a new thread.
          const gone = error.cause instanceof ThreadNotFound;
          await queue.notTaken(
            fresh,
            handOver.id,
            stopped || gone ? undefined : error.message,
            error.cause instanceof NotOpened,
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

  /** What the chat's thread is given now, and the version of its rules. */
  async function settings(
    chat: ChatRow,
  ): Promise<{ settings: ThreadSettings; version: string }> {
    const { instructions, version } = deps.rules(
      await transcripts.setting("emergency_region"),
    );
    return {
      settings: {
        // Set before a thread starts: the first message chooses one.
        model: chat.model ?? "",
        effort: chat.effort,
        instructions,
      },
      version,
    };
  }

  /**
   * Whether the chat's thread is the agent's. A thread keeps its tools from
   * Rufi's MCP server and takes a new model with a reply, so neither starts
   * a new one.
   */
  const current = (chat: ChatRow) =>
    chat.threadId !== null && chat.threadProvider === agent.provider;

  /**
   * The chat's thread, open in the agent and told the current rules. A
   * thread is picked up again only here, when the person acts: told again
   * when its rules changed (a Rufi update, a new emergency region), and a
   * new one starts only when the chat has none (a move, the person's New
   * thread), it is another agent's, or the agent has no such thread. Any
   * other failure to open it throws NotOpened: the message waits for the
   * person's choice.
   */
  async function threadFor(
    chat: ChatRow,
    signal: AbortSignal,
  ): Promise<string> {
    const { settings: threadSettings, version } = await settings(chat);
    if (current(chat) && chat.threadId !== null) {
      const threadId = chat.threadId;
      const told = chat.threadTools === version;
      if (told && agent.loaded(threadId)) return threadId;
      const wasLoaded = agent.loaded(threadId);
      const resumed = { ...threadSettings, tools: toolsOf(chat, threadId) };
      try {
        if (told) {
          await agent.resumeThread(threadId, resumed, signal);
        } else {
          await agent.reloadThread(
            threadId,
            resumed,
            rulesNote(threadSettings.instructions),
            signal,
          );
          await transcripts.setThreadRules(chat, version);
          chat.threadTools = version;
        }
        // What a crash kept Rufi from saving, from the agent's own record.
        if (!wasLoaded) fillGaps(chat, threadId);
        return threadId;
      } catch (error) {
        // Only a thread the agent has no record of is replaced; any other
        // failure holds the message (NotOpened: for the person's choice).
        if (!(error instanceof ThreadNotFound)) throw error;
        log("chat.resume_failed", { error: errorCode(error) });
      }
    }
    // The old thread's events are saved first: once the pointer moves, they
    // can't find the chat, and the new thread's seed needs them.
    await saving;
    const key = issueKey(chat);
    let started: { threadId: string; model: string };
    try {
      started = await agent.startThread(
        { ...threadSettings, tools: { url: deps.mcp.url(), key } },
        signal,
      );
    } catch (error) {
      deps.mcp.keys.revoke(key);
      throw error;
    }
    const { threadId, model } = started;
    // The old thread's key opens nothing any more.
    const old = chat.threadId === null ? undefined : keys.get(chat.threadId);
    if (old !== undefined) deps.mcp.keys.revoke(old);
    if (chat.threadId !== null) keys.delete(chat.threadId);
    keys.set(threadId, key);
    await transcripts.setThread(chat, {
      id: threadId,
      provider: agent.provider,
      model,
      tools: version,
    });
    chat.threadId = threadId;
    chat.threadProvider = agent.provider;
    chat.threadModel = model;
    chat.threadTools = version;
    const earlier = await transcripts.lastMessages(chat, NEW_THREAD_MESSAGES);
    if (earlier.length > 0) {
      pendingContext.set(chat.id, newThreadContext(earlier));
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
        // The hand-over starting now is no gap: it is saved with its turn,
        // where a save in that turn finds the user's message.
        if (handing.get(threadId) === message.id) continue;
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

    /** The allowed models the provider offers now. */
    models: offered,

    /**
     * Takes a message and its references into the queue by the send's id,
     * and empties the box, in one step; it goes to the AI in its turn. The
     * same id again finds the message it made. Signed out, nothing is
     * taken: the text stays in the box.
     */
    send: async (
      chat: ChatRow,
      id: string,
      text: string,
      refs: readonly Pointer[] = [],
    ) => {
      await mustBeSignedIn();
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
        await mustBeSignedIn();
        await refused(() => queue.sendNow(chat, id));
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
        await mustBeSignedIn();
        await inLane(chat, async (fresh) => {
          const newThread = choice === "new_thread";
          // Never while a reply runs: it would lose that reply's thread. The
          // hold stays, and the screens read the queue again.
          if (newThread && (await busy(fresh))) {
            queue.changed(fresh.id);
            return;
          }
          await refused(() => queue.recover(fresh, id, hold, newThread));
          // The old thread's key opens nothing any more.
          const old = fresh.threadId;
          if (newThread && old !== null) {
            const key = keys.get(old);
            if (key !== undefined) deps.mcp.keys.revoke(key);
            keys.delete(old);
          }
        });
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
     * the next reply runs on it, in the same thread.
     */
    selectModel: (chat: ChatRow, model: string) =>
      inLane(chat, async (chat) => {
        const models = await offered();
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

  /** Whether a reply runs or is starting; what the thread did is saved first. */
  async function busy(chat: ChatRow): Promise<boolean> {
    const threadId = threadOf(chat);
    await saving;
    const { items } = await queue.list(chat);
    return (
      (threadId !== null && agent.running(threadId)) ||
      items.some((item) => item.state === "handing_over")
    );
  }

  /** Refuses to change `what` while a reply runs or is starting. */
  async function idle(chat: ChatRow, what: string): Promise<void> {
    if (await busy(chat)) {
      throw new ChatRefusal(`Stop the reply before changing ${what}.`);
    }
  }

  async function offered(): Promise<Model[]> {
    return allowedModels(await agent.models(), deps.allowlist);
  }

  /** Without a sign-in, nothing the person sends is taken. */
  async function mustBeSignedIn(): Promise<void> {
    if (!(await deps.signedIn())) throw new ChatRefusal(SIGNED_OUT);
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

const WHO = {
  user: "User",
  ai: "AI",
  note: "AI (a progress note)",
  rufi: "Rufi",
} as const;

/** What a new thread is told first: the note, then the last messages. */
function newThreadContext(
  earlier: readonly {
    from: keyof typeof WHO;
    text: string;
    unfinished?: boolean;
  }[],
): string {
  const note =
    "A new thread started. Older history is available through read_chat.";
  const messages = earlier
    .map(
      ({ from, text, unfinished }) =>
        `${WHO[from]}${unfinished ? " (this reply didn't finish)" : ""}: ${text}`,
    )
    .join("\n\n");
  return `${note}\n\nThe last messages of this chat, oldest first:\n\n${messages}`;
}
