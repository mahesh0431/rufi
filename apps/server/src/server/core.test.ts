// The core as the screens will meet it: started in a scope on a fictional
// data folder with the scripted Codex, and used over HTTP like a browser.
import { spawn } from "node:child_process";
import { request as httpRequest, type IncomingMessage } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import type { StreamLine } from "@rufi/contracts";
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexRuntime } from "../agent/codex/codex.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
} from "../core/store/database.ts";
import { holdRufiLock } from "../platform/files.ts";
import { diagnostics } from "../platform/logs.ts";
import { LAUNCHER_HEADER, PROOF_HEADER } from "./api.ts";
import {
  coreFile,
  runningLink,
  startCore,
  type Core,
  type CoreOptions,
} from "./core.ts";

const FAKE = join(import.meta.dirname, "../../tests/fake-codex.ts");

let home: string;
let scope: Scope.Closeable | undefined;
let logged: string[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-core-"));
  logged = [];
});
afterEach(async () => {
  await stop();
});

async function start(options: Partial<CoreOptions> = {}): Promise<Core> {
  const opened = await Effect.runPromise(Scope.make());
  const core = await Effect.runPromise(
    startCore({
      home,
      agent: (tools, host) =>
        codexRuntime({
          home,
          command: { file: process.execPath, args: [FAKE] },
          env: { PATH: process.env["PATH"] ?? "", FAKE_CODEX: "{}" },
          token: () => Promise.resolve("token"),
          version: "0.0.0",
          tools,
          host,
        }),
      log: (event) => logged.push(event),
      ...options,
    }).pipe(Scope.provide(opened)),
  ).catch(async (error: unknown) => {
    await Effect.runPromise(Scope.close(opened, Exit.void));
    throw error;
  });
  scope = opened;
  return core;
}

async function stop(): Promise<void> {
  const open = scope;
  scope = undefined;
  if (open) await Effect.runPromise(Scope.close(open, Exit.void));
}

interface Reply {
  status: number;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
  text: string;
}

/** One HTTP request, with every header as given (a browser's would differ). */
function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { host: `127.0.0.1:${String(port)}`, ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          const json =
            res.headers["content-type"]?.startsWith("application/json");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: json ? (JSON.parse(text) as Record<string, unknown>) : {},
            text,
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.setHeader("content-type", "application/json");
      req.end(JSON.stringify(body));
    } else req.end();
  });
}

/** A page's session: its cookie and its tab proof. */
async function session(core: Pick<Core, "port" | "launchUrl">) {
  const launch =
    new URLSearchParams(new URL(core.launchUrl()).hash.slice(1)).get(
      "launch",
    ) ?? "";
  const origin = `http://127.0.0.1:${String(core.port)}`;
  const swapped = await call(
    core.port,
    "POST",
    "/api/session",
    { origin },
    { launch },
  );
  const cookie = String(swapped.headers["set-cookie"]?.[0]).split(";")[0] ?? "";
  const proof = String(swapped.body["proof"]);
  const headers = { origin, cookie, [PROOF_HEADER]: proof };
  return {
    launch,
    cookie,
    proof,
    headers,
    api: (method: string, path: string, body?: unknown) =>
      call(core.port, method, path, headers, body),
  };
}

/** A live stream: its lines as they come, and a way to hang up. */
function stream(port: number, path: string, headers: Record<string, string>) {
  const lines: StreamLine[] = [];
  let response: IncomingMessage | undefined;
  const ended = Promise.withResolvers<undefined>();
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path,
      headers: { host: `127.0.0.1:${String(port)}`, ...headers },
    },
    (res) => {
      response = res;
      createInterface({ input: res })
        .on("line", (line) => {
          lines.push(JSON.parse(line) as StreamLine);
        })
        // The reader passes a cut connection on as an error.
        .on("error", () => {
          ended.resolve(undefined);
        });
      res.on("close", () => {
        ended.resolve(undefined);
      });
      // A cut connection can also surface as a response error.
      res.on("error", () => {
        ended.resolve(undefined);
      });
    },
  );
  // Hanging up, or being cut off, ends the stream; that's not an error here.
  req.on("error", () => {
    ended.resolve(undefined);
  });
  // The socket can close before the response reports the cut.
  req.on("socket", (socket) => {
    socket.on("close", () => {
      ended.resolve(undefined);
    });
  });
  req.end();
  return {
    lines,
    ended: ended.promise,
    pause: () => response?.pause(),
    resume: () => response?.resume(),
    hangUp: () => {
      req.destroy();
    },
  };
}

/** The reply text a screen shows after applying the lines in order. */
function replyText(lines: StreamLine[]): string {
  const entries = new Map<
    string,
    { kind: string; text: string; seq: number }
  >();
  for (const line of lines) {
    if (line.type === "snapshot") {
      entries.clear();
      for (const e of line.entries) entries.set(e.id, e);
    }
    if (line.type === "update")
      for (const e of line.entries) entries.set(e.id, e);
  }
  return [...entries.values()]
    .filter((e) => e.kind === "reply")
    .sort((a, b) => a.seq - b.seq)
    .map((e) => e.text)
    .join("");
}

async function until(
  ready: () => boolean | Promise<boolean>,
  ms = 10_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
}

/** A person with one conversation, through the API. */
async function conversation(page: Awaited<ReturnType<typeof session>>) {
  const person = (
    await page.api("POST", "/api/people", { displayName: "Asha Fictional" })
  ).body["person"] as { id: string };
  const created = (
    await page.api("POST", `/api/people/${person.id}/conversations`, {})
  ).body["conversation"] as { id: string };
  return {
    person: person.id,
    id: created.id,
    path: `/api/people/${person.id}/conversations/${created.id}`,
  };
}

describe("the core", () => {
  it("creates the database for this user only, and holds rufi.lock while it runs", async () => {
    await start();
    expect(openReadOnly(databasePath(home))).toBeDefined();
    for (const file of ["rufi.sqlite", "rufi.sqlite-wal", "rufi.sqlite-shm"]) {
      expect((await stat(join(home, file))).mode & 0o777).toBe(0o600);
    }
    await expect(start()).rejects.toThrow(
      "Rufi is already running with this data folder",
    );
    // A terminal command is refused too.
    await expect(holdRufiLock(home, () => undefined)).rejects.toThrow(
      "already running",
    );
    await stop();
    const release = await holdRufiLock(home, () => undefined);
    await release();
  });

  it("marks replies cut off by a crash as interrupted when it starts", async () => {
    // What a crash leaves: a reply still marked running.
    const left = openWritable(databasePath(home));
    left.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
      INSERT INTO conversations (id, person_id, title, provider, model, created_at)
        VALUES ('c-1', 'asha', 'Fictional', 'codex', 'gpt-6.1-sol', '2026-10-04T10:00:00Z');
      INSERT INTO turns (id, person_id, conversation_id, agent_turn_id, model, status, started_at)
        VALUES ('t-1', 'asha', 'c-1', 'turn-1', 'gpt-6.1-sol', 'running', '2026-10-04T10:00:00Z');`);
    left.close();
    const core = await start();
    const page = await session(core);
    expect(
      (await page.api("GET", "/api/people/asha/conversations/c-1")).body[
        "turns"
      ],
    ).toMatchObject([
      {
        status: "interrupted",
        endText: "Rufi closed before the reply finished.",
      },
    ]);
  });

  it(
    "stops writing at once when it loses rufi.lock",
    { timeout: 20_000 },
    async () => {
      const core = await start();
      const page = await session(core);
      expect(
        (
          await page.api("POST", "/api/people", {
            displayName: "Asha Fictional",
          })
        ).status,
      ).toBe(201);
      await rm(join(home, "rufi.lock"), { recursive: true });
      // The lock is checked every few seconds.
      await until(() => logged.includes("core.lock_lost"), 15_000);
      const refused = await page.api("POST", "/api/people", {
        displayName: "Ravi Fictional",
      });
      expect(refused.status).toBe(500);
    },
  );

  it("closes every part when it stops, even when one of them fails", async () => {
    let agent: AgentRuntime | undefined;
    const core = await start({
      agent: (tools, host) => {
        agent = codexRuntime({
          home,
          command: { file: process.execPath, args: [FAKE] },
          env: { PATH: process.env["PATH"] ?? "", FAKE_CODEX: "{}" },
          token: () => Promise.resolve("token"),
          version: "0.0.0",
          tools,
          host,
        });
        return {
          ...agent,
          close: () => Promise.reject(new Error("close failed")),
        };
      },
    });
    const port = core.port;
    // The failure is reported; every other part is closed all the same.
    await expect(stop()).rejects.toThrow("close failed");
    await expect(call(port, "GET", "/api/people")).rejects.toThrow();
    const release = await holdRufiLock(home, () => undefined);
    await release();
    await agent?.close();
  });
});

describe("the local API", () => {
  it("needs both proofs: the cookie and the tab's proof", async () => {
    const core = await start();
    const page = await session(core);
    expect((await page.api("GET", "/api/people")).status).toBe(200);
    const { origin } = page.headers;
    expect((await call(core.port, "GET", "/api/people")).status).toBe(401);
    expect(
      (await call(core.port, "GET", "/api/people", { cookie: page.cookie }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(core.port, "GET", "/api/people", {
          [PROOF_HEADER]: page.proof,
        })
      ).status,
    ).toBe(401);
    // A launch link works once.
    const again = await call(
      core.port,
      "POST",
      "/api/session",
      { origin },
      { launch: page.launch },
    );
    expect(again.status).toBe(401);
  });

  it("refuses another host, another origin and forwarded requests", async () => {
    const core = await start();
    const page = await session(core);
    expect(
      (
        await call(core.port, "GET", "/api/people", {
          ...page.headers,
          host: "localhost",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          core.port,
          "POST",
          "/api/people",
          { ...page.headers, origin: "http://evil.example" },
          { displayName: "X" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(core.port, "GET", "/api/people", {
          ...page.headers,
          "x-forwarded-for": "1.2.3.4",
        })
      ).status,
    ).toBe(400);
  });

  it("sends a strict CSP, and API answers are never cached", async () => {
    const core = await start();
    const page = await session(core);
    const reply = await page.api("GET", "/api/people");
    expect(reply.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(reply.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(reply.headers["cache-control"]).toBe("no-store");
  });

  it("finds a conversation only under its own person", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    const ravi = (
      await page.api("POST", "/api/people", { displayName: "Ravi Fictional" })
    ).body["person"] as {
      id: string;
    };
    expect((await page.api("GET", c.path)).status).toBe(200);
    expect(
      (await page.api("GET", `/api/people/${ravi.id}/conversations/${c.id}`))
        .status,
    ).toBe(404);
    expect(
      (
        await page.api(
          "POST",
          `/api/people/${ravi.id}/conversations/${c.id}/messages`,
          { text: "Hi" },
        )
      ).status,
    ).toBe(404);
  });

  it("takes a message at the limit and stores it whole", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    const text = `${"é".repeat(9_999)}x`;
    expect(
      (await page.api("POST", `${c.path}/messages`, { text })).status,
    ).toBe(202);
    await until(async () => {
      const { body } = await page.api("GET", c.path);
      const entries = body["entries"] as { kind: string; text: string }[];
      return entries.some((e) => e.kind === "reply");
    });
    const { body } = await page.api("GET", c.path);
    const entries = body["entries"] as { kind: string; text: string }[];
    expect(entries.find((e) => e.kind === "message")?.text).toBe(text);
  });

  it("refuses requests that don't match their contract", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    expect(
      (await page.api("POST", `${c.path}/messages`, { text: "" })).status,
    ).toBe(400);
    const tooLong = await page.api("POST", `${c.path}/messages`, {
      text: "x".repeat(10_001),
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toEqual({
      error: "A message needs some text, and can be at most 10,000 characters.",
    });
    // Only regions Rufi knows, not names every object has.
    for (const emergencyRegion of ["ZZ", "toString"]) {
      expect(
        (await page.api("PUT", "/api/settings", { emergencyRegion })).status,
      ).toBe(400);
    }
  });

  it("keeps a draft per conversation and one for a new conversation, and refuses a save based on an older revision", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    const drafts = `/api/people/${c.person}/drafts`;
    expect((await page.api("GET", `${drafts}/new`)).body).toEqual({
      text: "",
      revision: 0,
    });
    expect(
      (await page.api("PUT", `${drafts}/new`, { text: "Start", revision: 0 }))
        .body,
    ).toEqual({ text: "Start", revision: 1 });
    await page.api("PUT", `${drafts}/new`, { text: "Start here", revision: 1 });
    await page.api("PUT", `${drafts}/${c.id}`, {
      text: "Half written",
      revision: 0,
    });
    expect((await page.api("GET", `${drafts}/new`)).body).toEqual({
      text: "Start here",
      revision: 2,
    });
    expect((await page.api("GET", `${drafts}/${c.id}`)).body).toEqual({
      text: "Half written",
      revision: 1,
    });
    // Another tab, still at revision 1: refused, with the draft as it is now.
    const stale = await page.api("PUT", `${drafts}/new`, {
      text: "Older text",
      revision: 1,
    });
    expect(stale).toMatchObject({
      status: 409,
      body: {
        error: "Changed in another tab.",
        draft: { text: "Start here", revision: 2 },
      },
    });
    // Emptied, a draft keeps its revision moving.
    await page.api("PUT", `${drafts}/new`, { text: "", revision: 2 });
    expect(
      (await page.api("PUT", `${drafts}/new`, { text: "x", revision: 2 }))
        .status,
    ).toBe(409);

    // A tab's last save as the page goes follows the tab's own save that was
    // still on its way, whichever arrives first; never another tab's save.
    const save = (text: string, revision: number, more: object = {}) =>
      page.api("PUT", `${drafts}/${c.id}`, { text, revision, ...more });
    const tabA = { tab: "tab-a" };
    const leavingA = { tab: "tab-a", leaving: true };
    await save("Questions", 1, tabA);
    expect((await save("Questions for", 1, leavingA)).body).toEqual({
      text: "Questions for",
      revision: 3,
    });
    expect((await save("Questions for my", 3, leavingA)).status).toBe(200);
    expect((await save("Questions for m", 3, tabA)).status).toBe(409);
    await save("From tab B", 4, { tab: "tab-b" });
    expect((await save("Questions for my visit", 4, leavingA)).status).toBe(
      409,
    );
    expect((await page.api("GET", `${drafts}/${c.id}`)).body).toEqual({
      text: "From tab B",
      revision: 5,
    });
  });

  it("clears the box's draft when its message is taken, unless another tab changed it meanwhile", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    const draft = `/api/people/${c.person}/drafts/${c.id}`;
    await page.api("PUT", draft, { text: "Fir", revision: 0 });
    // The box's text is the draft until the agent took it, then cleared.
    const sent = await page.api("POST", `${c.path}/messages`, {
      text: "First",
      draft: 1,
    });
    expect(sent.status).toBe(202);
    expect(sent.body["draft"]).toEqual({ text: "", revision: 3 });

    // Not taken: the draft keeps the text, and the answer says so.
    const refused = await page.api("POST", `${c.path}/steer`, {
      text: "Only the latest results",
      draft: 3,
    });
    expect(refused).toMatchObject({
      status: 409,
      body: {
        error: "No reply is running to steer.",
        draft: { text: "Only the latest results", revision: 4 },
      },
    });

    // The box saw revision 4; another tab saved after it.
    await page.api("PUT", draft, { text: "Other tab", revision: 4 });
    const second = await page.api("POST", `${c.path}/messages`, {
      text: "Second",
      draft: 4,
    });
    expect(second.body["draft"]).toEqual({ text: "Other tab", revision: 5 });
    expect((await page.api("GET", draft)).body).toEqual({
      text: "Other tab",
      revision: 5,
    });
  });

  it("starts a conversation with its first message, titles it from its first words, and the chat continues it", async () => {
    const core = await start();
    const page = await session(core);
    const asha = (
      await page.api("POST", "/api/people", { displayName: "Asha Fictional" })
    ).body["person"] as { id: string };
    const people = `/api/people/${asha.id}`;
    await page.api("PUT", `${people}/drafts/new`, {
      text: "draft",
      revision: 0,
    });
    const text =
      "Is my **TSH** still high after the lab [amended](https://example.com/lab) it in August?\nAnd the Free T4?";
    const started = await page.api(
      "POST",
      `${people}/conversations/new/messages`,
      { text, draft: 1, model: "gpt-6-astra" },
    );
    expect(started.status).toBe(202);
    const created = started.body["conversation"] as {
      id: string;
      title: string;
      model: string;
    };
    expect(created).toMatchObject({
      title: "Is my TSH still high after the lab amended it in August?",
      model: "gpt-6-astra",
    });
    expect(started.body["draft"]).toEqual({ text: "", revision: 2 });
    expect((await page.api("GET", `${people}/drafts/new`)).body).toEqual({
      text: "",
      revision: 2,
    });
    const listed = (await page.api("GET", `${people}/conversations`)).body;
    expect(listed["chosen"]).toBe(created.id);
    expect(listed["conversations"]).toEqual([started.body["conversation"]]);

    // A long first line is cut at a word; a later message keeps the title.
    const path = `${people}/conversations/${created.id}`;
    await until(async () =>
      (
        (await page.api("GET", path)).body["turns"] as { status: string }[]
      ).every((turn) => turn.status !== "running"),
    );
    await page.api("POST", `${path}/messages`, { text: "Something else" });
    const long = await page.api(
      "POST",
      `${people}/conversations/new/messages`,
      {
        text: `${"word ".repeat(20)}end`,
      },
    );
    expect((long.body["conversation"] as { title: string }).title).toBe(
      `${"word ".repeat(12).trimEnd()}…`,
    );
    expect(
      ((await page.api("GET", path)).body["conversation"] as { title: string })
        .title,
    ).toBe("Is my TSH still high after the lab amended it in August?");
  });

  it("keeps a new conversation whose first message wasn't taken, with the message as its draft", async () => {
    const core = await start({
      agent: (tools, host) =>
        codexRuntime({
          home,
          command: { file: process.execPath, args: [FAKE] },
          env: {
            PATH: process.env["PATH"] ?? "",
            FAKE_CODEX: JSON.stringify({ hang: ["thread/queue/add"] }),
          },
          token: () => Promise.resolve("token"),
          version: "0.0.0",
          deadlines: { requestMs: 500 },
          tools,
          host,
        }),
    });
    const page = await session(core);
    const asha = (
      await page.api("POST", "/api/people", { displayName: "Asha Fictional" })
    ).body["person"] as { id: string };
    const people = `/api/people/${asha.id}`;
    const refused = await page.api(
      "POST",
      `${people}/conversations/new/messages`,
      { text: "Hello" },
    );
    expect(refused.status).toBe(502);
    const kept = refused.body["conversation"] as { id: string; title: null };
    expect(kept.title).toBeNull();
    expect(refused.body["draft"]).toEqual({ text: "Hello", revision: 1 });
    expect((await page.api("GET", `${people}/drafts/${kept.id}`)).body).toEqual(
      { text: "Hello", revision: 1 },
    );
    expect(
      (await page.api("GET", `${people}/conversations`)).body["chosen"],
    ).toBe(kept.id);
  });

  it(
    "keeps a new conversation's first message as its draft when the core dies before the agent took it",
    { timeout: 20_000 },
    async () => {
      // A core of its own, whose Codex never answers thread/start.
      const child = spawn(
        process.execPath,
        [join(import.meta.dirname, "../../tests/core-process.ts"), home],
        {
          env: {
            ...process.env,
            FAKE_CODEX: JSON.stringify({ hang: ["thread/start"] }),
          },
          stdio: "ignore",
        },
      );
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try {
        let link: string | undefined;
        await until(async () => (link = await runningLink(home)) !== undefined);
        const page = await session({
          port: Number(new URL(link ?? "").port),
          launchUrl: () => link ?? "",
        });
        const { id } = (
          await page.api("POST", "/api/people", { displayName: "Asha" })
        ).body["person"] as { id: string };
        await page.api("PUT", `/api/people/${id}/drafts/new`, {
          text: "Questions for my visit",
          revision: 0,
        });
        void page
          .api("POST", `/api/people/${id}/conversations/new/messages`, {
            text: "Questions for my visit",
            draft: 1,
          })
          .catch(() => undefined);
        // The conversation is there: the agent is starting its thread.
        await until(
          async () =>
            (await page.api("GET", `/api/people/${id}/conversations`)).body[
              "chosen"
            ] !== null,
        );
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      // The crash's lock would go stale in 10 s; Rufi starts again.
      await rm(join(home, "rufi.lock"), { recursive: true, force: true });
      const page = await session(await start());
      const asha = (
        (await page.api("GET", "/api/people")).body["people"] as {
          id: string;
        }[]
      )[0]?.id;
      const people = `/api/people/${asha ?? ""}`;
      const { chosen } = (await page.api("GET", `${people}/conversations`))
        .body as { chosen: string };
      expect(
        (await page.api("GET", `${people}/drafts/${chosen}`)).body,
      ).toEqual({ text: "Questions for my visit", revision: 1 });
      expect((await page.api("GET", `${people}/drafts/new`)).body).toEqual({
        text: "",
        revision: 2,
      });
    },
  );

  it("remembers the conversation the chat continues, for that person only", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    const list = `/api/people/${c.person}/conversations`;
    expect((await page.api("GET", list)).body["chosen"]).toBeNull();
    const chosen = `/api/people/${c.person}/chosen`;
    await page.api("PUT", chosen, { conversationId: c.id });
    expect((await page.api("GET", list)).body["chosen"]).toBe(c.id);

    const ravi = (
      await page.api("POST", "/api/people", { displayName: "Ravi Fictional" })
    ).body["person"] as { id: string };
    expect(
      (
        await page.api("PUT", `/api/people/${ravi.id}/chosen`, {
          conversationId: c.id,
        })
      ).status,
    ).toBe(404);

    await page.api("PUT", chosen, { conversationId: null });
    expect((await page.api("GET", list)).body["chosen"]).toBeNull();
  });

  it("offers the allowed models, and says when the allowlist is broken", async () => {
    const core = await start();
    const page = await session(core);
    expect((await page.api("GET", "/api/models")).body).toEqual({
      models: [
        { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
        { id: "gpt-6-astra", name: "GPT-6-Astra" },
      ],
      allowlistError: null,
    });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(home, "models.json"), "{ broken");
    const broken = (await page.api("GET", "/api/models")).body;
    expect(broken["models"]).toHaveLength(2);
    expect(String(broken["allowlistError"])).toContain(
      "models.json isn't valid JSON",
    );
  });

  it("shows the waiting messages and lets the person act on them", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    expect(
      (await page.api("POST", `${c.path}/messages`, { text: "hang" })).status,
    ).toBe(202);
    await until(
      async () =>
        ((await page.api("GET", c.path)).body["turns"] as unknown[]).length > 0,
    );
    await page.api("POST", `${c.path}/messages`, { text: "B" });
    const waiting = (await page.api("GET", `${c.path}/waiting`)).body[
      "messages"
    ] as { id: string; text: string }[];
    expect(waiting.map((w) => w.text)).toEqual(["B"]);
    expect(
      (
        await page.api("PUT", `${c.path}/waiting/${waiting[0]?.id ?? ""}`, {
          text: "B2",
        })
      ).status,
    ).toBe(200);
    expect(
      (await page.api("POST", `${c.path}/steer`, { text: "faster" })).status,
    ).toBe(200);
    expect(
      (await page.api("PUT", `${c.path}/model`, { model: "gpt-6-astra" }))
        .status,
    ).toBe(409);
    expect((await page.api("POST", `${c.path}/stop`)).status).toBe(200);
    expect(
      (await page.api("DELETE", `${c.path}/waiting/${waiting[0]?.id ?? ""}`))
        .status,
    ).toBe(200);
    expect(
      (await page.api("GET", `${c.path}/waiting`)).body["messages"],
    ).toEqual([]);
    // A harness error is shown as it is.
    const steer = await page.api("POST", `${c.path}/steer`, {
      text: "nothing runs",
    });
    expect(steer).toMatchObject({
      status: 409,
      body: { error: "No reply is running to steer." },
    });
  });

  it("streams a snapshot, then every change after it, with no gap", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    const live = stream(core.port, `${c.path}/stream`, page.headers);
    await until(() => live.lines.length > 0);
    expect(live.lines[0]).toMatchObject({
      type: "snapshot",
      revision: 0,
      entries: [],
      turns: [],
    });
    await page.api("POST", `${c.path}/messages`, { text: "drip" });
    await until(() => replyText(live.lines) === "ok:drip");
    const revisions = live.lines.flatMap((l) =>
      l.type === "update" ? [l.revision] : [],
    );
    expect(revisions).toEqual(revisions.map((_, i) => i + 1));
    live.hangUp();
  });

  it("tells an open stream when the conversation's title or model changes", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    const live = stream(core.port, `${c.path}/stream`, page.headers);
    await until(() => live.lines.length > 0);
    expect(live.lines[0]).toMatchObject({ conversation: { title: null } });
    const changed = () =>
      live.lines.flatMap((line) =>
        line.type === "update" && line.conversation ? [line.conversation] : [],
      );
    await page.api("POST", `${c.path}/messages`, { text: "Hello there" });
    await until(() => changed().length === 1);
    expect(changed()[0]).toMatchObject({ title: "Hello there" });
    await until(async () =>
      (
        (await page.api("GET", c.path)).body["turns"] as { status: string }[]
      ).every((turn) => turn.status === "completed"),
    );
    await page.api("PUT", `${c.path}/model`, { model: "gpt-6-astra" });
    await until(() => changed().length === 2);
    expect(changed()[1]).toMatchObject({
      title: "Hello there",
      model: "gpt-6-astra",
    });
    live.hangUp();
  });

  it("gives a screen that reconnects during a reply the text so far, then the rest", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    const first = stream(core.port, `${c.path}/stream`, page.headers);
    await until(() => first.lines.length > 0);
    await page.api("POST", `${c.path}/messages`, { text: "drip" });
    await until(() => replyText(first.lines).length >= 4);
    first.hangUp();
    const second = stream(core.port, `${c.path}/stream`, page.headers);
    await until(() => second.lines.length > 0);
    const snapshot = second.lines[0];
    expect(snapshot?.type).toBe("snapshot");
    expect("ok:drip".startsWith(replyText(second.lines.slice(0, 1)))).toBe(
      true,
    );
    await until(() => replyText(second.lines) === "ok:drip");
    second.hangUp();
  });

  it(
    "closes the stream of a screen that falls behind; it reloads without gaps",
    { timeout: 60_000 },
    async () => {
      const core = await start({ behindMax: 20 });
      const page = await session(core);
      const c = await conversation(page);
      const slow = stream(core.port, `${c.path}/stream`, page.headers);
      await until(() => slow.lines.length > 0);
      slow.pause();
      await page.api("POST", `${c.path}/messages`, { text: "long" });
      // Keep the screen behind until the reply is stored. A paused reader
      // may not see the server's cut until it drains buffered bytes.
      await until(
        async () =>
          (
            (await page.api("GET", c.path)).body["turns"] as {
              status: string;
            }[]
          )[0]?.status === "completed",
      );
      slow.resume();
      await slow.ended;
      const fresh = stream(core.port, `${c.path}/stream`, page.headers);
      await until(() => replyText(fresh.lines).length === 200_000, 20_000);
      const text = replyText(fresh.lines);
      expect(text).toBe(
        Array.from({ length: 200 }, (_, i) =>
          String(i % 10).repeat(1_000),
        ).join(""),
      );
      fresh.hangUp();
    },
  );
});

describe("what the screens read", () => {
  it("says whether the AI can be used, without a sign-in by default", async () => {
    const core = await start();
    const page = await session(core);
    expect((await page.api("GET", "/api/status")).body).toEqual({
      account: "signed_out",
      email: null,
    });
    await stop();
    const signedIn = await start({
      account: () =>
        Promise.resolve({ account: "signed_in", email: "asha@example.com" }),
    });
    const again = await session(signedIn);
    expect((await again.api("GET", "/api/status")).body).toEqual({
      account: "signed_in",
      email: "asha@example.com",
    });
  });

  it("lists the regions it knows; the chosen one gives the number", async () => {
    const core = await start();
    const page = await session(core);
    const before = (await page.api("GET", "/api/settings")).body;
    expect(before["emergencyRegion"]).toBeNull();
    expect(before["emergency"]).toBeNull();
    expect(before["regions"]).toContainEqual({
      region: "IN",
      name: "India",
      number: "112",
    });
    const saved = await page.api("PUT", "/api/settings", {
      emergencyRegion: "IN",
    });
    expect(saved.body["emergency"]).toEqual({ name: "India", number: "112" });
    expect(
      (await page.api("PUT", "/api/settings", { emergencyRegion: "XX" }))
        .status,
    ).toBe(400);
    const cleared = await page.api("PUT", "/api/settings", {
      emergencyRegion: null,
    });
    expect(cleared.body["emergency"]).toBeNull();
  });
});

describe("opening Rufi again", () => {
  it("keeps core.json for this user only while it runs", async () => {
    const core = await start();
    const file = coreFile(home);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const kept = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    expect(kept["port"]).toBe(core.port);
    expect(typeof kept["launcher"]).toBe("string");
    await stop();
    await expect(stat(file)).rejects.toThrow("ENOENT");
  });

  it("gives a fresh link only for the data folder's secret", async () => {
    const core = await start();
    const origin = `http://127.0.0.1:${String(core.port)}`;
    const link = await runningLink(home);
    expect(link).toMatch(new RegExp(`^${origin}/#launch=[\\w-]{43}$`));
    // The link opens a session, once.
    const launch = new URLSearchParams(new URL(link ?? "").hash.slice(1)).get(
      "launch",
    );
    const swapped = await call(
      core.port,
      "POST",
      "/api/session",
      { origin },
      { launch },
    );
    expect(swapped.status).toBe(200);

    const refused = (headers: Record<string, string>) =>
      call(core.port, "POST", "/api/launch", { origin, ...headers });
    expect((await refused({})).status).toBe(403);
    expect((await refused({ [LAUNCHER_HEADER]: "guess" })).status).toBe(403);
    // The secret alone isn't enough from another page.
    const { launcher } = JSON.parse(await readFile(coreFile(home), "utf8")) as {
      launcher: string;
    };
    expect(
      (
        await call(core.port, "POST", "/api/launch", {
          origin: "http://evil.example",
          [LAUNCHER_HEADER]: launcher,
        })
      ).status,
    ).toBe(403);
  });

  it("finds no running Rufi when there is none, or only a crash's leftover", async () => {
    expect(await runningLink(home)).toBeUndefined();
    const core = await start();
    const left = await readFile(coreFile(home), "utf8");
    await stop();
    // A crash leaves core.json behind; nothing answers on its port.
    await writeFile(coreFile(home), left);
    expect(JSON.parse(left)).toMatchObject({ port: core.port });
    expect(await runningLink(home)).toBeUndefined();
  });
});

describe("the screens", () => {
  let folder: string;
  let screens: string;

  beforeEach(async () => {
    // A space in the path, as in "My Projects".
    folder = await mkdtemp(join(tmpdir(), "rufi screens-"));
    screens = join(folder, "dist");
    await mkdir(join(screens, "assets"), { recursive: true });
    await writeFile(join(screens, "index.html"), "<!doctype html><p>Rufi");
    await writeFile(join(screens, "assets", "app-1a2b.js"), "export {};");
    // Next to the screens, not in them: never served.
    await writeFile(join(folder, "secret.txt"), "not a screen");
    // Links in the build that lead outside it.
    await symlink(
      join(folder, "secret.txt"),
      join(screens, "assets", "out.txt"),
    );
    await symlink(folder, join(screens, "assets", "up"));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("serves the built files, and the app for every page path", async () => {
    const core = await start({ screens });
    const get = (path: string) => call(core.port, "GET", path);

    const page = await get("/help/glossary");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["cache-control"]).toBe("no-cache");
    expect(page.headers["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    expect(page.text).toContain("<p>Rufi");

    const script = await get("/assets/app-1a2b.js");
    expect(script.headers["content-type"]).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(script.headers["cache-control"]).toContain("immutable");

    // A missing file stays missing; so does the API, and what's outside.
    expect((await get("/assets/gone.js")).status).toBe(404);
    expect((await get("/api/nothing")).status).toBe(401);
    expect(
      (await (await session(core)).api("GET", "/api/nothing")).status,
    ).toBe(404);
    expect((await get("/..%2Fsecret.txt")).status).toBe(404);
    expect((await get("/assets/..%2F..%2Fsecret.txt")).status).toBe(404);
    expect((await get("/%E0%A4%A")).status).toBe(404);
    expect((await get("/assets/out.txt")).status).toBe(404);
    expect((await get("/assets/up/secret.txt")).status).toBe(404);
    expect((await get("/assets/app-1a2b.js/x.js")).status).toBe(404);
  });

  it("refuses an app page that is a link leading outside", async () => {
    await rm(join(screens, "index.html"));
    await symlink(join(folder, "secret.txt"), join(screens, "index.html"));
    const core = await start({ screens });
    for (const path of ["/", "/help/glossary", "/index.html"]) {
      expect((await call(core.port, "GET", path)).status).toBe(404);
    }
  });

  it("serves the API only, when it has no screens", async () => {
    const core = await start();
    expect((await call(core.port, "GET", "/")).status).toBe(404);
  });
});

describe("Rufi's log", () => {
  it("holds the core's events and none of the conversation", async () => {
    const core = await start({ log: diagnostics(home).log });
    const page = await session(core);
    const c = await conversation(page);
    await page.api("POST", `${c.path}/messages`, {
      text: "A fictional private worry",
    });
    await until(
      async () =>
        (
          (await page.api("GET", c.path)).body["turns"] as { status: string }[]
        )[0]?.status === "completed",
    );
    const file = await readFile(join(home, "logs", "rufi.log"), "utf8");
    expect(file).toContain('"event":"core.started"');
    expect(file).not.toContain("private worry");
  });
});
