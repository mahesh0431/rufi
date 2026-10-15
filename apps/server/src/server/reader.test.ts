// The document reader at work, on a real database and real files, with a
// scripted reader sub-agent (tests/fake-reader.ts) and the real jobs,
// notebook, page service and chat transcript: the reader's model and
// effort, a reading from its start line to its drafts and end line, a
// restart in the middle, failures and Retry, and waiting for the sign-in or
// a usage limit.
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
import { deletions } from "../core/documents/delete.ts";
import { documents, type Documents } from "../core/documents/documents.ts";
import { fileGate } from "../core/documents/gate.ts";
import { notebook } from "../core/documents/notebook.ts";
import { pages } from "../core/documents/pages.ts";
import { readings, type Readings } from "../core/documents/reading.ts";
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
let signedIn: boolean;
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
  signedIn = true;
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
    signInPollMs?: number;
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
    book: notebook(store, () => NOW),
    pages: pages(store, home),
    event: async (id, event, write) => {
      const chat = await transcripts.chat(id);
      if (!chat) throw new Error("No chat.");
      await transcripts.addEvent(chat, event, write);
    },
    run: options.run ?? fake.run,
    signedIn: () => Promise.resolve(signedIn),
    choice: () => readerChoice(transcripts.setting),
    mcp: { url: () => `http://127.0.0.1:${String(port)}/mcp/reader`, keys },
    log: options.log ?? (() => undefined),
    signInPollMs: options.signInPollMs ?? 20,
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
  rows(
    "SELECT state, attempt, retried, error, waiting, wait_until FROM jobs",
  )[0];
const drafts = () =>
  rows(
    "SELECT page, seq, version, status, fields, original, unsure FROM draft_items ORDER BY page, seq",
  );
const pageStates = () =>
  rows("SELECT position, state FROM document_pages ORDER BY position");
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
  it("writes a start line, then drafts, page states and an end line in one go", async () => {
    let midway: unknown;
    const { runs, reader: running } = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage(), "Collected date on page 1.");
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
        waiting: null,
        waitUntil: null,
        again: false,
        saved: 1,
        of: 2,
        runAt: NOW,
      },
    ]);
    expect(runs[0]?.input).toBe(
      "Read this document: 2 pages (sunrise-august.pdf).\nIt was added for Asha Fictional.\nSave these pages: 1–2.",
    );
    expect(lines()).toEqual([
      "Reading sunrise-august.pdf · 2 pages",
      "Lab report · 12 Aug · 2 results read",
    ]);
    // Nothing needs the person: the AI isn't asked.
    expect(asks()).toEqual([]);
    expect(pageStates()).toEqual([
      { position: 1, state: "read" },
      { position: 2, state: "read" },
    ]);
    const [first] = drafts();
    expect(first).toMatchObject({
      page: 1,
      seq: 1,
      version: 1,
      status: "pending",
    });
    expect(JSON.parse(first?.["fields"] as string)).toEqual({
      test_name: "Haemoglobin",
      value_text: "13.2",
      value_number: 13.2,
      unit: "g/dL",
      reference_range: "12.0-15.0",
    });
    expect(drafts()).toHaveLength(2);
    expect(
      rows("SELECT kind, date, version, reader_note FROM documents"),
    ).toEqual([
      {
        kind: "lab_report",
        date: "2026-08-12",
        version: 1,
        reader_note: "Collected date on page 1.",
      },
    ]);
    expect(await reads.strip(personId)).toEqual([]);
    expect((await docs.list(personId))[0]).toMatchObject({
      status: "done",
      reading: { saved: 2, of: 2, results: 2, toCheck: 0, canRetry: false },
    });
    await running.close();
  });

  it("counts current results in the end line while keeping earlier values as drafts", async () => {
    const { reader: running } = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(
          1,
          readPage("13.2", {
            items: [
              {
                test_name: "Haemoglobin",
                value_text: "13.2",
                column: "current",
              },
              {
                test_name: "Haemoglobin",
                value_text: "13.2",
                column: "earlier",
                date: {
                  label: "Collected",
                  date: "12 Aug 2025",
                  iso: "2025-08-12",
                },
              },
            ],
          }),
        );
        await turn.look(2);
        await turn.save(2, { outcome: "nothing_here", items: [] });
        return undefined;
      },
    ]);
    try {
      await addReport();
      await until(done);
      expect(lines().at(-1)).toBe("Lab report · 12 Aug · 1 result read");
      expect(drafts()).toHaveLength(2);
      expect((await docs.list(personId))[0]?.reading).toMatchObject({
        results: 1,
        toCheck: 0,
      });
      expect(JSON.parse(drafts()[1]?.["fields"] as string)).toMatchObject({
        column: "earlier",
      });
    } finally {
      await running.close();
    }
  });

  it("asks only about what the reader raised: Rufi adds no flags of its own", async () => {
    const answers: unknown[] = [];
    const { reader: running } = await startReader([
      async (turn) => {
        await turn.look(1);
        // Not on the page's own text, and a number that isn't the printed
        // value: the reader didn't say it was unsure, so it isn't.
        answers.push(
          (
            await turn.save(
              1,
              readPage("13.8", {
                items: [
                  {
                    test_name: "Haemoglobin",
                    value_text: "4,6",
                    value_number: 46,
                  },
                ],
              }),
            )
          ).json,
        );
        await turn.look(2);
        await turn.save(
          2,
          readPage("13.2", {
            facts: { kind: "lab_report", name: "Meera Fictional" },
            items: [
              {
                test_name: "Haemoglobin",
                value_text: "13.2",
                unsure: "the last digit is smudged",
              },
            ],
            issues: ["The name on the report is Meera Fictional."],
          }),
        );
        return undefined;
      },
    ]);
    const id = await addReport();
    await until(done);

    expect(answers[0]).toEqual({
      ok: true,
      result: { saved: "1", still_to_save: "2", note: null },
    });
    expect(
      rows("SELECT entry_checks FROM document_pages ORDER BY position"),
    ).toEqual([{ entry_checks: null }, { entry_checks: null }]);
    expect(
      drafts().map((d) => JSON.parse(d["unsure"] as string) as string[]),
    ).toEqual([[], ["the last digit is smudged"]]);
    expect(lines().at(-1)).toBe(
      "Lab report · 12 Aug · 2 results read · 1 to check",
    );
    expect(asks()).toEqual([
      [
        `A document reading finished: sunrise-august.pdf (document ${id}), 2 draft items read, not saved.`,
        "What needs the user:",
        `- unsure: page 2: Haemoglobin "13.2" (the last digit is smudged)`,
        "- the reader noted: page 2: The name on the report is Meera Fictional.",
        "Read the document with get_documents if you need to, then tell the user in a few lines and ask what it needs. Don't save anything.",
      ].join("\n"),
    ]);
    await running.close();
  });

  it("doesn't ask about a printed name the reader raised no issue for", async () => {
    const { reader: running } = await startReader([
      async (turn) => {
        for (const page of [1, 2]) {
          await turn.look(page);
          await turn.save(
            page,
            readPage("13.2", {
              facts: { kind: "lab_report", name: "Meera Fictional" },
            }),
          );
        }
        return undefined;
      },
    ]);
    await addReport();
    await until(done);
    expect(lines().at(-1)).toBe("Lab report · 2 results read");
    expect(asks()).toEqual([]);
    await running.close();
  });

  it("tells the reader only the name of the person the document was added for", async () => {
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
      "Read this document: 2 pages (sunrise-august.pdf).\nIt was added for Ravi Fictional.\nSave these pages: 1–2.",
    );
    await running.close();
  });

  it("marks pages the reader never saved as not looked at, and Retry reads only those", async () => {
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
      "Lab report · 12 Aug · 1 result read · 1 page not looked at",
    );
    expect(pageStates()).toEqual([
      { position: 1, state: "read" },
      { position: 2, state: "not_looked_at" },
    ]);
    // The person fixed page 1's draft meanwhile (slice 3c's fix, by hand here).
    store.db.exec(
      `UPDATE draft_items SET fields = '{"test_name":"Haemoglobin","value_text":"13.4"}', version = 2`,
    );
    const before = drafts();

    expect(await reads.retry(personId, id)).toEqual([2]);
    await until(
      () => rows("SELECT state FROM jobs WHERE state = 'done'").length === 2,
    );
    expect(runs[1]?.input).toContain("Save these pages: 2.");
    expect(lines().slice(-2)).toEqual([
      "Reading sunrise-august.pdf again · page 2",
      "Lab report · 12 Aug · page 2 read again · 1 result read",
    ]);
    expect(drafts()).toEqual([before[0], expect.objectContaining({ page: 2 })]);
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
  it("stops a reader that used its refusal allowance, keeps why, and publishes no drafts", async () => {
    await transcripts.saveSetting("reader_model", "gpt-5.5");
    let attempts = 0;
    const late: number[] = [];
    const bad: Step = {
      call: {
        namespace: "mcp__rufi",
        name: "save_page",
        arguments: { page: 1, entry: readPage() },
      },
    };
    const { reader: running } = await startReader([], {
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
                arguments: { page: 2, entry: readPage() },
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
                arguments: { page: 1, entry: readPage() },
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
              arguments: { page: 2, entry: readPage() },
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
      expect(drafts()).toEqual([]);
      const pages = rows(
        "SELECT position, entry FROM document_pages ORDER BY position",
      );
      expect(pages[0]).toEqual({ position: 1, entry: null });
      expect(JSON.parse(String(pages[1]?.["entry"]))).toMatchObject({
        outcome: "read",
        items: [{ test_name: "Haemoglobin", value_text: "13.2" }],
      });
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

  it("continues after a restart from the notebook: no second start line, one set of drafts", async () => {
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
    await until(
      () =>
        rows("SELECT entry FROM document_pages WHERE entry IS NOT NULL")
          .length === 1,
    );
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
    expect(lines()).toEqual([
      "Reading sunrise-august.pdf · 2 pages",
      "Lab report · 12 Aug · 2 results read",
    ]);
    expect(drafts().map((d) => d["page"])).toEqual([1, 2]);
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
    await until(
      () =>
        rows("SELECT entry FROM document_pages WHERE entry IS NOT NULL")
          .length === 2,
    );
    await first.reader.close();
    await reads.recover();

    const second = await startReader([]);
    await until(done);
    expect(second.runs).toEqual([]);
    expect(lines()).toHaveLength(2);
    expect(drafts()).toHaveLength(2);
    await second.reader.close();
  });

  it("finishes a reading an older Rufi saved, with the checks it stored, and leaves its entries as they are", async () => {
    const first = await startReader([
      async (turn) => {
        for (const page of [1, 2]) {
          await turn.look(page);
          await turn.save(page, readPage());
        }
        await turn.stopped();
        return { end: { status: "interrupted", reason: "stopped" } };
      },
    ]);
    const id = await addReport();
    await until(
      () =>
        rows("SELECT entry FROM document_pages WHERE entry IS NOT NULL")
          .length === 2,
    );
    await first.reader.close();
    // Page 1 as an older Rufi saved it: a row count in the entry, and its
    // own checks beside it.
    store.db.exec(
      `UPDATE document_pages SET
         entry = json_set(entry, '$.rows_seen', 2),
         entry_checks = '{"incomplete":{"rows_seen":2,"items":1},"items":[{"item":1,"why":"its number 13.2 isn''t the printed value"}]}'
       WHERE position = 1`,
    );
    const before = rows(
      "SELECT entry, entry_checks FROM document_pages ORDER BY position",
    );
    await reads.recover();

    const second = await startReader([]);
    await until(done);
    expect(second.runs).toEqual([]);
    expect(lines().at(-1)).toBe(
      "Lab report · 12 Aug · 2 results read · 1 to check · 1 page may be incomplete",
    );
    expect(asks()).toEqual([
      [
        `A document reading finished: sunrise-august.pdf (document ${id}), 2 draft items read, not saved.`,
        "What needs the user:",
        `- unsure: page 1: Haemoglobin "13.2" (its number 13.2 isn't the printed value)`,
        "- page 1 may be incomplete: 2 rows seen, 1 read",
        "Read the document with get_documents if you need to, then tell the user in a few lines and ask what it needs. Don't save anything.",
      ].join("\n"),
    ]);
    expect(JSON.parse(drafts()[0]?.["unsure"] as string)).toEqual([
      "its number 13.2 isn't the printed value",
    ]);
    expect(
      rows("SELECT entry, entry_checks FROM document_pages ORDER BY position"),
    ).toEqual(before);
    await second.reader.close();
  });

  it("does not finish from failed entries after the retry is interrupted and Rufi restarts", async () => {
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
      expect(drafts()).toEqual([]);
    } finally {
      await first.reader.close();
    }
    await reads.recover();
    const completed = Promise.withResolvers<undefined>();
    const second = await startReader([() => completed.promise]);
    try {
      await until(() => second.runs.length === 1 || done());
      expect(second.runs).toHaveLength(1);
      expect(drafts()).toEqual([]);
      expect(lines()).toEqual(["Reading sunrise-august.pdf · 2 pages"]);
      completed.resolve(undefined);
      await until(done);
      expect(drafts()).toHaveLength(2);
      expect(lines()).toHaveLength(2);
    } finally {
      completed.resolve(undefined);
      await second.reader.close();
    }
  });

  it("a deadline fails the reading with its entries kept and no drafts; Retry continues it", async () => {
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
    expect(drafts()).toEqual([]);
    expect(asks()).toEqual([]);
    expect((await docs.list(personId))[0]).toMatchObject({
      status: "failed",
      reading: { saved: 1, of: 2, canRetry: true },
    });

    expect(await reads.retry(personId, id)).toEqual([1, 2]);
    await until(done);
    expect(runs[1]?.input).toContain("You saved pages 1 in an earlier run");
    expect(lines().at(-1)).toBe("Lab report · 12 Aug · 2 results read");
    expect(drafts().map((d) => d["page"])).toEqual([1, 2]);
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
            arguments: { page: 1, entry: readPage() },
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
    expect(drafts().map((d) => d["page"])).toEqual([1, 2]);
    await running.close();
  });

  it.each(["timeout", "connection"] as const)(
    "keeps all entries without publishing after a %s failure; Retry needs a completed turn",
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
        ...(reason === "connection" ? [failure] : []),
        () => Promise.resolve(undefined),
      ]);
      try {
        const id = await addReport();
        await until(() =>
          ["failed", "done"].includes(String(job()?.["state"])),
        );
        expect(job()?.["state"]).toBe("failed");
        expect(runs).toHaveLength(reason === "connection" ? 2 : 1);
        expect(
          (await reads.view(personId, id))?.pages.map((p) => p.entry),
        ).toEqual([readPage(), readPage()]);
        expect(drafts()).toEqual([]);
        expect(lines().at(-1)).toContain("Couldn't finish reading");
        expect(asks()).toEqual([]);

        await reads.retry(personId, id);
        await until(done);
        expect(runs).toHaveLength(reason === "connection" ? 3 : 2);
        expect(runs.at(-1)?.input).toContain(
          "You saved pages 1–2 in an earlier run",
        );
        expect(drafts()).toHaveLength(2);
        expect(lines().at(-1)).toBe("Lab report · 12 Aug · 2 results read");
      } finally {
        await running.close();
      }
    },
  );

  it("retries once by itself for a passing reason, then fails visibly with the service's words", async () => {
    const lost = () =>
      Promise.resolve({
        end: {
          status: "failed" as const,
          reason: "connection" as const,
          text: "exceeded retry limit, last status: 429 Too Many Requests",
        },
      });
    const { runs, reader: running } = await startReader([lost, lost]);
    await addReport();
    await until(() => job()?.["state"] === "failed");
    expect(runs).toHaveLength(2);
    expect(lines().at(-1)).toBe(
      "Couldn't finish reading sunrise-august.pdf · exceeded retry limit, last status: 429 Too Many Requests · read 0 of 2",
    );
    await running.close();
  });

  it("waits for the sign-in, and until a usage limit resets", async () => {
    signedIn = false;
    const { runs, reader: running } = await startReader([
      () =>
        Promise.resolve({
          end: {
            status: "failed" as const,
            reason: "usage_limit" as const,
            resetsAt: "2026-10-10T14:30:00.000Z",
          },
        }),
    ]);
    await addReport();
    await until(() => job()?.["waiting"] === "sign_in");
    expect(runs).toEqual([]);
    expect(await reads.strip(personId)).toMatchObject([
      { state: "waiting", waiting: "sign_in" },
    ]);

    signedIn = true;
    await until(() => job()?.["waiting"] === "usage_limit");
    expect(job()).toMatchObject({
      state: "queued",
      wait_until: "2026-10-10T14:30:00.000Z",
    });
    // The clock is still before the reset: nothing more runs.
    running.poke();
    await sleep(50);
    expect(runs).toHaveLength(1);
    expect(lines()).toEqual(["Reading sunrise-august.pdf · 2 pages"]);
    await running.close();
  });

  it("waits visibly when the provider rejects a stored sign-in, then resumes at the poll time", async () => {
    const { runs, reader: running } = await startReader(
      [
        () => Promise.resolve({ end: { status: "failed", reason: "sign_in" } }),
        async (turn) => {
          await turn.look(1);
          await turn.save(1, readPage());
          await turn.look(2);
          await turn.save(2, readPage());
          return undefined;
        },
      ],
      { signInPollMs: 30_000 },
    );
    try {
      await addReport();
      await until(() => job()?.["waiting"] === "sign_in" || done());
      expect(job()).toMatchObject({
        state: "queued",
        waiting: "sign_in",
        wait_until: "2026-10-10T09:00:30.000Z",
        retried: 0,
      });
      expect(await reads.strip(personId)).toMatchObject([
        {
          state: "waiting",
          waiting: "sign_in",
          waitUntil: "2026-10-10T09:00:30.000Z",
        },
      ]);
      running.poke();
      await sleep(50);
      expect(runs).toHaveLength(1);
      expect(drafts()).toEqual([]);
      expect(lines()).toEqual(["Reading sunrise-august.pdf · 2 pages"]);

      clock += 30_000;
      running.poke();
      await until(done);
      expect(runs).toHaveLength(2);
      expect(drafts()).toHaveLength(2);
    } finally {
      await running.close();
    }
  });

  it("waits a minute when the sign-in can't be renewed yet, keeping its retry", async () => {
    const { runs, reader: running } = await startReader([
      () =>
        Promise.reject(
          new ChatGptError("temporary", "Can't renew the sign-in yet."),
        ),
    ]);
    await addReport();
    await until(() => job()?.["waiting"] === "sign_in");
    expect(job()).toMatchObject({
      state: "queued",
      retried: 0,
      wait_until: "2026-10-10T09:01:00.000Z",
    });
    running.poke();
    await sleep(50);
    expect(runs).toHaveLength(1);
    await running.close();
  });
});

describe("the chat AI and a reading", () => {
  it("sees the drafts as not saved, and can read failed pages again only in the person's turn", async () => {
    const { reader: running } = await startReader([
      async (turn) => {
        await turn.look(1);
        await turn.save(1, readPage());
        await turn.look(2);
        await turn.save(2, {
          outcome: "unreadable",
          why: "Blurred.",
          items: [],
        });
        return undefined;
      },
    ]);
    const id = await addReport();
    await until(done);
    expect(lines().at(-1)).toBe(
      "Lab report · 12 Aug · 1 result read · 1 page couldn't be read",
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
      draft_items: 1,
    });
    expect(answer.result["pages"]).toEqual([
      expect.objectContaining({ page: 1, state: "read" }),
      expect.objectContaining({
        page: 2,
        state: "unreadable",
        why: "Blurred.",
      }),
    ]);
    expect(answer.result["items"]).toEqual([
      expect.objectContaining({
        page: 1,
        version: 1,
        status: "not saved",
        test_name: "Haemoglobin",
        value_text: "13.2",
      }),
    ]);

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
