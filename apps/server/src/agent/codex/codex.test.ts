import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect, Fiber } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scenario } from "../../../tests/fake-codex.ts";
import { childEnvironment } from "../../platform/config.ts";
import {
  agentCall,
  NotReloaded,
  NotSent,
  type AgentEvent,
  type AgentRuntime,
  type AgentTools,
  type TurnEnd,
} from "../runtime.ts";
import type { Deadlines } from "./appserver.ts";
import { checkExecutable } from "./binary.ts";
import { codexRuntime } from "./codex.ts";
import { activityOf, endOf } from "./events.ts";
import { isRunning } from "./processes.ts";
import type { CommandAction } from "./protocol/v2/CommandAction.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";

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
/** A stand-in for Rufi's MCP server, when a test starts one. */
let mcp: Server | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-codex-"));
  log = join(home, "fake.jsonl");
  token = "token-1";
  asked = [];
  diagnostics = [];
  events = [];
  tokenGate = undefined;
});
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await new Promise((resolve) => {
    if (mcp) mcp.close(resolve);
    else resolve(null);
  });
  mcp = undefined;
});

const TOOLS: AgentTools = {
  server: "rufi",
  specs: [{ name: "get_overview", shown: () => "Read your overview" }],
};

/**
 * A stand-in for Rufi's MCP server that answers the session's start with
 * `status`; returns the thread settings' tools for it.
 */
async function mcpServer(status = 200) {
  mcp = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "rufi", version: "1.0.0" },
          },
        }),
      );
    });
  });
  const server = mcp;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/mcp`, key: "key-1" };
}

/*
 * Timing: a busy CI machine can be slow by a second or more. So a deadline the
 * fake meets (requestMs, Stop's) is 1 s or more, and a test that waits a
 * deadline out sets it short (GIVE_UP, a turn's 300 ms). Starting the fake (a
 * new Node process) is the slowest step, so its own deadline (startMs) is
 * long, except where a test waits it out. `until` waits far
 * longer than both, and fails when it gives up. A test waits for what it
 * needs, not a fixed time, except to check that nothing more happens or when
 * nothing shows what it needs.
 */

/** Stop's deadlines when the fake never answers, so Rufi gives up soon. */
const GIVE_UP = { interruptAckMs: 300, interruptEndMs: 300 };

function start(
  scenario: Scenario = {},
  tools?: AgentTools,
  deadlines?: Partial<Deadlines>,
): AgentRuntime {
  runtime = codexRuntime({
    ...(tools && { tools }),
    home,
    sandbox: { folder: join(home, "ai"), unreadable: [] },
    skills: [],
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
      startMs: 10_000,
      requestMs: 1_000,
      turnMs: 3_000,
      interruptAckMs: 1_000,
      interruptEndMs: 1_000,
      answerMs: 500,
      toolMs: 200,
      ...deadlines,
    },
    host: { onEvent: (event) => events.push(event) },
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
  /** A turn the fake ran, with the instructions its history held. */
  turn?: string;
  told?: string | null;
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
  await agent.send(threadId, { id: `m-${text}`, input: [text] });
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
      'model_reasoning_effort = "medium"',
      'model_reasoning_summary = "detailed"',
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
    // Without it, Codex's models send no reasoning summary to keep.
    await expect(
      start({ config: { model_reasoning_summary: null } }).startThread(
        SETTINGS,
      ),
    ).rejects.toThrow("model_reasoning_summary is null");
    // Codex would drop Rufi's tools without a word.
    await expect(
      start({ capabilities: { namespaceTools: false } }).startThread(SETTINGS),
    ).rejects.toThrow("the provider doesn't take Rufi's tools");
  });

  it.each(["initialize", "config/read", "thread/start"])(
    "gives up when Codex doesn't answer %s, and ends it",
    async (method) => {
      await expect(
        start(
          { hang: [method] },
          undefined,
          method === "initialize" ? { startMs: 1_000 } : {},
        ).startThread(SETTINGS),
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

/** The fake's first turn: its ids carry the run's tag, as Codex's are unique. */
const TURN_1 = expect.stringMatching(/^turn-1-/) as string;
/** The id of the turn that started on `thread`. */
const turnOf = (thread: string) => {
  const started = seen(thread).find((e) => e.type === "turnStarted");
  return started?.type === "turnStarted" ? started.turnId : "";
};

describe("a turn", () => {
  it("streams the reply, shows what the agent did, and ignores stray notifications", async () => {
    const thread = await ask(start(), "Hello");
    expect(await ended(thread)).toEqual({ status: "completed" });
    expect(seen(thread)).toEqual([
      { type: "turnStarted", turnId: TURN_1 },
      { type: "message", turnId: TURN_1, id: "m-Hello", text: "Hello" },
      { type: "text", turnId: TURN_1, itemId: "item-1", delta: "ok:" },
      { type: "text", turnId: TURN_1, itemId: "item-1", delta: "Hello" },
      {
        type: "activity",
        turnId: TURN_1,
        itemId: "item-ls",
        activity: "command",
        title: "Ran a command",
        detail: "ls",
        status: "done",
        // Everything Codex gave, as it came.
        details: {
          id: "item-ls",
          type: "commandExecution",
          command: "ls",
          commandActions: [],
          status: "completed",
          aggregatedOutput: "notes.txt\n",
          exitCode: 0,
          durationMs: 4,
        },
      },
      {
        type: "activity",
        turnId: TURN_1,
        itemId: "item-tp",
        activity: "other",
        title: "The AI did something Rufi can't display",
        detail: "teleport",
        status: "done",
        details: { id: "item-tp", type: "teleport" },
      },
      { type: "turnEnded", turnId: TURN_1, end: { status: "completed" } },
    ]);
    expect(diagnostics).toContainEqual({
      event: "codex.notification_ignored",
      method: "remoteControl/status/changed",
    });
    expect(
      diagnostics.some((d) => String(d.method).startsWith("brand/new")),
    ).toBe(true);
  });

  it("passes on the AI's reasoning summary as it streams, then whole with everything Codex gave", async () => {
    const thread = await ask(
      start({ reasoning: ["**Reading**", "The user said hello."] }),
      "Hello",
    );
    await ended(thread);
    // The thinking starts empty; a new summary part starts a new paragraph.
    expect(
      seen(thread)
        .filter((e) => e.type === "thinking")
        .map((e) => [e.itemId, e.delta]),
    ).toEqual([
      ["item-think", ""],
      ["item-think", "**Read"],
      ["item-think", "ing**"],
      ["item-think", "\n\nThe user s"],
      ["item-think", "aid hello."],
    ]);
    expect(seen(thread).filter((e) => e.type === "reasoning")).toEqual([
      {
        type: "reasoning",
        turnId: TURN_1,
        itemId: "item-think",
        summary: "**Reading**\n\nThe user said hello.",
        details: {
          id: "item-think",
          type: "reasoning",
          summary: ["**Reading**", "The user said hello."],
          content: [],
        },
      },
    ]);
  });

  it("shows a picture Codex generated as a picture line with its saved path whole, and keeps none of its bytes", async () => {
    const savedPath = join(
      home,
      "codex",
      "generated_images",
      "thread-1",
      `${"call_".repeat(80)}1.png`,
    );
    const thread = await ask(start({ picture: { savedPath } }), "Hello");
    await ended(thread);
    const lines = seen(thread).filter(
      (e) => e.type === "activity" && e.itemId === "item-pic",
    );
    expect(lines).toMatchObject([
      { activity: "picture", title: "Making a picture", status: "running" },
      {
        activity: "picture",
        title: "Made a picture",
        // Longer than a detail may be, and kept whole.
        detail: savedPath,
        status: "done",
        details: {
          type: "imageGeneration",
          savedPath,
          result: "(a generated picture, not kept)",
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain("iVBORw0KGgo");
  });

  it("says when a generated picture wasn't saved, or failed: nothing to show", () => {
    const item = {
      type: "imageGeneration" as const,
      id: "g",
      status: "completed",
      revisedPrompt: null,
      result: "",
      failure: null,
    };
    expect(activityOf(item, true)).toEqual({
      activity: "picture",
      title: "Made a picture Rufi couldn't keep",
      status: "done",
    });
    expect(activityOf({ ...item, status: "failed" }, true)).toEqual({
      activity: "picture",
      title: "Couldn't make a picture",
      status: "failed",
    });
  });

  it("starts a thread with the model, in the AI's folder under Rufi's profile, with Rufi's instructions and Rufi's MCP server with the thread's key", async () => {
    const tools = await mcpServer();
    await start({}, TOOLS).startThread({ ...SETTINGS, tools });
    expect(await sent("thread/start")).toEqual([
      {
        model: "gpt-6.1-sol",
        cwd: join(home, "ai"),
        approvalPolicy: "never",
        permissions: "rufi-ai",
        developerInstructions: "Be careful.",
        config: {
          mcp_servers: {
            rufi: {
              url: tools.url,
              http_headers: { Authorization: "Bearer key-1" },
              required: true,
              default_tools_approval_mode: "approve",
              startup_timeout_sec: 10,
              tool_timeout_sec: 11,
              tool_input_schema_max_bytes: 65_536,
            },
          },
        },
      },
    ]);
  });

  it("refuses a thread Codex runs under another permission profile than Rufi's", async () => {
    await expect(
      start({ profile: ":workspace" }).startThread(SETTINGS),
    ).rejects.toThrow(
      "Codex didn't take Rufi's thread settings: its permissions are :workspace.",
    );
  });

  it("says plainly when Rufi's tools didn't start for a thread", async () => {
    const tools = await mcpServer(401);
    await expect(
      start({}, TOOLS).startThread({ ...SETTINGS, tools }),
    ).rejects.toThrow(
      "Rufi's tools didn't start for the AI, so it can't reply now. Try again; if it keeps happening, restart Rufi.",
    );
  });

  it("starts a reply with Rufi's id, its parts in order and the effort", async () => {
    const agent = start();
    const { threadId } = await agent.startThread(SETTINGS);
    await agent.send(threadId, {
      id: "m-1",
      input: ["Earlier: hello", "Hi"],
      model: "gpt-6-astra",
      effort: "high",
    });
    await ended(threadId);
    expect(await sent("turn/start")).toEqual([
      {
        threadId,
        clientUserMessageId: "m-1",
        input: [
          { type: "text", text: "Earlier: hello", text_elements: [] },
          { type: "text", text: "Hi", text_elements: [] },
        ],
        model: "gpt-6-astra",
        effort: "high",
      },
    ]);
    expect(seen(threadId)).toContainEqual(
      expect.objectContaining({ type: "message", turnId: TURN_1, id: "m-1" }),
    );
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
        turnId: TURN_1,
        itemId: "item-last",
        delta: "Which person do you mean?",
      },
      {
        type: "question",
        turnId: TURN_1,
        itemId: "item-last",
        title: "Whose results?",
        options: ["Asha", "Ravi"],
      },
      {
        type: "question",
        turnId: TURN_1,
        itemId: "item-last",
        title: "Anything else?",
        options: [],
      },
    ]);
    // The streamed message isn't repeated when it completes.
    expect(last.filter((e) => e.type === "text")).toHaveLength(3);
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
    const thread = await ask(start({}, undefined, { turnMs: 300 }), "hang");
    expect(await ended(thread)).toEqual({
      status: "failed",
      reason: "timeout",
      text: "The reply took too long, so Rufi stopped it.",
    });
    expect(await sent("turn/interrupt")).toEqual([
      { threadId: thread, turnId: TURN_1 },
    ]);
  });

  it("declines approvals and refuses other requests, also a dynamic tool call", async () => {
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
        id: 1001,
        error: {
          code: -32601,
          message: "Rufi doesn't handle item/tool/call.",
        },
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

describe("starting a reply", () => {
  it("never starts a reply while one runs, so it never steers it by mistake", async () => {
    const agent = start();
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    await expect(
      agent.send(thread, { id: "m-2", input: ["second"] }),
    ).rejects.toBeInstanceOf(NotSent);
    expect(await sent("turn/start")).toHaveLength(1);
  });

  it("says when the message surely didn't reach Codex, and not when Codex didn't answer", async () => {
    const refusing = start({ threads: { "old-1": {} } });
    await refusing.resumeThread("old-1", SETTINGS);
    await expect(
      refusing.send("no-such-thread", { id: "m-1", input: ["Hi"] }),
    ).rejects.toBeInstanceOf(NotSent);
    await runtime?.close();
    const silent = start({ hang: ["turn/start"] });
    const { threadId } = await silent.startThread(SETTINGS);
    const sending = silent.send(threadId, { id: "m-2", input: ["Hi"] });
    await expect(sending).rejects.toThrow("didn't answer turn/start");
    await expect(sending).rejects.not.toBeInstanceOf(NotSent);
  });

  it("stops the reply Codex starts when Stop came while it was asked", async () => {
    const agent = start({ slow: ["turn/start"] });
    const { threadId } = await agent.startThread(SETTINGS);
    const op = new AbortController();
    const sending = agent.send(
      threadId,
      { id: "m-a", input: ["hang"] },
      op.signal,
    );
    await until(async () => (await sent("turn/start")).length === 1);
    op.abort();
    await expect(sending).rejects.toThrow("Stopped.");
    expect(await ended(threadId)).toMatchObject({ status: "interrupted" });
  });

  it("stops a reply Codex starts after its request timed out, when Stop came meanwhile", async () => {
    // Codex takes the request only after Rufi gave up waiting for it.
    const agent = start({ slow: ["turn/start"], slowMs: 1_500 });
    const { threadId } = await agent.startThread(SETTINGS);
    const op = new AbortController();
    const sending = agent.send(
      threadId,
      { id: "m-a", input: ["hang"] },
      op.signal,
    );
    await until(async () => (await sent("turn/start")).length === 1);
    op.abort();
    await expect(sending).rejects.toThrow("Stopped.");
    expect(await ended(threadId)).toMatchObject({ status: "interrupted" });
  });

  it("keeps the person's message when Stop came before Codex showed it", async () => {
    // Interrupted before it records the message, Codex would drop it.
    const agent = start({ userMessageMs: 100 });
    const { threadId } = await agent.startThread(SETTINGS);
    await agent.send(threadId, { id: "m-a", input: ["hang"] });
    await until(() => Promise.resolve(agent.running(threadId)));
    const stopping = agent.stop(threadId);
    await ended(threadId);
    await stopping;
    expect(seen(threadId).filter((e) => e.type === "message")).toMatchObject([
      { id: "m-a", text: "hang" },
    ]);
    expect(seen(threadId).filter((e) => e.type === "text")).toEqual([]);
    await expect(agent.startedMessages(threadId)).resolves.toEqual([
      { id: "m-a", text: "hang" },
    ]);
  });

  it("stops a reply only when it is the one asked for", async () => {
    const agent = start();
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    await agent.stop(thread, "an-earlier-turn");
    await sleep(100);
    expect(agent.running(thread)).toBe(true);
    await agent.stop(thread, turnOf(thread));
    expect(await ended(thread)).toMatchObject({ status: "interrupted" });
  });

  it("passes a steer into the running reply, with Rufi's id", async () => {
    const agent = start();
    const thread = await ask(agent, "slow");
    await until(() => Promise.resolve(agent.running(thread)));
    await expect(
      agent.steer(thread, { id: "s-1", text: "shorter" }),
    ).resolves.toEqual({
      turnId: TURN_1,
    });
    await ended(thread);
    expect(seen(thread)).toContainEqual({
      type: "message",
      turnId: TURN_1,
      id: "s-1",
      text: "shorter",
    });
    await expect(
      agent.steer(thread, { id: "s-2", text: "late" }),
    ).rejects.toBeInstanceOf(NotSent);
  });

  it("refuses a steer as not sent while the reply is stopping", async () => {
    const agent = start({ ignoreInterrupt: true }, undefined, GIVE_UP);
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    const stopping = agent.stop(thread);
    expect(agent.running(thread)).toBe(true);
    await expect(
      agent.steer(thread, { id: "s-1", text: "late" }),
    ).rejects.toBeInstanceOf(NotSent);
    await stopping;
  });

  it("lists the messages a thread ran, with Rufi's ids", async () => {
    const agent = start();
    const thread = await ask(agent, "first");
    await ended(thread);
    await agent.send(thread, { id: "m-2", input: ["second"] });
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

  it("resumes a thread with the settings", async () => {
    const agent = start({ threads: { "old-1": {} } });
    await expect(agent.resumeThread("old-1", SETTINGS)).resolves.toEqual({
      model: "gpt-6.1-sol",
      running: false,
    });
    expect(await sent("thread/resume")).toEqual([
      {
        threadId: "old-1",
        excludeTurns: true,
        model: "gpt-6.1-sol",
        cwd: join(home, "ai"),
        approvalPolicy: "never",
        permissions: "rufi-ai",
        developerInstructions: "Be careful.",
      },
    ]);
  });

  it("gives an open thread new instructions: lets it go, picks it up with them, then has it summarised, showing nothing of the summary", async () => {
    const agent = start();
    const { threadId } = await agent.startThread(SETTINGS);
    await expect(
      agent.reloadThread(threadId, { ...SETTINGS, instructions: "Be kind." }),
    ).resolves.toEqual({ model: "gpt-6.1-sol" });
    expect(
      (await entries()).flatMap((entry) => {
        const method = entry.received?.method;
        return method?.startsWith("thread/") ? [method] : [];
      }),
    ).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/resume",
      "thread/compact/start",
    ]);
    expect(await sent("thread/resume")).toMatchObject([
      { threadId, developerInstructions: "Be kind." },
    ]);
    expect(seen(threadId)).toEqual([]);
    expect(agent.loaded(threadId)).toBe(true);
    // The next reply runs with them.
    await agent.send(threadId, { id: "m-1", input: ["Hi"] });
    await ended(threadId);
    expect((await entries()).filter((entry) => entry.turn)).toMatchObject([
      { told: "Be kind." },
    ]);
  });

  it("says the thread didn't take its new instructions when its summary fails", async () => {
    const agent = start({ compactFails: true });
    const { threadId } = await agent.startThread(SETTINGS);
    await expect(
      agent.reloadThread(threadId, { ...SETTINGS, instructions: "Be kind." }),
    ).rejects.toThrow(NotReloaded);
    expect(seen(threadId)).toEqual([]);
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
    // Ended, but the system may take a moment to clear them.
    await until(() =>
      Promise.resolve(
        [programs?.command, programs?.child].every(
          (pid) => pid === undefined || !isRunning(pid),
        ),
      ),
    );
    expect((await pids()).filter(isRunning)).toHaveLength(1);
  });

  it("ends Codex when it can't clean up after an interrupt", async () => {
    const agent = start(
      { hang: ["thread/backgroundTerminals/clean"] },
      undefined,
      GIVE_UP,
    );
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
    const agent = start({ ignoreInterrupt: true }, undefined, GIVE_UP);
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

  async function runCommand(
    scenario: Scenario,
    deadlines?: Partial<Deadlines>,
  ) {
    const agent = start(scenario, undefined, deadlines);
    const thread = await ask(agent, "command");
    await until(async () => (await entries()).some((entry) => entry.child));
    // The process shows up in the fake's log before Rufi hears of the turn
    // on stdout; Stop needs the turn.
    await until(() =>
      Promise.resolve(
        seen(thread).some(
          (event) => event.type === "activity" && event.activity === "command",
        ),
      ),
    );
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
    const { agent, thread, programs } = await runCommand(
      { clean: "never" },
      GIVE_UP,
    );
    await agent.stop(thread);
    expect([...programs, ...(await pids())].filter(isRunning)).toEqual([]);
  });

  it("stops a turn once, however often Stop is pressed", async () => {
    const { agent, thread } = await runCommand({});
    await Promise.all([agent.stop(thread), agent.stop(thread)]);
    expect(await sent("turn/interrupt")).toHaveLength(1);
    expect(await sent("thread/backgroundTerminals/clean")).toHaveLength(1);
  });

  it("ends the commands Codex left when it crashes", async () => {
    const { thread, programs } = await runCommand({});
    // Rufi notes the command's process group as it starts; nothing shows when
    // that is done, so this one waits a fixed time.
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
        turnId: TURN_1,
        itemId: "item-cmd",
        activity: "command",
        title: "Ran a command",
        detail: "sleep 301",
        status: "running",
        // What Codex gave as it started; the end would replace it.
        details: {
          id: "item-cmd",
          type: "commandExecution",
          command: "sleep 301",
          commandActions: [],
          status: "inProgress",
        },
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
      { id: "m-1", input: ["Hello"] },
      op.signal,
    );
    await until(() => Promise.resolve(asked.length === 2));
    op.abort();
    gate.resolve(undefined);
    await expect(sending).rejects.toThrow("Stopped.");
    expect(await sent("turn/start")).toEqual([]);
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
    // Well before initialize's own deadline (startMs, 10 s here).
    expect(Date.now() - began).toBeLessThan(500);
    await agent.close();
    expect((await pids()).filter(isRunning)).toEqual([]);
  });

  it("waits for a sign-in renewal to be saved before it ends, but not for ever", async () => {
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
      // An agent that never stops is given up after five minutes.
      const never = new Promise<never>(() => undefined);
      const stuck = Effect.runFork(
        agentCall(
          () => never,
          () => never,
        ),
      );
      let gaveUp = false;
      void Effect.runPromise(Fiber.interrupt(stuck)).then(() => {
        gaveUp = true;
      });
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(gaveUp).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(gaveUp).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
    await agent.send(thread, { id: "m-2", input: ["second"] });
    await ended(thread, 2);
    expect(await pids()).toHaveLength(1);
  });

  it("gives a resumed thread Rufi's MCP server again (Codex keeps none)", async () => {
    const tools = await mcpServer();
    const agent = start({ threads: { "old-1": {} } }, TOOLS);
    await agent.resumeThread("old-1", { ...SETTINGS, tools });
    const [resumed] = await sent("thread/resume");
    expect(resumed).toMatchObject({
      developerInstructions: "Be careful.",
      config: { mcp_servers: { rufi: { url: tools.url } } },
    });
  });
});

describe("the reply Rufi's tools are for", () => {
  it("is the running reply's turn, and none once Stop is pressed or it ended", async () => {
    const agent = start({ ignoreInterrupt: true }, undefined, GIVE_UP);
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    const started = seen(thread).find((e) => e.type === "turnStarted");
    expect(agent.activeTurn(thread)).toBe(
      started?.type === "turnStarted" ? started.turnId : "none",
    );
    const stopping = agent.stop(thread);
    // From the moment Stop is pressed, before Codex has stopped it.
    expect(agent.running(thread)).toBe(true);
    expect(agent.activeTurn(thread)).toBeUndefined();
    await stopping;
    await ended(thread);
    expect(agent.activeTurn(thread)).toBeUndefined();
  });

  it("ends a reply Rufi stops with the reason Rufi gives", async () => {
    const agent = start();
    const thread = await ask(agent, "hang");
    await until(() => Promise.resolve(agent.running(thread)));
    await agent.stop(thread, undefined, {
      status: "failed",
      text: "The AI kept making requests Rufi couldn't accept.",
    });
    expect(await ended(thread)).toEqual({
      status: "failed",
      text: "The AI kept making requests Rufi couldn't accept.",
    });
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

  it("shows a command quietly only when it does nothing but read Rufi's skills", () => {
    const skills = ["/data/codex/skills", "/private/data/codex/skills"];
    const ran = (...commandActions: CommandAction[]) =>
      activityOf(
        {
          type: "commandExecution",
          id: "c",
          command: "the command as it ran",
          cwd: "/data/codex/skills/results",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions,
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 1,
        } as ThreadItem,
        true,
        undefined,
        skills,
      )?.title;
    const unknown = (command: string): CommandAction => ({
      type: "unknown",
      command,
    });
    const read = (path: string): CommandAction => ({
      type: "read",
      command: `cat ${path}`,
      name: "SKILL.md",
      path,
    });
    // By either path, relative to where it ran, each named once.
    expect(
      ran(
        read("SKILL.md"),
        read("/private/data/codex/skills/follow-ups/SKILL.md"),
        unknown(
          `cat '/data/codex/skills/results/SKILL.md' "/data/codex/skills/visit-brief/SKILL.md"`,
        ),
      ),
    ).toBe("Read Rufi's instructions: results, follow ups and visit brief");
    for (const other of [
      [read("/data/codex/skills/../core.json")],
      [read("/data/ai/SKILL.md")],
      [read("SKILL.md"), { type: "listFiles", command: "ls", path: null }],
      [
        unknown(
          "cat /data/codex/skills/results/SKILL.md > /data/codex/skills/research/SKILL.md",
        ),
      ],
      [unknown('cat "/data/codex/skills/$(id)/SKILL.md"')],
      [unknown("cat /data/codex/skills/results/SKILL.md;rm x")],
      [unknown("cp /data/codex/skills/results/SKILL.md x")],
      [],
    ] satisfies CommandAction[][]) {
      expect(ran(...other)).toBe("Ran a command");
    }
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
    // A page the AI opened is named by its address.
    expect(
      activityOf(
        {
          type: "webSearch",
          id: "p",
          query: "open https://example.org/hba1c",
          action: { type: "openPage", url: "https://example.org/hba1c" },
          results: null,
        },
        true,
      ),
    ).toEqual({
      activity: "web_search",
      title: "Opened a web page",
      detail: "https://example.org/hba1c",
      status: "done",
    });
    expect(activityOf({ type: "contextCompaction", id: "c" }, false)).toEqual({
      activity: "compaction",
      title: "Compacted its memory of the chat",
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

  it("says what Rufi's own tool did in its own words, with no detail; another tool gets its arguments", () => {
    const call = (server: string, args: unknown) =>
      activityOf(
        {
          type: "mcpToolCall",
          id: "t",
          server,
          tool: "save_changes",
          arguments: args,
          status: "completed",
          result: null,
          error: null,
          durationMs: 1,
        } as never,
        true,
        {
          server: "rufi",
          specs: [{ name: "save_changes", shown: () => "Save to your record" }],
        },
      );
    const changes = { changes: [{ kind: "symptom", action: "add" }] };
    expect(call("rufi", changes)).toEqual({
      activity: "tool",
      title: "Save to your record",
      status: "done",
    });
    expect(call("other", changes)).toEqual({
      activity: "tool",
      title: "Used a tool",
      detail: '{"changes":[{"kind":"symptom","action":"add"}]}',
      status: "done",
    });
    expect(call("other", {})).toEqual({
      activity: "tool",
      title: "Used a tool",
      status: "done",
    });
  });

  it("keeps an activity's detail to one short line", () => {
    const line = activityOf(
      {
        type: "commandExecution",
        id: "c",
        command: `echo ${"x".repeat(400)}\nls`,
        commandActions: [],
        status: "completed",
      } as never,
      true,
    );
    expect(line?.detail).toHaveLength(300);
    expect(line?.detail).not.toContain("\n");
  });
});

async function until(ready: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 4_000;
  while (!(await ready().catch(() => false))) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(10);
  }
}
