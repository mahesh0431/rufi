// The reader's lock-down, proved on the pinned Codex binary itself, offline:
// a sub-agent turn against the local fake model, with the reader's real
// tools, page service and notebook writer on a real database. It captures
// every request Codex sends the model and fails on any tool but get_page and
// save_page, also after a compaction; it checks a page image reaches the
// model, and that the tools' binding and the notebook's write boundary hold.
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fakeModel,
  type FakeModel,
  type ModelRequest,
  type Step,
} from "../../../tests/fake-model.ts";
import type { Scenario } from "../../../tests/fake-codex.ts";
import { documents } from "../../core/documents/documents.ts";
import { notebook, type Run } from "../../core/documents/notebook.ts";
import { pagePath } from "../../core/documents/originals.ts";
import { pages } from "../../core/documents/pages.ts";
import { forReader } from "../../core/documents/reader-tools.ts";
import {
  databasePath,
  openWritable,
  type Store,
} from "../../core/store/database.ts";
import type { SubAgentOutcome } from "../runtime.ts";
import { codexBinary } from "./binary.ts";
import { subAgentRunner } from "./subagent.ts";

/** The reader's direct model: Codex adds no tools of its own. */
const MODEL = "gpt-5.5";
/** The reader's code-mode model: Rufi's tools only inside Codex's exec. */
const CODE_MODEL = "gpt-6.1-sol";
const INSTRUCTIONS = "You read one document for Rufi. (Test instructions.)";
const INPUT = "Read the document's pages and save each one.";
/** Over any model's compaction limit: Codex summarises the thread. */
const OVER_LIMIT = 10_000_000;

let root: string;
let store: Store;
let model: FakeModel | undefined;
let documentId: string;
let jobId: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "rufi-subagent-")));
  await mkdir(join(root, "user-home"));
  store = openWritable(databasePath(root));
  store.db.exec(`INSERT INTO people (id, display_name) VALUES
    ('asha', 'Asha Fictional'), ('ravi', 'Ravi Fictional')`);
  const fixture = async (file: string) => ({
    name: file,
    bytes: new Uint8Array(
      await readFile(
        join(import.meta.dirname, "../../../tests/fixtures/documents", file),
      ),
    ),
  });
  const docs = documents(store, root);
  // A two-page report for Asha, and Ravi's own report beside it.
  [documentId = ""] = (
    await docs.add("asha", [await fixture("sunrise-labs-august.pdf")], true)
  ).added;
  await docs.add("ravi", [await fixture("ravi-lipid-panel.pdf")], true);
  jobId = "job-1";
  return () => {
    store.close();
  };
});
afterEach(async () => {
  await model?.close();
  model = undefined;
});

/** A running job for Asha's report: its attempt, and the pages it reads. */
function job(targets: number[], attempt = 1): Run {
  store.db
    .prepare(
      `INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, created_at)
       VALUES (?, 'asha', 'document_read', ?, 'running', ?, ?, '2026-10-10T09:00:00.000Z')`,
    )
    .run(jobId, documentId, attempt, JSON.stringify(targets));
  return {
    jobId,
    attempt,
    personId: "asha",
    documentId,
    targets,
    lookedAt: new Set(),
    closed: false,
  };
}

/** The notebook as stored: every page's entry and job, and the note. */
const stored = () => ({
  pages: store.db
    .prepare(
      "SELECT person_id, position, entry, entry_job_id FROM document_pages ORDER BY person_id, position",
    )
    .all()
    .map((row) => ({ ...row })),
  notes: store.db
    .prepare("SELECT person_id, reader_note FROM documents ORDER BY person_id")
    .all()
    .map((row) => ({ ...row })),
});

/** A reader turn on the real Codex: the scripted steps, then "done". */
async function read(
  run: Run,
  script: Step[],
  before?: (call: number) => void,
  readerModel = MODEL,
  config: readonly string[] = [],
): Promise<{ outcome: SubAgentOutcome; answers: unknown[] }> {
  model = await fakeModel({ script });
  const reader = forReader(
    run,
    pages(store, root),
    notebook(store),
    () => undefined,
  );
  const answers: unknown[] = [];
  let calls = 0;
  const runner = subAgentRunner({
    home: root,
    command: {
      file: await codexBinary(),
      args: [
        "-c",
        `model_providers.openai_chatgpt_plan.base_url="${model.url}"`,
        ...config.flatMap((value) => ["-c", value]),
      ],
    },
    env: { PATH: process.env["PATH"] ?? "", HOME: join(root, "user-home") },
    token: () => Promise.resolve("not-a-real-token"),
    version: "0.0.0",
  });
  const outcome = await runner({
    model: readerModel,
    effort: "low",
    instructions: INSTRUCTIONS,
    input: INPUT,
    tools: { namespace: reader.namespace, specs: reader.specs },
    callTool: async (name, input) => {
      before?.(++calls);
      const answer = await reader.call(name, input);
      answers.push(JSON.parse(answer.text));
      return answer;
    },
    onCompaction: () => {
      run.lookedAt.clear();
    },
    deadlineMs: 60_000,
  });
  return { outcome, answers };
}

/** Every tool the model could call in a request, as namespace.name. */
function callable(request: ModelRequest): string[] {
  const tools = [
    ...(request.tools ?? []),
    ...request.input.flatMap((item) =>
      item.type === "additional_tools" ? (item.tools ?? []) : [],
    ),
  ] as { type: string; name?: string; tools?: { name: string }[] }[];
  return tools
    .flatMap((tool) =>
      tool.type === "namespace"
        ? (tool.tools ?? []).map((t) => `${tool.name ?? ""}.${t.name}`)
        : [tool.name ?? tool.type],
    )
    .sort();
}

/** The tools a code-mode request offers inside exec, from exec's own description. */
function inExec(request: ModelRequest): string[] {
  const exec = [
    ...(request.tools ?? []),
    ...request.input.flatMap((item) =>
      item.type === "additional_tools" ? (item.tools ?? []) : [],
    ),
  ]
    .flatMap((tool) => {
      const t = tool as { name?: string; tools?: unknown[] };
      return [t, ...((t.tools ?? []) as (typeof t)[])];
    })
    .find((tool) => tool.name === "exec") as
    | { description?: string }
    | undefined;
  return [...(exec?.description ?? "").matchAll(/^### `([^`]+)`$/gm)]
    .map((match) => match[1] ?? "")
    .sort();
}

const isCompaction = (request: ModelRequest) =>
  JSON.stringify(request.input.at(-1)).includes(
    "CONTEXT CHECKPOINT COMPACTION",
  );

const call = (name: string, args: unknown, tokens?: number): Step => ({
  call: { namespace: "rufi", name, arguments: args },
  ...(tokens !== undefined && { tokens }),
});

/** A script for exec: look at a page, then show its text and its image. */
const look = (page: number): Step => ({
  exec: `const answer = await tools.rufi__get_page({ page: ${String(page)} });
const at = answer.lastIndexOf("\\ndata:");
text(answer.slice(0, at));
image(answer.slice(at + 1));`,
});

/** A script for exec: save a page, and show Rufi's answer. */
const save = (page: number, entry: unknown, tokens?: number): Step => ({
  exec: `text(await tools.rufi__save_page(${JSON.stringify({ page, entry })}));`,
  ...(tokens !== undefined && { tokens }),
});

const entry = (value: string) => ({
  outcome: "read",
  rows_seen: 1,
  items: [{ test_name: "Haemoglobin", value_text: value, unit: "g/dL" }],
});

describe("the reader on the pinned Codex", () => {
  it.each([
    [
      "enabled MCP servers",
      `mcp_servers.fixture.command=${JSON.stringify(process.execPath)}`,
    ],
    [
      "developer instructions",
      'developer_instructions="Ambient fictional instructions."',
    ],
    [
      "base instructions",
      'instructions="Ambient fictional base instructions."',
    ],
    [
      "compaction instructions",
      'compact_prompt="Ambient fictional compaction instructions."',
    ],
    ["plan tool", "tools.update_plan.enabled=true"],
    ["clock tool", "features.current_time_reminder=true"],
  ])(
    "refuses ambient %s before a turn starts",
    async (_name, config) => {
      const { outcome, answers } = await read(
        job([1]),
        [{ text: "Done." }],
        undefined,
        MODEL,
        [config],
      );
      expect(outcome.end).toMatchObject({
        status: "failed",
        reason: "provider_failed",
      });
      expect(outcome.end.text).toContain("reader configuration");
      expect(model?.requests).toEqual([]);
      expect(answers).toEqual([]);
    },
    120_000,
  );

  it("checks the effective ambient configuration at the reader's cwd", async () => {
    const cwd = join(root, "sub-agents", "workspace");
    await mkdir(join(cwd, ".codex"), { recursive: true });
    await writeFile(
      join(cwd, ".codex", "config.toml"),
      'developer_instructions="Fictional project instructions."\n',
    );
    const { outcome } = await read(
      job([1]),
      [{ text: "Done." }],
      undefined,
      MODEL,
      [`projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`],
    );
    expect(outcome.end).toMatchObject({
      status: "failed",
      reason: "provider_failed",
    });
    expect(outcome.end.text).toContain("reader configuration");
    expect(model?.requests).toEqual([]);
  }, 120_000);

  it("can call only get_page and save_page, sees the page image, and its tools hold", async () => {
    const run = job([1, 2]);
    const before = stored();
    const { outcome, answers } = await read(
      run,
      [
        call("save_page", { page: 1, entry: entry("13.2") }),
        call("get_page", { page: 1 }),
        call("get_page", { page: 9 }),
        call("get_page", { page: 1, document: "another" }),
        call("save_page", { page: 1, entry: { outcome: "read" } }),
        // Refusals so far changed nothing.
        call("save_page", {
          page: 1,
          entry: entry("13.2"),
          note: "Dates on page 1.",
        }),
        // The answer to this save reports usage over the limit: Codex compacts.
        call("save_page", { page: 1, entry: entry("13.4") }, OVER_LIMIT),
        call("save_page", { page: 1, entry: entry("13.5") }),
        call("get_page", { page: 1 }),
        { text: "Done." },
      ],
      undefined,
      MODEL,
      [
        `mcp_servers.fixture.command=${JSON.stringify(process.execPath)}`,
        "mcp_servers.fixture.enabled=false",
        "tools.update_plan.enabled=false",
      ],
    );

    expect(outcome.end).toEqual({ status: "completed" });
    expect(outcome.compactions).toBe(1);

    // The complete callable set, in every request, also after the compaction.
    const requests = model?.requests ?? [];
    expect(requests.filter(isCompaction)).toHaveLength(1);
    for (const request of requests) {
      // Codex's own summarising request offers no tools at all.
      expect(
        callable(request),
        JSON.stringify(request.input.at(-1)).slice(0, 80),
      ).toEqual(
        isCompaction(request) ? [] : ["rufi.get_page", "rufi.save_page"],
      );
    }
    // Rufi's instructions only, and no history: the first request is just the task.
    expect(requests[0]?.instructions).toBe(INSTRUCTIONS);
    expect(requests[0]?.input).toEqual([
      {
        type: "message",
        role: "user",
        id: expect.any(String) as unknown,
        content: [{ type: "input_text", text: INPUT }],
      },
    ]);

    // The page image reached the model with the page's text, as Rufi drew it.
    const shown = requests[2]?.input.at(-1);
    expect(shown?.type).toBe("function_call_output");
    const output = shown?.output as {
      type: string;
      text?: string;
      image_url?: string;
    }[];
    expect(output.map((part) => part.type)).toEqual([
      "input_text",
      "input_image",
    ]);
    expect(output[0]?.text).toContain("Sunrise Labs · Test report · page 1");
    const drawn = await readFile(
      pagePath(
        root,
        store.db
          .prepare("SELECT file_id FROM document_pages WHERE document_id = ?")
          .get(documentId)?.["file_id"] as string,
        1,
      ),
    );
    expect(output[1]?.image_url).toBe(
      `data:image/png;base64,${drawn.toString("base64")}`,
    );

    // Each refusal says why; nothing changed until the first valid save.
    const errors = answers.map((a) => (a as { error?: string }).error);
    expect(errors[0]).toBe("Look at page 1 with get_page first, then save it.");
    expect(errors[2]).toBe("This document has no page 9; its pages are 1–2.");
    expect(errors[3]).toBe("The input for get_page isn't valid.");
    expect(errors[4]).toBe("The input for save_page isn't valid.");
    // After the compaction, page 1 must be looked at again before a save.
    expect(errors[7]).toBe("Look at page 1 with get_page first, then save it.");

    const after = stored();
    expect(after.notes).toEqual([
      { person_id: "asha", reader_note: "Dates on page 1." },
      { person_id: "ravi", reader_note: null },
    ]);
    expect(after.pages).toEqual([
      // Replaced, not added: one entry, the last saved before the compaction.
      {
        person_id: "asha",
        position: 1,
        entry: JSON.stringify(entry("13.4")),
        entry_job_id: jobId,
      },
      { person_id: "asha", position: 2, entry: null, entry_job_id: null },
      { person_id: "ravi", position: 1, entry: null, entry_job_id: null },
    ]);
    expect(before.pages.every((p) => p["entry"] === null)).toBe(true);
    // The look after the compaction shows the saved entry and the note.
    expect(answers[8]).toMatchObject({
      ok: true,
      result: {
        page: 1,
        of: 2,
        entry: entry("13.4"),
        note: "Dates on page 1.",
        saved: "1",
        still_to_save: "2",
      },
    });
  }, 120_000);

  it("saves nothing for a page outside the job's targets, another run, or a closed run", async () => {
    const run = job([1]);
    const { outcome, answers } = await read(
      run,
      [
        // Page 2 may be looked at for context, but this job doesn't save it.
        call("get_page", { page: 2 }),
        call("save_page", { page: 2, entry: entry("1") }),
        call("get_page", { page: 1 }),
        // Before this call, another run of the job has started.
        call("save_page", { page: 1, entry: entry("2") }),
        // Before this call, Rufi has closed the run.
        call("save_page", { page: 1, entry: entry("3") }),
        { text: "Done." },
      ],
      (n) => {
        if (n === 4) store.db.exec("UPDATE jobs SET attempt = 2");
        if (n === 5) {
          store.db.exec("UPDATE jobs SET attempt = 1");
          run.closed = true;
        }
      },
    );
    expect(outcome.end).toEqual({ status: "completed" });
    expect(answers.map((a) => (a as { error?: string }).error)).toEqual([
      undefined,
      "Page 2 isn't one of the pages this reading saves (1).",
      undefined,
      "This reading isn't running any more; nothing more is saved.",
      "This reading has ended; nothing more is saved.",
    ]);
    // A late call after the turn ended is refused too.
    const late = await forReader(
      run,
      pages(store, root),
      notebook(store),
      () => undefined,
    ).call("save_page", { page: 1, entry: entry("4") });
    expect(JSON.parse(late.text)).toMatchObject({
      ok: false,
      error: "This reading has ended; nothing more is saved.",
    });
    expect(stored().pages.every((p) => p["entry"] === null)).toBe(true);
    expect(stored().notes.every((n) => n["reader_note"] === null)).toBe(true);
  }, 120_000);

  it("on a code-mode model, can reach only its two tools and Codex's pinned set through exec, and sees the page image", async () => {
    const run = job([1, 2]);
    const { outcome } = await read(
      run,
      [
        look(1),
        save(1, entry("13.2")),
        // The answer to this save reports usage over the limit: Codex compacts.
        save(1, entry("13.4"), OVER_LIMIT),
        look(1),
        { text: "Done." },
      ],
      undefined,
      CODE_MODEL,
    );

    expect(outcome.end).toEqual({ status: "completed" });
    expect(outcome.compactions).toBe(1);

    // The complete exposed set, in every request, also after the compaction:
    // exec and wait run Rufi's tools; the async question fails the turn.
    const requests = model?.requests ?? [];
    expect(requests.filter(isCompaction)).toHaveLength(1);
    for (const request of requests) {
      const where = JSON.stringify(request.input.at(-1)).slice(0, 80);
      if (isCompaction(request)) {
        expect(callable(request), where).toEqual([]);
        continue;
      }
      expect(callable(request), where).toEqual([
        "functions.exec",
        "functions.request_user_input_async",
        "functions.wait",
      ]);
      expect(inExec(request), where).toEqual([
        "clock__curr_time",
        "rufi__get_page",
        "rufi__save_page",
      ]);
    }
    // Rufi's instructions only (this model takes them as a developer
    // message), and no history: then just the task.
    expect(
      requests[0]?.input
        .filter((item) => item.type === "message")
        .map((item) => [item.role, item.content]),
    ).toEqual([
      ["developer", [{ type: "input_text", text: INSTRUCTIONS }]],
      ["user", [{ type: "input_text", text: INPUT }]],
    ]);

    // The page image reached the model, as Rufi drew it, through exec.
    const shown = requests[1]?.input.at(-1);
    expect(shown?.type).toBe("custom_tool_call_output");
    const output = shown?.output as { type: string; image_url?: string }[];
    const drawn = await readFile(
      pagePath(
        root,
        store.db
          .prepare("SELECT file_id FROM document_pages WHERE document_id = ?")
          .get(documentId)?.["file_id"] as string,
        1,
      ),
    );
    expect(output.filter((part) => part.type === "input_image")).toEqual([
      expect.objectContaining({
        image_url: `data:image/png;base64,${drawn.toString("base64")}`,
      }),
    ]);
    // The saves through exec reached the notebook.
    expect(stored().pages[0]).toMatchObject({
      entry: JSON.stringify(entry("13.4")),
      entry_job_id: jobId,
    });
  }, 120_000);

  it("fails the turn when a code-mode reader asks the person a question", async () => {
    const { outcome } = await read(
      job([1]),
      [
        {
          call: {
            name: "request_user_input_async",
            arguments: { questions: [{ title: "Which page is the latest?" }] },
          },
        },
        { text: "Done." },
      ],
      undefined,
      CODE_MODEL,
    );
    expect(outcome.end).toEqual({
      status: "failed",
      reason: "provider_failed",
      text: "The reader asked a question, but nobody is there to answer it, so Rufi stopped it.",
    });
  }, 120_000);

  it("refuses a model it doesn't run before a turn starts", async () => {
    const { outcome, answers } = await read(
      job([1, 2]),
      [{ text: "Done." }],
      undefined,
      "gpt-6-astra",
    );
    expect(outcome.end).toEqual({
      status: "failed",
      reason: "provider_failed",
      text: "Rufi's sub-agents run only on gpt-6.1-sol, gpt-5.5.",
    });
    expect(model?.requests).toEqual([]);
    expect(answers).toEqual([]);
  }, 120_000);
});

describe("the reader's tool route", () => {
  it.each([
    [MODEL, { status: "failed", reason: "provider_failed" }, 0],
    [CODE_MODEL, { status: "completed" }, 1],
  ] as const)(
    "a call made through exec, on %s: %o, tool runs %i",
    async (readerModel, end, runs) => {
      const scenario: Scenario = {
        bare: true,
        calls: [
          {
            id: "exec-1",
            namespace: "rufi",
            tool: "get_page",
            arguments: { page: 1 },
          },
        ],
      };
      let called = 0;
      const outcome = await subAgentRunner({
        home: root,
        command: {
          file: process.execPath,
          args: [join(import.meta.dirname, "../../../tests/fake-codex.ts")],
        },
        env: {
          PATH: process.env["PATH"] ?? "",
          FAKE_CODEX: JSON.stringify(scenario),
        },
        token: () => Promise.resolve("not-a-real-token"),
        version: "0.0.0",
      })({
        model: readerModel,
        effort: "low",
        instructions: INSTRUCTIONS,
        input: INPUT,
        tools: { namespace: "rufi", specs: [] },
        callTool: () => {
          called++;
          return Promise.resolve({ ok: true, text: "{}" });
        },
        onCompaction: () => undefined,
        deadlineMs: 60_000,
      });
      expect(outcome.end, outcome.end.text).toMatchObject(end);
      expect(called).toBe(runs);
    },
    // It starts the fake Codex: a busy machine can take seconds.
    120_000,
  );
});

describe("the reader's provider outcomes", () => {
  it.each([true, false])(
    "preserves the account reset time when reported: %s",
    async (reported) => {
      const scenario: Scenario = reported
        ? {
            resetsAt: 1_791_617_700,
            rateLimitUpdates: [{ planType: "plus", credits: null }],
          }
        : {};
      const runner = subAgentRunner({
        home: root,
        command: {
          file: process.execPath,
          args: [join(import.meta.dirname, "../../../tests/fake-codex.ts")],
        },
        env: {
          PATH: process.env["PATH"] ?? "",
          FAKE_CODEX: JSON.stringify(scenario),
        },
        token: () => Promise.resolve("not-a-real-token"),
        version: "0.0.0",
      });
      const outcome = await runner({
        model: MODEL,
        effort: "low",
        instructions: INSTRUCTIONS,
        input: "fail",
        tools: { namespace: "rufi", specs: [] },
        callTool: () => {
          throw new Error("No tool call expected.");
        },
        onCompaction: () => undefined,
        deadlineMs: 60_000,
      });
      expect(outcome.end).toEqual({
        status: "failed",
        reason: "usage_limit",
        text: "Your ChatGPT plan's usage limit has been reached.",
        ...(reported && { resetsAt: "2026-10-10T07:35:00.000Z" }),
      });
    },
    // It starts the fake Codex: a busy machine can take seconds.
    120_000,
  );
});
