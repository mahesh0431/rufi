import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Scenario } from "../../../tests/fake-codex.ts";
import { childEnvironment } from "../../platform/config.ts";
import type {
  AgentRuntime,
  AgentTools,
  ToolAnswer,
  TurnEvent,
} from "../runtime.ts";
import { checkExecutable } from "./binary.ts";
import { codexRuntime, describe as describeItem, resultOf } from "./codex.ts";
import { isRunning } from "./processes.ts";

const FAKE = join(import.meta.dirname, "../../../tests/fake-codex.ts");

let home: string;
let log: string;
let token: string;
let asked: number[];
let diagnostics: string[];
let runtime: AgentRuntime | undefined;
/** While set, token requests wait for it. */
let tokenGate: Promise<void> | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-codex-"));
  log = join(home, "fake.jsonl");
  token = "token-1";
  asked = [];
  diagnostics = [];
  tokenGate = undefined;
});
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

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
    log: (line) => diagnostics.push(line),
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

async function collect(
  agent: AgentRuntime,
): Promise<{ events: TurnEvent[]; result: unknown }> {
  const events: TurnEvent[] = [];
  const thread = await agent.open();
  const result = await agent.turn(thread, "How are you?", (event) =>
    events.push(event),
  );
  return { events, result };
}

describe("starting Codex", () => {
  it("runs app-server as OpenAI documents, with only the environment Rufi gives it", async () => {
    await start().open();
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
    await start().open();
    expect(asked).toEqual([3_000 + 5 * 60_000]);
  });

  it("refuses Codex when it didn't take Rufi's settings, and stops it", async () => {
    await expect(
      start({ features: { daemon_auto_start: true } }).open(),
    ).rejects.toThrow(
      "Codex didn't take Rufi's settings: daemon_auto_start is on.",
    );
    expect((await pids()).filter(isRunning)).toEqual([]);
    await expect(
      start({ config: { model_reasoning_effort: "high" } }).open(),
    ).rejects.toThrow("model_reasoning_effort is high");
    // Codex would drop Rufi's tools without a word.
    await expect(
      start({ capabilities: { namespaceTools: false } }).open(),
    ).rejects.toThrow("the provider doesn't take Rufi's tools");
  });

  it.each(["initialize", "config/read", "thread/start"])(
    "gives up when Codex doesn't answer %s, and ends it",
    async (method) => {
      await expect(start({ hang: [method] }).open()).rejects.toThrow(
        `didn't answer ${method} within 1 s`,
      );
      expect((await pids()).filter(isRunning)).toEqual([]);
    },
  );
});

describe("a turn", () => {
  it("streams the reply, shows what the agent did, and ignores stray notifications", async () => {
    const { events, result } = await collect(start());
    expect(events).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "activity", text: "ran: ls" },
      { type: "unknown", what: "teleport" },
    ]);
    expect(result).toEqual({ status: "completed" });
    expect(diagnostics).toContain(
      "ignored notification remoteControl/status/changed",
    );
    expect(diagnostics.some((line) => line.includes("brand/new"))).toBe(true);
  });

  it("sends the whole full-access setting with every turn", async () => {
    await collect(start());
    expect(await sent("thread/start")).toEqual([
      {
        cwd: join(home, "workspace"),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    ]);
    expect(await sent("turn/start")).toEqual([
      {
        threadId: "thread-1",
        input: [{ type: "text", text: "How are you?", text_elements: [] }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        effort: "low",
      },
    ]);
  });

  it("ignores events from an earlier turn on the same thread", async () => {
    const { events, result } = await collect(start({ stale: true }));
    expect(events).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "activity", text: "ran: ls" },
      { type: "unknown", what: "teleport" },
    ]);
    expect(result).toEqual({ status: "completed" });
  });

  it("keeps the turn's events that arrive before Codex acknowledges it", async () => {
    const { events, result } = await collect(start({ early: true }));
    expect(events).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "activity", text: "ran: ls" },
      { type: "unknown", what: "teleport" },
    ]);
    expect(result).toEqual({ status: "completed" });
  });

  it("shows a message that didn't stream, and the AI's questions for the user", async () => {
    const { events } = await collect(
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
    expect(events.slice(-3)).toEqual([
      { type: "text", delta: "Which person do you mean?" },
      { type: "question", title: "Whose results?", options: ["Asha", "Ravi"] },
      { type: "question", title: "Anything else?", options: [] },
    ]);
    // The streamed message isn't repeated when it completes.
    expect(events.filter((e) => e.type === "text")).toHaveLength(3);
  });

  it("reports a failed turn as failed, in plain words", async () => {
    const { result } = await collect(start({ turn: "fail" }));
    expect(result).toEqual({
      status: "failed",
      reason: "Your ChatGPT plan's usage limit has been reached.",
    });
  });

  it("fails the turn when Codex doesn't acknowledge it", async () => {
    const { result } = await collect(start({ hang: ["turn/start"] }));
    expect(result).toEqual({
      status: "failed",
      reason:
        "Codex didn't start the turn: Codex didn't answer turn/start within 1 s.",
    });
  });

  it("stops a turn that runs past its deadline", async () => {
    const { result } = await collect(start({ turn: "hang" }));
    expect(result).toEqual({
      status: "failed",
      reason: "The turn took too long, so Rufi stopped it.",
    });
    expect(await sent("turn/interrupt")).toEqual([
      { threadId: "thread-1", turnId: "turn-1" },
    ]);
  });

  it("declines approvals, answers a tool call that isn't this turn's, and refuses other requests", async () => {
    await collect(
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

describe("Stop", () => {
  it("interrupts the turn", async () => {
    const agent = start({ turn: "hang" });
    const thread = await agent.open();
    const turn = agent.turn(thread, "Long task", () => undefined);
    await until(async () => (await sent("turn/start")).length > 0);
    await agent.stop();
    await expect(turn).resolves.toEqual({
      status: "interrupted",
      reason: "Stopped.",
    });
  });

  it("ends the commands an interrupted turn left running, and keeps Codex", async () => {
    const agent = start({ turn: "command" });
    const thread = await agent.open();
    const turn = agent.turn(thread, "Run something long", () => undefined);
    await until(async () => (await entries()).some((entry) => entry.child));
    const programs = (await entries()).find((entry) => entry.child);
    await agent.stop();
    await expect(turn).resolves.toEqual({
      status: "interrupted",
      reason: "Stopped.",
    });
    expect(await sent("thread/backgroundTerminals/clean")).toEqual([
      { threadId: "thread-1" },
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
    const agent = start({
      turn: "command",
      hang: ["thread/backgroundTerminals/clean"],
    });
    const thread = await agent.open();
    const turn = agent.turn(thread, "Run something long", () => undefined);
    await until(async () => (await entries()).some((entry) => entry.child));
    const programs = (await entries()).find((entry) => entry.child);
    await agent.stop();
    await turn;
    const all = [...(await pids()), programs?.command, programs?.child];
    expect(all.filter((pid) => pid !== undefined && isRunning(pid))).toEqual(
      [],
    );
  });

  it("ends Codex and the programs it started when the interrupt is ignored", async () => {
    const agent = start({ turn: "command", ignoreInterrupt: true });
    const thread = await agent.open();
    const turn = agent.turn(thread, "Run something long", () => undefined);
    await until(async () => (await entries()).some((entry) => entry.child));
    const programs = (await entries()).find((entry) => entry.child);
    await agent.stop();
    await expect(turn).resolves.toEqual({
      status: "interrupted",
      reason: "Codex didn't stop when asked, so Rufi ended it.",
    });
    const all = [...(await pids()), programs?.command, programs?.child];
    expect(all.filter((pid) => pid !== undefined && isRunning(pid))).toEqual(
      [],
    );
  });
});

describe("Stop, more cases", () => {
  async function runCommand(scenario: Scenario) {
    const agent = start({ turn: "command", ...scenario });
    const thread = await agent.open();
    const events: TurnEvent[] = [];
    const turn = agent.turn(thread, "Run something long", (event) =>
      events.push(event),
    );
    await until(async () => (await entries()).some((entry) => entry.child));
    const found = (await entries()).find((entry) => entry.child);
    const programs = [found?.command, found?.child].filter(
      (pid): pid is number => pid !== undefined,
    );
    return { agent, turn, events, programs };
  }

  it("waits until Codex has really ended the commands, not just queued it", async () => {
    const { agent, turn, programs } = await runCommand({ clean: "later" });
    void agent.stop();
    // The turn returns only once Stop has finished.
    await expect(turn).resolves.toMatchObject({ status: "interrupted" });
    expect(programs.filter(isRunning)).toEqual([]);
    expect((await pids()).filter(isRunning)).toHaveLength(1);
  });

  it("ends Codex when it queues the clean-up but never does it", async () => {
    const { agent, turn, programs } = await runCommand({ clean: "never" });
    void agent.stop();
    await turn;
    expect([...programs, ...(await pids())].filter(isRunning)).toEqual([]);
  });

  it("stops a turn once, however often Stop is pressed", async () => {
    const { agent, turn } = await runCommand({});
    await Promise.all([agent.stop(), agent.stop()]);
    await turn;
    expect(await sent("turn/interrupt")).toHaveLength(1);
    expect(await sent("thread/backgroundTerminals/clean")).toHaveLength(1);
  });

  it("ends the commands Codex left when it crashes", async () => {
    const { turn, events, programs } = await runCommand({});
    // Shown as it starts, and before Rufi's regular look at the processes.
    await until(() => Promise.resolve(events.length > 0));
    await sleep(200);
    const [codex] = await pids();
    if (codex !== undefined) process.kill(codex, "SIGKILL");
    await expect(turn).resolves.toEqual({
      status: "failed",
      reason: "Codex stopped unexpectedly.",
    });
    expect(programs.filter(isRunning)).toEqual([]);
  });

  it("shows a command when it starts, once, even when it's stopped", async () => {
    const { agent, turn, events } = await runCommand({});
    await agent.stop();
    await turn;
    expect(events).toEqual([{ type: "activity", text: "ran: sleep 301" }]);
  });

  it("cancels an open that is still getting a token", async () => {
    const gate = Promise.withResolvers<undefined>();
    tokenGate = gate.promise;
    const agent = start();
    const opening = agent.open();
    await sleep(50);
    await agent.stop();
    gate.resolve(undefined);
    await expect(opening).rejects.toThrow("Stopped.");
    expect(await pids()).toEqual([]);
  });

  it("cancels an open while Codex is starting, and ends it", async () => {
    const agent = start({ slow: ["initialize"] });
    const opening = agent.open();
    await until(async () => (await pids()).length > 0);
    await agent.stop();
    await expect(opening).rejects.toThrow("Stopped.");
    expect(await sent("thread/start")).toEqual([]);
    expect((await pids()).filter(isRunning)).toEqual([]);
  });

  it("cancels a turn that is still getting a token, and sends nothing", async () => {
    const agent = start();
    const thread = await agent.open();
    const gate = Promise.withResolvers<undefined>();
    tokenGate = gate.promise;
    const turn = agent.turn(thread, "Hello", () => undefined);
    await sleep(50);
    await agent.stop();
    gate.resolve(undefined);
    await expect(turn).resolves.toEqual({
      status: "interrupted",
      reason: "Stopped.",
    });
    expect(await sent("turn/start")).toEqual([]);
  });
});

describe("closing", () => {
  it("ends a running turn at once, with Codex and its programs", async () => {
    const agent = start({ turn: "command", ignoreInterrupt: true });
    const thread = await agent.open();
    const turn = agent.turn(thread, "Run something long", () => undefined);
    await until(async () => (await entries()).some((entry) => entry.child));
    const programs = (await entries()).find((entry) => entry.child);
    await agent.close();
    await expect(turn).resolves.toEqual({
      status: "interrupted",
      reason: "Rufi closed Codex.",
    });
    const all = [...(await pids()), programs?.command, programs?.child];
    expect(all.filter((pid) => pid !== undefined && isRunning(pid))).toEqual(
      [],
    );
  });
});

describe("token renewal", () => {
  it("restarts Codex with the new token and resumes the thread", async () => {
    const agent = start();
    const thread = await agent.open();
    await agent.turn(thread, "First", () => undefined);
    token = "token-2";
    await agent.turn(thread, "Second", () => undefined);

    const starts = (await entries()).filter((entry) => entry.started);
    expect(starts.map((entry) => entry.token)).toEqual(["token-1", "token-2"]);
    expect(await sent("thread/resume")).toEqual([
      {
        threadId: "thread-1",
        excludeTurns: true,
        cwd: join(home, "workspace"),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    ]);
    expect((await pids()).slice(0, 1).filter(isRunning)).toEqual([]);
  });

  it("keeps the same Codex while the token is the same", async () => {
    const agent = start();
    const thread = await agent.open();
    await agent.turn(thread, "First", () => undefined);
    await agent.turn(thread, "Second", () => undefined);
    expect(await pids()).toHaveLength(1);
  });
});

describe("Rufi's tools", () => {
  /** Tools for the adapter: what each call got, and what it answers. */
  function fakeTools(
    run: (name: string, input: unknown) => Promise<ToolAnswer> | ToolAnswer,
  ): AgentTools & { calls: [string, unknown][] } {
    const calls: [string, unknown][] = [];
    return {
      calls,
      namespace: "rufi",
      specs: [
        {
          name: "get_overview",
          description: "The record at a glance.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      instructions: "Use the rufi tools.",
      forTurn: () => async (name, input) => {
        calls.push([name, input]);
        return run(name, input);
      },
    };
  }
  const overview = { namespace: "rufi", tool: "get_overview", arguments: {} };
  const replies = async () =>
    (await entries())
      .filter((entry) => entry.answered === "item/tool/call")
      .map((entry) => entry.reply);

  it("gives Codex the tools and their instructions when a thread starts", async () => {
    await collect(
      start(
        {},
        fakeTools(() => ({ ok: true, text: "{}" })),
      ),
    );
    expect(await sent("thread/start")).toEqual([
      {
        cwd: join(home, "workspace"),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        developerInstructions: "Use the rufi tools.",
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

  it("runs a call, answers with its result, and shows it once", async () => {
    const tools = fakeTools(() => ({ ok: true, text: '{"ok":true}' }));
    const { events, result } = await collect(
      start({ calls: [overview] }, tools),
    );
    expect(tools.calls).toEqual([["get_overview", {}]]);
    expect(await replies()).toEqual([
      {
        contentItems: [{ type: "inputText", text: '{"ok":true}' }],
        success: true,
      },
    ]);
    expect(events.filter((e) => e.type === "activity")).toEqual([
      { type: "activity", text: "used rufi.get_overview" },
      { type: "activity", text: "ran: ls" },
    ]);
    expect(result).toEqual({ status: "completed" });
  });

  it("passes a call outside Rufi's namespace on as an unknown tool, never an RPC error", async () => {
    const tools = fakeTools((name) => ({
      ok: false,
      text: JSON.stringify({ ok: false, error: `no ${name}` }),
    }));
    await collect(
      start({ calls: [{ ...overview, namespace: "other" }] }, tools),
    );
    expect(tools.calls).toEqual([["other.get_overview", {}]]);
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
    const tools = fakeTools(async () => {
      await sleep(2_000);
      return { ok: true, text: "late" };
    });
    const begun = Date.now();
    const { result } = await collect(start({ calls: [overview] }, tools));
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
    expect(result).toEqual({ status: "completed" });
  });

  it("stops the turn when the tools say so", async () => {
    const tools = fakeTools(() => ({
      ok: false,
      text: "{}",
      stopTurn: "The AI kept making requests Rufi couldn't accept.",
    }));
    const { result } = await collect(
      start({ calls: [overview], turn: "hang" }, tools),
    );
    expect(result).toEqual({
      status: "failed",
      reason: "The AI kept making requests Rufi couldn't accept.",
    });
    expect(await sent("turn/interrupt")).toHaveLength(1);
  });

  it("gives no tools again when a thread is resumed (Codex keeps them)", async () => {
    const tools = fakeTools(() => ({ ok: true, text: "{}" }));
    const agent = start({}, tools);
    const thread = await agent.open();
    token = "token-2";
    await agent.turn(thread, "Again", () => undefined);
    const [resumed] = await sent("thread/resume");
    expect(resumed).toMatchObject({
      developerInstructions: "Use the rufi tools.",
    });
    expect(resumed).not.toHaveProperty("dynamicTools");
  });
});

describe("protocol details", () => {
  it("counts only `completed` as success", () => {
    expect(resultOf({ status: "completed", error: null })).toEqual({
      status: "completed",
    });
    expect(resultOf({ status: "inProgress", error: null }).status).toBe(
      "failed",
    );
  });

  it("describes items, and marks one it doesn't know", () => {
    expect(
      describeItem({
        type: "webSearch",
        id: "w",
        query: "HbA1c",
        action: null,
        results: null,
      }),
    ).toEqual({ type: "activity", text: "searched the web: HbA1c" });
    expect(describeItem({ type: "contextCompaction", id: "c" })).toEqual({
      type: "activity",
      text: "condensed the earlier conversation",
    });
  });
});

async function until(ready: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await ready().catch(() => false)); i++) {
    await sleep(10);
  }
}
