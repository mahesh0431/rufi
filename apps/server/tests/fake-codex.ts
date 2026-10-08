// A scripted stand-in for `codex app-server --listen stdio://`, run as a real
// child process so tests exercise Rufi's process, JSON-RPC and cleanup code.
// It keeps Codex's queue as Codex 0.159.2 does: a message starts when nothing
// runs, waits otherwise, and the queue pauses after an interrupt until
// thread/queue/start. What a turn does is chosen by its message's text, the
// same words the fake model uses for the real Codex (tests/fake-model.ts):
// "hang" never ends, "partial" writes "ok:part" and then never ends, "slow"
// answers after 300 ms, "fail" fails, "quiet" makes no tool call and runs no
// command, "command"
// starts a long command ("background command": and the turn ends while it
// runs), "drip" streams its answer in five parts 100 ms
// apart, "long" streams 200 parts of 1,000 characters, and anything else
// answers "ok:<text>".
// The test passes a scenario in FAKE_CODEX and reads what happened from the
// JSON lines written to FAKE_CODEX_LOG.
import { spawn } from "node:child_process";
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

export interface Scenario {
  /** Methods the fake never answers. */
  hang?: string[];
  /** Methods the fake takes and answers after `slowMs` (200 ms). */
  slow?: string[];
  slowMs?: number;
  /** Methods the fake takes at once but answers after `slowMs`. */
  answerLate?: string[];
  /** How long Codex takes to start a message by itself (at once). */
  startMs?: number;
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
  /** The summary parts of a reasoning item the turn has before its answer. */
  reasoning?: string[];
  /** Codex compacts the thread's context during the turn, before answering. */
  compaction?: boolean;
  /** Tool calls the model makes during a turn, before answering. */
  calls?: { namespace: string | null; tool: string; arguments: unknown }[];
  /** A usage-limit snapshot sent before a failed turn. */
  resetsAt?: number;
  /** Threads the fake knows from before, as a restarted Codex would. */
  threads?: Record<
    string,
    { queue?: string[]; paused?: boolean; history?: string[] }
  >;
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
  queue: Queued[];
  paused: boolean;
  running:
    | { turnId: string; steers: Queued[]; interrupted: boolean }
    | undefined;
  /** Each turn's status and the user messages it ran. */
  history: { id: string; status: string; messages: Queued[] }[];
}
const threads = new Map<string, Thread>();
// Like Codex, threads and their queues outlive the process: a restarted fake
// finds them in CODEX_HOME. A reply that was running when it was killed is
// interrupted, and the queue is not paused.
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
    queue: (known.queue ?? []).map((text, i) =>
      queued(`waiting-${String(i)}`, text),
    ),
    paused: known.paused ?? false,
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

function changed(thread: Thread) {
  persist();
  send({ method: "thread/queue/changed", params: { threadId: thread.id } });
}

/** Starts the head of the queue (or `entry`) when nothing runs. */
function dispatch(thread: Thread, entry?: Queued) {
  if (thread.running) return;
  const next = entry ?? thread.queue[0];
  if (!next) return;
  thread.queue = thread.queue.filter((q) => q !== next);
  thread.paused = false;
  // Numbered across every thread and restart, so never used twice.
  const turnId = `turn-${String(
    [...threads.values()].reduce((n, t) => n + t.history.length, 0) + 1,
  )}`;
  thread.running = { turnId, steers: [], interrupted: false };
  record({ turn: turnId, effort: thread.effort ?? null });
  thread.history.push({ id: turnId, status: "inProgress", messages: [next] });
  changed(thread);
  setImmediate(() => void runTurn(thread, turnId, next));
  return turnObject(turnId, "inProgress");
}

function complete(thread: Thread, turnId: string, status: string) {
  const turn = thread.history.find((t) => t.id === turnId);
  if (turn) turn.status = status;
  persist();
  if (thread.running?.turnId !== turnId) return;
  thread.running = undefined;
  if (status === "interrupted") thread.paused = true;
  send({
    method: "turn/completed",
    params: { threadId: thread.id, turn: turnObject(turnId, status) },
  });
  // Like Codex: the next waiting message starts, unless a Stop paused the queue.
  if (!thread.paused) setImmediate(() => dispatch(thread));
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
    if (thread.running?.turnId !== turnId) {
      const turn = thread.history.find((t) => t.id === turnId);
      if (turn) turn.messages = [];
      persist();
      return;
    }
  }
  event("item/started", { item: userItem(entry) });
  const calls = text.includes("quiet") ? [] : (scenario.calls ?? []);
  for (const [i, call] of calls.entries()) {
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
    event("item/started", { item });
    const reply = (await askRufi("item/tool/call", {
      threadId,
      turnId,
      callId: item.id,
      ...call,
    })) as { success?: boolean };
    record({ answered: "item/tool/call", reply });
    if (thread.running?.turnId !== turnId) return;
    event("item/completed", {
      item: {
        ...item,
        status: reply.success ? "completed" : "failed",
        success: reply.success ?? null,
      },
    });
  }
  for (const request of scenario.ask ?? []) {
    record({
      answered: request.method,
      reply: await askRufi(request.method, request.params),
    });
  }
  if (scenario.reasoning) {
    event("item/completed", {
      item: {
        id: "item-think",
        type: "reasoning",
        summary: scenario.reasoning,
        content: [],
      },
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
      item: { id: "item-1", type: "agentMessage", text: "" },
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
    complete(thread, turnId, "failed");
    return;
  }
  if (text.includes("slow"))
    await new Promise((resolve) => setTimeout(resolve, 300));
  if (thread.running?.turnId !== turnId) return;
  if (text.includes("drip") || text.includes("long")) {
    const parts = text.includes("drip")
      ? ["ok:", "d", "r", "i", "p"]
      : Array.from({ length: 200 }, (_, i) => String(i % 10).repeat(1_000));
    event("item/started", {
      item: { id: "item-1", type: "agentMessage", text: "" },
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
  if (!text.includes("quiet"))
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
  event("item/completed", { item: { id: "item-tp", type: "teleport" } });
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
    params: { ...params, item: { id: itemId, type: "agentMessage", text: "" } },
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

function threadResponse(thread: Thread) {
  return {
    thread: {
      id: thread.id,
      status: thread.running
        ? { type: "active", activeFlags: [] }
        : { type: "idle" },
      model: thread.model,
    },
    model: thread.model,
    approvalPolicy: "never",
    sandbox: { type: "dangerFullAccess" },
  };
}

function threadOf(params: Record<string, unknown>): Thread {
  const thread = threads.get(String(params["threadId"]));
  if (!thread) throw new Error("no such thread");
  return thread;
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
          model_reasoning_effort: "medium",
          model_reasoning_summary: "detailed",
          ...scenario.config,
        },
      };
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
      const thread: Thread = {
        // Unique across fakes, as Codex's ids are.
        id: `thread-${String(process.pid)}-${String(++threadCount)}`,
        model: scenario.model ?? String(params["model"]),
        queue: [],
        paused: false,
        running: undefined,
        history: [],
      };
      threads.set(thread.id, thread);
      persist();
      return threadResponse(thread);
    }
    case "thread/resume": {
      const thread = threadOf(params);
      thread.model = scenario.model ?? String(params["model"]);
      // Like Codex: a resumed thread starts what waits, unless paused.
      if (!thread.paused) setImmediate(() => dispatch(thread));
      return threadResponse(thread);
    }
    case "thread/read":
      return threadResponse(threadOf(params));
    case "thread/settings/update": {
      const thread = threadOf(params);
      if (typeof params["effort"] === "string")
        thread.effort = params["effort"];
      persist();
      return {};
    }
    case "thread/queue/add": {
      const thread = threadOf(params);
      if (thread.queue.length >= 100) throw new Error("queue is full");
      const entry: Queued = {
        id: `q-${String(++queuedCount)}`,
        input: params["input"] as Queued["input"],
        clientUserMessageId: String(params["clientUserMessageId"]),
      };
      thread.queue.push(entry);
      changed(thread);
      // Like Codex, it starts only while the queue isn't paused.
      const start = () => {
        if (!thread.paused) dispatch(thread);
      };
      if (scenario.startMs) setTimeout(start, scenario.startMs);
      else setImmediate(start);
      return { queuedSubmission: entry };
    }
    case "thread/queue/list":
      return { data: threadOf(params).queue, nextCursor: null };
    case "thread/queue/start": {
      const thread = threadOf(params);
      if (thread.running) throw new Error("thread is busy");
      const id = params["queuedSubmissionId"];
      const entry = id
        ? thread.queue.find((q) => q.id === id)
        : thread.queue[0];
      if (!entry) throw new Error("queue is empty");
      return { turn: dispatch(thread, entry) };
    }
    case "thread/queue/update": {
      const thread = threadOf(params);
      const entry = thread.queue.find(
        (q) => q.id === params["queuedSubmissionId"],
      );
      if (!entry) throw new Error("not found");
      entry.input = params["input"] as Queued["input"];
      changed(thread);
      return {};
    }
    case "thread/queue/delete": {
      const thread = threadOf(params);
      thread.queue = thread.queue.filter(
        (q) => q.id !== params["queuedSubmissionId"],
      );
      changed(thread);
      return {};
    }
    case "thread/queue/reorder": {
      const thread = threadOf(params);
      const ids = params["queuedSubmissionIds"] as string[];
      thread.queue = ids.flatMap((id) =>
        thread.queue.filter((q) => q.id === id),
      );
      changed(thread);
      return {};
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
    try {
      const result = handle(method, message.params ?? {});
      if (result !== undefined) send({ id, result });
    } catch (error) {
      send({ id, error: { code: -32600, message: (error as Error).message } });
    }
  };
  if (scenario.slow?.includes(method)) {
    setTimeout(reply, scenario.slowMs ?? 200);
  } else if (scenario.answerLate?.includes(method)) {
    const result = handle(method, message.params ?? {});
    setTimeout(() => {
      send({ id, result });
    }, scenario.slowMs ?? 200);
  } else reply();
});
