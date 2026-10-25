// The document reader at work, on a real database and real files, with a
// scripted reader sub-agent (tests/fake-reader.ts) and the real jobs, page
// copies and page service: the reader's model and effort, a reading opened
// as a reply that sends its document starts it, its progress and Rufi's note
// for the AI, a restart in the middle, failures, automatic retries, a Stop,
// one reading at a time, an account problem and a delete.
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
import { addSent } from "../../tests/sent.ts";
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
import {
  readings,
  type Job,
  type Readings,
} from "../core/documents/reading.ts";
import {
  databasePath,
  openWritable,
  type Store,
} from "../core/store/database.ts";
import { chatCaller } from "../core/tools/tools.ts";
import { callTool } from "../../tests/mcp-client.ts";
import { mcpEndpoint, mcpKeys, serveMcp } from "./mcp.ts";
import { reader, readerChoice, type ReadProgress } from "./reader.ts";

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

/** Adds and sends a fictional file; returns its document's id. */
async function addFile(
  fixture: string,
  name: string,
  person = personId,
): Promise<string> {
  const bytes = new Uint8Array(await readFile(join(FIXTURES, fixture)));
  const { added } = await addSent(docs, store, person, [{ name, bytes }]);
  return added[0] ?? "";
}

/** Adds and sends the fictional two-page report; returns its document's id. */
const addReport = (person = personId) =>
  addFile("sunrise-labs-august.pdf", "sunrise-august.pdf", person);

/** The document's reading, opened as the reply that sends it starts. */
async function open(id: string, again = false, person = personId) {
  const job = await store.query
    .transaction()
    .execute((trx) => reads.open(trx, person, id, again));
  if (!job) throw new Error("Nothing to read.");
  return job;
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
  /**
   * Reads the job (or opens the document's) until it ends; what it heard
   * of its progress, as the reply's step shows it.
   */
  const read = async (
    what: string | Job,
    signal = new AbortController().signal,
    hear: (now: ReadProgress) => void = () => undefined,
  ) => {
    const job = typeof what === "string" ? await open(what) : what;
    const heard: ReadProgress[] = [];
    const end = await running.read(job, signal, (now) => {
      heard.push(now);
      hear(now);
    });
    return { end, heard, job };
  };
  return { ...fake, reader: running, read };
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
/** The pages copied, by page in the file. */
const copied = () =>
  rows(
    "SELECT page_in_file FROM page_copies ORDER BY page_in_file, job_id",
  ).map((r) => r["page_in_file"]);
const DONE = { ended: "done" };
const readBoth: Script = async (turn) => {
  for (const page of [1, 2]) {
    await turn.look(page);
    await turn.save(page, readPage());
  }
  return undefined;
};

describe("the reader's model and effort", () => {
  it("a run takes those chosen in Settings as it starts, and records them; a model the runner doesn't run is the default", async () => {
    await transcripts.saveSetting("reader_effort", "high");
    await transcripts.saveSetting("reader_model", "gpt-6-astra");
    const { runs, read } = await startReader([readBoth]);
    expect((await read(await addReport())).end).toEqual(DONE);
    expect(runs.map(({ model, effort }) => ({ model, effort }))).toEqual([
      { model: "gpt-6.1-sol", effort: "high" },
    ]);
    expect(
      JSON.parse(String(rows("SELECT reader FROM jobs")[0]?.["reader"])),
    ).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
  });
});

describe("a reading", () => {
  it("copies every page of a document never read, tells how far it is, and decides nothing; Rufi's note asks the AI to sort it", async () => {
    const { runs, read } = await startReader([readBoth]);
    const id = await addReport();
    const { end, heard, job: reading } = await read(id);

    expect(end).toEqual(DONE);
    expect(heard).toEqual([
      { state: "waiting", saved: 0, of: 2 },
      { state: "copying", saved: 0, of: 2 },
      { state: "copying", saved: 1, of: 2 },
      { state: "copying", saved: 2, of: 2 },
    ]);
    expect(runs.map((r) => r.instructions)).toEqual([COPY_INSTRUCTIONS]);
    expect(runs[0]?.input).toBe(
      "Copy this document: 2 pages (sunrise-august.pdf).\nSave these pages: 1–2.",
    );
    expect(pageStates()).toEqual([
      { position: 1, state: "read" },
      { position: 2, state: "read" },
    ]);
    // The reader decided nothing: no drafts, kind or date.
    expect(drafts()).toEqual([]);
    expect(rows("SELECT kind, date, version FROM documents")).toEqual([
      { kind: null, date: null, version: 1 },
    ]);
    expect((await docs.list(personId))[0]).toMatchObject({
      status: "done",
      notSorted: true,
      reading: { saved: 2, of: 2, results: 0, canRetry: false },
    });
    expect(await reads.note([reading.id])).toContain(
      "Not sorted yet: sort it as the sorting-documents skill says",
    );
    // Read in full, a send doesn't read it again.
    expect(await reads.needs(personId, id, false)).toBe(false);
    expect(await reads.needs(personId, id, true)).toBe(false);
  });

  it("leaves nothing to sort when no page could be read; reading again reads them", async () => {
    const unreadable: Script = async (turn) => {
      for (const page of [1, 2]) {
        await turn.look(page);
        await turn.save(page, {
          outcome: "unreadable",
          copy: "",
          why: "Blurred.",
        });
      }
      return undefined;
    };
    const { runs, read } = await startReader([unreadable, readBoth]);
    const id = await addReport();
    const { job: first } = await read(id);
    expect(await reads.note([first.id])).toContain("Nothing in it to sort");
    expect((await docs.list(personId))[0]).toMatchObject({
      notSorted: false,
      reading: { canRetry: true },
    });

    // A plain send doesn't read it again; a read-again chip does.
    expect(await reads.needs(personId, id, false)).toBe(false);
    expect((await read(await open(id, true))).end).toEqual(DONE);
    expect(runs[1]?.input).toContain("Save these pages: 1–2.");
    expect(pageStates()).toEqual([
      { position: 1, state: "read" },
      { position: 2, state: "read" },
    ]);
  });

  it("tells the reader nothing of whom the document was added for", async () => {
    store.db.exec(
      `INSERT INTO people (id, display_name) VALUES ('ravi', 'Ravi Fictional');
       INSERT INTO chats (id, person_id, created_at) VALUES ('c-ravi', 'ravi', '${NOW}');`,
    );
    const { runs, read } = await startReader([readBoth]);
    await read(await open(await addReport("ravi"), false, "ravi"));
    expect(runs[0]?.input).toBe(
      "Copy this document: 2 pages (sunrise-august.pdf).\nSave these pages: 1–2.",
    );
  });

  it("marks pages the reader never saved as not looked at, and reading again reads only those", async () => {
    const { runs, read } = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        return undefined;
      },
      async (turn) => {
        // Page 1 for context only: the read-again can't change it.
        await turn.look(1);
        const refused = await turn.save(1, readPage("99"));
        expect(refused.ok).toBe(false);
        await turn.look(2);
        await turn.save(2, readPage());
        return undefined;
      },
    ]);
    const id = await addReport();
    const { job: first } = await read(id);
    expect(await reads.note([first.id])).toContain(
      "It didn't look at pages 2.",
    );
    expect(pageStates()).toEqual([
      { position: 1, state: "read" },
      { position: 2, state: "not_looked_at" },
    ]);

    const again = await open(id, true);
    expect(again.targets).toEqual([2]);
    expect((await read(again)).end).toEqual(DONE);
    expect(runs[1]?.input).toContain("Save these pages: 2.");
    expect(copied()).toEqual([1, 2]);
    expect(pageStates()).toEqual([
      { position: 1, state: "read" },
      { position: 2, state: "read" },
    ]);
    expect(await reads.needs(personId, id, true)).toBe(false);
  });
});

describe("a Stop, one reading at a time", () => {
  it("a Stop ends the run at once: its key opens nothing more, and the job is left for its reply to fail with its copies kept", async () => {
    const stop = new AbortController();
    let late: unknown;
    const { read } = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        stop.abort();
        await turn.stopped();
        late = (await turn.save(2, readPage())).json;
        return { end: { status: "interrupted", reason: "stopped" } };
      },
    ]);
    const { end, job: reading } = await read(await addReport(), stop.signal);
    expect(end).toEqual({ ended: "stopped" });
    expect(late).toMatchObject({ ok: false, error: "HTTP 401" });
    expect(job()?.["state"]).toBe("running");
    await store.query
      .transaction()
      .execute((trx) => reads.failOpen(trx, [reading.id], "Stopped"));
    expect(job()).toMatchObject({ state: "failed", error: "Stopped" });
    expect(copied()).toEqual([1]);
  });

  it("reads one document at a time: the next waits, and a Stop while it waits ends it without a run", async () => {
    const first = Promise.withResolvers<undefined>();
    let overlapping = false;
    let active = 0;
    const once =
      (wait?: Promise<undefined>): Script =>
      async (turn) => {
        if (++active > 1) overlapping = true;
        await wait;
        await turn.look(1);
        await turn.save(1, readPage());
        active--;
        return undefined;
      };
    const { runs, read } = await startReader([once(first.promise), once()]);
    const a = await addFile("thyroid-recheck.jpg", "thyroid.jpg");
    const b = await addFile("thyroid-recheck-version-1.jpg", "thyroid-1.jpg");
    const c = await addReport();
    const reading = read(a);
    await until(() => runs.length === 1);

    const later = read(b);
    const stop = new AbortController();
    const stopped = read(c, stop.signal);
    await sleep(50);
    expect(runs).toHaveLength(1);
    stop.abort();
    expect((await stopped).end).toEqual({ ended: "stopped" });

    first.resolve(undefined);
    expect((await reading).end).toEqual(DONE);
    expect((await later).end).toEqual(DONE);
    expect(runs).toHaveLength(2);
    expect(overlapping).toBe(false);
  });
});

describe("a restart or a failure", () => {
  it("stops a reader that used its refusal allowance and keeps why", async () => {
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
    const { read } = await startReader([], {
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
          // Before returning to the owner: the stop must have revoked the
          // key already, including while the runner is unwinding.
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
    const why = "The AI kept making requests Rufi couldn't accept.";
    expect((await read(await addReport())).end).toEqual({
      ended: "failed",
      why,
    });
    expect(job()).toMatchObject({ state: "failed", error: why });
    expect(attempts).toBe(2);
    expect(late).toEqual([401, 401]);
    expect(rows("SELECT page_in_file, copy FROM page_copies")).toEqual([
      { page_in_file: 2, copy: readPage().copy },
    ]);
  }, 60_000);

  it("fails a reading Rufi closed in the middle at the next start; sending it again goes on from its copies", async () => {
    const first = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        // Rufi closes here, before page 2.
        await turn.stopped();
        return { end: { status: "interrupted", reason: "stopped" } };
      },
    ]);
    const id = await addReport();
    const reading = first.read(id);
    await until(() => copied().length === 1);
    first.reader.close();
    expect((await reading).end).toEqual({ ended: "stopped" });
    expect(job()?.["state"]).toBe("running");

    expect(await reads.recover()).toBe(1);
    expect(job()).toMatchObject({
      state: "failed",
      error: "Rufi closed while reading",
    });
    const second = await startReader([
      async (turn) => {
        await turn.look(2);
        await turn.save(2, readPage());
        return undefined;
      },
    ]);
    expect((await second.read(id)).end).toEqual(DONE);
    expect(second.runs[0]?.input).toContain(
      "You saved pages 1 in an earlier run",
    );
    expect(copied()).toEqual([1, 2]);
  });

  it("copies again, the new way, the pages an older reader saved as entries in a reading it left unfinished, each copy taking its entry's place", async () => {
    const id = await addReport();
    await open(id);
    // An older reader's unfinished reading: page 1 in its notebook.
    store.db.exec(`
      UPDATE jobs SET state = 'running', attempt = 1, started_at = '${NOW}';
      UPDATE document_pages SET entry = '{"outcome":"read","items":[]}', entry_job_id = (SELECT id FROM jobs), entry_attempt = 1, entry_at = '${NOW}'
        WHERE position = 1;
    `);
    await reads.recover();
    const { runs, read } = await startReader([readBoth]);
    expect((await read(id)).end).toEqual(DONE);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.input).not.toContain("earlier run");
    expect(copied()).toEqual([1, 2]);
    expect(
      rows("SELECT entry FROM document_pages ORDER BY position").map(
        (r) => r["entry"],
      ),
    ).toEqual([null, null]);
  });

  it("does not finish from failed copies after the retry is interrupted and Rufi restarts", async () => {
    const first = await startReader([
      async (turn) => {
        await readBoth(turn);
        return { end: { status: "failed", reason: "connection" } };
      },
      async (turn) => {
        await turn.stopped();
        return { end: { status: "interrupted", reason: "stopped" } };
      },
    ]);
    const id = await addReport();
    const reading = first.read(id);
    await until(() => first.runs.length === 2);
    first.reader.close();
    expect((await reading).end).toEqual({ ended: "stopped" });
    await reads.recover();

    const completed = Promise.withResolvers<undefined>();
    const second = await startReader([() => completed.promise]);
    const again = second.read(id);
    await until(() => second.runs.length === 1);
    expect(job()?.["state"]).toBe("running");
    completed.resolve(undefined);
    expect((await again).end).toEqual(DONE);
  });

  it("a deadline fails the reading with its copies kept; sending it again goes on", async () => {
    const { runs, read } = await startReader([
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
    expect((await read(id)).end).toEqual({
      ended: "failed",
      why: "the reading took too long",
    });
    expect((await docs.list(personId))[0]).toMatchObject({
      status: "failed",
      reading: { saved: 1, of: 2, canRetry: true },
    });
    expect(await reads.needs(personId, id, false)).toBe(true);

    expect((await read(id)).end).toEqual(DONE);
    expect(runs[1]?.input).toContain("You saved pages 1 in an earlier run");
    expect(copied()).toEqual([1, 2]);
  });

  it("refuses a call with an earlier attempt's key once that run has ended", async () => {
    let refused: unknown;
    const { runs, read } = await startReader([
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
        return readBoth(turn);
      },
    ]);
    expect((await read(await addReport())).end).toEqual(DONE);
    expect(runs[1]?.tools.key).not.toBe(runs[0]?.tools.key);
    expect(refused).toEqual({ status: 401 });
    expect(copied()).toEqual([1, 2]);
  });

  it.each(["timeout", "connection"] as const)(
    "keeps all copies after a %s failure; sending it again needs a completed turn",
    async (reason) => {
      const failure: Script = () =>
        Promise.resolve({
          end: { status: "failed", reason },
        });
      const { runs, read } = await startReader([
        async (turn) => {
          await readBoth(turn);
          return failure(turn);
        },
        // A passing reason: tried again three times by itself.
        ...(reason === "connection" ? [failure, failure, failure] : []),
        () => Promise.resolve(undefined),
      ]);
      const id = await addReport();
      expect((await read(id)).end).toMatchObject({ ended: "failed" });
      expect(runs).toHaveLength(reason === "connection" ? 4 : 1);
      expect(
        (await reads.view(personId, id))?.pages.map((p) => p.copy),
      ).toEqual([null, null]);
      expect(copied()).toEqual([1, 2]);

      expect((await read(id)).end).toEqual(DONE);
      expect(runs).toHaveLength(reason === "connection" ? 5 : 2);
      expect(runs.at(-1)?.input).toContain(
        "You saved pages 1–2 in an earlier run",
      );
      expect(
        (await reads.view(personId, id))?.pages.map((p) => p.copy),
      ).toEqual([readPage().copy, readPage().copy]);
    },
  );

  it("tries again by itself for a passing reason, three times after a longer wait each, then fails with the service's words", async () => {
    const lost = () =>
      Promise.resolve({
        end: {
          status: "failed" as const,
          reason: "connection" as const,
          text: "exceeded retry limit, last status: 429 Too Many Requests",
        },
      });
    const { runs, read } = await startReader([lost, lost, lost, lost], {
      retryWaitsMs: [30, 60, 120],
    });
    const waits: unknown[] = [];
    const { end, heard } = await read(await addReport(), undefined, (now) => {
      if (now.state === "again") waits.push(job()?.["retry_at"]);
    });
    expect(waits).toEqual(
      [30, 60, 120].map((ms) => new Date(clock + ms).toISOString()),
    );
    expect(heard.filter((h) => h.state === "again")).toHaveLength(3);
    expect(runs).toHaveLength(4);
    expect(end).toEqual({
      ended: "failed",
      why: "exceeded retry limit, last status: 429 Too Many Requests",
    });
    expect(job()).toMatchObject({ state: "failed", retries: 3 });
  });

  it("a Stop during the wait before a retry ends it at once; a restart then fails the reading that waited", async () => {
    const lost = () =>
      Promise.resolve({
        end: { status: "failed" as const, reason: "connection" as const },
      });
    const { runs, read } = await startReader([lost, lost], {
      retryWaitsMs: [60_000],
    });
    const stop = new AbortController();
    const { end } = await read(await addReport(), stop.signal, (now) => {
      if (now.state === "again") stop.abort();
    });
    expect(end).toEqual({ ended: "stopped" });
    expect(runs).toHaveLength(1);
    // Rufi closed then: its next start fails the reading that waited.
    expect(job()).toMatchObject({ state: "queued" });
    expect(await reads.recover()).toBe(1);
    expect(job()).toMatchObject({ state: "failed", retry_at: null });
  });

  it("tries again by itself when ChatGPT can't renew the sign-in just now, from its copies, and finishes", async () => {
    const { runs, read } = await startReader([
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
    expect((await read(await addReport())).end).toEqual(DONE);
    expect(job()).toMatchObject({ retries: 1, error: null });
    expect(runs[1]?.input).toContain("You saved pages 1 in an earlier run");
    expect(copied()).toEqual([1, 2]);
  });

  it("keeps the words of a sign-in ChatGPT can't renew when its tries run out", async () => {
    const renewal = () =>
      Promise.reject(
        new ChatGptError(
          "temporary",
          "Couldn't reach ChatGPT. Try again shortly.",
        ),
      );
    const { read } = await startReader([renewal, renewal], {
      retryWaitsMs: [0],
    });
    expect((await read(await addReport())).end).toEqual({
      ended: "failed",
      why: "Couldn't reach ChatGPT. Try again shortly.",
    });
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
    "%s: the reading fails at once with the reason and keeps its pages; sending it again goes on",
    async (_, problem, why) => {
      const { runs, read } = await startReader([
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
      const id = await addReport();
      expect((await read(id)).end).toEqual({ ended: "failed", why });
      expect(job()).toMatchObject({ retries: 0, error: why });
      expect(runs).toHaveLength(1);

      expect((await read(id)).end).toEqual(DONE);
      expect(runs[1]?.input).toContain("You saved pages 1 in an earlier run");
      expect(copied()).toEqual([1, 2]);
    },
  );
});

describe("the chat AI and a reading", () => {
  it("sees the copies and what isn't sorted yet", async () => {
    const { read } = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        await turn.look(2);
        await turn.save(2, {
          outcome: "unreadable",
          why: "Blurred.",
          copy: "",
        });
        return undefined;
      },
    ]);
    const id = await addReport();
    await read(id);
    const chat = await transcripts.chat(personId);
    if (!chat) throw new Error("No chat.");
    const caller = chatCaller(
      store,
      transcripts,
      () => undefined,
      pages(store, home),
    );

    const got = await caller(
      chat,
      "turn-1",
      "person",
    )("get_documents", { document: id });
    const answer = JSON.parse(got.text) as { result: Record<string, unknown> };
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
          {
            page: 1,
            document: id,
            outcome: "read",
            sorted: false,
            copy: readPage().copy,
          },
          {
            page: 2,
            document: id,
            outcome: "unreadable",
            sorted: false,
            copy: "",
          },
        ],
      },
    });
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
      const { reader: started, read } = await startReader(
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
      expect((await read(id)).end).toEqual({ ended: "deleted" });

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
      expect(lines()).toEqual(["Deleted sunrise-august.pdf"]);
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
    },
  );
});
