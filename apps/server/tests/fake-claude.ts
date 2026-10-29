// A scripted Claude for the Claude adapter's tests: the SDK's `query` and
// Claude's kept conversations, giving the frames the installed Claude gave
// in the trial (review-artifacts/agent-system/2026-10-29-claude-trial) as a
// contract case's script asks. Only the fields the adapter reads are set.
import type {
  query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ANSWER, type Script } from "@rufi/agents/contract";
import type { ClaudeSessions } from "../src/agent/claude/adapter.ts";

/** Longer than the adapter waits for a turn to start, in the tests. */
const SILENT_MS = 1_000;

export function fakeClaude(
  script: Script,
  /**
   * Beyond the contract's scripts. Connection drops: the turn's network
   * drops. Next turn: steers miss the running turn, which ends, and Claude
   * starts the next with them. With two, its first answer names the first
   * and its later ones both. Before an answer, it runs and never answers.
   */
  more: {
    connectionDrops?: true;
    nextTurn?: "two" | "before_an_answer";
    /** Claude takes the message, and starts its turn (and keeps it) this late. */
    slowStartMs?: number;
  } = {},
): {
  query: typeof query;
  sessions: ClaudeSessions;
  /** How many times a process was closed. */
  closes: () => number;
} {
  let closes = 0;
  /** Each conversation Claude keeps, with the ids of its messages. */
  const kept = new Map<string, string[]>();

  const run = ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<SDKUserMessage> | string;
    options?: { sessionId?: string; resume?: string };
  }) => {
    const id = options?.sessionId ?? options?.resume ?? "asking";
    const frames = channel();
    /** The id of the message the running turn answers; none when idle. */
    let turn: string | undefined;
    /** Steers Claude holds and hasn't taken. */
    let queued: string[] = [];
    let closed = false;

    const keep = (message: string) => {
      kept.set(id, [...(kept.get(id) ?? []), message]);
    };
    const answer = (to: string[]) => {
      frames.push({
        type: "assistant",
        message: { content: [{ type: "text", text: ANSWER }] },
        user_message_uuid: to.at(-1),
        user_message_uuids: to,
      });
      frames.push({
        type: "result",
        subtype: "success",
        is_error: false,
        result: ANSWER,
        user_message_uuids: to,
      });
      turn = undefined;
    };
    const fail = (error: string, text: string) => {
      frames.push({
        type: "assistant",
        message: { content: [{ type: "text", text }] },
        error,
        user_message_uuid: turn,
      });
      frames.push({
        type: "result",
        subtype: "success",
        is_error: true,
        result: text,
      });
      turn = undefined;
    };

    const start = (message: string) => {
      const late = more.slowStartMs;
      if (late !== undefined) {
        setTimeout(() => {
          if (closed) return;
          keep(message);
          frames.push({ type: "system", subtype: "init" });
          turn = message;
          answer([message]);
        }, late);
        return;
      }
      if (script.start === "loses_reply") {
        keep(message);
        return;
      }
      keep(message);
      frames.push({ type: "system", subtype: "init" });
      turn = message;
      if (more.connectionDrops === true) {
        frames.push({
          type: "system",
          subtype: "api_retry",
          error_status: null,
        });
        fail("server_error", "API Error: Connection refused (ECONNREFUSED)");
        return;
      }
      switch (script.turn ?? "answers") {
        case "answers":
        case "renews":
          answer([message]);
          break;
        case "silent":
          setTimeout(() => {
            answer([message]);
          }, SILENT_MS);
          break;
        case "runs":
          break;
        case "fails":
          frames.push({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["The fictional model couldn't answer."],
          });
          turn = undefined;
          break;
        case "usage_limit":
          frames.push({
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              resetsAt: Math.floor(Date.now() / 1000) + 3_600,
            },
          });
          fail("rate_limit", "You've reached your fictional usage limit.");
          break;
        case "renewal_fails":
          fail("authentication_failed", "Please sign in again.");
          break;
        case "dies":
          frames.fail(new Error("Claude's process exited with code 1."));
          break;
      }
    };

    const steer = (message: string) => {
      const running = turn;
      if (running === undefined) return;
      if (more.nextTurn === "two") {
        queued.push(message);
        if (queued.length < 2) return;
        const [first = "", second = ""] = queued;
        queued = [];
        answer([running]);
        keep(first);
        keep(second);
        frames.push({ type: "system", subtype: "init" });
        frames.push({
          type: "assistant",
          message: { content: [] },
          user_message_uuid: first,
          user_message_uuids: [first],
        });
        answer([first, second]);
        return;
      }
      if (more.nextTurn === "before_an_answer") {
        answer([running]);
        keep(message);
        frames.push({ type: "system", subtype: "init" });
        turn = message;
        return;
      }
      switch (script.steer ?? "takes") {
        case "takes":
          keep(message);
          frames.push({
            type: "assistant",
            message: { content: [] },
            user_message_uuid: message,
            user_message_uuids: [running, message],
          });
          break;
        case "holds":
          queued.push(message);
          break;
        case "holds_past_end":
          queued.push(message);
          answer([running]);
          break;
        case "starts_next":
          answer([running]);
          keep(message);
          frames.push({ type: "system", subtype: "init" });
          answer([message]);
          break;
        case "loses_reply":
          break;
      }
    };

    void (async () => {
      if (typeof prompt === "string") return;
      for await (const message of prompt) {
        if (message.priority === "next") steer(message.uuid ?? "");
        else start(message.uuid ?? "");
      }
    })();

    const resumed = options?.resume !== undefined;
    return Object.assign(frames.iterator, {
      accountInfo: () =>
        resumed && script.resumeFails === true
          ? Promise.reject(new Error("Claude couldn't start."))
          : Promise.resolve(
              script.signedIn === false
                ? { apiKeySource: "none" }
                : { subscriptionType: "max" },
            ),
      setModel: () =>
        script.start === "refuses"
          ? Promise.reject(new Error("The fictional model isn't available."))
          : Promise.resolve(),
      applyFlagSettings: () => Promise.resolve(),
      supportedModels: () =>
        Promise.resolve([
          { value: "default", resolvedModel: "claude-fictional-1" },
          {
            value: "fictional",
            resolvedModel: "claude-fictional-1",
            displayName: "Fictional 1",
            supportedEffortLevels: ["low", "high"],
          },
          { value: "claude-fictional-0", displayName: "Fictional 0" },
        ]),
      interrupt: (): Promise<unknown> => {
        if (script.cancelLost === true) return new Promise(() => {});
        const cancelled = queued;
        queued = [];
        if (turn !== undefined && script.ignoresInterrupt !== true) {
          frames.push({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: [],
          });
          turn = undefined;
        }
        return Promise.resolve({ still_queued: [], cancelled });
      },
      close: () => {
        closes++;
        closed = true;
        frames.end();
      },
    });
  };

  return {
    closes: () => closes,
    query: run as unknown as typeof query,
    sessions: {
      info: (id) =>
        Promise.resolve(kept.has(id) ? { sessionId: id } : undefined),
      ids: (id) => Promise.resolve(kept.get(id) ?? []),
      delete: (id) =>
        kept.delete(id)
          ? Promise.resolve()
          : Promise.reject(new Error(`Session ${id} not found.`)),
    },
  };
}

/** Frames as Claude gives them: in order, until it ends or dies. */
function channel() {
  const waiting: object[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let died: Error | undefined;
  const iterator: AsyncIterableIterator<SDKMessage> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: async () => {
      while (waiting.length === 0 && !ended && died === undefined) {
        await new Promise<void>((resolve) => (wake = resolve));
      }
      const frame = waiting.shift();
      if (frame !== undefined) {
        return { done: false, value: frame as SDKMessage };
      }
      if (died !== undefined) throw died;
      return { done: true, value: undefined };
    },
  };
  return {
    iterator,
    push: (frame: object) => {
      waiting.push(frame);
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
    fail: (error: Error) => {
      died = error;
      wake?.();
    },
  };
}
