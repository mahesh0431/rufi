// Rufi AI on the agent package: through startRufiAi, on a real record, a
// real agent database and the package's fake provider.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider } from "@rufi/agents/fake";
import { openAgentStore } from "@rufi/agents/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

it("applies a turn's end the chat didn't save from the package's events, with Rufi's cursor in the same transaction", async () => {
  const fake = fakeProvider({
    id: "codex",
    answer: "Your last TSH was 2.1.",
    script: { turn: "runs" },
  });
  const store = openAgentStore(agentsPath(home));
  const transcripts = openTranscripts(record);
  const logged: string[] = [];
  const system = await startRufiAi({
    store,
    record,
    transcripts,
    adapters: [fake.adapter],
    tools: ["get_records"],
    cwd: join(home, "ai"),
    model: "fake-model",
    log: (event) => logged.push(event),
  });
  await system.agents.dispatch();
  const chat = (await transcripts.chat("asha")) as ChatRow;
  // The chat saves only the start of each turn: Rufi stopped before the rest.
  let saving = Promise.resolve();
  const ai = system.rufiAi({
    onEvent: (event) => {
      if (event.type !== "turnStarted") return;
      saving = saving.then(async () => {
        await transcripts.startTurn(chat, event.turnId, {
          id: event.threadId,
          model: "fake-model",
        });
      });
    },
    saved: () => saving,
  });
  const thread = await ai.open(
    chat,
    {
      instructions: "Fictional rules.",
      version: "rules-1",
      tools: { url: "http://127.0.0.1:9/mcp", key: "fictional-key" },
      seed: () => Promise.resolve(undefined),
    },
    { fresh: false, reload: false },
  );
  await ai.send(thread, {
    id: "msg-1",
    sender: "person",
    input: ["What was my last TSH?"],
    effort: "medium",
  });
  const cursor = () => rows("SELECT number FROM agent_cursor")[0]?.["number"];
  await vi.waitFor(() => {
    expect(cursor()).toBe(store.highWater());
  });

  // Rufi's cursor can't move: the answer isn't applied without it.
  record.db.exec("UPDATE agent_cursor SET generation = 'elsewhere'");
  const before = cursor();
  fake.end(thread);
  await vi.waitFor(() => {
    expect(logged).toContain("agents.failed");
  });
  expect(rows("SELECT status FROM turns")).toEqual([{ status: "running" }]);
  expect(
    rows("SELECT text FROM transcript_entries WHERE kind = 'reply'"),
  ).toEqual([]);
  expect(cursor()).toBe(before);

  // It can again: the next reading applies the end once, with the cursor.
  record.db
    .prepare("UPDATE agent_cursor SET generation = ?")
    .run(store.generation);
  system.agents.configure(await system.root("c-asha"), {
    model: "fake-small",
    effort: "low",
  });
  await vi.waitFor(() => {
    expect(cursor()).toBe(store.highWater());
  });
  expect(rows("SELECT status FROM turns")).toEqual([{ status: "completed" }]);
  expect(
    rows("SELECT text, status FROM transcript_entries WHERE kind = 'reply'"),
  ).toEqual([{ text: "Your last TSH was 2.1.", status: "done" }]);

  await ai.close();
  await system.close();
  store.close();
});
