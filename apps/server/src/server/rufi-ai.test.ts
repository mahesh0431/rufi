// Rufi AI on the agent package: the chat through startRufiAi, on a real
// record, a real agent database and the package's fake provider.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  await system.agents.dispatch();
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
  const row = async () => (await transcripts.chat("asha")) as ChatRow;
  return {
    store,
    system,
    row,
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

it("puts each turn's whole answer from the package's events on its reply row, once, with Rufi's cursor in the same transaction", async () => {
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

  // Only part of the answer streams before the turn ends with all of it.
  await rufi.send("message-1", "What was my last TSH?");
  const first = await rufi.running();
  emit({
    type: "text",
    turn: first,
    item: "answer-1",
    delta: "Your last TSH was ",
  });
  await vi.waitFor(() => {
    expect(replies()).toHaveLength(1);
  });
  const streamed = String(replies()[0]?.["id"]);
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
  expect(replies()).toEqual([
    { id: streamed, text: "Your last TSH was ", status: "stopped" },
  ]);
  expect(rufi.store.eventsAfter(cursor()).map((event) => event.type)).toContain(
    "turn.ended",
  );

  // The next reading puts it on the streamed row.
  record.db.exec("DROP TRIGGER fictional_failure");
  rufi.system.agents.configure(await rufi.system.root("c-asha"), {
    model: "fake-model",
    effort: "low",
  });
  await vi.waitFor(() => {
    expect(cursor()).toBe(rufi.store.highWater());
  });
  expect(replies()).toEqual([
    { id: streamed, text: "Your last TSH was 2.1.", status: "done" },
  ]);

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
  const whole = replies();
  expect(whole).toMatchObject([
    { id: streamed, text: "Your last TSH was 2.1.", status: "done" },
    { text: "It was 2.4.", status: "done" },
  ]);

  // Read again from the start, each answer is there once.
  await rufi.close();
  record.db.exec("UPDATE agent_cursor SET number = 0");
  rufi = await start(adapter);
  expect(cursor()).toBe(rufi.store.highWater());
  expect(replies()).toEqual(whole);
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
