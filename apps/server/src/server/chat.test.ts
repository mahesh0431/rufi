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
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "../core/store/database.ts";
import { chatCaller, forAgent } from "../core/tools/tools.ts";
import { chat as openChat, type Chat } from "./chat.ts";

const FAKE = join(import.meta.dirname, "../../tests/fake-codex.ts");
const ALLOWED = ["gpt-6.1-sol", "gpt-6-astra"];

let home: string;
let store: Store;
let transcripts: Transcripts;
let chat: Chat | undefined;
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
  await chat?.close();
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
      caller: (chat, turnId) => {
        const call = chatCaller(reader, transcripts, log)(chat, turnId);
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
          entry.received?.method === "thread/queue/add"
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
    await chat?.send(c, "Hello");
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
      await chat?.send(c, "hang");
      await running(c.id);
      await chat?.send(c, "B");
      expect((await chat?.waiting.list(c))?.map((w) => w.text)).toEqual(["B"]);
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
      expect((await chat?.waiting.list(c))?.map((w) => w.text)).toEqual(["B"]);
      await chat?.send(c, "C");
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
      await Promise.all([chat?.send(c, "slow first"), chat?.send(again, "B")]);
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
      await Promise.all([
        chat?.selectModel(c, "gpt-6-astra"),
        chat?.send(c, "Hello"),
      ]);
      await ended(c.id);
      expect((await transcript(c.id)).turns).toMatchObject([
        { model: "gpt-6-astra" },
      ]);
    },
  );

  it(
    "runs a waiting message now; the others follow in order",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await chat?.send(c, "hang");
      await running(c.id);
      await chat?.send(c, "B");
      await chat?.send(c, "C");
      await chat?.stop(c);
      await ended(c.id);
      const waiting = (await chat?.waiting.list(c)) ?? [];
      await chat?.waiting.runNow(
        c,
        waiting.find((w) => w.text === "C")?.id ?? "",
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
      await chat?.send(c, "slow");
      await running(c.id);
      await chat?.steer(c, "shorter please");
      await ended(c.id);
      const { entries } = await transcript(c.id);
      expect(entries).toContainEqual(["steer", "shorter please"]);
      expect(entries).toContainEqual(["reply", "ok:shorter please"]);
      await expect(chat?.steer(c, "too late")).rejects.toThrow(
        "No reply is running to steer.",
      );
    },
  );

  it(
    "sends nothing when Stop comes while the message is getting ready",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      const gate = Promise.withResolvers<undefined>();
      tokenGate = gate.promise;
      const sending = chat?.send(c, "Hello");
      await sleep(100);
      await chat?.stop(c);
      gate.resolve(undefined);
      await expect(sending).rejects.toThrow("Stopped.");
      await sleep(300);
      expect((await transcript(c.id)).entries).toEqual([]);
    },
  );

  it("stops a reply that runs past its deadline", timeout, async () => {
    await startChat(name, { deadlines: { turnMs: 2_000 } });
    const c = await newChat();
    await chat?.send(c, "hang");
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
        await chat?.send(c, `message ${String(i)}`);
        await ended(c.id, i);
      }
      await chat?.selectModel(c, "gpt-6-astra");
      const changed = await chatRow(c.id);
      await chat?.send(changed, "after the switch");
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
      await chat?.send(c, "first");
      await ended(c.id, 1);
      await chat?.selectEffort(await chatRow(c.id), "high");
      await chat?.send(await chatRow(c.id), "second");
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
      await chat?.send(c, "hang");
      await running(c.id);
      await until(async () => (await backend.efforts()).length === 1);
      await chat?.send(c, "queued next");
      await chat?.stop(c);
      await ended(c.id);
      const [waiting] = (await chat?.waiting.list(c)) ?? [];
      if (!waiting) throw new Error("nothing waits");
      // Rufi starts again; the person runs what waited.
      await startChat(name);
      await chat?.waiting.runNow(await chatRow(), waiting.id);
      await ended(c.id, 2);
      expect(await backend.efforts()).toEqual(["high", "high"]);
    },
  );

  it(
    "refuses a model or effort change while a reply runs or a message waits",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await chat?.send(c, "hang");
      await running(c.id);
      await expect(chat?.selectModel(c, "gpt-6-astra")).rejects.toThrow(
        "Stop the reply before changing the model.",
      );
      await expect(chat?.selectEffort(c, "low")).rejects.toThrow(
        "Stop the reply before changing the effort.",
      );
      await chat?.send(c, "B");
      await chat?.stop(c);
      await ended(c.id);
      await expect(chat?.selectModel(c, "gpt-6-astra")).rejects.toThrow(
        "Run or delete the waiting messages before changing the model.",
      );
      await expect(chat?.selectEffort(c, "low")).rejects.toThrow(
        "Run or delete the waiting messages before changing the effort.",
      );
      await expect(chat?.selectModel(c, "gpt-5.5")).rejects.toThrow(
        "That model isn't allowed or isn't offered now.",
      );
      expect((await chatRow(c.id)).model).toBe("gpt-6.1-sol");
      expect((await chatRow(c.id)).effort).toBe("medium");
    },
  );

  it(
    "after a restart runs nothing until the person acts; then what waited runs first",
    timeout,
    async () => {
      // The scripted Codex records a message a moment after its turn starts,
      // as Codex does.
      await startChat(name, { scenario: { userMessageMs: 300 } });
      const c = await newChat();
      await chat?.send(c, "hang");
      // The agent has recorded the message (Rufi stores it then): a restart
      // before that loses it, in the agent too.
      await until(async () =>
        (await transcript(c.id)).entries.some(
          ([kind, text]) => kind === "message" && text === "hang",
        ),
      );
      await chat?.send(c, "B");
      await startChat(name); // Rufi restarts.
      expect((await transcript(c.id)).turns).toMatchObject([
        { status: "interrupted" },
      ]);
      await sleep(1_000);
      expect((await transcript(c.id)).turns).toHaveLength(1);
      expect(
        (await chat?.waiting.list(await chatRow(c.id)))?.map((w) => w.text),
      ).toEqual(["B"]);
      await chat?.send(await chatRow(c.id), "C");
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
      await chat?.send(c, "first");
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
      await chat?.send(await chatRow(c.id), "after restart");
      await sleep(1_000);
      const switching = chat?.selectModel(await chatRow(c.id), "gpt-6-astra");
      const sending = chat?.send(await chatRow(c.id), "after the switch");
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
      // Rufi "crashes" between the agent starting the message and saving it.
      const addMessage = transcripts.addMessage;
      transcripts.addMessage = () => Promise.reject(new Error("crash"));
      await chat?.send(c, "first");
      await ended(c.id);
      transcripts.addMessage = addMessage;
      expect(
        (await transcript(c.id)).entries.filter(([kind]) => kind === "message"),
      ).toEqual([]);
      await startChat(name);
      await chat?.send(await chatRow(c.id), "second");
      await ended(c.id, 2);
      await startChat(name);
      await chat?.send(await chatRow(c.id), "third");
      await ended(c.id, 3);
      expect(
        (await transcript(c.id)).entries
          .filter(([kind]) => kind === "message")
          .map(([, text]) => text),
      ).toEqual(["first", "second", "third"]);
    },
  );
});

describe("the chat, on the scripted Codex", () => {
  it("sends nothing when Stop comes while the effort is being set", async () => {
    await startChat("fake", {
      scenario: { slow: ["thread/settings/update"], slowMs: 250 },
    });
    const c = await newChat();
    await chat?.send(c, "first");
    await ended(c.id);
    // A new effort for the thread that runs: it is set before the message.
    await chat?.selectEffort(await chatRow(), "high");
    const sent = chat
      ?.send(await chatRow(), "Not after Stop")
      .catch((error: unknown) => error);
    const received = async () =>
      (await readFile(join(home, "fake.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { received?: { method?: string } })
        .map((line) => line.received?.method);
    await until(async () =>
      (await received()).includes("thread/settings/update"),
    );
    await chat?.stop(await chatRow());
    await sent;
    await sleep(400);
    expect(
      (await received()).filter((method) => method === "thread/queue/add"),
    ).toHaveLength(1);
  });

  it("starts and changes to allowed models the provider offers only", async () => {
    await startChat("fake", { allowlist: ["gpt-retired", "gpt-6-astra"] });
    const c = await newChat();
    expect(c.model).toBeNull();
    await chat?.send(c, "Hello");
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
    await expect(chat?.send(ravis, "Hello")).rejects.toThrow(
      "None of the allowed models is offered now.",
    );
  });

  it("goes on with a resumed thread when its history can't be read", async () => {
    const options = {
      scenario: { hang: ["thread/turns/list"] },
      deadlines: { requestMs: 300 },
    };
    await startChat("fake", options);
    const c = await newChat();
    await chat?.send(c, "first");
    await ended(c.id);
    const { threadId } = await chatRow(c.id);
    await startChat("fake", options); // Rufi restarts.
    await chat?.send(await chatRow(c.id), "hang");
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
    await chat?.send(c, "drip");
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
    await chat?.send(c, "drip");
    await chat?.send(c, "hang");
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
    await chat?.send(c, "Show results");
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
    await chat?.send(c, "What's new?");
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
    await chat?.send(c, asked);
    await ended(c.id);
    // Small talk: the AI reads nothing and writes no block.
    await chat?.send(await chatRow(c.id), "quiet thanks");
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
    await chat?.send(c, "hang");
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
    await chat?.send(c, "hang");
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
    await chat?.send(c, "hang: I have a headache");
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
    await chat?.send(c, "I have a headache");
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
    await chat?.send(c, "I have a headache");
    await ended(c.id);
    await chat?.selectModel(await chatRow(c.id), "gpt-6-astra");
    await startChat("fake");
    await chat?.send(await chatRow(c.id), "And now?");
    await ended(c.id, 2);
    expect((await backendOf("fake").contexts()).at(-1)).toContain(
      "User: I have a headache\n\nRufi: **Saved**\n\n- Added symptom **Headache**\n\nAI: ok:I have a headache",
    );
  });

  it("saves nothing of a reply after its Stop", async () => {
    await startChat("fake", { scenario: { late: true } });
    const c = await newChat();
    await chat?.send(c, "hang");
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
    await chat?.send(c, "first");
    await ended(c.id, 1);
    // Chosen and changed back before a message: the thread goes on.
    await chat?.selectModel(c, "gpt-6-astra");
    await chat?.selectModel(c, "gpt-6.1-sol");
    await chat?.send(await chatRow(), "second");
    await ended(c.id, 2);
    // A new model; the first send to its new thread is stopped while the
    // thread starts, before the message leaves. (Stopped during the add, it
    // would wait in the queue and run with the next send.)
    await chat?.selectModel(c, "gpt-6-astra");
    const stopped = chat?.send(await chatRow(), "never sent");
    await sleep(100);
    await chat?.stop(await chatRow());
    await expect(stopped).rejects.toThrow();
    await chat?.send(await chatRow(), "third");
    await ended(c.id, 3);
    await chat?.send(await chatRow(), "fourth");
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
    await chat?.send(c, "Hello");
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
    await chat?.send(c, "please fail");
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
    await chat?.send(c, "Hello");
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
    await chat?.send(await chatRow(c.id), "Hello");
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
    await expect(chat?.send(c, "Hello")).rejects.toThrow(
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
    await chat?.send(await chatRow(c.id), "And?");
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
