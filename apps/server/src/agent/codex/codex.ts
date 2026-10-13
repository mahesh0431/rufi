// The Codex implementation of AgentRuntime: one app-server for every thread,
// each working in the AI's folder under Rufi's permission profile (it writes
// only there, reads anything but the record, and uses the network; ADR
// 0016), with Rufi's skills in its CODEX_HOME. Rufi starts each reply with turn/start
// when none runs; Codex's own queue is not used (Rufi keeps what waits). A
// new app-server starts when the access token changes and no reply is
// running. Each thread gets Rufi's tools from Rufi's MCP server, with its own
// key (settings.ts); Codex calls the server itself, and Rufi binds each call
// to the reply it was made in (activeTurn).
import { setTimeout as sleep } from "node:timers/promises";
import {
  NotReloaded,
  NotSent,
  Stopped,
  type AgentEvent,
  type AgentHost,
  type AgentRuntime,
  type AgentSandbox,
  type AgentSkill,
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
import type { ItemCompletedNotification } from "./protocol/v2/ItemCompletedNotification.ts";
import type { ItemStartedNotification } from "./protocol/v2/ItemStartedNotification.ts";
import type { ModelListResponse } from "./protocol/v2/ModelListResponse.ts";
import type { RateLimitSnapshot } from "./protocol/v2/RateLimitSnapshot.ts";
import type { ReasoningSummaryTextDeltaNotification } from "./protocol/v2/ReasoningSummaryTextDeltaNotification.ts";
import type { ThreadBackgroundTerminalsListResponse } from "./protocol/v2/ThreadBackgroundTerminalsListResponse.ts";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse.ts";
import type { ThreadUnsubscribeResponse } from "./protocol/v2/ThreadUnsubscribeResponse.ts";
import type { TurnCompletedNotification } from "./protocol/v2/TurnCompletedNotification.ts";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.ts";
import type { TurnSteerResponse } from "./protocol/v2/TurnSteerResponse.ts";
import type { TurnStartedNotification } from "./protocol/v2/TurnStartedNotification.ts";
import type { UserInput } from "./protocol/v2/UserInput.ts";
import { errorCode, type Log } from "../../platform/logs.ts";
import { RpcError } from "./rpc.ts";
import { AI_PROFILE, mcpServers, prepareCodexHome } from "./settings.ts";

export interface CodexDeps {
  /** Rufi's data folder; Codex gets `codex/` inside it. */
  home: string;
  /** The AI's folder, its working folder, and what its commands can't read. */
  sandbox: AgentSandbox;
  /** Rufi's skills, written into CODEX_HOME at each start. */
  skills: readonly AgentSkill[];
  command: CodexCommand;
  /** The child's environment, without secrets (platform/config.ts). */
  env: Readonly<Record<string, string>>;
  /** An access token valid for at least `validForMs`. */
  token: (validForMs: number) => Promise<string>;
  version: string;
  deadlines?: Partial<Deadlines>;
  /** Rufi's tools, for the words a person sees when the AI uses one. */
  tools?: AgentTools;
  /** Where events go. */
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
  /** The summary part each reasoning item streams now, by item. */
  thinking: Map<string, number>;
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
  const loaded = new Set<string>(); // threads open in the current app-server
  /** Threads Rufi let go of, until Codex says they are closed. */
  const closing = new Map<string, PromiseWithResolvers<undefined>>();
  /**
   * Threads Codex is summarising for Rufi, until it ends: how it ended. Its
   * turn is Rufi's own, never shown as a reply.
   */
  const compacting = new Map<string, PromiseWithResolvers<string>>();
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
    const paths = await prepareCodexHome(deps.home, {
      userHome: deps.env["HOME"],
      sandbox: deps.sandbox,
      skills: deps.skills,
    });
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
        forgetThreads();
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
    forgetThreads();
    await old?.stop();
    endAll({
      status: "failed",
      reason: "provider_failed",
      text: "Codex stopped.",
    });
  }

  /** The app-server is gone, and with it every thread it had open. */
  function forgetThreads(): void {
    loaded.clear();
    for (const waiting of closing.values()) waiting.resolve(undefined);
    closing.clear();
    for (const waiting of compacting.values()) waiting.resolve("failed");
    compacting.clear();
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
  const settingsFor = (settings: ThreadSettings) => {
    const config = {
      // Resumed with a model, Codex takes the effort from its config again,
      // not the thread's own: it is given here, before the resume runs
      // anything that waits.
      ...(settings.effort !== undefined && {
        model_reasoning_effort: settings.effort,
      }),
      // Codex keeps no MCP settings with a thread: given on every resume.
      ...(settings.tools && {
        mcp_servers: mcpServers(settings.tools, deadlines.toolMs),
      }),
    };
    return {
      model: settings.model,
      cwd: deps.sandbox.folder,
      approvalPolicy: "never",
      // The named profile, never the legacy `sandbox`: only a profile can
      // deny reads.
      permissions: AI_PROFILE,
      developerInstructions: settings.instructions,
      ...(Object.keys(config).length > 0 && { config }),
    };
  };

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
    // The profile Codex says is active, not the legacy projection of it,
    // which can't show denied reads.
    if (response.activePermissionProfile?.id !== AI_PROFILE) {
      problems.push(
        `its permissions are ${response.activePermissionProfile?.id ?? "unknown"}`,
      );
    }
    if (problems.length > 0) {
      loaded.delete(response.thread.id);
      throw new Error(
        `Codex didn't take Rufi's thread settings: ${problems.join("; ")}.`,
      );
    }
  }

  /** Codex asked Rufi something. Approvals are declined. */
  function answer(method: string): Promise<unknown> {
    log("codex.request", { method });
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return Promise.resolve({ decision: "decline" });
      default:
        return Promise.reject(
          new RpcError(-32601, `Rufi doesn't handle ${method}.`),
        );
    }
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
      case "thread/closed":
        if (typeof threadId === "string") {
          loaded.delete(threadId);
          closing.get(threadId)?.resolve(undefined);
        }
        return;
    }
    // A summary Rufi asked for: nothing of it is shown, only how it ended.
    const summarising =
      typeof threadId === "string" ? compacting.get(threadId) : undefined;
    if (summarising && typeof threadId === "string") {
      if (method === "turn/completed") {
        compacting.delete(threadId);
        summarising.resolve((params as TurnCompletedNotification).turn.status);
      }
      return;
    }
    if (method === "turn/started") {
      const { turn } = params as TurnStartedNotification;
      if (typeof threadId === "string") started(threadId, turn.id);
      return;
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
      thinking: new Map(),
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
        if (item.type === "reasoning") {
          running.thinking.set(item.id, 0);
          emit({
            type: "thinking",
            threadId,
            turnId,
            itemId: item.id,
            delta: "",
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
      case "item/reasoning/summaryTextDelta": {
        const { itemId, delta, summaryIndex } =
          params as ReasoningSummaryTextDeltaNotification;
        // A later part of the summary starts a new paragraph, as the whole
        // summary is joined.
        const part = running.thinking.get(itemId) ?? summaryIndex;
        running.thinking.set(itemId, summaryIndex);
        emit({
          type: "thinking",
          threadId,
          turnId,
          itemId,
          delta: summaryIndex > part ? `\n\n${delta}` : delta,
        });
        return;
      }
      case "item/reasoning/summaryPartAdded":
        // The next delta says which part it is.
        return;
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
            details: withoutImages(item),
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
      const response = await abortable(
        request<ThreadStartResponse>(
          app,
          "thread/start",
          settingsFor(settings),
        ).catch(toolsFailed),
        signal,
      );
      check(response, settings);
      loaded.add(response.thread.id);
      return { threadId: response.thread.id, model: response.model };
    },

    resumeThread: async (threadId, settings, signal) => {
      const app = await ready(signal);
      const response = await abortable(
        request<ThreadResumeResponse>(app, "thread/resume", {
          threadId,
          excludeTurns: true,
          ...settingsFor(settings),
        }).catch(toolsFailed),
        signal,
      );
      const running =
        response.thread.status.type === "active" || turns.has(threadId);
      check(response, settings);
      loaded.add(threadId);
      return { model: response.model, running };
    },

    reloadThread: async (threadId, settings, signal) => {
      const app = await ready(signal);
      // Still summarising after a Stop: the thread is there, but busy.
      if (turns.has(threadId) || compacting.has(threadId)) {
        throw new NotReloaded(
          "The AI is busy in this chat. Try again in a moment.",
        );
      }
      // Codex ignores new settings for a thread it has open: it is let go
      // of first, and closes at once (thread_unload_delay_secs = 0).
      if (loaded.has(threadId)) {
        const closed = Promise.withResolvers<undefined>();
        closing.set(threadId, closed);
        try {
          const { status } = await request<ThreadUnsubscribeResponse>(
            app,
            "thread/unsubscribe",
            { threadId },
          );
          if (status === "unsubscribed") {
            await within(closed.promise, deadlines.requestMs, signal);
          }
        } catch (error) {
          if (error instanceof Stopped) throw error;
          throw new NotReloaded(undefined, { cause: error });
        } finally {
          closing.delete(threadId);
        }
        loaded.delete(threadId);
      }
      const response = await abortable(
        request<ThreadResumeResponse>(app, "thread/resume", {
          threadId,
          excludeTurns: true,
          ...settingsFor(settings),
        }).catch(toolsFailed),
        signal,
      );
      check(response, settings);
      loaded.add(threadId);
      // The history still holds the instructions the thread was first given
      // (0.159.3); a summary of it starts again from the new ones.
      const summarised = Promise.withResolvers<string>();
      compacting.set(threadId, summarised);
      let status: string;
      try {
        await request(app, "thread/compact/start", { threadId });
        status = await within(summarised.promise, deadlines.turnMs, signal);
      } catch (error) {
        if (error instanceof Stopped) throw error;
        // Codex didn't start it, or it took too long: nothing more is waited for.
        if (compacting.get(threadId) === summarised)
          compacting.delete(threadId);
        throw new NotReloaded(undefined, { cause: error });
      }
      if (status !== "completed") throw new NotReloaded();
      return { model: response.model };
    },

    loaded: (threadId) => loaded.has(threadId) && server?.running() === true,

    running: (threadId) => turns.has(threadId),

    activeTurn: (threadId) => {
      const running = turns.get(threadId);
      return running && !running.stopping ? running.turnId : undefined;
    },

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
            ...(message.model !== undefined && { model: message.model }),
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
        throw new NotSent("No reply is running to steer.");
      }
      try {
        const { turnId } = await request<TurnSteerResponse>(app, "turn/steer", {
          threadId,
          expectedTurnId: running.turnId,
          clientUserMessageId: message.id,
          input: [textInput(message.text)],
        });
        return { turnId };
      } catch (error) {
        // Codex answered no: the reply ended before Rufi heard of it.
        if (error instanceof RpcError) {
          throw new NotSent(error.message, { cause: error });
        }
        throw error;
      }
    },

    stop: async (threadId, turnId, end) => {
      const running = turns.get(threadId);
      if (running && (turnId === undefined || running.turnId === turnId)) {
        running.end ??= end;
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

/**
 * Waits for `promise` (something Codex sends later), at most `ms`, or
 * until `signal` aborts: then it's a Stop.
 */
async function within<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await abortable(
      Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Codex didn't answer in time."));
          }, ms);
        }),
      ]),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

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

/**
 * Codex couldn't start or resume a thread because Rufi's MCP server didn't
 * start for it (a required server, 0.159.3): said plainly, the cause kept.
 */
function toolsFailed(error: unknown): never {
  if (
    error instanceof RpcError &&
    error.message.includes("required MCP servers failed to initialize")
  ) {
    throw new Error(
      "Rufi's tools didn't start for the AI, so it can't reply now. Try again; if it keeps happening, restart Rufi.",
      { cause: error },
    );
  }
  throw error;
}

/**
 * A tool call as Rufi keeps it: a page image the AI was given is left out
 * (it is a copy of the document's page, and large).
 */
function withoutImages(item: ThreadItem): ThreadItem {
  if (item.type !== "mcpToolCall" || !item.result) return item;
  return {
    ...item,
    result: {
      ...item.result,
      content: item.result.content.map((content) =>
        isImage(content)
          ? { ...content, data: "(a page image, not kept)" }
          : content,
      ),
    },
  };
}

const isImage = (content: JsonValue): content is { [key: string]: JsonValue } =>
  typeof content === "object" &&
  content !== null &&
  !Array.isArray(content) &&
  content["type"] === "image";
