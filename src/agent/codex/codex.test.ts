import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Scenario } from "../../../tests/fake-codex.ts";
import { childEnvironment } from "../../platform/config.ts";
import type { AgentRuntime, TurnEvent } from "../runtime.ts";
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

function start(scenario: Scenario = {}): AgentRuntime {
  runtime = codexRuntime({
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

  it("declines approvals, answers unknown tools, and refuses other requests", async () => {
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
          { type: "inputText", text: "Unknown tool: read_record" },
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
    await agent.stop();
    expect(programs.filter(isRunning)).toEqual([]);
    expect((await pids()).filter(isRunning)).toHaveLength(1);
    await expect(turn).resolves.toMatchObject({ status: "interrupted" });
  });

  it("ends Codex when it queues the clean-up but never does it", async () => {
    const { agent, turn, programs } = await runCommand({ clean: "never" });
    await agent.stop();
    await turn;
    expect([...programs, ...(await pids())].filter(isRunning)).toEqual([]);
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
