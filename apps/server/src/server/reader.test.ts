// The document reader at work, on a real database and real files, with a
// scripted reader sub-agent (tests/fake-reader.ts) and the real jobs, page
// copies, page service, sorting requests and chat transcript: the reader's
// model and effort, a reading from its start line to its end line and its
// request that Rufi AI sort it, a restart in the middle, failures,
// automatic retries and Retry, and an account problem.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { ChatGptError } from "../agent/chatgpt/openai.ts";
import { codexBinary } from "../agent/codex/binary.ts";
import { subAgentRunner } from "../agent/codex/subagent.ts";
import type { RunSubAgent } from "../agent/runtime.ts";
import { fakeModel, type Step } from "../../tests/fake-model.ts";
import {
  readPage,
  scriptedReader,
  type Script,
} from "../../tests/fake-reader.ts";
import {
  transcripts as openTranscripts,
  type Transcripts,
} from "../core/chat/transcript.ts";
import { copies } from "../core/documents/copies.ts";
import {
  COPY_INSTRUCTIONS,
  copyReader,
} from "../core/documents/copy-reader.ts";
import { deletions } from "../core/documents/delete.ts";
import { documents, type Documents } from "../core/documents/documents.ts";
import { fileGate } from "../core/documents/gate.ts";
import { pages } from "../core/documents/pages.ts";
import { readings, type Readings } from "../core/documents/reading.ts";
import { sorting } from "../core/documents/sorting.ts";
import {
  databasePath,
  openWritable,
  type Store,
} from "../core/store/database.ts";
import { chatCaller } from "../core/tools/tools.ts";
import { callTool } from "../../tests/mcp-client.ts";
import { mcpEndpoint, mcpKeys, serveMcp } from "./mcp.ts";
import { reader, readerChoice } from "./reader.ts";

const FIXTURES = join(import.meta.dirname, "../../tests/fixtures/documents");
const NOW = "2026-10-10T09:00:00.000Z";

let home: string;
let store: Store;
let transcripts: Transcripts;
let reads: Readings;
let docs: Documents;
let personId: string;
let clock: number;
/** Rufi's MCP servers the readers got, closed after each test. */
let served: { close: () => Promise<void> }[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-reader-"));
  store = openWritable(databasePath(home));
  transcripts = openTranscripts(store, () => NOW);
  const person = await transcripts.addFirstPerson("Asha Fictional");
  personId = person?.id ?? "";
  clock = Date.parse(NOW);
  reads = readings(store, () => new Date(clock).toISOString());
  docs = documents(store, home, () => NOW, reads);
  served = [];
  return async () => {
    await Promise.all(served.map((server) => server.close()));
    store.close();
  };
});

/** Adds the fictional two-page report for a person; returns its document's id. */
async function addReport(person = personId): Promise<string> {
  const bytes = new Uint8Array(
    await readFile(join(FIXTURES, "sunrise-labs-august.pdf")),
  );
  const { added } = await docs.add(
    person,
    [{ name: "sunrise-august.pdf", bytes }],
    true,
  );
  return added[0] ?? "";
}

/** A reader running `scripts`, as the core starts it. */
async function startReader(
  scripts: Script[],
  options: {
    deadlineMs?: number;
    retryWaitsMs?: number[];
    log?: (event: string) => void;
    run?: RunSubAgent;
  } = {},
) {
  const fake = scriptedReader(scripts);
  const keys = mcpKeys();
  let port = 0;
  const server = await serveMcp(
    mcpEndpoint({ keys, port: () => port, log: () => undefined }),
  );
  port = server.port;
  served.push(server);
  const running = reader({
    readings: reads,
    kind: copyReader(
      pages(store, home),
      copies(store, () => NOW),
    ),
    event: async (id, event, write) => {
      const chat = await transcripts.chat(id);
      if (!chat) throw new Error("No chat.");
      await transcripts.addEvent(chat, event, write);
    },
    sort: sorting(store, () => NOW).ask,
    run: options.run ?? fake.run,
    choice: () => readerChoice(transcripts.setting),
    mcp: { url: () => `http://127.0.0.1:${String(port)}/mcp/reader`, keys },
    log: options.log ?? (() => undefined),
    retryWaitsMs: options.retryWaitsMs ?? [0, 0, 0],
    now: () => clock,
    ...(options.deadlineMs !== undefined && {
      deadlineMs: () => options.deadlineMs ?? 0,
    }),
  });
  reads.watch(running.poke);
  running.start();
  return { ...fake, reader: running };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting.");
    await sleep(10);
  }
}

const rows = (sql: string, ...params: (string | number)[]) =>
  store.db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row }));

/** The chat's event lines, in order. */
const lines = () =>
  rows(
    "SELECT text FROM transcript_entries WHERE kind = 'event' ORDER BY seq",
  ).map((r) => r["text"]);
/** Rufi's notes for the AI that wait in the queue. */
const asks = () =>
  rows(
    "SELECT text FROM chat_queue WHERE origin = 'rufi' ORDER BY position",
  ).map((r) => r["text"] as string);
const job = () =>
  rows("SELECT state, attempt, retries, retry_at, error FROM jobs")[0];
const drafts = () =>
  rows(
    "SELECT page, seq, version, status, fields, original, unsure FROM draft_items ORDER BY page, seq",
  );
const pageStates = () =>
  rows("SELECT position, state FROM document_pages ORDER BY position");
/** The requests that Rufi AI sort a reading. */
const requests = () =>
  rows(
    "SELECT r.job_id, r.state, q.text FROM sort_requests r LEFT JOIN chat_queue q ON q.id = r.queue_id ORDER BY r.created_at",
  );
/** The pages copied, by page in the file. */
const copied = () =>
  rows(
    "SELECT page_in_file FROM page_copies ORDER BY page_in_file, job_id",
  ).map((r) => r["page_in_file"]);
const SORTING = "Read sunrise-august.pdf · 2 pages. Rufi AI is sorting it.";
/** Rufi's note that asks Rufi AI to sort the report. */
const sortNote = (id: string, copies = 2, more: string[] = []) =>
  [
    `A document reading finished: sunrise-august.pdf (document ${id}), ${String(copies)} ${copies === 1 ? "page" : "pages"} copied by the reader, not sorted yet.`,
    ...more,
    "Sort it now, as the sorting-documents skill says: read its page copies with get_documents, then split it into documents and write its drafts with one sort_documents call. Save nothing. Then tell the user in a few lines what you found and that nothing is saved; if you can't tell something, ask instead.",
  ].join("\n");
const done = () => job()?.["state"] === "done";

describe("the reader's model and effort", () => {
  it("a run takes those chosen in Settings as it starts, and records them; a model the runner doesn't run is the default", async () => {
    await transcripts.saveSetting("reader_effort", "high");
    await transcripts.saveSetting("reader_model", "gpt-6-astra");
    const { runs, reader: running } = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        await turn.look(2);
        await turn.save(2, readPage());
        return undefined;
      },
    ]);
    await addReport();
    await until(done);
    expect(runs.map(({ model, effort }) => ({ model, effort }))).toEqual([
      { model: "gpt-6.1-sol", effort: "high" },
    ]);
    expect(
      JSON.parse(String(rows("SELECT reader FROM jobs")[0]?.["reader"])),
    ).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
    await running.close();
  });
});

describe("a reading", () => {
  it("writes a start line, then page states, an end line and a request that Rufi AI sort it, in one go, deciding nothing", async () => {
    let midway: unknown;
    const { runs, reader: running } = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        midway = await reads.strip(personId);
        await turn.look(2);
        await turn.save(2, readPage());
        return undefined;
      },
    ]);
    const id = await addReport();
    await until(done);

    expect(midway).toEqual([
      {
        documentId: id,
        name: "sunrise-august.pdf",
        state: "running",
        again: false,
        saved: 1,
        of: 2,
        runAt: NOW,
      },
    ]);
    expect(runs.map((r) => r.instructions)).toEqual([COPY_INSTRUCTIONS]);
    expect(runs[0]?.input).toBe(
      "Copy this document: 2 pages (sunrise-august.pdf).\nSave these pages: 1–2.",
    );
    expect(lines()).toEqual(["Reading sunrise-august.pdf · 2 pages", SORTING]);
    // The request and its note for the AI, its row in the queue.
    expect(requests()).toEqual([
      {
        job_id: rows("SELECT id FROM jobs")[0]?.["id"],
        state: "open",
        text: sortNote(id),
      },
    ]);
    expect(asks()).toEqual([sortNote(id)]);
    expect(pageStates()).toEqual([
      { position: 1, state: "read" },
      { position: 2, state: "read" },
    ]);
    // The reader decided nothing: no drafts, kind or date.
    expect(drafts()).toEqual([]);
    expect(rows("SELECT kind, date, version FROM documents")).toEqual([
      { kind: null, date: null, version: 1 },
    ]);
    expect(await reads.strip(personId)).toEqual([]);
    expect((await docs.list(personId))[0]).toMatchObject({
      status: "done",
      sorting: { state: "sorting", why: null },
      reading: { saved: 2, of: 2, results: 0, canRetry: false },
    });
    await running.close();
  });

  it("asks for no sort when no page could be read: the line says so, and Retry reads them", async () => {
    const { reader: running } = await startReader([
      async (turn) => {
        for (const page of [1, 2]) {
          await turn.look(page);
          await turn.save(page, {
            outcome: "unreadable",
            copy: "",
            why: "Blurred.",
          });
        }
        return undefined;
      },
    ]);
    await addReport();
    await until(done);
    expect(lines().at(-1)).toBe(
      "Couldn't read sunrise-august.pdf · 2 pages couldn't be read",
    );
    expect(requests()).toEqual([]);
    expect(asks()).toEqual([]);
    expect((await docs.list(personId))[0]).toMatchObject({
      sorting: null,
      reading: { canRetry: true },
    });
    await running.close();
  });

  it("tells the reader nothing of whom the document was added for", async () => {
    store.db.exec(
      `INSERT INTO people (id, display_name) VALUES ('ravi', 'Ravi Fictional');
       INSERT INTO chats (id, person_id, created_at) VALUES ('c-ravi', 'ravi', '${NOW}');`,
    );
    const { runs, reader: running } = await startReader([
      async (turn) => {
        for (const page of [1, 2]) {
          await turn.look(page);
          await turn.save(page, readPage());
        }
        return undefined;
      },
    ]);
    await addReport("ravi");
    await until(done);
    expect(runs[0]?.input).toBe(
      "Copy this document: 2 pages (sunrise-august.pdf).\nSave these pages: 1–2.",
    );
    await running.close();
  });

  it("marks pages the reader never saved as not looked at, and Retry reads only those, for Rufi AI to sort", async () => {
    const { runs, reader: running } = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        return undefined;
      },
      async (turn) => {
        // Page 1 for context only: the retry can't change it.
        await turn.look(1);
        const refused = await turn.save(1, readPage("99"));
        expect(refused.ok).toBe(false);
        await turn.look(2);
        await turn.save(2, readPage());
        return undefined;
      },
    ]);
    const id = await addReport();
    await until(done);
    expect(lines().at(-1)).toBe(
      "Read sunrise-august.pdf · 2 pages · 1 page not looked at. Rufi AI is sorting it.",
    );
    expect(asks()).toEqual([
      sortNote(id, 1, ["The reader didn't look at pages 2; Retry reads them."]),
    ]);
    expect(pageStates()).toEqual([
      { position: 1, state: "read" },
      { position: 2, state: "not_looked_at" },
    ]);

    expect(await reads.retry(personId, id)).toEqual([2]);
    await until(
      () => rows("SELECT state FROM jobs WHERE state = 'done'").length === 2,
    );
    expect(runs[1]?.input).toContain("Save these pages: 2.");
    expect(lines().slice(-2)).toEqual([
      "Reading sunrise-august.pdf again · page 2",
      "Read sunrise-august.pdf again · page 2. Rufi AI is sorting it.",
    ]);
    // The newer request takes the place of the one that waited.
    expect(requests().map((r) => r["state"])).toEqual(["void", "open"]);
    expect(copied()).toEqual([1, 2]);
    expect(pageStates()).toEqual([
      { position: 1, state: "read" },
      { position: 2, state: "read" },
    ]);
    await expect(reads.retry(personId, id)).rejects.toThrow(
      "Every page of this document was read",
    );
    await running.close();
  });
});

describe("a restart or a failure", () => {
  it("stops a reader that used its refusal allowance, keeps why, and asks for no sort", async () => {
    await transcripts.saveSetting("reader_model", "gpt-5.5");
    let attempts = 0;
    const late: number[] = [];
    const bad: Step = {
      call: {
        namespace: "mcp__rufi",
        name: "save_page",
        arguments: { page: 1, ...readPage() },
      },
    };
    const { reader: running } = await startReader([], {
      // One automatic retry is enough to see each attempt stopped.
      retryWaitsMs: [0],
      run: async (task, signal) => {
        attempts++;
        const model = await fakeModel({
          script: [
            {
              call: {
                namespace: "mcp__rufi",
                name: "get_page",
                arguments: { page: 2 },
              },
            },
            {
              call: {
                namespace: "mcp__rufi",
                name: "save_page",
                arguments: { page: 2, ...readPage() },
              },
            },
            ...Array.from({ length: 10 }, () => bad),
            {
              call: {
                namespace: "mcp__rufi",
                name: "get_page",
                arguments: { page: 1 },
              },
            },
            {
              call: {
                namespace: "mcp__rufi",
                name: "save_page",
                arguments: { page: 1, ...readPage() },
              },
            },
            { text: "Done." },
          ],
        });
        try {
          const outcome = await subAgentRunner({
            home,
            command: {
              file: await codexBinary(),
              args: [
                "-c",
                `model_providers.openai_chatgpt_plan.base_url="${model.url}"`,
              ],
            },
            env: { PATH: process.env["PATH"] ?? "" },
            token: () => Promise.resolve("not-a-real-token"),
            version: "0.0.0",
          })(task, signal);
          // Before returning to the owner: Stop must have revoked the key
          // already, including while the runner is unwinding.
          const refused = await callTool(
            {
              url: task.tools.url,
              http_headers: { Authorization: `Bearer ${task.tools.key}` },
            },
            {
              name: "save_page",
              arguments: { page: 2, ...readPage() },
              callId: "call-late",
              threadId: "ended",
              turnId: "ended",
            },
          );
          late.push(refused.status);
          return outcome;
        } finally {
          await model.close();
        }
      },
    });
    try {
      await addReport();
      await until(
        () => ["done", "failed"].includes(String(job()?.["state"])),
        30_000,
      );
      expect(job()).toMatchObject({
        state: "failed",
        error: "The AI kept making requests Rufi couldn't accept.",
      });
      expect(attempts).toBe(2);
      expect(late).toEqual([401, 401]);
      expect(requests()).toEqual([]);
      expect(rows("SELECT page_in_file, copy FROM page_copies")).toEqual([
        { page_in_file: 2, copy: readPage().copy },
      ]);
    } finally {
      await running.close();
    }
  }, 60_000);
  it("Retry reads a document never read (from before Rufi read each one as it came) in full", async () => {
    const id = await addReport();
    store.db.exec("DELETE FROM jobs");
    expect((await docs.list(personId))[0]?.status).toBe("not_read");
    expect(await reads.retry(personId, id)).toEqual([1, 2]);
    expect(rows("SELECT state, targets FROM jobs")).toEqual([
      { state: "queued", targets: "[1,2]" },
    ]);
  });

  it("continues after a restart from its copies: no second start line, one request to sort", async () => {
    const first = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        // Rufi stops here, before page 2.
        await turn.stopped();
        return { end: { status: "interrupted", reason: "stopped" } };
      },
    ]);
    await addReport();
    await until(() => copied().length === 1);
    await first.reader.close();
    expect(job()?.["state"]).toBe("running");

    expect(await reads.recover()).toBe(1);
    expect(await reads.strip(personId)).toMatchObject([
      { state: "waiting", again: true, saved: 1, of: 2 },
    ]);
    const second = await startReader([
      async (turn) => {
        await turn.look(2);
        await turn.save(2, readPage());
        return undefined;
      },
    ]);
    await until(done);
    expect(second.runs[0]?.input).toContain(
      "You saved pages 1 in an earlier run",
    );
    expect(lines()).toEqual(["Reading sunrise-august.pdf · 2 pages", SORTING]);
    expect(copied()).toEqual([1, 2]);
    expect(requests()).toHaveLength(1);
    await second.reader.close();
  });

  it("finishes without a reader when every page was saved before a crash", async () => {
    const first = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        await turn.look(2);
        await turn.save(2, readPage());
        await turn.stopped();
        return { end: { status: "interrupted", reason: "stopped" } };
      },
    ]);
    await addReport();
    await until(() => copied().length === 2);
    await first.reader.close();
    await reads.recover();

    const second = await startReader([]);
    await until(done);
    expect(second.runs).toEqual([]);
    expect(lines()).toEqual(["Reading sunrise-august.pdf · 2 pages", SORTING]);
    expect(requests()).toHaveLength(1);
    await second.reader.close();
  });

  it("copies again, the new way, the pages an older reader saved as entries in a reading it left unfinished, each copy taking its entry's place", async () => {
    const id = await addReport();
    // An older reader's unfinished reading: page 1 in its notebook.
    store.db.exec(`
      UPDATE jobs SET state = 'running', attempt = 1, started_at = '${NOW}';
      UPDATE document_pages SET entry = '{"outcome":"read","items":[]}', entry_job_id = (SELECT id FROM jobs), entry_attempt = 1, entry_at = '${NOW}'
        WHERE position = 1;
    `);
    await reads.recover();
    const { runs, reader: running } = await startReader([
      async (turn) => {
        for (const page of [1, 2]) {
          await turn.look(page);
          await turn.save(page, readPage());
        }
        return undefined;
      },
    ]);
    await until(done);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.input).not.toContain("earlier run");
    expect(copied()).toEqual([1, 2]);
    expect(requests()).toEqual([
      expect.objectContaining({ state: "open", text: sortNote(id) }),
    ]);
    expect(
      rows("SELECT entry FROM document_pages ORDER BY position").map(
        (r) => r["entry"],
      ),
    ).toEqual([null, null]);
    await running.close();
  });

  it("does not finish from failed copies after the retry is interrupted and Rufi restarts", async () => {
    const first = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        await turn.look(2);
        await turn.save(2, readPage());
        return { end: { status: "failed", reason: "connection" } };
      },
      async (turn) => {
        await turn.stopped();
        return { end: { status: "interrupted", reason: "stopped" } };
      },
    ]);
    try {
      await addReport();
      await until(() => first.runs.length === 2 || done());
      expect(first.runs).toHaveLength(2);
      expect(requests()).toEqual([]);
    } finally {
      await first.reader.close();
    }
    await reads.recover();
    const completed = Promise.withResolvers<undefined>();
    const second = await startReader([() => completed.promise]);
    try {
      await until(() => second.runs.length === 1 || done());
      expect(second.runs).toHaveLength(1);
      expect(requests()).toEqual([]);
      expect(lines()).toEqual(["Reading sunrise-august.pdf · 2 pages"]);
      completed.resolve(undefined);
      await until(done);
      expect(requests()).toHaveLength(1);
      expect(lines()).toEqual(["Reading sunrise-august.pdf · 2 pages", SORTING]);
    } finally {
      completed.resolve(undefined);
      await second.reader.close();
    }
  });

  it("a deadline fails the reading with its copies kept and no sort; Retry continues it", async () => {
    const { runs, reader: running } = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        return {
          end: { status: "failed", reason: "timeout", text: "Too long." },
        };
      },
      async (turn) => {
        await turn.look(2);
        await turn.save(2, readPage());
        return undefined;
      },
    ]);
    const id = await addReport();
    await until(() => job()?.["state"] === "failed");
    expect(lines().at(-1)).toBe(
      "Couldn't finish reading sunrise-august.pdf · the reading took too long · read 1 of 2",
    );
    expect(requests()).toEqual([]);
    expect(asks()).toEqual([]);
    expect((await docs.list(personId))[0]).toMatchObject({
      status: "failed",
      reading: { saved: 1, of: 2, canRetry: true },
    });

    expect(await reads.retry(personId, id)).toEqual([1, 2]);
    await until(done);
    expect(runs[1]?.input).toContain("You saved pages 1 in an earlier run");
    expect(lines().at(-1)).toBe(SORTING);
    expect(copied()).toEqual([1, 2]);
    await running.close();
  });

  it("refuses a call with an earlier attempt's key once that run has ended", async () => {
    let refused: unknown;
    const { runs, reader: running } = await startReader([
      () =>
        Promise.resolve({
          end: { status: "failed", reason: "connection" },
        }),
      async (turn) => {
        const first = runs[0]?.tools;
        refused = await callTool(
          {
            url: first?.url ?? "",
            http_headers: { Authorization: `Bearer ${first?.key ?? ""}` },
          },
          {
            name: "save_page",
            arguments: { page: 1, ...readPage() },
            callId: "call-old",
            threadId: "old",
            turnId: "old",
          },
        );
        await turn.look(1);
        await turn.save(1, readPage());
        await turn.look(2);
        await turn.save(2, readPage());
        return undefined;
      },
    ]);
    await addReport();
    await until(done);
    expect(runs[1]?.tools.key).not.toBe(runs[0]?.tools.key);
    expect(refused).toEqual({ status: 401 });
    expect(copied()).toEqual([1, 2]);
    expect(requests()).toHaveLength(1);
    await running.close();
  });

  it.each(["timeout", "connection"] as const)(
    "keeps all copies without a sort after a %s failure; Retry needs a completed turn",
    async (reason) => {
      const failure: Script = () =>
        Promise.resolve({
          end: { status: "failed", reason },
        });
      const { runs, reader: running } = await startReader([
        async (turn) => {
          await turn.look(1);
          await turn.save(1, readPage());
          await turn.look(2);
          await turn.save(2, readPage());
          return failure(turn);
        },
        // A passing reason: tried again three times by itself.
        ...(reason === "connection" ? [failure, failure, failure] : []),
        () => Promise.resolve(undefined),
      ]);
      try {
        const id = await addReport();
        await until(() =>
          ["failed", "done"].includes(String(job()?.["state"])),
        );
        expect(job()?.["state"]).toBe("failed");
        expect(runs).toHaveLength(reason === "connection" ? 4 : 1);
        expect(
          (await reads.view(personId, id))?.pages.map((p) => p.copy),
        ).toEqual([null, null]);
        expect(copied()).toEqual([1, 2]);
        expect(requests()).toEqual([]);
        expect(lines().at(-1)).toContain("Couldn't finish reading");
        expect(asks()).toEqual([]);

        await reads.retry(personId, id);
        await until(done);
        expect(runs).toHaveLength(reason === "connection" ? 5 : 2);
        expect(runs.at(-1)?.input).toContain(
          "You saved pages 1–2 in an earlier run",
        );
        expect(requests()).toHaveLength(1);
        expect(lines().at(-1)).toBe(SORTING);
        expect(
          (await reads.view(personId, id))?.pages.map((p) => p.copy),
        ).toEqual([readPage().copy, readPage().copy]);
      } finally {
        await running.close();
      }
    },
  );

  it("tries again by itself for a passing reason, three times after a longer wait each, also across a restart, then fails visibly with the service's words", async () => {
    const lost = () =>
      Promise.resolve({
        end: {
          status: "failed" as const,
          reason: "connection" as const,
          text: "exceeded retry limit, last status: 429 Too Many Requests",
        },
      });
    const waits = { retryWaitsMs: [30_000, 60_000, 120_000] };
    const first = await startReader([lost], waits);
    await addReport();
    await until(() => job()?.["retries"] === 1);
    await first.reader.close();

    // Rufi closes and starts again before the retry's time.
    store.close();
    store = openWritable(databasePath(home));
    transcripts = openTranscripts(store, () => NOW);
    reads = readings(store, () => new Date(clock).toISOString());
    expect(await reads.recover()).toBe(0);
    const second = await startReader([lost, lost, lost], waits);
    const runs = () => first.runs.length + second.runs.length;
    try {
      for (const [tries, wait] of [
        [1, 30_000],
        [2, 60_000],
        [3, 120_000],
      ] as const) {
        await until(() => job()?.["retries"] === tries);
        expect(job()).toMatchObject({
          state: "queued",
          retry_at: new Date(clock + wait).toISOString(),
        });
        // Before its time, nothing more runs.
        second.reader.poke();
        await sleep(50);
        expect(runs()).toBe(tries);
        clock += wait;
        second.reader.poke();
      }
      await until(() => job()?.["state"] === "failed");
      expect(runs()).toBe(4);
      expect(lines()).toEqual([
        "Reading sunrise-august.pdf · 2 pages",
        "Couldn't finish reading sunrise-august.pdf · exceeded retry limit, last status: 429 Too Many Requests · read 0 of 2",
      ]);
    } finally {
      await second.reader.close();
    }
  });

  it("tries again by itself when ChatGPT can't renew the sign-in just now, from its copies, and finishes", async () => {
    const { runs, reader: running } = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        throw new ChatGptError(
          "temporary",
          "Couldn't reach ChatGPT. Try again shortly.",
        );
      },
      async (turn) => {
        await turn.look(2);
        await turn.save(2, readPage());
        return undefined;
      },
    ]);
    try {
      await addReport();
      await until(done);
      expect(job()).toMatchObject({ retries: 1, error: null });
      expect(runs[1]?.input).toContain("You saved pages 1 in an earlier run");
      expect(copied()).toEqual([1, 2]);
      expect(lines()).toEqual(["Reading sunrise-august.pdf · 2 pages", SORTING]);
    } finally {
      await running.close();
    }
  });

  it("keeps the words of a sign-in ChatGPT can't renew when its tries run out", async () => {
    const renewal = () =>
      Promise.reject(
        new ChatGptError(
          "temporary",
          "Couldn't reach ChatGPT. Try again shortly.",
        ),
      );
    const { reader: running } = await startReader([renewal, renewal], {
      retryWaitsMs: [0],
    });
    try {
      await addReport();
      await until(() => job()?.["state"] === "failed");
      expect(lines().at(-1)).toBe(
        "Couldn't finish reading sunrise-august.pdf · Couldn't reach ChatGPT. Try again shortly. · read 0 of 2",
      );
    } finally {
      await running.close();
    }
  });

  it.each([
    [
      "signed out",
      () =>
        Promise.reject(
          new ChatGptError(
            "not_signed_in",
            "Not signed in. Sign in with ChatGPT: in Rufi, or with pnpm rufi signin.",
          ),
        ),
      "Not signed in. Sign in with ChatGPT: in Rufi, or with pnpm rufi signin.",
    ],
    [
      "a sign-in the service rejects",
      () =>
        Promise.resolve({
          end: {
            status: "failed" as const,
            reason: "sign_in" as const,
            text: "Your access token could not be refreshed.",
          },
        }),
      "Your access token could not be refreshed.",
    ],
    [
      "a usage limit",
      () =>
        Promise.resolve({
          end: {
            status: "failed" as const,
            reason: "usage_limit" as const,
            text: "You've hit your usage limit.",
            resetsAt: "2026-10-10T14:30:00.000Z",
          },
        }),
      "You've hit your usage limit.",
    ],
  ] as const)(
    "%s: the reading fails at once with the reason, keeps its pages, and Retry continues it",
    async (_, problem, why) => {
      const { runs, reader: running } = await startReader([
        async (turn) => {
          await turn.look(1);
          await turn.save(1, readPage());
          return problem();
        },
        async (turn) => {
          await turn.look(2);
          await turn.save(2, readPage());
          return undefined;
        },
      ]);
      try {
        const id = await addReport();
        await until(() => job()?.["state"] === "failed");
        expect(job()).toMatchObject({ retries: 0, error: why });
        expect(runs).toHaveLength(1);
        expect(lines()).toEqual([
          "Reading sunrise-august.pdf · 2 pages",
          `Couldn't finish reading sunrise-august.pdf · ${why} · read 1 of 2`,
        ]);
        expect(requests()).toEqual([]);
        expect(await reads.strip(personId)).toEqual([]);

        await reads.retry(personId, id);
        await until(done);
        expect(runs[1]?.input).toContain("You saved pages 1 in an earlier run");
        expect(copied()).toEqual([1, 2]);
        expect(requests()).toHaveLength(1);
      } finally {
        await running.close();
      }
    },
  );
});

describe("the chat AI and a reading", () => {
  it("sees the copies and what isn't sorted yet, and can read failed pages again only in the person's turn", async () => {
    const { reader: running } = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        await turn.look(2);
        await turn.save(2, { outcome: "unreadable", why: "Blurred.", copy: "" });
        return undefined;
      },
    ]);
    const id = await addReport();
    await until(done);
    expect(lines().at(-1)).toBe(
      "Read sunrise-august.pdf · 2 pages · 1 page couldn't be read. Rufi AI is sorting it.",
    );
    const chat = await transcripts.chat(personId);
    if (!chat) throw new Error("No chat.");
    const caller = chatCaller(
      store,
      transcripts,
      () => undefined,
      pages(store, home),
      (person, document) => reads.retry(person, document),
    );

    const read = await caller(
      chat,
      "turn-1",
      "person",
    )("get_documents", { document: id });
    const answer = JSON.parse(read.text) as { result: Record<string, unknown> };
    expect(answer.result["document"]).toMatchObject({
      status: "done",
      draft_items: 0,
      add: { id, pages: 2, not_sorted: "1–2" },
    });
    expect(answer.result["pages"]).toEqual([
      expect.objectContaining({ page: 1, state: "read", sorted: false }),
      expect.objectContaining({
        page: 2,
        state: "unreadable",
        why: "Blurred.",
        sorted: false,
      }),
    ]);
    const copies = await caller(
      chat,
      "turn-1",
      "person",
    )("get_documents", { document: id, copies: true });
    expect(JSON.parse(copies.text)).toMatchObject({
      ok: true,
      result: {
        add: id,
        copies: [
          { page: 1, document: id, outcome: "read", sorted: false, copy: readPage().copy },
          { page: 2, document: id, outcome: "unreadable", sorted: false, copy: "" },
        ],
      },
    });

    // A turn a Rufi event started can only read.
    const fromEvent = await caller(
      chat,
      "turn-2",
      "rufi",
    )("retry_reading", { document: id });
    expect(fromEvent.ok).toBe(false);
    expect(fromEvent.text).toContain("started by a Rufi event");
    expect(rows("SELECT id FROM jobs")).toHaveLength(1);

    const asked = await caller(
      chat,
      "turn-3",
      "person",
    )("retry_reading", { document: id });
    expect(JSON.parse(asked.text)).toMatchObject({
      ok: true,
      result: { pages: [2] },
    });
    await running.close();
  });
});

describe("a document deleted while it is read", () => {
  it.each([
    { when: "its run is stopped", stop: true },
    { when: "the stop comes after its run ended", stop: false },
  ])(
    "writes nothing more when $when, and a restart doesn't read it",
    async ({ stop }) => {
      const logged: string[] = [];
      let stopped: boolean | undefined;
      let late: unknown;
      let id = "";
      const running: { stopDocument?: (id: string) => void } = {};
      const remover = deletions({
        store,
        home,
        gate: fileGate(),
        event: async (person, event, write) => {
          const chat = await transcripts.chat(person);
          if (!chat) throw new Error("No chat.");
          await transcripts.addEvent(chat, event, write);
        },
        stopReading: (document) => {
          if (stop) running.stopDocument?.(document);
        },
        changed: reads.changed,
        log: () => undefined,
        now: () => NOW,
      });
      const { reader: started } = await startReader(
        [
          async (turn) => {
            await turn.look(1);
            await turn.save(1, readPage());
            const preview = await remover.preview(personId, id);
            await remover.remove(personId, id, preview?.version ?? "");
            stopped = turn.signal?.aborted;
            late = (await turn.save(1, readPage("14.0"))).json;
            return undefined;
          },
        ],
        { log: (event) => logged.push(event) },
      );
      running.stopDocument = started.stopDocument;
      id = await addReport();
      await until(() => late !== undefined);
      await started.close();

      expect(stopped).toBe(stop);
      // Stopped, its key opens nothing: the call never reaches the tool.
      // Otherwise the tool refuses it: the reading is gone.
      expect(late).toMatchObject(
        stop
          ? { ok: false, error: "HTTP 401" }
          : {
              ok: false,
              error:
                "This reading isn't running any more; nothing more is saved.",
            },
      );
      expect(lines()).toEqual([
        "Reading sunrise-august.pdf · 2 pages",
        "Deleted sunrise-august.pdf",
      ]);
      // Only the delete's note: no reading's.
      expect(asks()).toEqual([
        expect.stringContaining(
          `The user deleted document ${id} (sunrise-august.pdf). Nothing saved in the record came from it.`,
        ),
      ]);
      expect(drafts()).toEqual([]);
      expect(rows("SELECT id FROM jobs")).toEqual([]);
      expect(logged).not.toContain("reader.failed");
      expect(await reads.recover()).toBe(0);
      expect((await reads.next()).job).toBeUndefined();
    },
  );
});
