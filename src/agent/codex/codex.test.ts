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

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-codex-"));
  log = join(home, "fake.jsonl");
  token = "token-1";
  asked = [];
  diagnostics = [];
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
    token: (validForMs) => {
      asked.push(validForMs);
      return Promise.resolve(token);
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
  (await readFile(log, "utf8"))
    .trim()
    .split("\n")
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
      'web_search = "live"',
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
      start({ config: { web_search: "cached" } }).open(),
    ).rejects.toThrow("web_search is cached");
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
    expect(diagnostics).toContain(
      "ignored notification brand/new/notification",
    );
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
