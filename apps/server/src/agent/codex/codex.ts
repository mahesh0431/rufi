// The Codex implementation of AgentRuntime: one app-server for every thread,
// each working in the AI's folder under Rufi's permission profile (it writes
// only there, reads anything but the record, and uses the network; ADR
// 0016), with Rufi's skills in its CODEX_HOME. Rufi starts each reply with turn/start
// when none runs; Codex's own queue is not used (Rufi keeps what waits).
// Codex signs in by itself, with its own ChatGPT login in CODEX_HOME, and
// renews it as it goes; Rufi asks it whether it is signed in before it sends
// anything, and starts its sign-in from the screens. Each thread gets Rufi's tools from Rufi's MCP server, with its own
// key (settings.ts); Codex calls the server itself, and Rufi binds each call
// to the reply it was made in (activeTurn).
import { setTimeout as sleep } from "node:timers/promises";
import {
  NotOpened,
  NotReloaded,
  NotSent,
  SignedOut,
  Stopped,
  ThreadNotFound,
  type AgentEvent,
  type AgentHost,
  type AgentRuntime,
  type AgentSandbox,
  type AgentSkill,
  type Model,
  type ThreadSettings,
  type TurnEnd,
} from "../runtime.ts";
import {
  DEADLINES,
  SIGNED_OUT,
  signedOut,
  startAppServer,
  type AppServer,
  type CodexCommand,
  type Deadlines,
} from "./appserver.ts";
import { activityOf, endOf, messageText } from "./events.ts";
import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";
import type { AccountLoginCompletedNotification } from "./protocol/v2/AccountLoginCompletedNotification.ts";
import type { AccountRateLimitsUpdatedNotification } from "./protocol/v2/AccountRateLimitsUpdatedNotification.ts";
import type { AgentMessageDeltaNotification } from "./protocol/v2/AgentMessageDeltaNotification.ts";
import type { ItemCompletedNotification } from "./protocol/v2/ItemCompletedNotification.ts";
import type { GetAccountResponse } from "./protocol/v2/GetAccountResponse.ts";
import type { ItemStartedNotification } from "./protocol/v2/ItemStartedNotification.ts";
import type { LoginAccountResponse } from "./protocol/v2/LoginAccountResponse.ts";
import type { ModelListResponse } from "./protocol/v2/ModelListResponse.ts";
import type { RateLimitSnapshot } from "./protocol/v2/RateLimitSnapshot.ts";
import type { ReasoningSummaryTextDeltaNotification } from "./protocol/v2/ReasoningSummaryTextDeltaNotification.ts";
import type { ThreadBackgroundTerminalsListResponse } from "./protocol/v2/ThreadBackgroundTerminalsListResponse.ts";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.ts";
import type { ThreadInjectItemsParams } from "./protocol/v2/ThreadInjectItemsParams.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { ThreadTokenUsageUpdatedNotification } from "./protocol/v2/ThreadTokenUsageUpdatedNotification.ts";
import type { ThreadUnsubscribeResponse } from "./protocol/v2/ThreadUnsubscribeResponse.ts";
import type { TurnCompletedNotification } from "./protocol/v2/TurnCompletedNotification.ts";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.ts";
import type { TurnSteerResponse } from "./protocol/v2/TurnSteerResponse.ts";
import type { TurnStartedNotification } from "./protocol/v2/TurnStartedNotification.ts";
import type { UserInput } from "./protocol/v2/UserInput.ts";
import { errorCode, type Log } from "../../platform/logs.ts";
import { RpcError } from "./rpc.ts";
import {
  AI_PROFILE,
  mcpServers,
  prepareCodexHome,
  type CodexPaths,
} from "./settings.ts";

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
  version: string;
  deadlines?: Partial<Deadlines>;
  /** Where events go. */
  host: AgentHost;
  /** Diagnostics: what Rufi ignored or refused, as event names and codes. */
  log?: Log;
}

/** How often Rufi notes the process groups of running commands. */
const TRACK_EVERY_MS = 500;

interface Running {
  threadId: string;
  turnId: string;
  /** How it ended, when Rufi decided it (a Stop, a tool loop). */
  end: TurnEnd | undefined;
  /** When Codex said it started. */
  startedAt: number;
  /**
   * Agent messages whose text came as they started or in deltas; the others
   * arrive whole at their end.
   */
  streamed: Set<string>;
  /**
   * Agent messages Codex marked as its progress notes (commentary), by item:
   * known from `item/started`, as the deltas carry only the item's id.
   */
  notes: Set<string>;
  /** The summary part each reasoning item streams now, by item. */
  thinking: Map<string, number>;
  /** Settles once the turn has ended. */
  ended: PromiseWithResolvers<void>;
  /** A Stop under way; nothing more of the turn is shown after it. */
  stopping: Promise<void> | undefined;
  /** Settles once Codex has shown the user's message that started it. */
  messaged: PromiseWithResolvers<void>;
}

const textInput = (text: string): UserInput => ({
  type: "text",
  text,
  text_elements: [],
});

/** A model as Codex lists it, with the efforts it takes. */
interface CodexModel extends Model {
  efforts: string[];
  defaultEffort: string;
}

/** Codex's sign-in as it reports it: the account's email, when it gives one. */
interface CodexAccount {
  signedIn: boolean;
  email: string | null;
}

/** What the Codex adapter needs beyond what the chat uses. */
export interface CodexRuntime extends AgentRuntime {
  /**
   * Codex's home, written once for this run: the chat's app-server and the
   * reader's use it, and share its sign-in.
   */
  codexHome: () => Promise<CodexPaths>;
  /** Whether Codex is signed in, as it says. */
  account: () => Promise<CodexAccount>;
  /**
   * Starts Codex's own ChatGPT sign-in: the link to its page in the browser,
   * and once it has finished. Aborting `signal` cancels it.
   */
  signIn: (
    signal: AbortSignal,
  ) => Promise<{ link: string; done: Promise<void> }>;
  /** The models Codex offers now, with their efforts. */
  catalog: (signal?: AbortSignal) => Promise<CodexModel[]>;
  /** Codex's usage limits as it last reported them. */
  limits: () => RateLimitSnapshot | undefined;
  /**
   * Lets go of a thread Codex has open, once no reply runs in it, so the
   * next resume gives it new settings.
   */
  release: (threadId: string) => Promise<void>;
  /** Deletes a thread no reply runs in; one Codex hasn't got counts as deleted. */
  deleteThread: (threadId: string) => Promise<void>;
}

export function codexRuntime(deps: CodexDeps): CodexRuntime {
  const deadlines = { ...DEADLINES, ...deps.deadlines };
  const log = deps.log ?? (() => undefined);
  const emit = (event: AgentEvent) => {
    deps.host.onEvent(event);
  };
  /** Aborted by close(): ends an app-server that is still starting. */
  const lifetime = new AbortController();
  let server: AppServer | undefined;
  let starting: Promise<AppServer> | undefined;
  /** One cancellable prepare/send operation uses one readiness decision. */
  const prepared = new WeakMap<AbortSignal, AppServer>();
  const loaded = new Set<string>(); // threads open in the current app-server
  /** Settings to pick a known thread up after its app-server is replaced. */
  const threads = new Map<string, ThreadSettings>();
  /** Threads Rufi let go of, until Codex says they are closed. */
  const closing = new Map<string, PromiseWithResolvers<undefined>>();
  const turns = new Map<string, Running>(); // the running turn of each thread
  /** Threads where a Stop came during a send: the reply it starts is stopped. */
  const stopNext = new Set<string>();
  /** Codex's sign-ins under way, by Codex's id for each. */
  const logins = new Map<string, PromiseWithResolvers<undefined>>();
  let home: Promise<CodexPaths> | undefined;
  const codexHome = () =>
    (home ??= prepareCodexHome(deps.home, {
      userHome: deps.env["HOME"],
      sandbox: deps.sandbox,
      skills: deps.skills,
    }));
  let limits: RateLimitSnapshot | undefined;
  let tracking: NodeJS.Timeout | undefined;

  const request = <T>(app: AppServer, method: string, params: unknown) =>
    app.rpc.request<T>(method, params, deadlines.requestMs);

  /**
   * Codex, once it says it is signed in: signed out, nothing is sent. Thread
   * preparation and its hand-over share a signal: a new thread has no saved
   * rollout to resume if a second decision replaces its server.
   */
  async function ready(signal?: AbortSignal): Promise<AppServer> {
    const previous = signal && prepared.get(signal);
    if (previous === server && previous?.running()) {
      if (signal?.aborted) throw new Stopped();
      return previous;
    }
    const app = await up(signal);
    const answer = await request<GetAccountResponse>(app, "account/read", {});
    if (signedOut(answer)) throw new SignedOut(SIGNED_OUT);
    if (signal?.aborted) throw new Stopped();
    if (signal) prepared.set(signal, app);
    return app;
  }

  /** The running app-server, started when there is none. */
  async function up(signal?: AbortSignal): Promise<AppServer> {
    if (lifetime.signal.aborted) throw new Error("Codex is closed.");
    if (server?.running()) return server;
    starting ??= start().finally(() => {
      starting = undefined;
    });
    return abortable(starting, signal);
  }

  async function start(): Promise<AppServer> {
    await shutDown();
    const paths = await codexHome();
    const started = await startAppServer({
      command: deps.command,
      env: { ...deps.env, HOME: paths.processHome },
      codexHome: paths.codexHome,
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
        for (const [id, login] of logins) {
          logins.delete(id);
          login.reject(new Error("Codex stopped before the sign-in finished."));
        }
        // Rufi clears `server` before ending one itself; only a crash gets here.
        if (!server || server.running()) return;
        server = undefined;
        forgetThreads();
        endAll({
          status: "failed",
          reason: "provider_failed",
          text: "Codex stopped unexpectedly.",
          died: true,
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
      died: true,
    });
  }

  /** The app-server is gone, and with it every thread it had open. */
  function forgetThreads(): void {
    loaded.clear();
    for (const waiting of closing.values()) waiting.resolve(undefined);
    closing.clear();
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
      cwd: settings.cwd ?? deps.sandbox.folder,
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
      case "account/login/completed": {
        const { loginId, success, error } =
          params as AccountLoginCompletedNotification;
        const login = loginId === null ? undefined : logins.get(loginId);
        if (!login || loginId === null) return;
        logins.delete(loginId);
        if (success) login.resolve(undefined);
        else login.reject(new Error(error ?? "The sign-in didn't finish."));
        return;
      }
      case "thread/closed":
        if (typeof threadId === "string") {
          loaded.delete(threadId);
          closing.get(threadId)?.resolve(undefined);
        }
        return;
    }
    // Also outside a reply: a resume gives the thread's last usage again.
    if (method === "thread/tokenUsage/updated") {
      const { turnId, tokenUsage } =
        params as ThreadTokenUsageUpdatedNotification;
      if (typeof threadId === "string") {
        emit({
          type: "usage",
          threadId,
          turnId,
          tokens: tokenUsage.last.totalTokens,
          window: tokenUsage.modelContextWindow,
        });
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
      startedAt: Date.now(),
      streamed: new Set(),
      notes: new Set(),
      thinking: new Map(),
      messaged: Promise.withResolvers(),
      ended: Promise.withResolvers(),
      stopping: undefined,
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
        if (item.type === "agentMessage") {
          if (item.phase === "commentary") running.notes.add(item.id);
          // Codex can give a message's first words as it starts.
          if (item.text) textDelta(running, item.id, item.text);
          return;
        }
        if (item.type === "commandExecution") void track();
        const activity = activityOf(item, false);
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
      case "item/agentMessage/delta": {
        const { itemId, delta } = params as AgentMessageDeltaNotification;
        textDelta(running, itemId, delta);
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
          // A note ends whole, with its text when it didn't stream.
          if (running.notes.has(item.id) || item.phase === "commentary") {
            emit({
              type: "note",
              threadId,
              turnId,
              itemId: item.id,
              delta: running.streamed.has(item.id) ? "" : item.text,
              done: true,
            });
          }
          // Text that didn't stream, and questions the AI asks the user
          // (Codex's request_user_input_async), arrive only here; a
          // question is always part of the reply, so it is never lost.
          else if (!running.streamed.has(item.id) && item.text) {
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
          // The answer is whole; one never completed was cut.
          if (!running.notes.has(item.id) && item.phase !== "commentary") {
            emit({
              type: "text",
              threadId,
              turnId,
              itemId: item.id,
              delta: "",
              done: true,
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
        const activity = activityOf(item, true);
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

  /** Part of an agent message: to its note, or to its reply. */
  function textDelta(running: Running, itemId: string, delta: string): void {
    running.streamed.add(itemId);
    emit({
      type: running.notes.has(itemId) ? "note" : "text",
      threadId: running.threadId,
      turnId: running.turnId,
      itemId,
      delta,
    });
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

  /**
   * Picks a thread up with the same checked settings and MCP registration.
   * Codex's answer for a thread it has no files of (0.159.3) is the only
   * one that says the thread is gone; any other failure only says it didn't
   * open now.
   */
  async function resume(
    app: AppServer,
    threadId: string,
    settings: ThreadSettings,
    signal?: AbortSignal,
  ) {
    let response: ThreadResumeResponse;
    try {
      response = await abortable(
        request<ThreadResumeResponse>(app, "thread/resume", {
          threadId,
          excludeTurns: true,
          ...settingsFor(settings),
        }).catch(toolsFailed),
        signal,
      );
      check(response, settings);
    } catch (error) {
      if (error instanceof Stopped) throw error;
      if (
        error instanceof RpcError &&
        error.code === -32600 &&
        error.message ===
          `Codex refused thread/resume: no rollout found for thread id ${threadId}`
      ) {
        throw new ThreadNotFound(error.message, { cause: error });
      }
      throw new NotOpened(errorText(error), { cause: error });
    }
    const running =
      response.thread.status.type === "active" || turns.has(threadId);
    loaded.add(threadId);
    threads.set(threadId, settings);
    return { model: response.model, running };
  }

  /**
   * Lets go of a thread Codex has open; it closes at once
   * (thread_unload_delay_secs = 0).
   */
  async function unload(
    app: AppServer,
    threadId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!loaded.has(threadId)) return;
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
    } finally {
      closing.delete(threadId);
    }
    loaded.delete(threadId);
  }

  /** The models, every page, with their efforts. */
  async function catalog(signal?: AbortSignal): Promise<CodexModel[]> {
    const app = await ready(signal);
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const page: ModelListResponse = await request(app, "model/list", {
        cursor,
        includeHidden: false,
      });
      for (const model of page.data) {
        models.push({
          id: model.id,
          name: model.displayName,
          efforts: model.supportedReasoningEfforts.map(
            (option) => option.reasoningEffort,
          ),
          defaultEffort: model.defaultReasoningEffort,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  }

  /** A new app-server (after a crash) picks a known thread up again. */
  async function open(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<AppServer> {
    const previous = server;
    const app = await ready(signal);
    if (!loaded.has(threadId)) {
      const settings = previous !== app ? threads.get(threadId) : undefined;
      if (!settings) throw new Error("Open the chat's thread first.");
      await resume(app, threadId, settings, signal);
    }
    return app;
  }

  return {
    provider: "codex",

    codexHome,

    account: async () => {
      const answer = await request<GetAccountResponse>(
        await up(),
        "account/read",
        {},
      );
      const { account } = answer;
      return {
        signedIn: !signedOut(answer),
        email: account?.type === "chatgpt" ? account.email : null,
      };
    },

    signIn: async (signal) => {
      const app = await up(signal);
      const started = await request<LoginAccountResponse>(
        app,
        "account/login/start",
        { type: "chatgpt" },
      );
      if (started.type !== "chatgpt") {
        throw new Error("Codex didn't start its ChatGPT sign-in.");
      }
      const { loginId } = started;
      const login = Promise.withResolvers<undefined>();
      logins.set(loginId, login);
      signal.addEventListener("abort", () => {
        if (!logins.delete(loginId)) return;
        login.reject(new Error("The sign-in didn't finish."));
        void request(app, "account/login/cancel", { loginId }).catch(
          () => undefined,
        );
      });
      return { link: started.authUrl, done: login.promise };
    },

    models: async (signal) =>
      (await catalog(signal)).map(({ id, name }) => ({ id, name })),

    catalog,

    limits: () => limits,

    deleteThread: async (threadId) => {
      if (turns.has(threadId)) throw new Error("A reply is running.");
      const app = await ready();
      threads.delete(threadId);
      try {
        await request(app, "thread/delete", { threadId });
      } catch (error) {
        // Codex's answer for a thread it has no files of (0.163.0).
        if (
          !(error instanceof RpcError) ||
          error.code !== -32600 ||
          error.message !==
            `Codex refused thread/delete: no rollout found for thread id ${threadId}`
        ) {
          throw error;
        }
      }
      loaded.delete(threadId);
    },

    release: async (threadId) => {
      if (turns.has(threadId)) throw new Error("A reply is running.");
      threads.delete(threadId);
      const app = server;
      if (app?.running()) await unload(app, threadId);
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
      threads.set(response.thread.id, settings);
      return { threadId: response.thread.id, model: response.model };
    },

    resumeThread: async (threadId, settings, signal) => {
      const app = await ready(signal);
      return resume(app, threadId, settings, signal);
    },

    reloadThread: async (threadId, settings, note, signal) => {
      const app = await ready(signal);
      if (turns.has(threadId)) {
        throw new NotReloaded(
          "The AI is busy in this chat. Try again in a moment.",
        );
      }
      // Codex ignores new settings for a thread it has open: it is let go
      // of first.
      try {
        await unload(app, threadId, signal);
      } catch (error) {
        if (error instanceof Stopped) throw error;
        throw new NotReloaded(undefined, { cause: error });
      }
      const response = await resume(app, threadId, settings, signal);
      // The history still holds the instructions the thread was first given
      // (0.159.3): the note says the new ones replace them. Codex stores it
      // before it answers.
      try {
        await abortable(
          request(app, "thread/inject_items", {
            threadId,
            items: [
              {
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: note }],
              },
            ],
          } satisfies ThreadInjectItemsParams),
          signal,
        );
      } catch (error) {
        if (error instanceof Stopped) throw error;
        throw new NotReloaded(undefined, { cause: error });
      }
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
        app = await open(threadId, signal);
      } catch (error) {
        throw new NotSent(errorText(error), { cause: error });
      } finally {
        if (signal) prepared.delete(signal);
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
      let app: AppServer;
      try {
        app = await open(threadId);
      } catch (error) {
        throw new NotSent(errorText(error), { cause: error });
      }
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
 * An item as Rufi keeps it: a page image the AI was given is left out (it is
 * a copy of the document's page, and large), and so are a generated
 * picture's bytes (Codex saved them as a file).
 */
function withoutImages(item: ThreadItem): ThreadItem {
  // A generated picture is its file; its bytes aren't kept twice.
  if (item.type === "imageGeneration") {
    return { ...item, result: "(a generated picture, not kept)" };
  }
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
