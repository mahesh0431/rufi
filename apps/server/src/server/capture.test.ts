// What the pinned Codex sends and does with Rufi's tools over MCP, captured
// offline (decision 28 of the AI setup): the real Codex binary, a local fake
// model that records every request, and the real chat, MCP server, tools and
// record on fictional data. It is the upgrade gate for Codex: a new pin must
// pass it. It checks what the model is given (Codex's prompt, Rufi's core and
// skills, the sandbox) and that one thread keeps it across a model change, a
// Rufi update and a compaction.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openAgentStore } from "@rufi/agents/store";
import { promisify } from "node:util";
import { v7 as uuid } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fakeModel,
  type FakeModel,
  type ModelRequest,
  type Step,
} from "../../tests/fake-model.ts";
import { rufiAiFor } from "../../tests/rufi-ai.ts";
import { codexBinary } from "../agent/codex/binary.ts";
import { codexAdapter, instructionsNote } from "../agent/codex/adapter.ts";
import { chatQueue } from "../core/chat/queue.ts";
import { DEFAULT_ALLOWLIST } from "../core/chat/models.ts";
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
import { rufiCaller, forAgent } from "../core/tools/tools.ts";
import { agentsPath } from "./agents.ts";
import { chat as openChat, type Chat } from "./chat.ts";
import { tempPath, tempPattern } from "../platform/files.ts";
import { agentSetup, aiSandbox, coreFile } from "./core.ts";
import { doorFile } from "../agent/codex/token-door.ts";
import { mcpEndpoint, mcpKeys, serveMcp } from "./mcp.ts";

let home: string;
let store: Store;
let transcripts: Transcripts;
let model: FakeModel | undefined;
let chat: Chat | undefined;
let ai: Awaited<ReturnType<typeof rufiAiFor>> | undefined;
let served: { port: number; close: () => Promise<void> } | undefined;
/** What reached Rufi's MCP server over HTTP. */
let seen: { auth: string | null; origin: string | null; method: string }[];

async function makeRecord(root: string) {
  home = await mkdtemp(join(root, "rufi-capture-"));
  store = openWritable(databasePath(home));
  store.db.exec(`
    INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
    INSERT INTO chats (id, person_id, created_at)
      VALUES ('c-asha', 'asha', '2026-10-01T09:00:00Z');
  `);
  transcripts = openTranscripts(store);
}

beforeEach(async () => {
  await makeRecord(tmpdir());
  seen = [];
});
afterEach(async () => {
  await chat?.close();
  chat = undefined;
  await ai?.close();
  ai = undefined;
  await served?.close();
  served = undefined;
  await model?.close();
  model = undefined;
  store.close();
  await rm(home, { recursive: true, force: true });
});

/**
 * The chat on the real Codex, as the core runs it (again, as after a
 * restart, when it ran); `refuse` breaks its MCP, `update` changes what an
 * update of Rufi would: a tool's description. `model` is the only one
 * allowed; without it, two are.
 */
async function start(
  script: Step[],
  options: { refuse?: boolean; update?: string; model?: string } = {},
) {
  await chat?.close();
  await ai?.close();
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
  ai = await rufiAiFor({
    home,
    record: store,
    transcripts,
    adapter: codexAdapter({
      home,
      ...agentSetup(home),
      command,
      env: { PATH: process.env["PATH"] ?? "" },
      token: () => Promise.resolve("not-a-real-token"),
      version: "0.0.0",
      deadlines: { requestMs: 20_000 },
      log,
    }),
    tools: tools.specs.map((spec) => spec.name),
  });
  chat = openChat({
    transcripts,
    queue: chatQueue(store),
    signedIn: () => Promise.resolve(true),
    agent: ai.agent,
    allowlist: options.model ? [options.model] : DEFAULT_ALLOWLIST,
    mcp: { url: () => `http://127.0.0.1:${String(port)}/mcp`, keys },
    rules: (region) => ({
      instructions: coreInstructions(region),
      version: rulesVersion(region),
    }),
    tools: {
      specs: tools.specs,
      caller: rufiCaller(reader, transcripts, log),
    },
    log,
  });
  await chat.carryAll();
  await ai.dispatch();
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
  "mcp__rufi__agent_status",
  "mcp__rufi__create_brief",
  "mcp__rufi__dismiss_items",
  "mcp__rufi__get_documents",
  "mcp__rufi__get_overview",
  "mcp__rufi__get_records",
  "mcp__rufi__read_agent",
  "mcp__rufi__read_chat",
  "mcp__rufi__save_changes",
  "mcp__rufi__save_reading",
  "mcp__rufi__send_agent",
  "mcp__rufi__show_face",
  "mcp__rufi__sort_documents",
  "mcp__rufi__start_agent",
  "mcp__rufi__stop_agent",
  "mcp__rufi__waiting_messages",
];

describe("Rufi's tools on the pinned Codex, over MCP", () => {
  it.each(DEFAULT_ALLOWLIST)(
    "on %s registers over HTTP with the thread's key and no Origin, and the code runner gets every tool with its input typed",
    { timeout: 120_000 },
    async (modelId) => {
      await start(
        [
          // Codex cuts a long output in the middle: every tool's name, and
          // only the save's description, whole.
          {
            exec: `text(JSON.stringify(ALL_TOOLS.filter((t) => t.name.startsWith("mcp__rufi__")).map((t) => ({ name: t.name, description: t.name === "mcp__rufi__save_changes" ? t.description : "" }))))`,
          },
          { text: "Done." },
        ],
        { model: modelId },
      );
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
      // Rufi's start_agent is the one way to start an agent: none of Codex's.
      expect(
        JSON.stringify(
          model?.requests.map((r) => [
            r.tools,
            r.input.filter((item) => item.type === "additional_tools"),
          ]),
        ),
      ).not.toContain("spawn_agent");
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
        'action: "add" | "change" | "remove" | "restore" | "link" | "remove_source";',
      );
      expect(save).toContain('as: "new" | "another_source" | "correction";');
      // Required stays required, and every field keeps its type: none is left
      // to the model to guess ("unknown" is only ever a value here).
      expect(save).toMatch(/\n {2}source\?: number;/);
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
            '  { kind: "symptom", action: "add",',
            '    fields: { name: "Headache" } }] });',
            "text(JSON.stringify([read.isError ?? false, saved.isError ?? false]));",
          ].join("\n"),
        },
        { text: "Saved your headache." },
      ]);
      await say("I have a headache; please save it.");
      await until(() => turns().some((t) => t["status"] !== "running"));
      expect(printed(1)).toBe("[false,false]");

      const row = await transcripts.chat("asha");
      if (!row) throw new Error("no chat");
      const page = await transcripts.page(row);
      const lines = await Promise.all(
        page.entries
          .filter((entry) => entry.kind === "activity")
          .map(async (entry) => ({
            ...entry,
            details: (await transcripts.details(row, entry.id))?.details as
              | { id?: string }
              | undefined,
          })),
      );
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
      // Rufi's id for a call is <agent>/<conversation>/<Codex's call id>,
      // and Codex's call id is its item's id: the line and the call are one.
      const item = (callId = "") => callId.split("/").slice(2).join("/");
      for (const call of calls) {
        expect(
          lines.find((line) => line.details?.id === item(call.call_id)),
        ).toMatchObject({ status: "done" });
      }
      expect(
        lines.find((line) => line.details?.id === item(calls[0]?.call_id))
          ?.text,
      ).toBe("rufi.get_overview");
      expect(
        page.entries
          .filter((entry) => entry.kind === "receipt")
          .map((entry) => entry.text),
      ).toEqual(["**Saved**\n\n- Added symptom **Headache**"]);
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
        async () => (await queue.list(row)).items[0]?.held === "open_failed",
      );
      expect((await queue.list(row)).items).toMatchObject([
        {
          text: "Hello",
          held: "open_failed",
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
      // Each path is in the data folder; some aren't made yet.
      const real = (path: string) =>
        join(realpathSync(home), relative(home, path));
      const permissions =
        given.find((text) => text.startsWith("<permissions instructions>")) ??
        "";
      expect(permissions).toContain("Network access is enabled.");
      expect(permissions).toContain(real(sandbox.folder));
      for (const path of sandbox.unreadable) {
        expect(permissions).toContain(
          path.includes("*")
            ? `- glob \`${path}\``
            : `- path \`${real(path)}\``,
        );
      }
      const environment = (model?.requests[0]?.input ?? [])
        .flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? "")
        .find((text) => text.startsWith("<environment_context>"));
      expect(environment).toContain(`<cwd>${sandbox.folder}</cwd>`);
    },
  );

  it(
    "keeps one thread across a model change and a Rufi update; each reply has the tools of its time",
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

      // Rufi is updated: a tool says more.
      const update = "Changed in this update.";
      await start(
        [
          {
            exec: 'text(ALL_TOOLS.find((t) => t.name === "mcp__rufi__get_overview").description)',
          },
          { text: "Three." },
        ],
        { update },
      );
      await say("third");
      await replies(3);
      const output = JSON.stringify(answering().at(-1)?.input.at(-1)?.output);
      expect(output).toContain(update);
      expect(threadsUsed()).toBe(1);
    },
  );
});

/** The developer messages that say Rufi's rules changed, whole. */
const notes = (request: ModelRequest | undefined) =>
  developer(request).filter((text) =>
    text.startsWith("Your instructions, given again"),
  );

describe("The context a chat's thread used, on the pinned Codex", () => {
  it(
    "is the last request's tokens and the model's window, as Codex reports them",
    { timeout: 120_000 },
    async () => {
      await start([{ text: "One.", tokens: 1_234 }]);
      await say("first");
      await replies(1);
      await until(
        async () =>
          ((await transcripts.chat("asha"))?.context ?? null) !== null,
      );
      const context = (await transcripts.chat("asha"))?.context;
      expect(context?.tokens).toBe(1_234);
      expect(context?.window).toBeGreaterThan(1_234);
    },
  );
});

describe("How a change of Rufi's rules reaches the AI, on the pinned Codex", () => {
  /** A skill's body or file changes, as in a release; undone after the test. */
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it.each([
    {
      change: "a new emergency region (the core)",
      region: "IN",
      make: () => transcripts.saveSetting("emergency_region", "IN"),
    },
    {
      change: "a skill's body only",
      region: undefined,
      make: () => {
        const skill = SKILLS.find((skill) => skill.name === "analysis");
        if (!skill) throw new Error("no analysis skill");
        const previous = skill.text;
        skill.text +=
          "\n- New rule in this release: show each calculation's inputs.\n";
        restore = () => {
          skill.text = previous;
        };
        return Promise.resolve();
      },
    },
    {
      change: "a file beside a skill only",
      region: undefined,
      make: () => {
        const skill = SKILLS.find((skill) => skill.name === "analysis");
        if (!skill) throw new Error("no analysis skill");
        const previous = skill.files;
        skill.files = {
          ...previous,
          "paper.css": `${previous["paper.css"] ?? ""}\n.rufi-paper h3 { margin: 0; }\n`,
        };
        restore = () => {
          skill.files = previous;
        };
        return Promise.resolve();
      },
    },
  ])(
    "after $change, the complete rules reach the next request without a compaction, and stay after a restart and after Codex compacts",
    { timeout: 180_000 },
    async ({ region, make }) => {
      await start([{ text: "One." }]);
      await say("first");
      await replies(1);
      const before = coreInstructions(undefined);
      expect(notes(answering().at(-1))).toEqual([]);

      // The thread is open: Rufi lets it go, picks it up with the new rules
      // and adds the note; the next request has it, whole.
      await make();
      const note = instructionsNote(coreInstructions(region));
      model?.script.push({ text: "Two." });
      await say("second");
      await replies(2);
      expect(model?.requests.length).toBe(answering().length);
      expect(notes(answering().at(-1))).toEqual([note]);
      expect(userWords(answering().at(-1))).toEqual(["first", "second"]);

      // Rufi starts again: the thread is picked up cold, keeps the note and
      // is given its rules again.
      await start([{ text: "Three.", tokens: OVER_LIMIT }]);
      await say("third");
      await replies(3);
      expect(model?.requests.length).toBe(answering().length);
      expect(notes(answering().at(-1))).toEqual([note, note]);

      // The answer was over the limit: Codex compacts, and the request after
      // it starts from the new rules.
      model?.script.push({ text: "Four." });
      await say("fourth");
      await replies(4);
      expect(model?.requests.length).toBe(answering().length + 1);
      const fourth = answering().at(-1);
      expect(developer(fourth)).toContain(coreInstructions(region));
      if (region !== undefined) expect(developer(fourth)).not.toContain(before);
      expect(userWords(fourth)).toContain("fourth");
      expect(threadsUsed()).toBe(1);
    },
  );

  it(
    "gives the rules again after an update that didn't reach the AI",
    { timeout: 180_000 },
    async () => {
      await start([{ text: "One." }]);
      await say("first");
      await replies(1);
      await transcripts.saveSetting("emergency_region", "IN");
      // Rufi's tools don't start for the AI: the thread isn't picked up.
      await start([], { refuse: true });
      await say("second");
      const row = await transcripts.chat("asha");
      if (!row) throw new Error("no chat");
      const queue = chatQueue(store);
      await until(
        async () => (await queue.list(row)).items[0]?.held === "open_failed",
      );
      expect((await transcripts.chat("asha"))?.threadTools).toBe(
        row.threadTools,
      );

      // Rufi starts again, and the person tries again.
      const opened = await start([{ text: "Two." }]);
      const [held] = (await queue.list(row)).items;
      if (!held?.holdId) throw new Error("nothing waits");
      await opened.chat.queue.recover(row, held.id, held.holdId, "retry");
      await replies(2);
      expect(notes(answering().at(-1))).toEqual([
        instructionsNote(coreInstructions("IN")),
      ]);
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
/**
 * Reads each process's arguments and environment, as any of the user's
 * programs can (sysctl KERN_PROCARGS2), and prints, for each, which of the
 * named values it holds; nothing else of them leaves the command.
 */
const PROCARGS = `import ctypes, json, sys
libc = ctypes.CDLL(None)
values = json.load(open(sys.argv[1]))
for pid in map(int, sys.argv[2:]):
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t(1 << 20)
    buf = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
        print(pid, "unreadable")
        continue
    raw = buf.raw[: size.value]
    print(pid, "read", *sorted(n for n, v in values.items() if v.encode() in raw))
`;

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

describe("What a person sees of the AI's steps, on the pinned Codex", () => {
  it(
    "shows each step as Codex reported it, whole: a command with its exit code (a skill read too), Rufi's tool with its arguments, and a progress note as a step, not a reply",
    { timeout: 120_000 },
    async () => {
      const skill = join(home, "codex", "skills", "results", "SKILL.md");
      const long = `echo ${"fictional ".repeat(40)}done`;
      await start([
        {
          note: "I'll read the results skill first.",
          ...commands([
            `cat ${JSON.stringify(skill)}`,
            long,
            "ls /fictional-folder-that-is-not-there",
          ]),
        },
        { exec: 'await tools.mcp__rufi__get_records({ kind: "result" });' },
        { text: "Done." },
      ]);
      await say("Hi.");
      await replies(1);
      const row = await transcripts.chat("asha");
      if (!row) throw new Error("No fictional chat.");
      const page = await transcripts.page(row);
      // As the screens get them; everything else when a line opens.
      const lines = await Promise.all(
        page.entries
          .filter((entry) => entry.kind === "activity")
          .map(async (entry) => ({
            ...entry,
            details: (await transcripts.details(row, entry.id))?.details as
              | { command: string; exitCode: number }
              | undefined,
          })),
      );
      const commandLines = lines.filter((line) => line.activity === "command");
      expect(commandLines).toHaveLength(3);
      for (const line of commandLines) {
        // The command and exit code as Codex gave them, nothing cut.
        const item = line.details ?? { command: "", exitCode: -1 };
        expect(line.text).toBe(item.command);
        expect(line.detail).toBe(`exit ${String(item.exitCode)}`);
      }
      const [read, echoed, missing] = commandLines;
      expect(read?.text).toContain("skills/results/SKILL.md");
      expect(read?.status).toBe("done");
      expect(echoed?.text.length).toBeGreaterThan(300);
      expect(echoed?.text).toContain(long);
      expect(missing?.status).toBe("failed");
      expect(missing?.detail).not.toBe("exit 0");
      expect(
        lines
          .filter((line) => line.activity !== "command")
          .map((line) => [line.activity, line.text, line.detail, line.status]),
      ).toEqual([
        ["note", "I'll read the results skill first.", null, "done"],
        ["tool", "rufi.get_records", '{"kind":"result"}', "done"],
      ]);
      expect(
        page.entries
          .filter((entry) => entry.kind === "reply")
          .map((entry) => entry.text),
      ).toEqual(["Done."]);
    },
  );
});

describe.runIf(process.platform === "darwin")(
  "The AI's sandbox on macOS (the canary)",
  () => {
    it.each([
      { location: "the system temp folder", root: tmpdir() },
      { location: "/tmp", root: "/tmp" },
    ])(
      "keeps the record unreadable, the skills read-only and writes in the AI's folder (its caches too) or temp, with data in $location; also after a model change, resume and reload",
      { timeout: 180_000 },
      async ({ root }) => {
        if (root !== tmpdir()) {
          store.close();
          await rm(home, { recursive: true, force: true });
          await makeRecord(root);
        }
        // The agent database, open as the core keeps it.
        const agentStore = openAgentStore(agentsPath(home));
        // Outside both the AI's folder and all temp roots. Prove that a
        // refusal isn't just the Mac's ordinary file permissions.
        const outsideRoot = await mkdtemp("/Users/Shared/rufi-canary-");
        // What a command reads of Rufi's processes, and how.
        const probe = await mkdtemp(join(tmpdir(), "rufi-canary-procargs-"));
        const outside = join(outsideRoot, "outside.txt");
        try {
          await writeFile(outside, "the test process can write here");
          await rm(outside);
          const { folder, unreadable } = aiSandbox(home);
          // Each way in, there to be read (the databases are in WAL mode).
          await mkdir(join(home, "backups"), { recursive: true });
          await writeFile(join(home, "backups", "copy.sqlite"), "a copy");
          await writeFile(join(home, "core.json"), '{"launcher":"secret"}');
          // Its temp copy, as it is written.
          const copy = tempPath(coreFile(home));
          await writeFile(copy, '{"launcher":"secret"}');
          // The chat's Codex replaces its door's file as it starts.
          const doors = [doorFile(home, "chat"), doorFile(home, "reader")];
          for (const door of doors) {
            await mkdir(dirname(door), { recursive: true });
            await writeFile(
              door,
              JSON.stringify({ key: `fictional-${uuid()}` }),
            );
          }
          expect(existsSync(`${databasePath(home)}-wal`)).toBe(true);
          expect(existsSync(`${agentsPath(home)}-wal`)).toBe(true);
          const skill = join(home, "codex", "skills", "analysis", "SKILL.md");
          const q = (path: string) => JSON.stringify(path);
          // Each one that is there now, and the backup's copy; neither
          // database has a journal, in WAL mode.
          const journal = `${databasePath(home)}-journal`;
          const denied = [
            ...unreadable.map((path) =>
              path === tempPattern(coreFile(home)) ? copy : path,
            ),
            join(home, "backups", "copy.sqlite"),
            ...doors,
          ]
            .filter((path) => existsSync(path))
            .map((path) => `cat ${q(path)}`);
          expect(denied).toHaveLength(unreadable.length - 1 + doors.length);
          // What a command reads of Rufi's processes: Rufi's own and the
          // Codex it runs now, each with a value it surely holds.
          await writeFile(join(probe, "procargs.py"), PROCARGS);
          let codexChecked = 0;
          const processes = async () => {
            const { stdout } = await promisify(execFile)("ps", [
              "-A",
              "-o",
              "pid=,ppid=,command=",
            ]);
            const codex = stdout
              .split("\n")
              .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
              .filter(
                (match) =>
                  match?.[2] === String(process.pid) &&
                  match[3]?.includes("app-server"),
              )
              .map((match) => ({
                pid: Number(match?.[1]),
                holds: join(home, "codex"),
              }));
            return [{ pid: process.pid, holds: process.execPath }, ...codex];
          };
          const others = (url: string) => ({
            outside: `echo no > ${q(outside)}`,
            journal: `echo no > ${q(journal)}`,
            skillWrite: `echo no > ${q(skill)}`,
            inside: "echo yes > inside.txt && cat inside.txt",
            skillRead: `head -2 ${q(skill)}`,
            temp: "echo yes > /tmp/rufi-canary-$$ && cat /tmp/rufi-canary-$$ && rm /tmp/rufi-canary-$$",
            env: "env",
            // Caches go in the AI's folder, where commands can write.
            cache:
              'for d in "$PIP_CACHE_DIR" "$MPLCONFIGDIR"; do mkdir -p "$d" && echo yes > "$d/x" && cat "$d/x"; done; echo "$XDG_CACHE_HOME"',
            // The network is on: the local model answers (404: no page there).
            network: `curl -s -o /dev/null -w "%{http_code}" ${q(url)}`,
          });
          /** Runs every command in a reply, and checks what each got back. */
          const run = async (n: number, text: string) => {
            const url = model?.url ?? "";
            const named = others(url);
            // Every secret Rufi has given so far: the token, the MCP keys
            // and the token door's key.
            const watched = await processes();
            const door = JSON.parse(
              await readFile(doorFile(home, "chat"), "utf8"),
            ) as { key: string };
            const secrets = [
              "not-a-real-token",
              door.key,
              ...seen.flatMap((r) => r.auth?.replace("Bearer ", "") ?? []),
            ];
            await writeFile(
              join(probe, "values.json"),
              JSON.stringify({
                ...Object.fromEntries(
                  secrets.map((value, i) => [`secret-${String(i)}`, value]),
                ),
                ...Object.fromEntries(
                  watched.map((p) => [`holds-${String(p.pid)}`, p.holds]),
                ),
              }),
            );
            const readOthers = `/usr/bin/python3 -I ${q(join(probe, "procargs.py"))} ${q(join(probe, "values.json"))} ${watched.map((p) => String(p.pid)).join(" ")}`;
            model?.script.push(
              commands([...denied, ...Object.values(named), readOthers]),
              {
                text: "Ran.",
              },
            );
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
              expect(by(cmd)?.output).toMatch(/operation not permitted/i);
            }
            for (const write of [named.outside, named.journal]) {
              expect(by(write)?.output).toMatch(/operation not permitted/i);
            }
            expect(existsSync(outside)).toBe(false);
            expect(existsSync(journal)).toBe(false);
            expect(by(named.skillWrite)?.exit_code).not.toBe(0);
            expect(by(named.inside)?.output).toBe("yes\n");
            expect(by(named.temp)?.output).toBe("yes\n");
            expect(by(named.skillRead)?.output).toBe("---\nname: analysis\n");
            const env = by(named.env)?.output ?? "";
            const key = (seen.at(-1)?.auth ?? "").replace("Bearer ", "");
            expect(key).not.toBe("");
            expect(env).toContain("PATH=");
            expect(env).not.toMatch(/TOKEN|not-a-real-token/);
            expect(env).not.toContain(key);
            expect(by(named.cache)?.output).toBe(
              `yes\nyes\n${join(folder, ".cache")}\n`,
            );
            expect(by(named.network)?.output).toBe("404");
            // The Mac lets a command read another process's arguments and
            // environment: each one it read holds its own value, and none
            // of Rufi's secrets.
            // Only its answer lines: the Mac's python3 may warn first.
            expect(
              (by(readOthers)?.output ?? "")
                .split("\n")
                .filter((line) => /^\d+ /.test(line))
                .sort(),
            ).toEqual(
              watched
                .map((p) => `${String(p.pid)} read holds-${String(p.pid)}`)
                .sort(),
            );
            codexChecked += watched.length - 1;
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
          await transcripts.saveSetting("emergency_region", "IN");
          await run(4, "After reloading the rules.");
          expect(threadsUsed()).toBe(1);
          // Codex was running for some of the runs.
          expect(codexChecked).toBeGreaterThan(0);
        } finally {
          agentStore.close();
          await rm(outsideRoot, { recursive: true, force: true });
          await rm(probe, { recursive: true, force: true });
        }
      },
    );
  },
);
