// Rufi's MCP endpoints over real HTTP, as the pinned Codex talks to them: who
// gets in, what a key opens, and the shape of answers. What a chat call may
// do is chat.test.ts's; the real Codex against them is capture.test.ts's.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  callTool,
  codexMeta,
  initialize,
  listResources,
  listTools,
  readResource,
  type McpServerConfig,
} from "../../tests/mcp-client.ts";
import { SKILLS } from "../core/skills/skills.ts";
import type { ToolAnswer, ToolSpec } from "../core/tools/registry.ts";
import {
  mcpEndpoint,
  mcpKeys,
  serveMcp,
  skillResources,
  type McpCall,
} from "./mcp.ts";

const OVERVIEW: ToolSpec = {
  name: "get_overview",
  description: "The record at a glance.",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
  destructive: false,
};
const SAVE: ToolSpec = {
  ...OVERVIEW,
  name: "save_changes",
  description: "Saves changes.",
  readOnly: false,
};

let calls: McpCall[];
let answer: (call: McpCall) => Promise<ToolAnswer>;
let refused: string[];
let chatKeys: ReturnType<typeof mcpKeys>;
let served: { port: number; close: () => Promise<void> };
let working: Set<Promise<unknown>>;

beforeEach(async () => {
  calls = [];
  refused = [];
  answer = () => Promise.resolve({ ok: true, text: '{"ok":true}' });
  chatKeys = mcpKeys();
  working = new Set();
  let port = 0;
  const log = (event: string, fields?: { reason?: unknown }) => {
    if (event === "mcp.refused") refused.push(String(fields?.reason));
  };
  const chat = mcpEndpoint({
    keys: chatKeys,
    port: () => port,
    log,
    toolMs: 300,
    working,
  });
  served = await serveMcp(chat);
  port = served.port;
});
afterEach(async () => {
  await served.close();
});

const scope = (tools: readonly ToolSpec[] = [OVERVIEW, SAVE]) => ({
  tools,
  call: (call: McpCall) => {
    calls.push(call);
    return answer(call);
  },
});

const at = (key: string, path = "/mcp"): McpServerConfig => ({
  url: `http://127.0.0.1:${String(served.port)}${path}`,
  http_headers: { Authorization: `Bearer ${key}` },
});

const call = (server: McpServerConfig, name = "get_overview") =>
  callTool(server, {
    name,
    arguments: {},
    callId: "call-1",
    threadId: "thread-1",
    turnId: "turn-1",
  });

describe("Rufi's MCP endpoints", () => {
  it("serves a key's tools to a client with no Origin, and passes on the call's _meta as it came", async () => {
    const server = at(chatKeys.issue(scope()));
    const started = await initialize(server);
    expect(started.result).toMatchObject({
      serverInfo: { name: "rufi" },
      capabilities: { tools: {} },
    });
    const { result } = await listTools(server);
    expect(result?.["tools"]).toEqual([
      {
        name: "get_overview",
        description: "The record at a glance.",
        inputSchema: { type: "object", properties: {} },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      {
        name: "save_changes",
        description: "Saves changes.",
        inputSchema: { type: "object", properties: {} },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
    ]);
    expect((await call(server)).result).toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
    expect(calls).toEqual([
      {
        tool: "get_overview",
        input: {},
        meta: codexMeta({
          callId: "call-1",
          threadId: "thread-1",
          turnId: "turn-1",
        }),
        signal: expect.any(AbortSignal) as AbortSignal,
      },
    ]);
  });

  it("refuses a request without a key, and with a wrong or revoked one", async () => {
    const key = chatKeys.issue(scope());
    const url = `http://127.0.0.1:${String(served.port)}/mcp`;
    expect((await initialize({ url })).status).toBe(401);
    expect((await initialize(at("not-a-key"))).status).toBe(401);
    expect((await initialize(at(key))).status).toBe(200);
    chatKeys.revoke(key);
    expect((await call(at(key))).status).toBe(401);
    expect(calls).toEqual([]);
    expect(refused).toEqual(["key", "key", "key"]);
  });

  it("refuses a request from a web page or another address, even with the key", async () => {
    const server = at(chatKeys.issue(scope()));
    const own = `http://127.0.0.1:${String(served.port)}`;
    expect((await initialize(server, { origin: own })).status).toBe(200);
    expect(
      (await initialize(server, { origin: "http://evil.example" })).status,
    ).toBe(403);
    expect((await initialize(server, { host: "rufi.example" })).status).toBe(
      403,
    );
    expect(
      (await initialize(server, { "x-forwarded-for": "10.0.0.1" })).status,
    ).toBe(400);
    expect(refused).toEqual(["origin", "host", "forwarded"]);
  });

  it("gives a page image as MCP image content before the text, and a refusal as an error result", async () => {
    const server = at(chatKeys.issue(scope()));
    answer = () =>
      Promise.resolve({
        ok: true,
        text: '{"ok":true,"result":{"page":1}}',
        images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
      });
    expect((await call(server)).result).toEqual({
      content: [
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        { type: "text", text: '{"ok":true,"result":{"page":1}}' },
      ],
    });
    answer = () =>
      Promise.resolve({ ok: false, text: '{"ok":false,"error":"No."}' });
    expect((await call(server)).result).toEqual({
      content: [{ type: "text", text: '{"ok":false,"error":"No."}' }],
      isError: true,
    });
  });

  it("tells the agent a call took too long, within the deadline, and keeps the call in the work Rufi finishes before it stops until it ends", async () => {
    const server = at(chatKeys.issue(scope()));
    const late = Promise.withResolvers<ToolAnswer>();
    answer = () => late.promise;
    expect((await call(server)).result).toEqual({
      content: [
        {
          type: "text",
          text: '{"ok":false,"error":"get_overview took too long."}',
        },
      ],
      isError: true,
    });
    // Its answer is long given; the call itself still runs.
    expect(working.size).toBe(1);
    late.resolve({ ok: true, text: "late" });
    await Promise.allSettled(working);
    expect(working.size).toBe(0);
  });
  it("offers each skill and the files beside it to read, the paper as CSS byte for byte", async () => {
    let port = 0;
    const withSkills = await serveMcp(
      mcpEndpoint({
        keys: chatKeys,
        port: () => port,
        log: () => undefined,
        resources: skillResources(SKILLS),
      }),
    );
    port = withSkills.port;
    try {
      const server: McpServerConfig = {
        url: `http://127.0.0.1:${String(port)}/mcp`,
        http_headers: { Authorization: `Bearer ${chatKeys.issue(scope())}` },
      };
      await initialize(server);
      const listed = (await listResources(server)).result?.["resources"];
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            uri: "skill://analysis/SKILL.md",
            mimeType: "text/markdown",
          }),
          expect.objectContaining({
            uri: "skill://analysis/paper.css",
            mimeType: "text/css",
          }),
        ]),
      );
      const paper = readFileSync(
        createRequire(import.meta.url).resolve("@rufi/brand/paper.css"),
        "utf8",
      );
      expect(
        (await readResource(server, "skill://analysis/paper.css")).result,
      ).toEqual({
        contents: [
          {
            uri: "skill://analysis/paper.css",
            mimeType: "text/css",
            text: paper,
          },
        ],
      });
    } finally {
      await withSkills.close();
    }
  });
});
