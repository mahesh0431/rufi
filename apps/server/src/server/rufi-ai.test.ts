// Rufi AI on the agent package: the chat through startRufiAi, on a real
// record, a real agent database and the package's fake provider.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fakeProvider } from "@rufi/agents/fake";
import type { ProviderAdapter, ProviderEvent } from "@rufi/agents/provider";
import { openAgentStore } from "@rufi/agents/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatQueue } from "../core/chat/queue.ts";
import {
  transcripts as openTranscripts,
  type ChatRow,
} from "../core/chat/transcript.ts";
import {
  databasePath,
  openWritable,
  type Store,
} from "../core/store/database.ts";
import { agentsPath } from "./agents.ts";
import { chat as openChat } from "./chat.ts";
import { mcpKeys } from "./mcp.ts";
import { startRufiAi } from "./rufi-ai.ts";

let home: string;
let record: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-ai-"));
  record = openWritable(databasePath(home));
  record.db.exec(`
    INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
    INSERT INTO chats (id, person_id, created_at)
      VALUES ('c-asha', 'asha', '2026-10-08T09:00:00Z');
  `);
});

afterEach(async () => {
  record.close();
  await rm(home, { recursive: true, force: true });
});

const rows = (sql: string) =>
  record.db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));

/** Rufi as it starts: Rufi AI on the package, and the chat on it. */
async function start(adapter: ProviderAdapter, logged: string[] = []) {
  const store = openAgentStore(agentsPath(home));
  const transcripts = openTranscripts(record);
  const system = await startRufiAi({
    store,
    record,
    transcripts,
    adapters: [adapter],
    tools: [],
    cwd: join(home, "ai"),
    model: "fake-model",
    log: (event) => logged.push(event),
  });
  // Replies still running once Rufi has read the events were cut.
  await transcripts.interruptRunning();
  const chat = openChat({
    transcripts,
    queue: chatQueue(record),
    signedIn: () => Promise.resolve(true),
    agent: system.rufiAi,
    allowlist: ["fake-model"],
    mcp: { url: () => "http://127.0.0.1:9/mcp", keys: mcpKeys() },
    rules: () => ({ instructions: "Fictional rules.", version: "rules-1" }),
    tools: {
      specs: [],
      caller: () => () => Promise.reject(new Error("No tools here.")),
    },
    log: () => undefined,
  });
  await system.recover();
  await chat.carryAll();
  await system.agents.dispatch();
  const row = async () => (await transcripts.chat("asha")) as ChatRow;
  return {
    store,
    system,
    row,
    /** A Rufi event whose note asks the AI: a reply of its own. */
    event: async (note: string) => {
      await chat.event("asha", {
        kind: "test",
        line: "Rufi's line",
        ask: note,
      });
    },
    edit: async (id: string, text: string) => {
      await chat.queue.edit(await row(), id, text);
    },
    /** The chat's waiting messages, by id, and their states. */
    waiting: async () =>
      (await chat.queue.list(await row())).items.map((item) => [
        item.id,
        item.state,
      ]),
    /** The replies' and the AI's notes' text as the screens get it. */
    shown: async () =>
      (await transcripts.page(await row())).entries
        .filter((entry) => entry.kind === "reply" || entry.activity === "note")
        .map((entry) => entry.text),
    send: async (id: string, text: string) => chat.send(await row(), id, text),
    /** Waits for the chat's reply to run; its provider turn. */
    running: async () => {
      const agent = await system.root("c-asha");
      return vi.waitFor(() => {
        const current = system.agents.current(agent);
        if (current?.status !== "running") throw new Error("Not running.");
        return current.ref;
      });
    },
    close: async () => {
      await chat.close();
      await system.close();
      store.close();
    },
  };
}

const cursor = () =>
  Number(rows("SELECT number FROM agent_cursor")[0]?.["number"]);
const replies = () =>
  rows(
    "SELECT id, text, status FROM transcript_entries WHERE kind = 'reply' ORDER BY seq",
  );

it("puts each turn, and its whole answer on its reply row, from the package's events, once, with Rufi's cursor in the same transaction", async () => {
  const fake = fakeProvider({ id: "codex", script: { turn: "runs" } });
  let emit: (event: ProviderEvent) => void = () => undefined;
  const adapter: ProviderAdapter = {
    ...fake.adapter,
    open: (options) => {
      emit = options.onEvent;
      return fake.adapter.open(options);
    },
  };
  const logged: string[] = [];
  let rufi = await start(adapter, logged);

  // A whole note, then a question on its item; only part of the answer
  // streams, then a question on the same item, before the turn ends with
  // all of the answer.
  await rufi.send("message-1", "What was my last TSH?");
  const first = await rufi.running();
  const note = "I checked your March report.";
  emit({ type: "note", turn: first, item: "note-1", delta: note, done: true });
  emit({
    type: "question",
    turn: first,
    item: "note-1",
    title: "Which report?",
    options: ["March", "May"],
  });
  const which = "**Which report?**\n- March\n- May";
  emit({
    type: "text",
    turn: first,
    item: "answer-1",
    delta: "Your last TSH",
  });
  emit({
    type: "question",
    turn: first,
    item: "answer-1",
    title: "Which one?",
    options: ["March", "May"],
  });
  const asked = "\n\n**Which one?**\n- March\n- May";
  await vi.waitFor(async () => {
    expect(await rufi.shown()).toEqual([note, which, `Your last TSH${asked}`]);
  });
  const streamed = String(replies()[1]?.["id"]);
  // Writing the answer fails after the cursor moved: both roll back.
  record.db.exec(`
    CREATE TRIGGER fictional_failure BEFORE UPDATE OF text ON transcript_entries
    WHEN NEW.text = 'Your last TSH was 2.1.'
    BEGIN SELECT RAISE(ABORT, 'A fictional write failure.'); END;
  `);
  const thread = (await rufi.row()).threadId ?? "";
  fake.end(thread, { status: "done", answer: "Your last TSH was 2.1." });
  await vi.waitFor(() => {
    expect(logged).toContain("agents.failed");
  });
  expect(rows("SELECT status FROM turns")).toEqual([{ status: "completed" }]);
  expect(replies()).toMatchObject([{}, { id: streamed, status: "stopped" }]);
  expect(await rufi.shown()).toEqual([note, which, `Your last TSH${asked}`]);
  expect(rufi.store.eventsAfter(cursor()).map((event) => event.type)).toContain(
    "turn.ended",
  );

  // The next reading puts it on the streamed row; the question stays.
  record.db.exec("DROP TRIGGER fictional_failure");
  rufi.system.agents.configure(await rufi.system.root("c-asha"), {
    model: "fake-model",
    effort: "low",
  });
  await vi.waitFor(() => {
    expect(cursor()).toBe(rufi.store.highWater());
  });
  expect(replies()).toMatchObject([{}, { id: streamed, status: "done" }]);
  const firstTurn = [note, which, `Your last TSH was 2.1.${asked}`];
  expect(await rufi.shown()).toEqual(firstTurn);

  // Nothing streams: the answer gets a row of its own.
  await rufi.send("message-2", "And the one before?");
  await rufi.running();
  fake.end(thread, { status: "done", answer: "It was 2.4." });
  await vi.waitFor(() => {
    expect(rows("SELECT status FROM turns")).toEqual([
      { status: "completed" },
      { status: "completed" },
    ]);
    expect(cursor()).toBe(rufi.store.highWater());
  });

  // The chat saves nothing of the next turn: its start and answer come
  // from the events alone.
  rufi.system.rufiAi({
    onEvent: () => undefined,
    saved: () => Promise.resolve(),
    opening: () => Promise.reject(new Error("It is open already.")),
    claim: () => Promise.resolve(undefined),
    changed: () => undefined,
  });
  const agent = await rufi.system.root("c-asha");
  const ask = async (id: string) => {
    rufi.system.agents.send(agent, {
      id,
      sender: "person",
      kind: "queue",
      parts: ["What about my ferritin?"],
    });
    await rufi.running();
  };
  await ask("message-3");
  fake.end(thread, { status: "done", answer: "Ferritin was 40." });
  const turns = () =>
    rows("SELECT status, end_text FROM turns ORDER BY started_at, rowid");
  const completed = { status: "completed", end_text: null };
  await vi.waitFor(() => {
    expect(turns()).toEqual([completed, completed, completed]);
    expect(cursor()).toBe(rufi.store.highWater());
  });
  const whole = replies();
  expect(whole).toMatchObject([
    { text: "" },
    { id: streamed, text: "Your last TSH was 2.1.", status: "done" },
    { text: "It was 2.4.", status: "done" },
    { text: "Ferritin was 40.", status: "done" },
  ]);

  // Nor of one that starts while Rufi's cursor can't move, and still runs
  // when Rufi closes.
  record.db.exec("UPDATE agent_cursor SET generation = 'elsewhere'");
  await ask("message-4");
  await vi.waitFor(() => {
    expect(logged.filter((event) => event === "agents.failed")).toHaveLength(2);
  });
  await rufi.close();

  // Read again from the start: each answer is there once, and the turn
  // that ran on is there, cut when Rufi closed.
  record.db
    .prepare("UPDATE agent_cursor SET generation = ?, number = 0")
    .run(rufi.store.generation);
  rufi = await start(adapter);
  expect(cursor()).toBe(rufi.store.highWater());
  expect(turns()).toEqual([
    completed,
    completed,
    completed,
    {
      status: "interrupted",
      end_text: "Rufi closed before the reply finished.",
    },
  ]);
  expect(replies()).toEqual(whole);
  // The note and its question are there as they were.
  expect(await rufi.shown()).toEqual([
    ...firstTurn,
    "It was 2.4.",
    "Ferritin was 40.",
  ]);
  await rufi.close();
});

it("saves a steer the provider confirms after its turn ended under that turn; the same message again sends nothing", async () => {
  const fake = fakeProvider({ id: "codex", script: { turn: "runs" } });
  const rufi = await start({
    ...fake.adapter,
    open: async (options) => {
      const conversation = await fake.adapter.open(options);
      return {
        ...conversation,
        // The turn ends before the provider confirms the steer.
        steer: async (steer) => {
          const outcome = await conversation.steer(steer);
          fake.end(conversation.ref);
          return outcome;
        },
      };
    },
  });
  await rufi.send("message-1", "Summarise my fictional record.");
  await rufi.running();
  const words = "Please include my fictional TSH.";

  expect(await rufi.send("message-2", words)).toEqual({
    id: "message-2",
    steered: true,
  });
  expect(
    rows("SELECT turn_id FROM transcript_entries WHERE id = 'message-2'"),
  ).toEqual(rows("SELECT id AS turn_id FROM turns"));

  await rufi.send("message-2", words);
  const thread = (await rufi.row()).threadId ?? "";
  expect(
    fake.received(thread).filter((input) => input.parts.includes(words)),
  ).toHaveLength(1);
  await rufi.close();
});

it("sends a waiting message with its words as they are when it goes: an edit before Rufi's claim goes, one after is refused", async () => {
  const fake = fakeProvider({ id: "codex", script: { turn: "runs" } });
  let held: PromiseWithResolvers<undefined> | undefined;
  const rufi = await start({
    ...fake.adapter,
    open: async (options) => {
      const conversation = await fake.adapter.open(options);
      return {
        ...conversation,
        // A start can wait at the provider, after Rufi's claim.
        startTurn: async (turn) => {
          await held?.promise;
          return conversation.startTurn(turn);
        },
      };
    },
  });
  // Rufi's note has a reply of its own: the person's message waits.
  await rufi.event("A fictional report was read.");
  await rufi.running();
  await rufi.send("message-1", "Is my TSH high?");
  await rufi.edit("message-1", "Is my fictional TSH high?");
  held = Promise.withResolvers();
  const thread = (await rufi.row()).threadId ?? "";
  fake.end(thread);
  await vi.waitFor(async () => {
    expect(await rufi.waiting()).toEqual([["message-1", "handing_over"]]);
  });
  await expect(rufi.edit("message-1", "Never mind.")).rejects.toThrow(
    "That message isn't waiting any more.",
  );
  held.resolve(undefined);
  await rufi.running();
  expect(
    fake
      .received(thread)
      .filter((input) => input.id === "message-1")
      .map((input) => input.parts),
  ).toEqual([["Is my fictional TSH high?"]]);
  await rufi.close();
});

it("after a crash between Rufi's claim and the package's hand-over, sends the message once at the next start", async () => {
  const fake = fakeProvider({ id: "codex", script: { turn: "runs" } });
  let rufi = await start(fake.adapter);
  await rufi.event("A fictional report was read.");
  await rufi.running();
  await rufi.send("message-1", "Is my TSH high?");
  // The package can't keep the hand-over Rufi has just claimed.
  const agents = new DatabaseSync(agentsPath(home));
  agents.exec(`
    CREATE TRIGGER fictional_crash BEFORE UPDATE OF state ON queue
    WHEN NEW.state = 'handing_over'
    BEGIN SELECT RAISE(ABORT, 'A fictional crash.'); END;
  `);
  const thread = (await rufi.row()).threadId ?? "";
  fake.end(thread);
  await vi.waitFor(async () => {
    expect(await rufi.waiting()).toEqual([["message-1", "handing_over"]]);
  });
  expect(rufi.system.agents.input("message-1")?.state).toBe("waiting");
  await rufi.close();
  agents.exec("DROP TRIGGER fictional_crash");
  agents.close();

  rufi = await start(fake.adapter);
  await rufi.running();
  expect(await rufi.waiting()).toEqual([]);
  expect(
    fake.received(thread).filter((input) => input.id === "message-1"),
  ).toHaveLength(1);
  await rufi.close();
});
