// Rufi and the agent package start in step: through startAgents, on a real
// record, a real agent database and the package's fake provider.
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgents, type NewAgent, type Sent } from "@rufi/agents/agents";
import { fakeProvider, type FakeProvider } from "@rufi/agents/fake";
import type { ProviderAdapter } from "@rufi/agents/provider";
import { openAgentStore, type AgentStore } from "@rufi/agents/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sentAs } from "../core/chat/agents.ts";
import {
  databasePath,
  openWritable,
  type Store,
} from "../core/store/database.ts";
import { agentsPath, startAgents, type AgentSystem } from "./agents.ts";

let home: string;
let record: Store;
let fake: FakeProvider;
let running: { store: AgentStore; system: AgentSystem } | undefined;
let logged: string[];

const TOOLS = { url: "http://127.0.0.1:9/mcp", key: "fictional-key" };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-agents-"));
  record = openWritable(databasePath(home));
  record.db.exec(`
    INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional'), ('ravi', 'Ravi Fictional');
    INSERT INTO chats (id, person_id, model, effort, created_at) VALUES
      ('c-asha', 'asha', 'gpt-6.1-sol', 'high', '2026-10-08T09:00:00Z'),
      ('c-ravi', 'ravi', NULL, NULL, '2026-10-08T09:00:00Z');
  `);
  fake = fakeProvider();
  logged = [];
});

afterEach(async () => {
  await stop();
  record.close();
  await rm(home, { recursive: true, force: true });
});

async function start(adapters: readonly ProviderAdapter[] = [fake.adapter]) {
  const store = openAgentStore(agentsPath(home));
  const system = await startAgents({
    store,
    record,
    adapters,
    host: {
      opening: () =>
        Promise.resolve({ instructions: "Fictional rules.", tools: TOOLS }),
      claim: () => Promise.resolve({ status: "gone" }),
    },
    tools: ["get_records", "save_changes"],
    cwd: join(home, "ai"),
    model: "gpt-6-astra",
    log: (event) => logged.push(event),
  });
  await system.recover();
  running = { store, system };
  return running;
}

/** A thread the provider has, as Asha's chat's. */
async function ashaThread(): Promise<string> {
  const known = await fake.adapter.open({
    cwd: join(home, "ai"),
    instructions: "Fictional rules.",
    model: "fake-model",
    effort: "medium",
    tools: TOOLS,
    onEvent: () => undefined,
  });
  await known.close();
  record.db
    .prepare(
      "UPDATE chats SET thread_id = ?, thread_provider = 'fake' WHERE id = 'c-asha'",
    )
    .run(known.ref);
  return known.ref;
}

/** The agent database's file goes, as when it is lost. */
async function lose() {
  for (const end of ["", "-wal", "-shm"]) {
    await rm(`${agentsPath(home)}${end}`, { force: true });
  }
}

/** A child's report, waiting for Asha's agent. */
const REPORT: Sent = {
  id: "child-result",
  sender: "agent-child",
  kind: "queue",
  parts: ["Fictional reading of report.pdf."],
};

async function stop() {
  await running?.system.close();
  running?.store.close();
  running = undefined;
}

const rows = (sql: string, ...params: string[]) =>
  record.db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row }));

const agentRows = (store: AgentStore) =>
  store.db
    .prepare(
      "SELECT id, provider, provider_ref AS ref, conversation, admitted, model, effort FROM agents ORDER BY rowid",
    )
    .all()
    .map((row) => ({ ...row }));

const rootOf = (chat: string) =>
  rows("SELECT agent_id FROM agent_owners WHERE chat_id = ? AND root = 1", chat)
    .map((row) => row["agent_id"] as string)
    .at(0) ?? "";

const cursor = () =>
  rows("SELECT generation, number FROM agent_cursor").at(0) as
    | { generation: string; number: number }
    | undefined;

const handingOver = (person: string, id: string, sent: string | null) => {
  record.db
    .prepare(
      `INSERT INTO chat_queue (id, person_id, chat_id, origin, text, position, state, sent_as, created_at, updated_at)
       VALUES (?, ?, ?, 'person', 'What was my last TSH?', 1, 'handing_over', ?, '2026-10-08T09:01:00Z', '2026-10-08T09:01:00Z')`,
    )
    .run(id, person, `c-${person}`, sent);
};

const queued = () =>
  rows("SELECT id, state, sent_as FROM chat_queue ORDER BY id");

describe("at the first start", () => {
  it("each chat gets its own agent, which takes over its thread, and again changes nothing", async () => {
    record.db.exec(
      "UPDATE chats SET thread_id = 'thread-asha', thread_provider = 'codex', thread_model = 'gpt-6-astra' WHERE id = 'c-asha'",
    );
    const { store } = await start([]);
    const asha = rootOf("c-asha");
    const ravi = rootOf("c-ravi");

    expect(agentRows(store)).toEqual([
      {
        id: asha,
        provider: "codex",
        ref: "thread-asha",
        conversation: 1,
        admitted: 1,
        model: "gpt-6.1-sol",
        effort: "high",
      },
      {
        id: ravi,
        provider: "codex",
        ref: null,
        conversation: 0,
        admitted: 1,
        model: "gpt-6-astra",
        effort: "medium",
      },
    ]);
    expect(
      rows(
        "SELECT chat_id, agent_id, conversation, provider, ref FROM agent_conversations",
      ),
    ).toEqual([
      {
        chat_id: "c-asha",
        agent_id: asha,
        conversation: 1,
        provider: "codex",
        ref: "thread-asha",
      },
    ]);
    // Rufi has read every event, and reads the next as it commits.
    const last = store.eventsAfter(0).at(-1)?.number;
    expect(cursor()).toEqual({ generation: store.generation, number: last });
    running?.system.agents.create({
      id: "agent-reader",
      parent: asha,
      title: "Reading report.pdf",
      provider: "codex",
      model: "gpt-6-astra",
      effort: "medium",
      tools: ["get_records"],
      cwd: join(home, "ai"),
    });
    await vi.waitFor(() => {
      expect(cursor()?.number).toBe((last ?? 0) + 1);
    });

    await stop();
    await start([]);
    expect(rows("SELECT agent_id FROM agent_owners ORDER BY agent_id")).toEqual(
      [asha, ravi].sort().map((agent_id) => ({ agent_id })),
    );
    expect(rows("SELECT agent_id FROM agent_conversations")).toHaveLength(1);
  });
});

describe("a lost agent database", () => {
  it("ends Rufi's links to it but keeps the ledger; a hand-over left is not sure, and chats start afresh", async () => {
    record.db.exec(
      "UPDATE chats SET thread_id = 'thread-asha', thread_provider = 'codex' WHERE id = 'c-asha'",
    );
    await start([]);
    const old = rootOf("c-asha");
    await stop();
    // Rufi was far into the old database's events, and was handing a
    // message over to its agent when the database was lost.
    record.db.exec("UPDATE agent_cursor SET number = 99");
    handingOver("asha", "msg-1", sentAs(old, 1));
    // One Rufi claimed but never marked surely didn't go: today's recovery
    // has it wait again.
    handingOver("ravi", "msg-2", null);
    await lose();

    const { store } = await start([]);

    const asha = rootOf("c-asha");
    expect(asha).not.toBe(old);
    // The new agent never takes the old thread over.
    expect(agentRows(store).map(({ id, ref }) => ({ id, ref }))).toEqual([
      { id: asha, ref: null },
      { id: rootOf("c-ravi"), ref: null },
    ]);
    expect(rows("SELECT agent_id, ref FROM agent_conversations")).toEqual([
      { agent_id: old, ref: "thread-asha" },
    ]);
    expect(queued()).toEqual([
      { id: "msg-1", state: "not_sure", sent_as: sentAs(old, 1) },
      { id: "msg-2", state: "handing_over", sent_as: null },
    ]);
    expect(cursor()).toEqual({
      generation: store.generation,
      number: store.eventsAfter(0).at(-1)?.number,
    });
  });
});

describe("a restored copy of the agent database", () => {
  it("from before it was lost runs none of its agents, admitted or not", async () => {
    await ashaThread();
    const { system } = await start();
    const old = rootOf("c-asha");
    system.agents.send(old, REPORT);
    await stop();
    const copy = join(home, "copy.sqlite");
    await copyFile(agentsPath(home), copy);
    // It is lost, Rufi starts a new one, and then the copy is put back.
    await lose();
    await start();
    await stop();
    await lose();
    await copyFile(copy, agentsPath(home));

    const { store, system: again } = await start();

    expect(again.agents.get(old)).toBeUndefined();
    expect(agentRows(store).map(({ id }) => id)).toEqual([
      rootOf("c-asha"),
      rootOf("c-ravi"),
    ]);
  });

  it("older than what Rufi has read starts again as a new one, and sends nothing twice", async () => {
    const ref = await ashaThread();
    const { system } = await start();
    const old = rootOf("c-asha");
    system.agents.send(old, REPORT);
    await stop();
    const copy = join(home, "copy.sqlite");
    await copyFile(agentsPath(home), copy);
    // The report goes, and Rufi reads on.
    const { system: on } = await start();
    await on.agents.dispatch();
    await vi.waitFor(() => {
      expect(on.agents.get(old)?.status).toBe("done");
    });
    await stop();
    await lose();
    await copyFile(copy, agentsPath(home));

    const { store, system: again } = await start();
    await again.agents.dispatch();

    expect(again.agents.get(old)).toBeUndefined();
    expect(cursor()).toEqual({
      generation: store.generation,
      number: store.eventsAfter(0).at(-1)?.number,
    });
    expect(fake.received(ref).map((input) => input.id)).toEqual([
      "child-result",
    ]);
  });
});

describe("a claim the package never saved", () => {
  it("is settled at the next start by what its provider says", async () => {
    // Asha's thread is one the provider has; Ravi's it no longer finds.
    await ashaThread();
    record.db.exec(
      "UPDATE chats SET thread_id = 'thread-gone', thread_provider = 'fake' WHERE id = 'c-ravi'",
    );
    await start();
    // Rufi claimed a message for each, and stopped before the package
    // saved the hand-over.
    handingOver("asha", "msg-asha", sentAs(rootOf("c-asha"), 1));
    handingOver("ravi", "msg-ravi", sentAs(rootOf("c-ravi"), 1));
    await stop();

    await start();

    expect(queued()).toEqual([
      { id: "msg-asha", state: "waiting", sent_as: null },
      {
        id: "msg-ravi",
        state: "not_sure",
        sent_as: sentAs(rootOf("c-ravi"), 1),
      },
    ]);
    expect(logged).toEqual([]);
  });
});

describe("a crash between the steps of making an agent", () => {
  it("is finished or undone at the next start", async () => {
    record.db.exec(`
      UPDATE chats SET thread_id = 'thread-asha', thread_provider = 'codex' WHERE id = 'c-asha';
      INSERT INTO people (id, display_name) VALUES ('mei', 'Mei Fictional');
      INSERT INTO chats (id, person_id, created_at) VALUES ('c-mei', 'mei', '2026-10-08T09:00:00Z');
    `);
    const store = openAgentStore(agentsPath(home));
    record.db
      .prepare(
        "INSERT INTO agent_cursor (id, generation, number) VALUES (1, ?, 0)",
      )
      .run(store.generation);
    const made = createAgents({
      store,
      adapters: [],
      host: {
        opening: () => Promise.reject(new Error("Not opened in this test.")),
        ledger: () => Promise.resolve(),
        claim: () => Promise.resolve({ status: "gone" }),
      },
      onError: (error) => {
        throw error;
      },
    });
    const agent = (id: string, adopt?: string): NewAgent => ({
      id,
      title: "Rufi AI",
      provider: "codex",
      model: "gpt-6-astra",
      effort: "medium",
      tools: ["get_records"],
      cwd: join(home, "ai"),
      ...(adopt !== undefined && { adopt }),
    });
    const own = (id: string, person: string) => {
      record.db
        .prepare(
          "INSERT INTO agent_owners (agent_id, person_id, chat_id, root, created_at) VALUES (?, ?, ?, 1, '2026-10-08T09:00:00Z')",
        )
        .run(id, person, `c-${person}`);
    };
    // Asha's agent was made, and Rufi stopped before keeping its owner.
    made.create(agent("agent-unowned", "thread-asha"));
    // Ravi's was owned, and Rufi stopped before admitting it.
    made.create(agent("agent-unadmitted"));
    own("agent-unadmitted", "ravi");
    // Mei's owner outlived its agent.
    own("agent-gone", "mei");
    await made.close();
    store.close();

    const { store: started } = await start([]);

    const asha = rootOf("c-asha");
    const mei = rootOf("c-mei");
    expect(rootOf("c-ravi")).toBe("agent-unadmitted");
    expect(
      agentRows(started).map(({ id, ref, admitted }) => ({
        id,
        ref,
        admitted,
      })),
    ).toEqual([
      { id: "agent-unadmitted", ref: null, admitted: 1 },
      { id: asha, ref: "thread-asha", admitted: 1 },
      { id: mei, ref: null, admitted: 1 },
    ]);
    expect(["agent-unowned", "agent-gone"]).not.toContain(asha);
    expect(mei).not.toBe("agent-gone");
    expect(rows("SELECT agent_id FROM agent_conversations")).toEqual([
      { agent_id: asha },
    ]);
  });
});
