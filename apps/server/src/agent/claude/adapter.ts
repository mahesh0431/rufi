// Claude behind the provider boundary (@rufi/agents/provider): Rufi's agents
// on the Claude installed on this Mac, one process per open conversation
// (session.ts) under Rufi AI's lock-down (sandbox.ts), as T3 Code drives it.
// A message counts as sent once written to Claude, under a fresh uuid. Each
// turn shows when Claude begins it (its `system/init`), with the messages it
// names: Rufi's start, or a steer Claude held past the last turn's end. The
// process closes when a turn ends with nothing left with Claude, and the
// next turn carries the conversation on in a new one. What Claude does in a
// turn shows as its items, by its own ids, and the turn's usage once it ends
// (items.ts). A call to Rufi's tools carries Claude's id for it.
import { randomUUID, type UUID } from "node:crypto";
import {
  deleteSession,
  getSessionInfo,
  query as sdkQuery,
  type EffortLevel,
  type ModelInfo,
  type SDKAssistantMessageError,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Missing,
  NotOpened,
  type Conversation,
  type FailReason,
  type OpenOptions,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderModel,
  type TurnEnd,
} from "@rufi/agents/provider";
import type { AgentSandbox } from "../runtime.ts";
import { within } from "./deadline.ts";
import { askClaude, signInOf, type InstalledClaude } from "./executable.ts";
import {
  blocksOf,
  contextOf,
  lineOf,
  turnUsageOf,
  windowsOf,
  withoutImages,
  type Block,
  type Counts,
} from "./items.ts";
import {
  openClaudeSession,
  type ClaudePlugin,
  type ClaudeSession,
} from "./session.ts";

/** How long Claude has to answer a question about itself. */
const ASK_MS = 15_000;
/** How long Claude has to answer an interrupt. */
const STOP_MS = 10_000;
/** How long a conversation's process stays open with nothing to do (T3 Code's). */
const IDLE_MS = 30 * 60_000;
/** Where a call to Rufi's tools carries Claude's id for it. */
const TOOL_USE_ID = "claudecode/toolUseId";

/** Claude's kept conversations, by the id Rufi gave each. */
export interface ClaudeSessions {
  /** Whether Claude keeps it: something when it does. */
  info: (id: string, dir?: string) => Promise<unknown>;
  /** Throws when it isn't there. */
  delete: (id: string) => Promise<void>;
}

const SDK_SESSIONS: ClaudeSessions = {
  info: (id, dir) => getSessionInfo(id, dir === undefined ? {} : { dir }),
  delete: (id) => deleteSession(id),
};

export interface ClaudeAdapterOptions {
  /** The installed Claude, looked up when the adapter needs it (findClaude). */
  claude: () => Promise<InstalledClaude>;
  /**
   * Rufi AI's sandbox. Each conversation works in its own `cwd`, with the
   * same unreadable paths; Claude is asked about itself in the folder.
   */
  sandbox: AgentSandbox;
  /** Claude's environment, without Rufi's secrets (platform/config.ts). */
  env: Record<string, string>;
  plugin: ClaudePlugin;
  query?: typeof sdkQuery;
  sessions?: ClaudeSessions;
  stopMs?: number;
  idleMs?: number;
}

export function claudeAdapter(options: ClaudeAdapterOptions): ProviderAdapter {
  const sessions = options.sessions ?? SDK_SESSIONS;
  const conversations = new Set<Conversation>();
  const shared: Shared = {};
  const ask = {
    cwd: options.sandbox.folder,
    env: options.env,
    ...(options.query && { query: options.query }),
  };
  return {
    id: "claude",
    family: "anthropic",
    models: async () =>
      modelsOf(
        await askClaude(await options.claude(), ask, async (run) => {
          // Signed out, it offers none, as Codex does.
          const account = await within(
            run.accountInfo(),
            ASK_MS,
            "how it's signed in",
          );
          if (signInOf(account) === "none") {
            throw new SignedOut("Claude isn't signed in.");
          }
          return within(run.supportedModels(), ASK_MS, "its models");
        }),
      ),
    open: async (open) => {
      if (open.resume !== undefined) {
        const kept = await sessions
          .info(open.resume, open.cwd)
          .catch((error: unknown) => {
            throw new NotOpened("Claude couldn't look for the conversation.", {
              cause: error,
            });
          });
        if (kept === undefined) {
          throw new Missing("Claude doesn't keep this conversation.");
        }
      }
      const conversation = await openConversation(
        { ...options, claude: await options.claude() },
        sessions,
        shared,
        open,
      );
      conversations.add(conversation);
      const close = conversation.close;
      return {
        ...conversation,
        close: async () => {
          conversations.delete(conversation);
          await close();
        },
      };
    },
    delete: async (ref) => {
      try {
        await sessions.delete(ref);
      } catch (error) {
        if ((await sessions.info(ref)) !== undefined) throw error;
      }
    },
    // Claude says its limits with a turn's first request: none before one.
    usage: () => Promise.resolve(shared.limits ? windowsOf(shared.limits) : []),
    callOf: (meta) => {
      const call =
        typeof meta === "object" && meta !== null
          ? (meta as Record<string, unknown>)[TOOL_USE_ID]
          : undefined;
      return typeof call === "string" ? call : undefined;
    },
    close: async () => {
      await Promise.all([...conversations].map((each) => each.close()));
    },
  };
}

/**
 * Claude's models by their exact ids, never an alias such as `opus`, which
 * moves. Claude gives no default effort.
 */
function modelsOf(rows: readonly ModelInfo[]): ProviderModel[] {
  const models = new Map<string, ProviderModel>();
  for (const row of rows) {
    const id = row.resolvedModel ?? row.value;
    if (row.value === "default" || models.has(id)) continue;
    models.set(id, {
      id,
      name: row.displayName,
      efforts: row.supportedEffortLevels ?? [],
    });
  }
  return [...models.values()];
}

interface Turn {
  ref: string;
  /** Rufi stopped it: it ends stopped, however Claude ends it. */
  stopping: boolean;
  /** Claude's error in the turn, if it reported one. */
  error?: SDKAssistantMessageError;
  /** Claude's last request got no answer at all: no HTTP status. */
  unanswered?: boolean;
  /** Its tool calls, by Claude's ids, for their results' steps. */
  uses: Map<string, Block>;
  /** The context its last request used, and the model that answered. */
  context?: number;
  model?: string;
  /**
   * Its thinking blocks' items: each is its API message's id and its place
   * among that message's thinking, the same as it streams and once whole
   * (T3 Code's). The message streaming now, the items of its blocks
   * streaming now by their index, and how many each message began and
   * finished.
   */
  thinking: {
    message?: string;
    streaming: Map<number, string>;
    began: Map<string, number>;
    whole: Map<string, number>;
  };
}

/**
 * What Rufi reads of Claude's streaming events (the Messages API's): the
 * SDK types them from a package Rufi doesn't install.
 */
type StreamEvent =
  | { type: "message_start"; message: { id: string } }
  | {
      type: "content_block_start";
      index: number;
      content_block: { type: string; thinking?: string };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta: { type: string; thinking?: string };
    }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta" | "message_stop" };

const isThinking = (type: string | undefined) =>
  type === "thinking" || type === "redacted_thinking";

/** The item of a message's `n`th thinking block. */
const thinkingItem = (message: string, n: number) =>
  `${message}:thinking:${String(n)}`;

/** What the adapter's conversations share: Claude's latest limits. */
interface Shared {
  limits?: SDKRateLimitInfo;
}

class SignedOut extends Error {}

async function openConversation(
  options: Omit<ClaudeAdapterOptions, "claude"> & { claude: InstalledClaude },
  sessions: ClaudeSessions,
  shared: Shared,
  open: OpenOptions,
): Promise<Conversation> {
  const ref = open.resume ?? randomUUID();
  const stopMs = options.stopMs ?? STOP_MS;
  const idleMs = options.idleMs ?? IDLE_MS;
  /**
   * Closes the open process once it has rested long enough: not while a
   * turn runs (one Claude began by itself), whose end rests it again.
   */
  let resting: NodeJS.Timeout | undefined;
  const rest = () => {
    clearTimeout(resting);
    resting = setTimeout(() => {
      if (running === undefined && out.size === 0) void closeProcess();
    }, idleMs);
    resting.unref();
  };
  let model = open.model;
  let effort = open.effort;
  /** Whether Claude keeps a message of it, so a new process resumes it. */
  let kept = open.resume !== undefined;
  let session: ClaudeSession | undefined;
  /** The process Rufi is ending: what it had shows stopped. */
  let ending: ClaudeSession | undefined;
  let pumped: Promise<void> = Promise.resolve();
  let running: Turn | undefined;
  /** How many Stops are under way: a turn starting meanwhile is stopped too. */
  let stops = 0;
  /**
   * Rufi's ids for the messages it gave Claude, by the fresh uuid each went
   * under: Claude skips a uuid it has stored before, so a message sent
   * again would do nothing (T3 Code's `ClaudeAdapterV2.ts`).
   */
  const given = new Map<string, string>();
  /**
   * Messages given to this process that Claude hasn't named in a turn yet,
   * by their uuids: it stays open for them.
   */
  const out = new Set<string>();
  /** A new uuid for message `id`. */
  const fresh = (id: string): UUID => {
    const uuid = randomUUID();
    given.set(uuid, id);
    out.add(uuid);
    return uuid;
  };
  /** Rufi's ids for the uuids a frame of Claude's names; none for one not Rufi's. */
  const named = (frame: { user_message_uuids?: string[] }) => {
    const uuids = frame.user_message_uuids ?? [];
    for (const uuid of uuids) out.delete(uuid);
    return uuids.flatMap((uuid) => given.get(uuid) ?? []);
  };
  let rateLimit: SDKRateLimitInfo | undefined;

  const emit = (event: ProviderEvent) => {
    open.onEvent(event);
  };

  const begin = (inputs: readonly string[]) => {
    const turn = randomUUID();
    running = {
      ref: turn,
      stopping: stops > 0,
      uses: new Map(),
      thinking: { streaming: new Map(), began: new Map(), whole: new Map() },
    };
    kept = true;
    emit({ type: "turnStarted", turn, inputs });
  };

  const finish = (end: TurnEnd) => {
    const turn = running;
    if (turn === undefined) return;
    running = undefined;
    emit({ type: "turnEnded", turn: turn.ref, end });
  };

  const handle = (message: SDKMessage) => {
    if (message.type === "rate_limit_event") {
      rateLimit = message.rate_limit_info;
      shared.limits = message.rate_limit_info;
    } else if (
      message.type === "system" &&
      message.subtype === "compact_boundary"
    ) {
      if (running) {
        emit({
          type: "step",
          turn: running.ref,
          item: message.uuid,
          kind: "compaction",
          title: message.subtype,
          detail: message.compact_metadata.trigger,
          status: "done",
          payload: message.compact_metadata,
        });
      }
    } else if (message.type === "system" && message.subtype === "init") {
      // Each turn's init names the messages it took: Rufi's start, or a
      // steer Claude held past the last turn's end and began a turn with.
      const inputs = named(message as { user_message_uuids?: string[] });
      if (running === undefined) begin(inputs);
    } else if (message.type === "system" && message.subtype === "api_retry") {
      if (running) running.unanswered = message.error_status === null;
    } else if (message.type === "stream_event") {
      // Only to show: what Claude finishes replaces it.
      if (running && message.parent_tool_use_id === null) {
        streamed(running, message.event as StreamEvent);
      }
    } else if (message.type === "assistant") {
      named(message);
      if (running) {
        if (message.error === undefined) running.unanswered = false;
        else running.error = message.error;
        said(running, message.uuid, message.message);
      }
    } else if (message.type === "user") {
      if (running) answered(running, message.message);
    } else if (message.type === "result") {
      named(message);
      if (running) {
        if (running.context !== undefined) {
          const model = running.model && message.modelUsage[running.model];
          emit({
            type: "usage",
            turn: running.ref,
            tokens: running.context,
            window: model ? model.contextWindow : null,
          });
        }
        emit(turnUsageOf(running.ref, message.usage));
        const end = endOf(message, running, rateLimit);
        finish(end);
        // Signed out, it can do nothing more.
        if (end.status === "failed" && end.reason === "signed_out") {
          void closeProcess();
          return;
        }
      }
      // Nothing left with Claude: it stays open for the next turn a while.
      if (out.size === 0) rest();
    }
  };

  /** Claude's thinking as it writes it, by the item its whole block will have. */
  const streamed = (turn: Turn, event: StreamEvent) => {
    const { thinking } = turn;
    if (event.type === "message_start") {
      thinking.message = event.message.id;
      thinking.streaming.clear();
    } else if (
      event.type === "content_block_start" &&
      isThinking(event.content_block.type) &&
      thinking.message !== undefined
    ) {
      const n = thinking.began.get(thinking.message) ?? 0;
      thinking.began.set(thinking.message, n + 1);
      if (event.content_block.type !== "thinking") return;
      const item = thinkingItem(thinking.message, n);
      thinking.streaming.set(event.index, item);
      emit({
        type: "thinking",
        turn: turn.ref,
        item,
        delta: event.content_block.thinking ?? "",
      });
    } else if (
      event.type === "content_block_delta" &&
      event.delta.type === "thinking_delta"
    ) {
      const item = thinking.streaming.get(event.index);
      if (item === undefined) return;
      emit({
        type: "thinking",
        turn: turn.ref,
        item,
        delta: event.delta.thinking ?? "",
      });
    } else if (event.type === "content_block_stop") {
      thinking.streaming.delete(event.index);
    }
  };

  /** What an answer of Claude's holds: its text, thinking and tool calls. */
  const said = (turn: Turn, uuid: string, message: unknown) => {
    const { id } = message as { id?: string };
    for (const [index, block] of blocksOf(message).entries()) {
      let item = index === 0 ? uuid : `${uuid}/${String(index)}`;
      if (id !== undefined && isThinking(block.type)) {
        const n = turn.thinking.whole.get(id) ?? 0;
        turn.thinking.whole.set(id, n + 1);
        item = thinkingItem(id, n);
      }
      if (block.type === "text") {
        emit({
          type: "text",
          turn: turn.ref,
          item,
          delta: block.text ?? "",
          done: true,
        });
      } else if (
        block.type === "thinking" ||
        block.type === "redacted_thinking"
      ) {
        emit({
          type: "reasoning",
          turn: turn.ref,
          item,
          summary: block.thinking ?? "",
          payload: block,
        });
      } else if (block.type === "tool_use" && block.id !== undefined) {
        turn.uses.set(block.id, block);
        emit({
          type: "step",
          turn: turn.ref,
          item: block.id,
          ...lineOf(block),
          status: "running",
          payload: { use: block },
        });
      }
    }
    const { usage, model } = message as { usage?: Counts; model?: string };
    if (usage) turn.context = contextOf(usage);
    if (model) turn.model = model;
  };

  /** The results Claude's tools gave, each ending its step. */
  const answered = (turn: Turn, message: unknown) => {
    for (const block of blocksOf(message)) {
      if (block.type !== "tool_result" || block.tool_use_id === undefined) {
        continue;
      }
      const use = turn.uses.get(block.tool_use_id);
      emit({
        type: "step",
        turn: turn.ref,
        item: block.tool_use_id,
        ...lineOf(use ?? {}),
        status: block.is_error === true ? "failed" : "done",
        payload: { use, result: withoutImages(block) },
      });
    }
  };

  /**
   * The process ended: by Rufi, whose Stop or close stops what it had, or
   * by itself (`died`, when it said why). Messages it hadn't begun a turn
   * with show in one that ends as it did, so none waits for a turn.
   */
  const ended = (current: ClaudeSession, died: unknown) => {
    // One closed while idle may end after the next turn opened another.
    if (session !== undefined && session !== current) return;
    session = undefined;
    const end: TurnEnd =
      current === ending
        ? { status: "stopped" }
        : {
            status: "failed",
            reason: "process_died",
            ...(died !== undefined && { text: messageOf(died) }),
          };
    if (running) finish(running.stopping ? { status: "stopped" } : end);
    const unbegun = [...out].flatMap((uuid) => given.get(uuid) ?? []);
    out.clear();
    if (unbegun.length > 0) {
      begin(unbegun);
      finish(end);
    }
  };

  const pump = async (current: ClaudeSession) => {
    let died: unknown;
    try {
      for await (const message of current.messages) {
        handle(message);
      }
    } catch (error) {
      died = error;
    }
    ended(current, died);
  };

  /** The open process, after opening one and checking its sign-in. */
  const opened = async (): Promise<ClaudeSession> => {
    if (session) return session;
    const current = openClaudeSession({
      claude: options.claude,
      sandbox: { folder: open.cwd, unreadable: options.sandbox.unreadable },
      env: options.env,
      instructions: open.instructions,
      model,
      effort: effort as EffortLevel,
      conversation: kept ? { resume: ref } : { start: ref },
      plugin: options.plugin,
      ...(options.query && { query: options.query }),
    });
    session = current;
    pumped = pump(current);
    try {
      const account = await within(
        current.controls.accountInfo(),
        ASK_MS,
        "how it's signed in",
      );
      if (signInOf(account) === "none") {
        throw new SignedOut("Claude isn't signed in.");
      }
      await within(current.giveTools(open.tools), ASK_MS, "Rufi's tools");
    } catch (error) {
      await closeProcess();
      throw error;
    }
    return current;
  };

  const closeProcess = async () => {
    clearTimeout(resting);
    const current = session;
    session = undefined;
    ending = current;
    await current?.close();
    await pumped;
  };

  /**
   * Stops `turn`, as T3 Code does: interrupts Claude, then ends its
   * process, so nothing Claude took, also a turn it began by itself, runs
   * on. The next turn carries the conversation on in a new process.
   */
  const stop = async (turn: string) => {
    const current = session;
    if (current === undefined || running?.ref !== turn) return;
    stops++;
    try {
      running.stopping = true;
      await within(current.interrupt(), stopMs, "the interrupt").catch(
        () => undefined,
      );
      await closeProcess();
    } finally {
      stops--;
    }
  };

  try {
    await opened();
  } catch (error) {
    throw error instanceof SignedOut
      ? new NotOpened(error.message, { reason: "signed_out" })
      : new NotOpened("Claude couldn't open the conversation.", {
          cause: error,
        });
  }
  open.signal?.addEventListener("abort", () => {
    void conversation.close();
  });

  const conversation: Conversation = {
    ref,
    startTurn: async (start) => {
      if (running) {
        return { status: "not_delivered", text: "A turn is running." };
      }
      // A kept conversation goes on in a new process only if Claude still
      // keeps it (it deletes old ones): if not, only a new one can take it.
      if (session === undefined && kept) {
        const lost = await sessions.info(ref, open.cwd).then(
          (info) => info === undefined,
          () => false,
        );
        if (lost) {
          return {
            status: "not_delivered",
            reason: "missing",
            text: "Claude no longer keeps this conversation.",
          };
        }
      }
      clearTimeout(resting);
      let current: ClaudeSession;
      try {
        current = await opened();
        await within(current.controls.setModel(start.model), ASK_MS, "model");
        await within(
          current.controls.applyFlagSettings({
            effortLevel: start.effort as EffortLevel,
          }),
          ASK_MS,
          "effort",
        );
      } catch (error) {
        rest();
        return error instanceof SignedOut
          ? {
              status: "not_delivered",
              reason: "signed_out",
              text: error.message,
            }
          : {
              status: "not_delivered",
              text: `Claude didn't take the turn: ${messageOf(error)}`,
            };
      }
      model = start.model;
      effort = start.effort;
      const parts = [
        ...(open.seed !== undefined && !kept ? [open.seed] : []),
        ...start.input.parts,
      ];
      // Sent once written: its turn shows when Claude begins it.
      current.send(parts.join("\n\n"), fresh(start.input.id));
      return { status: "delivered" };
    },
    steer: (steer) => {
      const current = session;
      if (running?.ref !== steer.turn || current === undefined) {
        return Promise.resolve({
          status: "not_delivered",
          text: "Its turn had ended.",
        });
      }
      // Claude takes it into the turn once the tool running now ends, or,
      // held past the turn's end, begins its next turn with it.
      current.send(steer.input.parts.join("\n\n"), fresh(steer.input.id), true);
      return Promise.resolve({ status: "delivered" });
    },
    stop,
    close: async () => {
      if (running) await stop(running.ref);
      await closeProcess();
    },
  };
  return conversation;
}

/** How a turn ended, from its result and what Claude reported in it. */
function endOf(
  result: SDKResultMessage,
  turn: Turn,
  rateLimit: SDKRateLimitInfo | undefined,
): TurnEnd {
  if (turn.stopping) return { status: "stopped" };
  const text =
    result.subtype === "success" ? result.result : result.errors.join("\n");
  if (!result.is_error) return { status: "done", answer: text };
  const reason = reasonOf(turn, rateLimit);
  const resetsAt =
    reason === "usage_limit" && rateLimit?.resetsAt !== undefined
      ? new Date(rateLimit.resetsAt * 1000).toISOString()
      : undefined;
  return {
    status: "failed",
    reason,
    ...(text !== "" && { text }),
    ...(resetsAt !== undefined && { resetsAt }),
  };
}

function reasonOf(
  { error, unanswered }: Turn,
  rateLimit: SDKRateLimitInfo | undefined,
): FailReason {
  if (error === "authentication_failed" || error === "oauth_org_not_allowed") {
    return "signed_out";
  }
  if (error === "rate_limit") {
    return rateLimit?.status === "rejected" ? "usage_limit" : "rate_limit";
  }
  // A dropped network gives no HTTP status (ECONNREFUSED, behind a dead
  // proxy, on 2.1.312).
  if (unanswered === true) return "connection";
  return "other";
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
