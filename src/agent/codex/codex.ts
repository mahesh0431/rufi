// The Codex implementation of AgentRuntime: one app-server at a time, full
// access as PLAN.md §4 sets it, and a restart whenever the access token changes.
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentRuntime, TurnEvent, TurnResult } from "../runtime.ts";
import {
  DEADLINES,
  startAppServer,
  type AppServer,
  type CodexCommand,
  type Deadlines,
} from "./appserver.ts";
import type { AgentMessageDeltaNotification } from "./protocol/v2/AgentMessageDeltaNotification.ts";
import type { ItemCompletedNotification } from "./protocol/v2/ItemCompletedNotification.ts";
import type { ItemStartedNotification } from "./protocol/v2/ItemStartedNotification.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { Turn } from "./protocol/v2/Turn.ts";
import type { TurnCompletedNotification } from "./protocol/v2/TurnCompletedNotification.ts";
import type { TurnError } from "./protocol/v2/TurnError.ts";
import type { TurnStartedNotification } from "./protocol/v2/TurnStartedNotification.ts";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.ts";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.ts";
import { RpcError } from "./rpc.ts";
import { prepareCodexHome } from "./settings.ts";

export interface CodexDeps {
  /** Rufi's data folder; Codex gets `codex/` and `workspace/` inside it. */
  home: string;
  command: CodexCommand;
  /** The child's environment, without secrets (platform/config.ts). */
  env: Readonly<Record<string, string>>;
  /** An access token valid for at least `validForMs`. */
  token: (validForMs: number) => Promise<string>;
  version: string;
  deadlines?: Partial<Deadlines>;
  /** Diagnostics: what Rufi ignored or refused. Never the token. */
  log?: (line: string) => void;
}

/** A token must outlast a whole turn, plus this margin. */
const TOKEN_MARGIN_MS = 5 * 60_000;

interface Running {
  threadId: string;
  turnId: string | undefined;
  onEvent: (event: TurnEvent) => void;
  lastMessageId: string | undefined;
  result: TurnResult | undefined;
  /** Settles once the turn has really ended (or Codex is gone). */
  ended: PromiseWithResolvers<void>;
}

export function codexRuntime(deps: CodexDeps): AgentRuntime {
  const deadlines = { ...DEADLINES, ...deps.deadlines };
  const log = deps.log ?? (() => undefined);
  let server: AppServer | undefined;
  let workspace = "";
  const loaded = new Set<string>(); // threads open in the current app-server
  let current: Running | undefined;

  const end = (running: Running, result: TurnResult) => {
    running.result ??= result;
    running.ended.resolve();
  };

  async function serverFor(token: string): Promise<AppServer> {
    if (server?.running() && server.token === token) return server;
    await shutDown();
    const paths = await prepareCodexHome(deps.home, deps.env["HOME"]);
    workspace = paths.workspace;
    const started = await startAppServer({
      command: deps.command,
      env: { ...deps.env, HOME: paths.processHome },
      codexHome: paths.codexHome,
      token,
      version: deps.version,
      deadlines,
      handlers: {
        request: (method, params) => Promise.resolve(answer(method, params)),
        notification: onNotification,
        ignored: (what) => {
          log(`ignored ${what}`);
        },
      },
      onExit: (why) => {
        log(why.message);
        // Rufi clears `server` before ending one itself; only a crash gets here.
        if (!server || server.running()) return;
        server = undefined;
        loaded.clear();
        if (current) {
          end(current, {
            status: "failed",
            reason: "Codex stopped unexpectedly.",
          });
        }
      },
    });
    server = started;
    return started;
  }

  async function shutDown(): Promise<void> {
    const old = server;
    server = undefined;
    loaded.clear();
    await old?.stop();
  }

  /** Starts a thread, or resumes one; on failure Codex is ended. */
  async function load(app: AppServer, threadId?: string): Promise<string> {
    try {
      return await loadThread(app, threadId);
    } catch (error) {
      await shutDown();
      throw error;
    }
  }

  async function loadThread(
    app: AppServer,
    threadId?: string,
  ): Promise<string> {
    const settings = {
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    } as const;
    const response = threadId
      ? await app.rpc.request<ThreadResumeResponse>(
          "thread/resume",
          { threadId, excludeTurns: true, ...settings },
          deadlines.requestMs,
        )
      : await app.rpc.request<ThreadStartResponse>(
          "thread/start",
          settings,
          deadlines.requestMs,
        );
    loaded.add(response.thread.id);
    return response.thread.id;
  }

  const tokenForTurn = () => deps.token(deadlines.turnMs + TOKEN_MARGIN_MS);

  /** Codex asked Rufi something. Approvals are declined; tools arrive in M1.3. */
  function answer(method: string, params: unknown): unknown {
    log(`Codex asked: ${method}`);
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "item/tool/call": {
        const tool = (params as { tool?: unknown } | undefined)?.tool;
        return {
          contentItems: [
            { type: "inputText", text: `Unknown tool: ${String(tool)}` },
          ],
          success: false,
        };
      }
      default:
        throw new RpcError(-32601, `Rufi doesn't handle ${method}.`);
    }
  }

  function onNotification(method: string, params: unknown): void {
    const running = current;
    const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
    if (!running || threadId !== running.threadId) {
      log(`ignored notification ${method}`);
      return;
    }
    switch (method) {
      case "turn/started":
        running.turnId ??= (params as TurnStartedNotification).turn.id;
        return;
      case "item/started": {
        const { item } = params as ItemStartedNotification;
        if (item.type === "agentMessage") {
          // A new message after an earlier one starts on a new paragraph.
          if (running.lastMessageId && running.lastMessageId !== item.id) {
            running.onEvent({ type: "text", delta: "\n\n" });
          }
          running.lastMessageId = item.id;
        }
        return;
      }
      case "item/agentMessage/delta":
        running.onEvent({
          type: "text",
          delta: (params as AgentMessageDeltaNotification).delta,
        });
        return;
      case "item/completed": {
        const event = describe((params as ItemCompletedNotification).item);
        if (event) running.onEvent(event);
        return;
      }
      case "turn/completed": {
        const { turn } = params as TurnCompletedNotification;
        if (running.turnId !== undefined && turn.id !== running.turnId) {
          log("ignored turn/completed for another turn");
          return;
        }
        end(running, resultOf(turn));
        return;
      }
      default:
        log(`ignored notification ${method}`);
    }
  }

  /** Interrupts the turn; if Codex doesn't stop in time, ends Codex instead. */
  async function stopTurn(running: Running): Promise<void> {
    const app = server;
    if (app?.running() && running.turnId !== undefined) {
      try {
        await app.rpc.request(
          "turn/interrupt",
          { threadId: running.threadId, turnId: running.turnId },
          deadlines.interruptAckMs,
        );
        const stopped = await Promise.race([
          running.ended.promise.then(() => true),
          sleep(deadlines.interruptEndMs).then(() => false),
        ]);
        if (stopped) return;
      } catch (error) {
        log(`interrupt failed: ${(error as Error).message}`);
      }
    }
    await shutDown();
    end(running, {
      status: "interrupted",
      reason: "Codex didn't stop when asked, so Rufi ended it.",
    });
  }

  return {
    open: async (conversationId) => {
      const app = await serverFor(await tokenForTurn());
      return load(app, conversationId);
    },

    turn: async (threadId, text, onEvent) => {
      if (current) throw new Error("A turn is already running.");
      const app = await serverFor(await tokenForTurn());
      if (!loaded.has(threadId)) await load(app, threadId);
      const running: Running = {
        threadId,
        turnId: undefined,
        onEvent,
        lastMessageId: undefined,
        result: undefined,
        ended: Promise.withResolvers(),
      };
      current = running;
      const timer = setTimeout(() => {
        running.result ??= {
          status: "failed",
          reason: "The turn took too long, so Rufi stopped it.",
        };
        void stopTurn(running);
      }, deadlines.turnMs);
      try {
        // The whole setting goes with every turn; Codex's memory of it isn't relied on.
        const params: TurnStartParams = {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
          effort: "low",
        };
        app.rpc
          .request<TurnStartResponse>("turn/start", params, deadlines.requestMs)
          .then(
            (started) => {
              running.turnId ??= started.turn.id;
            },
            async (error: unknown) => {
              running.result ??= {
                status: "failed",
                reason: `Codex didn't start the turn: ${(error as Error).message}`,
              };
              // Codex is in an unknown state; start fresh next time.
              await shutDown();
              running.ended.resolve();
            },
          );
        await running.ended.promise;
        return running.result ?? { status: "failed", reason: "Unknown." };
      } finally {
        clearTimeout(timer);
        current = undefined;
      }
    },

    stop: async () => {
      if (current) await stopTurn(current);
    },

    close: shutDown,
  };
}

/** One plain line for what the agent did; undefined for what the reply already shows. */
export function describe(item: ThreadItem): TurnEvent | undefined {
  switch (item.type) {
    case "userMessage":
    case "agentMessage":
    case "reasoning":
      return undefined;
    case "plan":
      return { type: "activity", text: "updated its plan" };
    case "commandExecution":
      return { type: "activity", text: `ran: ${item.command}` };
    case "webSearch":
      return { type: "activity", text: `searched the web: ${item.query}` };
    case "fileChange":
      return {
        type: "activity",
        text: `changed ${item.changes.map((change) => change.path).join(", ")}`,
      };
    case "imageView":
      return { type: "activity", text: `looked at ${item.path}` };
    case "dynamicToolCall":
      return { type: "activity", text: `used the tool ${item.tool}` };
    case "mcpToolCall":
      return { type: "activity", text: `used ${item.server}: ${item.tool}` };
    case "contextCompaction":
      return { type: "activity", text: "condensed the earlier conversation" };
    case "hookPrompt":
    case "functionCallOutput":
    case "collabAgentToolCall":
    case "subAgentActivity":
    case "sleep":
    case "imageGeneration":
    case "enteredReviewMode":
    case "exitedReviewMode":
      return { type: "unknown", what: item.type };
  }
  // A type newer than the generated protocol.
  return { type: "unknown", what: String((item as { type: unknown }).type) };
}

/** Only `completed` counts as success. */
export function resultOf(turn: Pick<Turn, "status" | "error">): TurnResult {
  switch (turn.status) {
    case "completed":
      return { status: "completed" };
    case "interrupted":
      return { status: "interrupted", reason: "Stopped." };
    case "failed":
      return { status: "failed", reason: reasonOf(turn.error) };
    case "inProgress":
      return { status: "failed", reason: "Codex ended the turn unfinished." };
  }
}

function reasonOf(error: TurnError | null): string {
  const info = error?.codexErrorInfo;
  if (info === "unauthorized") {
    return "ChatGPT didn't accept Rufi's sign-in. Run: pnpm rufi signin";
  }
  if (info === "usageLimitExceeded") {
    return "Your ChatGPT plan's usage limit has been reached.";
  }
  if (info === "rateLimitExceeded") {
    return "ChatGPT is limiting requests right now. Try again shortly.";
  }
  if (info === "serverOverloaded" || info === "internalServerError") {
    return "ChatGPT is having trouble. Try again shortly.";
  }
  if (info === "contextWindowExceeded") {
    return "The conversation is too long for the model.";
  }
  if (typeof info === "object" && info !== null) {
    return "Couldn't reach ChatGPT. Check the connection and try again.";
  }
  return error?.message || "The AI couldn't finish.";
}
