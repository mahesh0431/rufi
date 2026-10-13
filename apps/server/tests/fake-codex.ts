// A scripted stand-in for `codex app-server --listen stdio://`, run as a real
// child process so tests exercise Rufi's process, JSON-RPC and cleanup code.
// turn/start starts a turn, or steers the running one, as Codex 0.159.3
// does. What a turn does is chosen by its message's text, the
// same words the fake model uses for the real Codex (tests/fake-model.ts):
// "hang" never ends, "partial" writes "ok:part" and then never ends, "slow"
// answers after 300 ms, "fail" fails, "quiet" makes no tool call and runs no
// command, "command"
// starts a long command ("background command": and the turn ends while it
// runs), "drip" streams its answer in five parts 100 ms
// apart, "long" streams 200 parts of 1,000 characters, "think" streams a
// reasoning summary (fake-model.ts's THINKING) before it answers, and anything else
// answers "ok:<text>".
// Like Codex, it calls Rufi's tools on the MCP server a thread was given
// (its config's mcp_servers.rufi), checking it answers when the thread starts
// or resumes. Like Codex, a thread keeps the developer instructions it was
// first given in its history: a resume of a thread it has open changes
// nothing, and new ones take effect only after thread/compact/start (each
// turn logs the ones it ran with, as `told`). The test passes a scenario in FAKE_CODEX and reads what
// happened from the JSON lines written to FAKE_CODEX_LOG.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { THINKING } from "./fake-model.ts";
import { callTool, initialize, type McpServerConfig } from "./mcp-client.ts";

export interface Scenario {
  /** Methods the fake never answers. */
  hang?: string[];
  /** Methods the fake takes and answers after `slowMs` (200 ms). */
  slow?: string[];
  slowMs?: number;
  /** Methods the fake takes at once but answers after `slowMs`. */
  answerLate?: string[];
  /** How long after a turn starts Codex shows the user's message (at once). */
  userMessageMs?: number;
  /** Feature flags as Codex reports them, over what config.toml asked for. */
  features?: Record<string, boolean>;
  /** Effective config as Codex reports it, over what config.toml asked for. */
  config?: Record<string, unknown>;
  /** The model Codex gives a thread, whatever Rufi asked for. */
  model?: string;
  /** Requests the fake sends Rufi during a turn, before answering. */
  ask?: { method: string; params: unknown }[];
  /** Codex ignores turn/interrupt. */
  ignoreInterrupt?: boolean;
  /**
   * Like Codex, an interrupt leaves the turn's commands running. Codex's reply
   * to clean-up only means it was queued: "later" ends them 100 ms after it,
   * "never" doesn't end them.
   */
  clean?: "now" | "later" | "never";
  /** Events from an earlier turn on the same thread, sent before the turn starts. */
  stale?: boolean;
  /** Text the reply streams after an interrupt (Rufi must not save it). */
  late?: boolean;
  /** What the provider supports, over what Codex reports by default. */
  capabilities?: { namespaceTools?: boolean };
  /** A last message that arrives only completed, never streamed. */
  unstreamed?: {
    text: string;
    questions?: { title: string; options: string[] | null }[];
  };
  /**
   * The summary parts of a reasoning item the turn has before its answer,
   * streamed as Codex does: the item starts, each part streams in two
   * deltas, then the item completes, `reasoningMs` (0) after the last one.
   */
  reasoning?: string[];
  reasoningMs?: number;
  /**
   * The turn generates a picture before answering, as Codex's image
   * generation does: started, then completed with its bytes and, unless
   * null, the path it saved them at.
   */
  picture?: { savedPath: string | null };
  /** Codex compacts the thread's context during the turn, before answering. */
  compaction?: boolean;
  /** A compaction Rufi asks for (thread/compact/start) fails. */
  compactFails?: boolean;
  /** The permission profile Codex says a thread runs under, whatever Rufi asked. */
  profile?: string;
  /**
   * Calls of Rufi's tools the model makes during a turn, before answering;
   * `id` is Codex's call id (`call-<n>`; `exec-…` for a call made from exec).
   */
  calls?: {
    id?: string;
    /** Another MCP server than Rufi's: the call is answered without Rufi. */
    server?: string;
    tool: string;
    arguments: unknown;
  }[];
  /**
   * The turn shows only its message, tool calls and answer: no command and
   * no item Rufi doesn't know, as a sub-agent's turn.
   */
  bare?: boolean;
  /** Tool calls by turn, oldest first, for each thread. */
  callsByTurn?: NonNullable<Scenario["calls"]>[];
  /** A usage-limit snapshot sent before a failed turn. */
  resetsAt?: number;
  /** Sparse account rate-limit updates following that snapshot. */
  rateLimitUpdates?: Record<string, unknown>[];
  /** Threads the fake knows from before, as a restarted Codex would. */
  threads?: Record<string, { history?: string[] }>;
  /**
   * Lines go out together, every 20 ms, as a pipe can deliver them: an
   * answer and the turn's first lines after it come in one read.
   */
  together?: boolean;
}

const scenario = JSON.parse(process.env["FAKE_CODEX"] ?? "{}") as Scenario;
const logFile = process.env["FAKE_CODEX_LOG"] ?? "";
const record = (entry: object) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
record({
  started: process.argv.slice(2),
  pid: process.pid,
  env: Object.keys(process.env).sort(),
  token: process.env["ACCESS_TOKEN"],
  codexHome: process.env["CODEX_HOME"],
});

let held = "";
const send = (message: object) => {
  const line = `${JSON.stringify(message)}\n`;
  if (!scenario.together) {
    process.stdout.write(line);
    return;
  }
  if (held === "") {
    setTimeout(() => {
      process.stdout.write(held);
      held = "";
    }, 20);
  }
  held += line;
};
let nextId = 1000;
/** This run's tag, in its turn ids. */
const RUN = randomUUID().slice(0, 8);
const asked = new Map<number, (result: unknown) => void>();
const askRufi = (method: string, params: unknown) =>
  new Promise((resolve) => {
    const id = nextId++;
    asked.set(id, resolve);
    send({ id, method, params });
  });

interface Queued {
  id: string;
  input: { type: string; text: string; text_elements: [] }[];
  clientUserMessageId: string;
}
interface Thread {
  id: string;
  model: string;
  /** The effort its next turns run with; none: the config's. */
  effort?: string;
  ephemeral?: boolean;
  sandbox?: string;
  /** The named permission profile it runs with. */
  permissions?: string;
  /** The developer instructions it was last given, and those its history holds. */
  given?: string;
  told?: string;
  /** Rufi's MCP server, as the thread was last given it. */
  mcp?: McpServerConfig;
  running:
    | { turnId: string; steers: Queued[]; interrupted: boolean }
    | undefined;
  /** Each turn's status and the user messages it ran. */
  history: { id: string; status: string; messages: Queued[] }[];
}
const threads = new Map<string, Thread>();
/** Threads open in this process, as Codex has them loaded. */
const loaded = new Set<string>();
// Like Codex, threads outlive the process: a restarted fake finds them in
// CODEX_HOME. A reply that was running when it was killed is interrupted.
const STATE = join(process.env["CODEX_HOME"] ?? ".", "fake-threads.json");
if (existsSync(STATE)) {
  for (const thread of JSON.parse(readFileSync(STATE, "utf8")) as Thread[]) {
    for (const turn of thread.history) {
      if (turn.status === "inProgress") turn.status = "interrupted";
    }
    threads.set(thread.id, { ...thread, running: undefined });
  }
}
// Rufi may end the fake at any moment, also mid-write: it writes the threads
// aside, then renames them into place, so a restart never finds half a file.
function persist() {
  const aside = `${STATE}.${String(process.pid)}`;
  writeFileSync(aside, JSON.stringify([...threads.values()]));
  renameSync(aside, STATE);
}
let threadCount = 0;
let compactCount = 0;
/** `{[key]: value}` when it is a string, else nothing. */
const optional = (key: string, value: unknown) =>
  typeof value === "string" ? { [key]: value } : {};
let queuedCount = 0;
let command: ReturnType<typeof spawn> | undefined;
let commandRunning = false;

const textOf = (entry: Queued) => entry.input.at(-1)?.text ?? "";
const queued = (clientUserMessageId: string, text: string): Queued => ({
  id: `q-${String(++queuedCount)}`,
  input: [{ type: "text", text, text_elements: [] }],
  clientUserMessageId,
});
for (const [id, known] of Object.entries(scenario.threads ?? {})) {
  threads.set(id, {
    id,
    model: scenario.model ?? "gpt-6.1-sol",
    running: undefined,
    history: (known.history ?? []).map((text, i) => ({
      id: `old-${String(i)}`,
      status: "completed",
      messages: [queued(text, text)],
    })),
  });
}

const turnObject = (id: string, status: string) => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status,
  error:
    status === "failed"
      ? {
          message: "boom",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: null,
          misalignment: null,
        }
      : null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});

const userItem = (entry: Queued) => ({
  type: "userMessage",
  id: `user-${entry.clientUserMessageId}`,
  clientId: entry.clientUserMessageId,
  content: entry.input,
});

/** Starts a turn for `next`; nothing runs. */
function dispatch(thread: Thread, next: Queued) {
  // Numbered across every thread and restart, with this run's tag, so never
  // used twice, also by a fake on a fresh CODEX_HOME (after a move): Codex's
  // own ids are UUIDs.
  const turnId = `turn-${String(
    [...threads.values()].reduce((n, t) => n + t.history.length, 0) + 1,
  )}-${RUN}`;
  thread.running = { turnId, steers: [], interrupted: false };
  record({
    turn: turnId,
    effort: thread.effort ?? null,
    model: thread.model,
    told: thread.told ?? null,
  });
  // Like Codex: the message is in its record once it is recorded, a moment
  // after the turn starts (`userMessageMs`); ended before, it is lost.
  thread.history.push({
    id: turnId,
    status: "inProgress",
    messages: scenario.userMessageMs ? [] : [next],
  });
  persist();
  setImmediate(() => void runTurn(thread, turnId, next));
  return turnObject(turnId, "inProgress");
}

function complete(thread: Thread, turnId: string, status: string) {
  const turn = thread.history.find((t) => t.id === turnId);
  if (turn) turn.status = status;
  if (thread.running?.turnId !== turnId) {
    persist();
    return;
  }
  thread.running = undefined;
  persist();
  send({
    method: "turn/completed",
    params: { threadId: thread.id, turn: turnObject(turnId, status) },
  });
}

async function runTurn(thread: Thread, turnId: string, entry: Queued) {
  const threadId = thread.id;
  const text = textOf(entry);
  const event = (method: string, params: object) => {
    send({ method, params: { threadId, turnId, ...params } });
  };
  if (scenario.stale) {
    const old = "previous-turn";
    send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId: old, itemId: "x", delta: "STALE" },
    });
    send({
      method: "turn/completed",
      params: { threadId, turn: turnObject(old, "failed") },
    });
  }
  // Notifications Rufi must ignore without ending the turn.
  send({
    method: "remoteControl/status/changed",
    params: { status: "disabled" },
  });
  send({ method: "brand/new/notification", params: { threadId } });
  send({
    method: "turn/started",
    params: { threadId, turn: turnObject(turnId, "inProgress") },
  });
  if (scenario.userMessageMs) {
    await sleep(scenario.userMessageMs);
    // Like Codex: interrupted before it recorded the message, it drops it.
    if (thread.running?.turnId !== turnId) return;
    const turn = thread.history.find((t) => t.id === turnId);
    if (turn) turn.messages = [entry];
    persist();
  }
  event("item/started", { item: userItem(entry) });
  const turnIndex = thread.history.findIndex((turn) => turn.id === turnId);
  const calls = text.includes("quiet")
    ? []
    : (scenario.callsByTurn?.[turnIndex] ?? scenario.calls ?? []);
  for (const [i, { id, ...call }] of calls.entries()) {
    // Like Codex: the item starts, then the call goes to Rufi's MCP server.
    const item = {
      id: id ?? `call-${String(i)}`,
      type: "mcpToolCall",
      server: call.server ?? "rufi",
      tool: call.tool,
      arguments: call.arguments,
      status: "inProgress",
      result: null,
      error: null,
      durationMs: null,
    };
    event("item/started", { item });
    const reply =
      item.server !== "rufi"
        ? { status: 200, result: { content: [] } }
        : thread.mcp
          ? await callTool(thread.mcp, {
              name: call.tool,
              arguments: call.arguments,
              callId: item.id,
              threadId,
              turnId,
            })
          : { status: 0 };
    record({ answered: "tools/call", reply });
    if (thread.running?.turnId !== turnId) return;
    const failed = !reply.result || reply.result["isError"] === true;
    event("item/completed", {
      item: {
        ...item,
        status: failed ? "failed" : "completed",
        result: reply.result
          ? {
              content: reply.result["content"],
              structuredContent: null,
              _meta: null,
            }
          : null,
        error: reply.result
          ? null
          : { message: `HTTP ${String(reply.status)}` },
      },
    });
  }
  for (const request of scenario.ask ?? []) {
    record({
      answered: request.method,
      reply: await askRufi(request.method, request.params),
    });
  }
  const reasoning =
    scenario.reasoning ?? (text.includes("think") ? THINKING : undefined);
  if (reasoning) {
    const item = { id: "item-think", type: "reasoning", content: [] };
    event("item/started", { item: { ...item, summary: [] } });
    for (const [summaryIndex, part] of reasoning.entries()) {
      if (summaryIndex > 0) {
        event("item/reasoning/summaryPartAdded", {
          itemId: item.id,
          summaryIndex,
        });
      }
      const half = Math.ceil(part.length / 2);
      for (const delta of [part.slice(0, half), part.slice(half)]) {
        event("item/reasoning/summaryTextDelta", {
          itemId: item.id,
          delta,
          summaryIndex,
        });
      }
    }
    if (scenario.reasoningMs) await sleep(scenario.reasoningMs);
    if (thread.running?.turnId !== turnId) return;
    event("item/completed", {
      item: { ...item, summary: reasoning },
    });
  }
  if (scenario.compaction) {
    // As Codex 0.159.3 does: the item starts, and completes once the
    // thread's history is replaced.
    const item = { id: "item-compact", type: "contextCompaction" };
    event("item/started", { item });
    event("item/completed", { item });
  }
  if (text.includes("hang")) return;
  if (text.includes("partial")) {
    event("item/started", {
      item: { id: "item-1", type: "agentMessage", text: "", questions: null },
    });
    event("item/agentMessage/delta", { itemId: "item-1", delta: "ok:part" });
    return;
  }
  if (text.includes("command")) {
    // Like Codex: the command gets its own session. It ignores TERM, and it
    // leaves an orphan behind (its parent subshell has exited), which only a
    // signal to the whole process group reaches.
    const shell = (command = spawn(
      "sh",
      ["-c", 'trap "" TERM; (sleep 300 & echo $!); sleep 301'],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    ));
    commandRunning = true;
    shell.once("exit", () => (commandRunning = false));
    shell.stdout.once("data", (chunk: Buffer) => {
      record({ command: shell.pid, child: Number(chunk.toString().trim()) });
      event("item/started", {
        item: {
          id: "item-cmd",
          type: "commandExecution",
          command: "sleep 301",
          status: "inProgress",
        },
      });
      if (text.includes("background")) complete(thread, turnId, "completed");
    });
    return;
  }
  if (text.includes("fail")) {
    if (scenario.resetsAt !== undefined) {
      send({
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: {
              usedPercent: 100,
              windowDurationMins: 300,
              resetsAt: scenario.resetsAt,
            },
            secondary: null,
          },
        },
      });
    }
    for (const rateLimits of scenario.rateLimitUpdates ?? []) {
      send({ method: "account/rateLimits/updated", params: { rateLimits } });
    }
    complete(thread, turnId, "failed");
    return;
  }
  if (text.includes("slow"))
    await new Promise((resolve) => setTimeout(resolve, 300));
  if (thread.running?.turnId !== turnId) return;
  if (scenario.picture) {
    const item = {
      id: "item-pic",
      type: "imageGeneration",
      status: "generating",
      revisedPrompt: null,
      result: "",
      failure: null,
    };
    event("item/started", { item });
    event("item/completed", {
      item: {
        ...item,
        status: "completed",
        revisedPrompt: "A fictional watercolour of a sleeping cat",
        result: "iVBORw0KGgo".repeat(1_000),
        ...(scenario.picture.savedPath !== null && {
          savedPath: scenario.picture.savedPath,
        }),
      },
    });
  }
  if (text.includes("drip") || text.includes("long")) {
    const parts = text.includes("drip")
      ? ["ok:", "d", "r", "i", "p"]
      : Array.from({ length: 200 }, (_, i) => String(i % 10).repeat(1_000));
    event("item/started", {
      item: { id: "item-1", type: "agentMessage", text: "", questions: null },
    });
    // A Stop may end the turn between parts.
    const stopped = () => thread.running?.turnId !== turnId;
    for (const delta of parts) {
      if (stopped()) return;
      event("item/agentMessage/delta", { itemId: "item-1", delta });
      if (text.includes("drip"))
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    event("item/completed", {
      item: {
        id: "item-1",
        type: "agentMessage",
        text: parts.join(""),
        questions: null,
      },
    });
  } else {
    answer(thread, turnId, "item-1", `ok:${text}`);
  }
  // Steers that came meanwhile are taken in, and answered, in the same turn.
  for (const [i, steer] of thread.running.steers.entries()) {
    event("item/started", { item: userItem(steer) });
    answer(thread, turnId, `item-steer-${String(i)}`, `ok:${textOf(steer)}`);
  }
  if (!text.includes("quiet") && !scenario.bare)
    event("item/completed", {
      item: {
        id: "item-ls",
        type: "commandExecution",
        command: "ls",
        status: "completed",
        aggregatedOutput: "notes.txt\n",
        exitCode: 0,
        durationMs: 4,
      },
    });
  if (!scenario.bare) {
    event("item/completed", { item: { id: "item-tp", type: "teleport" } });
  }
  if (scenario.unstreamed) {
    event("item/completed", {
      item: {
        id: "item-last",
        type: "agentMessage",
        phase: "final_answer",
        questions: null,
        ...scenario.unstreamed,
      },
    });
  }
  complete(thread, turnId, "completed");
}

function answer(thread: Thread, turnId: string, itemId: string, text: string) {
  const params = { threadId: thread.id, turnId };
  send({
    method: "item/started",
    params: {
      ...params,
      item: { id: itemId, type: "agentMessage", text: "", questions: null },
    },
  });
  for (const delta of [text.slice(0, 3), text.slice(3)]) {
    send({
      method: "item/agentMessage/delta",
      params: { ...params, itemId, delta },
    });
  }
  send({
    method: "item/completed",
    params: {
      ...params,
      item: { id: itemId, type: "agentMessage", text, questions: null },
    },
  });
}

function featureList() {
  const reported: Record<string, boolean> = {
    shell_tool: true,
    daemon_auto_start: false,
    plugins: false,
    apps: false,
    ...scenario.features,
  };
  return Object.entries(reported).map(([name, enabled]) => ({
    name,
    stage: "stable",
    enabled,
  }));
}

/** Rufi's MCP server a thread/start or thread/resume gives in its config. */
function configMcp(
  params: Record<string, unknown>,
): McpServerConfig | undefined {
  const config = params["config"] as
    | { mcp_servers?: Record<string, McpServerConfig> }
    | undefined;
  return config?.mcp_servers?.["rufi"];
}

/**
 * Like Codex with a required server: the thread doesn't start or resume when
 * Rufi's MCP server doesn't take the session.
 */
async function checkMcp(server: McpServerConfig | undefined, what: string) {
  if (!server) return;
  const { status } = await initialize(server);
  if (status !== 200) {
    throw new Error(
      `error ${what} thread: Fatal error: Failed to initialize session: required MCP servers failed to initialize: rufi: unexpected server response: HTTP ${String(status)}`,
    );
  }
}

/** The effort a thread/start or thread/resume asks for in its config. */
function configEffort(params: Record<string, unknown>): string | undefined {
  const config = params["config"] as Record<string, unknown> | undefined;
  const effort = config?.["model_reasoning_effort"];
  return typeof effort === "string" ? effort : undefined;
}

function threadResponse(thread: Thread) {
  return {
    thread: {
      id: thread.id,
      status: thread.running
        ? { type: "active", activeFlags: [] }
        : { type: "idle" },
      model: thread.model,
      ephemeral: thread.ephemeral ?? false,
    },
    instructionSources: [],
    model: thread.model,
    reasoningEffort: thread.effort ?? "medium",
    approvalPolicy: "never",
    sandbox:
      thread.sandbox === "read-only"
        ? { type: "readOnly", networkAccess: false }
        : thread.permissions !== undefined
          ? {
              type: "workspaceWrite",
              writableRoots: [],
              networkAccess: true,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            }
          : { type: "dangerFullAccess" },
    activePermissionProfile:
      thread.permissions === undefined
        ? null
        : { id: scenario.profile ?? thread.permissions, extends: ":workspace" },
  };
}

function threadOf(params: Record<string, unknown>): Thread {
  const thread = threads.get(String(params["threadId"]));
  if (!thread) throw new Error("no such thread");
  return thread;
}

async function handle(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "initialize":
      return { userAgent: "fake", codexHome: process.env["CODEX_HOME"] };
    case "experimentalFeature/list": {
      // Two pages, so Rufi has to follow the cursor.
      const all = featureList();
      const half = Math.ceil(all.length / 2);
      return params["cursor"]
        ? { data: all.slice(half), nextCursor: null }
        : { data: all.slice(0, half), nextCursor: "page-2" };
    }
    case "modelProvider/capabilities/read":
      return {
        namespaceTools: true,
        imageGeneration: false,
        webSearch: false,
        ...scenario.capabilities,
      };
    case "config/read":
      return {
        config: {
          model_provider: "openai_chatgpt_plan",
          model_reasoning_effort: "medium",
          model_reasoning_summary: "detailed",
          personality: "none",
          ...scenario.config,
        },
      };
    case "configRequirements/read":
      return { requirements: null };
    case "model/list":
      // Two pages, so Rufi has to follow the cursor.
      return params["cursor"]
        ? {
            data: [
              { id: "gpt-6-astra", displayName: "GPT-6-Astra" },
              { id: "gpt-5.5", displayName: "GPT-5.5" },
            ],
            nextCursor: null,
          }
        : {
            data: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" }],
            nextCursor: "page-2",
          };
    case "thread/start": {
      await checkMcp(configMcp(params), "creating");
      const thread: Thread = {
        // Unique across fakes, as Codex's ids are.
        id: `thread-${String(process.pid)}-${String(++threadCount)}`,
        model: scenario.model ?? String(params["model"]),
        effort: configEffort(params),
        ephemeral: params["ephemeral"] === true,
        sandbox: String(params["sandbox"]),
        ...optional("permissions", params["permissions"]),
        ...optional("given", params["developerInstructions"]),
        ...optional("told", params["developerInstructions"]),
        mcp: configMcp(params),
        running: undefined,
        history: [],
      };
      threads.set(thread.id, thread);
      loaded.add(thread.id);
      persist();
      return threadResponse(thread);
    }
    case "thread/resume": {
      const thread = threadOf(params);
      // Like Codex: a thread it has open keeps its settings.
      if (loaded.has(thread.id)) return threadResponse(thread);
      await checkMcp(configMcp(params), "resuming");
      loaded.add(thread.id);
      Object.assign(
        thread,
        optional("permissions", params["permissions"]),
        optional("given", params["developerInstructions"]),
      );
      persist();
      thread.mcp = configMcp(params);
      thread.model = scenario.model ?? String(params["model"]);
      // Like Codex: resumed with a model, the effort is the config's again.
      thread.effort = configEffort(params);
      return threadResponse(thread);
    }
    case "thread/read":
      return threadResponse(threadOf(params));
    case "thread/unsubscribe": {
      const thread = threadOf(params);
      if (!loaded.delete(thread.id)) return { status: "notLoaded" };
      // Like Codex with thread_unload_delay_secs = 0: idle, it closes at once.
      setImmediate(() => {
        send({ method: "thread/closed", params: { threadId: thread.id } });
      });
      return { status: "unsubscribed" };
    }
    case "thread/compact/start": {
      const thread = threadOf(params);
      const turnId = `compact-${RUN}-${String(++compactCount)}`;
      setImmediate(() => {
        const event = (method: string, item: object) => {
          send({ method, params: { threadId: thread.id, turnId, item } });
        };
        send({
          method: "turn/started",
          params: {
            threadId: thread.id,
            turn: turnObject(turnId, "inProgress"),
          },
        });
        const item = { type: "contextCompaction", id: `${turnId}-item` };
        event("item/started", item);
        event("item/completed", item);
        const status = scenario.compactFails ? "failed" : "completed";
        if (!scenario.compactFails) thread.told = thread.given;
        persist();
        send({
          method: "turn/completed",
          params: { threadId: thread.id, turn: turnObject(turnId, status) },
        });
      });
      return {};
    }
    case "turn/start": {
      const thread = threadOf(params);
      const entry: Queued = {
        id: `q-${String(++queuedCount)}`,
        input: params["input"] as Queued["input"],
        clientUserMessageId: String(params["clientUserMessageId"]),
      };
      // Like Codex: into a running turn it steers.
      if (thread.running) {
        thread.running.steers.push(entry);
        return { turn: turnObject(thread.running.turnId, "inProgress") };
      }
      // Like Codex: the model and effort hold for this turn and the ones after.
      if (typeof params["effort"] === "string")
        thread.effort = params["effort"];
      if (typeof params["model"] === "string")
        thread.model = scenario.model ?? params["model"];
      return { turn: dispatch(thread, entry) };
    }
    case "thread/turns/list": {
      const thread = threadOf(params);
      // Newest first, a page at a time, as Codex does.
      const all = [...thread.history].reverse();
      const from = Number(params["cursor"] ?? 0);
      const to = from + Number(params["limit"] ?? 25);
      const data = all.slice(from, to).map((turn) => ({
        ...turnObject(turn.id, turn.status),
        items: turn.messages.map(userItem),
      }));
      const nextCursor = to < all.length ? String(to) : null;
      return { data, nextCursor, backwardsCursor: null };
    }
    case "turn/steer": {
      const thread = threadOf(params);
      if (
        !thread.running ||
        thread.running.turnId !== params["expectedTurnId"]
      ) {
        throw new Error("no active turn to steer");
      }
      thread.running.steers.push({
        id: "steer",
        input: params["input"] as Queued["input"],
        clientUserMessageId: String(params["clientUserMessageId"]),
      });
      return { turnId: thread.running.turnId };
    }
    case "turn/interrupt": {
      if (scenario.ignoreInterrupt) return undefined;
      const thread = threadOf(params);
      const turnId = String(params["turnId"]);
      if (thread.running?.turnId !== turnId) throw new Error("no active turn");
      setImmediate(() => {
        if (scenario.late) {
          send({
            method: "item/agentMessage/delta",
            params: {
              threadId: thread.id,
              turnId,
              itemId: "item-late",
              delta: "LATE",
            },
          });
        }
        complete(thread, turnId, "interrupted");
      });
      return {};
    }
    case "thread/backgroundTerminals/list":
      // Like 0.159.2: no process ids.
      return {
        data: commandRunning
          ? [
              {
                itemId: "item-cmd",
                processId: "1",
                command: "sleep 301",
                osPid: null,
              },
            ]
          : [],
        nextCursor: null,
      };
    case "thread/backgroundTerminals/clean": {
      // Ends the command's whole process group, as Codex does.
      const pid = command?.pid;
      const kill = () => {
        if (pid !== undefined) process.kill(-pid, "SIGKILL");
      };
      if (scenario.clean === "later") setTimeout(kill, 100);
      else if (scenario.clean !== "never") kill();
      return {};
    }
    default:
      throw new Error(`fake doesn't know ${method}`);
  }
}

// Like Codex: when Rufi goes away, its end of stdin closes, and the fake ends
// the command it runs, with what that left in the background, then itself.
process.stdin.once("end", () => {
  const pid = command?.pid;
  try {
    if (pid !== undefined) process.kill(-pid, "SIGKILL");
  } catch (error) {
    // Already gone; EPERM is macOS's answer for a group not yet reaped.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
  process.exit(0);
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
  };
  record({ received: message });
  if (message.method === undefined) {
    if (message.id !== undefined)
      asked.get(message.id)?.(message.result ?? message);
    return;
  }
  if (message.id === undefined) return; // a notification, e.g. initialized
  if (scenario.hang?.includes(message.method)) return;
  const { id, method } = message;
  const reply = () => {
    handle(method, message.params ?? {}).then(
      (result) => {
        if (result !== undefined) send({ id, result });
      },
      (error: unknown) => {
        send({
          id,
          error: { code: -32600, message: (error as Error).message },
        });
      },
    );
  };
  if (scenario.slow?.includes(method)) {
    setTimeout(reply, scenario.slowMs ?? 200);
  } else if (scenario.answerLate?.includes(method)) {
    void handle(method, message.params ?? {}).then((result) => {
      setTimeout(() => {
        send({ id, result });
      }, scenario.slowMs ?? 200);
    });
  } else reply();
});
