// The chat with its agent, as one contract: the same tests run against the
// scripted fake Codex and against the real Codex binary (on a local fake
// model, offline). What a reply does is chosen by the message's words: see
// tests/fake-codex.ts and tests/fake-model.ts.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SIGNED_OUT, type Entry } from "@rufi/contracts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Scenario } from "../../tests/fake-codex.ts";
import {
  fakeModel,
  NOTE,
  THINKING,
  type FakeModel,
} from "../../tests/fake-model.ts";
import { callTool, type McpServerConfig } from "../../tests/mcp-client.ts";
import { rufiAiFor } from "../../tests/rufi-ai.ts";
import { codexBinary } from "../agent/codex/binary.ts";
import type { ProviderAdapter } from "@rufi/agents/provider";
import { codexAdapter, instructionsNote } from "../agent/codex/adapter.ts";
import type { Deadlines } from "../agent/codex/appserver.ts";
import type { SubAgentTask } from "../agent/runtime.ts";
import {
  readPage,
  scriptedReader,
  type Script,
} from "../../tests/fake-reader.ts";
import { copies } from "../core/documents/copies.ts";
import { copyReader } from "../core/documents/copy-reader.ts";
import { readings } from "../core/documents/reading.ts";
import { addSent } from "../../tests/sent.ts";
import { reader as documentReaderOf } from "./reader.ts";
import {
  transcripts as openTranscripts,
  type ChatRow,
  type Transcripts,
} from "../core/chat/transcript.ts";
import { documents } from "../core/documents/documents.ts";
import { deletions } from "../core/documents/delete.ts";
import { fileGate } from "../core/documents/gate.ts";
import { pages } from "../core/documents/pages.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "../core/store/database.ts";
import { forAgent, rufiCaller } from "../core/tools/tools.ts";
import { v7 as uuid } from "uuid";
import { chatQueue, type ChatQueue } from "../core/chat/queue.ts";
import { chatAgents } from "../core/chat/agents.ts";
import { agentsPath } from "./agents.ts";
import { chat as openChat, type Chat } from "./chat.ts";
import { subAgents } from "./sub-agents.ts";
import { agentSetup } from "./core.ts";
import { mcpEndpoint, mcpKeys, serveMcp } from "./mcp.ts";

const FAKE = join(import.meta.dirname, "../../tests/fake-codex.ts");
const ALLOWED = ["gpt-6.1-sol", "gpt-6-astra"];

let home: string;
let store: Store;
let transcripts: Transcripts;
let queue: ChatQueue;
let chat: Chat | undefined;
let ai: Awaited<ReturnType<typeof rufiAiFor>> | undefined;
/** The chat's Codex, behind the provider boundary. */
let codex: ProviderAdapter | undefined;
/** Whether the person is signed in, as the chat asks it. */
let signedIn: boolean;
let model: FakeModel | undefined;
let token: string;
let tokenGate: Promise<void> | undefined;
/** Calls of Rufi's tools the chat admitted, as they start. */
let admitted: string[];
/** Rufi's MCP server for this run of the chat, as the core serves it. */
let served: { port: number; close: () => Promise<void> } | undefined;
/** The runs of Rufi's reader, in order. */
let readerRuns: SubAgentTask[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-chat-"));
  store = openWritable(databasePath(home));
  store.db.exec(`
    INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
    INSERT INTO chats (id, person_id, created_at)
      VALUES ('c-asha', 'asha', '2026-10-01T09:00:00Z');
  `);
  transcripts = openTranscripts(store);
  queue = chatQueue(store);
  signedIn = true;
  token = "token";
  tokenGate = undefined;
  admitted = [];
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
});

interface Backend {
  name: "fake" | "real";
  /** The text each new thread's first message carried before the user's words. */
  contexts: () => Promise<string[]>;
  /** The effort each reply ran with, in order. */
  efforts: () => Promise<(string | null)[]>;
  /** The model each reply ran with, in order. */
  models: () => Promise<string[]>;
  /** Rufi's rules the AI had in each reply, in order. */
  rules: () => Promise<string[]>;
}

/** Starts the chat (again, as after a restart) on the backend. */
async function startChat(
  backend: Backend["name"],
  options: {
    scenario?: Scenario;
    deadlines?: Partial<Deadlines>;
    /** How long Rufi's tools take. */
    toolMs?: number;
    /** How long the agent waits for a call's answer. */
    doorMs?: number;
    /** What a call of this tool waits for before it runs. */
    waitFor?: (tool: string) => Promise<void> | undefined;
    allowlist?: string[];
    /** Names this Rufi's rules: another one is an update. */
    rules?: string;
    /** The sign-in's token decision, at the external edge. */
    tokenProvider?: () => Promise<string>;
    /** What Rufi's reader does in each run (tests/fake-reader.ts). */
    reader?: Script[];
    /** The agent database is lost while Rufi is closed. */
    loseAgents?: boolean;
  } = {},
): Promise<Chat> {
  const again = chat !== undefined;
  await chat?.close();
  await ai?.close();
  await served?.close();
  if (options.loseAgents) {
    for (const end of ["", "-wal", "-shm"]) {
      await rm(`${agentsPath(home)}${end}`, { force: true });
    }
  }
  const reader = openReadOnly(databasePath(home));
  const log = () => undefined;
  const tools = forAgent(() => ({ store: reader, personId: undefined }), log);
  const keys = mcpKeys();
  let port = 0;
  served = await serveMcp(
    mcpEndpoint({
      keys,
      port: () => port,
      log,
      ...(options.doorMs !== undefined && { toolMs: options.doorMs }),
    }),
  );
  port = served.port;
  if (backend === "real") model ??= await fakeModel();
  const command =
    backend === "fake"
      ? { file: process.execPath, args: [FAKE] }
      : {
          file: await codexBinary(),
          args: [
            "-c",
            `model_providers.openai_chatgpt_plan.base_url="${model?.url ?? ""}"`,
          ],
        };
  const reads = readings(store);
  const fakeReader = scriptedReader(options.reader ?? []);
  readerRuns = fakeReader.runs;
  const documentReader = documentReaderOf({
    readings: reads,
    kind: copyReader(pages(store, home), copies(store)),
    run: fakeReader.run,
    choice: () => Promise.resolve({ model: "gpt-6.1-sol", effort: "low" }),
    mcp: { url: () => `http://127.0.0.1:${String(port)}/mcp/reader`, keys },
    log,
    retryWaitsMs: [],
  });
  codex = codexAdapter({
    home,
    ...agentSetup(home),
    command,
    env: {
      PATH: process.env["PATH"] ?? "",
      FAKE_CODEX: JSON.stringify(options.scenario ?? {}),
      FAKE_CODEX_LOG: join(home, "fake.jsonl"),
    },
    token: async () => {
      await tokenGate;
      return options.tokenProvider?.() ?? token;
    },
    version: "0.0.0",
    deadlines: { requestMs: 10_000, turnMs: 20_000, ...options.deadlines },
    log,
  });
  const system = await rufiAiFor({
    home,
    record: store,
    transcripts,
    adapter: codex,
    tools: tools.specs.map((spec) => spec.name),
  });
  ai = system;
  // As the core does when it starts again, once Rufi has read the agent
  // database's events.
  if (again) {
    await transcripts.interruptRunning();
    await queue.endStopped("Rufi closed while reading.");
  }
  chat = openChat({
    transcripts,
    queue,
    ...(options.reader && {
      reading: { readings: reads, read: documentReader.read },
    }),
    signedIn: () => Promise.resolve(signedIn),
    agent: ai.agent,
    allowlist: options.allowlist ?? ALLOWED,
    mcp: { url: () => `http://127.0.0.1:${String(port)}/mcp`, keys },
    rules: (region) => ({
      instructions: `Rufi's rules ${options.rules ?? "1"}, for ${region ?? "no region"}.`,
      version: `rules-${options.rules ?? "1"}-${region ?? ""}`,
    }),
    tools: {
      specs: tools.specs,
      caller: (scope, origin) => {
        const call = rufiCaller(
          reader,
          transcripts,
          log,
          reader && pages(reader, home),
          undefined,
          subAgents({ agents: system.agents, kept: chatAgents(store), queue }),
        )(scope, origin);
        return async (name, input, callId) => {
          admitted.push(name);
          await options.waitFor?.(name);
          await sleep(options.toolMs ?? 0);
          return call(name, input, callId);
        };
      },
    },
    log,
  });
  await ai.recover();
  await chat.carryAll();
  await ai.dispatch();
  return chat;
}

function backendOf(name: Backend["name"]): Backend {
  return {
    name,
    contexts: async () => {
      if (name === "real") {
        return (model?.requests ?? []).flatMap((request) => {
          const users = request.input.filter((item) => item.role === "user");
          const texts = users.flatMap((item) =>
            (item.content ?? []).map((part) => part.text ?? ""),
          );
          return texts.filter((text) =>
            text.includes("Older history is available"),
          );
        });
      }
      const lines = (await readFile(join(home, "fake.jsonl"), "utf8"))
        .trim()
        .split("\n");
      return lines.flatMap((line) => {
        const entry = JSON.parse(line) as {
          received?: {
            method?: string;
            params?: { input?: { text: string }[] };
          };
        };
        const input =
          entry.received?.method === "turn/start"
            ? entry.received.params?.input
            : undefined;
        return input && input.length > 1 ? [input[0]?.text ?? ""] : [];
      });
    },
    efforts: async () =>
      name === "real"
        ? (model?.requests ?? []).map(
            (request) => request.reasoning?.effort ?? null,
          )
        : (await turnsRun()).map((turn) => turn.effort ?? null),
    models: async () =>
      name === "real"
        ? (model?.requests ?? []).map((request) => request.model ?? "")
        : (await turnsRun()).map((turn) => turn.model ?? ""),
    rules: async () =>
      name === "real"
        ? (model?.requests ?? []).map((request) =>
            request.input
              .filter((item) => item.role === "developer")
              .flatMap((item) => item.content ?? [])
              .map((part) => part.text ?? "")
              .filter((text) => text.includes("Rufi's rules"))
              .join(" + "),
          )
        : (await turnsRun()).map((turn) => turn.told ?? ""),
  };
}

/** The turns the scripted Codex ran, as it logged them. */
async function turnsRun() {
  const lines = (await readFile(join(home, "fake.jsonl"), "utf8"))
    .trim()
    .split("\n");
  return lines.flatMap((line) => {
    const entry = JSON.parse(line) as {
      turn?: string;
      effort?: string;
      model?: string;
      told?: string;
    };
    return entry.turn === undefined ? [] : [entry];
  });
}

/** The AI saves the nausea the user told it about. */
const saveNausea = {
  tool: "save_changes",
  arguments: {
    changes: [{ kind: "symptom", action: "add", fields: { name: "Nausea" } }],
  },
};

/** The AI saves a headache the user told it about. */
const saveHeadache = {
  tool: "save_changes",
  arguments: {
    changes: [
      {
        kind: "symptom",
        action: "add",
        fields: { name: "Headache" },
      },
    ],
  },
};

/** Sends a message from the box, by a new send id. */
const say = (c: ChatRow, text: string) => {
  if (!chat) throw new Error("no chat");
  return chat.send(c, uuid(), text);
};

/**
 * A reply Rufi started, with its note: "hang" runs until it is stopped. A
 * message the person sends meanwhile waits for a reply of its own.
 */
const rufiReply = async (c: ChatRow, note = "Rufi's note: hang") => {
  if (!chat) throw new Error("no chat");
  await chat.event("asha", { kind: "test", line: "Rufi's line", ask: note });
  // Codex starts for this first reply; a busy machine needs longer than for
  // a reply's later steps, as long as a send was given before.
  await until(
    async () =>
      (await transcript(c.id)).turns.some((t) => t.status === "running"),
    45_000,
  );
};

/** What waits in the chat's queue, as [text, state, held]. */
const waiting = async () =>
  (await queue.list(await chatRow())).items.map((item) => [
    item.text,
    item.state,
    item.held,
  ]);

/**
 * Rufi's id for a call of the chat's own agent, from the provider's:
 * `<agent>/<conversation>/<call>`.
 */
function ownCall(call: string, chatId = "c-asha", conversation = 1): string {
  const owner = store.db
    .prepare("SELECT agent_id FROM agent_owners WHERE chat_id = ? AND root = 1")
    .get(chatId);
  return `${String(owner?.["agent_id"])}/${String(conversation)}/${call}`;
}

/** The agents in the agent database, oldest first. */
function agentRows(): Record<string, unknown>[] {
  const db = new DatabaseSync(agentsPath(home), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id, parent_id, title, status, result FROM agents ORDER BY rowid",
      )
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

/** The thread's files are gone: Codex has no record of the chat's thread. */
async function loseThread(chatId?: string): Promise<void> {
  const { threadId } = await chatRow(chatId);
  if (!codex || threadId === null) throw new Error("no thread");
  await codex.delete(threadId);
}

/** Asha's chat, as stored now. */
const chatRow = async (_id?: string): Promise<ChatRow> => {
  const found = await transcripts.chat("asha");
  if (!found) throw new Error("no chat");
  return found;
};

const newChat = () => chatRow();

/** The transcript as [kind, text] pairs, and the turns' statuses. */
async function transcript(id: string) {
  const snapshot = await transcripts.page(await chatRow(id));
  return {
    entries: snapshot.entries.map((e: Entry) => [e.kind, e.text]),
    turns: snapshot.turns,
    all: snapshot.entries,
  };
}

async function until(
  ready: () => Promise<boolean>,
  ms = 20_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ready().catch(() => false))) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
}

/** How many agent threads the chat's replies ran on. */
const threadsUsed = () =>
  (
    store.db
      .prepare("SELECT COUNT(DISTINCT thread_id) AS n FROM turns")
      .get() as {
      n: number;
    }
  ).n;

/** Waits until `n` replies have ended. */
const ended = (id: string, n = 1) =>
  until(
    async () =>
      (await transcript(id)).turns.filter((t) => t.status !== "running")
        .length >= n,
  );
const running = (id: string) =>
  until(async () =>
    (await transcript(id)).turns.some((t) => t.status === "running"),
  );

describe.each(["fake", "real"] as const)("the chat on the %s Codex", (name) => {
  const backend = backendOf(name);
  const timeout = { timeout: 60_000 };

  it.each(["before its first turn", "between messages"])(
    "sends once in the same thread when the sign-in renews %s, with its record tools",
    timeout,
    async (when) => {
      // A selected model makes thread creation the first readiness decision.
      await transcripts.setModel(await chatRow(), "gpt-6.1-sol");
      let tokenCalls = 0;
      await startChat(name, {
        tokenProvider: () =>
          Promise.resolve(
            when === "before its first turn"
              ? ++tokenCalls === 1
                ? "token"
                : "renewed-token"
              : token,
          ),
        scenario: {
          callsByTurn: [
            [{ id: "read-first", tool: "get_overview", arguments: {} }],
            [{ id: "read-second", tool: "get_overview", arguments: {} }],
          ],
        },
      });
      const c = await newChat();
      await say(c, "overview first");
      await until(
        async () =>
          (await transcript(c.id)).turns.length > 0 ||
          (await queue.list(c)).items.some((item) => item.held !== null),
      );
      expect((await queue.list(c)).items.map((item) => item.heldText)).toEqual(
        [],
      );
      await ended(c.id);
      const thread = (await chatRow()).threadId;
      expect(thread).not.toBeNull();

      token = "renewed-token";
      await say(await chatRow(), "overview second");
      await until(async () => {
        const waiting = await queue.list(await chatRow());
        return (
          (await transcript(c.id)).turns.length === 2 ||
          waiting.items.some((item) => item.held !== null)
        );
      });
      // A failed hand-over reports its reason here instead of answering.
      expect(
        (await queue.list(await chatRow())).items.map((item) => item.heldText),
      ).toEqual([]);
      await ended(c.id, 2);
      expect((await chatRow()).threadId).toBe(thread);
      const { all, turns } = await transcript(c.id);
      expect(
        all
          .filter((entry) => entry.kind === "message" || entry.kind === "reply")
          .map((entry) => [entry.kind, entry.text]),
      ).toEqual([
        ["message", "overview first"],
        ["reply", "ok:overview first"],
        ["message", "overview second"],
        ["reply", "ok:overview second"],
      ]);
      expect(turns.map((turn) => [turn.status, turn.newThread])).toEqual([
        ["completed", false],
        ["completed", false],
      ]);
      // Each reply read the overview with Rufi's tools.
      expect(
        store.db
          .prepare(
            "SELECT turn_id FROM tool_calls WHERE tool = 'get_overview' AND ok = 1 ORDER BY started_at",
          )
          .all()
          .map((row) => row["turn_id"]),
      ).toEqual(turns.map((turn) => turn.id));
    },
  );

  it("stores each part of a reply before it is shown", timeout, async () => {
    await startChat(name);
    const c = await newChat();
    const shown: Entry[] = [];
    let unsaved = 0;
    transcripts.subscribe(c.id, (change) => {
      // What is shown is already in the database, exactly so; steps show as
      // the agent reports them, and the agent database keeps them.
      const rows = store.db
        .prepare("SELECT id, text FROM transcript_entries WHERE chat_id = ?")
        .all(c.id) as { id: string; text: string }[];
      for (const entry of change.entries) {
        if (entry.kind === "activity" || entry.kind === "reasoning") continue;
        if (rows.find((row) => row.id === entry.id)?.text !== entry.text)
          unsaved++;
        shown.push(entry);
      }
    });
    await say(c, "Hello");
    await ended(c.id);
    expect(unsaved).toBe(0);
    expect(shown.length).toBeGreaterThan(0);
    const { entries, turns } = await transcript(c.id);
    expect(entries.filter(([kind]) => kind !== "activity")).toEqual([
      ["message", "Hello"],
      ["reply", "ok:Hello"],
    ]);
    expect(turns).toMatchObject([
      { status: "completed", model: "gpt-6.1-sol", endReason: null },
    ]);
  });

  it(
    "shows the AI's reasoning summary as it streams, then whole",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      const shown: [string, string | null][] = [];
      transcripts.subscribe(c.id, (change) => {
        for (const entry of change.entries) {
          if (entry.kind === "reasoning")
            shown.push([entry.text, entry.status]);
        }
      });
      await say(c, "think");
      await ended(c.id);
      const whole = THINKING.join("\n\n");
      // Thinking from its start, its summary growing, until it is whole.
      expect(shown[0]?.[1]).toBe("running");
      expect(shown.at(-1)).toEqual([whole, "done"]);
      for (const [i, [text]] of shown.entries()) {
        expect(whole.startsWith(text)).toBe(true);
        expect(text.length).toBeGreaterThanOrEqual(
          shown[i - 1]?.[0].length ?? 0,
        );
      }
      expect(
        (await transcript(c.id)).entries.filter(
          ([kind]) => kind !== "activity",
        ),
      ).toEqual([
        ["message", "think"],
        ["reasoning", whole],
        ["reply", "ok:think"],
      ]);
    },
  );

  it.each(["commentary", "seeded commentary"])(
    "keeps the AI's progress note as a step of the reply's Activity, as it streams, and its answer as the one reply, with How (%s)",
    timeout,
    async (text) => {
      await startChat(name);
      const c = await newChat();
      const shown: Entry[] = [];
      transcripts.subscribe(c.id, (change) => shown.push(...change.entries));
      await say(c, `${text}\n\n\`\`\`rufi-basis\nFrom the note test.\n\`\`\``);
      await ended(c.id);
      const { all, turns } = await transcript(c.id);
      expect(
        all
          .filter((e) => e.kind === "reply" || e.activity === "note")
          .map((e) => [e.kind, e.activity, e.text, e.status]),
      ).toEqual([
        ["activity", "note", NOTE, "done"],
        ["reply", null, `ok:${text}`, null],
      ]);
      expect(turns[0]?.how).toBe("From the note test.");
      // Never a reply, not even while it streamed; it grew as it came.
      expect(
        shown.some((e) => e.kind === "reply" && e.text.includes("Checking")),
      ).toBe(false);
      const note = shown.filter((e) => e.activity === "note");
      expect(note[0]?.status).toBe("running");
      expect(note.map((e) => e.text)).toContain(NOTE.slice(0, 9));
    },
  );

  it(
    "keeps a progress note that arrives only whole as a step, not a reply",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "whole commentary");
      await ended(c.id);
      expect(
        (await transcript(c.id)).all
          .filter((e) => e.kind === "reply" || e.activity === "note")
          .map((e) => [e.kind, e.activity, e.text, e.status]),
      ).toEqual([
        ["activity", "note", NOTE, "done"],
        ["reply", null, "ok:whole commentary", null],
      ]);
    },
  );

  it.each(["cut commentary", "seeded cut commentary"])(
    "keeps half a progress note as a stopped step when the reply is stopped, also after a restart (%s)",
    timeout,
    async (text) => {
      await startChat(name);
      const c = await newChat();
      const shown: Entry[] = [];
      transcripts.subscribe(c.id, (change) => shown.push(...change.entries));
      await say(c, text);
      await until(() =>
        Promise.resolve(shown.some((e) => e.activity === "note")),
      );
      await chat?.stop(c);
      await ended(c.id);
      const notes = async () =>
        (await transcript(c.id)).all
          .filter((e) => e.kind !== "message")
          .map((e) => [e.kind, e.activity, e.text, e.status]);
      expect(await notes()).toEqual([
        ["activity", "note", NOTE.slice(0, 9), "stopped"],
      ]);
      await startChat(name);
      expect(await notes()).toEqual([
        ["activity", "note", NOTE.slice(0, 9), "stopped"],
      ]);
    },
  );

  it(
    "holds a message sent during a reply; after Stop, it goes next",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await rufiReply(c);
      await say(c, "B");
      expect(await waiting()).toEqual([["B", "waiting", null]]);
      // A waiting message is not in the transcript.
      expect(
        (await transcript(c.id)).entries.filter(([kind]) => kind === "message"),
      ).toEqual([]);
      await chat?.stop(c);
      await ended(c.id, 2);
      expect((await transcript(c.id)).turns[0]).toMatchObject({
        status: "interrupted",
        endReason: "stopped",
      });
      expect(
        (await transcript(c.id)).entries.filter(
          ([kind]) => kind === "message" || kind === "reply",
        ),
      ).toEqual([
        ["message", "B"],
        ["reply", "ok:B"],
      ]);
      expect(await waiting()).toEqual([]);
    },
  );

  it(
    "keeps one thread when two first messages are sent at once",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      // Two requests, each with the chat as it read it.
      const again = await chatRow(c.id);
      await Promise.all([say(c, "slow first"), say(again, "B")]);
      await ended(c.id, 2);
      const { entries, turns } = await transcript(c.id);
      expect(
        entries.filter(([kind]) => kind === "message" || kind === "reply"),
      ).toEqual([
        ["message", "slow first"],
        ["reply", "ok:slow first"],
        ["message", "B"],
        ["reply", "ok:B"],
      ]);
      expect(turns.map((t) => t.status)).toEqual(["completed", "completed"]);
    },
  );

  it(
    "sends with the new model when the model changed after the request read the chat",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await Promise.all([chat?.selectModel(c, "gpt-6-astra"), say(c, "Hello")]);
      await ended(c.id);
      expect((await transcript(c.id)).turns).toMatchObject([
        { model: "gpt-6-astra" },
      ]);
    },
  );

  it(
    "sends a waiting message now; the others follow in order",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await rufiReply(c);
      await say(c, "B");
      await say(c, "C");
      const { items } = await queue.list(c);
      await chat?.queue.sendNow(
        c,
        items.find((item) => item.text === "C")?.id ?? "",
      );
      await chat?.stop(c);
      await ended(c.id, 3);
      expect(
        (await transcript(c.id)).entries
          .filter(([kind]) => kind === "message")
          .map(([, text]) => text),
      ).toEqual(["C", "B"]);
    },
  );

  it(
    "a message sent while a reply runs goes into that reply; one sent after goes as a new message",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "slow");
      await running(c.id);
      await say(c, "shorter please");
      await ended(c.id);
      const { entries } = await transcript(c.id);
      expect(entries).toContainEqual(["steer", "shorter please"]);
      expect(entries).toContainEqual(["reply", "ok:shorter please"]);
      await say(c, "after");
      await ended(c.id, 2);
      expect((await transcript(c.id)).entries).toContainEqual([
        "reply",
        "ok:after",
      ]);
    },
  );

  it(
    "hands nothing over when Stop comes while the message is getting ready; it waits, not sent, and goes once when sent now",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await chat?.selectModel(c, "gpt-6.1-sol");
      // Its conversation opens: Codex waits for a token.
      const gate = Promise.withResolvers<undefined>();
      tokenGate = gate.promise;
      await say(await chatRow(c.id), "Hello");
      await until(async () => (await chat?.agent.busy(c)) === true);
      const stopping = chat?.stop(c);
      gate.resolve(undefined);
      await stopping;
      await until(async () => (await waiting())[0]?.[2] === "failed");
      expect((await transcript(c.id)).entries).toEqual([]);
      const [held] = (await queue.list(c)).items;
      expect(held).toMatchObject({
        text: "Hello",
        state: "waiting",
        heldText: "Not sent: stopped.",
      });
      await chat?.queue.sendNow(c, held?.id ?? "");
      await ended(c.id);
      expect(
        (await transcript(c.id)).entries.filter(
          ([kind]) => kind === "message" || kind === "reply",
        ),
      ).toEqual([
        ["message", "Hello"],
        ["reply", "ok:Hello"],
      ]);
    },
  );

  it("stops a reply that runs past its deadline", timeout, async () => {
    await startChat(name, { deadlines: { turnMs: 2_000 } });
    const c = await newChat();
    await say(c, "hang");
    await ended(c.id);
    expect((await transcript(c.id)).turns[0]).toMatchObject({
      status: "failed",
      endReason: "provider_failed",
      endText: "The reply took too long, so Rufi stopped it.",
    });
  });

  it(
    "keeps the thread on a model change: the next reply runs on the new model, with the whole chat",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "first");
      await ended(c.id, 1);
      await chat?.selectModel(c, "gpt-6-astra");
      await say(await chatRow(c.id), "after the switch");
      await ended(c.id, 2);
      const { turns } = await transcript(c.id);
      expect(turns.map((turn) => [turn.model, turn.newThread])).toEqual([
        ["gpt-6.1-sol", false],
        ["gpt-6-astra", false],
      ]);
      expect((await backend.models()).at(-1)).toBe("gpt-6-astra");
      // No new thread: nothing handed over to start it.
      expect(await backend.contexts()).toEqual([]);
    },
  );

  it(
    "tells the thread Rufi's new rules (a new emergency region, an update after a restart) and goes on in it",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "first");
      await ended(c.id, 1);
      await transcripts.saveSetting("emergency_region", "IN");
      await say(await chatRow(c.id), "second");
      await ended(c.id, 2);
      await startChat(name, { rules: "2" }); // Rufi updated.
      await say(await chatRow(c.id), "third");
      await ended(c.id, 3);
      const { turns, entries } = await transcript(c.id);
      // One thread, and Rufi's summaries aren't replies.
      expect(threadsUsed()).toBe(1);
      expect(turns.map((turn) => turn.newThread)).toEqual([
        false,
        false,
        false,
      ]);
      expect(entries.filter(([kind]) => kind === "reply")).toEqual([
        ["reply", "ok:first"],
        ["reply", "ok:second"],
        ["reply", "ok:third"],
      ]);
      // Each reply after a change had the new rules whole, as the last word.
      const rules = await backend.rules();
      expect(rules).toHaveLength(3);
      const regionNote = instructionsNote("Rufi's rules 1, for IN.");
      const updateNote = instructionsNote("Rufi's rules 2, for IN.");
      expect(rules[1]?.slice(-regionNote.length)).toBe(regionNote);
      expect(rules[2]?.slice(-updateNote.length)).toBe(updateNote);
    },
  );

  it(
    "starts a new thread, with the earlier chat, only when Codex has no record of the chat's thread",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "first");
      await ended(c.id, 1);
      await loseThread(c.id);
      await startChat(name);
      await say(await chatRow(c.id), "second");
      await ended(c.id, 2);
      expect((await queue.list(c)).items).toEqual([]);
      const { turns } = await transcript(c.id);
      expect(turns.map((turn) => turn.newThread)).toEqual([false, true]);
      expect((await backend.contexts()).at(-1)).toContain(
        "User: first\n\nAI: ok:first",
      );
    },
  );

  it(
    "runs each reply with the chat's effort: a new effort applies from the next reply, in the same thread",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "first");
      await ended(c.id, 1);
      await chat?.selectEffort(await chatRow(c.id), "high");
      await say(await chatRow(c.id), "second");
      await ended(c.id, 2);
      expect(await backend.efforts()).toEqual(["medium", "high"]);
      // No new thread: no earlier messages handed over, no quiet line.
      expect(await backend.contexts()).toEqual([]);
      const { turns } = await transcript(c.id);
      expect(turns.map((turn) => turn.newThread)).toEqual([false, false]);
      expect((await chatRow(c.id)).effort).toBe("high");
    },
  );

  it(
    "after a restart, what waited goes first, by itself, with the chat's effort",
    timeout,
    async () => {
      await startChat(name);
      await chat?.selectEffort(await newChat(), "high");
      const c = await chatRow();
      await rufiReply(c);
      await until(async () => (await backend.efforts()).length === 1);
      await say(c, "B");
      await startChat(name); // Rufi restarts.
      await ended(c.id, 2);
      expect((await transcript(c.id)).turns).toMatchObject([
        { status: "interrupted" },
        { status: "completed" },
      ]);
      await say(await chatRow(c.id), "C");
      await ended(c.id, 3);
      expect(
        (await transcript(c.id)).entries
          .filter(([kind]) => kind === "message")
          .map(([, text]) => text),
      ).toEqual(["B", "C"]);
      expect(await backend.efforts()).toEqual(["high", "high", "high"]);
    },
  );

  it(
    "refuses a model or effort change while a reply runs; the next reply runs on the new one",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await rufiReply(c);
      await until(async () => (await backend.efforts()).length === 1);
      await expect(chat?.selectModel(c, "gpt-6-astra")).rejects.toThrow(
        "Stop the reply before changing the model.",
      );
      await expect(chat?.selectEffort(c, "low")).rejects.toThrow(
        "Stop the reply before changing the effort.",
      );
      await chat?.stop(c);
      await ended(c.id);
      await expect(chat?.selectModel(c, "gpt-5.5")).rejects.toThrow(
        "That model isn't allowed or isn't offered now.",
      );
      await chat?.selectModel(c, "gpt-6-astra");
      await chat?.selectEffort(c, "low");
      await say(await chatRow(), "C");
      await ended(c.id, 2);
      expect((await transcript(c.id)).turns.map((t) => t.model)).toEqual([
        "gpt-6.1-sol",
        "gpt-6-astra",
      ]);
      expect((await backend.efforts()).at(-1)).toBe("low");
    },
  );

  it(
    "saves the first message after a restart with its own turn, never as a gap the history read found",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "first");
      await ended(c.id);
      await startChat(name); // Rufi restarts.
      await say(await chatRow(c.id), "after restart");
      await ended(c.id, 2);
      expect(
        store.db
          .prepare(
            "SELECT e.text, t.agent_turn_id IS NOT NULL AS in_turn FROM transcript_entries e LEFT JOIN turns t ON t.id = e.turn_id WHERE e.kind = 'message' ORDER BY e.seq",
          )
          .all()
          .map((row) => ({ ...row })),
      ).toEqual([
        { text: "first", in_turn: 1 },
        { text: "after restart", in_turn: 1 },
      ]);
    },
  );
});

it(
  "gives a page image to the code-mode chat without keeping its bytes in calls or activity",
  { timeout: 60_000 },
  async () => {
    const bytes = await readFile(
      join(
        import.meta.dirname,
        "../../tests/fixtures/documents/thyroid-recheck.jpg",
      ),
    );
    const [documentId = ""] = (
      await addSent(
        documents(store, home),
        store,
        "asha",
        [{ name: "Fictional thyroid.jpg", bytes: new Uint8Array(bytes) }],
        false,
      )
    ).added;
    const imageUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    model = await fakeModel({
      script: [
        {
          exec: `const result = await tools.mcp__rufi__get_documents({document: ${JSON.stringify(documentId)}, page: 1}); for (const part of result.content) if (part.type === "image") image(part);`,
        },
        { text: "Done." },
      ],
    });
    await startChat("real");
    const c = await newChat();
    await say(c, "Look at the fictional document's first page.");
    await ended(c.id);
    const output = model.requests.at(-1)?.input.at(-1)?.output;
    expect(output).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "input_image", image_url: imageUrl }),
      ]),
    );
    const calls = store.db
      .prepare("SELECT * FROM tool_calls WHERE chat_id = ?")
      .all(c.id);
    expect(calls).toMatchObject([{ tool: "get_documents", ok: 1 }]);
    const snapshot = await transcript(c.id);
    expect(snapshot.turns).toMatchObject([
      { status: "completed", model: "gpt-6.1-sol" },
    ]);
    expect(
      snapshot.all.filter((entry) => entry.activity === "tool"),
    ).toMatchObject([{ text: "rufi.get_documents", status: "done" }]);
    // Both stored forms and the activity a person can read must omit the payload.
    const persisted = store.db
      .prepare("SELECT * FROM transcript_entries WHERE chat_id = ?")
      .all(c.id);
    for (const value of [calls, persisted, snapshot.all]) {
      const kept = JSON.stringify(value);
      expect(kept).not.toContain("data:image/");
      expect(kept).not.toContain(bytes.toString("base64"));
    }
  },
);

describe("the chat, on the scripted Codex", () => {
  /** Each turn/start's input texts, in order. */
  const inputs = async () =>
    (await readFile(join(home, "fake.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .flatMap((line) => {
        const entry = JSON.parse(line) as {
          received?: {
            method?: string;
            params?: { input?: { text: string }[] };
          };
        };
        return entry.received?.method === "turn/start"
          ? [(entry.received.params?.input ?? []).map((part) => part.text)]
          : [];
      });

  /** A test producer: a finished piece of background work that asks the AI. */
  const event = (line: string) =>
    chat?.event("asha", {
      kind: "test",
      line,
      facts: { line },
      ask: `Note: ${line}`,
    });

  it("sends a message's chips with it: the AI gets them after the words, and the message keeps them with their versions then; a report's chip counts its current results", async () => {
    store.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('ravi', 'Ravi Fictional');
      INSERT INTO files (id, size, media_type, created_at) VALUES ('f-1', 1, 'application/pdf', '2026-10-01T09:00:00Z');
      INSERT INTO documents (id, person_id, added_at, added_from, version, sent_at) VALUES
        ('doc-1', 'asha', '2026-10-01T09:00:00Z', 'chat', 3, '2026-10-01T09:00:00Z'),
        ('doc-r', 'ravi', '2026-10-01T09:00:00Z', 'chat', 1, '2026-10-01T09:00:00Z');
      INSERT INTO document_pages (person_id, document_id, position, file_id, page_in_file, file_name) VALUES
        ('asha', 'doc-1', 1, 'f-1', 1, 'Sunrise Labs August.pdf'),
        ('ravi', 'doc-r', 1, 'f-1', 1, 'Ravi lipid panel.pdf');
      INSERT INTO results (id, person_id, category, test_name, value_text, unit, measured_at, entered_at)
        VALUES ('res-1', 'asha', 'lab', 'HbA1c', '6.8', '%', '2026-08-12', '2026-08-13T00:00:00Z');
      INSERT INTO reports (id, person_id, document_id, issuer, collected) VALUES
        ('rep-1', 'asha', 'doc-1', 'Sunrise Labs', '2026-08-12'),
        ('rep-r', 'ravi', 'doc-r', 'Lakeside Diagnostics', '2026-06-30');
      INSERT INTO results (id, person_id, report_id, category, test_name, value_text, unit, measured_at, entered_at, replaces_id, removed) VALUES
        ('res-2', 'asha', 'rep-1', 'lab', 'Glucose', '118', 'mg/dL', '2026-08-12', '2026-08-13T00:00:00Z', NULL, 0),
        ('res-3', 'asha', 'rep-1', 'lab', 'CRP', '<5', 'mg/L', '2026-08-12', '2026-08-13T00:00:00Z', NULL, 0),
        ('res-4', 'asha', 'rep-1', 'lab', 'TSH', '2.1', 'mIU/L', '2026-08-12', '2026-08-13T00:00:00Z', NULL, 1);
      INSERT INTO documents (id, person_id, added_at, added_from, kind, date, issuer, report_number, version, sent_at)
        VALUES ('doc-correction', 'asha', '2026-10-01T09:00:00Z', 'chat', 'lab_report', '2026-08-12', 'Sunrise Labs', 'CORRECTED', 1, '2026-10-01T09:00:00Z');
      INSERT INTO files (id, size, media_type, created_at)
        VALUES ('f-correction', 1, 'application/pdf', '2026-10-01T09:00:00Z');
      INSERT INTO document_pages (person_id, document_id, position, file_id, page_in_file, file_name, state)
        VALUES ('asha', 'doc-correction', 1, 'f-correction', 1, 'Corrected report.pdf', 'read');
      INSERT INTO jobs (id, person_id, kind, document_id, state, targets, sorted_at, created_at)
        VALUES ('job-correction', 'asha', 'document_read', 'doc-correction', 'done', '[1]', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z');
      INSERT INTO page_copies (person_id, file_id, page_in_file, job_id, attempt, outcome, copy, saved_at)
        VALUES ('asha', 'f-correction', 1, 'job-correction', 1, 'read', 'Sunrise Labs · CORRECTED · Collected 12/08/2026 · CRP 4 mg/L', '2026-10-01T09:00:00Z');
      INSERT INTO draft_items (id, person_id, document_id, page, seq, job_id, kind, fields, original, quote, created_at)
        VALUES ('item-correction', 'asha', 'doc-correction', 1, 1, 'job-correction', 'lab_result',
          '{"test_name":"CRP","value_text":"4","unit":"mg/L","date":{"label":"Collected","date":"12/08/2026","iso":"2026-08-12"}}',
          '{"test_name":"CRP","value_text":"4","unit":"mg/L","date":{"label":"Collected","date":"12/08/2026","iso":"2026-08-12"}}',
          'CRP 4 mg/L', '2026-10-01T09:00:00Z');
    `);
    await startChat("fake");
    const c = await newChat();
    // A report's version is the last save that changed any of its results,
    // also one it took out.
    store.db.exec(`
      INSERT INTO operations (id, seq, person_id, chat_id, call_id, request, created_at) VALUES
        ('op-1', 1, 'asha', '${c.id}', 'call-1', '{}', '2026-08-13T00:00:00Z'),
        ('op-2', 2, 'asha', '${c.id}', 'call-2', '{}', '2026-08-14T00:00:00Z');
      INSERT INTO record_changes (operation_id, seq, person_id, kind, record_id, action, after) VALUES
        ('op-2', 1, 'asha', 'result', 'res-4', 'remove', '{}'),
        ('op-1', 1, 'asha', 'result', 'res-2', 'add', '{}');
    `);
    const id = uuid();
    await chat?.send(c, id, "Save it", [
      { type: "document", id: "doc-1" },
      { type: "record", kind: "result", id: "res-1" },
      { type: "report", id: "rep-1" },
    ]);
    await ended(c.id);
    expect((await inputs()).at(-1)).toEqual([
      "Save it\n\nReferences the user added to this message (Rufi's, exact: read them with your tools):\n- document doc-1, version 3: Sunrise Labs August.pdf\n- result res-1 (kind result), version null: HbA1c 6.8 % · 12 Aug 2026\n- report rep-1, version op-2: Sunrise Labs · 12 Aug 2026 · 2 results",
    ]);
    // The message shows its words and its chips, as they were when sent.
    store.db.exec("UPDATE documents SET version = 4 WHERE id = 'doc-1'");
    const message = (await transcript(c.id)).all.find((e) => e.id === id);
    expect(message).toMatchObject({
      text: "Save it",
      refs: [
        {
          ref: { type: "document", id: "doc-1", version: 3 },
          label: "Sunrise Labs August.pdf",
          detail: "Document",
        },
        {
          ref: { type: "record", kind: "result", id: "res-1", version: null },
          label: "HbA1c 6.8 % · 12 Aug 2026",
          detail: "Lab result in your health record",
        },
        {
          ref: { type: "report", id: "rep-1", version: "op-2" },
          label: "Sunrise Labs · 12 Aug 2026 · 2 results",
          detail: "Report in your health record",
        },
      ],
    });
    // Another person's document or report is refused, and nothing waits.
    for (const theirs of [
      { type: "document", id: "doc-r" },
      { type: "report", id: "rep-r" },
    ] as const) {
      await expect(chat?.send(c, uuid(), "And this", [theirs])).rejects.toThrow(
        "Something added to this message isn't in this person's record. Take it out of the message and add it again.",
      );
    }
    expect(await waiting()).toEqual([]);

    // A replacement changes this report's current results even when the
    // replacement is typed, or belongs to a different report. Exercise
    // real saves and the chips sent afterwards, including undo and restore.
    let turns = 1;
    const save = async (text: string, input: unknown) => {
      const callId = uuid();
      await startChat("fake", {
        scenario: {
          calls: [
            {
              id: callId,
              tool: "save_changes",
              arguments: input,
            },
          ],
        },
      });
      await say(c, text);
      await ended(c.id, ++turns);
      const call = store.db
        .prepare("SELECT answer FROM tool_calls WHERE call_id = ?")
        .get(ownCall(callId));
      const answer = JSON.parse(String(call?.["answer"])) as {
        ok: boolean;
        result: { changes: { id: string }[] };
      };
      expect(answer).toMatchObject({ ok: true });
      const receipt = (await transcript(c.id)).all
        .filter((e) => e.kind === "receipt")
        .at(-1);
      expect(receipt).toBeDefined();
      return { version: receipt?.id, id: answer.result.changes[0]?.id };
    };
    const checkReport = async (version: string | undefined, count: number) => {
      const messageId = uuid();
      await chat?.send(c, messageId, "quiet: read this report", [
        { type: "report", id: "rep-1" },
      ]);
      await ended(c.id, ++turns);
      expect(
        (await transcript(c.id)).all.find((e) => e.id === messageId)?.refs,
      ).toEqual([
        {
          ref: { type: "report", id: "rep-1", version },
          label: `Sunrise Labs · 12 Aug 2026 · ${String(count)} ${count === 1 ? "result" : "results"}`,
          detail: "Report in your health record",
        },
      ]);
    };
    for (const amendment of [
      {
        text: "The lab corrected my glucose to 116",
        input: {
          changes: [
            {
              kind: "result",
              action: "add",
              fields: {
                test: "Glucose",
                value: "116",
                unit: "mg/dL",
                replaces: "res-2",
              },
            },
          ],
        },
        count: 1,
      },
      {
        text: "That report corrects my CRP",
        input: {
          items: [
            {
              item: "item-correction",
              version: 1,
              as: "correction",
              record: { id: "res-3", version: null },
            },
          ],
        },
        count: 0,
      },
    ]) {
      const added = await save(amendment.text, amendment.input);
      await checkReport(added.version, amendment.count);
      const undone = await save("Undo that amendment", {
        changes: [
          {
            kind: "result",
            action: "remove",
            id: added.id,
          },
        ],
      });
      expect(undone.version).not.toBe(added.version);
      await checkReport(undone.version, amendment.count + 1);
      const restored = await save("Put that amendment back", {
        changes: [
          {
            kind: "result",
            action: "restore",
            id: added.id,
          },
        ],
      });
      expect(restored.version).not.toBe(undone.version);
      await checkReport(restored.version, amendment.count);
    }
  });

  it("gives each Rufi event that came during a reply to the AI after it, in a turn of its own that can only read", async () => {
    await startChat("fake", { scenario: { calls: [saveHeadache] } });
    const c = await newChat();
    await say(c, "slow quiet");
    await running(c.id);
    await event("Lab report read");
    await event("Second report read");
    await ended(c.id, 3);
    await sleep(300);
    const { entries, turns, all } = await transcript(c.id);
    // A turn for each, started by Rufi; never the person's message.
    expect(turns).toHaveLength(3);
    expect(entries.filter(([kind]) => kind === "message")).toEqual([
      ["message", "slow quiet"],
    ]);
    expect(all.filter((e) => e.kind === "event").map((e) => e.text)).toEqual([
      "Lab report read",
      "Second report read",
    ]);
    expect((await inputs()).slice(-2)).toEqual([
      [expect.stringContaining("Note: Lab report read")],
      [expect.stringContaining("Note: Second report read")],
    ]);
    // Their saves were refused, with the reason, and nothing was saved.
    const calls = store.db
      .prepare("SELECT tool, ok, answer FROM tool_calls")
      .all() as { tool: string; ok: number; answer: string }[];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatchObject({ tool: "save_changes", ok: 0 });
      expect(call.answer).toContain("started by a Rufi event");
    }
    expect(store.db.prepare("SELECT * FROM symptoms").all()).toEqual([]);
    expect(await waiting()).toEqual([]);
  });

  it.each([false, true])(
    "a deleted document's note goes to the existing thread in a turn of its own: at once, or, when Rufi stopped before handing it over, when it starts again (stopped: %s)",
    async (stopped) => {
      await startChat("fake");
      const c = await newChat();
      const { added } = await documents(store, home).add(
        "asha",
        [
          {
            name: "Sunrise Labs August.pdf",
            bytes: new Uint8Array(
              await readFile(
                join(
                  import.meta.dirname,
                  "../../tests/fixtures/documents/sunrise-labs-august.pdf",
                ),
              ),
            ),
          },
        ],
        true,
      );
      const documentId = added[0] ?? "";
      await say(c, "quiet Explain my report");
      await ended(c.id);
      const threadId = (await chatRow()).threadId as string;
      const remover = deletions({
        store,
        home,
        gate: fileGate(),
        event: async (personId, event, write) => {
          if (!chat) throw new Error("No chat.");
          // Rufi stops right after the delete's commit: nothing hands it over.
          if (stopped) {
            await transcripts.addEvent(c, event, write);
          } else await chat.event(personId, event, write);
        },
        stopReading: () => undefined,
        changed: () => undefined,
        log: () => undefined,
      });
      await remover.remove(
        "asha",
        documentId,
        (await remover.preview("asha", documentId))?.version ?? "",
      );
      const note = expect.stringContaining(
        `The user deleted document ${documentId} (Sunrise Labs August.pdf). Nothing saved in the record came from it.`,
      ) as unknown;
      if (stopped) {
        await chat?.close();
        chat = undefined;
        store.close();
        store = openWritable(databasePath(home));
        transcripts = openTranscripts(store);
        queue = chatQueue(store);
        await queue.endStopped("Rufi closed while reading.");
        await startChat("fake", {
          scenario: { threads: { [threadId]: {} } },
        });
      }
      // No message from the person: the note is the turn's whole input.
      await ended(c.id, 2);
      expect((await inputs()).at(-1)).toEqual([note]);
      expect((await inputs()).at(-1)?.[0]).toContain(
        "It is not the user's words, a request or their consent.",
      );
      expect((await chatRow()).threadId).toBe(threadId);
      expect(await waiting()).toEqual([]);
      await say(await chatRow(), "quiet And what else?");
      await ended(c.id, 3);
      expect((await inputs()).at(-1)).toEqual(["quiet And what else?"]);
    },
  );

  describe("Rufi's part of a reply", () => {
    /** Adds the fictional report from the chat box, unsent; its id. */
    const attach = async () => {
      const bytes = new Uint8Array(
        await readFile(
          join(
            import.meta.dirname,
            "../../tests/fixtures/documents/sunrise-labs-august.pdf",
          ),
        ),
      );
      const { added } = await documents(store, home).add(
        "asha",
        [{ name: "Sunrise Labs August.pdf", bytes }],
        true,
      );
      return added[0] ?? "";
    };
    const reading = async (c: ChatRow) =>
      (await transcript(c.id)).all
        .filter((e) => e.activity === "reading")
        .map((e) => [e.status, e.link]);
    const jobs = () =>
      store.db
        .prepare("SELECT state FROM jobs ORDER BY rowid")
        .all()
        .map((row) => row["state"]);

    it("reads a message's file first, as a step of its reply, then the AI gets the message with Rufi's note in the same reply", async () => {
      await startChat("fake", {
        reader: [
          async (turn) => {
            for (const page of [1, 2]) {
              await turn.look(page);
              await turn.save(page, readPage());
            }
            return undefined;
          },
        ],
      });
      const c = await newChat();
      const id = await attach();
      // Unsent, nobody reads it, and the Documents page doesn't list it.
      expect(await documents(store, home).list("asha")).toEqual([]);
      await chat?.send(c, uuid(), "quiet What does it say?", [
        { type: "document", id },
      ]);
      await ended(c.id);

      const { turns } = await transcript(c.id);
      expect(turns).toMatchObject([{ status: "completed" }]);
      expect(await reading(c)).toEqual([
        ["done", { document: id, action: "open" }],
      ]);
      const [given] = await inputs();
      expect(given?.join("\n")).toContain(
        `Rufi's reader copied Sunrise Labs August.pdf (document ${id})`,
      );
      expect(given?.at(-1)).toMatch(/^quiet What does it say\?/);
      expect(readerRuns).toHaveLength(1);
      expect(await documents(store, home).list("asha")).toMatchObject([
        { id, notSorted: true },
      ]);
    });

    it("ends the reply before the AI when a reading fails or is stopped, its message held for Retry and no reading of its files left open; another message goes meanwhile, and Retry reads on", async () => {
      const stoppedAt = Promise.withResolvers<undefined>();
      await startChat("fake", {
        reader: [
          () =>
            Promise.resolve({
              end: {
                status: "failed",
                reason: "sign_in",
                text: "Your access token could not be refreshed.",
              },
            }),
          async (turn) => {
            await turn.look(1);
            await turn.save(1, readPage());
            stoppedAt.resolve(undefined);
            await turn.stopped();
            return { end: { status: "interrupted", reason: "stopped" } };
          },
          async (turn) => {
            await turn.look(2);
            await turn.save(2, readPage());
            return undefined;
          },
          // The second file, read only once the first is.
          async (turn) => {
            await turn.look(1);
            await turn.save(1, readPage());
            return undefined;
          },
        ],
      });
      const c = await newChat();
      const id = await attach();
      const [photo = ""] = (
        await documents(store, home).add(
          "asha",
          [
            {
              name: "thyroid.jpg",
              bytes: new Uint8Array(
                await readFile(
                  join(
                    import.meta.dirname,
                    "../../tests/fixtures/documents/thyroid-recheck.jpg",
                  ),
                ),
              ),
            },
          ],
          true,
        )
      ).added;
      await chat?.send(c, uuid(), "quiet Read this", [
        { type: "document", id },
        { type: "document", id: photo },
      ]);
      await ended(c.id);
      expect((await transcript(c.id)).turns).toMatchObject([
        { status: "failed" },
      ]);
      expect((await reading(c)).map(([status]) => status)).toEqual(["failed"]);
      // The second file's reading, never started, fails with the reply.
      expect(jobs()).toEqual(["failed", "failed"]);
      const held = async () => {
        const [item] = (await queue.list(await chatRow())).items;
        expect(item).toMatchObject({
          text: "quiet Read this",
          held: "reply_ended",
        });
        return item as { id: string; holdId: string };
      };

      // Retry: the reading goes on in a new reply, and the person stops it.
      const first = await held();
      await chat?.queue.retry(await chatRow(), first.id, first.holdId);
      await stoppedAt.promise;
      await chat?.stop(await chatRow());
      await ended(c.id, 2);
      expect((await transcript(c.id)).turns.at(-1)).toMatchObject({
        status: "interrupted",
      });
      expect(jobs()).toEqual(["failed", "failed"]);
      expect(await inputs()).toEqual([]);

      // Another message goes on its own; the held one waits for Retry.
      await say(await chatRow(), "quiet Thanks");
      await ended(c.id, 3);
      expect(await inputs()).toEqual([["quiet Thanks"]]);
      const second = await held();
      expect(second.holdId).not.toBe(first.holdId);

      await chat?.queue.retry(await chatRow(), second.id, second.holdId);
      await ended(c.id, 4);
      expect((await transcript(c.id)).turns.at(-1)).toMatchObject({
        status: "completed",
      });
      expect(readerRuns.map((run) => run.input)).toEqual([
        expect.stringContaining("Sunrise Labs August.pdf"),
        expect.stringContaining("Sunrise Labs August.pdf"),
        expect.stringContaining("You saved pages 1 in an earlier run"),
        expect.stringContaining("thyroid.jpg"),
      ]);
      expect(jobs()).toEqual(["done", "done"]);
      expect((await inputs()).at(-1)?.at(-1)).toMatch(/^quiet Read this/);
      expect(await waiting()).toEqual([]);

      // The AI took one before a crash, and the next start confirmed it,
      // with no turn of Rufi's.
      store.db.exec(`
        INSERT INTO chat_queue (id, person_id, chat_id, origin, text, position, state, sent_as, created_at, updated_at)
          VALUES ('confirmed', 'asha', 'c-asha', 'person', 'quiet Confirmed after a crash', 99, 'handing_over', 'gone/1', '2026-10-30T10:00:00Z', '2026-10-30T10:00:00Z');`);
      await transcripts.applyInput(
        await chatRow(),
        "confirmed",
        { state: "delivered", agentTurn: null },
        () => Promise.resolve(),
      );

      // A new thread has the message that went on Retry, and the confirmed
      // one, once each.
      await loseThread(c.id);
      await startChat("fake");
      await say(await chatRow(), "quiet And now?");
      await ended(c.id, 5);
      const seed = (await backendOf("fake").contexts()).at(-1) ?? "";
      expect(seed.match(/User: quiet Read this/g)).toHaveLength(1);
      expect(seed.match(/User: quiet Confirmed after a crash/g)).toHaveLength(
        1,
      );
    });
  });

  it("takes nothing the person sends while signed out", async () => {
    await startChat("fake");
    const c = await newChat();
    signedIn = false;
    await expect(say(c, "Hello")).rejects.toThrow(SIGNED_OUT);
    expect(await waiting()).toEqual([]);
    store.db.exec(`
      INSERT INTO chat_queue (id, person_id, chat_id, origin, text, position,
        state, held, created_at, updated_at)
      VALUES ('q-restored', '${c.personId}', '${c.id}', 'person', 'From before',
        1, 'waiting', 'restored', '2026-10-01T09:00:00Z', '2026-10-01T09:00:00Z');
    `);
    await expect(chat?.queue.sendNow(c, "q-restored")).rejects.toThrow(
      SIGNED_OUT,
    );
    expect(await waiting()).toEqual([["From before", "waiting", "restored"]]);
  });

  it("starts and changes to allowed models the provider offers only", async () => {
    await startChat("fake", { allowlist: ["gpt-retired", "gpt-6-astra"] });
    const c = await newChat();
    expect(c.model).toBeNull();
    await say(c, "Hello");
    await ended(c.id);
    expect((await chatRow(c.id)).model).toBe("gpt-6-astra");
    await expect(chat?.selectModel(c, "gpt-retired")).rejects.toThrow(
      "That model isn't allowed or isn't offered now.",
    );
    // A chat with no model yet, when none of the allowed ones is offered.
    await startChat("fake", { allowlist: ["gpt-retired"] });
    store.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('ravi', 'Ravi Fictional');
      INSERT INTO chats (id, person_id, created_at)
        VALUES ('c-ravi', 'ravi', '2026-10-01T09:00:00Z');
    `);
    const ravis = await transcripts.chat("ravi");
    if (!ravis) throw new Error("no chat");
    await say(ravis, "Hello");
    await until(
      async () =>
        (await queue.list(ravis)).items[0]?.heldText ===
        "None of the allowed models is offered now.",
    );
    expect((await queue.list(ravis)).items).toMatchObject([
      { text: "Hello", state: "waiting", held: "failed" },
    ]);
  });

  it("goes on with a resumed thread when its history can't be read", async () => {
    const options = {
      scenario: { hang: ["thread/turns/list"] },
      deadlines: { requestMs: 300 },
    };
    await startChat("fake", options);
    const c = await newChat();
    await say(c, "first");
    await ended(c.id);
    const { threadId } = await chatRow(c.id);
    await startChat("fake", options); // Rufi restarts.
    await say(await chatRow(c.id), "hang");
    await running(c.id);
    // The same thread, and Stop reaches its reply.
    expect((await chatRow(c.id)).threadId).toBe(threadId);
    await chat?.stop(await chatRow(c.id));
    await ended(c.id, 2);
    expect((await transcript(c.id)).turns.at(-1)).toMatchObject({
      status: "interrupted",
      endReason: "stopped",
    });
  });

  it("stops a reply it couldn't save in full, and ends it as failed", async () => {
    await startChat("fake");
    const c = await newChat();
    const appendReply = transcripts.appendReply;
    let parts = 0;
    transcripts.appendReply = (...args) =>
      ++parts === 2
        ? Promise.reject(new Error("disk full"))
        : appendReply(...args);
    await say(c, "drip");
    await ended(c.id);
    transcripts.appendReply = appendReply;
    const { entries, turns } = await transcript(c.id);
    // What was saved stays; nothing after the hole is added.
    expect(entries.filter(([kind]) => kind === "reply")).toEqual([
      ["reply", "ok:"],
    ]);
    expect(turns).toMatchObject([
      {
        status: "failed",
        endReason: "save_failed",
        endText: "Rufi couldn't save all of this reply, so it stopped it.",
      },
    ]);
    const log = await readFile(join(home, "fake.jsonl"), "utf8");
    expect(log).toContain('"method":"turn/interrupt"');
  });

  it("fails only the reply it couldn't save, also when the next one already runs", async () => {
    await startChat("fake");
    const c = await newChat();
    const appendReply = transcripts.appendReply;
    let parts = 0;
    transcripts.appendReply = async (...args) => {
      if (++parts !== 2) return appendReply(...args);
      // The failure comes late: the first reply has ended, the next runs.
      await sleep(1_500);
      throw new Error("disk full");
    };
    await say(c, "drip");
    await say(c, "hang");
    await ended(c.id);
    await running(c.id);
    await sleep(300);
    expect((await transcript(c.id)).turns).toMatchObject([
      { status: "failed", endReason: "save_failed" },
      { status: "running" },
    ]);
    transcripts.appendReply = appendReply;
    await chat?.stop(c);
  });

  it("writes the AI's question into its reply, also when the reply has no text", async () => {
    await startChat("fake", {
      scenario: {
        unstreamed: {
          text: "",
          questions: [{ title: "Whose results?", options: ["Asha", "Ravi"] }],
        },
      },
    });
    const c = await newChat();
    await say(c, "Show results");
    await ended(c.id);
    expect(
      (await transcript(c.id)).entries.filter(([kind]) => kind === "reply"),
    ).toEqual([
      ["reply", "ok:Show results"],
      ["reply", "**Whose results?**\n- Asha\n- Ravi"],
    ]);
  });

  it("keeps everything each activity sent and got back, the AI's reasoning, and each call to Rufi's tools as answered", async () => {
    await startChat("fake", {
      scenario: {
        calls: [{ tool: "get_overview", arguments: {} }],
        reasoning: ["**Reading the record**"],
      },
    });
    const c = await newChat();
    await say(c, "What's new?");
    await ended(c.id);
    const { all, turns } = await transcript(c.id);
    // The screens get the lines as Codex reported them and the reasoning's
    // summary, never details.
    expect(
      all
        .filter((e) => e.kind !== "message" && e.kind !== "reply")
        .map((e) => [e.activity, e.text, e.detail, e.status]),
    ).toEqual([
      ["tool", "rufi.get_overview", null, "done"],
      [null, "**Reading the record**", null, "done"],
      ["command", "ls", "exit 0", "done"],
      ["other", "teleport", null, "done"],
    ]);
    // Everything else only when a line opens, from the agent database.
    const kept = await Promise.all(
      all
        .filter((e) => e.kind === "activity" || e.kind === "reasoning")
        .map(async (e) => [
          e.kind,
          e.text,
          (await transcripts.details(c, e.id))?.details,
        ]),
    );
    expect(kept).toMatchObject([
      [
        "activity",
        "rufi.get_overview",
        { type: "mcpToolCall", server: "rufi", tool: "get_overview" },
      ],
      [
        "reasoning",
        "**Reading the record**",
        { summary: ["**Reading the record**"] },
      ],
      ["activity", "ls", { aggregatedOutput: "notes.txt\n", exitCode: 0 }],
      ["activity", "teleport", { type: "teleport" }],
    ]);
    const [call] = store.db
      .prepare("SELECT tool, input, answer, ok, turn_id FROM tool_calls")
      .all();
    expect(call).toMatchObject({
      tool: "get_overview",
      input: "{}",
      ok: 1,
      turn_id: turns[0]?.id,
    });
    expect(JSON.parse(String(call?.["answer"]))).toMatchObject({
      ok: true,
      result: { person: "Asha Fictional" },
    });
    // After a restart the reply shows the same.
    await startChat("fake");
    expect((await transcript(c.id)).all).toEqual(all);
  });

  it("splits How off a completed reply, also while it streams; small talk has none; Activity names each read", async () => {
    await startChat("fake", {
      scenario: {
        calls: [
          {
            tool: "get_records",
            arguments: { kind: "result", from: "2024" },
          },
        ],
      },
    });
    const c = await newChat();
    const shown: Entry[] = [];
    transcripts.subscribe(c.id, (change) => shown.push(...change.entries));
    const asked =
      "Your HbA1c\n\n```rufi-basis\nFrom the record, read now.\n```";
    await say(c, asked);
    await ended(c.id);
    // Small talk: the AI reads nothing and writes no block.
    await say(await chatRow(c.id), "quiet thanks");
    await ended(c.id, 2);
    const { entries, turns } = await transcript(c.id);
    // Activity names the read as Codex reported it.
    expect(entries).toContainEqual(["activity", "rufi.get_records"]);
    expect(entries.filter(([kind]) => kind === "reply")).toEqual([
      ["reply", "ok:Your HbA1c"],
      ["reply", "ok:quiet thanks"],
    ]);
    // Not even while it streamed.
    expect(
      shown.some((e) => e.kind === "reply" && e.text.includes("rufi-basis")),
    ).toBe(false);
    expect(
      store.db
        .prepare("SELECT text FROM transcript_entries WHERE kind = 'reply'")
        .all()[0],
    ).toEqual({ text: `ok:${asked}` });
    expect(turns.map((t) => t.how)).toEqual([
      "From the record, read now.",
      null,
    ]);
  });

  it("stops a reply when Rufi can't keep a call to its tools, and tells the AI; a save it can't keep saves nothing", async () => {
    await startChat("fake", { scenario: { calls: [saveHeadache] } });
    const c = await newChat();
    // The store itself refuses the write, as a full disk would.
    store.db.exec(
      "CREATE TEMP TRIGGER full BEFORE INSERT ON tool_calls BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END",
    );
    await say(c, "hang");
    await ended(c.id);
    expect((await transcript(c.id)).turns).toMatchObject([
      { status: "failed", endReason: "save_failed" },
    ]);
    const answered = (await readFile(join(home, "fake.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.includes('"answered":"tools/call"'));
    expect(answered).toHaveLength(1);
    expect(answered[0]).toContain("Rufi couldn't keep this call");
    expect(store.db.prepare("SELECT * FROM symptoms").all()).toEqual([]);
    expect(
      (await transcript(c.id)).entries.filter(([kind]) => kind === "receipt"),
    ).toEqual([]);
  });

  it("keeps a tool's late result out: the activity is stopped, not done", async () => {
    await startChat("fake", {
      scenario: {
        calls: [{ tool: "get_overview", arguments: {} }],
      },
      toolMs: 500,
    });
    const c = await newChat();
    await say(c, "hang");
    await until(async () =>
      (await transcript(c.id)).entries.some(([kind]) => kind === "activity"),
    );
    await chat?.stop(c);
    await ended(c.id);
    await sleep(300);
    expect(
      (await transcript(c.id)).all
        .filter((e) => e.kind === "activity")
        .map((e) => e.status),
    ).toEqual(["stopped"]);
  });

  /** The agent's id of the chat's only reply. */
  const agentTurn = () =>
    (
      store.db.prepare("SELECT agent_turn_id FROM turns").get() as {
        agent_turn_id: string;
      }
    ).agent_turn_id;

  /** Rufi's MCP server as the chat's thread got it, with its key. */
  const threadMcp = async (index = 0) => {
    const lines = (await readFile(join(home, "fake.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            received?: {
              method?: string;
              params?: {
                config?: { mcp_servers?: { rufi?: McpServerConfig } };
              };
            };
          },
      );
    const start = lines.filter((l) => l.received?.method === "thread/start")[
      index
    ];
    const server = start?.received?.params?.config?.mcp_servers?.rufi;
    if (!server) throw new Error("the thread got no MCP server");
    return server;
  };

  it("refuses another chat's key for a cached caller, for reads and saves", async () => {
    await startChat("fake", { scenario: { bare: true } });
    store.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('ravi', 'Ravi Fictional');
      INSERT INTO chats (id, person_id, created_at)
        VALUES ('c-ravi', 'ravi', '2026-10-01T09:00:00Z');
    `);
    const asha = await newChat();
    const ravi = await transcripts.chat("ravi");
    if (!ravi) throw new Error("no chat");
    await say(asha, "hang quiet: I have a headache");
    await running(asha.id);
    await say(ravi, "hang quiet: hello");
    await until(async () => {
      const row = await transcripts.chat("ravi");
      return (
        row?.threadId !== null &&
        row?.threadId !== undefined &&
        chat?.agent.activeTurn(row.threadId) !== undefined
      );
    });
    const { threadId } = await chatRow();
    const reply = { threadId: threadId ?? "", turnId: agentTurn() };
    const own = await threadMcp();
    const other = await threadMcp(1);
    const read = { name: "get_overview", arguments: {}, ...reply };
    const before = await callTool(other, { ...read, callId: "wrong-before" });
    const proper = await callTool(own, { ...read, callId: "proper-read" });
    const after = await callTool(other, { ...read, callId: "wrong-after" });
    const save = await callTool(other, {
      name: "save_changes",
      arguments: saveHeadache.arguments,
      ...reply,
      callId: "wrong-save",
    });
    expect(proper.result?.["isError"]).not.toBe(true);
    const refused = {
      content: [
        { type: "text", text: '{"ok":false,"error":"No reply is running."}' },
      ],
      isError: true,
    };
    expect([before.result, after.result, save.result]).toEqual([
      refused,
      refused,
      refused,
    ]);
    expect(
      store.db.prepare("SELECT tool, call_id FROM tool_calls").all(),
    ).toEqual([{ tool: "get_overview", call_id: ownCall("proper-read") }]);
    expect(store.db.prepare("SELECT * FROM symptoms").all()).toEqual([]);
    expect(
      (await transcript(asha.id)).entries.filter(
        ([kind]) => kind === "receipt",
      ),
    ).toEqual([]);
  });

  it("refuses a call with the thread's key when no reply is running, and keeps no trace of it as a call", async () => {
    await startChat("fake");
    const c = await newChat();
    await say(c, "Hello");
    await ended(c.id);
    const { threadId } = await chatRow();
    const { result } = await callTool(await threadMcp(), {
      name: "save_changes",
      arguments: saveHeadache.arguments,
      callId: "call-late",
      threadId: threadId ?? "",
      turnId: agentTurn(),
    });
    expect(result).toEqual({
      content: [
        { type: "text", text: '{"ok":false,"error":"No reply is running."}' },
      ],
      isError: true,
    });
    expect(store.db.prepare("SELECT * FROM tool_calls").all()).toEqual([]);
    expect(store.db.prepare("SELECT * FROM symptoms").all()).toEqual([]);
  });

  it("refuses the stopped reply's calls from the moment Stop is pressed; a save admitted before lands under it", async () => {
    await startChat("fake", {
      // The reply doesn't end at once: Codex holds it back.
      scenario: { calls: [saveHeadache], ignoreInterrupt: true },
      toolMs: 500,
      deadlines: { interruptAckMs: 1_000, interruptEndMs: 1_000 },
    });
    const c = await newChat();
    await say(c, "hang: I have a headache");
    // Admitted, not only shown: Codex shows the call before it reaches Rufi.
    await until(() => Promise.resolve(admitted.includes("save_changes")));
    const { threadId } = await chatRow();
    const turnId = agentTurn();
    const stopping = chat?.stop(c);
    await until(() =>
      Promise.resolve(chat?.agent.activeTurn(threadId ?? "") === undefined),
    );
    expect((await transcript(c.id)).turns).toMatchObject([
      { status: "running" },
    ]);
    const { result } = await callTool(await threadMcp(), {
      name: "save_changes",
      arguments: saveHeadache.arguments,
      callId: "call-after-stop",
      threadId: threadId ?? "",
      turnId,
    });
    expect(result?.["isError"]).toBe(true);
    await stopping;
    await ended(c.id);
    await until(async () =>
      (await transcript(c.id)).entries.some(([kind]) => kind === "receipt"),
    );
    const { entries, turns } = await transcript(c.id);
    expect(turns).toHaveLength(1);
    expect(entries.filter(([kind]) => kind === "receipt")).toEqual([
      ["receipt", "**Saved**\n\n- Added symptom **Headache**"],
    ]);
    expect(store.db.prepare("SELECT call_id FROM tool_calls").all()).toEqual([
      { call_id: ownCall("call-0") },
    ]);
  });

  it("keeps a sub-agent's save made after Rufi AI's reply ended, with its kept answer and its receipt", async () => {
    const replied = Promise.withResolvers<undefined>();
    await startChat("fake", {
      scenario: {
        callsByText: {
          "Ask a helper": [
            {
              tool: "start_agent",
              arguments: {
                title: "Helper",
                task: "helper: save it, from the user's message at 1",
              },
            },
          ],
          // Its turn has no message of the user's: it names theirs, the
          // chat's first.
          "helper:": [
            {
              tool: "save_changes",
              arguments: {
                changes: [
                  {
                    kind: "symptom",
                    action: "add",
                    source: 1,
                    fields: { name: "Headache" },
                  },
                ],
              },
            },
          ],
        },
      },
      waitFor: (tool) =>
        tool === "save_changes" ? replied.promise : undefined,
    });
    const c = await newChat();
    await say(c, "Ask a helper");
    await ended(c.id);
    replied.resolve(undefined);
    await until(async () =>
      (await transcript(c.id)).entries.some(([kind]) => kind === "receipt"),
    );
    expect(store.db.prepare("SELECT name FROM symptoms").all()).toEqual([
      { name: "Headache" },
    ]);
    // The helper's id is the call that started it.
    const helper = ownCall("call-0");
    expect(
      store.db
        .prepare(
          "SELECT agent_id, turn_id, ok FROM tool_calls WHERE tool = 'save_changes'",
        )
        .all(),
    ).toEqual([{ agent_id: helper, turn_id: null, ok: 1 }]);
    const { entries, all } = await transcript(c.id);
    // Labelled with the helper's title: it belongs to no reply.
    expect(entries.filter(([kind]) => kind === "receipt")).toEqual([
      ["receipt", "**Saved** · Helper\n\n- Added symptom **Headache**"],
    ]);
    expect(all.find((entry) => entry.kind === "receipt")?.turnId).toBeNull();
  });

  it("runs a sub-agent's own sub-agent, and Rufi AI reads how each went and the conversation of the one below", async () => {
    await startChat("fake", {
      scenario: {
        callsByText: {
          "Ask a helper": [
            {
              tool: "start_agent",
              arguments: { title: "Helper", task: "helper: ask yours" },
            },
          ],
          "helper:": [
            {
              tool: "start_agent",
              arguments: { title: "Second helper", task: "second: hello" },
            },
          ],
        },
      },
    });
    const c = await newChat();
    await say(c, "Ask a helper");
    await ended(c.id);
    const helper = ownCall("call-0");
    const second = `${helper}/1/call-0`;
    await until(() =>
      Promise.resolve(
        agentRows().some(
          (row) => row["id"] === second && row["status"] === "done",
        ),
      ),
    );
    await startChat("fake", {
      scenario: {
        callsByText: {
          "How did they do": [
            { tool: "agent_status", arguments: {} },
            { tool: "read_agent", arguments: { agent: second } },
          ],
        },
      },
    });
    await say(await chatRow(c.id), "How did they do?");
    await ended(c.id, 2);
    const answers = store.db
      .prepare(
        "SELECT tool, answer FROM tool_calls WHERE tool IN ('agent_status', 'read_agent') ORDER BY started_at",
      )
      .all() as { tool: string; answer: string }[];
    const [status, read] = answers.map(
      (row) => JSON.parse(row.answer) as { ok: boolean; result: unknown },
    );
    expect(status).toEqual({
      ok: true,
      result: {
        agents: [
          {
            agent: helper,
            title: "Helper",
            parent: "self",
            status: "done",
            result: "ok:helper: ask yours",
          },
          {
            agent: second,
            title: "Second helper",
            parent: helper,
            status: "done",
            result: "ok:second: hello",
          },
        ],
      },
    });
    expect(read).toMatchObject({
      ok: true,
      result: {
        agent: { agent: second, title: "Second helper", status: "done" },
        turns: [
          {
            status: "done",
            inputs: [{ from: helper, text: "second: hello" }],
            result: "ok:second: hello",
          },
        ],
        earlier: null,
      },
    });
  });

  it("reads a sub-agent's question, with its options, from its conversation", async () => {
    const question = {
      title: "Which visit is this brief for?",
      options: ["3 Nov, Dr Rao", "12 Nov, Dr Iyer"],
    };
    await startChat("fake", {
      scenario: {
        callsByText: {
          "Ask a helper": [
            {
              tool: "start_agent",
              arguments: { title: "Brief", task: "helper: make the brief" },
            },
          ],
        },
        // Each turn ends with it, the helper's too, and no answer text.
        unstreamed: { text: "", questions: [question] },
      },
    });
    const c = await newChat();
    await say(c, "Ask a helper");
    await ended(c.id);
    const helper = ownCall("call-0");
    await until(() =>
      Promise.resolve(
        agentRows().some(
          (row) => row["id"] === helper && row["status"] === "done",
        ),
      ),
    );
    await startChat("fake", {
      scenario: {
        callsByText: {
          "What did it ask": [
            { tool: "read_agent", arguments: { agent: helper } },
          ],
        },
      },
    });
    await say(await chatRow(c.id), "What did it ask?");
    await ended(c.id, 2);
    const [read] = (
      store.db
        .prepare("SELECT answer FROM tool_calls WHERE tool = 'read_agent'")
        .all() as { answer: string }[]
    ).map((row) => JSON.parse(row.answer) as unknown);
    expect(read).toMatchObject({
      ok: true,
      result: { turns: [{ status: "done", questions: [question] }] },
    });
  });

  it("gives a sub-agent only the tools it was given, and its own sub-agent no more than those", async () => {
    await startChat("fake", {
      scenario: {
        callsByText: {
          "Ask a reader": [
            {
              tool: "start_agent",
              arguments: {
                title: "Reader",
                task: "reader: try",
                tools: ["get_overview", "start_agent"],
              },
            },
          ],
          "reader:": [
            {
              tool: "save_changes",
              arguments: {
                changes: [
                  {
                    kind: "symptom",
                    action: "add",
                    source: 1,
                    fields: { name: "Headache" },
                  },
                ],
              },
            },
            {
              tool: "start_agent",
              arguments: {
                title: "Wider",
                task: "wider: try",
                tools: ["get_overview", "save_changes"],
              },
            },
          ],
        },
      },
    });
    const c = await newChat();
    await say(c, "Ask a reader");
    await ended(c.id);
    const reader = ownCall("call-0");
    await until(() =>
      Promise.resolve(
        agentRows().some(
          (row) => row["id"] === reader && row["status"] === "done",
        ),
      ),
    );
    const calls = store.db
      .prepare(
        "SELECT tool, answer FROM tool_calls WHERE agent_id = ? ORDER BY started_at",
      )
      .all(reader) as { tool: string; answer: string }[];
    expect(
      calls.map(({ tool, answer }) => ({
        tool,
        error: (JSON.parse(answer) as { error?: string }).error,
      })),
    ).toEqual([
      {
        tool: "save_changes",
        error:
          "There is no tool called save_changes. Rufi's tools: get_overview, start_agent.",
      },
      {
        tool: "start_agent",
        error:
          "An agent you start can have only tools you have, and you don't have save_changes. Nothing was started.",
      },
    ]);
    expect(store.db.prepare("SELECT * FROM symptoms").all()).toEqual([]);
    expect(agentRows().map((row) => row["title"])).toEqual([
      "Rufi AI",
      "Reader",
    ]);
  });

  it("saves the calls of two agents of the chat that have the same id from their provider, each with its receipt", async () => {
    // Rufi AI before and after the agent database is lost: two agents, and
    // each one's first call is call-0.
    await startChat("fake", { scenario: { calls: [saveHeadache] } });
    const c = await newChat();
    await say(c, "I have a headache");
    await ended(c.id);
    await startChat("fake", {
      loseAgents: true,
      scenario: { calls: [saveNausea] },
    });
    await say(await chatRow(c.id), "And I feel sick");
    await ended(c.id, 2);
    expect(
      store.db.prepare("SELECT name FROM symptoms ORDER BY name").all(),
    ).toEqual([{ name: "Headache" }, { name: "Nausea" }]);
    expect(
      (await transcript(c.id)).entries.filter(([kind]) => kind === "receipt"),
    ).toEqual([
      ["receipt", "**Saved**\n\n- Added symptom **Headache**"],
      ["receipt", "**Saved**\n\n- Added symptom **Nausea**"],
    ]);
  });

  it("saves once when the same call comes again after the agent stopped waiting for it", async () => {
    await startChat("fake", {
      scenario: {
        calls: [
          { ...saveHeadache, id: "call-same" },
          { ...saveHeadache, id: "call-same" },
        ],
      },
      toolMs: 300,
      doorMs: 100,
    });
    const c = await newChat();
    await say(c, "I have a headache");
    await ended(c.id);
    // Both calls ran to their end, after the agent's wait for each.
    await until(() =>
      Promise.resolve(
        store.db
          .prepare("SELECT call_id FROM tool_calls WHERE tool = 'save_changes'")
          .all().length === 2,
      ),
    );
    expect(store.db.prepare("SELECT name FROM symptoms").all()).toEqual([
      { name: "Headache" },
    ]);
    expect(
      (await transcript(c.id)).entries.filter(([kind]) => kind === "receipt"),
    ).toEqual([["receipt", "**Saved**\n\n- Added symptom **Headache**"]]);
    const answered = (await readFile(join(home, "fake.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.includes('"answered":"tools/call"'));
    expect(answered).toHaveLength(2);
    expect(answered[0]).toContain("save_changes took too long.");
  });

  it("saves once when the same call comes again by its id, and answers it with the same receipt", async () => {
    await startChat("fake", {
      scenario: {
        calls: [
          { ...saveHeadache, id: "call-same" },
          { ...saveHeadache, id: "call-same" },
        ],
      },
    });
    const c = await newChat();
    await say(c, "I have a headache");
    await ended(c.id);
    expect(store.db.prepare("SELECT name FROM symptoms").all()).toEqual([
      { name: "Headache" },
    ]);
    const answers = store.db
      .prepare("SELECT call_id, ok, answer FROM tool_calls ORDER BY started_at")
      .all() as { call_id: string; ok: number; answer: string }[];
    expect(answers).toHaveLength(2);
    expect(answers.map((a) => [a.call_id, a.ok])).toEqual([
      [ownCall("call-same"), 1],
      [ownCall("call-same"), 1],
    ]);
    const [first, again] = answers.map(
      (a) => JSON.parse(a.answer) as { result: Record<string, unknown> },
    );
    expect(again?.result).toEqual({
      ...first?.result,
      note: "This call was already saved.",
    });
  });

  it("stops a reply whose AI keeps making calls Rufi can't accept, and says why", async () => {
    const wrong = { tool: "read_database", arguments: {} };
    await startChat("fake", { scenario: { calls: [wrong, wrong, wrong] } });
    const c = await newChat();
    await say(c, "hang");
    await ended(c.id);
    expect((await transcript(c.id)).turns).toMatchObject([
      {
        status: "failed",
        endText: "The AI kept making requests Rufi couldn't accept.",
      },
    ]);
  });

  it("keeps a save that lands after Stop, with its receipt", async () => {
    await startChat("fake", {
      scenario: { calls: [saveHeadache] },
      toolMs: 500,
    });
    const c = await newChat();
    await say(c, "hang: I have a headache");
    // Codex shows the call before it reaches Rufi: a Stop before then
    // refuses it (ADR 0016). This one is under way when Stop comes.
    await until(() => Promise.resolve(admitted.includes("save_changes")));
    await chat?.stop(c);
    await ended(c.id);
    await until(async () =>
      (await transcript(c.id)).entries.some(([kind]) => kind === "receipt"),
    );
    const { entries, turns } = await transcript(c.id);
    expect(turns).toMatchObject([{ status: "interrupted" }]);
    expect(entries.filter(([kind]) => kind === "receipt")).toEqual([
      ["receipt", "**Saved**\n\n- Added symptom **Headache**"],
    ]);
    expect(store.db.prepare("SELECT name FROM symptoms").all()).toEqual([
      { name: "Headache" },
    ]);
  });

  it("saves after the message it rests on is stored, also when storing is slow", async () => {
    await startChat("fake", { scenario: { calls: [saveHeadache] } });
    const c = await newChat();
    const addMessage = transcripts.addMessage;
    transcripts.addMessage = async (...args) => {
      await sleep(300);
      return addMessage(...args);
    };
    await say(c, "I have a headache");
    await ended(c.id);
    transcripts.addMessage = addMessage;
    expect(
      (await transcript(c.id)).entries.filter(
        ([kind]) => kind === "message" || kind === "receipt",
      ),
    ).toEqual([
      ["message", "I have a headache"],
      ["receipt", "**Saved**\n\n- Added symptom **Headache**"],
    ]);
  });

  it("gives a new thread Rufi's receipts with the last messages", async () => {
    await startChat("fake", { scenario: { calls: [saveHeadache] } });
    const c = await newChat();
    await say(c, "I have a headache");
    await ended(c.id);
    await loseThread(c.id);
    await startChat("fake");
    await say(await chatRow(c.id), "And now?");
    await ended(c.id, 2);
    expect((await backendOf("fake").contexts()).at(-1)).toContain(
      "User: I have a headache\n\nRufi: **Saved**\n\n- Added symptom **Headache**\n\nAI: ok:I have a headache",
    );
  });

  it("goes on after the agent database is lost, in a new conversation that starts with what was delivered only", async () => {
    await startChat("fake");
    const c = await newChat();
    await say(c, "first");
    await ended(c.id);
    // The person's message waits for a reply of its own, then is stopped.
    await rufiReply(c);
    await say(await chatRow(), "waiting B");
    await chat?.stop(await chatRow());
    await ended(c.id, 2);

    await startChat("fake", { loseAgents: true });
    const [waitingB] = (await queue.list(await chatRow())).items;
    await chat?.queue.sendNow(await chatRow(), waitingB?.id ?? "");
    await ended(c.id, 3);
    const seed = (await backendOf("fake").contexts()).at(-1);
    expect(seed).toContain("User: first\n\nAI: ok:first");
    expect(seed).not.toContain("waiting B");
    const { entries, turns } = await transcript(c.id);
    expect(
      entries.filter(([kind]) => kind === "message").map(([, text]) => text),
    ).toEqual(["first", "waiting B"]);
    expect(turns.map((turn) => turn.newThread)).toEqual([false, false, true]);
  });

  it("saves nothing of a reply after its Stop", async () => {
    await startChat("fake", { scenario: { late: true } });
    const c = await newChat();
    await say(c, "hang");
    await running(c.id);
    await chat?.stop(c);
    await ended(c.id);
    await sleep(200);
    expect(JSON.stringify((await transcript(c.id)).entries)).not.toContain(
      "LATE",
    );
  });

  it("marks only the first reply on a new thread: a model change, or a send stopped before it began, marks nothing", async () => {
    await startChat("fake", {
      scenario: { slow: ["thread/start"], slowMs: 300 },
    });
    const c = await newChat();
    await say(c, "first");
    await ended(c.id, 1);
    // A new model: the thread goes on.
    await chat?.selectModel(c, "gpt-6-astra");
    await say(await chatRow(), "second");
    await ended(c.id, 2);
    // The thread is lost; the first message to the new one is stopped while
    // the thread starts, before it leaves, and the person removes it.
    await loseThread();
    await startChat("fake", {
      scenario: { slow: ["thread/start"], slowMs: 300 },
    });
    await say(await chatRow(), "never sent");
    await sleep(100);
    await chat?.stop(await chatRow());
    await until(async () => (await waiting())[0]?.[1] === "waiting");
    const [stopped] = (await queue.list(c)).items;
    await chat?.queue.remove(c, stopped?.id ?? "");
    await say(await chatRow(), "third");
    await ended(c.id, 3);
    await say(await chatRow(), "fourth");
    await ended(c.id, 4);
    // The stopped message never reached the AI.
    const { entries, turns } = await transcript(c.id);
    expect(
      entries.filter(([kind]) => kind === "message").map(([, text]) => text),
    ).toEqual(["first", "second", "third", "fourth"]);
    expect(turns.map((t) => t.newThread)).toEqual([false, false, true, false]);
  });

  it("keeps the AI's compaction of its memory, done once Codex completed it", async () => {
    await startChat("fake", { scenario: { compaction: true } });
    const c = await newChat();
    await say(c, "Hello");
    await ended(c.id);
    const compacted = (await transcript(c.id)).all.filter(
      (entry) => entry.activity === "compaction",
    );
    expect(compacted).toMatchObject([
      { text: "contextCompaction", status: "done" },
    ]);
  });

  it("saves a usage limit's end reason and reset time", async () => {
    await startChat("fake", { scenario: { resetsAt: 1_791_000_000 } });
    const c = await newChat();
    await say(c, "please fail");
    await ended(c.id);
    expect((await transcript(c.id)).turns[0]).toMatchObject({
      status: "failed",
      endReason: "usage_limit",
      resetsAt: new Date(1_791_000_000_000).toISOString(),
    });
  });

  it("gives a new thread the model, Rufi's rules for the region, the AI's folder and its permission profile", async () => {
    await transcripts.saveSetting("emergency_region", "IN");
    await startChat("fake");
    const c = await newChat();
    await say(c, "Hello");
    await ended(c.id);
    const log = await readFile(join(home, "fake.jsonl"), "utf8");
    const start = log
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line || "{}") as {
            received?: { method?: string; params?: Record<string, unknown> };
          },
      )
      .find((entry) => entry.received?.method === "thread/start")
      ?.received?.params;
    expect(start).toMatchObject({
      model: "gpt-6.1-sol",
      developerInstructions: "Rufi's rules 1, for IN.",
      cwd: join(home, "ai"),
      permissions: "rufi-ai",
      approvalPolicy: "never",
    });
    // Never the legacy selector, which can't deny reads.
    expect(start).not.toHaveProperty("sandbox");
  });

  it("holds the message with the reason and both choices when the thread can't take Rufi's new rules, and starts no other", async () => {
    await startChat("fake");
    const c = await newChat();
    await say(c, "first");
    await ended(c.id);
    await startChat("fake", { rules: "2", scenario: { injectFails: true } });
    await say(await chatRow(c.id), "second");
    await until(async () => (await waiting())[0]?.[2] === "open_failed");
    expect((await queue.list(c)).items).toMatchObject([
      {
        text: "second",
        heldText:
          "The AI couldn't take Rufi's new instructions, so it can't reply now. Try again.",
      },
    ]);
    expect((await transcript(c.id)).turns).toHaveLength(1);
    expect((await chatRow(c.id)).threadTools).toBe("rules-1-");
    const started = (await readFile(join(home, "fake.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.includes('"method":"thread/start"'));
    expect(started).toHaveLength(1);
  });

  it("never reuses another agent's thread", async () => {
    await startChat("fake");
    const c = await newChat();
    await transcripts.setThread(c, {
      id: "theirs-1",
      provider: "claude",
      model: "gpt-6.1-sol",
      tools: "tools-1",
    });
    await say(await chatRow(c.id), "Hello");
    await ended(c.id);
    const log = await readFile(join(home, "fake.jsonl"), "utf8");
    expect(log).not.toContain("theirs-1");
    expect((await chatRow(c.id)).threadProvider).toBe("codex");
  });

  it("shows the agent's errors as they are", async () => {
    await startChat("fake", {
      scenario: { hang: ["thread/start"] },
      deadlines: { requestMs: 300 },
    });
    const c = await newChat();
    await say(c, "Hello");
    await until(async () => (await waiting())[0]?.[2] === "open_failed");
    expect((await queue.list(c)).items[0]?.heldText).toBe(
      "Codex didn't answer thread/start within 0.3 s.",
    );
  });

  it("shows a cut reply's answer without How or half a block, and passes it on marked, with its progress note", async () => {
    const c = await newChat();
    await transcripts.startTurn(c, "t-1", {
      id: "thread-cut",
      model: "gpt-6.1-sol",
    });
    // A note can hold a fact the AI said; the new thread keeps it.
    await transcripts.appendNote(
      c,
      "t-1",
      "note-1",
      "Your record has one HbA1c, from August.",
      false,
    );
    await transcripts.appendReply(
      c,
      "t-1",
      "item-1",
      "Your HbA1c was 6.8 %.\n\n```rufi-basis\nFrom the rec",
    );
    await openTranscripts(store).interruptRunning();
    const { entries, turns } = await transcript(c.id);
    expect(entries).toEqual([
      ["activity", "Your record has one HbA1c, from August."],
      ["reply", "Your HbA1c was 6.8 %."],
    ]);
    expect(turns).toMatchObject([{ how: null }]);
    expect(await transcripts.lastMessages(c, 10)).toEqual([
      {
        from: "note",
        text: "Your record has one HbA1c, from August.",
        unfinished: true,
      },
      { from: "ai", text: "Your HbA1c was 6.8 %.", unfinished: true },
    ]);
    // A message sent into the reply cuts an answer and the turn goes on and completes: the
    // cut answer stays cut, the one that followed is whole.
    await transcripts.startTurn(c, "t-2", {
      id: "thread-cut",
      model: "gpt-6.1-sol",
    });
    await transcripts.appendReply(
      c,
      "t-2",
      "item-3",
      "Your HbA1c was 6.8 %.\n\n```rufi-ba",
    );
    await transcripts.addMessage(c, {
      id: uuid(),
      kind: "steer",
      text: "Only the number",
      agentTurnId: "t-2",
    });
    await transcripts.appendReply(c, "t-2", "item-4", "6.8 %.", true);
    await transcripts.endTurn(c, "t-2", { status: "completed" });
    expect((await transcript(c.id)).entries.slice(-3)).toEqual([
      ["reply", "Your HbA1c was 6.8 %."],
      ["steer", "Only the number"],
      ["reply", "6.8 %."],
    ]);
    expect((await transcripts.lastMessages(c, 10)).slice(-3)).toEqual([
      { from: "ai", text: "Your HbA1c was 6.8 %.", unfinished: true },
      { from: "user", text: "Only the number" },
      { from: "ai", text: "6.8 %." },
    ]);
    // A new thread hears both, marked unfinished.
    await startChat("fake");
    await say(await chatRow(c.id), "And?");
    await ended(c.id, 3);
    expect((await backendOf("fake").contexts()).at(-1)).toContain(
      "AI (a progress note) (this reply didn't finish): Your record has one HbA1c, from August.\n\nAI (this reply didn't finish): Your HbA1c was 6.8 %.",
    );
  });

  it("keeps a reply's text when a crash cuts it, and marks it interrupted", async () => {
    const c = await newChat();
    await transcripts.startTurn(c, "t-1", {
      id: "thread-cut",
      model: "gpt-6.1-sol",
    });
    await transcripts.appendReply(c, "t-1", "item-1", "Half a rep");
    await transcripts.setActivity(c, "t-1", "item-2", {
      activity: "command",
      title: "Ran a command",
      detail: "ls",
      status: "running",
    });
    // The next start finds it.
    await expect(openTranscripts(store).interruptRunning()).resolves.toBe(1);
    const { entries, turns, all } = await transcript(c.id);
    expect(entries).toEqual([
      ["reply", "Half a rep"],
      ["activity", "Ran a command"],
    ]);
    expect(all[1]?.status).toBe("stopped");
    expect(turns).toMatchObject([
      {
        status: "interrupted",
        endText: "Rufi closed before the reply finished.",
      },
    ]);
  });
});

describe("When the AI's thread doesn't open", () => {
  /** Asha's chat after one reply, then Rufi started again with `scenario`. */
  async function afterOneReply(scenario: Scenario) {
    await startChat("fake");
    await say(await newChat(), "first");
    await ended("c-asha");
    const thread = (await chatRow()).threadId;
    await startChat("fake", { scenario });
    return thread;
  }

  /** The held message, once it waits with the open error. */
  async function held() {
    await until(
      async () =>
        (await queue.list(await chatRow())).items[0]?.held === "open_failed",
    );
    const [item] = (await queue.list(await chatRow())).items;
    if (!item?.holdId) throw new Error("no held message");
    return { ...item, holdId: item.holdId };
  }

  const threadStarts = async () =>
    (await readFile(join(home, "fake.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.includes('"method":"thread/start"')).length;

  it("holds the message with Codex's error and starts no other thread; Try again holds it anew while the error lasts, then sends it once in the same thread", async () => {
    const thread = await afterOneReply({ resumeFails: 2 });
    await say(await chatRow(), "second");
    const first = await held();
    expect(first).toMatchObject({
      text: "second",
      state: "waiting",
      heldText:
        "Codex refused thread/resume: failed to read thread: a fictional read error",
    });
    expect(await threadStarts()).toBe(1);

    await chat?.queue.recover(await chatRow(), first.id, first.holdId, "retry");
    await until(async () => {
      const item = (await queue.list(await chatRow())).items[0];
      return item?.held === "open_failed" && item.holdId !== first.holdId;
    });
    const second = await held();
    expect(second.id).toBe(first.id);

    // A click on the first hold, from a tab that still shows it, changes nothing.
    await expect(
      chat?.queue.recover(
        await chatRow(),
        first.id,
        first.holdId,
        "new_thread",
      ),
    ).rejects.toThrow("The waiting messages changed meanwhile.");
    expect((await queue.list(await chatRow())).items).toMatchObject([
      { id: first.id, holdId: second.holdId },
    ]);
    expect((await chatRow()).threadId).toBe(thread);

    await chat?.queue.recover(
      await chatRow(),
      second.id,
      second.holdId,
      "retry",
    );
    await ended("c-asha", 2);
    const { entries, turns } = await transcript("c-asha");
    expect(
      entries.filter(([kind]) => kind === "message").map(([, text]) => text),
    ).toEqual(["first", "second"]);
    expect(turns.map((turn) => turn.newThread)).toEqual([false, false]);
    expect(threadsUsed()).toBe(1);
    expect(await threadStarts()).toBe(1);
  });

  it("keeps the held message with its choices when Rufi starts again", async () => {
    await afterOneReply({ profile: ":workspace" });
    await say(await chatRow(), "second");
    const before = await held();
    expect(before.heldText).toBe(
      "Codex didn't take Rufi's thread settings: its permissions are :workspace.",
    );
    await startChat("fake", { scenario: { profile: ":workspace" } });
    await sleep(100);
    expect(await held()).toEqual(before);
  });

  it("starts one new thread on New thread, with the earlier chat, and sends the message once", async () => {
    const thread = await afterOneReply({ resumeFails: 5 });
    await say(await chatRow(), "second");
    const item = await held();
    await chat?.queue.recover(
      await chatRow(),
      item.id,
      item.holdId,
      "new_thread",
    );
    await ended("c-asha", 2);
    const { entries, turns } = await transcript("c-asha");
    expect(
      entries.filter(([kind]) => kind === "message").map(([, text]) => text),
    ).toEqual(["first", "second"]);
    expect(turns.map((turn) => turn.newThread)).toEqual([false, true]);
    expect((await chatRow()).threadId).not.toBe(thread);
    expect(threadsUsed()).toBe(2);
    expect(await threadStarts()).toBe(2);
    expect((await backendOf("fake").contexts()).at(-1)).toContain(
      "User: first\n\nAI: ok:first",
    );
    expect(await queue.list(await chatRow())).toMatchObject({ items: [] });
  });

  it("takes only the first of two tabs' choices for one hold", async () => {
    const thread = await afterOneReply({ resumeFails: 1 });
    await say(await chatRow(), "second");
    const item = await held();
    const row = await chatRow();
    // The second finds the hold gone, or the reply running: it changes
    // nothing.
    const [first] = await Promise.allSettled([
      chat?.queue.recover(row, item.id, item.holdId, "retry"),
      chat?.queue.recover(row, item.id, item.holdId, "new_thread"),
    ]);
    expect(first.status).toBe("fulfilled");
    await ended("c-asha", 2);
    await sleep(100);
    expect(
      (await transcript("c-asha")).entries
        .filter(([kind]) => kind === "message")
        .map(([, text]) => text),
    ).toEqual(["first", "second"]);
    expect((await chatRow()).threadId).toBe(thread);
    expect(threadsUsed()).toBe(1);
  });

  it("keeps an open-error hold and the current thread when New thread meets another running reply, then recovers once after Stop", async () => {
    const thread = await afterOneReply({ resumeFails: 1 });
    await say(await chatRow(), "held message");
    const item = await held();

    // A later message opens the same thread once the transient error passes.
    await say(await chatRow(), "partial");
    await until(async () =>
      (await transcript("c-asha")).entries.some(
        ([kind, text]) => kind === "reply" && text === "ok:part",
      ),
    );
    const before = await queue.list(await chatRow());
    await chat?.queue.recover(
      await chatRow(),
      item.id,
      item.holdId,
      "new_thread",
    );
    expect(await queue.list(await chatRow())).toEqual(before);
    expect((await chatRow()).threadId).toBe(thread);
    expect(
      (await transcript("c-asha")).turns.map((turn) => turn.status),
    ).toEqual(["completed", "running"]);

    // Stop still reaches that reply; the same hold can then be recovered.
    await chat?.stop(await chatRow());
    await ended("c-asha", 2);
    await chat?.queue.recover(
      await chatRow(),
      item.id,
      item.holdId,
      "new_thread",
    );
    await ended("c-asha", 3);
    await expect(
      chat?.queue.recover(await chatRow(), item.id, item.holdId, "new_thread"),
    ).rejects.toThrow("The waiting messages changed meanwhile.");
    const { entries, turns } = await transcript("c-asha");
    expect(
      entries.filter(([kind]) => kind === "message").map(([, text]) => text),
    ).toEqual(["first", "partial", "held message"]);
    expect(turns.map((turn) => [turn.status, turn.newThread])).toEqual([
      ["completed", false],
      ["interrupted", false],
      ["completed", true],
    ]);
    expect((await chatRow()).threadId).not.toBe(thread);
    expect((await queue.list(await chatRow())).items).toEqual([]);
    expect(threadsUsed()).toBe(2);
  });

  it("after New thread, a restart before the message went sends it once, in the new thread", async () => {
    const thread = await afterOneReply({ resumeFails: 5 });
    await say(await chatRow(), "second");
    const item = await held();
    // The choice is stored, and Rufi stops before it hands the message over.
    await queue.recover(await chatRow(), item.id, item.holdId, true);
    await startChat("fake");
    await ended("c-asha", 2);
    const { turns } = await transcript("c-asha");
    expect(turns.map((turn) => turn.newThread)).toEqual([false, true]);
    expect((await chatRow()).threadId).not.toBe(thread);
    expect(
      (await transcript("c-asha")).entries
        .filter(([kind]) => kind === "message")
        .map(([, text]) => text),
    ).toEqual(["first", "second"]);
  });

  it("starts a new thread when Codex has no record of it, also when the sign-in renews before the message goes", async () => {
    await startChat("fake", { scenario: { forgets: true } });
    await say(await newChat(), "first");
    await ended("c-asha");
    // A new token: Codex starts again, and its saved threads are gone.
    token = "renewed-token";
    await say(await chatRow(), "second");
    await ended("c-asha", 2);
    expect((await queue.list(await chatRow())).items).toEqual([]);
    const { entries, turns } = await transcript("c-asha");
    expect(
      entries.filter(([kind]) => kind === "message").map(([, text]) => text),
    ).toEqual(["first", "second"]);
    expect(turns.map((turn) => turn.newThread)).toEqual([false, true]);
  });

  it("keeps the context the thread used as Codex last reported it, for that thread only", async () => {
    await startChat("fake", {
      scenario: { usage: { tokens: 38_000, window: 100_000 } },
    });
    await say(await newChat(), "first");
    await ended("c-asha");
    await until(async () => (await chatRow()).context !== null);
    expect((await chatRow()).context).toEqual({
      tokens: 38_000,
      window: 100_000,
    });
    expect((await transcripts.page(await chatRow())).chat.context).toEqual({
      tokens: 38_000,
      window: 100_000,
    });

    // A model change keeps the thread, and its last report.
    await chat?.selectModel(await chatRow(), "gpt-6-astra");
    expect((await chatRow()).context).toEqual({
      tokens: 38_000,
      window: 100_000,
    });

    // The thread is lost: the new one shows nothing until it reports.
    const lost = (await chatRow()).threadId;
    await loseThread();
    await startChat("fake", {
      scenario: { usage: { tokens: 1_000, window: null } },
    });
    await say(await chatRow(), "second");
    await ended("c-asha", 2);
    // Codex didn't say the window: kept as it came, and nothing to show.
    const stored = () =>
      store.db
        .prepare("SELECT context_tokens, context_window FROM chats")
        .get() as {
        context_tokens: number | null;
        context_window: number | null;
      };
    await until(() => Promise.resolve(stored().context_tokens === 1_000));
    expect((await chatRow()).threadId).not.toBe(lost);
    expect(stored()).toEqual({ context_tokens: 1_000, context_window: null });
    expect((await chatRow()).context).toBeNull();
  });
});
