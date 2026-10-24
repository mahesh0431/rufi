// The chat with its agent, as one contract: the same tests run against the
// scripted fake Codex and against the real Codex binary (on a local fake
// model, offline). What a reply does is chosen by the message's words: see
// tests/fake-codex.ts and tests/fake-model.ts.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SIGNED_OUT, type Entry } from "@rufi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Scenario } from "../../tests/fake-codex.ts";
import {
  fakeModel,
  NOTE,
  THINKING,
  type FakeModel,
} from "../../tests/fake-model.ts";
import { callTool, type McpServerConfig } from "../../tests/mcp-client.ts";
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
import { deletions } from "../core/documents/delete.ts";
import { fileGate } from "../core/documents/gate.ts";
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
import { rulesNote } from "../core/chat/instructions.ts";
import { chat as openChat, type Chat } from "./chat.ts";
import { agentSetup } from "./core.ts";
import { mcpEndpoint, mcpKeys, serveMcp } from "./mcp.ts";

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
let token: string;
let tokenGate: Promise<void> | undefined;
/** Calls of Rufi's tools the chat admitted, as they start. */
let admitted: string[];
/** Rufi's MCP server for this run of the chat, as the core serves it. */
let served: { port: number; close: () => Promise<void> } | undefined;

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
    allowlist?: string[];
    /** Names this Rufi's rules: another one is an update. */
    rules?: string;
    /** The sign-in's token decision, at the external edge. */
    tokenProvider?: () => Promise<string>;
  } = {},
): Promise<Chat> {
  const again = chat !== undefined;
  await chat?.close();
  await served?.close();
  // As the core does when it starts again.
  if (again) await queue.endStopped();
  const reader = openReadOnly(databasePath(home));
  const log = () => undefined;
  const tools = forAgent(() => ({ store: reader, personId: undefined }), log);
  const keys = mcpKeys();
  let port = 0;
  served = await serveMcp(mcpEndpoint({ keys, port: () => port, log }));
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
  chat = openChat({
    transcripts,
    queue,
    signedIn: () => Promise.resolve(signedIn),
    agent: (host: AgentHost) =>
      codexRuntime({
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
        host,
        log,
      }),
    allowlist: options.allowlist ?? ALLOWED,
    mcp: { url: () => `http://127.0.0.1:${String(port)}/mcp`, keys },
    rules: (region) => ({
      instructions: `Rufi's rules ${options.rules ?? "1"}, for ${region ?? "no region"}.`,
      version: `rules-${options.rules ?? "1"}-${region ?? ""}`,
    }),
    tools: {
      specs: tools.specs,
      caller: (chat, turnId, origin) => {
        const call = chatCaller(
          reader,
          transcripts,
          log,
          reader && pages(reader, home),
        )(chat, turnId, origin);
        return async (name, input, callId) => {
          admitted.push(name);
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
              .filter((text) => text.startsWith("Rufi's rules"))
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
      // The new thread's seed has it as the AI's progress note.
      expect(await transcripts.lastMessages(c, 10)).toContainEqual({
        from: "note",
        text: NOTE,
      });
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
      await say(c, text);
      await until(async () =>
        (await transcript(c.id)).all.some((e) => e.activity === "note"),
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
    "a message sent while a reply runs goes into that reply; one sent after goes as a new message",
    timeout,
    async () => {
      await startChat(name);
      const c = await newChat();
      await say(c, "slow");
      await running(c.id);
      await expect(say(c, "shorter please")).resolves.toMatchObject({
        steered: true,
      });
      await ended(c.id);
      const { entries } = await transcript(c.id);
      expect(entries).toContainEqual(["steer", "shorter please"]);
      expect(entries).toContainEqual(["reply", "ok:shorter please"]);
      await expect(say(c, "after")).resolves.toMatchObject({ steered: false });
      await ended(c.id, 2);
      expect((await transcript(c.id)).entries).toContainEqual([
        "reply",
        "ok:after",
      ]);
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
      await until(async () => (await waiting())[0]?.[1] === "handing_over");
      await chat?.stop(c);
      gate.resolve(undefined);
      await until(async () => (await waiting())[0]?.[1] === "waiting");
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
      const regionNote = rulesNote("Rufi's rules 1, for IN.");
      const updateNote = rulesNote("Rufi's rules 2, for IN.");
      expect(rules[1]?.slice(-regionNote.length)).toBe(regionNote);
      expect(rules[2]?.slice(-updateNote.length)).toBe(updateNote);
      expect((await chatRow(c.id)).threadTools).toBe("rules-2-IN");
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
      // The thread's files are gone: Codex has no record of this id.
      const lost = await chatRow(c.id);
      await transcripts.setThread(lost, {
        id: uuid(),
        provider: "codex",
        model: "gpt-6.1-sol",
        tools: lost.threadTools ?? "",
      });
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
      expect(threadsUsed()).toBe(1);
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
      INSERT INTO documents (id, person_id, added_at, added_from, version) VALUES
        ('doc-1', 'asha', '2026-10-01T09:00:00Z', 'chat', 3),
        ('doc-r', 'ravi', '2026-10-01T09:00:00Z', 'chat', 1);
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
      INSERT INTO documents (id, person_id, added_at, added_from, kind, date, issuer, report_number, version)
        VALUES ('doc-correction', 'asha', '2026-10-01T09:00:00Z', 'chat', 'lab_report', '2026-08-12', 'Sunrise Labs', 'CORRECTED', 1);
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
        .get(callId);
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

  it.each([false, true])(
    "a deleted document's note goes to the existing thread at once in a turn of its own, or, when Rufi stopped before handing it over, with the next message (stopped: %s)",
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
        await queue.endStopped();
        await startChat("fake", {
          scenario: { threads: { [threadId]: {} } },
        });
        await sleep(300);
        expect((await transcript(c.id)).turns).toHaveLength(1);
        expect(await waiting()).toEqual([
          ["Deleted Sunrise Labs August.pdf", "waiting", "paused"],
        ]);
        await say(await chatRow(), "quiet Continue the comparison");
        await ended(c.id, 2);
        expect((await inputs()).at(-1)).toEqual([
          note,
          "quiet Continue the comparison",
        ]);
      } else {
        // No message from the person: the note is the turn's whole input.
        await ended(c.id, 2);
        expect((await inputs()).at(-1)).toEqual([note]);
      }
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

  it("stops a reply when Rufi can't keep a call to its tools, and tells the AI", async () => {
    await startChat("fake", {
      scenario: {
        calls: [{ tool: "get_overview", arguments: {} }],
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
      .filter((line) => line.includes('"answered":"tools/call"'));
    expect(answered).toHaveLength(1);
    expect(answered[0]).toContain("Rufi couldn't keep this call");
    expect(answered[0]).not.toContain("Asha Fictional");
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
    ).toEqual([{ tool: "get_overview", call_id: "proper-read" }]);
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
    await until(async () =>
      (await transcript(c.id)).entries.some(([kind]) => kind === "activity"),
    );
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
      { call_id: "call-0" },
    ]);
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
      ["call-same", 1],
      ["call-same", 1],
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
    // The thread is lost.
    const lost = await chatRow(c.id);
    await transcripts.setThread(lost, {
      id: "lost-1",
      provider: "codex",
      model: "gpt-6.1-sol",
      tools: lost.threadTools ?? "",
    });
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
    const lost = await chatRow();
    await transcripts.setThread(lost, {
      id: "lost-1",
      provider: "codex",
      model: "gpt-6-astra",
      tools: lost.threadTools ?? "",
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
    await until(async () => (await waiting())[0]?.[2] === "failed");
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
    // Add to reply cuts an answer and the turn goes on and completes: the
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
    expect((await chatRow()).paused).toBeNull();
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
    const choices = await Promise.allSettled([
      chat?.queue.recover(row, item.id, item.holdId, "retry"),
      chat?.queue.recover(row, item.id, item.holdId, "new_thread"),
    ]);
    expect(choices.map((choice) => choice.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
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

  it("after New thread, a restart before the message went keeps it waiting once, and the next send starts the new thread", async () => {
    const thread = await afterOneReply({ resumeFails: 5 });
    await say(await chatRow(), "second");
    const item = await held();
    // The choice is stored, and Rufi stops before it hands the message over.
    await queue.recover(await chatRow(), item.id, item.holdId, true);
    await startChat("fake");
    expect((await chatRow()).threadId).toBeNull();
    expect(await waiting()).toEqual([["second", "waiting", null]]);
    expect((await chatRow()).paused).toBe("restarted");
    await chat?.queue.sendNow(await chatRow(), item.id);
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
    const lost = await chatRow();
    await transcripts.setThread(lost, {
      id: "lost-1",
      provider: "codex",
      model: "gpt-6.1-sol",
      tools: lost.threadTools ?? "",
    });
    expect((await chatRow()).context).toBeNull();
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
    expect(stored()).toEqual({ context_tokens: 1_000, context_window: null });
    expect((await chatRow()).context).toBeNull();
  });
});
