// Rufi's private sub-agent runner on Codex: one locked-down thread, one turn,
// in an app-server of its own (its own CODEX_HOME and an empty workspace in
// the data folder's sub-agents/), so it shares nothing with the chat. The
// thread is ephemeral (nothing saved), has Rufi's instructions in place of
// Codex's, no environment (no shell, files or patches), no network, no
// sub-agents, web search, goals, skills or questions to the user, and exactly
// the tools the task gives. Rufi checks the thread's model, effort and
// access when it starts, and ends the turn as failed if Codex shows any item
// Rufi didn't allow. The offline contract test (subagent.test.ts) proves the
// complete set of tools the model gets on the pinned Codex.
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { errorCode, type Log } from "../../platform/logs.ts";
import type {
  RunSubAgent,
  SubAgentOutcome,
  SubAgentTask,
  ToolAnswer,
  TurnEnd,
} from "../runtime.ts";
import {
  DEADLINES,
  startAppServer,
  type AppServer,
  type CodexCommand,
  type Deadlines,
} from "./appserver.ts";
import { dynamicTools } from "./codex.ts";
import { endOf } from "./events.ts";
import type { DynamicToolCallParams } from "./protocol/v2/DynamicToolCallParams.ts";
import type { DynamicToolCallResponse } from "./protocol/v2/DynamicToolCallResponse.ts";
import type { ItemCompletedNotification } from "./protocol/v2/ItemCompletedNotification.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { ThreadTokenUsageUpdatedNotification } from "./protocol/v2/ThreadTokenUsageUpdatedNotification.ts";
import type { TurnCompletedNotification } from "./protocol/v2/TurnCompletedNotification.ts";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.ts";
import { RpcError } from "./rpc.ts";
import { prepareCodexHome } from "./settings.ts";

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
  /** multi_agent_v2 on would bring the sub-agent tools back regardless. */
  features: { multi_agent_v2: false, goals: false },
  /** request_user_input: a sub-agent has nobody to ask. */
  tools: { experimental_request_user_input: { enabled: false } },
  web_search: "disabled",
  /** Codex's own instruction blocks: Rufi's instructions are the only ones. */
  skills: { include_instructions: false, bundled: { enabled: false } },
  include_permissions_instructions: false,
  include_environment_context: false,
  include_collaboration_mode_instructions: false,
};

/** What the turn may show: messages, reasoning, compactions and its own tools. */
const allowed = (item: ThreadItem, namespace: string) =>
  item.type === "userMessage" ||
  item.type === "agentMessage" ||
  item.type === "reasoning" ||
  item.type === "contextCompaction" ||
  (item.type === "dynamicToolCall" && item.namespace === namespace);

export function subAgentRunner(deps: SubAgentDeps): RunSubAgent {
  const deadlines = { ...DEADLINES, ...deps.deadlines };
  const log = deps.log ?? (() => undefined);

  return async (task: SubAgentTask, signal?: AbortSignal) => {
    const started = Date.now();
    const paths = await prepareCodexHome(
      join(deps.home, "sub-agents"),
      undefined,
    );
    const token = await deps.token(task.deadlineMs + TOKEN_MARGIN_MS);
    signal?.throwIfAborted();

    let compactions = 0;
    let usage: SubAgentOutcome["usage"];
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

    const callTool = async (
      call: DynamicToolCallParams,
    ): Promise<DynamicToolCallResponse> => {
      const refuse = (text: string): DynamicToolCallResponse => ({
        contentItems: [{ type: "inputText", text }],
        success: false,
      });
      // Codex 0.159.3 names a call made from code (its `exec` tool) exec-…:
      // the model then has a JavaScript tool besides Rufi's.
      if (call.callId.startsWith("exec-")) {
        log("subagent.unexpected", { item: "exec" });
        stop({
          status: "failed",
          reason: "provider_failed",
          text: "The AI reached Rufi's tools through code, which Rufi didn't allow, so Rufi stopped it.",
        });
      }
      if (
        call.threadId !== threadId ||
        call.turnId !== turnId ||
        call.namespace !== task.tools.namespace ||
        stopped
      ) {
        return refuse(
          JSON.stringify({ ok: false, error: "No such tool here." }),
        );
      }
      const slow: ToolAnswer = {
        ok: false,
        text: JSON.stringify({
          ok: false,
          error: `${call.tool} took too long.`,
        }),
      };
      const answer = await Promise.race([
        task.callTool(call.tool, call.arguments, call.callId),
        sleep(deadlines.toolMs, slow, { ref: false }),
      ]);
      if (answer.stopTurn !== undefined) {
        stop({ status: "failed", text: answer.stopTurn });
      }
      return {
        contentItems: [
          { type: "inputText", text: answer.text },
          ...(answer.images ?? []).map((imageUrl) => ({
            type: "inputImage" as const,
            imageUrl,
          })),
        ],
        success: answer.ok,
      };
    };

    const onItem = (item: ThreadItem, completed: boolean) => {
      if (!allowed(item, task.tools.namespace)) {
        log("subagent.unexpected", { item: item.type });
        stop({
          status: "failed",
          reason: "provider_failed",
          text: "The AI used something Rufi didn't give it, so Rufi stopped it.",
        });
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
          request: async (method, params) => {
            if (method === "item/tool/call") {
              return callTool(params as DynamicToolCallParams);
            }
            throw new RpcError(-32601, `Rufi doesn't handle ${method}.`);
          },
          notification: (method, params) => {
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
            } else if (method === "turn/completed") {
              const { turn } = params as TurnCompletedNotification;
              if (turn.id === turnId) ended.resolve(stopped ?? endOf(turn));
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
      const params: ThreadStartParams = {
        model: task.model,
        cwd: paths.workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        environments: [],
        baseInstructions: task.instructions,
        config: { ...LOCKED_CONFIG, model_reasoning_effort: task.effort },
        dynamicTools: dynamicTools(task.tools),
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
      turnId = turn.id;
      // A Stop during turn/start: the turn it started ends now.
      const during = stoppedNow();
      if (during) interrupt(during);
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
