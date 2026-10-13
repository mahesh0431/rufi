// What the pinned Codex sends and does with Rufi's tools over MCP, captured
// offline (decision 28 of the AI setup): the real Codex binary, a local fake
// model that records every request, and the real chat, MCP server, tools and
// record on fictional data. It is the upgrade gate for Codex: a new pin must
// pass it. It checks what the model is given (Codex's prompt, Rufi's core and
// skills, the sandbox) and that one thread keeps it across a model change, a
// Rufi update and a compaction.
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { v7 as uuid } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fakeModel,
  type FakeModel,
  type ModelRequest,
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
import { coreInstructions, rulesVersion } from "../core/chat/instructions.ts";
import { SKILLS } from "../core/skills/skills.ts";
import type { ToolSpec } from "../core/tools/registry.ts";
import { chatCaller, forAgent } from "../core/tools/tools.ts";
import { chat as openChat, type Chat } from "./chat.ts";
import { agentSetup, aiSandbox } from "./core.ts";
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

/**
 * The chat on the real Codex, as the core runs it (again, as after a
 * restart, when it ran); `refuse` breaks its MCP, `update` changes what an
 * update of Rufi would: a tool's description.
 */
async function start(
  script: Step[],
  options: { refuse?: boolean; update?: string } = {},
) {
  await chat?.close();
  await served?.close();
  await model?.close();
  model = await fakeModel({ script });
  const reader = openReadOnly(databasePath(home));
  const log = () => undefined;
  const agentTools = forAgent(
    () => ({ store: reader, personId: undefined }),
    log,
  );
  const update = options.update;
  const tools = {
    ...agentTools,
    specs: agentTools.specs.map((spec): ToolSpec =>
      update !== undefined && spec.name === "get_overview"
        ? { ...spec, description: `${spec.description} ${update}` }
        : spec,
    ),
  };
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
    return options.refuse
      ? new Response(null, { status: 401 })
      : endpoint(request);
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
        ...agentSetup(home),
        command,
        env: { PATH: process.env["PATH"] ?? "" },
        token: () => Promise.resolve("not-a-real-token"),
        version: "0.0.0",
        deadlines: { requestMs: 20_000, turnMs: 60_000 },
        tools: { server: tools.server, specs: tools.specs },
        host,
        log,
      }),
    allowlist: () =>
      Promise.resolve({ models: ["gpt-6-astra", "gpt-6.1-sol"] }),
    mcp: { url: () => `http://127.0.0.1:${String(port)}/mcp`, keys },
    rules: (region) => ({
      instructions: coreInstructions(region),
      version: rulesVersion(region),
    }),
    tools: {
      specs: tools.specs,
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
      await start([{ text: "Not reached." }], { refuse: true });
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

/** Over any model's compaction limit: Codex summarises the thread. */
const OVER_LIMIT = 10_000_000;

/** Each part of the developer messages a request carries, in order. */
const developer = (request: ModelRequest | undefined) =>
  (request?.input ?? [])
    .filter((item) => item.role === "developer" && item.type === "message")
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "");

/** The user's own words a request carries, in order. */
const userWords = (request: ModelRequest | undefined) =>
  (request?.input ?? [])
    .filter((item) => item.role === "user")
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .filter((text) => !text.startsWith("<"));

/** The requests that ask the model to answer, not to summarise. */
const answering = () =>
  (model?.requests ?? []).filter(
    (request) =>
      !userWords(request).some((text) =>
        text.startsWith("You are performing a CONTEXT CHECKPOINT COMPACTION"),
      ),
  );

const threadsUsed = () =>
  (
    store.db
      .prepare("SELECT COUNT(DISTINCT thread_id) AS n FROM turns")
      .get() as { n: number }
  ).n;

const replies = async (n: number) => {
  await until(
    () => turns().filter((turn) => turn["status"] !== "running").length >= n,
  );
  expect(turns().map((turn) => turn["status"])).toEqual(
    Array<string>(n).fill("completed"),
  );
};

describe("What the AI is given, on the pinned Codex", () => {
  it(
    "is Codex's own prompt with no personality, Rufi's core whole, Rufi's skills and none of Codex's, in the AI's folder under Rufi's profile",
    { timeout: 120_000 },
    async () => {
      await start([{ text: "Hello." }]);
      await say("Hi");
      await replies(1);
      const given = developer(model?.requests[0]);
      expect(given[0]).toMatch(/^You are Codex/);
      expect(given.join("\n")).not.toMatch(/^# Personality$/m);
      expect(given).toContain(coreInstructions(undefined));

      const catalog = given.find((text) =>
        text.startsWith("<skills_instructions>"),
      );
      const listed = [
        ...(catalog ?? "").matchAll(/^- ([\w-]+): (.+) \(file: [^)]+\)$/gm),
      ].map(([, name, description]) => ({ name, description }));
      expect(listed).toEqual(
        SKILLS.map(({ name, description }) => ({ name, description })),
      );

      // The sandbox as Codex tells the model, and its working folder.
      const sandbox = aiSandbox(home);
      const real = (path: string) =>
        join(realpathSync(dirname(path)), basename(path));
      const permissions =
        given.find((text) => text.startsWith("<permissions instructions>")) ??
        "";
      expect(permissions).toContain("Network access is enabled.");
      expect(permissions).toContain(real(sandbox.folder));
      for (const path of sandbox.unreadable) {
        expect(permissions).toContain(`- path \`${real(path)}\``);
      }
      const environment = (model?.requests[0]?.input ?? [])
        .flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? "")
        .find((text) => text.startsWith("<environment_context>"));
      expect(environment).toContain(`<cwd>${sandbox.folder}</cwd>`);
    },
  );

  it(
    "keeps one thread across a model change, a Rufi update and a compaction; each reply has the core and tools of its time",
    { timeout: 180_000 },
    async () => {
      const opened = await start([{ text: "One." }, { text: "Two." }]);
      await say("first");
      await replies(1);
      const row = await transcripts.chat("asha");
      if (!row) throw new Error("no chat");
      await opened.chat.selectModel(row, "gpt-6.1-sol");
      await say("second");
      await replies(2);
      const changed = answering().at(-1);
      expect(changed?.model).toBe("gpt-6.1-sol");
      expect(userWords(changed)).toEqual(["first", "second"]);

      // Rufi is updated: a tool says more, and the core names the region.
      await transcripts.saveSetting("emergency_region", "IN");
      const update = "Changed in this update.";
      await start(
        [
          {
            exec: 'text(ALL_TOOLS.find((t) => t.name === "mcp__rufi__get_overview").description)',
          },
          { text: "Three.", tokens: OVER_LIMIT },
          { text: "Four." },
        ],
        { update },
      );
      await say("third");
      await replies(3);
      const [described, third] = answering().slice(-2);
      expect(developer(described)).toContain(coreInstructions("IN"));
      expect(developer(described)).not.toContain(coreInstructions(undefined));
      expect(userWords(described)).toContain("third");
      const output = JSON.stringify(third?.input.at(-1)?.output ?? "");
      expect(output).toContain(update);

      // The answer was over the limit: Codex summarises, the core stays.
      await say("fourth");
      await replies(4);
      const summaries = (model?.requests.length ?? 0) - answering().length;
      expect(summaries).toBe(2);
      const fourth = answering().at(-1);
      expect(developer(fourth)).toContain(coreInstructions("IN"));
      expect(developer(fourth)).not.toContain(coreInstructions(undefined));
      expect(userWords(fourth)).toContain("fourth");
      expect(threadsUsed()).toBe(1);
    },
  );
});

/** A shell command the AI runs, and what it got back. */
interface Ran {
  cmd: string;
  exit_code: number;
  output: string;
}

/** An exec step that runs each command in the AI's folder and prints all. */
const commands = (cmds: readonly string[]): Step => ({
  exec: [
    `const cmds = ${JSON.stringify(cmds)};`,
    "const ran = [];",
    "for (const cmd of cmds) {",
    "  const r = await tools.exec_command({ cmd });",
    "  ran.push({ cmd, exit_code: r.exit_code, output: r.output });",
    "}",
    "text(JSON.stringify(ran));",
  ].join("\n"),
});

describe.runIf(process.platform === "darwin")(
  "The AI's sandbox on macOS (the canary)",
  () => {
    it(
      "keeps the record's database and Rufi's other ways in unreadable and every write in the AI's folder, with no secret in the environment; also after a model change and a resume",
      { timeout: 180_000 },
      async () => {
        const { folder, unreadable } = aiSandbox(home);
        // Each way in, there to be read (the database is in WAL mode).
        await mkdir(join(home, "backups"), { recursive: true });
        await writeFile(join(home, "backups", "copy.sqlite"), "a copy");
        await writeFile(join(home, "core.json"), '{"launcher":"secret"}');
        expect(existsSync(`${databasePath(home)}-wal`)).toBe(true);
        const outside = join(home, "outside.txt");
        const skill = join(home, "codex", "skills", "analysis", "SKILL.md");
        const q = (path: string) => JSON.stringify(path);
        // Each one that is there now; a journal isn't, in WAL mode.
        const journal = `${databasePath(home)}-journal`;
        const denied = [...unreadable, join(home, "backups", "copy.sqlite")]
          .filter((path) => existsSync(path))
          .map((path) => `cat ${q(path)}`);
        expect(denied).toHaveLength(unreadable.length);
        const others = (url: string) => ({
          outside: `echo no > ${q(outside)}`,
          journal: `echo no > ${q(journal)}`,
          skillWrite: `echo no > ${q(skill)}`,
          inside: "echo yes > inside.txt && cat inside.txt",
          skillRead: `head -2 ${q(skill)}`,
          env: "env",
          // The network is on: the local model answers (404: no page there).
          network: `curl -s -o /dev/null -w "%{http_code}" ${q(url)}`,
        });
        /** Runs every command in a reply, and checks what each got back. */
        const run = async (n: number, text: string) => {
          const url = model?.url ?? "";
          const named = others(url);
          model?.script.push(commands([...denied, ...Object.values(named)]), {
            text: "Ran.",
          });
          await say(text);
          await replies(n);
          const output = answering()
            .flatMap((request) => request.input)
            .filter((item) => item.type === "custom_tool_call_output")
            .at(-1)?.output;
          const ran = JSON.parse(
            (Array.isArray(output) ? output : [])
              .map((part) => part.text ?? "")
              .at(-1) ?? "[]",
          ) as Ran[];
          const by = (cmd: string) => ran.find((r) => r.cmd === cmd);
          for (const cmd of denied) {
            expect(by(cmd)?.output).toMatch(/Operation not permitted/);
          }
          for (const write of [named.outside, named.journal]) {
            expect(by(write)?.output).toMatch(/operation not permitted/);
          }
          expect(existsSync(outside)).toBe(false);
          expect(existsSync(journal)).toBe(false);
          expect(by(named.skillWrite)?.exit_code).not.toBe(0);
          expect(by(named.inside)?.output).toBe("yes\n");
          expect(by(named.skillRead)?.output).toBe("---\nname: analysis\n");
          const env = by(named.env)?.output ?? "";
          const key = (seen.at(-1)?.auth ?? "").replace("Bearer ", "");
          expect(key).not.toBe("");
          expect(env).toContain("PATH=");
          expect(env).not.toMatch(/TOKEN|not-a-real-token/);
          expect(env).not.toContain(key);
          expect(by(named.network)?.output).toBe("404");
        };

        const opened = await start([]);
        await run(1, "Run them.");
        expect(await readFile(join(folder, "inside.txt"), "utf8")).toBe(
          "yes\n",
        );
        const row = await transcripts.chat("asha");
        if (!row) throw new Error("no chat");
        await opened.chat.selectModel(row, "gpt-6.1-sol");
        await run(2, "Run them again.");
        // Rufi starts again: the thread is resumed, with a new key.
        await start([]);
        await run(3, "And once more.");
        expect(threadsUsed()).toBe(1);
      },
    );
  },
);
