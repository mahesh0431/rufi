// The chat with its agent, as one contract: the same tests run against the
// scripted fake Codex and against the real Codex binary (on a local fake
// model, offline). What a reply does is chosen by the message's words: see
// tests/fake-codex.ts and tests/fake-model.ts.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Entry } from "@rufi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Scenario } from "../../tests/fake-codex.ts";
import { fakeModel, type FakeModel } from "../../tests/fake-model.ts";
import { codexBinary } from "../agent/codex/binary.ts";
import { codexRuntime } from "../agent/codex/codex.ts";
import type { Deadlines } from "../agent/codex/appserver.ts";
import type { AgentHost } from "../agent/runtime.ts";
import {
  transcripts as openTranscripts,
  type ChatRow,
  type Transcripts,
} from "../core/chat/transcript.ts";
import { documents } from "../core/documents/documents.ts";
import { pages } from "../core/documents/pages.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "../core/store/database.ts";
import { chatCaller, forAgent } from "../core/tools/tools.ts";
import { v7 as uuid } from "uuid";
import { chatQueue, type ChatQueue } from "../core/chat/queue.ts";
import { chat as openChat, type Chat } from "./chat.ts";

const FAKE = join(import.meta.dirname, "../../tests/fake-codex.ts");
const ALLOWED = ["gpt-6.1-sol", "gpt-6-astra"];

let home: string;
let store: Store;
let transcripts: Transcripts;
let queue: ChatQueue;
let chat: Chat | undefined;
/** Whether the person is signed in, as the chat asks it. */
let signedIn: boolean;
let model: FakeModel | undefined;
let tokenGate: Promise<void> | undefined;

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
  tokenGate = undefined;
});
afterEach(async () => {
  await chat?.close();
  chat = undefined;
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
}

/** Starts the chat (again, as after a restart) on the backend. */
async function startChat(
  backend: Backend["name"],
  options: {
    scenario?: Scenario;
    deadlines?: Partial<Deadlines>;
    /** How long Rufi's tools take. */
    toolMs?: number;
    allowlist?: string[];
  } = {},
): Promise<Chat> {
  const again = chat !== undefined;
  await chat?.close();
  // As the core does when it starts again.
  if (again) await queue.endStopped();
  const reader = openReadOnly(databasePath(home));
  const log = () => undefined;
  const tools = forAgent(() => ({ store: reader, personId: undefined }), log);
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
  chat = openChat({
    transcripts,
    queue,
    signedIn: () => Promise.resolve(signedIn),
    agent: (host: AgentHost) =>
      codexRuntime({
        home,
        command,
        env: {
          PATH: process.env["PATH"] ?? "",
          FAKE_CODEX: JSON.stringify(options.scenario ?? {}),
          FAKE_CODEX_LOG: join(home, "fake.jsonl"),
        },
        token: async () => {
          await tokenGate;
          return "token";
        },
        version: "0.0.0",
        deadlines: { requestMs: 10_000, turnMs: 20_000, ...options.deadlines },
        tools: { namespace: tools.namespace, specs: tools.specs },
        host,
        log,
      }),
    allowlist: () => Promise.resolve({ models: options.allowlist ?? ALLOWED }),
    tools: {
      version: "tools-1",
      instructions: "Read the record only through the rufi tools.",
      caller: (chat, turnId, origin) => {
        const call = chatCaller(
          reader,
          transcripts,
          log,
          reader && pages(reader, home),
        )(chat, turnId, origin);
        return async (name, input, callId) => {
          await sleep(options.toolMs ?? 0);
          return call(name, input, callId);
        };
      },
    },
    log,
  });
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
    efforts: async () => {
      if (name === "real") {
        return (model?.requests ?? []).map(
          (request) => request.reasoning?.effort ?? null,
        );
      }
      const lines = (await readFile(join(home, "fake.jsonl"), "utf8"))
        .trim()
        .split("\n");
      return lines.flatMap((line) => {
        const entry = JSON.parse(line) as { turn?: string; effort?: string };
        return entry.turn === undefined ? [] : [entry.effort ?? null];
      });
    },
  };
}

/** The AI saves a headache the user told it about. */
const saveHeadache = {
  namespace: "rufi",
  tool: "save_changes",
  arguments: {
    changes: [
      {
        kind: "symptom",
        action: "add",
        source: "I have a headache",
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

/** What waits in the chat's queue, as [text, state, held]. */
const waiting = async () =>
  (await queue.list(await chatRow())).items.map((item) => [
    item.text,
    item.state,
    item.held,
  ]);

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

  it("stores each part of a reply before it is shown", timeout, async () => {
    await startChat(name);
    const c = await newChat();
    const shown: Entry[] = [];
    let unsaved = 0;
    transcripts.subscribe(c.id, (change) => {
      // What is shown is already in the database, exactly so.
      const rows = store.db
        .prepare("SELECT id, text FROM transcript_entries WHERE chat_id = ?")
        .all(c.id) as { id: string; text: string }[];
      for (const entry of change.entries) {
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
    "holds a message sent during a reply, keeps it waiting after Stop, and runs it first at the next send",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "hang");
      await running(c.id);
      await say(c, "B");
      expect(await waiting()).toEqual([["B", "waiting", null]]);
      // A waiting message is not in the transcript; the running one is.
      await until(async () => (await transcript(c.id)).entries.length > 0);
      expect((await transcript(c.id)).entries).toEqual([["message", "hang"]]);
      await chat?.stop(c);
      await ended(c.id);
      expect((await transcript(c.id)).turns[0]).toMatchObject({
        status: "interrupted",
        endReason: "stopped",
      });
      await sleep(500);
      expect(await waiting()).toEqual([["B", "waiting", null]]);
      expect((await chatRow()).paused).toBe("stopped");
      await say(c, "C");
      await ended(c.id, 3);
      expect(
        (await transcript(c.id)).entries.filter(
          ([kind]) => kind === "message" || kind === "reply",
        ),
      ).toEqual([
        ["message", "hang"],
        ["message", "B"],
        ["reply", "ok:B"],
        ["message", "C"],
        ["reply", "ok:C"],
      ]);
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
      await say(c, "hang");
      await running(c.id);
      await say(c, "B");
      await say(c, "C");
      await chat?.stop(c);
      await ended(c.id);
      const { items } = await queue.list(c);
      await chat?.queue.sendNow(
        c,
        items.find((item) => item.text === "C")?.id ?? "",
      );
      await ended(c.id, 3);
      expect(
        (await transcript(c.id)).entries
          .filter(([kind]) => kind === "message")
          .map(([, text]) => text),
      ).toEqual(["hang", "C", "B"]);
    },
  );

  it(
    "passes a steer into the running reply and saves it as a steer",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "slow");
      await running(c.id);
      await chat?.steer(c, uuid(), "shorter please");
      await ended(c.id);
      const { entries } = await transcript(c.id);
      expect(entries).toContainEqual(["steer", "shorter please"]);
      expect(entries).toContainEqual(["reply", "ok:shorter please"]);
      await expect(chat?.steer(c, uuid(), "too late")).rejects.toThrow(
        "The reply had ended, so this wasn't passed into it.",
      );
    },
  );

  it(
    "hands nothing over when Stop comes while the message is getting ready; it waits",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      const gate = Promise.withResolvers<undefined>();
      tokenGate = gate.promise;
      await say(c, "Hello");
      await sleep(100);
      await chat?.stop(c);
      gate.resolve(undefined);
      await sleep(300);
      expect((await transcript(c.id)).entries).toEqual([]);
      expect(await waiting()).toEqual([["Hello", "waiting", null]]);
    },
  );

  it("stops a reply that runs past its deadline", timeout, async () => {
    await startChat(name, { deadlines: { turnMs: 2_000 } });
    const c = await newChat();
    await say(c, "hang");
    await ended(c.id);
    expect((await transcript(c.id)).turns[0]).toMatchObject({
      status: "failed",
      endReason: "timeout",
      endText: "The reply took too long, so Rufi stopped it.",
    });
  });

  it(
    "starts a new thread on a model change, with the last 10 messages and the note",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      for (let i = 1; i <= 6; i++) {
        await say(c, `message ${String(i)}`);
        await ended(c.id, i);
      }
      await chat?.selectModel(c, "gpt-6-astra");
      const changed = await chatRow(c.id);
      await say(changed, "after the switch");
      await ended(c.id, 7);
      const [context] = await backend.contexts();
      expect(context).toBe(
        [
          "The model changed and a new thread started. Older history is available through read_chat.",
          "The last messages of this chat, oldest first:",
          ...[2, 3, 4, 5, 6].flatMap((i) => [
            `User: message ${String(i)}`,
            `AI: ok:message ${String(i)}`,
          ]),
        ].join("\n\n"),
      );
      const { turns, entries } = await transcript(c.id);
      expect(turns.at(-1)?.model).toBe("gpt-6-astra");
      // The context is the new thread's, never part of the user's message.
      expect(entries.filter(([kind]) => kind === "message").at(-1)).toEqual([
        "message",
        "after the switch",
      ]);
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
      expect(turns.map((turn) => turn.afresh)).toEqual([false, false]);
      expect((await chatRow(c.id)).effort).toBe("high");
    },
  );

  it(
    "after a restart, a waiting message runs with the chat's effort",
    timeout,
    async () => {
      await startChat(name);
      await chat?.selectEffort(await newChat(), "high");
      const c = await chatRow();
      await say(c, "hang");
      await running(c.id);
      await until(async () => (await backend.efforts()).length === 1);
      await say(c, "queued next");
      await chat?.stop(c);
      await ended(c.id);
      const [next] = (await queue.list(c)).items;
      if (!next) throw new Error("nothing waits");
      // Rufi starts again; the person sends what waited.
      await startChat(name);
      await chat?.queue.sendNow(await chatRow(), next.id);
      await ended(c.id, 2);
      expect(await backend.efforts()).toEqual(["high", "high"]);
    },
  );

  it(
    "refuses a model or effort change while a reply runs; what waits goes to the new model",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "hang");
      await running(c.id);
      await until(async () => (await backend.efforts()).length === 1);
      await expect(chat?.selectModel(c, "gpt-6-astra")).rejects.toThrow(
        "Stop the reply before changing the model.",
      );
      await expect(chat?.selectEffort(c, "low")).rejects.toThrow(
        "Stop the reply before changing the effort.",
      );
      await say(c, "B");
      await chat?.stop(c);
      await ended(c.id);
      await expect(chat?.selectModel(c, "gpt-5.5")).rejects.toThrow(
        "That model isn't allowed or isn't offered now.",
      );
      await chat?.selectModel(c, "gpt-6-astra");
      await chat?.selectEffort(c, "low");
      await say(await chatRow(), "C");
      await ended(c.id, 3);
      expect((await transcript(c.id)).turns.map((t) => t.model)).toEqual([
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6-astra",
      ]);
      expect((await backend.efforts()).slice(1)).toEqual(["low", "low"]);
    },
  );

  it(
    "after a restart runs nothing until the person acts; then what waited runs first",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "hang");
      await running(c.id);
      await say(c, "B");
      await startChat(name); // Rufi restarts.
      expect((await transcript(c.id)).turns).toMatchObject([
        { status: "interrupted" },
      ]);
      await sleep(1_000);
      expect((await transcript(c.id)).turns).toHaveLength(1);
      expect(await waiting()).toEqual([["B", "waiting", null]]);
      expect((await chatRow()).paused).toBe("restarted");
      await say(await chatRow(c.id), "C");
      await ended(c.id, 3);
      expect(
        (await transcript(c.id)).entries
          .filter(([kind]) => kind === "message")
          .map(([, text]) => text),
      ).toEqual(["hang", "B", "C"]);
    },
  );

  it(
    "keeps every reply when the model changes while a restart's history read is slow",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "first");
      await ended(c.id);
      await startChat(name); // Rufi restarts.
      const agent = chat?.agent;
      if (!agent) throw new Error("no chat");
      // The history read after the resume is slow; the reply isn't.
      const gate = Promise.withResolvers<undefined>();
      const read = agent.startedMessages;
      agent.startedMessages = async (threadId) => {
        await gate.promise;
        return read(threadId);
      };
      await say(await chatRow(c.id), "after restart");
      await sleep(1_000);
      const switching = chat?.selectModel(await chatRow(c.id), "gpt-6-astra");
      const sending = say(await chatRow(c.id), "after the switch");
      await sleep(300);
      gate.resolve(undefined);
      await Promise.all([switching, sending]);
      await ended(c.id, 3);
      const { entries, turns } = await transcript(c.id);
      expect(entries.filter(([kind]) => kind === "reply")).toEqual([
        ["reply", "ok:first"],
        ["reply", "ok:after restart"],
        ["reply", "ok:after the switch"],
      ]);
      expect(turns.map((t) => [t.status, t.model])).toEqual([
        ["completed", "gpt-6.1-sol"],
        ["completed", "gpt-6.1-sol"],
        ["completed", "gpt-6-astra"],
      ]);
      // The new thread's seed has the reply too.
      expect((await backend.contexts()).at(-1)).toContain(
        "AI: ok:after restart",
      );
    },
  );

  it(
    "fills a message a crash kept from the transcript, once, from the agent's own record",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      // Rufi couldn't save the start of the message's turn.
      const startTurn = transcripts.startTurn;
      transcripts.startTurn = () => Promise.reject(new Error("crash"));
      await say(c, "first");
      await until(async () => (await waiting()).length === 1);
      await until(async () => (await waiting())[0]?.[1] === "not_sure");
      transcripts.startTurn = startTurn;
      expect(
        (await transcript(c.id)).entries.filter(([kind]) => kind === "message"),
      ).toEqual([]);
      await startChat(name);
      await say(await chatRow(c.id), "second");
      await ended(c.id, 1);
      await startChat(name);
      await say(await chatRow(c.id), "third");
      await ended(c.id, 2);
      expect(
        (await transcript(c.id)).entries
          .filter(([kind]) => kind === "message")
          .map(([, text]) => text),
      ).toEqual(["first", "second", "third"]);
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
      await documents(store, home).add(
        "asha",
        [{ name: "Fictional thyroid.jpg", bytes: new Uint8Array(bytes) }],
        false,
      )
    ).added;
    const imageUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    model = await fakeModel({
      script: [
        {
          exec: `const result = await tools.rufi__get_documents({document: ${JSON.stringify(documentId)}, page: 1}); image(result.split('\\n')[1]);`,
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
    ).toMatchObject([
      { text: "Looked at page 1 of a document", status: "done" },
    ]);
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

  it("sends a message's chips with it: the AI gets them after the words, and the message keeps them with their versions then", async () => {
    store.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('ravi', 'Ravi Fictional');
      INSERT INTO files (id, size, media_type, created_at) VALUES ('f-1', 1, 'application/pdf', '2026-10-01T09:00:00Z');
      INSERT INTO documents (id, person_id, added_at, added_from, version) VALUES
        ('doc-1', 'asha', '2026-10-01T09:00:00Z', 'chat', 3),
        ('doc-r', 'ravi', '2026-10-01T09:00:00Z', 'chat', 1);
      INSERT INTO document_pages (person_id, document_id, position, file_id, page_in_file, file_name) VALUES
        ('asha', 'doc-1', 1, 'f-1', 1, 'Sunrise Labs August.pdf'),
        ('ravi', 'doc-r', 1, 'f-1', 1, 'Ravi lipid panel.pdf');
      INSERT INTO results (id, person_id, test_name, value_text, unit, measured_at, entered_at)
        VALUES ('res-1', 'asha', 'HbA1c', '6.8', '%', '2026-08-12', '2026-08-13T00:00:00Z');
    `);
    await startChat("fake");
    const c = await newChat();
    const id = uuid();
    await chat?.send(c, id, "Save it", [
      { type: "document", id: "doc-1" },
      { type: "record", kind: "result", id: "res-1" },
    ]);
    await ended(c.id);
    expect((await inputs()).at(-1)).toEqual([
      "Save it\n\nReferences the user added to this message (Rufi's, exact: read them with your tools):\n- document doc-1, version 3: Sunrise Labs August.pdf\n- result res-1 (kind result), version null: HbA1c 6.8 % · 12 Aug 2026",
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
          detail: "Result in your record",
        },
      ],
    });
    // Another person's document is refused, and nothing waits.
    await expect(
      chat?.send(c, uuid(), "And this", [{ type: "document", id: "doc-r" }]),
    ).rejects.toThrow(
      "Something added to this message isn't in this person's record. Take it out of the message and add it again.",
    );
    expect(await waiting()).toEqual([]);
  });

  it("takes a retried send once: one waiting row, one message", async () => {
    await startChat("fake");
    const c = await newChat();
    await say(c, "hang");
    await running(c.id);
    const id = uuid();
    await chat?.send(c, id, "B");
    await chat?.send(c, id, "B");
    expect(await waiting()).toEqual([["B", "waiting", null]]);
    // The box's draft was emptied with it.
    expect(store.db.prepare("SELECT text FROM drafts").all()).toEqual([
      { text: "" },
    ]);
    await chat?.stop(c);
  });

  it("gives Rufi events that came during a reply to the AI together, after it, in a turn that can only read", async () => {
    await startChat("fake", { scenario: { calls: [saveHeadache] } });
    const c = await newChat();
    await say(c, "slow quiet");
    await running(c.id);
    await event("Lab report read");
    await event("Second report read");
    await ended(c.id, 2);
    await sleep(300);
    const { entries, turns, all } = await transcript(c.id);
    // One turn for both, started by Rufi; never the person's message.
    expect(turns).toHaveLength(2);
    expect(entries.filter(([kind]) => kind === "message")).toEqual([
      ["message", "slow quiet"],
    ]);
    expect(all.filter((e) => e.kind === "event").map((e) => e.text)).toEqual([
      "Lab report read",
      "Second report read",
    ]);
    expect((await inputs()).at(-1)).toEqual([
      expect.stringContaining(
        "Note: Lab report read\n\nNote: Second report read",
      ),
    ]);
    // Its save was refused, with the reason, and nothing was saved.
    const [call] = store.db
      .prepare("SELECT tool, ok, answer FROM tool_calls")
      .all() as { tool: string; ok: number; answer: string }[];
    expect(call).toMatchObject({ tool: "save_changes", ok: 0 });
    expect(call?.answer).toContain("started by a Rufi event");
    expect(store.db.prepare("SELECT * FROM symptoms").all()).toEqual([]);
    expect(await waiting()).toEqual([]);
  });

  it("after Stop, holds an event: it rides with the next message, once, never a turn of its own", async () => {
    await startChat("fake");
    const c = await newChat();
    await say(c, "hang");
    await running(c.id);
    await chat?.stop(c);
    await ended(c.id);
    await event("Lab report read");
    await sleep(500);
    expect((await transcript(c.id)).turns).toHaveLength(1);
    expect(await waiting()).toEqual([["Lab report read", "waiting", "paused"]]);
    await say(await chatRow(), "What's new?");
    await ended(c.id, 2);
    await sleep(500);
    expect((await transcript(c.id)).turns).toHaveLength(2);
    const last = (await inputs()).at(-1) ?? [];
    expect(last.at(-1)).toBe("What's new?");
    expect(last.at(-2)).toContain("Note: Lab report read");
    expect(await waiting()).toEqual([]);
  });

  it("holds messages while signed out; signing in sends nothing; Send now does", async () => {
    await startChat("fake");
    const c = await newChat();
    signedIn = false;
    await say(c, "Hello");
    await until(async () => (await waiting())[0]?.[2] === "signed_out");
    signedIn = true;
    await sleep(300);
    expect((await transcript(c.id)).turns).toEqual([]);
    const [held] = (await queue.list(c)).items;
    await chat?.queue.sendNow(c, held?.id ?? "");
    await ended(c.id);
    expect((await transcript(c.id)).entries[0]).toEqual(["message", "Hello"]);
  });

  it("marks a hand-over Rufi stopped during as not sure, never sends it again by itself, and sends it again as new only when asked", async () => {
    await startChat("fake");
    const c = await newChat();
    // Rufi stopped while it handed "Hello" to the AI.
    await queue.accept(c, uuid(), "Hello");
    store.db.exec("UPDATE chat_queue SET state = 'handing_over', sent_as = id");
    await startChat("fake"); // Rufi starts again.
    expect(await waiting()).toEqual([["Hello", "not_sure", null]]);
    await say(await chatRow(), "Other");
    await ended(c.id);
    await sleep(300);
    expect(await waiting()).toEqual([["Hello", "not_sure", null]]);
    const [unsure] = (await queue.list(c)).items;
    await chat?.queue.sendNow(c, unsure?.id ?? "");
    await ended(c.id, 2);
    const messages = (await transcript(c.id)).all.filter(
      (e) => e.kind === "message",
    );
    expect(messages.map((e) => e.text)).toEqual(["Other", "Hello"]);
    expect(messages[1]?.id).not.toBe(unsure?.id);
    expect(await waiting()).toEqual([]);
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
        calls: [{ namespace: "rufi", tool: "get_overview", arguments: {} }],
        reasoning: ["**Reading the record**"],
      },
    });
    const c = await newChat();
    await say(c, "What's new?");
    await ended(c.id);
    const { all, turns } = await transcript(c.id);
    // The screens get the lines, never the reasoning.
    expect(
      all
        .filter((e) => e.kind !== "message" && e.kind !== "reply")
        .map((e) => [e.activity, e.text, e.detail, e.status]),
    ).toEqual([
      ["tool", "Read your overview", null, "done"],
      ["command", "Ran a command", "ls", "done"],
      ["other", "The AI did something Rufi can't display", "teleport", "done"],
    ]);
    const kept = store.db
      .prepare(
        "SELECT kind, text, details FROM transcript_entries WHERE kind IN ('activity', 'reasoning') ORDER BY seq",
      )
      .all()
      .map((row): unknown[] => [
        row["kind"],
        row["text"],
        JSON.parse(String(row["details"])),
      ]);
    expect(kept).toMatchObject([
      [
        "activity",
        "Read your overview",
        { type: "dynamicToolCall", tool: "get_overview" },
      ],
      [
        "reasoning",
        "**Reading the record**",
        { summary: ["**Reading the record**"] },
      ],
      [
        "activity",
        "Ran a command",
        { aggregatedOutput: "notes.txt\n", exitCode: 0 },
      ],
      [
        "activity",
        "The AI did something Rufi can't display",
        { type: "teleport" },
      ],
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
    expect(turns[0]?.used).toEqual([
      {
        title: "Read your overview",
        detail: null,
        outcome: "done",
        note: null,
      },
      { title: "Ran a command", detail: "ls", outcome: "done", note: null },
    ]);
  });

  it("shows How only from a completed reply, and each reply's Used is its own", async () => {
    await startChat("fake", {
      scenario: {
        calls: [
          {
            namespace: "rufi",
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
    // The activity line names the read in the same words as Used.
    expect(entries).toContainEqual([
      "activity",
      "Read your results since 2024",
    ]);
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
    expect(turns.map((t) => [t.how, t.used])).toEqual([
      [
        "From the record, read now.",
        [
          {
            title: "Read your results since 2024",
            detail: null,
            outcome: "done",
            note: "0 records",
          },
          { title: "Ran a command", detail: "ls", outcome: "done", note: null },
        ],
      ],
      [null, []],
    ]);
  });

  it("stops a reply when Rufi can't keep a call to its tools, and tells the AI", async () => {
    await startChat("fake", {
      scenario: {
        calls: [{ namespace: "rufi", tool: "get_overview", arguments: {} }],
      },
    });
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
      .filter((line) => line.includes('"answered":"item/tool/call"'));
    expect(answered).toHaveLength(1);
    expect(answered[0]).toContain("Rufi couldn't keep this call");
    expect(answered[0]).not.toContain("Asha Fictional");
  });

  it("keeps a tool's late result out: the activity is stopped, not done", async () => {
    await startChat("fake", {
      scenario: {
        calls: [{ namespace: "rufi", tool: "get_overview", arguments: {} }],
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

  it("keeps a save that lands after Stop, with its receipt", async () => {
    await startChat("fake", {
      scenario: { calls: [saveHeadache] },
      toolMs: 500,
    });
    const c = await newChat();
    await say(c, "hang: I have a headache");
    await until(async () =>
      (await transcript(c.id)).entries.some(([kind]) => kind === "activity"),
    );
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
    await chat?.selectModel(await chatRow(c.id), "gpt-6-astra");
    await startChat("fake");
    await say(await chatRow(c.id), "And now?");
    await ended(c.id, 2);
    expect((await backendOf("fake").contexts()).at(-1)).toContain(
      "User: I have a headache\n\nRufi: **Saved**\n\n- Added symptom **Headache**\n\nAI: ok:I have a headache",
    );
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

  it("marks only the first reply on a new thread as afresh: a model chosen and not used, or a send stopped before it began, marks nothing", async () => {
    await startChat("fake", {
      scenario: { slow: ["thread/start"], slowMs: 300 },
    });
    const c = await newChat();
    await say(c, "first");
    await ended(c.id, 1);
    // Chosen and changed back before a message: the thread goes on.
    await chat?.selectModel(c, "gpt-6-astra");
    await chat?.selectModel(c, "gpt-6.1-sol");
    await say(await chatRow(), "second");
    await ended(c.id, 2);
    // A new model; the first message to its new thread is stopped while
    // the thread starts, before it leaves, and the person removes it.
    await chat?.selectModel(c, "gpt-6-astra");
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
    expect(turns.map((t) => t.afresh)).toEqual([false, false, true, false]);
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
      { text: "Compacted its memory of the chat", status: "done" },
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

  it("gives a new thread the model, the safety instructions first, and the tools' rules", async () => {
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
            received?: { method?: string; params?: Record<string, string> };
          },
      )
      .find((entry) => entry.received?.method === "thread/start")
      ?.received?.params;
    expect(start?.["model"]).toBe("gpt-6.1-sol");
    expect(start?.["developerInstructions"]).toMatch(
      /^You are the AI inside Rufi[\s\S]*call 112 \(the emergency number in India\) now[\s\S]*\n\nRead the record only through the rufi tools\.$/,
    );
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
    await until(async () => (await waiting())[0]?.[2] === "failed");
    expect((await queue.list(c)).items[0]?.heldText).toBe(
      "Codex didn't answer thread/start within 0.3 s.",
    );
  });

  it("shows a cut reply's answer without How or half a block, with what it had read, and passes it on marked", async () => {
    const c = await newChat();
    await transcripts.startTurn(c, "t-1", {
      id: "thread-cut",
      model: "gpt-6.1-sol",
    });
    await transcripts.recordToolCall(c, "t-1", {
      callId: "call-1",
      tool: "get_records",
      input: { kind: "result", to: "2026-08" },
      answer: {
        ok: false,
        text: JSON.stringify({
          ok: false,
          error: "Rufi couldn't run get_records.",
        }),
      },
      startedAt: "2026-10-08T10:00:00Z",
    });
    await transcripts.appendReply(
      c,
      "t-1",
      "item-1",
      "Your HbA1c was 6.8 %.\n\n```rufi-basis\nFrom the rec",
    );
    await openTranscripts(store).interruptRunning();
    const { entries, turns } = await transcript(c.id);
    expect(entries).toEqual([["reply", "Your HbA1c was 6.8 %."]]);
    expect(turns).toMatchObject([
      {
        how: null,
        used: [
          {
            title: "Read your results up to Aug 2026",
            detail: null,
            outcome: "failed",
            note: "Rufi couldn't run get_records.",
          },
        ],
      },
    ]);
    expect(await transcripts.lastMessages(c, 10)).toEqual([
      { from: "ai", text: "Your HbA1c was 6.8 %.", unfinished: true },
    ]);
    // A new thread hears it as unfinished.
    await startChat("fake");
    await say(await chatRow(c.id), "And?");
    await ended(c.id, 2);
    expect((await backendOf("fake").contexts()).at(-1)).toContain(
      "AI (this reply didn't finish): Your HbA1c was 6.8 %.",
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
