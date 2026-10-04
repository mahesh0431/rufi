import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scenario } from "../../../tests/fake-codex.ts";
import { childEnvironment } from "../../platform/config.ts";
import {
  agentCall,
  type AgentEvent,
  type AgentRuntime,
  type AgentTools,
  type ToolAnswer,
  type TurnEnd,
} from "../runtime.ts";
import { checkExecutable } from "./binary.ts";
import { codexRuntime } from "./codex.ts";
import { activityOf, endOf } from "./events.ts";
import { isRunning } from "./processes.ts";

const FAKE = join(import.meta.dirname, "../../../tests/fake-codex.ts");
const SETTINGS = { model: "gpt-6.1-sol", instructions: "Be careful." };

let home: string;
let log: string;
let token: string;
let asked: number[];
let diagnostics: { event: string; method?: unknown }[];
let events: AgentEvent[];
let runtime: AgentRuntime | undefined;
/** While set, token requests wait for it. */
let tokenGate: Promise<void> | undefined;
/** What Rufi's tools are asked, and how they answer. */
let toolCalls: [string, unknown][];
let toolAnswer: (name: string) => Promise<ToolAnswer> | ToolAnswer;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-codex-"));
  log = join(home, "fake.jsonl");
  token = "token-1";
  asked = [];
  diagnostics = [];
  events = [];
  tokenGate = undefined;
  toolCalls = [];
  toolAnswer = () => ({ ok: true, text: '{"ok":true}' });
});
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

const TOOLS: AgentTools = {
  namespace: "rufi",
  specs: [
    {
      name: "get_overview",
      description: "The record at a glance.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

function start(scenario: Scenario = {}, tools?: AgentTools): AgentRuntime {
  runtime = codexRuntime({
    ...(tools && { tools }),
    home,
    command: { file: process.execPath, args: [FAKE] },
    env: {
      PATH: process.env["PATH"] ?? "",
      FAKE_CODEX: JSON.stringify(scenario),
      FAKE_CODEX_LOG: log,
    },
    token: async (validForMs) => {
      asked.push(validForMs);
      await tokenGate;
      return token;
    },
    version: "9.9.9",
    deadlines: {
      requestMs: 1_000,
      turnMs: 3_000,
      interruptAckMs: 300,
      interruptEndMs: 300,
      answerMs: 500,
      toolMs: 200,
    },
    host: {
      onEvent: (event) => events.push(event),
      callTool: async (_threadId, _turnId, name, input) => {
        toolCalls.push([name, input]);
        return toolAnswer(name);
      },
    },
    log: (event, fields) => diagnostics.push({ event, ...fields }),
  });
  return runtime;
}

interface Entry {
  started?: string[];
  pid?: number;
  env?: string[];
  token?: string;
  codexHome?: string;
  received?: { method?: string; params?: Record<string, unknown> };
  answered?: string;
  reply?: unknown;
  command?: number;
  child?: number;
}
const entries = async (): Promise<Entry[]> =>
  (await readFile(log, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry);
const sent = async (method: string) =>
  (await entries())
    .filter((entry) => entry.received?.method === method)
    .map((entry) => entry.received?.params);
const pids = async () =>
  (await entries()).flatMap((entry) => (entry.pid ? [entry.pid] : []));

/** The events of one thread's turns, without the thread id. */
const seen = (threadId: string) =>
  events
    .filter((event) => event.threadId === threadId)
    .map((event) => {
      const rest: Partial<AgentEvent> = { ...event };
      delete rest.threadId;
      return rest as WithoutThread<AgentEvent>;
    });
type WithoutThread<E> = E extends unknown ? Omit<E, "threadId"> : never;

/** How the `n`th turn of the thread ended, once it has. */
async function ended(threadId: string, n = 1): Promise<TurnEnd> {
  await until(() =>
    Promise.resolve(
      events.filter((e) => e.threadId === threadId && e.type === "turnEnded")
        .length >= n,
    ),
  );
  const end = events.filter(
    (e): e is Extract<AgentEvent, { type: "turnEnded" }> =>
      e.threadId === threadId && e.type === "turnEnded",
  )[n - 1];
  if (!end) throw new Error("the turn didn't end");
  return end.end;
}

/** A new thread with one message sent; returns the thread's id. */
async function ask(agent: AgentRuntime, text = "How are you?") {
  const { threadId } = await agent.startThread(SETTINGS);
  await agent.send(threadId, { id: `m-${text}`, text });
  return threadId;
}

describe("starting Codex", () => {
  it("runs app-server as OpenAI documents, with only the environment Rufi gives it", async () => {
    await start().startThread(SETTINGS);
    const [first] = await entries();
    expect(first?.started).toEqual(["app-server", "--listen", "stdio://"]);
    expect(first?.token).toBe("token-1");
    expect(first?.codexHome).toBe(join(home, "codex"));
    expect(first?.env).toEqual(
      expect.arrayContaining(["ACCESS_TOKEN", "CODEX_HOME", "PATH"]),
    );
    expect(first?.env).not.toContain("OPENAI_API_KEY");
    expect((await sent("initialize"))[0]).toEqual({
      clientInfo: { name: "Rufi", title: "Rufi", version: "9.9.9" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const config = await readFile(join(home, "codex/config.toml"), "utf8");
    for (const line of [
      'model_provider = "openai_chatgpt_plan"',
      'base_url = "https://api.openai.com/v1"',
      'env_key = "ACCESS_TOKEN"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      'model_reasoning_effort = "low"',
      "daemon_auto_start = false",
    ]) {
      expect(config).toContain(line);
    }
  });

  it("gives the child only listed variables, never secrets", () => {
    expect(
      childEnvironment({
        PATH: "/bin",
        HOME: "/Users/amma",
        OPENAI_API_KEY: "sk-x",
        ACCESS_TOKEN: "old",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/Users/amma" });
  });

  it("refuses a Codex binary that other users can change", async () => {
    const binary = join(home, "codex");
    await writeFile(binary, "#!/bin/sh\n");
    await chmod(binary, 0o755);
    await expect(checkExecutable(binary)).resolves.toBeUndefined();
    await chmod(binary, 0o757);
    await expect(checkExecutable(binary)).rejects.toThrow(
      "can be changed by other users",
    );
  });

  it("asks for a token that outlasts a whole turn", async () => {
    await start().startThread(SETTINGS);
    expect(asked).toEqual([3_000 + 5 * 60_000]);
  });

  it("refuses Codex when it didn't take Rufi's settings, and stops it", async () => {
    await expect(
      start({ features: { daemon_auto_start: true } }).startThread(SETTINGS),
    ).rejects.toThrow(
      "Codex didn't take Rufi's settings: daemon_auto_start is on.",
    );
    expect((await pids()).filter(isRunning)).toEqual([]);
    await expect(
      start({ config: { model_reasoning_effort: "high" } }).startThread(
        SETTINGS,
      ),
    ).rejects.toThrow("model_reasoning_effort is high");
    // Codex would drop Rufi's tools without a word.
    await expect(
      start({ capabilities: { namespaceTools: false } }).startThread(SETTINGS),
    ).rejects.toThrow("the provider doesn't take Rufi's tools");
  });

  it.each(["initialize", "config/read", "thread/start"])(
    "gives up when Codex doesn't answer %s, and ends it",
    async (method) => {
      await expect(
        start({ hang: [method] }).startThread(SETTINGS),
      ).rejects.toThrow(`didn't answer ${method} within 1 s`);
      if (method !== "thread/start") {
        expect((await pids()).filter(isRunning)).toEqual([]);
      }
    },
  );

  it("refuses a thread on another model than Rufi asked for", async () => {
    await expect(
      start({ model: "gpt-4" }).startThread(SETTINGS),
    ).rejects.toThrow(
      "Codex didn't take Rufi's thread settings: the model is gpt-4.",
    );
  });

  it("lists the provider's models, following every page", async () => {
    await expect(start().models()).resolves.toEqual([
      { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
      { id: "gpt-6-astra", name: "GPT-6-Astra" },
      { id: "gpt-5.5", name: "GPT-5.5" },
    ]);
  });
});

describe("a turn", () => {
  it("streams the reply, shows what the agent did, and ignores stray notifications", async () => {
    const thread = await ask(start(), "Hello");
    expect(await ended(thread)).toEqual({ status: "completed" });
    expect(seen(thread)).toEqual([
      { type: "waitingChanged" },
      { type: "waitingChanged" },
      { type: "turnStarted", turnId: "turn-1" },
      { type: "message", turnId: "turn-1", id: "m-Hello", text: "Hello" },
      { type: "text", turnId: "turn-1", itemId: "item-1", delta: "ok:" },
      { type: "text", turnId: "turn-1", itemId: "item-1", delta: "Hello" },
      {
        type: "activity",
        turnId: "turn-1",
        itemId: "item-ls",
        activity: "command",
        title: "Ran a command",
        detail: "ls",
        status: "done",
      },
      {
        type: "activity",
        turnId: "turn-1",
        itemId: "item-tp",
        activity: "other",
        title: "The AI did something Rufi can't display",
        detail: "teleport",
        status: "done",
      },
      { type: "turnEnded", turnId: "turn-1", end: { status: "completed" } },
    ]);
    expect(diagnostics).toContainEqual({
      event: "codex.notification_ignored",
      method: "remoteControl/status/changed",
    });
    expect(
      diagnostics.some((d) => String(d.method).startsWith("brand/new")),
    ).toBe(true);
  });

  it("starts a thread with the model, full access, Rufi's instructions and tools", async () => {
    await start({}, TOOLS).startThread(SETTINGS);
    expect(await sent("thread/start")).toEqual([
      {
        model: "gpt-6.1-sol",
        cwd: join(home, "workspace"),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        developerInstructions: "Be careful.",
        dynamicTools: [
          {
            type: "namespace",
            name: "rufi",
            description: "Rufi: the user's health record.",
            tools: [
              {
                type: "function",
                name: "get_overview",
                description: "The record at a glance.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        ],
      },
    ]);
  });

  it("sends the message with Rufi's id, and the new thread's context before it", async () => {
    const agent = start();
    const { threadId } = await agent.startThread(SETTINGS);
    await agent.send(threadId, {
      id: "m-1",
      text: "Hi",
      context: "Earlier: hello",
    });
    await ended(threadId);
    expect(await sent("thread/queue/add")).toEqual([
      {
        threadId,
        clientUserMessageId: "m-1",
        input: [
          { type: "text", text: "Earlier: hello", text_elements: [] },
          { type: "text", text: "Hi", text_elements: [] },
        ],
      },
    ]);
    // The message is the user's words only.
    expect(seen(threadId)).toContainEqual({
      type: "message",
      turnId: "turn-1",
      id: "m-1",
      text: "Hi",
    });
  });

  it("ignores events from an earlier turn on the same thread", async () => {
    const thread = await ask(start({ stale: true }), "Hello");
    await ended(thread);
    expect(
      seen(thread)
        .filter((e) => e.type === "text")
        .map((e) => e.delta),
    ).toEqual(["ok:", "Hello"]);
  });

  it("gives a message that didn't stream, and the AI's questions for the user", async () => {
    const thread = await ask(
      start({
        unstreamed: {
          text: "Which person do you mean?",
          questions: [
            { title: "Whose results?", options: ["Asha", "Ravi"] },
            { title: "Anything else?", options: null },
          ],
        },
      }),
    );
    await ended(thread);
    const last = seen(thread).filter((e) =>
      ["text", "question"].includes(e.type),
    );
    expect(last.slice(-3)).toEqual([
      {
        type: "text",
        turnId: "turn-1",
        itemId: "item-last",
        delta: "Which person do you mean?",
      },
      {
        type: "question",
        turnId: "turn-1",
        itemId: "item-last",
        title: "Whose results?",
        options: ["Asha", "Ravi"],
      },
      {
        type: "question",
        turnId: "turn-1",
        itemId: "item-last",
        title: "Anything else?",
        options: [],
      },
    ]);
    // The streamed message isn't repeated when it completes.
    expect(last.filter((e) => e.type === "text")).toHaveLength(3);
  });

  it("reports a usage limit with its reset time, when Codex gives one", async () => {
    const thread = await ask(start({ resetsAt: 1_791_000_000 }), "please fail");
    expect(await ended(thread)).toEqual({
      status: "failed",
      reason: "usage_limit",
      text: "Your ChatGPT plan's usage limit has been reached.",
      resetsAt: new Date(1_791_000_000_000).toISOString(),
    });
  });

  it("reports a usage limit without a reset time when Codex gives none", async () => {
    const thread = await ask(start(), "please fail");
    expect(await ended(thread)).toEqual({
      status: "failed",
      reason: "usage_limit",
      text: "Your ChatGPT plan's usage limit has been reached.",
    });
  });

  it("stops a turn that runs past its deadline", async () => {
    const thread = await ask(start(), "hang");
    expect(await ended(thread)).toEqual({
      status: "failed",
      reason: "timeout",
      text: "The reply took too long, so Rufi stopped it.",
    });
    expect(await sent("turn/interrupt")).toEqual([
      { threadId: thread, turnId: "turn-1" },
    ]);
  });

  it("declines approvals, answers a tool call that isn't this turn's, and refuses other requests", async () => {
    const thread = await ask(
      start({
        ask: [
          {
            method: "item/commandExecution/requestApproval",
            params: { command: "rm -rf /" },
          },
          { method: "item/tool/call", params: { tool: "read_record" } },
          { method: "item/tool/requestUserInput", params: {} },
        ],
      }),
    );
    await ended(thread);
    const replies = (await entries()).filter((entry) => entry.answered);
    expect(replies.map((entry) => entry.reply)).toEqual([
      { decision: "decline" },
      {
        contentItems: [
          {
            type: "inputText",
            text: '{"ok":false,"error":"No turn is running."}',
          },
        ],
        success: false,
      },
      {
        id: 1002,
        error: {
          code: -32601,
          message: "Rufi doesn't handle item/tool/requestUserInput.",
        },
      },
    ]);
  });
});

describe("Codex's queue", () => {
  it("holds a message sent while a reply runs, and starts it after", async () => {
    const agent = start();
    const thread = await ask(agent, "slow first");
    await until(() => Promise.resolve(agent.running(thread)));
    await agent.send(thread, { id: "m-2", text: "second" });
    expect(await agent.waiting.list(thread)).toEqual([
      { id: "q-2", messageId: "m-2", text: "second" },
    ]);
    await ended(thread, 2);
    expect(
      seen(thread)
        .filter((e) => e.type === "message")
        .map((e) => e.id),
    ).toEqual(["m-slow first", "m-2"]);
    // Codex started both by itself: nothing was paused.
    expect(await sent("thread/queue/start")).toEqual([]);
  });

  it("pauses after Stop; the next send starts what waited first, then itself", async () => {
    const agent = start();
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    await agent.send(thread, { id: "m-b", text: "B" });
    await agent.stop(thread);
    expect(await ended(thread)).toEqual({
      status: "interrupted",
      reason: "stopped",
      text: "Stopped.",
    });
    await sleep(50);
    // Paused: B still waits.
    expect((await agent.waiting.list(thread)).map((w) => w.messageId)).toEqual([
      "m-b",
    ]);
    await agent.send(thread, { id: "m-c", text: "C" });
    await ended(thread, 3);
    expect(
      seen(thread)
        .filter((e) => e.type === "message")
        .map((e) => e.id),
    ).toEqual(["m-hang", "m-b", "m-c"]);
  });

  it("starts a message at once after Stop when nothing waits", async () => {
    const agent = start();
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    await agent.stop(thread);
    await ended(thread);
    await agent.send(thread, { id: "m-2", text: "again" });
    expect(await ended(thread, 2)).toEqual({ status: "completed" });
  });

  it("runs a chosen waiting message now; the others follow in order", async () => {
    const agent = start();
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    await agent.send(thread, { id: "m-b", text: "B" });
    await agent.send(thread, { id: "m-c", text: "C" });
    await agent.stop(thread);
    await ended(thread);
    const [, c] = await agent.waiting.list(thread);
    await agent.waiting.runNow(thread, c?.id ?? "");
    await ended(thread, 3);
    expect(
      seen(thread)
        .filter((e) => e.type === "message")
        .map((e) => e.id),
    ).toEqual(["m-hang", "m-c", "m-b"]);
  });

  it("keeps a message waiting when Stop comes while a paused queue takes it", async () => {
    const agent = start({ slow: ["thread/queue/add"] });
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    await agent.stop(thread);
    await ended(thread);
    const op = new AbortController();
    const sending = agent.send(thread, { id: "m-b", text: "B" }, op.signal);
    await until(async () => (await sent("thread/queue/add")).length === 2);
    op.abort();
    await expect(sending).rejects.toThrow("Stopped.");
    await sleep(50);
    expect(await sent("thread/queue/start")).toEqual([]);
    expect(agent.running(thread)).toBe(false);
    expect((await agent.waiting.list(thread)).map((w) => w.messageId)).toEqual([
      "m-b",
    ]);
  });

  it("stops a message Codex started by itself when Stop came while it was added", async () => {
    const agent = start({ slow: ["thread/queue/add"] });
    const { threadId } = await agent.startThread(SETTINGS);
    const op = new AbortController();
    const sending = agent.send(
      threadId,
      { id: "m-a", text: "hang" },
      op.signal,
    );
    await until(async () => (await sent("thread/queue/add")).length === 1);
    op.abort();
    await expect(sending).rejects.toThrow("Stopped.");
    expect(await ended(threadId)).toMatchObject({ status: "interrupted" });
  });

  it("stops a message Codex takes after its request timed out, when Stop came meanwhile", async () => {
    // Codex takes the add only after Rufi gave up waiting for it.
    const agent = start({ slow: ["thread/queue/add"], slowMs: 1_500 });
    const { threadId } = await agent.startThread(SETTINGS);
    const op = new AbortController();
    const sending = agent.send(
      threadId,
      { id: "m-a", text: "hang" },
      op.signal,
    );
    await until(async () => (await sent("thread/queue/add")).length === 1);
    op.abort();
    await expect(sending).rejects.toThrow("Stopped.");
    expect(await ended(threadId)).toMatchObject({ status: "interrupted" });
  });

  it("stops a waiting message Codex starts after Run Now timed out, when Stop came meanwhile", async () => {
    const agent = start({ slow: ["thread/queue/start"], slowMs: 1_500 });
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    await agent.send(thread, { id: "m-b", text: "hang again" });
    await agent.stop(thread);
    await ended(thread);
    const [b] = await agent.waiting.list(thread);
    const op = new AbortController();
    const running = agent.waiting.runNow(thread, b?.id ?? "", op.signal);
    await until(async () => (await sent("thread/queue/start")).length === 1);
    op.abort();
    await expect(running).rejects.toThrow("Stopped.");
    expect(await ended(thread, 2)).toMatchObject({ status: "interrupted" });
  });

  it("stops a reply only when it is the one asked for", async () => {
    const agent = start();
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    await agent.stop(thread, "an-earlier-turn");
    await sleep(100);
    expect(agent.running(thread)).toBe(true);
    await agent.stop(thread, "turn-1");
    expect(await ended(thread)).toMatchObject({ status: "interrupted" });
  });

  it("stops a waiting message run now when Stop came while it started", async () => {
    const agent = start({ slow: ["thread/queue/start"] });
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    await agent.send(thread, { id: "m-b", text: "hang again" });
    await agent.stop(thread);
    await ended(thread);
    const [b] = await agent.waiting.list(thread);
    const op = new AbortController();
    const running = agent.waiting.runNow(thread, b?.id ?? "", op.signal);
    await until(async () => (await sent("thread/queue/start")).length === 1);
    op.abort();
    await expect(running).rejects.toThrow("Stopped.");
    expect(await ended(thread, 2)).toMatchObject({ status: "interrupted" });
  });

  it("edits, reorders and deletes waiting messages, keeping Rufi's context", async () => {
    const agent = start();
    const { threadId } = await agent.startThread(SETTINGS);
    await agent.send(threadId, { id: "m-a", text: "hang" });
    await until(() => Promise.resolve(agent.running(threadId)));
    await agent.send(threadId, { id: "m-b", text: "B" });
    await agent.send(threadId, { id: "m-c", text: "C" });
    const [b, c] = await agent.waiting.list(threadId);
    await agent.waiting.edit(threadId, b?.id ?? "", "B, edited");
    await agent.waiting.reorder(threadId, [c?.id ?? "", b?.id ?? ""]);
    expect(await agent.waiting.list(threadId)).toEqual([
      { id: c?.id, messageId: "m-c", text: "C" },
      { id: b?.id, messageId: "m-b", text: "B, edited" },
    ]);
    await agent.waiting.remove(threadId, c?.id ?? "");
    expect(
      (await agent.waiting.list(threadId)).map((w) => w.messageId),
    ).toEqual(["m-b"]);
  });

  it("passes a steer into the running reply, with Rufi's id", async () => {
    const agent = start();
    const thread = await ask(agent, "slow");
    await until(() => Promise.resolve(agent.running(thread)));
    await expect(
      agent.steer(thread, { id: "s-1", text: "shorter" }),
    ).resolves.toEqual({
      turnId: "turn-1",
    });
    await ended(thread);
    expect(seen(thread)).toContainEqual({
      type: "message",
      turnId: "turn-1",
      id: "s-1",
      text: "shorter",
    });
    await expect(
      agent.steer(thread, { id: "s-2", text: "late" }),
    ).rejects.toThrow("No reply is running to steer.");
  });

  it("lists the messages a thread ran, with Rufi's ids", async () => {
    const agent = start();
    const thread = await ask(agent, "first");
    await ended(thread);
    await agent.send(thread, { id: "m-2", text: "second" });
    await ended(thread, 2);
    await expect(agent.startedMessages(thread)).resolves.toEqual([
      { id: "m-first", text: "first" },
      { id: "m-2", text: "second" },
    ]);
  });

  it("lists every message of a long thread, page after page", async () => {
    const history = Array.from({ length: 120 }, (_, i) => `m-${String(i)}`);
    const agent = start({ threads: { "old-1": { history } } });
    await agent.resumeThread("old-1", SETTINGS);
    const messages = await agent.startedMessages("old-1");
    expect(messages.map((m) => m.id)).toEqual(history);
    expect(await sent("thread/turns/list")).toHaveLength(3);
  });

  it("resumes a thread with the settings, and may start what waited", async () => {
    const agent = start({ threads: { "old-1": { queue: ["left waiting"] } } });
    await expect(agent.resumeThread("old-1", SETTINGS)).resolves.toMatchObject({
      model: "gpt-6.1-sol",
    });
    expect(await sent("thread/resume")).toEqual([
      {
        threadId: "old-1",
        excludeTurns: true,
        model: "gpt-6.1-sol",
        cwd: join(home, "workspace"),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        developerInstructions: "Be careful.",
      },
    ]);
    expect(await ended("old-1")).toEqual({ status: "completed" });
  });

  it("stops a reply a resume started when Stop came during the resume", async () => {
    const agent = start({
      threads: { "old-1": { queue: ["hang"] } },
      slow: ["thread/resume"],
    });
    const op = new AbortController();
    const resuming = agent.resumeThread("old-1", SETTINGS, op.signal);
    await until(async () => (await sent("thread/resume")).length > 0);
    op.abort();
    await expect(resuming).rejects.toThrow("Stopped.");
    // Codex starts the waiting reply only after its answer; it is stopped too.
    expect(await ended("old-1")).toMatchObject({ status: "interrupted" });
  });
});

describe("Stop", () => {
  it("ends the commands an interrupted turn left running, and keeps Codex", async () => {
    const agent = start();
    const thread = await ask(agent, "command");
    await until(async () => (await entries()).some((entry) => entry.child));
    const programs = (await entries()).find((entry) => entry.child);
    await agent.stop(thread);
    expect(await ended(thread)).toEqual({
      status: "interrupted",
      reason: "stopped",
      text: "Stopped.",
    });
    expect(await sent("thread/backgroundTerminals/clean")).toEqual([
      { threadId: thread },
    ]);
    await sleep(100);
    expect(
      [programs?.command, programs?.child].filter(
        (pid) => pid !== undefined && isRunning(pid),
      ),
    ).toEqual([]);
    expect((await pids()).filter(isRunning)).toHaveLength(1);
  });

  it("ends Codex when it can't clean up after an interrupt", async () => {
    const agent = start({ hang: ["thread/backgroundTerminals/clean"] });
    const thread = await ask(agent, "command");
    await until(async () => (await entries()).some((entry) => entry.child));
    const programs = (await entries()).find((entry) => entry.child);
    await agent.stop(thread);
    const all = [...(await pids()), programs?.command, programs?.child];
    expect(all.filter((pid) => pid !== undefined && isRunning(pid))).toEqual(
      [],
    );
  });

  it("ends Codex and the programs it started when the interrupt is ignored", async () => {
    const agent = start({ ignoreInterrupt: true });
    const thread = await ask(agent, "command");
    await until(async () => (await entries()).some((entry) => entry.child));
    const programs = (await entries()).find((entry) => entry.child);
    await agent.stop(thread);
    expect(await ended(thread)).toEqual({
      status: "interrupted",
      reason: "stopped",
      text: "Codex didn't stop when asked, so Rufi ended it.",
    });
    const all = [...(await pids()), programs?.command, programs?.child];
    expect(all.filter((pid) => pid !== undefined && isRunning(pid))).toEqual(
      [],
    );
  });

  async function runCommand(scenario: Scenario) {
    const agent = start(scenario);
    const thread = await ask(agent, "command");
    await until(async () => (await entries()).some((entry) => entry.child));
    const found = (await entries()).find((entry) => entry.child);
    const programs = [found?.command, found?.child].filter(
      (pid): pid is number => pid !== undefined,
    );
    return { agent, thread, programs };
  }

  it("waits until Codex has really ended the commands, not just queued it", async () => {
    const { agent, thread, programs } = await runCommand({ clean: "later" });
    await agent.stop(thread);
    expect(programs.filter(isRunning)).toEqual([]);
    expect((await pids()).filter(isRunning)).toHaveLength(1);
  });

  it("ends Codex when it queues the clean-up but never does it", async () => {
    const { agent, thread, programs } = await runCommand({ clean: "never" });
    await agent.stop(thread);
    expect([...programs, ...(await pids())].filter(isRunning)).toEqual([]);
  });

  it("stops a turn once, however often Stop is pressed", async () => {
    const { agent, thread } = await runCommand({});
    await Promise.all([agent.stop(thread), agent.stop(thread)]);
    expect(await sent("turn/interrupt")).toHaveLength(1);
    expect(await sent("thread/backgroundTerminals/clean")).toHaveLength(1);
  });

  it("shows nothing of a turn after its Stop", async () => {
    const agent = start({ late: true });
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    await agent.stop(thread);
    await ended(thread);
    expect(JSON.stringify(seen(thread))).not.toContain("LATE");
  });

  it("ends the commands Codex left when it crashes", async () => {
    const { thread, programs } = await runCommand({});
    await sleep(200);
    const [codex] = await pids();
    if (codex !== undefined) process.kill(codex, "SIGKILL");
    expect(await ended(thread)).toEqual({
      status: "failed",
      reason: "provider_failed",
      text: "Codex stopped unexpectedly.",
    });
    expect(programs.filter(isRunning)).toEqual([]);
  });

  it("shows a command when it starts", async () => {
    const { agent, thread } = await runCommand({});
    await agent.stop(thread);
    expect(seen(thread).filter((e) => e.type === "activity")).toEqual([
      {
        type: "activity",
        turnId: "turn-1",
        itemId: "item-cmd",
        activity: "command",
        title: "Ran a command",
        detail: "sleep 301",
        status: "running",
      },
    ]);
  });

  it("sends nothing when Stop comes while Rufi waits for a token", async () => {
    const agent = start();
    const { threadId } = await agent.startThread(SETTINGS);
    const gate = Promise.withResolvers<undefined>();
    tokenGate = gate.promise;
    const op = new AbortController();
    const sending = agent.send(
      threadId,
      { id: "m-1", text: "Hello" },
      op.signal,
    );
    await sleep(50);
    op.abort();
    gate.resolve(undefined);
    await expect(sending).rejects.toThrow("Stopped.");
    expect(await sent("thread/queue/add")).toEqual([]);
  });

  it("stops waiting for Codex to start at once, and closing ends it", async () => {
    const agent = start({ hang: ["initialize"] });
    const op = new AbortController();
    const opening = Effect.runFork(
      agentCall(
        () => agent.startThread(SETTINGS, op.signal),
        () => {
          op.abort();
          return Promise.resolve();
        },
      ),
    );
    await until(async () => (await pids()).length > 0);
    const began = Date.now();
    await Effect.runPromise(Fiber.interrupt(opening));
    // Well before initialize's own deadline (requestMs, 1 s here).
    expect(Date.now() - began).toBeLessThan(500);
    await agent.close();
    expect((await pids()).filter(isRunning)).toEqual([]);
  });

  it("waits for a sign-in renewal to be saved before it ends", async () => {
    vi.useFakeTimers();
    try {
      let saved = false;
      // A renewal whose Keychain save takes 50 s, within its 60 s deadline.
      const renewal = new Promise<string>((resolve) =>
        setTimeout(() => {
          saved = true;
          resolve("thread-1");
        }, 50_000),
      );
      const opening = Effect.runFork(
        agentCall(
          () => renewal,
          () => Promise.resolve(),
        ),
      );
      let done = false;
      void Effect.runPromise(Fiber.interrupt(opening)).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(saved).toBe(true);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up waiting for an agent that never stops", async () => {
    const never = new Promise<never>(() => undefined);
    const opening = Effect.runFork(
      agentCall(
        () => never,
        () => never,
        undefined,
        50,
      ),
    );
    await sleep(10);
    await Effect.runPromise(Fiber.interrupt(opening));
  });
});

describe("closing", () => {
  it("ends a running turn at once, with Codex and its programs", async () => {
    const agent = start({ ignoreInterrupt: true });
    const thread = await ask(agent, "command");
    await until(async () => (await entries()).some((entry) => entry.child));
    const programs = (await entries()).find((entry) => entry.child);
    await agent.close();
    expect(await ended(thread)).toEqual({
      status: "interrupted",
      reason: "stopped",
      text: "Rufi closed Codex.",
    });
    const all = [...(await pids()), programs?.command, programs?.child];
    expect(all.filter((pid) => pid !== undefined && isRunning(pid))).toEqual(
      [],
    );
  });
});

describe("token renewal", () => {
  it("starts a new Codex with a new token, once no reply runs", async () => {
    const agent = start();
    const thread = await ask(agent, "first");
    await ended(thread);
    token = "token-2";
    await agent.startThread(SETTINGS);
    const starts = (await entries()).filter((entry) => entry.started);
    expect(starts.map((entry) => entry.token)).toEqual(["token-1", "token-2"]);
    expect((await pids()).slice(0, 1).filter(isRunning)).toEqual([]);
    // The old app-server is gone, so the thread must be opened again.
    expect(agent.loaded(thread)).toBe(false);
  });

  it("keeps Codex while a reply runs, even with a new token", async () => {
    const agent = start();
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    token = "token-2";
    await agent.startThread(SETTINGS);
    expect(await pids()).toHaveLength(1);
  });

  it("keeps the same Codex while the token is the same", async () => {
    const agent = start();
    const thread = await ask(agent, "first");
    await ended(thread);
    await agent.send(thread, { id: "m-2", text: "second" });
    await ended(thread, 2);
    expect(await pids()).toHaveLength(1);
  });

  it("gives no tools again when a thread is resumed (Codex keeps them)", async () => {
    const agent = start({ threads: { "old-1": {} } }, TOOLS);
    await agent.resumeThread("old-1", SETTINGS);
    const [resumed] = await sent("thread/resume");
    expect(resumed).toMatchObject({ developerInstructions: "Be careful." });
    expect(resumed).not.toHaveProperty("dynamicTools");
  });
});

describe("Rufi's tools", () => {
  const overview = { namespace: "rufi", tool: "get_overview", arguments: {} };
  const replies = async () =>
    (await entries())
      .filter((entry) => entry.answered === "item/tool/call")
      .map((entry) => entry.reply);

  it("runs a call, answers with its result, and shows it", async () => {
    const thread = await ask(start({ calls: [overview] }, TOOLS));
    expect(await ended(thread)).toEqual({ status: "completed" });
    expect(toolCalls).toEqual([["get_overview", {}]]);
    expect(await replies()).toEqual([
      {
        contentItems: [{ type: "inputText", text: '{"ok":true}' }],
        success: true,
      },
    ]);
    expect(
      seen(thread)
        .filter((e) => e.type === "activity" && e.activity === "tool")
        .map((e) => e.type === "activity" && [e.title, e.status]),
    ).toEqual([
      ["Used get_overview", "running"],
      ["Used get_overview", "done"],
    ]);
  });

  it("passes a call outside Rufi's namespace on as an unknown tool, never an RPC error", async () => {
    toolAnswer = (name) => ({
      ok: false,
      text: JSON.stringify({ ok: false, error: `no ${name}` }),
    });
    const thread = await ask(
      start({ calls: [{ ...overview, namespace: "other" }] }, TOOLS),
    );
    await ended(thread);
    expect(toolCalls).toEqual([["other.get_overview", {}]]);
    expect(await replies()).toEqual([
      {
        contentItems: [
          {
            type: "inputText",
            text: '{"ok":false,"error":"no other.get_overview"}',
          },
        ],
        success: false,
      },
    ]);
  });

  it("answers a tool that takes too long within the deadline", async () => {
    toolAnswer = async () => {
      await sleep(2_000);
      return { ok: true, text: "late" };
    };
    const begun = Date.now();
    const thread = await ask(start({ calls: [overview] }, TOOLS));
    expect(await ended(thread)).toEqual({ status: "completed" });
    expect(Date.now() - begun).toBeLessThan(1_500);
    expect(await replies()).toEqual([
      {
        contentItems: [
          {
            type: "inputText",
            text: '{"ok":false,"error":"get_overview took too long."}',
          },
        ],
        success: false,
      },
    ]);
  });

  it("stops the turn when the tools say so", async () => {
    toolAnswer = () => ({
      ok: false,
      text: "{}",
      stopTurn: "The AI kept making requests Rufi couldn't accept.",
    });
    const thread = await ask(start({ calls: [overview] }, TOOLS), "hang");
    expect(await ended(thread)).toEqual({
      status: "failed",
      text: "The AI kept making requests Rufi couldn't accept.",
    });
    expect(await sent("turn/interrupt")).toHaveLength(1);
  });

  it("doesn't run a tool for a turn after its Stop", async () => {
    toolAnswer = async () => {
      await sleep(100);
      return { ok: true, text: "{}" };
    };
    const agent = start({ calls: [overview, overview] }, TOOLS);
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(toolCalls.length === 1));
    await agent.stop(thread);
    await ended(thread);
    await sleep(150);
    expect(toolCalls).toHaveLength(1);
    expect(
      seen(thread).filter((e) => e.type === "activity" && e.status === "done"),
    ).toEqual([]);
  });
});

describe("Codex's items and endings in Rufi's words", () => {
  it("counts only `completed` as success", () => {
    expect(endOf({ status: "completed", error: null })).toEqual({
      status: "completed",
    });
    expect(endOf({ status: "inProgress", error: null }).status).toBe("failed");
  });

  it("names each kind of failure", () => {
    const failed = (codexErrorInfo: unknown) =>
      endOf({
        status: "failed",
        error: {
          message: "raw",
          codexErrorInfo: codexErrorInfo as null,
          additionalDetails: null,
          misalignment: null,
        },
      }).reason;
    expect(failed("unauthorized")).toBe("sign_in");
    expect(failed("rateLimitExceeded")).toBe("rate_limit");
    expect(failed({ httpConnectionFailed: { httpStatusCode: null } })).toBe(
      "connection",
    );
    expect(failed("serverOverloaded")).toBe("provider_failed");
    expect(failed("contextWindowExceeded")).toBe("provider_failed");
  });

  it("gives each item one line, and marks one it doesn't know", () => {
    expect(
      activityOf(
        {
          type: "webSearch",
          id: "w",
          query: "HbA1c",
          action: null,
          results: null,
        },
        true,
      ),
    ).toEqual({
      activity: "web_search",
      title: "Searched the web",
      detail: "HbA1c",
      status: "done",
    });
    expect(activityOf({ type: "contextCompaction", id: "c" }, false)).toEqual({
      activity: "other",
      title: "Condensed the earlier conversation",
      status: "running",
    });
    expect(
      activityOf(
        { type: "reasoning", id: "r", summary: [], content: [] },
        true,
      ),
    ).toBeUndefined();
    expect(activityOf({ type: "hologram", id: "h" } as never, true)).toEqual({
      activity: "other",
      title: "The AI did something Rufi can't display",
      detail: "hologram",
      status: "done",
    });
  });

  it("gives a tool call its arguments as detail, and none when it took none", () => {
    const call = (args: unknown) =>
      activityOf(
        {
          type: "dynamicToolCall",
          id: "t",
          namespace: "rufi",
          tool: "read_conversation",
          arguments: args,
          status: "completed",
          contentItems: null,
          success: true,
          durationMs: 1,
        } as never,
        true,
      );
    expect(call({})).toEqual({
      activity: "tool",
      title: "Used read_conversation",
      status: "done",
    });
    expect(call({ limit: 5 })?.detail).toBe('{"limit":5}');
  });

  it("keeps an activity's detail to one short line", () => {
    const line = activityOf(
      {
        type: "commandExecution",
        id: "c",
        command: `echo ${"x".repeat(400)}\nls`,
        status: "completed",
      } as never,
      true,
    );
    expect(line?.detail).toHaveLength(300);
    expect(line?.detail).not.toContain("\n");
  });
});

async function until(ready: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300 && !(await ready().catch(() => false)); i++) {
    await sleep(10);
  }
}
