// The agent database on a real SQLite file: a change and its events commit
// together, and the host can tell a new file from the one it knew.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NewerAgentStore,
  openAgentStore,
  type AgentStore,
  type Change,
} from "../src/store.ts";

let folder: string;
let path: string;
const opened: AgentStore[] = [];

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "rufi-agents-"));
  path = join(folder, "agents.sqlite");
});

afterEach(async () => {
  for (const store of opened.splice(0)) store.close();
  await rm(folder, { recursive: true, force: true });
});

const open = () => {
  const store = openAgentStore(path);
  opened.push(store);
  return store;
};

/** Closes a store the test opened, before the test ends. */
const shut = (store: AgentStore) => {
  opened.splice(opened.indexOf(store), 1);
  store.close();
};

const NOW = "2026-10-30T09:00:00.000Z";

/** A chat's root agent, written as the package writes one. */
function addRoot({ db, event }: Change, id: string): void {
  db.prepare(
    `INSERT INTO agents (id, root_id, title, provider, model, effort, tools, cwd, created_at, updated_at)
     VALUES (?, ?, 'Rufi AI', 'fake', 'fake-model', 'medium', '[]', '/fictional/ai', ?, ?)`,
  ).run(id, id, NOW, NOW);
  event("agent.created", id, { title: "Rufi AI" });
}

const agents = (store: AgentStore) =>
  store.db
    .prepare("SELECT id FROM agents ORDER BY id")
    .all()
    .map((row) => row["id"]);

describe("a change", () => {
  it("commits with its events, or none of it does", () => {
    const store = open();

    store.change((change) => {
      addRoot(change, "agent-asha");
    });
    expect(() =>
      store.change((change) => {
        addRoot(change, "agent-ravi");
        throw new Error("The provider said no.");
      }),
    ).toThrow("The provider said no.");
    expect(() => {
      store.change(({ db }) => {
        db.exec(
          "UPDATE agents SET title = 'Reading report.pdf' WHERE id = 'agent-asha'",
        );
      });
    }).toThrow("A change must record its event.");

    expect(agents(store)).toEqual(["agent-asha"]);
    expect(store.eventsAfter(0)).toEqual([
      {
        number: 1,
        type: "agent.created",
        agent: "agent-asha",
        payload: { title: "Rufi AI" },
        at: expect.any(String) as string,
      },
    ]);
    expect(store.db.prepare("SELECT title FROM agents").get()?.["title"]).toBe(
      "Rufi AI",
    );
  });

  it("can't wait: nothing its body started writes after it ends", async () => {
    const store = open();
    store.change((change) => {
      addRoot(change, "agent-asha");
    });

    let late: Promise<void> | undefined;
    expect(() =>
      // @ts-expect-error A change's body is synchronous.
      store.change(({ db, event }) => {
        late = (async () => {
          await Promise.resolve();
          db.exec(
            "UPDATE agents SET status = 'done', result = 'Fictional answer for Asha' WHERE id = 'agent-asha'",
          );
          event("turn.ended", "agent-asha", {});
        })();
        return late;
      }),
    ).toThrow("A change can't wait");
    await expect(late).rejects.toThrow("readonly");

    expect({
      ...store.db.prepare("SELECT status, result FROM agents").get(),
    }).toEqual({ status: "idle", result: null });
    expect(store.eventsAfter(0).map((event) => event.type)).toEqual([
      "agent.created",
    ]);
  });

  it("tells listeners once it has committed, never for one that rolled back", async () => {
    const store = open();
    const heard: { number: number; agents: unknown[] }[] = [];
    store.onCommit((number) => {
      // What a listener reads is already there.
      heard.push({ number, agents: agents(store) });
    });

    store.change((change) => {
      addRoot(change, "agent-asha");
      addRoot(change, "agent-ravi");
    });
    expect(heard).toEqual([]);
    expect(() =>
      store.change((change) => {
        addRoot(change, "agent-meena");
        throw new Error("Stopped.");
      }),
    ).toThrow("Stopped.");
    await Promise.resolve();

    expect(heard).toEqual([
      { number: 2, agents: ["agent-asha", "agent-ravi"] },
    ]);
  });
});

describe("the file", () => {
  it("keeps its generation and its event numbers; a new file has another generation", async () => {
    const first = open();
    const generation = first.generation;
    first.change((change) => {
      addRoot(change, "agent-asha");
      addRoot(change, "agent-ravi");
    });
    // A forget takes an agent's events with it.
    first.change(({ db, event }) => {
      db.exec("DELETE FROM agents WHERE id = 'agent-ravi'");
      event("agents.forgotten", null, { agents: ["agent-ravi"] });
    });
    shut(first);

    const again = open();
    expect(again.generation).toBe(generation);
    again.change((change) => {
      addRoot(change, "agent-meena");
    });
    expect(again.eventsAfter(0).map((event) => event.number)).toEqual([
      1, 3, 4,
    ]);
    expect(again.eventsAfter(3).map((event) => event.agent)).toEqual([
      "agent-meena",
    ]);
    shut(again);

    // The file is lost: Rufi starts a new one.
    await rm(folder, { recursive: true, force: true });
    folder = await mkdtemp(join(tmpdir(), "rufi-agents-"));
    path = join(folder, "agents.sqlite");
    const fresh = open();
    expect(fresh.generation).not.toBe(generation);
    expect(fresh.eventsAfter(0)).toEqual([]);
  });

  it("from a newer version isn't opened, and is left as it was", () => {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 99");
    db.close();

    expect(() => open()).toThrow(NewerAgentStore);

    const after = new DatabaseSync(path, { readOnly: true });
    expect(after.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 99,
    });
    expect(
      after.prepare("SELECT count(*) AS n FROM sqlite_schema").get(),
    ).toEqual({ n: 0 });
    after.close();
  });
});
