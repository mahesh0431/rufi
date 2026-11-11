// A document handed to a reader is a job (core/documents/jobs.ts): Rufi AI's
// start_agent and send_agent with documents open it, save_reading from the
// reader or one below it moves it on, and the package's events end it. On
// a real record, a real agent database and the package's fake provider.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProvider, type FakeProvider } from "@rufi/agents/fake";
import { openAgentStore } from "@rufi/agents/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatAgents } from "../core/chat/agents.ts";
import { chatQueue } from "../core/chat/queue.ts";
import {
  transcripts as openTranscripts,
  type ChatRow,
} from "../core/chat/transcript.ts";
import { readings } from "../core/documents/reading.ts";
import { saveReading } from "../core/documents/save-reading.ts";
import {
  databasePath,
  openWritable,
  type Store,
} from "../core/store/database.ts";
import type { TurnScope } from "../core/tools/tools.ts";
import { agentsPath } from "./agents.ts";
import { chat as openChat } from "./chat.ts";
import { mcpKeys } from "./mcp.ts";
import { startRufiAi } from "./rufi-ai.ts";
import { lineOf, subAgents } from "./sub-agents.ts";

const family = await readFile(
  new URL("../../tests/fixtures/fictional-family.sql", import.meta.url),
  "utf8",
);
/** Asha's two-page report. */
const REPORT = "doc-asha-aug";

let home: string;
let record: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-reading-jobs-"));
  record = openWritable(databasePath(home));
  record.db.exec(family);
});

afterEach(async () => {
  record.close();
  await rm(home, { recursive: true, force: true });
});

/** Rufi with Asha's chat on the fake provider, and Rufi AI's agent tools. */
async function start(fake: FakeProvider) {
  const store = openAgentStore(agentsPath(home));
  const transcripts = openTranscripts(record);
  const system = await startRufiAi({
    store,
    record,
    transcripts,
    adapters: [fake.adapter],
    tools: [],
    cwd: join(home, "ai"),
    model: "gpt-6.1-sol",
    log: () => undefined,
  });
  const queue = chatQueue(record);
  const chat = openChat({
    transcripts,
    queue,
    readings: readings(record),
    signIn: () =>
      Promise.resolve({ state: "signed_in", account: null, text: null }),
    agent: system.rufiAi,
    mcp: { url: () => "http://127.0.0.1:9/mcp", keys: mcpKeys() },
    rules: () => ({ instructions: "Fictional rules.", version: "rules-1" }),
    tools: {
      specs: [],
      caller: () => () => Promise.reject(new Error("No tools here.")),
    },
    log: () => undefined,
  });
  await system.agents.dispatch();
  const row = (await transcripts.chat("asha")) as ChatRow;
  const root = await system.root(row.id);
  const tools = subAgents({
    agents: system.agents,
    kept: chatAgents(record),
    record,
    queue,
    log: () => undefined,
    messages: () => chat.queue,
    signIn: () =>
      Promise.resolve({ state: "signed_in", account: null, text: null }),
    usage: () => Promise.resolve([]),
  });
  /** An agent's tools, in its turn. */
  const as = (agent: string) =>
    tools({
      chat: row,
      agent,
      thread: "thread-1",
      conversation: 1,
      turn: `turn-${agent}`,
      ref: `ref-${agent}`,
      tools: [],
    } satisfies TurnScope);
  /** A reader started by `by`, given the report's pages; its id. */
  const reader = async (id: string, pages?: number[], by = root) => {
    await as(by).start(
      {
        title: `Reading ${id}`,
        task: "Read the report.",
        documents: [{ id: REPORT, ...(pages && { pages }) }],
      },
      id,
    );
    return id;
  };
  /** `agent` saves these pages of the report. */
  const saves = (agent: string, pages: number[]) =>
    record.query.transaction().execute((trx) =>
      saveReading()(
        {
          personId: "asha",
          chatId: row.id,
          callId: `save-${agent}-${pages.join("-")}`,
          line: lineOf(system.agents, agent),
        },
        {
          document: REPORT,
          pages: pages.map((page) => ({
            page,
            outcome: "read" as const,
            copy: `| Haemoglobin | 13.${String(page)} | g/dL |`,
          })),
        },
        trx,
      ),
    );
  /** The agent's turn, once it runs; ended with the fake's answer. */
  const ends = async (agent: string) => {
    const turn = await vi.waitFor(() => {
      const current = system.agents.current(agent);
      if (current?.status !== "running") throw new Error("Not running.");
      return current.ref;
    });
    // Its conversation, as Rufi's ledger keeps it.
    const { ref } = record.db
      .prepare(
        "SELECT ref FROM agent_conversations WHERE agent_id = ? ORDER BY conversation DESC",
      )
      .get(agent) as { ref: string };
    fake.end(ref);
    await vi.waitFor(() => {
      const now = system.agents.current(agent);
      if (now?.status === "running" && now.ref === turn) {
        throw new Error("Still running.");
      }
    });
  };
  return {
    root,
    as,
    reader,
    saves,
    ends,
    close: async () => {
      await chat.close();
      await system.close();
      store.close();
    },
  };
}

/** The report as the Documents page and get_documents show it. */
const shown = async () => {
  const status = (await readings(record).statuses("asha")).get(REPORT);
  return {
    status: status?.status ?? "not_read",
    ended: status?.ended ?? null,
    canRetry: status?.canRetry ?? false,
  };
};

/** The report's jobs, oldest first. */
const jobs = () =>
  record.db
    .prepare(
      "SELECT agent_id, state, ended_why, targets FROM jobs WHERE document_id = ? ORDER BY created_at, rowid",
    )
    .all(REPORT)
    .map((row) => ({ ...row }));

/** Each copy's page and the agent of the job it was saved for. */
const copies = () =>
  record.db
    .prepare(
      "SELECT c.page_in_file AS page, j.agent_id AS agent FROM page_copies c JOIN jobs j ON j.id = c.job_id ORDER BY c.page_in_file",
    )
    .all()
    .map((row) => ({ ...row }));

it("ends the job of a reader whose start is held, not_started: the report isn't Reading for ever, and has Retry", async () => {
  // Signed out: the provider takes no turn, and the reader's start is held.
  const fake = fakeProvider({ id: "codex", script: { signedIn: false } });
  const rufi = await start(fake);
  try {
    await rufi.reader("r-1");
    await vi.waitFor(() => {
      expect(jobs()).toEqual([
        {
          agent_id: "r-1",
          state: "ended",
          ended_why: "not_started",
          targets: "[1,2]",
        },
      ]);
    });
    expect(await shown()).toEqual({
      status: "not_read",
      ended: "not_started",
      canRetry: true,
    });
  } finally {
    await rufi.close();
  }
});

it("shows the report as Reading each time one reader is given it, and done after each save", async () => {
  const fake = fakeProvider({ id: "codex", script: { turn: "runs" } });
  const rufi = await start(fake);
  try {
    const reader = await rufi.reader("r-1");
    expect((await shown()).status).toBe("reading");
    await rufi.saves(reader, [1, 2]);
    expect((await shown()).status).toBe("done");
    await rufi.ends(reader);

    // The same reader, given the report again.
    await rufi.as(rufi.root).send(
      {
        to: reader,
        text: "Read it again.",
        documents: [{ id: REPORT }],
      },
      "again",
    );
    expect((await shown()).status).toBe("reading");
    await rufi.saves(reader, [1, 2]);
    expect(jobs().map((job) => job["state"])).toEqual(["done", "done"]);
    expect((await shown()).status).toBe("done");
  } finally {
    await rufi.close();
  }
});

it("keeps two hand-offs of one report apart: each save counts for its own reader's job, Reading until both are saved", async () => {
  const fake = fakeProvider({ id: "codex", script: { turn: "runs" } });
  const rufi = await start(fake);
  try {
    const first = await rufi.reader("r-1", [1]);
    const second = await rufi.reader("r-2", [2]);
    await rufi.saves(second, [2]);
    expect((await shown()).status).toBe("reading");
    await rufi.saves(first, [1]);
    expect(jobs().map(({ agent_id, state }) => [agent_id, state])).toEqual([
      ["r-1", "done"],
      ["r-2", "done"],
    ]);
    expect(copies()).toEqual([
      { page: 1, agent: "r-1" },
      { page: 2, agent: "r-2" },
    ]);
    expect((await shown()).status).toBe("done");
  } finally {
    await rufi.close();
  }
});

it("counts a reader's helper's save for the reader's job: Reading after the reader's part, done after the helper's", async () => {
  const fake = fakeProvider({ id: "codex", script: { turn: "runs" } });
  const rufi = await start(fake);
  try {
    const reader = await rufi.reader("r-1");
    // The reader hands page 2 to a helper of its own, with the document.
    const helper = await rufi.reader("h-1", [2], reader);
    await rufi.saves(reader, [1]);
    expect((await shown()).status).toBe("reading");
    await rufi.saves(helper, [2]);
    expect(jobs()).toEqual([
      { agent_id: "r-1", state: "done", ended_why: null, targets: "[1,2]" },
    ]);
    expect((await shown()).status).toBe("done");
  } finally {
    await rufi.close();
  }
});

it("ends a reader's job no_save once it and its helper have stopped with a page unsaved, its saved page kept", async () => {
  const fake = fakeProvider({ id: "codex", script: { turn: "runs" } });
  const rufi = await start(fake);
  try {
    const reader = await rufi.reader("r-1");
    const helper = await rufi.reader("h-1", [2], reader);
    await rufi.saves(reader, [1]);
    // The reader's turn ends while its helper works: still Reading.
    await rufi.ends(reader);
    expect((await shown()).status).toBe("reading");
    // The helper ends without saving, and its result wakes the reader,
    // which ends without saving too.
    await rufi.ends(helper);
    await rufi.ends(reader);
    await vi.waitFor(() => {
      expect(jobs()).toEqual([
        {
          agent_id: "r-1",
          state: "ended",
          ended_why: "no_save",
          targets: "[1,2]",
        },
      ]);
    });
    // Page 1 was read; page 2 wasn't looked at, and Retry reads it.
    expect(await shown()).toEqual({
      status: "done",
      ended: "no_save",
      canRetry: true,
    });
  } finally {
    await rufi.close();
  }
});
