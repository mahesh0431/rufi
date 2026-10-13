// What the pinned Codex sends and does with Rufi's tools over MCP, captured
// offline (decision 28 of the AI setup): the real Codex binary, a local fake
// model that records every request, and the real chat, MCP server, tools and
// record on fictional data. It is the upgrade gate for Codex: a new pin must
// pass it. Later steps add the instructions, skills and sandbox.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { v7 as uuid } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fakeModel,
  type FakeModel,
  type Step,
} from "../../tests/fake-model.ts";
import { codexBinary } from "../agent/codex/binary.ts";
import { codexRuntime } from "../agent/codex/codex.ts";
import { chatQueue } from "../core/chat/queue.ts";
import {
  transcripts as openTranscripts,
  type Transcripts,
} from "../core/chat/transcript.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "../core/store/database.ts";
import { chatCaller, forAgent, toolsVersion } from "../core/tools/tools.ts";
import { chat as openChat, type Chat } from "./chat.ts";
import { mcpEndpoint, mcpKeys, serveMcp } from "./mcp.ts";

let home: string;
let store: Store;
let transcripts: Transcripts;
let model: FakeModel | undefined;
let chat: Chat | undefined;
let served: { port: number; close: () => Promise<void> } | undefined;
/** What reached Rufi's MCP server over HTTP. */
let seen: { auth: string | null; origin: string | null; method: string }[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-capture-"));
  store = openWritable(databasePath(home));
  store.db.exec(`
    INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
    INSERT INTO chats (id, person_id, created_at)
      VALUES ('c-asha', 'asha', '2026-10-01T09:00:00Z');
  `);
  transcripts = openTranscripts(store);
  seen = [];
});
afterEach(async () => {
  await chat?.close();
  chat = undefined;
  await served?.close();
  served = undefined;
  await model?.close();
  model = undefined;
  store.close();
});

/** The chat on the real Codex, as the core runs it; `refuse` breaks its MCP. */
async function start(script: Step[], refuse = false) {
  model = await fakeModel({ script });
  const reader = openReadOnly(databasePath(home));
  const log = () => undefined;
  const tools = forAgent(() => ({ store: reader, personId: undefined }), log);
  const keys = mcpKeys();
  let port = 0;
  const endpoint = mcpEndpoint({ keys, port: () => port, log });
  served = await serveMcp(async (request) => {
    const body = (await request.clone().json()) as { method?: string };
    seen.push({
      auth: request.headers.get("authorization"),
      origin: request.headers.get("origin"),
      method: body.method ?? "",
    });
    return refuse ? new Response(null, { status: 401 }) : endpoint(request);
  });
  port = served.port;
  const command = {
    file: await codexBinary(),
    args: ["-c", `model_providers.openai_chatgpt_plan.base_url="${model.url}"`],
  };
  chat = openChat({
    transcripts,
    queue: chatQueue(store),
    signedIn: () => Promise.resolve(true),
    agent: (host) =>
      codexRuntime({
        home,
        command,
        env: { PATH: process.env["PATH"] ?? "" },
        token: () => Promise.resolve("not-a-real-token"),
        version: "0.0.0",
        deadlines: { requestMs: 20_000, turnMs: 60_000 },
        tools: { server: tools.server, specs: tools.specs },
        host,
        log,
      }),
    allowlist: () => Promise.resolve({ models: ["gpt-6-astra"] }),
    mcp: { url: () => `http://127.0.0.1:${String(port)}/mcp`, keys },
    tools: {
      version: toolsVersion(),
      specs: tools.specs,
      instructions: tools.instructions,
      caller: chatCaller(reader, transcripts, log),
    },
    log,
  });
  return { tools, chat };
}

const say = async (text: string) => {
  const row = await transcripts.chat("asha");
  if (!row || !chat) throw new Error("no chat");
  await chat.send(row, uuid(), text);
};

async function until(ready: () => boolean | Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(25);
  }
}

const turns = () =>
  store.db
    .prepare("SELECT status, end_text FROM turns ORDER BY started_at")
    .all();

/** The last line an exec script printed, as the next request carries it. */
const printed = (request: number) =>
  (
    (model?.requests[request]?.input.at(-1)?.output ?? []) as {
      text?: string;
    }[]
  )
    .map((part) => part.text ?? "")
    .join("\n")
    .split("\n")
    .at(-1) ?? "";

const RUFI_TOOLS = [
  "mcp__rufi__create_brief",
  "mcp__rufi__dismiss_items",
  "mcp__rufi__get_documents",
  "mcp__rufi__get_overview",
  "mcp__rufi__get_records",
  "mcp__rufi__read_chat",
  "mcp__rufi__retry_reading",
  "mcp__rufi__save_changes",
];

describe("Rufi's tools on the pinned Codex, over MCP", () => {
  it(
    "registers over HTTP with the thread's key and no Origin, and the code runner gets every tool with its input typed",
    { timeout: 120_000 },
    async () => {
      await start([
        {
          exec: `text(JSON.stringify(ALL_TOOLS.filter((t) => t.name.startsWith("mcp__rufi__"))))`,
        },
        { text: "Done." },
      ]);
      await say("What can you do?");
      await until(() => turns().some((t) => t["status"] !== "running"));
      expect(turns()).toMatchObject([{ status: "completed" }]);

      const keys = new Set(seen.map((request) => request.auth));
      expect(keys.size).toBe(1);
      expect([...keys][0]).toMatch(/^Bearer [\w-]{43}$/);
      expect(seen.every((request) => request.origin === null)).toBe(true);
      expect(seen.map((request) => request.method)).toEqual(
        expect.arrayContaining(["initialize", "tools/list"]),
      );

      const offered = JSON.parse(printed(1)) as {
        name: string;
        description: string;
      }[];
      expect(offered.map((tool) => tool.name).sort()).toEqual(RUFI_TOOLS);
      // What the model writes a save from: the declaration, not the schema.
      const save =
        offered
          .find((tool) => tool.name === "mcp__rufi__save_changes")
          ?.description.split("exec tool declaration:")[1] ?? "";
      // Each kind is its own branch, with its own fields.
      for (const kind of ["medicine_use", "symptom", "result", "follow_up"]) {
        expect(save).toContain(`kind: "${kind}";`);
      }
      expect(save).toContain(
        'action: "add" | "change" | "remove" | "restore" | "remove_source";',
      );
      expect(save).toContain('as: "new" | "another_source" | "correction";');
      // Required stays required, and every field keeps its type: none is left
      // to the model to guess ("unknown" is only ever a value here).
      expect(save).toMatch(/\n {2}source: string;/);
      expect(save).toMatch(/\n {2}version: number;/);
      expect(save).toMatch(/\btest\?: string;/);
      expect(save).toMatch(/\bvalue\?: string;/);
      expect(save).not.toMatch(/[^"]unknown[^"]/);
    },
  );

  it(
    "binds each call to its reply by the call's own id, shows it in the activity and Based on, and saves with a receipt",
    { timeout: 120_000 },
    async () => {
      await start([
        {
          exec: [
            "const read = await tools.mcp__rufi__get_overview({});",
            "const saved = await tools.mcp__rufi__save_changes({ changes: [",
            '  { kind: "symptom", action: "add", source: "I have a headache",',
            '    fields: { name: "Headache" } }] });',
            "text(JSON.stringify([read.isError ?? false, saved.isError ?? false]));",
          ].join("\n"),
        },
        { text: "Saved your headache." },
      ]);
      await say("I have a headache; please save it.");
      await until(() => turns().some((t) => t["status"] !== "running"));
      expect(printed(1)).toBe("[false,false]");

      const lines = store.db
        .prepare(
          "SELECT agent_item_id, text, status FROM transcript_entries WHERE kind = 'activity' ORDER BY seq",
        )
        .all() as { agent_item_id: string; text: string; status: string }[];
      const calls = store.db
        .prepare(
          "SELECT call_id, tool, ok, turn_id FROM tool_calls ORDER BY started_at",
        )
        .all() as {
        call_id: string;
        tool: string;
        ok: number;
        turn_id: string;
      }[];
      const [turn] = store.db.prepare("SELECT id FROM turns").all() as {
        id: string;
      }[];
      expect(calls.map((call) => [call.tool, call.ok, call.turn_id])).toEqual([
        ["get_overview", 1, turn?.id],
        ["save_changes", 1, turn?.id],
      ]);
      // Codex's call id is its item's id: the line and the call are one.
      for (const call of calls) {
        expect(
          lines.find((line) => line.agent_item_id === call.call_id),
        ).toMatchObject({ status: "done" });
      }
      expect(
        lines.find((line) => line.agent_item_id === calls[0]?.call_id)?.text,
      ).toBe("Read your overview");

      const row = await transcripts.chat("asha");
      if (!row) throw new Error("no chat");
      const page = await transcripts.page(row);
      expect(
        page.entries
          .filter((entry) => entry.kind === "receipt")
          .map((entry) => entry.text),
      ).toEqual(["**Saved**\n\n- Added symptom **Headache**"]);
      expect(page.turns[0]?.used).toMatchObject([
        { title: "Read your overview", outcome: "done" },
      ]);
    },
  );

  it(
    "holds the message with a plain reason when Rufi's tools don't start",
    { timeout: 120_000 },
    async () => {
      await start([{ text: "Not reached." }], true);
      await say("Hello");
      const row = await transcripts.chat("asha");
      if (!row) throw new Error("no chat");
      const queue = chatQueue(store);
      await until(
        async () => (await queue.list(row)).items[0]?.held === "failed",
      );
      expect((await queue.list(row)).items).toMatchObject([
        {
          text: "Hello",
          held: "failed",
          heldText:
            "Rufi's tools didn't start for the AI, so it can't reply now. Try again; if it keeps happening, restart Rufi.",
        },
      ]);
      expect(seen[0]?.auth).toMatch(/^Bearer /);
      expect(model?.requests).toEqual([]);
    },
  );
});
