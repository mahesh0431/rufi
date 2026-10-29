// The Codex adapter meets the provider boundary, on the scripted Codex
// (tests/fake-codex.ts) as the pinned protocol has it.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANSWER, providerContract, type Script } from "@rufi/agents/contract";
import type { ProviderEvent } from "@rufi/agents/provider";
import { afterEach, expect, it } from "vitest";
import type { Scenario } from "../../../tests/fake-codex.ts";
import { codexMeta } from "../../../tests/mcp-client.ts";
import { ChatGptError } from "../chatgpt/openai.ts";
import { codexAdapter } from "./adapter.ts";

const FAKE = join(import.meta.dirname, "../../../tests/fake-codex.ts");
/** Longer than Rufi waits for Codex's answer: the answer is lost. */
const LOST_MS = 2_500;

/** A stand-in for Rufi's MCP server that takes a thread's session. */
async function mcpServer(): Promise<{
  tools: { url: string; key: string };
  close: () => Promise<void>;
}> {
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    tools: { url: `http://127.0.0.1:${String(port)}/mcp`, key: "key-1" },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** What every turn does, as the words of its message choose it. */
const WORDS: Record<NonNullable<Script["turn"]>, string | undefined> = {
  answers: undefined,
  runs: "hang",
  fails: "fail",
  usage_limit: "fail",
  dies: "crash",
  silent: undefined,
  renews: undefined,
  renewal_fails: undefined,
};

/** The scripted Codex that behaves as `script` says. */
function scenarioOf(script: Script): Scenario {
  const lost = (method: string) => ({ answerLate: [method], slowMs: LOST_MS });
  const words = WORDS[script.turn ?? "answers"];
  return {
    // The last answer of every turn that completes.
    unstreamed: { text: ANSWER },
    ...(words !== undefined && { words }),
    ...(script.turn === "fails" && {
      failInfo: null,
      failMessage: "The fictional model couldn't answer.",
    }),
    ...(script.turn === "usage_limit" && {
      resetsAt: Math.floor(Date.now() / 1000) + 3_600,
    }),
    ...(script.resumeFails && { resumeFails: 1 }),
    ...(script.start === "refuses" && { refuse: ["turn/start"] }),
    ...(script.start === "loses_reply" && lost("turn/start")),
    ...(script.steer === "loses_reply" && lost("turn/steer")),
    ...(script.ignoresInterrupt && { ignoreInterrupt: true }),
    ...(script.picture !== undefined && {
      picture: { savedPath: null, bytes: script.picture },
    }),
  };
}

async function setUp(script: Script, scenario = scenarioOf(script)) {
  const home = await mkdtemp(join(tmpdir(), "rufi-adapter-"));
  const mcp = await mcpServer();
  const adapter = codexAdapter({
    home,
    sandbox: { folder: join(home, "ai"), unreadable: [] },
    skills: [],
    command: { file: process.execPath, args: [FAKE] },
    env: {
      PATH: process.env["PATH"] ?? "",
      FAKE_CODEX: JSON.stringify(scenario),
      FAKE_CODEX_LOG: join(home, "fake.jsonl"),
    },
    token: () =>
      script.signedIn === false
        ? Promise.reject(new ChatGptError("not_signed_in", "Not signed in."))
        : Promise.resolve("token-1"),
    version: "9.9.9",
    deadlines: {
      startMs: 10_000,
      requestMs: 1_000,
      turnMs: 20_000,
      ...(script.ignoresInterrupt
        ? { interruptAckMs: 300, interruptEndMs: 300 }
        : { interruptAckMs: 1_000, interruptEndMs: 1_000 }),
      answerMs: 500,
      toolMs: 200,
    },
  });
  return {
    adapter,
    options: {
      cwd: join(home, "ai"),
      model: "gpt-6.1-sol",
      effort: "medium",
      tools: mcp.tools,
    },
    close: mcp.close,
  };
}

providerContract("Codex", {
  setUp: (script) => setUp(script),
  callMeta: (conversation, turn, call) =>
    Promise.resolve(
      codexMeta({ callId: call, threadId: conversation.ref, turnId: turn }),
    ),
  cannot: {
    heldSteer: "Codex takes a steer at once or refuses it",
    heldPastEnd: "Codex takes a steer at once or refuses it",
    lostCancel: "Codex takes a steer at once or refuses it",
    nextTurn: "Codex never starts a turn by itself",
  },
  pending: {
    renews: "Codex asks Rufi for a renewed token during a turn",
    renewalFails: "Codex asks Rufi for a renewed token during a turn",
    noLimit: "the turn's time limit goes",
  },
});

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

it("reports Codex's usage limits as it last gave them", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
  const { adapter, options, close } = await setUp(
    { turn: "usage_limit" },
    { words: "fail", resetsAt },
  );
  closing.push(close, () => adapter.close());
  const events: ProviderEvent[] = [];
  const conversation = await adapter.open({
    ...options,
    instructions: "Answer briefly.",
    onEvent: (event) => events.push(event),
  });
  await conversation.startTurn({
    input: { id: "message-1", parts: ["What was Asha's last TSH?"] },
    model: options.model,
    effort: options.effort,
  });
  await expect
    .poll(() => events.some((event) => event.type === "turnEnded"))
    .toBe(true);
  expect(await adapter.usage()).toEqual([
    {
      minutes: 300,
      usedPercent: 100,
      resetsAt: new Date(resetsAt * 1000).toISOString(),
    },
  ]);
});
