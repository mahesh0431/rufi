// An MCP client that talks as the pinned Codex does (0.159.3): Streamable
// HTTP, protocol 2025-06-18, a bearer key, no Origin, and Codex's `_meta` on
// each call. For the scripted fake Codex and the MCP server's tests. Every
// header goes as given (fetch would set Host itself).
import { request as httpRequest } from "node:http";

export interface McpServerConfig {
  url: string;
  http_headers?: Record<string, string>;
}

export interface McpAnswer {
  status: number;
  /** The JSON-RPC result, when there is one. */
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const PROTOCOL = "2025-06-18";

let nextId = 1;

/** Posts one JSON-RPC message; a notification has no `id` and no answer. */
async function post(
  server: McpServerConfig,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<McpAnswer> {
  const url = new URL(server.url);
  const response = await new Promise<{
    status: number;
    type: string;
    text: string;
  }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        method: "POST",
        path: url.pathname,
        headers: {
          host: url.host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...server.http_headers,
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            type: res.headers["content-type"] ?? "",
            text,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", ...body }));
  });
  const ok = response.status >= 200 && response.status < 300;
  if (!ok || body["id"] === undefined) return { status: response.status };
  // A JSON body, or an event stream whose data line carries the answer.
  const json = response.type.includes("event-stream")
    ? response.text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .at(-1)
    : response.text;
  const message = JSON.parse(json ?? "{}") as Omit<McpAnswer, "status">;
  return { status: response.status, ...message };
}

/** Starts a session: initialize, then initialized, as Codex does. */
export async function initialize(
  server: McpServerConfig,
  headers: Record<string, string> = {},
): Promise<McpAnswer> {
  const answer = await post(
    server,
    {
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "codex-mcp-client", version: "0.159.3" },
      },
    },
    headers,
  );
  if (answer.result) {
    await post(
      server,
      { method: "notifications/initialized" },
      { "mcp-protocol-version": PROTOCOL, ...headers },
    );
  }
  return answer;
}

export const listTools = (server: McpServerConfig) =>
  post(
    server,
    { id: nextId++, method: "tools/list", params: {} },
    { "mcp-protocol-version": PROTOCOL },
  );

export const listResources = (server: McpServerConfig) =>
  post(
    server,
    { id: nextId++, method: "resources/list", params: {} },
    { "mcp-protocol-version": PROTOCOL },
  );

export const readResource = (server: McpServerConfig, uri: string) =>
  post(
    server,
    { id: nextId++, method: "resources/read", params: { uri } },
    { "mcp-protocol-version": PROTOCOL },
  );

/** The `_meta` Codex gives a call to an MCP tool: its id, thread and turn. */
export const codexMeta = (call: {
  callId: string;
  threadId: string;
  turnId: string;
}) => ({
  callId: call.callId,
  threadId: call.threadId,
  "x-codex-turn-metadata": {
    thread_id: call.threadId,
    turn_id: call.turnId,
  },
});

/** Calls a tool with the `_meta` Codex gives a call, or the one given. */
export const callTool = (
  server: McpServerConfig,
  call: { name: string; arguments: unknown } & (
    | { callId: string; threadId: string; turnId: string }
    | { meta: object }
  ),
) =>
  post(
    server,
    {
      id: nextId++,
      method: "tools/call",
      params: {
        name: call.name,
        arguments: call.arguments,
        _meta: "meta" in call ? call.meta : codexMeta(call),
      },
    },
    { "mcp-protocol-version": PROTOCOL },
  );
