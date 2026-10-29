// Claude behind the provider boundary (@rufi/agents/provider): Rufi's agents
// on the Claude installed on this Mac, one process per open conversation
// (session.ts) under Rufi AI's lock-down (sandbox.ts). What became of an
// input rests only on what Claude shows: the turn that starts after it (its
// `system/init`), an assistant message or a result naming its id, or the ids
// an interrupt cancelled. A steer can outlive its turn: while one is with
// Claude, its process stays open, and when Claude takes it into a turn of
// its own, that turn starts with it. The process closes when a turn ends
// with nothing handing over, and the next turn carries the conversation on
// in a new one. Rufi's tools aren't given to Claude yet, so no call is
// placed.
import { randomUUID, type UUID } from "node:crypto";
import {
  deleteSession,
  getSessionInfo,
  getSessionMessages,
  query as sdkQuery,
  type EffortLevel,
  type ModelInfo,
  type SDKAssistantMessageError,
  type SDKControlInterruptResponse,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  Missing,
  NotOpened,
  type Conversation,
  type Delivery,
  type FailReason,
  type OpenOptions,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderModel,
  type Received,
  type SteerOutcome,
  type TurnEnd,
} from "@rufi/agents/provider";
import type { AgentSandbox } from "../runtime.ts";
import { within } from "./deadline.ts";
import { askClaude, signInOf, type InstalledClaude } from "./executable.ts";
import {
  openClaudeSession,
  type ClaudePlugin,
  type ClaudeSession,
} from "./session.ts";

/** How long Claude has to answer a question about itself. */
const ASK_MS = 15_000;
/** How long Claude has to show it started a turn with Rufi's message. */
const START_MS = 30_000;
/** How long Claude has to answer an interrupt, and then to end the turn. */
const STOP_MS = 10_000;

/** Claude's kept conversations, by the id Rufi gave each. */
export interface ClaudeSessions {
  /** Whether Claude keeps it: something when it does. */
  info: (id: string, dir?: string) => Promise<unknown>;
  /** The ids of the messages it keeps. */
  ids: (id: string, dir: string) => Promise<readonly string[]>;
  /** Throws when it isn't there. */
  delete: (id: string) => Promise<void>;
}

const SDK_SESSIONS: ClaudeSessions = {
  info: (id, dir) => getSessionInfo(id, dir === undefined ? {} : { dir }),
  ids: async (id, dir) =>
    (await getSessionMessages(id, { dir })).map((message) => message.uuid),
  delete: (id) => deleteSession(id),
};

export interface ClaudeAdapterOptions {
  claude: InstalledClaude;
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
  startMs?: number;
  stopMs?: number;
}

export function claudeAdapter(options: ClaudeAdapterOptions): ProviderAdapter {
  const sessions = options.sessions ?? SDK_SESSIONS;
  const conversations = new Set<Conversation>();
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
        await askClaude(options.claude, ask, (run) =>
          within(run.supportedModels(), ASK_MS, "its models"),
        ),
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
      const conversation = await openConversation(options, sessions, open);
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
    // Usage now comes from Claude's rate-limit events, with its items.
    usage: () => Promise.resolve([]),
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
  stopping: boolean;
  /** Claude's error in the turn, if it reported one. */
  error?: SDKAssistantMessageError;
  /** Resolves once its turnEnded is given. */
  ended: Promise<void>;
  end: () => void;
}

/** A steer with Claude, waiting for what Claude shows of it. */
interface Held {
  turn: string;
  settle: (outcome: SteerOutcome) => void;
}

class SignedOut extends Error {}

async function openConversation(
  options: ClaudeAdapterOptions,
  sessions: ClaudeSessions,
  open: OpenOptions,
): Promise<Conversation> {
  const ref = open.resume ?? randomUUID();
  const startMs = options.startMs ?? START_MS;
  const stopMs = options.stopMs ?? STOP_MS;
  let model = open.model;
  let effort = open.effort;
  /** Whether Claude keeps a message of it, so a new process resumes it. */
  let kept = open.resume !== undefined;
  let session: ClaudeSession | undefined;
  let pumped: Promise<void> = Promise.resolve();
  let running: Turn | undefined;
  /** A turn Claude began by itself, until its first answer names a steer. */
  let unclaimed: string | undefined;
  let starting:
    | { id: string; settle: (delivery: Delivery) => void }
    | undefined;
  const held = new Map<string, Held>();
  let rateLimit: SDKRateLimitInfo | undefined;

  const emit = (event: ProviderEvent) => {
    open.onEvent(event);
  };

  const settle = (id: string, outcome: SteerOutcome) => {
    const steer = held.get(id);
    if (steer === undefined) return;
    held.delete(id);
    steer.settle(outcome);
  };

  const begin = (turn: string, inputs: readonly string[]) => {
    let end = () => {};
    const ended = new Promise<void>((resolve) => (end = resolve));
    running = { ref: turn, stopping: false, ended, end };
    kept = true;
    emit({ type: "turnStarted", turn, inputs });
  };

  const finish = (end: TurnEnd) => {
    const turn = running;
    if (turn === undefined) return;
    running = undefined;
    emit({ type: "turnEnded", turn: turn.ref, end });
    turn.end();
  };

  /** Lets the process go once nothing is running or with Claude. */
  const idle = () => {
    if (running || starting || unclaimed || held.size > 0) return;
    void closeProcess();
  };

  const handle = (message: SDKMessage) => {
    if (message.type === "rate_limit_event") {
      rateLimit = message.rate_limit_info;
    } else if (message.type === "system" && message.subtype === "init") {
      if (starting) {
        const { id, settle: delivered } = starting;
        starting = undefined;
        begin(randomUUID(), [id]);
        delivered({ status: "delivered" });
      } else {
        unclaimed = randomUUID();
      }
    } else if (message.type === "assistant") {
      const ids =
        message.user_message_uuids ??
        (message.user_message_uuid === undefined
          ? []
          : [message.user_message_uuid]);
      if (unclaimed !== undefined && running === undefined) {
        const mine = ids.filter((id) => held.has(id));
        if (mine.length > 0) {
          const turn = unclaimed;
          unclaimed = undefined;
          begin(turn, mine);
          for (const id of mine) settle(id, { status: "next_turn", turn });
        }
      }
      if (running) {
        if (message.error !== undefined) running.error = message.error;
        settleTaken(ids, running.ref);
      }
    } else if (message.type === "result") {
      if (running) {
        settleTaken(
          message.user_message_uuids ??
            (message.user_message_uuid === undefined
              ? []
              : [message.user_message_uuid]),
          running.ref,
        );
        finish(endOf(message, running, rateLimit));
      }
      unclaimed = undefined;
      idle();
    }
  };

  const settleTaken = (ids: readonly string[], turn: string) => {
    for (const id of ids) {
      if (held.get(id)?.turn === turn) settle(id, { status: "delivered" });
    }
  };

  /** The process ended: by Rufi, or by itself (`died`, when it said why). */
  const ended = (current: ClaudeSession, died: unknown) => {
    if (session === current) session = undefined;
    if (running) {
      finish(
        running.stopping
          ? { status: "stopped" }
          : {
              status: "failed",
              reason: "process_died",
              ...(died !== undefined && { text: messageOf(died) }),
            },
      );
    }
    unclaimed = undefined;
    const start = starting;
    starting = undefined;
    start?.settle({
      status: "uncertain",
      text: "Claude ended before it showed it had the message.",
    });
    for (const id of held.keys()) {
      settle(id, {
        status: "uncertain",
        text: "Claude ended before it showed what became of the message.",
      });
    }
  };

  const pump = async (current: ClaudeSession) => {
    let died: unknown;
    try {
      for await (const message of current.messages) handle(message);
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
    } catch (error) {
      await closeProcess();
      throw error;
    }
    return current;
  };

  const closeProcess = async () => {
    const current = session;
    session = undefined;
    await current?.close();
    await pumped;
  };

  /** Settles a stopped turn's steers on what the interrupt answered. */
  const cancelled = (
    answer: SDKControlInterruptResponse | undefined,
    turn: string,
  ) => {
    for (const [id, steer] of held) {
      if (steer.turn !== turn) continue;
      settle(
        id,
        answer?.cancelled?.includes(id) === true
          ? { status: "not_delivered", text: "Stopped before Claude took it." }
          : {
              status: "uncertain",
              text: "Claude didn't say whether it took it before the stop.",
            },
      );
    }
  };

  const interrupt = async (current: ClaudeSession) =>
    within(current.interrupt(), stopMs, "the interrupt").catch(() => undefined);

  const stop = async (turn: string) => {
    const current = session;
    if (running?.ref === turn && current) {
      const stopping = running;
      stopping.stopping = true;
      cancelled(await interrupt(current), turn);
      const ends = await within(stopping.ended, stopMs, "the stop").then(
        () => true,
        () => false,
      );
      if (!ends) await closeProcess();
      await stopping.ended;
    } else if (current && [...held.values()].some((s) => s.turn === turn)) {
      cancelled(await interrupt(current), turn);
    }
    idle();
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
      if (running || starting || unclaimed || held.size > 0) {
        return { status: "not_delivered", text: "A turn is running." };
      }
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
      const delivery = new Promise<Delivery>((resolve) => {
        starting = { id: start.input.id, settle: resolve };
      });
      current.send(parts.join("\n\n"), start.input.id as UUID);
      const timer = setTimeout(() => {
        const lost = starting;
        if (lost?.id !== start.input.id) return;
        starting = undefined;
        lost.settle({
          status: "uncertain",
          text: "Claude didn't show it started the turn.",
        });
      }, startMs);
      return delivery.finally(() => {
        clearTimeout(timer);
      });
    },
    steer: (steer) => {
      const current = session;
      if (running?.ref !== steer.turn || current === undefined) {
        return Promise.resolve({
          status: "not_delivered",
          text: "Its turn had ended.",
        });
      }
      const outcome = new Promise<SteerOutcome>((resolve) => {
        held.set(steer.input.id, { turn: steer.turn, settle: resolve });
      });
      current.send(
        steer.input.parts.join("\n\n"),
        steer.input.id as UUID,
        true,
      );
      return outcome;
    },
    stop,
    reconcile: async (ids) => {
      const received = new Map<string, Received>();
      try {
        const keptIds = new Set(await sessions.ids(ref, open.cwd));
        for (const id of ids) {
          received.set(id, keptIds.has(id) ? "received" : "not_received");
        }
      } catch {
        for (const id of ids) received.set(id, "unknown");
      }
      return received;
    },
    placeCall: () => undefined,
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
  const reason = reasonOf(turn.error, rateLimit);
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
  error: SDKAssistantMessageError | undefined,
  rateLimit: SDKRateLimitInfo | undefined,
): FailReason {
  if (error === "authentication_failed" || error === "oauth_org_not_allowed") {
    return "signed_out";
  }
  if (error === "rate_limit") {
    return rateLimit?.status === "rejected" ? "usage_limit" : "rate_limit";
  }
  return "other";
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
