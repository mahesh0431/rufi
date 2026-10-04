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
  type ConversationRow,
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
  store.db.exec(
    "INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional')",
  );
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
      caller: (conversation, turnId) => {
        const call = chatCaller(reader, transcripts, log)(conversation, turnId);
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

const conversation = async (id: string): Promise<ConversationRow> => {
  const found = await transcripts.conversation("asha", id);
  if (!found) throw new Error("no conversation");
  return found;
};

async function newConversation(): Promise<ConversationRow> {
  if (!chat) throw new Error("no chat");
  const { id } = await chat.create("asha", "Fictional chat");
  return conversation(id);
}

/** The transcript as [kind, text] pairs, and the turns' statuses. */
async function transcript(id: string) {
  const snapshot = await transcripts.snapshot(await conversation(id));
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
    const c = await newConversation();
    const shown: Entry[] = [];
    let unsaved = 0;
    transcripts.subscribe(c.id, (change) => {
      // What is shown is already in the database, exactly so.
      const rows = store.db
        .prepare(
          "SELECT id, text FROM transcript_entries WHERE conversation_id = ?",
        )
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
      const c = await newConversation();
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
      const c = await newConversation();
      // Two requests, each with the conversation as it read it.
      const again = await conversation(c.id);
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
    "sends with the new model when the model changed after the request read the conversation",
    timeout,
    async () => {
      await startChat(name);
      const c = await newConversation();
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
      const c = await newConversation();
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
      const c = await newConversation();
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
      const c = await newConversation();
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
    const c = await newConversation();
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
      const c = await newConversation();
      for (let i = 1; i <= 6; i++) {
        await chat?.send(c, `message ${String(i)}`);
        await ended(c.id, i);
      }
      await chat?.selectModel(c, "gpt-6-astra");
      const changed = await conversation(c.id);
      await chat?.send(changed, "after the switch");
      await ended(c.id, 7);
      const [context] = await backend.contexts();
      expect(context).toBe(
        [
          "The model changed and a new thread started. Older history is available through read_conversation.",
          "The last messages of this conversation, oldest first:",
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
    "refuses a model change while a reply runs or a message waits",
    timeout,
    async () => {
      await startChat(name);
      const c = await newConversation();
      await chat?.send(c, "hang");
      await running(c.id);
      await expect(chat?.selectModel(c, "gpt-6-astra")).rejects.toThrow(
        "Stop the reply before changing the model.",
      );
      await chat?.send(c, "B");
      await chat?.stop(c);
      await ended(c.id);
      await expect(chat?.selectModel(c, "gpt-6-astra")).rejects.toThrow(
        "Run or delete the waiting messages before changing the model.",
      );
      await expect(chat?.selectModel(c, "gpt-5.5")).rejects.toThrow(
        "That model isn't allowed or isn't offered now.",
      );
      expect((await conversation(c.id)).model).toBe("gpt-6.1-sol");
    },
  );

  it(
    "after a restart runs nothing until the person acts; then what waited runs first",
    timeout,
    async () => {
      await startChat(name);
      const c = await newConversation();
      await chat?.send(c, "hang");
      await running(c.id);
      await chat?.send(c, "B");
      await startChat(name); // Rufi restarts.
      expect((await transcript(c.id)).turns).toMatchObject([
        { status: "interrupted" },
      ]);
      await sleep(1_000);
      expect((await transcript(c.id)).turns).toHaveLength(1);
      expect(
        (await chat?.waiting.list(await conversation(c.id)))?.map(
          (w) => w.text,
        ),
      ).toEqual(["B"]);
      await chat?.send(await conversation(c.id), "C");
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
      const c = await newConversation();
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
      await chat?.send(await conversation(c.id), "after restart");
      await sleep(1_000);
      const switching = chat?.selectModel(
        await conversation(c.id),
        "gpt-6-astra",
      );
      const sending = chat?.send(await conversation(c.id), "after the switch");
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
      const c = await newConversation();
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
      await chat?.send(await conversation(c.id), "second");
      await ended(c.id, 2);
      await startChat(name);
      await chat?.send(await conversation(c.id), "third");
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
  it("starts and changes to allowed models the provider offers only", async () => {
    await startChat("fake", { allowlist: ["gpt-retired", "gpt-6-astra"] });
    const c = await newConversation();
    expect(c.model).toBeNull();
    await chat?.send(c, "Hello");
    expect((await conversation(c.id)).model).toBe("gpt-6-astra");
    await expect(chat?.selectModel(c, "gpt-retired")).rejects.toThrow(
      "That model isn't allowed or isn't offered now.",
    );
    await startChat("fake", { allowlist: ["gpt-retired"] });
    await expect(chat?.send(await newConversation(), "Hello")).rejects.toThrow(
      "None of the allowed models is offered now.",
    );
  });

  it("goes on with a resumed thread when its history can't be read", async () => {
    const options = {
      scenario: { hang: ["thread/turns/list"] },
      deadlines: { requestMs: 300 },
    };
    await startChat("fake", options);
    const c = await newConversation();
    await chat?.send(c, "first");
    await ended(c.id);
    const { threadId } = await conversation(c.id);
    await startChat("fake", options); // Rufi restarts.
    await chat?.send(await conversation(c.id), "hang");
    await running(c.id);
    // The same thread, and Stop reaches its reply.
    expect((await conversation(c.id)).threadId).toBe(threadId);
    await chat?.stop(await conversation(c.id));
    await ended(c.id, 2);
    expect((await transcript(c.id)).turns.at(-1)).toMatchObject({
      status: "interrupted",
      endReason: "stopped",
    });
  });

  it("stops a reply it couldn't save in full, and ends it as failed", async () => {
    await startChat("fake");
    const c = await newConversation();
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
    const c = await newConversation();
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
    const c = await newConversation();
    await chat?.send(c, "Show results");
    await ended(c.id);
    expect(
      (await transcript(c.id)).entries.filter(([kind]) => kind === "reply"),
    ).toEqual([
      ["reply", "ok:Show results"],
      ["reply", "**Whose results?**\n- Asha\n- Ravi"],
    ]);
  });

  it("saves one activity line per thing the AI did, in order, without outputs", async () => {
    await startChat("fake", {
      scenario: {
        calls: [{ namespace: "rufi", tool: "get_overview", arguments: {} }],
      },
    });
    const c = await newConversation();
    await chat?.send(c, "What's new?");
    await ended(c.id);
    const lines = (await transcript(c.id)).all
      .filter((e) => e.kind === "activity")
      .map((e) => [e.activity, e.text, e.detail, e.status]);
    expect(lines).toEqual([
      ["tool", "Read your overview", null, "done"],
      ["command", "Ran a command", "ls", "done"],
      ["other", "The AI did something Rufi can't display", "teleport", "done"],
    ]);
    const columns = store.db.prepare("SELECT * FROM transcript_entries").all();
    expect(JSON.stringify(columns)).not.toContain("Asha Fictional");
  });

  it("keeps a tool's late result out: the activity is stopped, not done", async () => {
    await startChat("fake", {
      scenario: {
        calls: [{ namespace: "rufi", tool: "get_overview", arguments: {} }],
      },
      toolMs: 500,
    });
    const c = await newConversation();
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

  it("keeps a save that lands after Stop, with its receipt line", async () => {
    await startChat("fake", {
      scenario: { calls: [saveHeadache] },
      toolMs: 500,
    });
    const c = await newConversation();
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
      ["receipt", "Saved: added symptom Headache."],
    ]);
    expect(store.db.prepare("SELECT name FROM symptoms").all()).toEqual([
      { name: "Headache" },
    ]);
  });

  it("saves after the message it rests on is stored, also when storing is slow", async () => {
    await startChat("fake", { scenario: { calls: [saveHeadache] } });
    const c = await newConversation();
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
      ["receipt", "Saved: added symptom Headache."],
    ]);
  });

  it("gives a new thread Rufi's receipt lines with the last messages", async () => {
    await startChat("fake", { scenario: { calls: [saveHeadache] } });
    const c = await newConversation();
    await chat?.send(c, "I have a headache");
    await ended(c.id);
    await chat?.selectModel(await conversation(c.id), "gpt-6-astra");
    await startChat("fake");
    await chat?.send(await conversation(c.id), "And now?");
    await ended(c.id, 2);
    expect((await backendOf("fake").contexts()).at(-1)).toContain(
      "User: I have a headache\n\nRufi: Saved: added symptom Headache.\n\nAI: ok:I have a headache",
    );
  });

  it("saves nothing of a reply after its Stop", async () => {
    await startChat("fake", { scenario: { late: true } });
    const c = await newConversation();
    await chat?.send(c, "hang");
    await running(c.id);
    await chat?.stop(c);
    await ended(c.id);
    await sleep(200);
    expect(JSON.stringify((await transcript(c.id)).entries)).not.toContain(
      "LATE",
    );
  });

  it("saves a usage limit's end reason and reset time", async () => {
    await startChat("fake", { scenario: { resetsAt: 1_791_000_000 } });
    const c = await newConversation();
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
    const c = await newConversation();
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
    const c = await newConversation();
    await transcripts.setThread(c, {
      id: "theirs-1",
      provider: "claude",
      model: "gpt-6.1-sol",
      tools: "tools-1",
    });
    await chat?.send(await conversation(c.id), "Hello");
    await ended(c.id);
    const log = await readFile(join(home, "fake.jsonl"), "utf8");
    expect(log).not.toContain("theirs-1");
    expect((await conversation(c.id)).threadProvider).toBe("codex");
  });

  it("shows the agent's errors as they are", async () => {
    await startChat("fake", {
      scenario: { hang: ["thread/start"] },
      deadlines: { requestMs: 300 },
    });
    const c = await newConversation();
    await expect(chat?.send(c, "Hello")).rejects.toThrow(
      "Codex didn't answer thread/start within 0.3 s.",
    );
  });

  it("keeps a reply's text when a crash cuts it, and marks it interrupted", async () => {
    const c = await transcripts.createConversation(
      "asha",
      "Cut",
      "codex",
      "gpt-6.1-sol",
    );
    await transcripts.startTurn(c, "t-1", "gpt-6.1-sol");
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
