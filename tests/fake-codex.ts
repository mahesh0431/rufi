// A scripted stand-in for `codex app-server --listen stdio://`, run as a real
// child process so tests exercise Rufi's process, JSON-RPC and cleanup code.
// The test passes a scenario in FAKE_CODEX and reads what happened from the
// JSON lines written to FAKE_CODEX_LOG.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

export interface Scenario {
  /** Methods the fake never answers. */
  hang?: string[];
  /** Methods the fake answers after 200 ms. */
  slow?: string[];
  /** Feature flags as Codex reports them, over what config.toml asked for. */
  features?: Record<string, boolean>;
  /** Effective config as Codex reports it, over what config.toml asked for. */
  config?: Record<string, unknown>;
  /** What a turn does. */
  turn?: "answer" | "fail" | "hang" | "command";
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
  /** Events from an earlier turn on the same thread, sent before the reply. */
  stale?: boolean;
  /** The turn's own events come before the reply to turn/start. */
  early?: boolean;
  /** What the provider supports, over what Codex reports by default. */
  capabilities?: { namespaceTools?: boolean };
  /** A last message that arrives only completed, never streamed. */
  unstreamed?: {
    text: string;
    questions?: { title: string; options: string[] | null }[];
  };
  /** Tool calls the model makes during a turn, before answering. */
  calls?: { namespace: string | null; tool: string; arguments: unknown }[];
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

const send = (message: object) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
let nextId = 1000;
const asked = new Map<number, (result: unknown) => void>();
const askRufi = (method: string, params: unknown) =>
  new Promise((resolve) => {
    const id = nextId++;
    asked.set(id, resolve);
    send({ id, method, params });
  });

let threads = 0;
let turns = 0;
let running: { threadId: string; turnId: string } | undefined;
let command: ReturnType<typeof spawn> | undefined;
let commandRunning = false;

const turnObject = (id: string, status: string) => ({
  id,
  items: [],
  itemsView: "full",
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

async function runTurn(threadId: string, turnId: string) {
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
  for (const [i, call] of (scenario.calls ?? []).entries()) {
    // Like Codex: the item starts, then Rufi is asked to run it.
    const item = {
      id: `call-${String(i)}`,
      type: "dynamicToolCall",
      namespace: call.namespace,
      tool: call.tool,
      arguments: call.arguments,
      status: "inProgress",
      contentItems: null,
      success: null,
      durationMs: null,
    };
    send({ method: "item/started", params: { threadId, turnId, item } });
    const reply = await askRufi("item/tool/call", {
      threadId,
      turnId,
      callId: item.id,
      ...call,
    });
    record({ answered: "item/tool/call", reply });
  }
  for (const request of scenario.ask ?? []) {
    record({
      answered: request.method,
      reply: await askRufi(request.method, request.params),
    });
  }
  if (scenario.turn === "hang") return;
  if (scenario.turn === "command") {
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
      send({
        method: "item/started",
        params: {
          threadId,
          turnId,
          item: {
            id: "item-cmd",
            type: "commandExecution",
            command: "sleep 301",
          },
        },
      });
    });
    return;
  }
  if (scenario.turn === "fail") {
    send({
      method: "turn/completed",
      params: { threadId, turn: turnObject(turnId, "failed") },
    });
    return;
  }
  const item = (type: string, extra: object) => ({
    id: `item-${type}`,
    type,
    ...extra,
  });
  send({
    method: "item/started",
    params: { threadId, turnId, item: item("agentMessage", { text: "" }) },
  });
  for (const delta of ["Hel", "lo"]) {
    send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: "item-agentMessage", delta },
    });
  }
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: item("agentMessage", { text: "Hello", questions: null }),
    },
  });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: item("commandExecution", { command: "ls" }),
    },
  });
  send({
    method: "item/completed",
    params: { threadId, turnId, item: item("teleport", {}) },
  });
  if (scenario.unstreamed) {
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          id: "item-last",
          type: "agentMessage",
          phase: "final_answer",
          questions: null,
          ...scenario.unstreamed,
        },
      },
    });
  }
  send({
    method: "turn/completed",
    params: { threadId, turn: turnObject(turnId, "completed") },
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

function handle(method: string, params: Record<string, unknown>): unknown {
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
          model_reasoning_effort: "low",
          ...scenario.config,
        },
      };
    case "thread/start":
      threads++;
      return { thread: { id: `thread-${String(threads)}` } };
    case "thread/resume":
      return { thread: { id: params["threadId"] } };
    case "turn/start": {
      turns++;
      const turnId = `turn-${String(turns)}`;
      running = { threadId: String(params["threadId"]), turnId };
      if (scenario.stale) {
        const threadId = running.threadId;
        const old = "previous-turn";
        send({
          method: "turn/started",
          params: { threadId, turn: turnObject(old, "inProgress") },
        });
        send({
          method: "item/agentMessage/delta",
          params: { threadId, turnId: old, itemId: "x", delta: "STALE" },
        });
        send({
          method: "item/completed",
          params: {
            threadId,
            turnId: old,
            item: { id: "y", type: "commandExecution", command: "old" },
          },
        });
        send({
          method: "turn/completed",
          params: { threadId, turn: turnObject(old, "failed") },
        });
      }
      if (scenario.early) void runTurn(running.threadId, turnId);
      else setImmediate(() => void runTurn(running?.threadId ?? "", turnId));
      return { turn: turnObject(turnId, "inProgress") };
    }
    case "turn/interrupt":
      if (scenario.ignoreInterrupt) return undefined;
      setImmediate(() => {
        send({
          method: "turn/completed",
          params: {
            threadId: params["threadId"],
            turn: turnObject(String(params["turnId"]), "interrupted"),
          },
        });
      });
      return {};
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
    try {
      const result = handle(method, message.params ?? {});
      if (result !== undefined) send({ id, result });
    } catch (error) {
      send({ id, error: { code: -32601, message: String(error) } });
    }
  };
  if (scenario.slow?.includes(method)) setTimeout(reply, 200);
  else reply();
});
