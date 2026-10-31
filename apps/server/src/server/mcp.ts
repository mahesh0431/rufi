// Rufi's MCP server: Rufi's tools over the Model Context Protocol (Streamable
// HTTP, with the official SDK), on Rufi's own loopback listener and outside
// the screens' checks. Each endpoint has its own keys: Rufi makes a key for
// one scope (a chat's thread for one run of Rufi, or one reading attempt),
// hands it to the agent, and keeps only its hash. The scope decides which
// tools there are and what a call may do; nothing in a request names a
// person, a chat or a document. docs/adr/0016.
import { createHash, randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import {
  createMcpHandler,
  Server,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { DEADLINES } from "../agent/codex/appserver.ts";
import { callOf } from "../agent/codex/events.ts";
import type { ToolAnswer, ToolSpec } from "../core/tools/registry.ts";
import { errorCode, type Log } from "../platform/logs.ts";

/** One call as the agent made it, with what its `_meta` says about it. */
export interface McpCall {
  tool: string;
  input: unknown;
  /** The agent's id for the call; the same call again has it too. */
  callId: string | undefined;
  /** The agent's thread and turn the call belongs to. */
  threadId: string | undefined;
  turnId: string | undefined;
}

/**
 * A text the endpoint offers to read, whatever the key: a skill, under
 * `skill://<name>/SKILL.md`, and the files beside it (the same texts as the
 * agent's skill files).
 */
export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  text: string;
}

/** Rufi's skills as the endpoint offers them, each file beside its SKILL.md too. */
export const skillResources = (
  skills: readonly {
    name: string;
    description: string;
    text: string;
    files: Readonly<Record<string, string>>;
  }[],
): McpResource[] =>
  skills.flatMap((skill) => [
    {
      uri: `skill://${skill.name}/SKILL.md`,
      name: skill.name,
      description: skill.description,
      mimeType: "text/markdown",
      text: skill.text,
    },
    ...Object.entries(skill.files).map(([file, text]) => ({
      uri: `skill://${skill.name}/${file}`,
      name: `${skill.name}/${file}`,
      description: `A file of the ${skill.name} skill, named in its SKILL.md.`,
      mimeType: file.endsWith(".css") ? "text/css" : "text/plain",
      text,
    })),
  ]);

/** What a key opens: a catalog, and how its calls run. */
export interface McpScope {
  tools: readonly ToolSpec[];
  call: (call: McpCall) => Promise<ToolAnswer>;
}

export type McpKeys = ReturnType<typeof mcpKeys>;

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

/** One endpoint's keys, in memory: they end with this run of Rufi. */
export function mcpKeys() {
  const scopes = new Map<string, McpScope>();
  return {
    /** A new key for `scope`; only its hash is kept. */
    issue: (scope: McpScope): string => {
      const key = randomBytes(32).toString("base64url");
      scopes.set(hashOf(key), scope);
      return key;
    },
    /** The key opens nothing any more, from now on. */
    revoke: (key: string): void => {
      scopes.delete(hashOf(key));
    },
    resolve: (key: string): McpScope | undefined => scopes.get(hashOf(key)),
  };
}

const FORWARDING = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

/** The MCP server's own version: what it offers, not Rufi's. */
const VERSION = "1.0.0";

/**
 * One endpoint as a fetch handler. A request comes only from this Mac
 * (Host is Rufi's loopback address, nothing forwarded), with no Origin or
 * Rufi's own (Codex sends none, and a web page can't leave it out), and with
 * one of the endpoint's keys.
 */
export function mcpEndpoint(options: {
  keys: McpKeys;
  /** The port Rufi listens on, once known. */
  port: () => number;
  log: Log;
  /** How long a call may take before the agent is told it took too long. */
  toolMs?: number;
  /** What it offers to read; nothing when not given. */
  resources?: readonly McpResource[];
}): (request: Request) => Promise<Response> {
  const { keys, log } = options;
  const toolMs = options.toolMs ?? DEADLINES.toolMs;
  const resources = options.resources ?? [];
  const handler = createMcpHandler(
    (context) => {
      const scope = context.authInfo?.extra?.["scope"] as McpScope | undefined;
      if (!scope) throw new Error("An MCP request came without its scope.");
      return serverFor(scope, toolMs, resources);
    },
    {
      onerror: (error) => {
        log("mcp.failed", { error: errorCode(error) });
      },
    },
  );
  const refuse = (
    status: 400 | 401 | 403,
    reason: string,
    text: string,
  ): Response => {
    log("mcp.refused", { reason });
    return new Response(JSON.stringify({ error: text }), {
      status,
      headers: {
        "content-type": "application/json",
        ...(status === 401 && { "www-authenticate": "Bearer" }),
      },
    });
  };
  return async (request) => {
    const address = `127.0.0.1:${String(options.port())}`;
    if (FORWARDING.some((name) => request.headers.has(name))) {
      return refuse(
        400,
        "forwarded",
        "Rufi doesn't accept forwarded requests.",
      );
    }
    if (request.headers.get("host") !== address) {
      return refuse(403, "host", "This is Rufi's own address only.");
    }
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== `http://${address}`) {
      return refuse(403, "origin", "That request didn't come from Rufi.");
    }
    const authorization = request.headers.get("authorization") ?? "";
    const key = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    const scope = key === "" ? undefined : keys.resolve(key);
    if (!scope) return refuse(401, "key", "That key opens nothing here.");
    return handler.fetch(request, {
      authInfo: {
        token: hashOf(key),
        clientId: "agent",
        scopes: [],
        extra: { scope },
      },
    });
  };
}

/**
 * One scope's server, for one request. The SDK's low-level server: Rufi's
 * tools bring their own JSON Schema and check their own input, so the SDK's
 * high-level one, which checks input itself, isn't used.
 */
function serverFor(
  scope: McpScope,
  toolMs: number,
  resources: readonly McpResource[],
  // oxlint-disable-next-line typescript/no-deprecated -- see above
): Server {
  // oxlint-disable-next-line typescript/no-deprecated -- see above
  const server = new Server(
    { name: "rufi", version: VERSION },
    {
      capabilities: {
        tools: {},
        ...(resources.length > 0 && { resources: {} }),
      },
    },
  );
  if (resources.length > 0) {
    server.setRequestHandler("resources/list", () => ({
      resources: resources.map(({ uri, name, description, mimeType }) => ({
        uri,
        name,
        description,
        mimeType,
      })),
    }));
    server.setRequestHandler("resources/read", (request) => {
      const found = resources.find(
        (resource) => resource.uri === request.params.uri,
      );
      if (!found) throw new Error(`Rufi has no ${request.params.uri}.`);
      return {
        contents: [
          { uri: found.uri, mimeType: found.mimeType, text: found.text },
        ],
      };
    });
  }
  server.setRequestHandler("tools/list", () => ({
    tools: scope.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: inlined(tool.inputSchema) as { type: "object" },
      annotations: {
        readOnlyHint: tool.readOnly,
        destructiveHint: tool.destructive,
        openWorldHint: false,
      },
    })),
  }));
  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: input, _meta } = request.params;
    const tooLong: ToolAnswer = {
      ok: false,
      text: JSON.stringify({ ok: false, error: `${name} took too long.` }),
    };
    let timer: NodeJS.Timeout | undefined;
    const answer = await Promise.race([
      scope.call({ tool: name, input: input ?? {}, ...callOf(_meta) }),
      new Promise<ToolAnswer>((resolve) => {
        timer = setTimeout(resolve, toolMs, tooLong);
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });
    return resultOf(answer);
  });
  return server;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * A tool's input schema with its shared parts (`$defs`) written in place.
 * The pinned Codex (0.159.3) shows the code runner each tool as a TypeScript
 * declaration and resolves only its first few `$ref`s: the rest become
 * `unknown`, and the model loses those fields' types.
 */
function inlined(schema: unknown): unknown {
  const root = schema as { $defs?: Record<string, Json> };
  const defs = root.$defs ?? {};
  const walk = (node: Json, inside: readonly string[]): Json => {
    if (Array.isArray(node)) return node.map((item) => walk(item, inside));
    if (node === null || typeof node !== "object") return node;
    const { $ref, $defs: _defs, ...rest } = node;
    const name =
      typeof $ref === "string" ? $ref.replace("#/$defs/", "") : undefined;
    const shared = name === undefined ? undefined : defs[name];
    if (name !== undefined && (shared === undefined || inside.includes(name))) {
      throw new Error(
        `A tool's input schema has a $ref Rufi can't write out: ${name}.`,
      );
    }
    const own = Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [key, walk(value, inside)]),
    );
    if (name === undefined || shared === undefined) return own;
    const expanded = walk(shared, [...inside, name]);
    return typeof expanded === "object" &&
      expanded !== null &&
      !Array.isArray(expanded)
      ? { ...expanded, ...own }
      : expanded;
  };
  return walk(schema as Json, []);
}

/** A tool's answer as an MCP result: its text, then its images. */
function resultOf(answer: ToolAnswer): CallToolResult {
  return {
    content: [
      { type: "text", text: answer.text },
      ...(answer.images ?? []).map((image) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType,
      })),
    ],
    ...(!answer.ok && { isError: true }),
  };
}

/**
 * A loopback listener that serves only MCP, for a command with no core of its
 * own (the terminal ask). The core serves its endpoints on its own listener.
 */
export function serveMcp(
  fetch: (request: Request) => Promise<Response>,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      resolve({
        port: info.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
            if ("closeAllConnections" in server) server.closeAllConnections();
          }),
      });
    });
    server.once("error", reject);
  });
}
