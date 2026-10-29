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
import type { Conversation, ProviderAdapter } from "../src/provider.ts";
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
let chat: Map<
  string,
  { state: string; sentAs?: string; parts: readonly string[] }
>;
let claims: { input: string; status: string }[];
let errors: unknown[];

/** Rufi's claim, as one transaction of its own would answer it. */
function claim({
  agent,
  conversation,
  input,
}: Parameters<Host["claim"]>[0]): Promise<Claim | undefined> {
  const row = chat.get(input);
  const sentAs = `${agent}/${String(conversation)}`;
  let answer: Claim | undefined;
  if (row?.state === "waiting") {
    Object.assign(row, { state: "handing_over", sentAs });
    answer = { status: "claimed", parts: row.parts };
  } else if (row?.state === "handing_over") {
    if (row.sentAs === sentAs) {
      answer = { status: "already_claimed", parts: row.parts };
    }
  } else {
    answer = { status: "gone" };
  }
  claims.push({ input, status: answer?.status ?? "none" });
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

const run = (adapter: ProviderAdapter, on: Host = host()) =>
  createAgents({
    store,
    adapters: [adapter],
    host: on,
    onError: (error) => errors.push(error),
  });

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
  agents = run(fake.adapter);
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

const meta = (turn: string, call: string) => ({
  "fake/turn": turn,
  "fake/call": call,
});

const deadline = () => AbortSignal.timeout(2_000);

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
    expect(chat.get("msg-1")).toMatchObject({
      state: "handing_over",
      sentAs: `${ASHA.id}/1`,
    });
    expect(fake.received(ledger[0]?.ref ?? "")).toEqual([
      { id: "msg-1", parts: ["What was my last TSH?"] },
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
    asha();
    agents.send(ASHA.id, note("note-1"));
    await until(() => {
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });

    // Rufi restarts, and the provider no longer has the conversation.
    await agents.close();
    fake = fakeProvider({ answer: ANSWER });
    agents = run(fake.adapter);
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

describe("the queue", () => {
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

  it("holds a steer sent while the turn is starting, and puts it in the moment the turn is ready", async () => {
    const opened = Promise.withResolvers<undefined>();
    agents = run(fake.adapter, {
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

  it("starts nothing while a steer is still with the provider; one it didn't take goes first, and starts the next turn", async () => {
    asha();
    fake.script.turn = "runs";
    agents.send(ASHA.id, note("note-1"));
    await running();
    agents.send(ASHA.id, note("note-2", "queue"));

    // The provider holds the steer until its turn ends, and then doesn't take it.
    fake.script.steer = "holds";
    agents.send(ASHA.id, note("note-3", "steer"));
    await until(() => {
      expect(states()["note-3"]).toBe("handing_over");
    });
    fake.end(ledger[0]?.ref ?? "", { status: "failed", reason: "other" });

    await until(() => {
      expect(states()["note-3"]).toBe("delivered");
    });
    const next = latestTurn(ASHA.id);
    expect(rows("SELECT id, state, turn_id FROM queue ORDER BY id")).toEqual([
      {
        id: "note-1",
        state: "delivered",
        turn_id: expect.any(String) as string,
      },
      { id: "note-2", state: "waiting", turn_id: null },
      { id: "note-3", state: "delivered", turn_id: next.id },
    ]);
    expect(received()).toEqual(["note-1", "note-3"]);
  });

  it("settles an uncertain steer by what the provider can tell, and never sends one it can't tell again", async () => {
    let canTell = true;
    agents = run(
      changed((conversation) => ({
        reconcile: (ids) =>
          canTell
            ? conversation.reconcile(ids)
            : Promise.resolve(new Map(ids.map((id) => [id, "unknown"]))),
      })),
    );
    asha();
    fake.script.turn = "runs";
    agents.send(ASHA.id, note("note-1"));
    await running();

    fake.script.steer = "loses_reply";
    agents.send(ASHA.id, note("note-2", "steer"));
    await until(() => {
      expect(states()["note-2"]).toBe("delivered");
    });

    canTell = false;
    agents.send(ASHA.id, note("note-3", "steer"));
    await until(() => {
      expect(states()["note-3"]).toBe("not_sure");
    });
    fake.end(ledger[0]?.ref ?? "");
    await until(() => {
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });
    await sleep(20);
    expect(received()).toEqual(["note-1", "note-2", "note-3"]);
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
});

describe("a hand-over", () => {
  it("drops what Rufi says is gone, and after a crash between Rufi's claim and its own save, sends the message once", async () => {
    // Rufi committed its claim, then Rufi stopped before the package saved
    // the hand-over.
    let crashed = true;
    agents = run(fake.adapter, {
      ...host(),
      claim: async (asked) => {
        const answer = await claim(asked);
        return crashed && asked.input === "msg-2"
          ? new Promise<never>(() => undefined)
          : answer;
      },
    });
    asha();
    agents.send(ASHA.id, person("msg-1"));
    agents.send(ASHA.id, person("msg-2", "And my last HbA1c?"));
    // The person removed the first before it went.
    chat.set("msg-1", { state: "removed", parts: ["What was my last TSH?"] });
    await until(() => {
      expect(chat.get("msg-2")?.state).toBe("handing_over");
    });
    expect(states()).toEqual({ "msg-1": "removed", "msg-2": "waiting" });

    await agents.close();
    crashed = false;
    agents = run(fake.adapter);
    await agents.dispatch();

    await until(() => {
      expect(states()["msg-2"]).toBe("delivered");
    });
    expect(claims.filter(({ input }) => input === "msg-2")).toEqual([
      { input: "msg-2", status: "claimed" },
      { input: "msg-2", status: "already_claimed" },
    ]);
    expect(fake.received(ledger[0]?.ref ?? "")).toEqual([
      { id: "msg-2", parts: ["And my last HbA1c?"] },
    ]);
  });

  it("cut off by a crash is asked about at the next start, and goes once", async () => {
    // Rufi stops after the hand-over was saved, before the provider had it.
    let crashed = true;
    const adapter = changed((conversation) => ({
      startTurn: (start) =>
        crashed
          ? new Promise<never>(() => undefined)
          : conversation.startTurn(start),
    }));
    agents = run(adapter);
    asha();
    agents.send(ASHA.id, note("note-1"));
    await until(() => {
      expect(states()["note-1"]).toBe("handing_over");
    });

    await agents.close();
    crashed = false;
    agents = run(adapter);
    await agents.dispatch();

    await until(() => {
      expect(agents.get(ASHA.id)?.status).toBe("done");
    });
    expect(received()).toEqual(["note-1"]);
    expect(rows("SELECT status FROM turns")).toEqual([{ status: "done" }]);
  });
});

describe("a call to the host's tools", () => {
  it("is placed only in its turn while that is admitted and open", async () => {
    // The provider takes its time to stop, as a real one may.
    const stopping = Promise.withResolvers<undefined>();
    agents = run(
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
    agents.send(ASHA.id, note("note-2"));
    await running();
    expect(
      await agents.place(ASHA.id, meta(first.ref, "call-3"), deadline()),
    ).toBeUndefined();
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
      { turn: first.id, inputs: ["note-1"], by: "package" },
      { turn: next.id, inputs: ["note-2"], by: "provider" },
    ]);
    expect(
      await agents.place(ASHA.id, meta(next.ref, "call-1"), deadline()),
    ).toMatchObject({ turn: next.id });
  });
});

describe("Stop", () => {
  it("while a start is still opening keeps it from the provider, and drops its input", async () => {
    const asked = Promise.withResolvers<undefined>();
    const opened = Promise.withResolvers<undefined>();
    agents = run(fake.adapter, {
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
    const stopped = agents.stop(ASHA.id, "person");
    opened.resolve(undefined);
    await stopped;

    expect(states()).toEqual({ "note-1": "dropped" });
    expect(received()).toEqual([]);
    expect(rows("SELECT id FROM turns")).toEqual([]);
    expect(agents.get(ASHA.id)?.status).toBe("idle");
  });
});

describe("forget", () => {
  it("removes an agent, everything below it and all they kept, and lets go of their conversations", async () => {
    const closed: string[] = [];
    agents = run(
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
    await until(() => {
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
