// The Codex implementation of AgentRuntime: one app-server for every thread,
// full access as PLAN.md §4 sets it. Rufi starts each reply with turn/start
// when none runs; Codex's own queue is not used (Rufi keeps what waits). A
// new app-server starts when the access token changes and no reply is
// running.
import { setTimeout as sleep } from "node:timers/promises";
import {
  NotSent,
  Stopped,
  type AgentEvent,
  type AgentHost,
  type AgentRuntime,
  type AgentTools,
  type Model,
  type ThreadSettings,
  type TurnEnd,
} from "../runtime.ts";
import {
  DEADLINES,
  startAppServer,
  type AppServer,
  type CodexCommand,
  type Deadlines,
} from "./appserver.ts";
import { activityOf, endOf, messageText } from "./events.ts";
import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";
import type { AccountRateLimitsUpdatedNotification } from "./protocol/v2/AccountRateLimitsUpdatedNotification.ts";
import type { AgentMessageDeltaNotification } from "./protocol/v2/AgentMessageDeltaNotification.ts";
import type { DynamicToolCallParams } from "./protocol/v2/DynamicToolCallParams.ts";
import type { DynamicToolCallResponse } from "./protocol/v2/DynamicToolCallResponse.ts";
import type { DynamicToolSpec } from "./protocol/v2/DynamicToolSpec.ts";
import type { ItemCompletedNotification } from "./protocol/v2/ItemCompletedNotification.ts";
import type { ItemStartedNotification } from "./protocol/v2/ItemStartedNotification.ts";
import type { ModelListResponse } from "./protocol/v2/ModelListResponse.ts";
import type { RateLimitSnapshot } from "./protocol/v2/RateLimitSnapshot.ts";
import type { ThreadBackgroundTerminalsListResponse } from "./protocol/v2/ThreadBackgroundTerminalsListResponse.ts";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse.ts";
import type { TurnCompletedNotification } from "./protocol/v2/TurnCompletedNotification.ts";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.ts";
import type { TurnSteerResponse } from "./protocol/v2/TurnSteerResponse.ts";
import type { TurnStartedNotification } from "./protocol/v2/TurnStartedNotification.ts";
import type { UserInput } from "./protocol/v2/UserInput.ts";
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
  /** Rufi's tools; a thread keeps the ones it started with. */
  tools?: AgentTools;
  /** Where events go and tools run. */
  host: AgentHost;
  /** Diagnostics: what Rufi ignored or refused, as event names and codes. */
  log?: Log;
}

/** A token must outlast a whole turn, plus this margin. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** How often Rufi notes the process groups of running commands. */
const TRACK_EVERY_MS = 500;

interface Running {
  threadId: string;
  turnId: string;
  /** How it ended, when Rufi decided it (a deadline, a tool loop). */
  end: TurnEnd | undefined;
  /** Agent messages that streamed; the others arrive whole at their end. */
  streamed: Set<string>;
  /** Settles once the turn has ended. */
  ended: PromiseWithResolvers<void>;
  /** A Stop under way; nothing more of the turn is shown after it. */
  stopping: Promise<void> | undefined;
  /** Settles once Codex has shown the user's message that started it. */
  messaged: PromiseWithResolvers<void>;
  deadline: NodeJS.Timeout;
}

const textInput = (text: string): UserInput => ({
  type: "text",
  text,
  text_elements: [],
});

export function codexRuntime(deps: CodexDeps): AgentRuntime {
  const deadlines = { ...DEADLINES, ...deps.deadlines };
  const log = deps.log ?? (() => undefined);
  const emit = (event: AgentEvent) => {
    deps.host.onEvent(event);
  };
  /** Aborted by close(): ends an app-server that is still starting. */
  const lifetime = new AbortController();
  let server: AppServer | undefined;
  let starting: Promise<AppServer> | undefined;
  let workspace = "";
  const loaded = new Set<string>(); // threads open in the current app-server
  const turns = new Map<string, Running>(); // the running turn of each thread
  /** Threads where a Stop came during a send: the reply it starts is stopped. */
  const stopNext = new Set<string>();
  let limits: RateLimitSnapshot | undefined;
  let tracking: NodeJS.Timeout | undefined;

  const request = <T>(app: AppServer, method: string, params: unknown) =>
    app.rpc.request<T>(method, params, deadlines.requestMs);

  /**
   * Codex with a token that outlasts a turn. The token is always awaited to
   * the end (a renewed one must be saved); after it, a Stop ends the wait.
   */
  async function ready(signal?: AbortSignal): Promise<AppServer> {
    if (lifetime.signal.aborted) throw new Error("Codex is closed.");
    const token = await deps.token(deadlines.turnMs + TOKEN_MARGIN_MS);
    if (signal?.aborted) throw new Stopped();
    // A running reply keeps its app-server: Codex keeps the turn in it.
    if (server?.running() && (server.token === token || turns.size > 0)) {
      return server;
    }
    starting ??= start(token).finally(() => {
      starting = undefined;
    });
    return abortable(starting, signal);
  }

  async function start(token: string): Promise<AppServer> {
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
      signal: lifetime.signal,
      handlers: {
        request: answer,
        notification: onNotification,
        ignored: (what, error) => {
          log("codex.ignored", { what, error });
        },
      },
      onExit: (why) => {
        log("codex.exited", { code: errorCode(why) });
        // Rufi clears `server` before ending one itself; only a crash gets here.
        if (!server || server.running()) return;
        server = undefined;
        loaded.clear();
        endAll({
          status: "failed",
          reason: "provider_failed",
          text: "Codex stopped unexpectedly.",
        });
      },
    });
    if (lifetime.signal.aborted) {
      await started.stop();
      throw new Error("Codex is closed.");
    }
    server = started;
    return started;
  }

  async function shutDown(): Promise<void> {
    const old = server;
    server = undefined;
    loaded.clear();
    await old?.stop();
    endAll({
      status: "failed",
      reason: "provider_failed",
      text: "Codex stopped.",
    });
  }

  /** Ends every running turn the same way; their app-server is gone. */
  function endAll(end: TurnEnd): void {
    // Each one leaves the map as it ends; a Map's iteration allows that.
    for (const running of turns.values()) finish(running, end);
  }

  /** A turn has ended: told once, and nothing more of it is shown. */
  function finish(running: Running, end: TurnEnd): void {
    if (turns.get(running.threadId) !== running) return;
    turns.delete(running.threadId);
    clearTimeout(running.deadline);
    if (turns.size === 0) {
      clearInterval(tracking);
      tracking = undefined;
    }
    running.ended.resolve();
    emit({
      type: "turnEnded",
      threadId: running.threadId,
      turnId: running.turnId,
      end: running.end ?? end,
    });
  }

  /** The settings a thread starts or resumes with; checked against Codex's answer. */
  const settingsFor = (settings: ThreadSettings) => ({
    model: settings.model,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    developerInstructions: settings.instructions,
    // Resumed with a model, Codex takes the effort from its config again,
    // not the thread's own: it is given here, before the resume runs
    // anything that waits.
    ...(settings.effort !== undefined && {
      config: { model_reasoning_effort: settings.effort },
    }),
  });

  function check(
    response: ThreadStartResponse | ThreadResumeResponse,
    settings: ThreadSettings,
  ): void {
    const problems: string[] = [];
    if (response.model !== settings.model) {
      problems.push(`the model is ${response.model}`);
    }
    if (
      settings.effort !== undefined &&
      response.reasoningEffort !== settings.effort
    ) {
      problems.push(`the effort is ${String(response.reasoningEffort)}`);
    }
    if (response.approvalPolicy !== "never") {
      problems.push("it asks for approvals");
    }
    if (response.sandbox.type !== "dangerFullAccess") {
      problems.push(`its access is ${response.sandbox.type}`);
    }
    if (problems.length > 0) {
      throw new Error(
        `Codex didn't take Rufi's thread settings: ${problems.join("; ")}.`,
      );
    }
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
   * Runs one of Rufi's tools for a running turn. Always a result, never a
   * JSON-RPC error: Codex would turn that into a bare "request failed".
   */
  async function callTool(
    call: DynamicToolCallParams,
  ): Promise<DynamicToolCallResponse> {
    const reply = (ok: boolean, text: string): DynamicToolCallResponse => ({
      contentItems: [{ type: "inputText", text }],
      success: ok,
    });
    const running = turns.get(call.threadId);
    if (!running || running.turnId !== call.turnId || running.stopping) {
      return reply(
        false,
        JSON.stringify({ ok: false, error: "No turn is running." }),
      );
    }
    const name =
      call.namespace === deps.tools?.namespace
        ? call.tool
        : `${call.namespace ?? ""}.${call.tool}`;
    const timedOut = {
      ok: false,
      text: JSON.stringify({ ok: false, error: `${name} took too long.` }),
    };
    const answer = await Promise.race([
      deps.host.callTool(
        call.threadId,
        call.turnId,
        name,
        call.arguments,
        call.callId,
      ),
      sleep(deadlines.toolMs, timedOut, { ref: false }),
    ]);
    if ("stopTurn" in answer && answer.stopTurn !== undefined) {
      running.end ??= { status: "failed", text: answer.stopTurn };
      void stopTurn(running);
    }
    return reply(answer.ok, answer.text);
  }

  function onNotification(method: string, params: unknown): void {
    const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
    switch (method) {
      case "account/rateLimits/updated":
        limits = {
          ...limits,
          ...(params as AccountRateLimitsUpdatedNotification).rateLimits,
        };
        return;
      case "turn/started": {
        const { turn } = params as TurnStartedNotification;
        if (typeof threadId === "string") started(threadId, turn.id);
        return;
      }
    }
    const running =
      typeof threadId === "string" ? turns.get(threadId) : undefined;
    if (!running) {
      log("codex.notification_ignored", { method });
      return;
    }
    const p = params as { turnId?: unknown; turn?: { id?: unknown } };
    if ((p.turnId ?? p.turn?.id) !== running.turnId) {
      log("codex.other_turn", { method });
      return;
    }
    if (method === "turn/completed") {
      const { turn } = params as TurnCompletedNotification;
      // Nothing after a Stop was kept, so a stopped reply isn't whole even
      // when Codex finished it first.
      const stopped = running.stopping && turn.status === "completed";
      finish(
        running,
        endOf(stopped ? { ...turn, status: "interrupted" } : turn, limits),
      );
      return;
    }
    // Nothing of a stopped turn is shown or saved after the Stop, except the
    // person's own message, which Codex may show a moment after the start.
    const ownMessage =
      method === "item/started" &&
      (params as ItemStartedNotification).item.type === "userMessage";
    if (running.stopping && !ownMessage) return;
    handle(running, method, params);
  }

  function started(threadId: string, turnId: string): void {
    const previous = turns.get(threadId);
    if (previous) {
      finish(previous, {
        status: "failed",
        reason: "provider_failed",
        text: "Codex started another reply.",
      });
    }
    const running: Running = {
      threadId,
      turnId,
      end: undefined,
      streamed: new Set(),
      messaged: Promise.withResolvers(),
      ended: Promise.withResolvers(),
      stopping: undefined,
      deadline: setTimeout(() => {
        running.end ??= {
          status: "failed",
          reason: "timeout",
          text: "The reply took too long, so Rufi stopped it.",
        };
        void stopTurn(running);
      }, deadlines.turnMs),
    };
    turns.set(threadId, running);
    tracking ??= setInterval(() => void track(), TRACK_EVERY_MS);
    emit({ type: "turnStarted", threadId, turnId });
    if (stopNext.delete(threadId)) void stopTurn(running);
  }

  /** One of the running turn's events. */
  function handle(running: Running, method: string, params: unknown): void {
    const { threadId, turnId } = running;
    switch (method) {
      case "item/started": {
        const { item } = params as ItemStartedNotification;
        if (item.type === "userMessage") {
          running.messaged.resolve();
          // Only messages Rufi sent carry Rufi's id.
          if (item.clientId === null) {
            log("codex.notification_ignored", { method });
            return;
          }
          emit({
            type: "message",
            threadId,
            turnId,
            id: item.clientId,
            text: messageText(item.content),
          });
          return;
        }
        if (item.type === "commandExecution") void track();
        const activity = activityOf(item, false, deps.tools);
        if (activity) {
          emit({
            type: "activity",
            threadId,
            turnId,
            itemId: item.id,
            ...activity,
            details: item,
          });
        }
        return;
      }
      case "item/agentMessage/delta": {
        const { itemId, delta } = params as AgentMessageDeltaNotification;
        running.streamed.add(itemId);
        emit({ type: "text", threadId, turnId, itemId, delta });
        return;
      }
      case "item/completed": {
        const { item } = params as ItemCompletedNotification;
        if (item.type === "userMessage") return;
        if (item.type === "agentMessage") {
          // Text that didn't stream, and questions the AI asks the user
          // (Codex's request_user_input_async), arrive only here.
          if (!running.streamed.has(item.id) && item.text) {
            emit({
              type: "text",
              threadId,
              turnId,
              itemId: item.id,
              delta: item.text,
            });
          }
          for (const question of item.questions ?? []) {
            emit({
              type: "question",
              threadId,
              turnId,
              itemId: item.id,
              title: question.title,
              options: question.options ?? [],
            });
          }
          return;
        }
        if (item.type === "reasoning") {
          emit({
            type: "reasoning",
            threadId,
            turnId,
            itemId: item.id,
            summary: item.summary.join("\n\n"),
            details: item,
          });
          return;
        }
        const activity = activityOf(item, true, deps.tools);
        if (activity) {
          emit({
            type: "activity",
            threadId,
            turnId,
            itemId: item.id,
            ...activity,
            details: item,
          });
        }
        return;
      }
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
   * the clean-up only means it was queued. If anything fails or takes too
   * long, Rufi ends Codex. Runs once per turn.
   */
  /**
   * After a request that may start a reply, when a Stop came during it: that
   * reply stops too, also one Codex starts a moment later.
   */
  async function stoppedDuring(threadId: string): Promise<never> {
    const reply = turns.get(threadId);
    if (reply) await stopTurn(reply);
    else stopNext.add(threadId);
    throw new Stopped();
  }

  /**
   * Runs requests that may start a reply. A Stop while they run stops that
   * reply at once, or as soon as Codex starts it; Codex may still act on a
   * request that failed or timed out here.
   */
  async function mayStart<T>(
    threadId: string,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    // Stopped already (while the effort was set, say): nothing leaves.
    // A listener added now would never hear that Stop.
    if (signal?.aborted) throw new Stopped();
    const onStop = () => {
      const reply = turns.get(threadId);
      if (reply) void stopTurn(reply);
      else stopNext.add(threadId);
    };
    signal?.addEventListener("abort", onStop, { once: true });
    let result: T;
    try {
      result = await run();
    } catch (error) {
      if (signal?.aborted) await stoppedDuring(threadId);
      throw error;
    } finally {
      signal?.removeEventListener("abort", onStop);
    }
    if (signal?.aborted) await stoppedDuring(threadId);
    return result;
  }

  function stopTurn(running: Running): Promise<void> {
    running.stopping ??= interruptAndClean(running);
    return running.stopping;
  }

  async function interruptAndClean(running: Running): Promise<void> {
    // Codex records the message a moment after the turn starts; interrupted
    // before that, it drops the message. Wait for it (shown, nothing else).
    await Promise.race([
      running.messaged.promise,
      running.ended.promise,
      sleep(deadlines.interruptAckMs, undefined, { ref: false }),
    ]);
    const app = server;
    if (app?.running()) {
      let interrupted = false;
      try {
        await app.rpc.request(
          "turn/interrupt",
          { threadId: running.threadId, turnId: running.turnId },
          deadlines.interruptAckMs,
        );
        interrupted = true;
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
        // The turn may simply have ended before the interrupt.
        if (!interrupted && turns.get(running.threadId) !== running) return;
        log("codex.interrupt_failed", { error: errorCode(error) });
      }
    }
    running.end ??= {
      status: "interrupted",
      reason: "stopped",
      text: "Codex didn't stop when asked, so Rufi ended it.",
    };
    await shutDown();
  }

  /** Codex with the thread open in it; Rufi opens threads only when asked. */
  async function open(threadId: string): Promise<AppServer> {
    const app = await ready();
    if (!loaded.has(threadId)) {
      throw new Error("Open the chat's thread first.");
    }
    return app;
  }

  return {
    provider: "codex",

    models: async (signal) => {
      const app = await ready(signal);
      const models: Model[] = [];
      let cursor: string | null = null;
      do {
        const page: ModelListResponse = await request(app, "model/list", {
          cursor,
          includeHidden: false,
        });
        for (const model of page.data) {
          models.push({ id: model.id, name: model.displayName });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return models;
    },

    startThread: async (settings, signal) => {
      const app = await ready(signal);
      // Codex keeps a thread's tools and restores them on resume; they can
      // only be given when it starts.
      const response = await abortable(
        request<ThreadStartResponse>(app, "thread/start", {
          ...settingsFor(settings),
          ...(deps.tools && { dynamicTools: dynamicTools(deps.tools) }),
        }),
        signal,
      );
      loaded.add(response.thread.id);
      check(response, settings);
      return { threadId: response.thread.id, model: response.model };
    },

    resumeThread: async (threadId, settings, signal) => {
      const app = await ready(signal);
      const response = await abortable(
        request<ThreadResumeResponse>(app, "thread/resume", {
          threadId,
          excludeTurns: true,
          ...settingsFor(settings),
        }),
        signal,
      );
      loaded.add(threadId);
      const running =
        response.thread.status.type === "active" || turns.has(threadId);
      check(response, settings);
      return { model: response.model, running };
    },

    loaded: (threadId) => loaded.has(threadId) && server?.running() === true,

    running: (threadId) => turns.has(threadId),

    send: async (threadId, message, signal) => {
      let app: AppServer;
      try {
        app = await open(threadId);
      } catch (error) {
        throw new NotSent(errorText(error), { cause: error });
      }
      if (signal?.aborted)
        throw new NotSent("Stopped.", { cause: new Stopped() });
      // turn/start into a running reply would steer it: never.
      if (turns.has(threadId)) {
        throw new NotSent("A reply is running in this chat.");
      }
      stopNext.delete(threadId);
      await mayStart(threadId, signal, async () => {
        try {
          await request(app, "turn/start", {
            threadId,
            input: message.input.map(textInput),
            clientUserMessageId: message.id,
            ...(message.effort !== undefined && { effort: message.effort }),
          } satisfies TurnStartParams);
        } catch (error) {
          // Codex answered no: it didn't take the message.
          if (error instanceof RpcError) {
            throw new NotSent(error.message, { cause: error });
          }
          throw error;
        }
      });
    },

    steer: async (threadId, message) => {
      const app = await open(threadId);
      const running = turns.get(threadId);
      if (!running || running.stopping) {
        throw new Error("No reply is running to steer.");
      }
      const { turnId } = await request<TurnSteerResponse>(app, "turn/steer", {
        threadId,
        expectedTurnId: running.turnId,
        clientUserMessageId: message.id,
        input: [textInput(message.text)],
      });
      return { turnId };
    },

    stop: async (threadId, turnId) => {
      const running = turns.get(threadId);
      if (running && (turnId === undefined || running.turnId === turnId)) {
        await stopTurn(running);
      }
    },

    startedMessages: async (threadId) => {
      const app = await open(threadId);
      // Every page, newest first; then oldest first.
      const turnsRun: ThreadTurnsListResponse["data"] = [];
      let cursor: string | null = null;
      do {
        const page: ThreadTurnsListResponse = await request(
          app,
          "thread/turns/list",
          {
            threadId,
            cursor,
            limit: 50,
            sortDirection: "desc",
            itemsView: "full",
          },
        );
        turnsRun.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      return turnsRun
        .reverse()
        .flatMap((turn) =>
          turn.items.flatMap((item) =>
            item.type === "userMessage" && item.clientId !== null
              ? [{ id: item.clientId, text: messageText(item.content) }]
              : [],
          ),
        );
    },

    close: async () => {
      lifetime.abort();
      // An app-server still starting is ended by the abort; wait for that.
      await starting?.catch(() => undefined);
      endAll({
        status: "interrupted",
        reason: "stopped",
        text: "Rufi closed Codex.",
      });
      await shutDown();
    },
  };
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Codex couldn't take the message.";

/** Waits for `promise`, or until `signal` aborts: then it's a Stop. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Stopped());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Stopped());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
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
        name: spec.name,
        description: spec.description,
        // A JSON Schema made by Effect Schema: plain JSON.
        inputSchema: spec.inputSchema as JsonValue,
      })),
    },
  ];
}
