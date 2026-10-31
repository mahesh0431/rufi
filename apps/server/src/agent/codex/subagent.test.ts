// The reader's lock-down, proved on the pinned Codex binary itself, offline:
// a sub-agent turn against the local fake model, with the reader's real
// tools (core/documents/copy-reader.ts), page service and copies writer on a
// real database. It captures every request Codex sends the model and fails
// on any tool but get_page and save_page, also after a compaction; it checks
// a page image reaches the model, and that the tools' binding and the
// copies' write boundary hold. It runs in the chat's Codex home, as in Rufi,
// with the chat's skills and the AI's permission profile in it.
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  codexArgs,
  fakeModel,
  type FakeModel,
  type ModelRequest,
  type Step,
} from "../../../tests/fake-model.ts";
import type { Scenario } from "../../../tests/fake-codex.ts";
import { documents } from "../../core/documents/documents.ts";
import { copies } from "../../core/documents/copies.ts";
import { forCopying } from "../../core/documents/copy-reader.ts";
import type { Run } from "../../core/documents/notebook.ts";
import { pagePath } from "../../core/documents/originals.ts";
import { pages } from "../../core/documents/pages.ts";
import {
  databasePath,
  openWritable,
  type Store,
} from "../../core/store/database.ts";
import { mcpEndpoint, mcpKeys, serveMcp } from "../../server/mcp.ts";
import { SKILLS } from "../../core/skills/skills.ts";
import type { SubAgentOutcome } from "../runtime.ts";
import { codexBinary } from "./binary.ts";
import { callOf } from "./events.ts";
import { prepareCodexHome } from "./settings.ts";
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
/** Rufi's MCP server, as the core serves the reader's endpoint. */
let served: { port: number; close: () => Promise<void> } | undefined;
let keys: ReturnType<typeof mcpKeys>;
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
  await served?.close();
  served = undefined;
});

/** Tools for a run on the fake Codex: a key whose calls only count. */
async function counted(onCall: () => void) {
  const url = await endpoint();
  const key = keys.issue({
    tools: [],
    call: () => {
      onCall();
      return Promise.resolve({ ok: true, text: "{}" });
    },
  });
  return { url, key, names: ["get_page", "save_page"] };
}

/** The reader's endpoint; its address, for a key. */
async function endpoint() {
  keys = mcpKeys();
  let port = 0;
  served = await serveMcp(
    mcpEndpoint({ keys, port: () => port, log: () => undefined }),
  );
  port = served.port;
  return `http://127.0.0.1:${String(port)}/mcp/reader`;
}

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

/** Every page as stored: its entry and the reading that last saved it. */
const stored = () =>
  store.db
    .prepare(
      "SELECT person_id, position, entry, entry_job_id FROM document_pages ORDER BY person_id, position",
    )
    .all()
    .map((row) => ({ ...row }));

/** The reader's page copies as stored, by file page and reading. */
const storedCopies = () =>
  store.db
    .prepare(
      "SELECT person_id, page_in_file, job_id, attempt, outcome, copy FROM page_copies ORDER BY person_id, page_in_file",
    )
    .all()
    .map((row) => ({ ...row }));

/** Page 1 of Asha's report, as Rufi drew it. */
const drawn = () =>
  readFile(
    pagePath(
      root,
      store.db
        .prepare("SELECT file_id FROM document_pages WHERE document_id = ?")
        .get(documentId)?.["file_id"] as string,
      1,
    ),
  );

/** The chat's Codex home, which the reader shares, as the chat prepares it. */
const chatCodexHome = () =>
  prepareCodexHome(root, {
    userHome: join(root, "user-home"),
    sandbox: {
      folder: join(root, "ai"),
      unreadable: [join(root, "rufi.sqlite")],
    },
    skills: SKILLS,
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
  const reader = forCopying(
    run,
    pages(store, root),
    copies(store),
    () => undefined,
  );
  const answers: unknown[] = [];
  let calls = 0;
  const url = await endpoint();
  const key = keys.issue({
    tools: reader.specs,
    call: async ({ tool, input, meta }) => {
      before?.(++calls);
      const answer = await reader.call(tool, input, callOf(meta).callId);
      answers.push(JSON.parse(answer.text));
      return answer;
    },
  });
  const runner = subAgentRunner({
    home: root,
    command: {
      file: await codexBinary(),
      args: [
        ...codexArgs(model.url),
        ...config.flatMap((value) => ["-c", value]),
      ],
    },
    env: { PATH: process.env["PATH"] ?? "", HOME: join(root, "user-home") },
    codexHome: chatCodexHome,
    version: "0.0.0",
  });
  const outcome = await runner({
    model: readerModel,
    effort: "low",
    instructions: INSTRUCTIONS,
    input: INPUT,
    tools: { url, key, names: reader.specs.map((spec) => spec.name) },
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
  call: { namespace: "mcp__rufi", name, arguments: args },
  ...(tokens !== undefined && { tokens }),
});

/**
 * A script for exec: look at a page, then show its text and its image (an
 * MCP image block reaches the model only when the script shows it).
 */
const look = (page: number): Step => ({
  exec: `const answer = await tools.mcp__rufi__get_page({ page: ${String(page)} });
for (const part of answer.content) {
  if (part.type === "text") text(part.text);
  if (part.type === "image") image(part);
}`,
});

/** A script for exec: save a page's copy, and show Rufi's answer. */
const saveCopy = (page: number, copy: string, tokens?: number): Step => ({
  exec: `const answer = await tools.mcp__rufi__save_page(${JSON.stringify({ page, outcome: "read", copy })});
text(answer.content[0].text);`,
  ...(tokens !== undefined && { tokens }),
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

  it("can call only get_page, save_page and Codex's resource helpers (which find nothing), also after a compaction, sees the page image, and its copies hold", async () => {
    const run = job([1, 2]);
    const final = "# Sunrise Labs\n\n| Haemoglobin | 13.2 |";
    const { outcome, answers } = await read(
      run,
      [
        { call: { name: "list_mcp_resources", arguments: {} } },
        call("save_page", { page: 1, outcome: "read", copy: "# Sunrise Labs" }),
        call("get_page", { page: 1 }),
        call("get_page", { page: 9 }),
        call("get_page", { page: 1, document: "another" }),
        call("save_page", { page: 1, copy: "# Sunrise Labs" }),
        // Refusals so far changed nothing.
        call("save_page", {
          page: 1,
          outcome: "read",
          copy: "# Sunrise Labs\n\n| Haemoglobin | 1[3?].2 |",
        }),
        // The answer to this save reports usage over the limit: Codex compacts.
        call(
          "save_page",
          { page: 1, outcome: "read", copy: final },
          OVER_LIMIT,
        ),
        call("save_page", { page: 1, outcome: "read", copy: "lost" }),
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
        isCompaction(request)
          ? []
          : [
              "list_mcp_resource_templates",
              "list_mcp_resources",
              "mcp__rufi.get_page",
              "mcp__rufi.save_page",
              "read_mcp_resource",
            ],
      );
    }
    // Codex's own prompt with no personality (as a developer message), then
    // Rufi's instructions only, and no history (nor the chat's skills from the
    // Codex home they share): then just the task.
    const messages = requests[0]?.input.map((item) => [
      item.role,
      item.content,
    ]);
    expect(messages?.[0]?.[0]).toBe("developer");
    const prompt = JSON.stringify(messages?.[0]?.[1]);
    expect(prompt).toMatch(/^\[\{"type":"input_text","text":"You are Codex/);
    expect(prompt).not.toContain("# Personality\\n");
    expect(messages?.slice(1)).toEqual([
      ["developer", [{ type: "input_text", text: INSTRUCTIONS }]],
      ["user", [{ type: "input_text", text: INPUT }]],
    ]);

    // Codex's resource helper reached nothing: the endpoint offers none.
    expect(requests[1]?.input.at(-1)).toMatchObject({
      type: "function_call_output",
      output: '{"resources":[]}',
    });
    // The page image reached the model with the page's text, as Rufi drew it.
    const shown = requests[3]?.input.at(-1);
    expect(shown?.type).toBe("function_call_output");
    const output = shown?.output as {
      type: string;
      text?: string;
      image_url?: string;
    }[];
    expect(output.map((part) => part.type)).toEqual([
      "input_text",
      "input_text",
      "input_image",
    ]);
    expect(output[1]?.text).toContain("Sunrise Labs · Test report · page 1");
    expect(output[2]?.image_url).toBe(
      `data:image/png;base64,${(await drawn()).toString("base64")}`,
    );

    // Each refusal says why; nothing changed until the first valid save.
    const errors = answers.map((a) => (a as { error?: string }).error);
    expect(errors[0]).toBe("Look at page 1 with get_page first, then save it.");
    expect(errors[2]).toBe("This document has no page 9; its pages are 1–2.");
    expect(errors[3]).toBe("The input for get_page isn't valid.");
    expect(errors[4]).toBe("The input for save_page isn't valid.");
    // After the compaction, page 1 must be looked at again before a save.
    expect(errors[7]).toBe("Look at page 1 with get_page first, then save it.");
    // Replaced in place within the reading: one copy, the last saved
    // before the compaction, by its file page and this reading.
    expect(storedCopies()).toEqual([
      {
        person_id: "asha",
        page_in_file: 1,
        job_id: jobId,
        attempt: 1,
        outcome: "read",
        copy: final,
      },
    ]);
    // The page says this run saved it; Ravi's report is untouched.
    expect(stored()).toEqual([
      { person_id: "asha", position: 1, entry: null, entry_job_id: jobId },
      { person_id: "asha", position: 2, entry: null, entry_job_id: null },
      { person_id: "ravi", position: 1, entry: null, entry_job_id: null },
    ]);
    // The look after the compaction shows the saved copy.
    expect(answers[8]).toMatchObject({
      ok: true,
      result: {
        page: 1,
        saved_copy: { outcome: "read", copy: final },
        saved: "1",
        still_to_save: "2",
      },
    });
  }, 120_000);

  it("saves no copy for a page outside the job's targets, another run, or a closed run", async () => {
    const run = job([1]);
    const copy = (page: number, text: string) =>
      call("save_page", { page, outcome: "read", copy: text });
    const { outcome, answers } = await read(
      run,
      [
        // Page 2 may be looked at for context, but this job doesn't save it.
        call("get_page", { page: 2 }),
        copy(2, "page two"),
        call("get_page", { page: 1 }),
        // Before this call, another run of the job has started.
        copy(1, "another run"),
        // Before this call, Rufi has closed the run.
        copy(1, "closed"),
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
    const late = await forCopying(
      run,
      pages(store, root),
      copies(store),
      () => undefined,
    ).call("save_page", { page: 1, outcome: "read", copy: "late" });
    expect(JSON.parse(late.text)).toMatchObject({
      ok: false,
      error: "This reading has ended; nothing more is saved.",
    });
    expect(storedCopies()).toEqual([]);
    expect(stored().every((p) => p["entry_job_id"] === null)).toBe(true);
  }, 120_000);

  it("on a code-mode model, can reach only its two tools and Codex's pinned set through exec, also after a compaction, and sees the page image it shows", async () => {
    const run = job([1, 2]);
    const { outcome } = await read(
      run,
      [
        look(1),
        saveCopy(1, "# Sunrise Labs"),
        // The answer to this save reports usage over the limit: Codex compacts.
        saveCopy(1, "# Sunrise Labs\n\nHaemoglobin 13.2 g/dL", OVER_LIMIT),
        look(1),
        { text: "Done." },
      ],
      undefined,
      CODE_MODEL,
    );

    expect(outcome.end).toEqual({ status: "completed" });
    expect(outcome.compactions).toBe(1);

    // The complete exposed set, in every request, also after the compaction:
    // exec and wait run Rufi's tools (declared in exec's description, not
    // deferred) and Codex's resource helpers. No question to the person: Codex
    // honours the reader's request_user_input setting for it too.
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
        "functions.wait",
      ]);
      expect(inExec(request), where).toEqual([
        "clock__curr_time",
        "list_mcp_resource_templates",
        "list_mcp_resources",
        "mcp__rufi__get_page",
        "mcp__rufi__save_page",
        "read_mcp_resource",
      ]);
    }
    // Codex's own prompt with no personality (this model takes it as a
    // developer message), then Rufi's instructions only, and no history:
    // then just the task.
    const messages = requests[0]?.input
      .filter((item) => item.type === "message")
      .map((item) => [item.role, item.content]);
    expect(messages?.[0]?.[0]).toBe("developer");
    const prompt = JSON.stringify(messages?.[0]?.[1]);
    expect(prompt).toMatch(/^\[\{"type":"input_text","text":"You are Codex/);
    expect(prompt).not.toContain("# Personality\\n");
    expect(messages?.slice(1)).toEqual([
      ["developer", [{ type: "input_text", text: INSTRUCTIONS }]],
      ["user", [{ type: "input_text", text: INPUT }]],
    ]);

    // The page image reached the model, as Rufi drew it, through exec.
    const shown = requests[1]?.input.at(-1);
    expect(shown?.type).toBe("custom_tool_call_output");
    const output = shown?.output as { type: string; image_url?: string }[];
    expect(output.filter((part) => part.type === "input_image")).toEqual([
      expect.objectContaining({
        image_url: `data:image/png;base64,${(await drawn()).toString("base64")}`,
      }),
    ]);
    // The saves through exec reached the copies.
    expect(storedCopies()).toEqual([
      expect.objectContaining({
        job_id: jobId,
        copy: "# Sunrise Labs\n\nHaemoglobin 13.2 g/dL",
      }),
    ]);
  }, 120_000);

  it("gives a code-mode reader no way to ask the person a question", async () => {
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
    // Codex doesn't offer the question tool and refuses a call to it, so no
    // question reaches anyone and the reader goes on.
    expect(model?.requests[1]?.input.at(-1)).toMatchObject({
      type: "function_call_output",
      output: "unsupported call: request_user_input_async",
    });
    expect(outcome.end).toEqual({ status: "completed" });
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
    [MODEL, { status: "failed", reason: "provider_failed" }],
    [CODE_MODEL, { status: "completed" }],
  ] as const)(
    "a call made through exec, on %s: %o",
    async (readerModel, end) => {
      const scenario: Scenario = {
        bare: true,
        calls: [{ id: "exec-1", tool: "get_page", arguments: { page: 1 } }],
      };
      // Codex calls Rufi's server itself, so the call reaches the tool on
      // either route; on the direct route it fails the turn (no drafts).
      const tools = await counted(() => undefined);
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
        codexHome: chatCodexHome,
        version: "0.0.0",
      })({
        model: readerModel,
        effort: "low",
        instructions: INSTRUCTIONS,
        input: INPUT,
        tools,
        onCompaction: () => undefined,
        deadlineMs: 60_000,
      });
      expect(outcome.end, outcome.end.text).toMatchObject(end);
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
        codexHome: chatCodexHome,
        version: "0.0.0",
      });
      const outcome = await runner({
        model: MODEL,
        effort: "low",
        instructions: INSTRUCTIONS,
        input: "fail",
        tools: await counted(() => {
          throw new Error("No tool call expected.");
        }),
        onCompaction: () => undefined,
        deadlineMs: 60_000,
      });
      expect(outcome.end).toEqual({
        status: "failed",
        reason: "usage_limit",
        text: "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
        ...(reported && { resetsAt: "2026-10-10T07:35:00.000Z" }),
      });
    },
    // It starts the fake Codex: a busy machine can take seconds.
    120_000,
  );
});

describe("the reader's turn when Codex's lines come together", () => {
  // Codex's answer to turn/start, turn/started and the turn's first lines
  // can arrive in one read: the turn is still the reader's.
  const log = () => join(root, "fake-codex.jsonl");
  const run = async (
    scenario: Scenario,
    input: string,
    callTool: () => void,
    signal?: AbortSignal,
  ) =>
    subAgentRunner({
      home: root,
      command: {
        file: process.execPath,
        args: [join(import.meta.dirname, "../../../tests/fake-codex.ts")],
      },
      env: {
        PATH: process.env["PATH"] ?? "",
        FAKE_CODEX: JSON.stringify({ ...scenario, together: true }),
        FAKE_CODEX_LOG: log(),
      },
      codexHome: chatCodexHome,
      version: "0.0.0",
    })(
      {
        model: MODEL,
        effort: "low",
        instructions: INSTRUCTIONS,
        input,
        tools: await counted(callTool),
        onCompaction: () => undefined,
        // Well under the test's own timeout: an end missed waits for this.
        deadlineMs: 20_000,
      },
      signal,
    );
  /** What the fake Codex received from Rufi, in order. */
  const received = async () =>
    (await readFile(log(), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const { received } = JSON.parse(line) as {
          received?: { method?: string; params?: Record<string, unknown> };
        };
        return received?.method === undefined ? [] : [received];
      });

  it("runs the turn's first tool call", async () => {
    let called = 0;
    const outcome = await run(
      {
        bare: true,
        calls: [{ tool: "get_page", arguments: { page: 1 } }],
      },
      INPUT,
      () => called++,
    );
    expect(outcome.end, outcome.end.text).toMatchObject({
      status: "completed",
    });
    expect(called).toBe(1);
  }, 120_000);

  it("ends at once on a usage limit, with its reset time", async () => {
    const outcome = await run({ resetsAt: 1_791_617_700 }, "fail", () => {
      throw new Error("No tool call expected.");
    });
    expect(outcome.end).toMatchObject({
      reason: "usage_limit",
      resetsAt: "2026-10-10T07:35:00.000Z",
    });
  }, 120_000);

  it("ends a turn stopped while it starts, with one interrupt", async () => {
    const stop = new AbortController();
    const outcome = run(
      { bare: true, slow: ["turn/start"], slowMs: 250 },
      "hang",
      () => {
        throw new Error("No tool call expected.");
      },
      stop.signal,
    );
    // Stopped once Codex has the turn/start, before its answer comes back
    // with turn/started in the same read: either names the turn.
    await vi.waitFor(
      async () => {
        expect((await received()).map((m) => m.method)).toContain("turn/start");
      },
      { timeout: 10_000, interval: 5 },
    );
    stop.abort();
    expect((await outcome).end).toEqual({
      status: "interrupted",
      reason: "stopped",
      text: "Stopped.",
    });
    const messages = await received();
    const start = messages.find((m) => m.method === "turn/start");
    expect(
      messages
        .filter((m) => m.method === "turn/interrupt")
        .map((m) => m.params),
    ).toEqual([
      {
        threadId: start?.params?.["threadId"],
        turnId: expect.stringMatching(/^turn-1-/) as string,
      },
    ]);
  }, 120_000);
});
