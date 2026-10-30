// The package runs agents and their turns, through its own API, on the fake
// provider and a real agent database.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgents,
  type Agents,
  type Host,
  type NewAgent,
  type Sent,
} from "../src/agents.ts";
import type {
  Input,
  ProviderAdapter,
  ProviderEvent,
  SteerOutcome,
} from "../src/provider.ts";
import { openAgentStore, type AgentStore } from "../src/store.ts";
import { ANSWER } from "./contract.ts";
import { fakeProvider, type FakeProvider } from "./fake-provider.ts";

let folder: string;
let store: AgentStore;
let fake: FakeProvider;
let agents: Agents;
/** What the host's ledger got, with how many inputs were in it by then. */
let ledger: { conversation: number; ref: string; received: number }[];
let openings: string[];

const host = (): Host => ({
  opening: (_agent, kind) => {
    openings.push(kind);
    return Promise.resolve({
      instructions: "Fictional rules.",
      tools: { url: "http://127.0.0.1:9/mcp", key: "fictional-key" },
      ...(kind === "new" && { seed: "Asha asked about her TSH." }),
    });
  },
  ledger: ({ conversation, ref }) => {
    ledger.push({ conversation, ref, received: fake.received(ref).length });
    return Promise.resolve();
  },
});

const run = (adapter: ProviderAdapter, on: Host = host()) =>
  createAgents({ store, adapters: [adapter], host: on });

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "rufi-agents-"));
  store = openAgentStore(join(folder, "agents.sqlite"));
  fake = fakeProvider({ answer: ANSWER });
  ledger = [];
  openings = [];
  agents = run(fake.adapter);
});

afterEach(async () => {
  await agents.close();
  store.close();
  await rm(folder, { recursive: true, force: true });
});

const ASHA: NewAgent = {
  id: "agent-asha",
  title: "Rufi AI",
  provider: "fake",
  model: "fake-model",
  effort: "medium",
  tools: ["get_records", "save_changes"],
  cwd: "/fictional/ai",
};

const message = (id: string): Sent => ({
  id,
  sender: "person",
  parts: ["What was my last TSH?"],
});

const rows = (sql: string, ...params: string[]) =>
  store.db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row }));

/** The provider's reference of the agent's latest turn. */
const latestTurn = (agent: string) =>
  store.db
    .prepare(
      "SELECT id, provider_turn AS ref FROM turns WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(agent) as { id: string; ref: string };

const meta = (turn: string, call: string) => ({
  "fake/turn": turn,
  "fake/call": call,
});

const deadline = () => AbortSignal.timeout(2_000);

describe("an agent", () => {
  it("runs only once the host has admitted it", async () => {
    agents.create(ASHA);
    await expect(agents.start(ASHA.id, message("msg-1"))).rejects.toThrow(
      "isn't admitted",
    );
    expect(openings).toEqual([]);

    agents.admit(ASHA.id);
    fake.script.picture = "ZmljdGlvbmFs";
    expect(await agents.start(ASHA.id, message("msg-1"))).toEqual({
      status: "delivered",
    });

    await vi.waitFor(() => {
      expect(agents.get(ASHA.id)).toMatchObject({
        status: "done",
        result: ANSWER,
      });
    });
    // Its conversation was in the host's ledger before anything went in.
    expect(ledger).toEqual([
      { conversation: 1, ref: expect.any(String) as string, received: 0 },
    ]);
    const turn = latestTurn(ASHA.id);
    expect(
      rows("SELECT type, title, status, text FROM items ORDER BY position"),
    ).toEqual([
      { type: "step", title: "get_page", status: "done", text: null },
      { type: "text", title: null, status: null, text: ANSWER },
    ]);
    expect(rows("SELECT id, state, turn_id FROM queue")).toEqual([
      { id: "msg-1", state: "delivered", turn_id: turn.id },
    ]);
    // The host hears of the answer from the event log.
    expect(store.eventsAfter(0).at(-1)).toMatchObject({
      type: "turn.ended",
      agent: ASHA.id,
      payload: { turn: turn.id, status: "done", answer: ANSWER },
    });
  });

  it("gets a new conversation, under the next number, when its own is gone", async () => {
    agents.create(ASHA);
    agents.admit(ASHA.id);
    await agents.start(ASHA.id, message("msg-1"));
    await vi.waitFor(() => {
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });

    // Rufi restarts, and the provider no longer has the conversation.
    await agents.close();
    fake = fakeProvider({ answer: ANSWER });
    agents = run(fake.adapter);
    await agents.start(ASHA.id, message("msg-2"));

    expect(openings).toEqual(["new", "resume", "new"]);
    expect(
      ledger.map(({ conversation, received }) => ({ conversation, received })),
    ).toEqual([
      { conversation: 1, received: 0 },
      { conversation: 2, received: 0 },
    ]);
    expect(agents.get(ASHA.id)?.conversation).toBe(2);
    expect(
      fake.received(ledger[1]?.ref ?? "").map((input) => input.id),
    ).toEqual(["msg-2"]);
  });
});

describe("a call to the host's tools", () => {
  it("is placed only in its turn while that is admitted and open", async () => {
    // The provider takes its time to stop, as a real one may.
    const stopping = Promise.withResolvers<undefined>();
    const slow: ProviderAdapter = {
      ...fake.adapter,
      open: async (options) => {
        const conversation = await fake.adapter.open(options);
        return {
          ...conversation,
          stop: async (turn) => {
            await stopping.promise;
            await conversation.stop(turn);
          },
        };
      },
    };
    agents = run(slow);
    agents.create(ASHA);
    agents.admit(ASHA.id);
    fake.script.turn = "runs";
    await agents.start(ASHA.id, message("msg-1"));
    const first = latestTurn(ASHA.id);

    expect(
      await agents.place(ASHA.id, meta(first.ref, "call-1"), deadline()),
    ).toEqual({
      agent: ASHA.id,
      turn: first.id,
      conversation: 1,
      call: "call-1",
    });

    // Stop closes the turn before the provider has stopped it.
    const stopped = agents.stop(ASHA.id, "person");
    expect(
      await agents.place(ASHA.id, meta(first.ref, "call-2"), deadline()),
    ).toBeUndefined();
    stopping.resolve(undefined);
    await stopped;
    expect(agents.get(ASHA.id)).toMatchObject({
      status: "stopped",
      stoppedBy: "person",
    });

    // A newer turn doesn't open the old one again.
    await agents.start(ASHA.id, message("msg-2"));
    expect(
      await agents.place(ASHA.id, meta(first.ref, "call-3"), deadline()),
    ).toBeUndefined();
  });
});

describe("a call waiting for its turn's admission", () => {
  it("is refused when the conversation closes before it goes on", async () => {
    // The provider's word that the turn started is held back.
    const held: ProviderEvent[] = [];
    let deliver: (event: ProviderEvent) => void = () => undefined;
    agents = run({
      ...fake.adapter,
      open: (options) => {
        deliver = options.onEvent;
        return fake.adapter.open({
          ...options,
          onEvent: (event) => {
            if (event.type === "turnStarted") held.push(event);
            else options.onEvent(event);
          },
        });
      },
    });
    agents.create(ASHA);
    agents.admit(ASHA.id);
    fake.script.turn = "runs";
    await agents.start(ASHA.id, message("msg-1"));
    const [started] = held;
    if (started?.type !== "turnStarted") throw new Error("No turn started.");

    const placed = agents.place(
      ASHA.id,
      meta(started.turn, "save-1"),
      deadline(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The turn is admitted, and Rufi closes before the call goes on.
    deliver(started);
    const closed = agents.close();

    expect(await placed).toBeUndefined();
    await closed;
  });
});

describe("a turn the provider began by itself", () => {
  it("is admitted once, with the steer it took, and its calls are placed in it", async () => {
    agents.create(ASHA);
    agents.admit(ASHA.id);
    fake.script.turn = "runs";
    await agents.start(ASHA.id, message("msg-1"));
    const first = latestTurn(ASHA.id);

    fake.script.steer = "starts_next";
    const outcome = await agents.steer(ASHA.id, message("msg-2"));

    const next = latestTurn(ASHA.id);
    expect(outcome).toEqual({ status: "next_turn", turn: next.ref });
    expect(rows("SELECT id, status FROM turns ORDER BY rowid")).toEqual([
      { id: first.id, status: "done" },
      { id: next.id, status: "running" },
    ]);
    expect(
      rows("SELECT id, state, turn_id FROM queue ORDER BY position"),
    ).toEqual([
      { id: "msg-1", state: "delivered", turn_id: first.id },
      { id: "msg-2", state: "delivered", turn_id: next.id },
    ]);
    expect(
      store
        .eventsAfter(0)
        .filter((event) => event.type === "turn.started")
        .map((event) => event.payload),
    ).toEqual([
      { turn: first.id, inputs: ["msg-1"], by: "package" },
      { turn: next.id, inputs: ["msg-2"], by: "provider" },
    ]);
    expect(
      await agents.place(ASHA.id, meta(next.ref, "call-1"), deadline()),
    ).toMatchObject({ turn: next.id });
  });
});

describe("Stop", () => {
  it("after the turn ended asks the provider to settle a steer it still holds", async () => {
    agents.create(ASHA);
    agents.admit(ASHA.id);
    fake.script.turn = "runs";
    await agents.start(ASHA.id, message("msg-1"));
    // The provider holds the steer, and the turn ends without it.
    fake.script.steer = "holds_past_end";
    const steered = agents.steer(ASHA.id, message("msg-2"));
    await vi.waitFor(() => {
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });

    await agents.stop(ASHA.id, "person");

    expect(await steered).toMatchObject({ status: "not_delivered" });
    expect(rows("SELECT id, state FROM queue ORDER BY position")).toEqual([
      { id: "msg-1", state: "delivered" },
      { id: "msg-2", state: "waiting" },
    ]);
  });

  it("closes and stops a turn the provider begins with a held steer as it settles it", async () => {
    let held = Promise.withResolvers<SteerOutcome>();
    let taking: Input | undefined;
    const taken: string[] = [];
    const stopped: { turn: string; status: unknown }[] = [];
    const placed: unknown[] = [];
    agents = run({
      ...fake.adapter,
      open: async (options) => {
        const conversation = await fake.adapter.open(options);
        return {
          ...conversation,
          // The provider holds every steer.
          steer: ({ input }) => {
            taking = input;
            held = Promise.withResolvers();
            return held.promise;
          },
          stop: async (turn) => {
            stopped.push({
              turn,
              status: rows(
                "SELECT status FROM turns WHERE provider_turn = ?",
                turn,
              )[0]?.["status"],
            });
            if (!taking) return conversation.stop(turn);
            // Just then the turn ends, if it still ran, and the provider
            // takes the held steer as a turn of its own, which calls a tool.
            fake.end(conversation.ref);
            await conversation.startTurn({
              input: taking,
              model: ASHA.model,
              effort: ASHA.effort,
            });
            taking = undefined;
            const next = latestTurn(ASHA.id).ref;
            taken.push(next);
            held.resolve({ status: "next_turn", turn: next });
            placed.push(
              await agents.place(ASHA.id, meta(next, "call-1"), deadline()),
            );
          },
        };
      },
    });
    agents.create(ASHA);
    agents.admit(ASHA.id);
    fake.script.turn = "runs";

    // The turn ends before Stop.
    await agents.start(ASHA.id, message("msg-1"));
    const first = latestTurn(ASHA.id);
    const steered = agents.steer(ASHA.id, message("msg-2"));
    fake.end(ledger[0]?.ref ?? "");
    await vi.waitFor(() => {
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });
    await agents.stop(ASHA.id, "person");
    expect(await steered).toEqual({ status: "next_turn", turn: taken[0] });
    expect(agents.get(ASHA.id)).toMatchObject({
      status: "stopped",
      stoppedBy: "person",
    });

    // The turn ends during Stop.
    await agents.start(ASHA.id, message("msg-3"));
    const second = latestTurn(ASHA.id);
    const resteered = agents.steer(ASHA.id, message("msg-4"));
    await agents.stop(ASHA.id, "person");
    expect(await resteered).toEqual({ status: "next_turn", turn: taken[1] });
    expect(agents.get(ASHA.id)).toMatchObject({
      status: "stopped",
      stoppedBy: "person",
    });

    // Closed to calls from the moment they were admitted.
    expect(placed).toEqual([undefined, undefined]);
    expect(stopped).toEqual([
      { turn: first.ref, status: "done" },
      { turn: taken[0], status: "stopping" },
      { turn: second.ref, status: "stopping" },
      { turn: taken[1], status: "stopping" },
    ]);
  });

  it("while a start is still opening keeps it from the provider", async () => {
    const opened = Promise.withResolvers<undefined>();
    agents = run(fake.adapter, {
      ...host(),
      opening: async (agent, kind) => {
        await opened.promise;
        return host().opening(agent, kind);
      },
    });
    agents.create(ASHA);
    agents.admit(ASHA.id);

    const started = agents.start(ASHA.id, message("msg-1"));
    const stopped = agents.stop(ASHA.id, "person");
    opened.resolve(undefined);

    expect(await started).toMatchObject({ status: "not_delivered" });
    await stopped;
    expect(fake.received(ledger[0]?.ref ?? "")).toEqual([]);
    expect(rows("SELECT id FROM turns")).toEqual([]);
    expect(agents.get(ASHA.id)?.status).toBe("idle");
  });
});

describe("forget", () => {
  it("lets go of every conversation it can, and the next forget tries again the one that failed", async () => {
    const closed: string[] = [];
    agents = run({
      ...fake.adapter,
      open: async (options) => {
        const conversation = await fake.adapter.open(options);
        return {
          ...conversation,
          close: async () => {
            closed.push(conversation.ref);
            if (closed.length === 1) {
              throw new Error("The fake provider couldn't close it.");
            }
            await conversation.close();
          },
        };
      },
    });
    agents.create(ASHA);
    agents.admit(ASHA.id);
    const reader: NewAgent = {
      ...ASHA,
      id: "agent-reader",
      parent: ASHA.id,
      title: "Reading report.pdf",
      tools: ["get_records"],
    };
    agents.create(reader);
    agents.admit(reader.id);
    fake.script.turn = "runs";
    await agents.start(ASHA.id, message("msg-1"));
    await agents.start(reader.id, message("msg-2"));
    const [asha, child] = ledger.map((entry) => entry.ref);

    await expect(agents.forget([ASHA.id])).rejects.toThrow();
    await agents.forget([ASHA.id]);

    expect(closed).toEqual([asha, child, asha]);
    expect(rows("SELECT id FROM agents")).toEqual([]);
  });

  it("removes an agent, everything below it and all they kept, and lets go of their conversations", async () => {
    const closed: string[] = [];
    agents = run({
      ...fake.adapter,
      open: async (options) => {
        const conversation = await fake.adapter.open(options);
        return {
          ...conversation,
          close: async () => {
            closed.push(conversation.ref);
            await conversation.close();
          },
        };
      },
    });
    agents.create(ASHA);
    agents.admit(ASHA.id);
    const reader: NewAgent = {
      ...ASHA,
      id: "agent-reader",
      parent: ASHA.id,
      title: "Reading report.pdf",
      tools: ["get_records"],
    };
    // A child never gets more than its parent.
    expect(() =>
      agents.create({ ...reader, tools: ["get_records", "send_email"] }),
    ).toThrow("A child's tools are among its parent's.");
    agents.create(reader);
    agents.admit(reader.id);
    fake.script.picture = "ZmljdGlvbmFs";
    await agents.start(reader.id, message("msg-1"));
    await vi.waitFor(() => {
      expect(agents.get(reader.id)?.status).toBe("done");
    });
    expect(rows("SELECT id FROM items")).toHaveLength(2);

    await agents.forget([ASHA.id]);

    for (const table of ["agents", "turns", "items", "queue", "receipts"]) {
      expect(rows(`SELECT * FROM ${table}`)).toEqual([]);
    }
    expect(store.eventsAfter(0).map((event) => event.type)).toEqual([
      "agents.forgotten",
    ]);
    expect(closed).toEqual([ledger[0]?.ref]);
    // Again, it does nothing.
    await agents.forget([ASHA.id]);
    expect(store.eventsAfter(0)).toHaveLength(1);
  });
});
