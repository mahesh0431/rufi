// The package runs agents, their turns and their one queue, through its own
// API, on the fake provider and a real agent database.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgents,
  type Agents,
  type Claim,
  type Host,
  type NewAgent,
  type Sent,
} from "../src/agents.ts";
import type {
  Conversation,
  ProviderAdapter,
  ProviderEvent,
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
/** The person's messages as Rufi keeps them (its chat_queue). */
let chat: Map<string, { state: string; parts: readonly string[] }>;
let claims: { input: string; status: string }[];
let errors: unknown[];

/** Rufi's claim, as one transaction of its own would answer it. */
function claim({ input }: Parameters<Host["claim"]>[0]): Promise<Claim> {
  const row = chat.get(input);
  let answer: Claim = { status: "gone" };
  if (row?.state === "waiting") {
    row.state = "handing_over";
    answer = { status: "claimed", parts: row.parts };
  }
  claims.push({ input, status: answer.status });
  return Promise.resolve(answer);
}

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
  claim,
});

/** The package as Rufi starts it: nothing goes before it dispatches. */
const run = async (adapter: ProviderAdapter, on: Host = host()) => {
  const made = createAgents({
    store,
    adapters: [adapter],
    host: on,
    onError: (error) => errors.push(error),
  });
  await made.dispatch();
  return made;
};

/** The fake, with some of each conversation's calls changed. */
const changed = (
  change: (conversation: Conversation) => Partial<Conversation>,
): ProviderAdapter => ({
  ...fake.adapter,
  open: async (options) => {
    const conversation = await fake.adapter.open(options);
    return { ...conversation, ...change(conversation) };
  },
});

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "rufi-agents-"));
  store = openAgentStore(join(folder, "agents.sqlite"));
  fake = fakeProvider({ answer: ANSWER });
  ledger = [];
  openings = [];
  chat = new Map();
  claims = [];
  errors = [];
  agents = await run(fake.adapter);
});

afterEach(async () => {
  await agents.close();
  store.close();
  await rm(folder, { recursive: true, force: true });
  // Nobody got an error, and the dispatcher had none of its own.
  expect(errors).toEqual([]);
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

const asha = () => {
  agents.create(ASHA);
  agents.admit(ASHA.id);
};

/** A message of the person's: Rufi keeps its words, and a claim gives them. */
function person(id: string, words = "What was my last TSH?"): Sent {
  chat.set(id, { state: "waiting", parts: [words] });
  return { id, sender: "person", kind: "steer" };
}

/** A message from another agent, with its words. */
const note = (id: string, kind: "steer" | "queue" = "queue"): Sent => ({
  id,
  sender: "agent-reader",
  kind,
  parts: [`Reading report.pdf: ${id}`],
});

const rows = (sql: string, ...params: string[]) =>
  store.db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row }));

const states = (): Record<string, string> =>
  Object.fromEntries(
    rows("SELECT id, state FROM queue").map(({ id, state }) => [
      String(id),
      String(state),
    ]),
  );

const until = (check: () => void) => vi.waitFor(check, { timeout: 2_000 });

/** The agent's latest turn, and the provider's reference for it. */
const latestTurn = (agent: string) =>
  store.db
    .prepare(
      "SELECT id, provider_turn AS ref FROM turns WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(agent) as { id: string; ref: string };

const running = () =>
  until(() => {
    expect(
      rows("SELECT status FROM turns WHERE status = 'running'"),
    ).toHaveLength(1);
  });

const received = () =>
  fake.received(ledger[0]?.ref ?? "").map((input) => input.id);

const meta = (call: string) => ({ "fake/call": call });

describe("an agent", () => {
  it("runs only once the host has admitted it", async () => {
    agents.create(ASHA);
    agents.send(ASHA.id, person("msg-1"));
    await sleep(20);
    expect(openings).toEqual([]);
    expect(states()).toEqual({ "msg-1": "waiting" });

    fake.script.picture = "ZmljdGlvbmFs";
    agents.admit(ASHA.id);

    await until(() => {
      expect(agents.get(ASHA.id)).toMatchObject({
        status: "done",
        result: ANSWER,
      });
    });
    // Its conversation was in the host's ledger before anything went in,
    // and the message went with the words Rufi's claim gave.
    expect(ledger).toEqual([
      { conversation: 1, ref: expect.any(String) as string, received: 0 },
    ]);
    expect(chat.get("msg-1")?.state).toBe("handing_over");
    expect(fake.received(ledger[0]?.ref ?? "")).toEqual([
      { id: "msg-1", parts: ["What was my last TSH?"] },
    ]);
    const turn = latestTurn(ASHA.id);
    expect(
      rows("SELECT type, title, status, text FROM items ORDER BY position"),
    ).toEqual([
      { type: "step", title: "get_page", status: "done", text: null },
      { type: "text", title: null, status: "done", text: ANSWER },
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
    asha();
    agents.send(ASHA.id, note("note-1"));
    await until(() => {
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });

    // Rufi restarts, and the provider no longer has the conversation.
    await agents.close();
    fake = fakeProvider({ answer: ANSWER });
    agents = await run(fake.adapter);
    agents.send(ASHA.id, note("note-2"));
    await until(() => {
      expect(states()["note-2"]).toBe("delivered");
    });

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
    ).toEqual(["note-2"]);
  });
});

describe("a conversation the provider lost", () => {
  it("is replaced by a new one, which the input that found it gone starts", async () => {
    asha();
    agents.send(ASHA.id, note("note-1"));
    await until(() => {
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });
    await fake.adapter.delete(ledger[0]?.ref ?? "");

    agents.send(ASHA.id, note("note-2"));
    await until(() => {
      expect(states()["note-2"]).toBe("delivered");
    });
    expect(openings).toEqual(["new", "new"]);
    expect(agents.get(ASHA.id)?.conversation).toBe(2);
    expect(
      fake.received(ledger[1]?.ref ?? "").map((input) => input.id),
    ).toEqual(["note-2"]);
  });
});

describe("the host", () => {
  it("opens the agent's conversation when it asks, sets its next turn's model, and opens it again, or anew, while it is idle", async () => {
    asha();
    const ref = await agents.open(ASHA.id);
    expect(await agents.open(ASHA.id)).toBe(ref);
    agents.configure(ASHA.id, { model: "fake-small", effort: "low" });
    agents.send(ASHA.id, note("note-1"));
    await until(() => {
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });
    expect(rows("SELECT model, effort FROM turns")).toEqual([
      { model: "fake-small", effort: "low" },
    ]);

    // New rules: its own conversation opens again.
    await agents.reopen(ASHA.id);
    expect(await agents.open(ASHA.id)).toBe(ref);
    // A new one, under the next number.
    await agents.reopen(ASHA.id, true);
    const next = await agents.open(ASHA.id);
    expect(openings).toEqual(["new", "resume", "new"]);
    expect(ledger.map((entry) => entry.ref)).toEqual([ref, next]);
    expect(agents.get(ASHA.id)?.conversation).toBe(2);

    // Never while a turn runs.
    fake.script.turn = "runs";
    agents.send(ASHA.id, note("note-2"));
    await running();
    await expect(agents.reopen(ASHA.id)).rejects.toThrow("in use");
  });

  it("is shown each event of the open conversation once the package has kept it, with its item's place", async () => {
    await agents.close();
    const shown: {
      ref: string;
      type: string;
      turn?: string;
      position?: number;
    }[] = [];
    let deliver: (event: ProviderEvent) => void = () => undefined;
    agents = createAgents({
      store,
      adapters: [
        {
          ...fake.adapter,
          open: (options) => {
            deliver = options.onEvent;
            return fake.adapter.open(options);
          },
        },
      ],
      host: host(),
      onError: (error) => errors.push(error),
      live: (agent, ref, event, position) => {
        shown.push({
          ref,
          type: event.type,
          turn: agents.current(agent)?.status,
          ...(position !== undefined && { position }),
        });
      },
    });
    await agents.dispatch();
    asha();
    fake.script.turn = "runs";
    agents.send(ASHA.id, note("note-1"));
    await running();
    const ref = ledger[0]?.ref ?? "";
    const turn = latestTurn(ASHA.id);
    expect(agents.current(ASHA.id)).toEqual({
      status: "running",
      turn: turn.id,
      ref: turn.ref,
    });
    // A note starts, a step runs, the note ends, and a reasoning starts.
    const at = { turn: turn.ref };
    deliver({ type: "note", ...at, item: "note", delta: "Looking." });
    deliver({
      type: "step",
      ...at,
      item: "step",
      kind: "tool",
      title: "get_records",
      status: "done",
      payload: { result: "fictional" },
    });
    deliver({ type: "note", ...at, item: "note", delta: "", done: true });
    deliver({ type: "thinking", ...at, item: "reasoning", delta: "Asha's" });
    // In the order the turn first reported them; the reasoning as far as
    // it came, while it streams and once the turn ends.
    const reported = [
      {
        id: "note",
        position: 1,
        type: "note",
        status: "done",
        text: "Looking.",
      },
      { id: "step", position: 2, type: "step", kind: "tool", status: "done" },
      {
        id: "reasoning",
        position: 3,
        type: "reasoning",
        status: null,
        text: "Asha's",
      },
    ];
    expect(agents.items(ASHA.id, [turn.ref])).toMatchObject(reported);

    fake.end(ref);
    await until(() => {
      expect(shown.at(-1)).toEqual({ ref, type: "turnEnded" });
    });
    expect(shown[0]).toEqual({ ref, type: "turnStarted", turn: "running" });
    expect(shown.slice(1, -1).map((event) => event.position)).toEqual([
      1, 2, 1, 3,
    ]);
    expect(agents.current(ASHA.id)).toBeUndefined();
    expect(agents.items(ASHA.id, [turn.ref])).toMatchObject(reported);
    expect(agents.item(ASHA.id, turn.ref, "step")?.payload).toEqual({
      result: "fictional",
    });
  });
});

describe("the queue", () => {
  it("hands nothing over before the host dispatches, and a second dispatch leaves a start alone", async () => {
    const asked = Promise.withResolvers<undefined>();
    const go = Promise.withResolvers<undefined>();
    agents = createAgents({
      store,
      adapters: [
        changed((conversation) => ({
          startTurn: async (start) => {
            asked.resolve(undefined);
            await go.promise;
            return conversation.startTurn(start);
          },
        })),
      ],
      host: host(),
      onError: (error) => errors.push(error),
    });
    asha();
    agents.send(ASHA.id, note("note-1"));
    // A new task: whatever a hand-over would have begun has run by now.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openings).toEqual([]);

    await agents.dispatch();
    await asked.promise;
    // The start is with the provider when Rufi dispatches again.
    await agents.dispatch();
    go.resolve(undefined);

    await until(() => {
      expect(agents.get(ASHA.id)).toMatchObject({
        status: "done",
        result: ANSWER,
      });
    });
    expect(rows("SELECT turn_id FROM queue")).toEqual([
      { turn_id: latestTurn(ASHA.id).id },
    ]);
  });

  it("starts a turn with the first input; a steer goes into it at once, a queued input waits for its end", async () => {
    asha();
    fake.script.turn = "runs";
    agents.send(ASHA.id, note("note-1"));
    await running();
    const first = latestTurn(ASHA.id);

    agents.send(ASHA.id, note("note-2", "queue"));
    agents.send(ASHA.id, note("note-3", "steer"));
    await until(() => {
      expect(states()["note-3"]).toBe("delivered");
    });
    expect(states()).toMatchObject({
      "note-1": "delivered",
      "note-2": "waiting",
    });

    fake.end(ledger[0]?.ref ?? "");
    await until(() => {
      expect(states()["note-2"]).toBe("delivered");
    });
    expect(rows("SELECT id, turn_id FROM queue ORDER BY position")).toEqual([
      { id: "note-1", turn_id: first.id },
      { id: "note-2", turn_id: latestTurn(ASHA.id).id },
      { id: "note-3", turn_id: first.id },
    ]);
    expect(received()).toEqual(["note-1", "note-3", "note-2"]);
  });

  it("takes the host's changes to what waits: a removed input doesn't go, a new order holds, and one sent now goes first, also one removed before", async () => {
    asha();
    fake.script.turn = "runs";
    agents.send(ASHA.id, note("note-1"));
    await running();
    for (const id of ["note-2", "note-3", "note-4", "note-5"]) {
      agents.send(ASHA.id, note(id, "queue"));
    }
    agents.remove(["note-3", "note-5"]);
    agents.reorder(ASHA.id, ["note-4", "note-2"]);
    agents.sendNow("note-5");
    const ref = ledger[0]?.ref ?? "";
    for (const next of ["note-5", "note-4", "note-2"]) {
      fake.end(ref);
      await until(() => {
        expect(states()[next]).toBe("delivered");
      });
    }
    expect(received()).toEqual(["note-1", "note-5", "note-4", "note-2"]);
    expect(states()["note-3"]).toBe("removed");
  });

  it("holds a steer sent while the turn is starting, and puts it in the moment the turn is ready", async () => {
    const opened = Promise.withResolvers<undefined>();
    agents = await run(fake.adapter, {
      ...host(),
      opening: async (agent, kind) => {
        await opened.promise;
        return host().opening(agent, kind);
      },
    });
    asha();
    fake.script.turn = "runs";
    agents.send(ASHA.id, note("note-1"));
    agents.send(ASHA.id, note("note-2", "steer"));
    await sleep(20);
    expect(states()).toEqual({ "note-1": "waiting", "note-2": "waiting" });

    opened.resolve(undefined);
    await until(() => {
      expect(states()["note-2"]).toBe("delivered");
    });
    expect(rows("SELECT id FROM turns")).toHaveLength(1);
    expect(received()).toEqual(["note-1", "note-2"]);
  });

  it("starts the next turn with a steer whose turn ended before it went, ahead of what was queued", async () => {
    agents = await run(
      changed((conversation) => ({
        // The turn ends just as the steer reaches the provider.
        steer: (steer) => {
          fake.end(conversation.ref);
          return conversation.steer(steer);
        },
      })),
    );
    asha();
    fake.script.turn = "runs";
    agents.send(ASHA.id, note("note-1"));
    await running();
    agents.send(ASHA.id, note("note-2", "queue"));
    agents.send(ASHA.id, note("note-3", "steer"));
    await until(() => {
      expect(states()["note-3"]).toBe("delivered");
    });
    expect(states()["note-2"]).toBe("waiting");
    expect(received()).toEqual(["note-1", "note-3"]);
    expect(errors).toEqual([]);
  });

  it("counts a steer whose answer was lost as sent, and never sends it again", async () => {
    asha();
    fake.script.turn = "runs";
    agents.send(ASHA.id, note("note-1"));
    await running();
    fake.script.steer = "loses_reply";
    agents.send(ASHA.id, note("note-2", "steer"));
    await until(() => {
      expect(states()["note-2"]).toBe("delivered");
    });
    fake.end(ledger[0]?.ref ?? "");
    await until(() => {
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });
    await sleep(20);
    expect(received()).toEqual(["note-1", "note-2"]);
    expect(rows("SELECT id FROM turns")).toHaveLength(1);
  });

  it("holds an input while signed out, with the provider's line, and sends it once the sign-in is back", async () => {
    asha();
    fake.script.signedIn = false;
    agents.send(ASHA.id, note("note-1"));
    await until(() => {
      expect(rows("SELECT state, held, held_text FROM queue")).toEqual([
        {
          state: "waiting",
          held: "signed_out",
          held_text: "Signed out of the fake provider.",
        },
      ]);
    });

    fake.script.signedIn = true;
    agents.signedIn();
    await until(() => {
      expect(states()["note-1"]).toBe("delivered");
    });
    expect(received()).toEqual(["note-1"]);
  });

  it("holds a start the provider refuses, with its words; released, the same input goes once", async () => {
    asha();
    fake.script.start = "refuses";
    agents.send(ASHA.id, note("note-1"));
    await until(() => {
      expect(rows("SELECT state, held, held_text FROM queue")).toEqual([
        {
          state: "waiting",
          held: "failed",
          held_text: "The fake provider refused it.",
        },
      ]);
    });

    fake.script.start = "takes";
    // Sent again by its id, it is the same input.
    agents.send(ASHA.id, note("note-1"));
    agents.release(["note-1"]);
    await until(() => {
      expect(states()["note-1"]).toBe("delivered");
    });
    expect(received()).toEqual(["note-1"]);
  });
});

describe("a hand-over", () => {
  it("drops what Rufi says is gone; one a crash cut off counts as sent, its turn stopped by the restart", async () => {
    // Rufi stops once the hand-over is saved, before the provider answers.
    let crashed = true;
    const adapter = changed((conversation) => ({
      startTurn: (start) =>
        crashed
          ? new Promise<never>(() => undefined)
          : conversation.startTurn(start),
    }));
    agents = await run(adapter);
    asha();
    agents.send(ASHA.id, person("msg-1"));
    agents.send(ASHA.id, person("msg-2", "And my last HbA1c?"));
    // The person removed the first before it went.
    chat.set("msg-1", { state: "removed", parts: ["What was my last TSH?"] });
    await until(() => {
      expect(states()).toEqual({ "msg-1": "removed", "msg-2": "handing_over" });
    });

    await agents.close();
    crashed = false;
    agents = await run(adapter);

    expect(states()).toEqual({ "msg-1": "removed", "msg-2": "delivered" });
    expect(rows("SELECT status, reason FROM turns")).toEqual([
      { status: "stopped", reason: "restart" },
    ]);
    agents.send(ASHA.id, person("msg-3", "Thanks."));
    await until(() => {
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });
    expect(received()).toEqual(["msg-3"]);
    expect(claims.map(({ input }) => input)).toEqual([
      "msg-1",
      "msg-2",
      "msg-3",
    ]);
  });

  it("counts a start that failed after it may have gone as sent: its turn fails with the error", async () => {
    agents = await run(
      changed(() => ({
        startTurn: () => Promise.reject(new Error("Codex didn't answer.")),
      })),
    );
    asha();
    agents.send(ASHA.id, note("note-1"));
    await until(() => {
      expect(agents.get(ASHA.id)).toMatchObject({
        status: "failed",
        result: "Codex didn't answer.",
      });
    });
    expect(states()).toEqual({ "note-1": "delivered" });
    expect(rows("SELECT status, result FROM turns")).toEqual([
      { status: "failed", result: "Codex didn't answer." },
    ]);
  });
});

describe("a call to the host's tools", () => {
  it("goes under its agent's running turn, until a Stop closes it; what waits goes on after", async () => {
    // The provider takes its time to stop, as a real one may.
    const stopping = Promise.withResolvers<undefined>();
    agents = await run(
      changed((conversation) => ({
        stop: async (turn) => {
          await stopping.promise;
          await conversation.stop(turn);
        },
      })),
    );
    asha();
    fake.script.turn = "runs";
    agents.send(ASHA.id, note("note-1"));
    await running();
    const first = latestTurn(ASHA.id);
    expect(agents.place(ASHA.id, meta("call-1"))).toEqual({
      agent: ASHA.id,
      turn: first.id,
      ref: first.ref,
      conversation: 1,
      call: "call-1",
    });
    expect(agents.place(ASHA.id, {})).toBeUndefined();

    // Stop closes the turn before the provider has stopped it.
    agents.send(ASHA.id, note("note-2", "queue"));
    const stopped = agents.stop(ASHA.id, "person");
    expect(agents.place(ASHA.id, meta("call-2"))).toBeUndefined();
    stopping.resolve(undefined);
    await stopped;
    expect(
      rows("SELECT status, reason FROM turns WHERE id = ?", first.id),
    ).toEqual([{ status: "stopped", reason: "person" }]);

    // The next turn takes calls again.
    await running();
    expect(agents.place(ASHA.id, meta("call-3"))).toMatchObject({
      turn: latestTurn(ASHA.id).id,
    });
    expect(received()).toEqual(["note-1", "note-2"]);
  });
});

describe("a turn the provider began by itself", () => {
  it("is admitted once, with the steer it took, and its calls are placed in it", async () => {
    asha();
    fake.script.turn = "runs";
    agents.send(ASHA.id, note("note-1"));
    await running();
    const first = latestTurn(ASHA.id);

    fake.script.steer = "starts_next";
    agents.send(ASHA.id, note("note-2", "steer"));
    await until(() => {
      expect(states()["note-2"]).toBe("delivered");
    });

    const next = latestTurn(ASHA.id);
    expect(rows("SELECT id, status FROM turns ORDER BY rowid")).toEqual([
      { id: first.id, status: "done" },
      { id: next.id, status: "running" },
    ]);
    expect(rows("SELECT id, turn_id FROM queue ORDER BY position")).toEqual([
      { id: "note-1", turn_id: first.id },
      { id: "note-2", turn_id: next.id },
    ]);
    expect(
      store
        .eventsAfter(0)
        .filter((event) => event.type === "turn.started")
        .map((event) => event.payload),
    ).toEqual([
      { turn: first.id, ref: first.ref, inputs: ["note-1"], by: "package" },
      { turn: next.id, ref: next.ref, inputs: ["note-2"], by: "provider" },
    ]);
    expect(agents.place(ASHA.id, meta("call-1"))).toMatchObject({
      turn: next.id,
    });
  });
});

describe("Stop", () => {
  it("while a start is still opening keeps it from the provider and drops its input; what waits goes on", async () => {
    const asked = Promise.withResolvers<undefined>();
    const opened = Promise.withResolvers<undefined>();
    agents = await run(fake.adapter, {
      ...host(),
      opening: async (agent, kind) => {
        asked.resolve(undefined);
        await opened.promise;
        return host().opening(agent, kind);
      },
    });
    asha();
    agents.send(ASHA.id, note("note-1"));
    await asked.promise;
    agents.send(ASHA.id, note("note-2"));
    const stopped = agents.stop(ASHA.id, "person");
    opened.resolve(undefined);
    await stopped;

    await until(() => {
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });
    expect(states()).toEqual({ "note-1": "dropped", "note-2": "delivered" });
    expect(received()).toEqual(["note-2"]);
    expect(rows("SELECT status FROM turns")).toEqual([{ status: "done" }]);
  });
});

describe("forget", () => {
  it("lets go of every conversation it can, and the next forget tries again the one that failed", async () => {
    const closed: string[] = [];
    agents = await run({
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
    asha();
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
    agents.send(ASHA.id, note("note-1"));
    agents.send(reader.id, note("note-2"));
    await until(() => {
      expect(rows("SELECT status FROM turns")).toEqual([
        { status: "running" },
        { status: "running" },
      ]);
    });
    const refOf = (id: string) =>
      rows("SELECT provider_ref AS ref FROM agents WHERE id = ?", id)[0]?.[
        "ref"
      ];
    const [root, child] = [refOf(ASHA.id), refOf(reader.id)];

    await expect(agents.forget([ASHA.id])).rejects.toThrow();
    await agents.forget([ASHA.id]);

    expect(closed).toEqual([root, child, root]);
    expect(rows("SELECT id FROM agents")).toEqual([]);
  });

  it("removes an agent, everything below it and all they kept, and lets go of their conversations", async () => {
    const closed: string[] = [];
    agents = await run(
      changed((conversation) => ({
        close: async () => {
          closed.push(conversation.ref);
          await conversation.close();
        },
      })),
    );
    asha();
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
    agents.send(reader.id, note("note-1"));
    // Its done message wakes its parent, which answers it.
    await until(() => {
      expect(agents.get(reader.id)?.status).toBe("done");
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });
    expect(rows("SELECT id FROM items")).toHaveLength(4);

    await agents.forget([ASHA.id]);

    for (const table of ["agents", "turns", "items", "queue", "receipts"]) {
      expect(rows(`SELECT * FROM ${table}`)).toEqual([]);
    }
    expect(store.eventsAfter(0).map((event) => event.type)).toEqual([
      "agents.forgotten",
    ]);
    expect(closed.toSorted()).toEqual(
      ledger.map((entry) => entry.ref).toSorted(),
    );
    // Again, it does nothing.
    await agents.forget([ASHA.id]);
    expect(store.eventsAfter(0)).toHaveLength(1);
  });
});
