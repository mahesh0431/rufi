// The core as the screens will meet it: started in a scope on a fictional
// data folder with the scripted Codex, and used over HTTP like a browser.
import { spawn } from "node:child_process";
import { request as httpRequest, type IncomingMessage } from "node:http";
import {
  chmod,
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
import type { Status, StreamLine } from "@rufi/contracts";
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexRuntime } from "../agent/codex/codex.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
} from "../core/store/database.ts";
import { backupsPath } from "../core/store/backup.ts";
import { restore } from "../core/store/restore.ts";
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
import type { SignIn } from "./signin.ts";

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

/**
 * A second person, written straight into the record: first run adds only the
 * first one, and more people come with family.
 */
function addRavi(): { id: string } {
  const store = openWritable(databasePath(home));
  try {
    store.db.exec(
      "INSERT INTO people (id, display_name) VALUES ('ravi', 'Ravi Fictional')",
    );
  } finally {
    store.close();
  }
  return { id: "ravi" };
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
    /** Sends from a conversation's box, as the screens do: saves the draft, then sends it. */
    say: async (
      path: string,
      text: string,
      kind: "messages" | "steer" = "messages",
    ) => {
      const draft = path.replace("/conversations/", "/drafts/");
      const before = await call(core.port, "GET", draft, headers);
      const saved = await call(core.port, "PUT", draft, headers, {
        text,
        revision: before.body["revision"],
      });
      return call(core.port, "POST", `${path}/${kind}`, headers, {
        text,
        draft: saved.body["revision"],
      });
    },
  };
}

/** The scripted Codex playing `scenario` (FAKE_CODEX), for start(). */
const scripted =
  (scenario: object, more: { requestMs?: number } = {}) =>
  (...[tools, host]: Parameters<CoreOptions["agent"]>) =>
    codexRuntime({
      home,
      command: { file: process.execPath, args: [FAKE] },
      env: {
        PATH: process.env["PATH"] ?? "",
        FAKE_CODEX: JSON.stringify(scenario),
      },
      token: () => Promise.resolve("token"),
      version: "0.0.0",
      ...(more.requestMs !== undefined && {
        deadlines: { requestMs: more.requestMs },
      }),
      tools,
      host,
    });

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

  it("ends the sends a crash cut off when it starts: taken if the transcript has the message, else the text stays", async () => {
    // What a crash leaves: two drafts still held by their sends; the agent
    // started the first one's message (m-1), and nobody knows of the second.
    const left = openWritable(databasePath(home));
    left.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
      INSERT INTO conversations (id, person_id, title, provider, model, created_at)
        VALUES ('c-1', 'asha', 'Fictional', 'codex', 'gpt-6.1-sol', '2026-10-04T10:00:00Z'),
               ('c-2', 'asha', 'Fictional', 'codex', 'gpt-6.1-sol', '2026-10-04T10:00:00Z');
      INSERT INTO transcript_entries (id, person_id, conversation_id, seq, kind, text, revision, created_at, updated_at)
        VALUES ('m-1', 'asha', 'c-1', 1, 'message', 'Taken', 1, '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z');
      INSERT INTO drafts (person_id, conversation_id, text, revision, state, attempt, updated_at)
        VALUES ('asha', 'c-1', 'Taken', 2, 'sending', 'm-1', '2026-10-04T10:00:00Z'),
               ('asha', 'c-2', 'Not known', 2, 'sending', 'm-2', '2026-10-04T10:00:00Z');`);
    left.close();
    const page = await session(await start());
    expect((await page.api("GET", "/api/people/asha/drafts/c-1")).body).toEqual(
      { text: "", revision: 3, state: "editable" },
    );
    expect((await page.api("GET", "/api/people/asha/drafts/c-2")).body).toEqual(
      { text: "Not known", revision: 3, state: "unknown" },
    );
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
    const ravi = addRavi();
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
    expect((await page.say(c.path, text)).status).toBe(202);
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
      (await page.api("POST", `${c.path}/messages`, { text: "", draft: 0 }))
        .status,
    ).toBe(400);
    const tooLong = await page.api("POST", `${c.path}/messages`, {
      text: "x".repeat(10_001),
      draft: 0,
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

  it("keeps a draft per conversation, and refuses a save based on an older revision", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    const other = (
      await page.api("POST", `/api/people/${c.person}/conversations`, {})
    ).body["conversation"] as { id: string };
    const draft = `/api/people/${c.person}/drafts/${c.id}`;
    expect((await page.api("GET", draft)).body).toEqual({
      text: "",
      revision: 0,
      state: "editable",
    });
    expect(
      (await page.api("PUT", draft, { text: "Start", revision: 0 })).body,
    ).toEqual({ text: "Start", revision: 1, state: "editable" });
    await page.api("PUT", draft, { text: "Start here", revision: 1 });
    await page.api("PUT", `/api/people/${c.person}/drafts/${other.id}`, {
      text: "Half written",
      revision: 0,
    });
    expect((await page.api("GET", draft)).body).toMatchObject({
      text: "Start here",
      revision: 2,
    });
    // Another tab, still at revision 1: refused, with the draft as it is now.
    expect(
      await page.api("PUT", draft, { text: "Older text", revision: 1 }),
    ).toMatchObject({
      status: 409,
      body: {
        error: "Changed in another tab.",
        draft: { text: "Start here", revision: 2, state: "editable" },
      },
    });
    // Emptied, a draft keeps its revision moving.
    await page.api("PUT", draft, { text: "", revision: 2 });
    expect(
      (await page.api("PUT", draft, { text: "x", revision: 2 })).status,
    ).toBe(409);
  });

  it("holds the box's draft while it is sent: only its saved text goes, nobody changes or sends it meanwhile, and it empties once the agent took it", async () => {
    // Codex takes a while to start the conversation's thread.
    const core = await start({
      agent: scripted({ slow: ["thread/start"], slowMs: 600 }),
    });
    const page = await session(core);
    const c = await conversation(page);
    const draft = `/api/people/${c.person}/drafts/${c.id}`;
    const changed = (text: string, revision: number) => ({
      status: 409,
      body: {
        error: "Changed in another tab.",
        draft: { text, revision, state: "editable" },
      },
    });
    // Text the core doesn't keep as the draft is never sent.
    expect(
      await page.api("POST", `${c.path}/messages`, { text: "First", draft: 0 }),
    ).toMatchObject(changed("", 0));

    await page.api("PUT", draft, { text: "First\n", revision: 0 });
    const sending = page.api("POST", `${c.path}/messages`, {
      text: "First",
      draft: 1,
    });
    await until(
      async () => (await page.api("GET", draft)).body["state"] === "sending",
    );
    const held = {
      status: 409,
      body: {
        error: "This message is being sent.",
        draft: { text: "First\n", revision: 2, state: "sending" },
      },
    };
    // Another tab, at the latest revision: it can't change it or send it.
    expect(
      await page.api("PUT", draft, { text: "Other tab", revision: 2 }),
    ).toMatchObject(held);
    expect(
      await page.api("POST", `${c.path}/messages`, { text: "First", draft: 2 }),
    ).toMatchObject(held);
    const sent = await sending;
    expect(sent.status).toBe(202);
    expect(sent.body["draft"]).toEqual({
      text: "",
      revision: 3,
      state: "editable",
    });

    // Refused: the text is back to edit, and the answer says why.
    await page.api("PUT", draft, { text: "Only the latest", revision: 3 });
    expect(
      await page.api("POST", `${c.path}/steer`, {
        text: "Only the latest",
        draft: 4,
      }),
    ).toMatchObject({
      status: 409,
      body: {
        error: "No reply is running to steer.",
        draft: { text: "Only the latest", revision: 6, state: "editable" },
      },
    });

    // The box saved at revision 7; another tab saved after it: nothing is
    // sent, and the box gets that tab's text.
    await page.api("PUT", draft, { text: "Second", revision: 6 });
    await page.api("PUT", draft, { text: "Other tab", revision: 7 });
    expect(
      await page.api("POST", `${c.path}/messages`, {
        text: "Second",
        draft: 7,
      }),
    ).toMatchObject(changed("Other tab", 8));
    await until(async () =>
      (
        (await page.api("GET", c.path)).body["turns"] as { status: string }[]
      ).some((turn) => turn.status === "completed"),
    );
    const said = (
      (await page.api("GET", c.path)).body["entries"] as {
        kind: string;
        text: string;
      }[]
    ).filter((entry) => entry.kind === "message" || entry.kind === "steer");
    expect(said.map((entry) => entry.text)).toEqual(["First"]);
  });

  it("keeps the text of a send whose outcome Rufi doesn't know, and says so", async () => {
    // Codex never answers: Rufi can't tell whether it has the message.
    const core = await start({
      agent: scripted({ hang: ["thread/start"] }, { requestMs: 300 }),
    });
    const page = await session(core);
    const c = await conversation(page);
    const failed = await page.say(c.path, "Hello");
    expect(failed.status).toBe(502);
    expect(failed.body["draft"]).toEqual({
      text: "Hello",
      revision: 3,
      state: "unknown",
    });
    // The person can go on from it: edit, or send it again themselves.
    expect(
      (
        await page.api("PUT", `/api/people/${c.person}/drafts/${c.id}`, {
          text: "Hello again",
          revision: 3,
        })
      ).body,
    ).toEqual({ text: "Hello again", revision: 4, state: "editable" });
  });

  it("keeps the text as unknown when Stop comes while the agent takes the message, which may already wait", async () => {
    // Codex takes a while to put a message in its queue.
    const core = await start({
      agent: scripted({ slow: ["thread/queue/add"], slowMs: 650 }),
    });
    const page = await session(core);
    const c = await conversation(page);
    const draft = `/api/people/${c.person}/drafts/${c.id}`;
    await page.say(c.path, "hang");
    await until(async () =>
      (
        (await page.api("GET", c.path)).body["turns"] as { status: string }[]
      ).some((turn) => turn.status === "running"),
    );
    const sending = page.say(c.path, "Next question");
    await until(
      async () => (await page.api("GET", draft)).body["state"] === "sending",
    );
    await page.api("POST", `${c.path}/stop`);
    const stopped = await sending;
    expect(stopped.status).toBe(409);
    expect(stopped.body["draft"]).toMatchObject({
      text: "Next question",
      state: "unknown",
    });
    // Why: the agent may have it already.
    expect(
      (
        (await page.api("GET", `${c.path}/waiting`)).body["messages"] as {
          text: string;
        }[]
      ).map((m) => m.text),
    ).toEqual(["Next question"]);
  });

  it("creates a conversation at once, without the AI; its first message taken chooses the model and names it", async () => {
    // Codex doesn't answer the list of models: creating doesn't need it.
    let core = await start({ agent: scripted({ hang: ["model/list"] }) });
    let page = await session(core);
    const asha = (
      await page.api("POST", "/api/people", { displayName: "Asha Fictional" })
    ).body["person"] as { id: string };
    const people = `/api/people/${asha.id}`;
    const create = await page.api("POST", `${people}/conversations`, {});
    expect(create.status).toBe(201);
    const created = create.body["conversation"] as { id: string };
    expect(created).toMatchObject({ title: null, model: null });
    await stop();

    core = await start();
    page = await session(core);
    const path = `${people}/conversations/${created.id}`;
    const text =
      "Is my **TSH** still high after the lab [amended](https://example.com/lab) it in August?\nAnd the Free T4?";
    expect((await page.say(path, text)).status).toBe(202);
    expect((await page.api("GET", path)).body["conversation"]).toMatchObject({
      title: "Is my TSH still high after the lab amended it in August?",
      model: "gpt-6-astra",
    });

    // A model chosen before the first message stays; a long first line is
    // cut at a word; a later message keeps the title.
    const second = (
      (await page.api("POST", `${people}/conversations`, {})).body[
        "conversation"
      ] as { id: string }
    ).id;
    const secondPath = `${people}/conversations/${second}`;
    await page.api("PUT", `${secondPath}/model`, { model: "gpt-6.1-sol" });
    await page.say(secondPath, `${"word ".repeat(20)}end`);
    expect(
      (await page.api("GET", secondPath)).body["conversation"],
    ).toMatchObject({
      title: `${"word ".repeat(12).trimEnd()}…`,
      model: "gpt-6.1-sol",
    });
    await until(async () =>
      (
        (await page.api("GET", path)).body["turns"] as { status: string }[]
      ).every((turn) => turn.status !== "running"),
    );
    await page.say(path, "Something else");
    expect(
      ((await page.api("GET", path)).body["conversation"] as { title: string })
        .title,
    ).toBe("Is my TSH still high after the lab amended it in August?");
  });

  it(
    "keeps the text of a send Rufi stops during, which another tab can't change meanwhile",
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
      let draft = "";
      try {
        let link: string | undefined;
        await until(async () => (link = await runningLink(home)) !== undefined);
        const page = await session({
          port: Number(new URL(link ?? "").port),
          launchUrl: () => link ?? "",
        });
        const c = await conversation(page);
        draft = `/api/people/${c.person}/drafts/${c.id}`;
        await page.api("PUT", draft, { text: "Outgoing text", revision: 0 });
        void page
          .api("POST", `${c.path}/messages`, {
            text: "Outgoing text",
            draft: 1,
          })
          .catch(() => undefined);
        await until(
          async () =>
            (await page.api("GET", draft)).body["state"] === "sending",
        );
        // Another tab saves at the latest revision while the agent starts.
        expect(
          (
            await page.api("PUT", draft, {
              text: "Other tab text",
              revision: 2,
            })
          ).status,
        ).toBe(409);
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      // The crash's lock would go stale in 10 s; Rufi starts again.
      await rm(join(home, "rufi.lock"), { recursive: true, force: true });
      const page = await session(await start());
      expect((await page.api("GET", draft)).body).toEqual({
        text: "Outgoing text",
        revision: 3,
        state: "unknown",
      });
    },
  );

  it("remembers the conversation to open the chat on, for that person only", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    const list = `/api/people/${c.person}/conversations`;
    expect((await page.api("GET", list)).body["chosen"]).toBeNull();
    const chosen = `/api/people/${c.person}/chosen`;
    await page.api("PUT", chosen, { conversationId: c.id });
    expect((await page.api("GET", list)).body["chosen"]).toBe(c.id);

    const ravi = addRavi();
    expect(
      (
        await page.api("PUT", `/api/people/${ravi.id}/chosen`, {
          conversationId: c.id,
        })
      ).status,
    ).toBe(404);
  });

  it("offers the allowed models, and says when the allowlist is broken", async () => {
    const core = await start();
    const page = await session(core);
    expect((await page.api("GET", "/api/models")).body).toEqual({
      models: [
        { id: "gpt-6-astra", name: "GPT-6-Astra" },
        { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
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
    expect((await page.say(c.path, "hang")).status).toBe(202);
    await until(
      async () =>
        ((await page.api("GET", c.path)).body["turns"] as unknown[]).length > 0,
    );
    await page.say(c.path, "B");
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
    expect((await page.say(c.path, "faster", "steer")).status).toBe(200);
    expect(
      (await page.api("PUT", `${c.path}/model`, { model: "gpt-6.1-sol" }))
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
    const steer = await page.say(c.path, "nothing runs", "steer");
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
    await page.say(c.path, "drip");
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
    await page.say(c.path, "Hello there");
    // The first message chooses the first allowed model, then names it.
    await until(() => changed().length === 2);
    expect(changed()).toMatchObject([
      { title: null, model: "gpt-6-astra" },
      { title: "Hello there", model: "gpt-6-astra" },
    ]);
    await until(async () =>
      (
        (await page.api("GET", c.path)).body["turns"] as { status: string }[]
      ).every((turn) => turn.status === "completed"),
    );
    await page.api("PUT", `${c.path}/model`, { model: "gpt-6.1-sol" });
    await until(() => changed().length === 3);
    expect(changed()[2]).toMatchObject({
      title: "Hello there",
      model: "gpt-6.1-sol",
    });
    live.hangUp();
  });

  it("gives a screen that reconnects during a reply the text so far, then the rest", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    const first = stream(core.port, `${c.path}/stream`, page.headers);
    await until(() => first.lines.length > 0);
    await page.say(c.path, "drip");
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
      await page.say(c.path, "long");
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
    await page.say(c.path, "A fictional private worry");
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

describe("never starting over", () => {
  it("won't start empty when the record is lost, and points to restore", async () => {
    await start();
    await stop();
    for (const name of ["rufi.sqlite", "rufi.sqlite-wal", "rufi.sqlite-shm"]) {
      await rm(join(home, name), { force: true });
    }
    await expect(start()).rejects.toThrow("Rufi's record is missing from");
    await expect(stat(databasePath(home))).rejects.toThrow();
  });

  it("won't open a folder whose restore didn't finish", async () => {
    await mkdir(join(home, "restoring"));
    await expect(start()).rejects.toThrow("didn't finish");
    await expect(stat(databasePath(home))).rejects.toThrow();
  });

  it.each([
    { folder: "a new folder", prepare: () => Promise.resolve(), people: 0 },
    {
      folder: "a folder with only a sign-in",
      prepare: () => writeFile(join(home, "chatgpt.json"), "{}"),
      people: 0,
    },
    {
      folder: "a folder from before the marker",
      prepare: () => {
        const store = openWritable(databasePath(home));
        store.db.exec(
          "INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional')",
        );
        store.close();
        return Promise.resolve();
      },
      people: 1,
    },
  ])("opens $folder and marks it", async ({ prepare, people }) => {
    await prepare();
    const page = await session(await start());
    expect((await page.api("GET", "/api/people")).body["people"]).toHaveLength(
      people,
    );
    await stop();
    await rm(databasePath(home));
    await expect(start()).rejects.toThrow("Rufi's record is missing from");
  });
});

describe("first run", () => {
  it("goes through its steps, kept by the core, and makes one person from two tabs", async () => {
    const core = await start();
    const page = await session(core);
    const second = await session(core);
    const step = async () =>
      (await page.api("GET", "/api/first-run")).body["step"];
    expect(await step()).toBe("welcome");
    expect(
      (await page.api("POST", "/api/first-run", { step: "welcome" })).body,
    ).toEqual({ step: "name" });

    const both = await Promise.all([
      page.api("POST", "/api/people", { displayName: "Asha Fictional" }),
      second.api("POST", "/api/people", { displayName: "Asha F." }),
    ]);
    expect(both.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect((await page.api("GET", "/api/people")).body["people"]).toHaveLength(
      1,
    );

    // Signed out: the sign-in step, until it is skipped.
    expect(await second.api("GET", "/api/first-run")).toMatchObject({
      body: { step: "sign_in" },
    });
    await second.api("POST", "/api/first-run", { step: "sign_in" });
    expect(await step()).toBe("region");
    await page.api("POST", "/api/first-run", { step: "region" });
    expect(await step()).toBe("done");
  });

  it("skips the sign-in step when Rufi is already signed in, and stays done after signing out", async () => {
    let account: Status = { account: "signed_in", email: "asha@example.com" };
    const page = await session(
      await start({ account: () => Promise.resolve(account) }),
    );
    await page.api("POST", "/api/first-run", { step: "welcome" });
    await page.api("POST", "/api/people", { displayName: "Asha Fictional" });
    expect((await page.api("GET", "/api/first-run")).body["step"]).toBe(
      "region",
    );
    await page.api("POST", "/api/first-run", { step: "region" });

    account = { account: "signed_out", email: null };
    expect((await page.api("GET", "/api/first-run")).body["step"]).toBe("done");
  });
});

describe("signing in from the screens", () => {
  it("opens one sign-in at a time, gives its link, and says when it is done or why it failed", async () => {
    const runs: PromiseWithResolvers<{ email: string | undefined }>[] = [];
    const signIn: SignIn = ({ showLink }) => {
      showLink("https://auth.example.com/authorize?fictional=1");
      const run = Promise.withResolvers<{ email: string | undefined }>();
      runs.push(run);
      return run.promise;
    };
    const page = await session(await start({ signIn }));
    const state = async () => (await page.api("GET", "/api/signin")).body;
    expect(await state()).toEqual({ state: "idle", link: null, error: null });

    await page.api("POST", "/api/signin");
    await page.api("POST", "/api/signin");
    expect(runs).toHaveLength(1);
    expect(await state()).toEqual({
      state: "waiting",
      link: "https://auth.example.com/authorize?fictional=1",
      error: null,
    });
    runs[0]?.reject(
      new Error("Sign-in wasn't finished in time. Sign in again."),
    );
    await until(async () => (await state())["state"] === "failed");
    expect((await state())["error"]).toBe(
      "Sign-in wasn't finished in time. Sign in again.",
    );

    await page.api("POST", "/api/signin");
    runs[1]?.resolve({ email: "asha@example.com" });
    await until(async () => (await state())["state"] === "done");
  });
});

describe("backups and export over the API", () => {
  it("makes a backup at start, another on Back up now, and gives the export as a zip", async () => {
    const page = await session(await start());
    const backups = async () => (await page.api("GET", "/api/backups")).body;
    await until(async () => (await backups())["last"] !== null);
    const first = (await backups())["last"] as { name: string };
    const now = (await page.api("POST", "/api/backups")).body;
    expect(now).toMatchObject({ failed: null, running: false });
    expect((now["last"] as { name: string }).name).not.toBe(first.name);

    const exported = await page.api("GET", "/api/export");
    expect(exported.status).toBe(200);
    expect(exported.headers["content-type"]).toBe("application/zip");
    expect(exported.headers["content-disposition"]).toMatch(
      /^attachment; filename="rufi-export-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
  });

  it("starts even when the backups folder can't be written, and says so in Settings", async () => {
    const left = join(backupsPath(home), ".staging-abc123");
    await mkdir(left, { recursive: true });
    await chmod(backupsPath(home), 0o500);
    try {
      const page = await session(await start());
      const backups = async () => (await page.api("GET", "/api/backups")).body;
      await until(async () => (await backups())["running"] === false);
      expect(await backups()).toMatchObject({
        last: null,
        failed: { reason: "the backups folder can't be written" },
      });
    } finally {
      await chmod(backupsPath(home), 0o700);
    }
  });

  it(
    "restores a backup made during a reply: drafts and history are there, the reply shows interrupted, and the next message starts the AI afresh",
    { timeout: 30_000 },
    async () => {
      const page = await session(await start());
      const c = await conversation(page);
      await page.say(c.path, "Please remember my fictional cat Biscuit");
      await until(async () =>
        (
          (await page.api("GET", c.path)).body["turns"] as { status: string }[]
        ).every((turn) => turn.status === "completed"),
      );
      await page.say(c.path, "hang");
      await until(async () =>
        (
          (await page.api("GET", c.path)).body["turns"] as { status: string }[]
        ).some((turn) => turn.status === "running"),
      );
      const draft = c.path.replace("/conversations/", "/drafts/");
      const { revision } = (await page.api("GET", draft)).body;
      await page.api("PUT", draft, {
        text: "An unsent fictional note",
        revision,
      });
      const made = (await page.api("POST", "/api/backups")).body["last"] as {
        name: string;
      };
      await stop();

      const backup = join(backupsPath(home), made.name);
      home = await mkdtemp(join(tmpdir(), "rufi-restored-"));
      await rm(home, { recursive: true });
      await restore(backup, home);
      // Codex's turn ids are unique; the scripted one numbers them from what
      // it knew, so it is told of two earlier turns to start at a new id.
      const restored = await session(
        await start({
          agent: scripted({ threads: { earlier: { history: ["a", "b"] } } }),
        }),
      );

      const snapshot = (await restored.api("GET", c.path)).body as {
        turns: { status: string }[];
      };
      expect(snapshot.turns.map((t) => t.status)).toEqual([
        "completed",
        "interrupted",
      ]);
      expect((await restored.api("GET", draft)).body["text"]).toBe(
        "An unsent fictional note",
      );
      // Nothing ran by itself; the next message starts a new thread (the copy
      // has none of the AI's files), told the conversation's last messages.
      expect(
        (await restored.say(c.path, "What is my cat called?")).status,
      ).toBe(202);
      await until(
        async () =>
          (
            (await restored.api("GET", c.path)).body["turns"] as {
              status: string;
            }[]
          ).at(2)?.status === "completed",
      );
      expect(logged).toContain("chat.resume_failed");
    },
  );
});
