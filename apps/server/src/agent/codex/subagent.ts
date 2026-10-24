// Rufi's private sub-agent runner on Codex: one locked-down thread, one turn,
// in an app-server of its own (its own CODEX_HOME and an empty working folder
// in the data folder's sub-agents/), so it shares nothing with the chat. The
// thread is ephemeral (nothing saved), has Codex's own prompt with no
// personality and Rufi's instructions as its developer instructions, no
// environment (no shell, files or patches), no network, no
// sub-agents, web search, goals, skills or questions to the user, and exactly
// the tools the task gives, from the MCP server and key the task names (on a
// code-mode model, inside Codex's exec, with the few tools Codex always adds
// there and its helpers for MCP resources). Rufi checks the thread's model,
// effort and access when it starts, and ends the turn as failed if Codex
// shows any item Rufi didn't allow. The offline contract test
// (subagent.test.ts) proves the complete set of tools each model gets on the
// pinned Codex.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { errorCode, type Log } from "../../platform/logs.ts";
import type {
  RunSubAgent,
  SubAgentOutcome,
  SubAgentTask,
  TurnEnd,
} from "../runtime.ts";
import {
  DEADLINES,
  startAppServer,
  type AppServer,
  type CodexCommand,
  type Deadlines,
} from "./appserver.ts";
import { endOf } from "./events.ts";
import type { AccountRateLimitsUpdatedNotification } from "./protocol/v2/AccountRateLimitsUpdatedNotification.ts";
import type { RateLimitSnapshot } from "./protocol/v2/RateLimitSnapshot.ts";
import type { ConfigReadResponse } from "./protocol/v2/ConfigReadResponse.ts";
import type { ConfigRequirementsReadResponse } from "./protocol/v2/ConfigRequirementsReadResponse.ts";
import type { ItemCompletedNotification } from "./protocol/v2/ItemCompletedNotification.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { ThreadTokenUsageUpdatedNotification } from "./protocol/v2/ThreadTokenUsageUpdatedNotification.ts";
import type { TurnCompletedNotification } from "./protocol/v2/TurnCompletedNotification.ts";
import type { TurnStartedNotification } from "./protocol/v2/TurnStartedNotification.ts";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.ts";
import { RpcError } from "./rpc.ts";
import { mcpServers, prepareCodexHome, RUFI_SERVER } from "./settings.ts";

export interface SubAgentDeps {
  /** Rufi's data folder; the runner uses `sub-agents/` inside it. */
  home: string;
  command: CodexCommand;
  /** The child's environment, without secrets (platform/config.ts). */
  env: Readonly<Record<string, string>>;
  /** An access token valid for at least `validForMs`. */
  token: (validForMs: number) => Promise<string>;
  version: string;
  deadlines?: Partial<Deadlines>;
  log?: Log;
}

/**
 * The models a sub-agent may run on, the default first, each with the route
 * the pinned Codex gives Rufi's tools on it (ADR 0010). Direct: the model
 * calls them itself, and Codex adds none of its own. Code: the model calls
 * them from JavaScript in Codex's `exec` (an isolate with no files or
 * network), and Codex always adds `exec`, `wait`, `request_user_input_async`
 * and, inside `exec`, `clock__curr_time`; nothing turns them off.
 */
export const SUB_AGENT_MODELS = [
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", route: "code" },
  { id: "gpt-5.5", name: "GPT-5.5", route: "direct" },
] as const;

/**
 * Codex's helpers for MCP resources, which it adds beside any MCP server and
 * shows as calls on its own server "codex" (0.159.3). They reach only the
 * reader's endpoint, which offers no resources.
 */
const RESOURCE_HELPERS = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];

/** Codex's id for a tool call made from a script in `exec` (0.159.3). */
const VIA_EXEC = "exec-";

/** A token must outlast the whole turn, plus this margin. */
const TOKEN_MARGIN_MS = 5 * 60_000;

/**
 * Codex's settings for a sub-agent thread on the pinned Codex, each turning
 * off what Codex would otherwise give the model (checked in the source at
 * rust-v0.159.3 and by subagent.test.ts).
 */
const LOCKED_CONFIG = {
  /** spawn_agent and its tools (and tool_search, which finds them). */
  agents: { enabled: false },
  /**
   * multi_agent_v2 on would bring the sub-agent tools back regardless; a
   * model with Codex's clock would also get its sleep tool.
   */
  features: { multi_agent_v2: false, goals: false, sleep_tool: false },
  /** request_user_input: a sub-agent has nobody to ask. */
  tools: { experimental_request_user_input: { enabled: false } },
  web_search: "disabled",
  /** Codex's added instruction blocks: after its prompt, Rufi's are the only ones. */
  skills: { include_instructions: false, bundled: { enabled: false } },
  include_permissions_instructions: false,
  include_environment_context: false,
  include_collaboration_mode_instructions: false,
};

/**
 * Why the turn may not show this item, or nothing when it may: messages,
 * reasoning, compactions and its own tools, by its model's route.
 */
function refusal(
  item: ThreadItem,
  names: readonly string[],
  route: "direct" | "code",
): string | undefined {
  if (item.type === "agentMessage" && item.questions !== null) {
    return "The reader asked a question, but nobody is there to answer it, so Rufi stopped it.";
  }
  if (
    item.type === "userMessage" ||
    item.type === "agentMessage" ||
    item.type === "reasoning" ||
    item.type === "contextCompaction" ||
    (item.type === "mcpToolCall" &&
      ((item.server === RUFI_SERVER && names.includes(item.tool)) ||
        (item.server === "codex" && RESOURCE_HELPERS.includes(item.tool))) &&
      (route === "code" || !item.id.startsWith(VIA_EXEC)))
  ) {
    return undefined;
  }
  return "The AI used something Rufi didn't give it, so Rufi stopped it.";
}

export function subAgentRunner(deps: SubAgentDeps): RunSubAgent {
  const deadlines = { ...DEADLINES, ...deps.deadlines };
  const log = deps.log ?? (() => undefined);

  return async (task: SubAgentTask, signal?: AbortSignal) => {
    const chosen = SUB_AGENT_MODELS.find((model) => model.id === task.model);
    if (!chosen) {
      return {
        end: {
          status: "failed",
          reason: "provider_failed",
          text: `Rufi's sub-agents run only on ${SUB_AGENT_MODELS.map((model) => model.id).join(", ")}.`,
        },
        compactions: 0,
      };
    }
    const started = Date.now();
    const home = join(deps.home, "sub-agents");
    const paths = await prepareCodexHome(home);
    // Its working folder, empty: with no environment it can't look in it.
    const cwd = join(home, "workspace");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const token = await deps.token(task.deadlineMs + TOKEN_MARGIN_MS);
    signal?.throwIfAborted();

    let compactions = 0;
    let usage: SubAgentOutcome["usage"];
    let limits: RateLimitSnapshot | undefined;
    let threadId: string | undefined;
    let turnId: string | undefined;
    /** Rufi's own reason to end the turn (a deadline, an item it didn't allow). */
    let stopped: TurnEnd | undefined;
    const ended = Promise.withResolvers<TurnEnd>();
    let app: AppServer | undefined;

    /** Read through a call: a Stop can set it while Rufi awaits Codex. */
    const stoppedNow = () => stopped;
    /** Ends the turn as `end`: at once if it runs, else as soon as it starts. */
    const stop = (end: TurnEnd) => {
      if (stopped) return;
      stopped = end;
      interrupt(end);
    };
    const interrupt = (end: TurnEnd) => {
      if (!app || !threadId || !turnId) return;
      void app.rpc
        .request(
          "turn/interrupt",
          { threadId, turnId },
          deadlines.interruptAckMs,
        )
        .catch(() => {
          // Codex didn't stop when asked: the process ends with the run.
          ended.resolve(end);
        });
      setTimeout(() => {
        ended.resolve(end);
      }, deadlines.interruptEndMs).unref();
    };

    /**
     * The turn this run started. Codex names it in `turn/started` before the
     * turn's first item, and may send both in the same read as its answer
     * to turn/start, before Rufi has seen that answer: either names it.
     */
    const turnStarted = (id: string) => {
      if (turnId !== undefined) return;
      turnId = id;
      // A Stop while the turn started: it ends now.
      if (stopped) interrupt(stopped);
    };

    const onItem = (item: ThreadItem, completed: boolean) => {
      const refused = refusal(item, task.tools.names, chosen.route);
      if (refused !== undefined) {
        log("subagent.unexpected", { item: item.type });
        stop({ status: "failed", reason: "provider_failed", text: refused });
        return;
      }
      if (completed && item.type === "contextCompaction") {
        compactions++;
        task.onCompaction();
      }
    };

    const onAbort = () => {
      stop({ status: "interrupted", reason: "stopped", text: "Stopped." });
    };
    const deadline = setTimeout(() => {
      stop({
        status: "failed",
        reason: "timeout",
        text: "The reading took too long, so Rufi stopped it.",
      });
    }, task.deadlineMs);

    try {
      app = await startAppServer({
        command: deps.command,
        env: { ...deps.env, HOME: paths.processHome },
        codexHome: paths.codexHome,
        token,
        version: deps.version,
        deadlines,
        ...(signal && { signal }),
        handlers: {
          request: (method) => {
            throw new RpcError(-32601, `Rufi doesn't handle ${method}.`);
          },
          notification: (method, params) => {
            // Account updates have no thread id and can be sparse.
            if (method === "account/rateLimits/updated") {
              limits = {
                ...limits,
                ...(params as AccountRateLimitsUpdatedNotification).rateLimits,
              };
              return;
            }
            const p = params as {
              threadId?: string;
              turnId?: string;
              turn?: { id?: string };
            };
            if (p.threadId !== threadId) return;
            if (method === "item/started" || method === "item/completed") {
              const { item } = params as ItemCompletedNotification;
              onItem(item, method === "item/completed");
            } else if (method === "thread/tokenUsage/updated") {
              const { total } = (params as ThreadTokenUsageUpdatedNotification)
                .tokenUsage;
              usage = {
                inputTokens: total.inputTokens,
                cachedInputTokens: total.cachedInputTokens,
                outputTokens: total.outputTokens,
                reasoningOutputTokens: total.reasoningOutputTokens,
                totalTokens: total.totalTokens,
              };
            } else if (method === "turn/started") {
              turnStarted((params as TurnStartedNotification).turn.id);
            } else if (method === "turn/completed") {
              const { turn } = params as TurnCompletedNotification;
              if (turn.id === turnId)
                ended.resolve(stopped ?? endOf(turn, limits));
            }
          },
          ignored: (what, error) => {
            log("codex.ignored", { what, error });
          },
        },
        onExit: (why) => {
          log("codex.exited", { code: errorCode(why) });
          ended.resolve(
            stopped ?? {
              status: "failed",
              reason: "provider_failed",
              text: "Codex stopped unexpectedly.",
            },
          );
        },
      });
      // A separate CODEX_HOME still inherits system/managed configuration.
      // Ask Codex for the layers the reader's cwd will actually load, rather
      // than parsing files or relying only on its instruction-file list.
      const config = await app.rpc.request<ConfigReadResponse>(
        "config/read",
        { cwd, includeLayers: true },
        deadlines.requestMs,
      );
      const { requirements } =
        await app.rpc.request<ConfigRequirementsReadResponse>(
          "configRequirements/read",
          {},
          deadlines.requestMs,
        );
      const additions = checkConfig(config);
      if (requirements?.additionalDeveloperInstructions) {
        additions.push("managed developer instructions");
      }
      if (requirements?.hooks) additions.push("managed hooks");
      if (additions.length > 0) {
        return outcome({
          status: "failed",
          reason: "provider_failed",
          text: `Codex's reader configuration has unsupported additions: ${additions.join("; ")}.`,
        });
      }
      const params: ThreadStartParams = {
        model: task.model,
        cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        environments: [],
        developerInstructions: task.instructions,
        config: {
          ...LOCKED_CONFIG,
          model_reasoning_effort: task.effort,
          // Its two tools at once, as the reader always had them: no search
          // for them first, also after a compaction.
          mcp_servers: mcpServers(task.tools, deadlines.toolMs, true),
        },
      };
      const response = await app.rpc.request<ThreadStartResponse>(
        "thread/start",
        params,
        deadlines.requestMs,
      );
      threadId = response.thread.id;
      const problems = checkThread(response, task);
      if (problems.length > 0) {
        return outcome({
          status: "failed",
          reason: "provider_failed",
          text: `Codex didn't take the sub-agent's settings: ${problems.join("; ")}.`,
        });
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      // Stopped while the thread started (a Stop, the deadline): no turn.
      const early = stoppedNow();
      if (early) return outcome(early);
      const { turn } = await app.rpc.request<TurnStartResponse>(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: task.input, text_elements: [] }],
        },
        deadlines.requestMs,
      );
      turnStarted(turn.id);
      return outcome(await ended.promise);
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      await app?.stop();
    }

    function outcome(end: TurnEnd): SubAgentOutcome {
      log("subagent.ended", {
        status: end.status,
        ms: Date.now() - started,
        count: compactions,
      });
      return { end, compactions, ...(usage && { usage }) };
    }
  };
}

/** Additions that the locked thread settings alone do not exclude. */
function checkConfig({ config, layers }: ConfigReadResponse): string[] {
  const problems: string[] = [];
  const table = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const servers = table(config["mcp_servers"]);
  if (
    Object.values(servers).some((server) => table(server)["enabled"] !== false)
  ) {
    problems.push("enabled MCP servers");
  }
  for (const key of [
    "instructions",
    "developer_instructions",
    "model_instructions_file",
    "compact_prompt",
    "experimental_compact_prompt_file",
    "model_catalog_json",
    "profile",
  ]) {
    if (config[key]) problems.push(key);
  }
  // The pinned API's typed `tools` projection drops update_plan. Its layers
  // keep it, highest precedence first; ignore layers Codex disabled.
  const plan = layers
    ?.filter((layer) => !layer.disabledReason)
    .map(
      (layer) =>
        table(table(table(layer.config)["tools"])["update_plan"])["enabled"],
    )
    .find((enabled) => enabled !== undefined);
  if (layers === null) problems.push("configuration layers unavailable");
  if (plan === true) {
    problems.push("tools.update_plan");
  }
  const features = table(config["features"]);
  for (const key of [
    "current_time_reminder",
    "sleep_tool",
    "token_budget",
    "deferred_executor",
    "send_message_to_user_async",
    "image_generation",
  ]) {
    const value = features[key];
    if (value === true || table(value)["enabled"] === true) {
      problems.push(`features.${key}`);
    }
  }
  if (Object.keys(table(config["hooks"])).length > 0) problems.push("hooks");
  return problems;
}

/** What in Codex's answer to thread/start isn't what Rufi asked for. */
function checkThread(
  response: ThreadStartResponse,
  task: SubAgentTask,
): string[] {
  const problems: string[] = [];
  if (response.model !== task.model)
    problems.push(`the model is ${response.model}`);
  if (response.reasoningEffort !== task.effort) {
    problems.push(`the effort is ${String(response.reasoningEffort)}`);
  }
  if (response.approvalPolicy !== "never")
    problems.push("it asks for approvals");
  if (response.sandbox.type !== "readOnly" || response.sandbox.networkAccess) {
    problems.push(`its access is ${response.sandbox.type}`);
  }
  if (!response.thread.ephemeral) problems.push("its thread is saved");
  if (response.instructionSources.length > 0) {
    problems.push("it loaded instruction files");
  }
  return problems;
}
