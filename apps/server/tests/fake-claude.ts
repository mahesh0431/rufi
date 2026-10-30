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

export function fakeClaude(
  script: Script,
  /**
   * Beyond the contract's scripts. Connection drops: the turn's network
   * drops. Ends before a turn: the process ends after it took a message,
   * before it began the turn. Frames: a turn's frames, recorded, given for
   * each message, `$input` naming it.
   */
  more: {
    frames?: readonly object[];
    connectionDrops?: true;
    endsBeforeATurn?: true;
  } = {},
): {
  query: typeof query;
  sessions: ClaudeSessions;
  /** The `_meta` Claude's call `call` to one of Rufi's tools carries. */
  callMeta: (call: string) => object;
} {
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

    const keep = (message: string) => {
      kept.set(id, [...(kept.get(id) ?? []), message]);
    };
    /** A turn's result, with its usage, as Claude always gives it. */
    const result = (fields: object) => {
      frames.push({
        type: "result",
        usage: { input_tokens: 3, output_tokens: 1 },
        modelUsage: {},
        ...fields,
      });
    };
    const answer = (to: string[]) => {
      frames.push({
        type: "assistant",
        message: { content: [{ type: "text", text: ANSWER }] },
        user_message_uuid: to.at(-1),
        user_message_uuids: to,
      });
      result({
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
      result({ subtype: "success", is_error: true, result: text });
      turn = undefined;
    };
    /** A step whose result is a picture: Claude reads it. */
    const picture = (bytes: string, to: string) => {
      frames.push({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_picture",
              name: "Read",
              input: { file_path: "/fictional/page.png" },
            },
          ],
        },
        user_message_uuid: to,
        user_message_uuids: [to],
      });
      frames.push({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_picture",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: bytes,
                  },
                },
              ],
            },
          ],
        },
        tool_use_result: { type: "image", file: { base64: bytes } },
      });
    };

    /** A turn's start, naming the messages it took. */
    const init = (to: string[]) => {
      frames.push({ type: "system", subtype: "init", user_message_uuids: to });
    };

    const start = (message: string) => {
      // Claude skips a uuid it has stored before, and says nothing.
      if (kept.get(id)?.includes(message) === true) return;
      keep(message);
      if (more.endsBeforeATurn === true) {
        frames.fail(new Error("Claude's process exited with code 1."));
        return;
      }
      if (more.frames !== undefined) {
        for (const frame of more.frames) {
          frames.push(
            JSON.parse(
              JSON.stringify(frame).replaceAll("$input", message),
            ) as object,
          );
        }
        return;
      }
      init([message]);
      turn = message;
      if (script.picture !== undefined) picture(script.picture, message);
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
        case "runs":
          break;
        case "fails":
          result({
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
        case "starts_next":
          answer([running]);
          keep(message);
          init([message]);
          turn = message;
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
      setMcpServers: () =>
        Promise.resolve({ added: ["rufi"], removed: [], errors: {} }),
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
      interrupt: () => {
        if (turn !== undefined && script.ignoresInterrupt !== true) {
          result({
            subtype: "error_during_execution",
            is_error: true,
            errors: [],
          });
          turn = undefined;
        }
        return Promise.resolve(undefined);
      },
      close: () => {
        frames.end();
      },
    });
  };

  return {
    callMeta: (call) => ({ "claudecode/toolUseId": call, progressToken: 1 }),
    query: run as unknown as typeof query,
    sessions: {
      info: (id) =>
        Promise.resolve(kept.has(id) ? { sessionId: id } : undefined),
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
