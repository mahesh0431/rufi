// The Codex implementation of AgentRuntime: one app-server at a time, full
// access as PLAN.md §4 sets it, and a restart whenever the access token changes.
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AgentRuntime,
  AgentTools,
  ToolAnswer,
  TurnEvent,
  TurnResult,
} from "../runtime.ts";
import {
  DEADLINES,
  startAppServer,
  type AppServer,
  type CodexCommand,
  type Deadlines,
} from "./appserver.ts";
import type { AgentMessageDeltaNotification } from "./protocol/v2/AgentMessageDeltaNotification.ts";
import type { DynamicToolCallParams } from "./protocol/v2/DynamicToolCallParams.ts";
import type { DynamicToolCallResponse } from "./protocol/v2/DynamicToolCallResponse.ts";
import type { DynamicToolSpec } from "./protocol/v2/DynamicToolSpec.ts";
import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";
import type { ItemCompletedNotification } from "./protocol/v2/ItemCompletedNotification.ts";
import type { ItemStartedNotification } from "./protocol/v2/ItemStartedNotification.ts";
import type { ThreadBackgroundTerminalsListResponse } from "./protocol/v2/ThreadBackgroundTerminalsListResponse.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { Turn } from "./protocol/v2/Turn.ts";
import type { TurnCompletedNotification } from "./protocol/v2/TurnCompletedNotification.ts";
import type { TurnError } from "./protocol/v2/TurnError.ts";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.ts";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.ts";
import { errorCode, type Log } from "../../platform/logs.ts";
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
  /** Rufi's tools; fixed for the life of each thread (Codex keeps them). */
  tools?: AgentTools;
  /** Diagnostics: what Rufi ignored or refused, as event names and codes. */
  log?: Log;
}

/** A token must outlast a whole turn, plus this margin. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** How often Rufi notes the process groups of running commands. */
const TRACK_EVERY_MS = 500;

/** An open or turn that hasn't sent its question yet; Stop can cancel it. */
interface Starting {
  cancelled: boolean;
}

class Stopped extends Error {}

interface Running {
  threadId: string;
  /** Known from Codex's acknowledgement; events wait in `early` until then. */
  turnId: string | undefined;
  early: [string, unknown][];
  onEvent: (event: TurnEvent) => void;
  /** Items already shown when they started. */
  shown: Set<string>;
  lastMessageId: string | undefined;
  result: TurnResult | undefined;
  /** Settles once the turn has really ended (or Codex is gone). */
  ended: PromiseWithResolvers<void>;
  /** A Stop under way; the turn returns only once it has finished. */
  stopping: Promise<void> | undefined;
  /** Runs Rufi's tools for this turn. */
  callTool: ReturnType<AgentTools["forTurn"]> | undefined;
  /** Settles when Codex has answered turn/start, either way. */
  acknowledged: PromiseWithResolvers<void>;
}

export function codexRuntime(deps: CodexDeps): AgentRuntime {
  const deadlines = { ...DEADLINES, ...deps.deadlines };
  const log = deps.log ?? (() => undefined);
  let server: AppServer | undefined;
  let workspace = "";
  const loaded = new Set<string>(); // threads open in the current app-server
  let starting: Starting | undefined;
  let current: Running | undefined;

  const end = (running: Running, result: TurnResult) => {
    running.result ??= result;
    running.ended.resolve();
  };
  const check = (op: Starting) => {
    if (op.cancelled) throw new Stopped("Stopped.");
  };

  async function serverFor(token: string, op: Starting): Promise<AppServer> {
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
        request: answer,
        notification: onNotification,
        ignored: (what, error) => {
          log("codex.ignored", { what, error });
        },
      },
      onExit: (why) => {
        log("codex.exited", { error: errorCode(why.cause ?? why) });
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
    if (op.cancelled) {
      await started.stop();
      throw new Stopped("Stopped.");
    }
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
      ...(deps.tools && { developerInstructions: deps.tools.instructions }),
    } as const;
    // Codex keeps a thread's tools and restores them on resume; they can only
    // be given when it starts.
    const response = threadId
      ? await app.rpc.request<ThreadResumeResponse>(
          "thread/resume",
          { threadId, excludeTurns: true, ...settings },
          deadlines.requestMs,
        )
      : await app.rpc.request<ThreadStartResponse>(
          "thread/start",
          {
            ...settings,
            ...(deps.tools && { dynamicTools: dynamicTools(deps.tools) }),
          },
          deadlines.requestMs,
        );
    loaded.add(response.thread.id);
    return response.thread.id;
  }

  /** Gets a token, Codex and the thread ready; Stop can cancel at each step. */
  async function prepare(op: Starting, threadId?: string) {
    const token = await deps.token(deadlines.turnMs + TOKEN_MARGIN_MS);
    check(op);
    const app = await serverFor(token, op);
    const id =
      threadId !== undefined && loaded.has(threadId)
        ? threadId
        : await load(app, threadId);
    check(op);
    return { app, id };
  }

  /** Codex asked Rufi something. Approvals are declined; tools are run. */
  async function answer(method: string, params: unknown): Promise<unknown> {
    log("codex.request", { method });
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "item/tool/call":
        return callTool(params as DynamicToolCallParams);
      default:
        throw new RpcError(-32601, `Rufi doesn't handle ${method}.`);
    }
  }

  /**
   * Runs one of Rufi's tools for the current turn. Always a result, never a
   * JSON-RPC error: Codex would turn that into a bare "request failed".
   */
  async function callTool(
    call: DynamicToolCallParams,
  ): Promise<DynamicToolCallResponse> {
    const reply = (ok: boolean, text: string): DynamicToolCallResponse => ({
      contentItems: [{ type: "inputText", text }],
      success: ok,
    });
    const running = current;
    // A call can come before Codex's answer to turn/start, like any event.
    if (running?.turnId === undefined) {
      await Promise.race([
        running?.acknowledged.promise,
        sleep(deadlines.requestMs, undefined, { ref: false }),
      ]);
    }
    if (
      !running?.callTool ||
      call.threadId !== running.threadId ||
      call.turnId !== running.turnId
    ) {
      return reply(
        false,
        JSON.stringify({ ok: false, error: "No turn is running." }),
      );
    }
    const name =
      call.namespace === deps.tools?.namespace
        ? call.tool
        : `${call.namespace ?? ""}.${call.tool}`;
    const timedOut: ToolAnswer = {
      ok: false,
      text: JSON.stringify({ ok: false, error: `${name} took too long.` }),
    };
    const answer = await Promise.race([
      running.callTool(name, call.arguments),
      sleep(deadlines.toolMs, timedOut, { ref: false }),
    ]);
    if (answer.stopTurn !== undefined) {
      running.result ??= { status: "failed", reason: answer.stopTurn };
      void stopTurn(running);
    }
    return reply(answer.ok, answer.text);
  }

  function onNotification(method: string, params: unknown): void {
    const running = current;
    const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
    if (!running || threadId !== running.threadId) {
      log("codex.notification_ignored", { method });
      return;
    }
    if (running.turnId === undefined) {
      running.early.push([method, params]);
      return;
    }
    handle(running, method, params);
  }

  /** One of this thread's events, once the turn's id is known. */
  function handle(running: Running, method: string, params: unknown): void {
    const p = params as { turnId?: unknown; turn?: { id?: unknown } };
    const turnId = p.turnId ?? p.turn?.id;
    if (turnId !== running.turnId) {
      log("codex.other_turn", { method });
      return;
    }
    switch (method) {
      case "item/started": {
        const { item } = params as ItemStartedNotification;
        if (item.type === "agentMessage") {
          // A new message after an earlier one starts on a new paragraph.
          if (running.lastMessageId && running.lastMessageId !== item.id) {
            running.onEvent({ type: "text", delta: "\n\n" });
          }
          running.lastMessageId = item.id;
          return;
        }
        if (item.type === "commandExecution") void track();
        const event = describe(item);
        if (event) {
          running.shown.add(item.id);
          running.onEvent(event);
        }
        return;
      }
      case "item/agentMessage/delta": {
        const { itemId, delta } = params as AgentMessageDeltaNotification;
        running.shown.add(itemId);
        running.onEvent({ type: "text", delta });
        return;
      }
      case "item/completed": {
        const { item } = params as ItemCompletedNotification;
        if (item.type === "agentMessage") {
          // Text that didn't stream, and questions the AI asks the user
          // (Codex's request_user_input_async), arrive only here.
          if (!running.shown.has(item.id) && item.text) {
            running.onEvent({ type: "text", delta: item.text });
          }
          for (const question of item.questions ?? []) {
            running.onEvent({
              type: "question",
              title: question.title,
              options: question.options ?? [],
            });
          }
          return;
        }
        if (running.shown.has(item.id)) return;
        const event = describe(item);
        if (event) running.onEvent(event);
        return;
      }
      case "turn/completed":
        end(running, resultOf((params as TurnCompletedNotification).turn));
        return;
      default:
        log("codex.notification_ignored", { method });
    }
  }

  async function track(): Promise<void> {
    try {
      await server?.track();
    } catch (error) {
      log("codex.process_list_failed", { error: errorCode(error) });
    }
  }

  /**
   * Whether Codex still lists commands of the thread as running. Codex's list,
   * not the process table: Codex keeps helpers of its own in other process
   * groups, and the list doesn't give the commands' process ids (0.159.2).
   */
  async function commandsLeft(
    app: AppServer,
    threadId: string,
  ): Promise<boolean> {
    const { data } =
      await app.rpc.request<ThreadBackgroundTerminalsListResponse>(
        "thread/backgroundTerminals/list",
        { threadId },
        deadlines.interruptAckMs,
      );
    return data.length > 0;
  }

  /**
   * Interrupts the turn, then ends the commands it left running (Codex keeps
   * them by design) and waits until Codex no longer lists them: its reply to
   * the clean-up only means it was queued. If anything fails or takes too long, Rufi ends Codex.
   * Runs once per turn, and the turn returns only after it.
   */
  function stopTurn(running: Running): Promise<void> {
    running.stopping ??= interruptAndClean(running);
    return running.stopping;
  }

  async function interruptAndClean(running: Running): Promise<void> {
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
          // A deadline alone mustn't keep Rufi running once the turn has ended.
          sleep(deadlines.interruptEndMs, undefined, { ref: false }).then(
            () => false,
          ),
        ]);
        if (stopped) {
          await app.track();
          await app.rpc.request(
            "thread/backgroundTerminals/clean",
            { threadId: running.threadId },
            deadlines.interruptAckMs,
          );
          const deadline = Date.now() + deadlines.interruptEndMs;
          while (app.running() && Date.now() < deadline) {
            if (!(await commandsLeft(app, running.threadId))) return;
            await sleep(100);
          }
          log("codex.commands_left");
        }
      } catch (error) {
        log("codex.interrupt_failed", { error: errorCode(error) });
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
      if (starting || current) throw new Error("Codex is busy.");
      const op: Starting = { cancelled: false };
      starting = op;
      try {
        return (await prepare(op, conversationId)).id;
      } finally {
        starting = undefined;
      }
    },

    turn: async (threadId, text, onEvent) => {
      if (starting || current) throw new Error("A turn is already running.");
      const op: Starting = { cancelled: false };
      starting = op;
      let app: AppServer;
      try {
        ({ app } = await prepare(op, threadId));
      } catch (error) {
        if (error instanceof Stopped) {
          return { status: "interrupted", reason: "Stopped." };
        }
        throw error;
      } finally {
        starting = undefined;
      }
      const running: Running = {
        threadId,
        turnId: undefined,
        early: [],
        onEvent,
        shown: new Set(),
        lastMessageId: undefined,
        result: undefined,
        ended: Promise.withResolvers(),
        stopping: undefined,
        callTool: deps.tools?.forTurn(),
        acknowledged: Promise.withResolvers(),
      };
      current = running;
      const tracking = setInterval(() => void track(), TRACK_EVERY_MS);
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
              running.turnId = started.turn.id;
              running.acknowledged.resolve();
              for (const [method, early] of running.early.splice(0)) {
                handle(running, method, early);
              }
            },
            async (error: unknown) => {
              running.acknowledged.resolve();
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
        await running.stopping;
        return running.result ?? { status: "failed", reason: "Unknown." };
      } finally {
        clearInterval(tracking);
        clearTimeout(timer);
        current = undefined;
      }
    },

    stop: async () => {
      if (current) {
        await stopTurn(current);
      } else if (starting) {
        starting.cancelled = true;
        await shutDown();
      }
    },

    close: async () => {
      if (starting) starting.cancelled = true;
      if (current) {
        end(current, { status: "interrupted", reason: "Rufi closed Codex." });
      }
      await shutDown();
    },
  };
}

/** Rufi's tools in Codex's shape: one namespace. */
function dynamicTools(tools: AgentTools): DynamicToolSpec[] {
  if (tools.specs.length === 0) return [];
  return [
    {
      type: "namespace",
      name: tools.namespace,
      description: "Rufi: the user's health record.",
      tools: tools.specs.map((spec) => ({
        type: "function",
        ...spec,
        // A JSON Schema made by Effect Schema: plain JSON.
        inputSchema: spec.inputSchema as JsonValue,
      })),
    },
  ];
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
      // The query may only be known once the search has finished.
      return item.query
        ? { type: "activity", text: `searched the web: ${item.query}` }
        : undefined;
    case "fileChange":
      return {
        type: "activity",
        text: `changed ${item.changes.map((change) => change.path).join(", ")}`,
      };
    case "imageView":
      return { type: "activity", text: `looked at ${item.path}` };
    case "dynamicToolCall":
      return {
        type: "activity",
        text: `used ${item.namespace ? `${item.namespace}.` : ""}${item.tool}`,
      };
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
