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
  /** Like Codex, an interrupt leaves the turn's commands running. */
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
    shell.stdout.once("data", (chunk: Buffer) => {
      record({ command: shell.pid, child: Number(chunk.toString().trim()) });
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
      item: item("commandExecution", { command: "ls" }),
    },
  });
  send({
    method: "item/completed",
    params: { threadId, turnId, item: item("teleport", {}) },
  });
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
      setImmediate(() => void runTurn(running?.threadId ?? "", turnId));
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
    case "thread/backgroundTerminals/clean":
      // Ends the command's whole process group, as Codex does.
      if (command?.pid !== undefined) process.kill(-command.pid, "SIGKILL");
      return {};
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
  try {
    const result = handle(message.method, message.params ?? {});
    if (result !== undefined) send({ id: message.id, result });
  } catch (error) {
    send({ id: message.id, error: { code: -32601, message: String(error) } });
  }
});
