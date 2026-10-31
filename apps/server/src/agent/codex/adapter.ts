// Codex behind the provider boundary (@rufi/agents/provider): the agent
// system's conversations run as Codex threads on one shared app-server,
// through the same runtime as the chat (codex.ts). A start or a steer that
// Codex surely didn't get is not delivered; one whose answer was lost is
// uncertain, and Codex's thread tells later whether it arrived. A call to
// Rufi's tools is placed in its turn by the turn id and call id Codex gives
// in its `_meta`.
import {
  Missing,
  NotOpened,
  type Conversation,
  type FailReason,
  type OpenOptions,
  type ProviderAdapter,
  type ProviderEvent,
  type Received,
  type StepKind,
  type TurnEnd as ProviderTurnEnd,
  type UsageWindow,
} from "@rufi/agents/provider";
import { errorCode, type Log } from "../../platform/logs.ts";
import { ChatGptError } from "../chatgpt/openai.ts";
import {
  NotSent,
  ThreadNotFound,
  type ActivityKind,
  type AgentEvent,
  type ThreadSettings,
  type TurnEnd,
} from "../runtime.ts";
import { codexRuntime, type CodexDeps } from "./codex.ts";
import { callOf } from "./events.ts";
import type { RateLimitWindow } from "./protocol/v2/RateLimitWindow.ts";

/** Sign-in failures that only signing in again ends. */
const SIGNED_OUT = new Set(["not_signed_in", "sign_in_again", "plan_use_off"]);

/** Whether `error`, or what caused it, says Rufi is signed out of ChatGPT. */
function signedOut(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof ChatGptError && SIGNED_OUT.has(cause.code)) {
      return true;
    }
  }
  return false;
}

const textOf = (error: unknown) =>
  error instanceof Error ? error.message : "Codex couldn't take it.";

/**
 * What a resumed conversation is told: Codex's history still holds the
 * instructions it was given before (docs/adr/0018), so they come again
 * whole, saying they replace those.
 */
export const instructionsNote = (instructions: string) =>
  `Your instructions, given again as this conversation is opened. They replace any given before. Skills may have changed too: read a skill's SKILL.md again before you use it.\n\n${instructions}`;

/** Whether `error`, or what caused it, says Codex has no such thread. */
function missing(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof ThreadNotFound) return true;
  }
  return false;
}

/** An open conversation, as the adapter keeps it. */
interface Open {
  onEvent: (event: ProviderEvent) => void;
  /** Earlier history, until the first input that reached Codex carries it. */
  seed: string | undefined;
  /**
   * A new thread's start, until its first input: they share Codex's
   * readiness, as Codex has nothing of the thread to resume until then.
   */
  preparing: AbortSignal | undefined;
  /** The input of a start that hasn't shown its turn yet. */
  starting: string | undefined;
  /** The running turn's answer messages so far, by item, in order. */
  answers: Map<string, string>;
}

export function codexAdapter(
  deps: Omit<CodexDeps, "host"> & { log?: Log },
): ProviderAdapter {
  const log = deps.log ?? (() => undefined);
  const conversations = new Map<string, Open>();
  const runtime = codexRuntime({
    ...deps,
    host: {
      onEvent: (event) => {
        const open = conversations.get(event.threadId);
        if (open) relay(open, event);
      },
    },
  });

  function relay(open: Open, event: AgentEvent): void {
    const emit = open.onEvent;
    switch (event.type) {
      case "turnStarted":
        open.answers.clear();
        emit({
          type: "turnStarted",
          turn: event.turnId,
          inputs: open.starting === undefined ? [] : [open.starting],
        });
        open.starting = undefined;
        return;
      // The inputs' outcomes say what reached Codex.
      case "message":
        return;
      case "text":
        open.answers.set(
          event.itemId,
          (open.answers.get(event.itemId) ?? "") + event.delta,
        );
        emit({
          type: "text",
          turn: event.turnId,
          item: event.itemId,
          delta: event.delta,
          ...(event.done && { done: true }),
        });
        return;
      case "note":
        emit({
          type: "note",
          turn: event.turnId,
          item: event.itemId,
          delta: event.delta,
          ...(event.done && { done: true }),
        });
        return;
      case "question":
        emit({
          type: "question",
          turn: event.turnId,
          item: event.itemId,
          title: event.title,
          options: event.options,
        });
        return;
      case "thinking":
        emit({
          type: "thinking",
          turn: event.turnId,
          item: event.itemId,
          delta: event.delta,
        });
        return;
      case "reasoning":
        emit({
          type: "reasoning",
          turn: event.turnId,
          item: event.itemId,
          summary: event.summary,
          payload: event.details,
        });
        return;
      case "activity":
        emit({
          type: "step",
          turn: event.turnId,
          item: event.itemId,
          kind: kindOf(event.activity),
          title: event.title,
          ...(event.detail !== undefined && { detail: event.detail }),
          status: event.status,
          ...(event.details !== undefined && { payload: event.details }),
        });
        return;
      case "usage":
        emit({
          type: "usage",
          turn: event.turnId,
          tokens: event.tokens,
          window: event.window,
        });
        return;
      case "turnEnded":
        emit({
          type: "turnEnded",
          turn: event.turnId,
          end: endOf(event.end, [...open.answers.values()].at(-1) ?? ""),
        });
        open.answers.clear();
    }
  }

  async function open(options: OpenOptions): Promise<Conversation> {
    const settings: ThreadSettings = {
      model: options.model,
      effort: options.effort,
      instructions: options.instructions,
      tools: options.tools,
      cwd: options.cwd,
    };
    let ref: string;
    const preparing =
      options.resume === undefined
        ? (options.signal ?? new AbortController().signal)
        : undefined;
    try {
      if (options.resume === undefined) {
        ({ threadId: ref } = await runtime.startThread(settings, preparing));
      } else {
        if (conversations.has(options.resume)) {
          throw new NotOpened("The conversation is open already.");
        }
        // Also lets go of the thread first if Codex still has it open (a
        // release that failed), so it takes the new settings or doesn't open.
        await runtime.reloadThread(
          options.resume,
          settings,
          instructionsNote(options.instructions),
          options.signal,
        );
        ref = options.resume;
      }
    } catch (error) {
      if (error instanceof NotOpened) throw error;
      if (error instanceof ThreadNotFound) {
        throw new Missing(error.message, { cause: error });
      }
      throw new NotOpened(textOf(error), {
        cause: error,
        reason: signedOut(error) ? "signed_out" : "other",
      });
    }
    const mine: Open = {
      onEvent: options.onEvent,
      seed: options.resume === undefined ? options.seed : undefined,
      preparing,
      starting: undefined,
      answers: new Map(),
    };
    conversations.set(ref, mine);
    const isOpen = () => conversations.get(ref) === mine;

    return {
      ref,

      startTurn: async ({ input, model, effort }) => {
        if (!isOpen()) {
          return {
            status: "not_delivered",
            text: "The conversation is closed.",
          };
        }
        if (runtime.running(ref)) {
          return { status: "not_delivered", text: "A turn is running." };
        }
        mine.starting = input.id;
        const preparing = mine.preparing;
        mine.preparing = undefined;
        try {
          await runtime.send(
            ref,
            {
              id: input.id,
              input: [
                ...(mine.seed === undefined ? [] : [mine.seed]),
                ...input.parts,
              ],
              model,
              effort,
            },
            preparing,
          );
        } catch (error) {
          if (error instanceof NotSent) {
            mine.starting = undefined;
            const text = textOf(error);
            if (signedOut(error)) {
              return { status: "not_delivered", reason: "signed_out", text };
            }
            return missing(error)
              ? { status: "not_delivered", reason: "missing", text }
              : { status: "not_delivered", text };
          }
          // Codex may still start it: its turn names the input.
          mine.seed = undefined;
          return { status: "uncertain", text: textOf(error) };
        }
        mine.seed = undefined;
        return { status: "delivered" };
      },

      // Codex takes a steer at once or refuses it, and never starts a turn
      // with one.
      steer: async ({ input, turn }) => {
        if (!isOpen() || runtime.activeTurn(ref) !== turn) {
          return { status: "not_delivered", text: "That turn has ended." };
        }
        try {
          await runtime.steer(ref, {
            id: input.id,
            text: input.parts.join("\n\n"),
          });
          return { status: "delivered" };
        } catch (error) {
          return error instanceof NotSent
            ? { status: "not_delivered", text: textOf(error) }
            : { status: "uncertain", text: textOf(error) };
        }
      },

      // The runtime interrupts, and else ends the shared app-server: every
      // turn on it then ends with its process.
      stop: (turn) => runtime.stop(ref, turn),

      // Codex may still act on a request it didn't answer, so an input its
      // thread doesn't list is unknown, never not received.
      reconcile: async (ids) => {
        let listed: Set<string>;
        try {
          listed = new Set(
            (await runtime.startedMessages(ref)).map((message) => message.id),
          );
        } catch (error) {
          log("codex.reconcile_failed", { error: errorCode(error) });
          listed = new Set();
        }
        return new Map<string, Received>(
          ids.map((id) => [id, listed.has(id) ? "received" : "unknown"]),
        );
      },

      placeCall: (meta) => {
        const { callId, threadId, turnId } = callOf(meta);
        if (
          !isOpen() ||
          callId === undefined ||
          threadId !== ref ||
          turnId === undefined ||
          runtime.activeTurn(ref) !== turnId
        ) {
          return undefined;
        }
        return { turn: turnId, call: callId };
      },

      close: async () => {
        if (!isOpen()) return;
        await runtime.stop(ref);
        conversations.delete(ref);
        try {
          await runtime.release(ref);
        } catch (error) {
          // Still open in Codex: the next resume lets go of it first.
          log("codex.release_failed", { error: errorCode(error) });
        }
      },
    };
  }

  return {
    id: "codex",
    family: "openai",

    models: async (signal) =>
      (await runtime.catalog(signal)).map((model) => ({
        id: model.id,
        name: model.name,
        efforts: model.efforts,
        defaultEffort: model.defaultEffort,
      })),

    open,

    delete: (ref) => runtime.deleteThread(ref),

    usage: () => {
      const limits = runtime.limits();
      return Promise.resolve(
        [limits?.primary, limits?.secondary].flatMap((window) =>
          window ? [usageOf(window)] : [],
        ),
      );
    },

    // The running turns' ends still reach their conversations.
    close: async () => {
      await runtime.close();
      conversations.clear();
    },
  };
}

function usageOf(window: RateLimitWindow): UsageWindow {
  return {
    ...(window.windowDurationMins !== null && {
      minutes: window.windowDurationMins,
    }),
    usedPercent: window.usedPercent,
    ...(window.resetsAt !== null && {
      resetsAt: new Date(window.resetsAt * 1000).toISOString(),
    }),
  };
}

function kindOf(activity: ActivityKind): StepKind {
  return activity === "note" ? "other" : activity;
}

/** How a turn ended, in the boundary's words; `answer` is its last answer. */
function endOf(end: TurnEnd, answer: string): ProviderTurnEnd {
  if (end.status === "completed") return { status: "done", answer };
  if (end.status === "interrupted") return { status: "stopped" };
  return {
    status: "failed",
    reason: reasonOf(end),
    ...(end.text !== undefined && { text: end.text }),
    ...(end.resetsAt !== undefined && { resetsAt: end.resetsAt }),
  };
}

function reasonOf(end: TurnEnd): FailReason {
  if (end.died) return "process_died";
  switch (end.reason) {
    case "sign_in":
      return "signed_out";
    case "usage_limit":
    case "rate_limit":
    case "connection":
      return end.reason;
    // A turn has no time limit; Rufi's own ending of one is other.
    case "timeout":
    case "provider_failed":
    case "save_failed":
    case "stopped":
    case undefined:
      return "other";
  }
}
