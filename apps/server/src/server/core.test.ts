// The core as the screens will meet it: started in a scope on a fictional
// data folder with the scripted Codex, and used over HTTP like a browser.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { request as httpRequest, type IncomingMessage } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { Entry, ProviderStatus, StreamLine } from "@rufi/contracts";
import { APPEARANCE_HEADER } from "@rufi/contracts/app";
import { createCanvas } from "@napi-rs/canvas";
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexAdapter, type CodexAdapter } from "../agent/codex/adapter.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
} from "../core/store/database.ts";
import { backupsPath } from "../core/store/backup.ts";
import { MIGRATIONS, migrate } from "../core/store/migrations.ts";
import { devices } from "../core/devices/devices.ts";
import { findDataFolder } from "../core/store/data-folder.ts";
import { moveData } from "../core/store/move.ts";
import { restore } from "../core/store/restore.ts";
import { holdRufiLock } from "../platform/files.ts";
import { diagnostics } from "../platform/logs.ts";
import { LAUNCHER_HEADER, PROOF_HEADER } from "./api.ts";
import {
  agentSetup,
  coreFile,
  runningLink,
  startCore,
  type Core,
  type CoreOptions,
} from "./core.ts";
import { codexSignIn, type ProviderSignIn } from "./signin.ts";

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

async function start(
  options: Omit<Partial<CoreOptions>, "adapters"> & {
    adapters?: CodexAdapter[];
  } = {},
): Promise<Core> {
  const opened = await Effect.runPromise(Scope.make());
  const adapters = options.adapters ?? scripted({});
  const core = await Effect.runPromise(
    startCore({
      home,
      adapters,
      log: (event) => logged.push(event),
      // Codex's own sign-in, as the scripted Codex reports it.
      signIns: {
        codex: codexSignIn(adapters[0] as CodexAdapter, () => undefined),
      },
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
          // A HEAD answer has no body.
          const json =
            text !== "" &&
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
 * A second person and their chat, written straight into the record: first run adds only the
 * first one, and more people come with family.
 */
function addRavi(): { id: string } {
  const store = openWritable(databasePath(home));
  try {
    store.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('ravi', 'Ravi Fictional');
      INSERT INTO chats (id, person_id, created_at)
        VALUES ('c-ravi', 'ravi', '2026-10-04T09:00:00Z');
    `);
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
    /**
     * Sends a box's text, by a new send id (or `id`, to send it again);
     * while a reply runs, it steers unless queued.
     */
    say: (
      path: string,
      text: string,
      id: string = randomUUID(),
      kind?: "steer" | "queue",
    ) =>
      call(core.port, "POST", `${path}/messages`, headers, {
        id,
        text,
        ...(kind && { kind }),
      }),
  };
}

/**
 * A reply Rufi started, with its note: "hang" runs until it is stopped. A
 * message the person queues meanwhile waits for a reply of its own.
 */
async function rufiReply(
  core: Core,
  page: {
    api: (
      method: string,
      path: string,
    ) => Promise<{ body: Record<string, unknown> }>;
  },
  path: string,
) {
  const personId = decodeURIComponent(path.split("/")[3] ?? "");
  await core.chat.event(personId, {
    kind: "test",
    line: "Rufi's line",
    ask: "Rufi's note: hang",
  });
  await until(async () =>
    ((await page.api("GET", path)).body["turns"] as { status: string }[]).some(
      (turn) => turn.status === "running",
    ),
  );
}

/** The scripted Codex playing `scenario` (FAKE_CODEX), for start(). */
const scripted = (
  scenario: object,
  more: { requestMs?: number; log?: string } = {},
) => [
  codexAdapter({
    home,
    ...agentSetup(home),
    command: { file: process.execPath, args: [FAKE] },
    env: {
      PATH: process.env["PATH"] ?? "",
      FAKE_CODEX: JSON.stringify(scenario),
      ...(more.log !== undefined && { FAKE_CODEX_LOG: more.log }),
    },
    version: "0.0.0",
    ...(more.requestMs !== undefined && {
      deadlines: { requestMs: more.requestMs },
    }),
  }),
];

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

/** What the welcome's "About you" sends for a person named `displayName`. */
const aboutYou = (displayName: string) => ({
  displayName,
  profile: {
    birth_date: { date: "1990-03", words: "March 1990" },
    sex_for_ranges: "female",
  },
});

/** A person, through the API, and their chat. */
async function chat(page: Awaited<ReturnType<typeof session>>) {
  const person = (
    await page.api("POST", "/api/people", aboutYou("Asha Fictional"))
  ).body["person"] as { id: string };
  const path = `/api/people/${person.id}/chat`;
  return { person: person.id, path, draft: `${path}/draft` };
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

  it("counts a hand-over a crash cut off as sent, its reply stopped; what waits goes", async () => {
    const left = openWritable(databasePath(home));
    left.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
      INSERT INTO chats (id, person_id, created_at) VALUES ('c-asha', 'asha', '2026-10-04T09:00:00Z');
      INSERT INTO chat_queue (id, person_id, chat_id, origin, text, position, state, sent_as, created_at, updated_at) VALUES
        ('q-1', 'asha', 'c-asha', 'person', 'Being handed over', 1, 'handing_over', 'agent-gone/1', '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z'),
        ('q-2', 'asha', 'c-asha', 'person', 'Waiting', 2, 'waiting', NULL, '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z');`);
    left.close();
    const page = await session(await start());
    const said = async (person: string) =>
      (
        (await page.api("GET", `/api/people/${person}/chat`)).body[
          "entries"
        ] as { id: string; kind: string; text: string }[]
      ).filter((entry) => entry.kind === "message");
    // The one handed over is in the chat, its reply stopped; what waited
    // goes by itself.
    await until(async () => (await said("asha")).length === 2);
    expect((await said("asha")).map((entry) => entry.id)).toEqual([
      "q-1",
      "q-2",
    ]);
    expect(
      (await page.api("GET", "/api/people/asha/chat")).body["turns"],
    ).toMatchObject([
      {
        status: "interrupted",
        endText: "Rufi closed before the reply finished.",
      },
      {},
    ]);
    expect(
      (await page.api("GET", "/api/people/asha/chat/queue")).body["items"],
    ).toEqual([]);
  });

  it("after an upgrade, sends each message that waited once and counts one that may have reached the AI as sent, also when its first start is cut short; one whose files an older Rufi read goes once, in the chat once", async () => {
    // Asha's chat as Rufi of version 19 left it, stopped: one message to
    // go, one behind it, and one it may have given the AI. Ravi's: one
    // whose reply ended while Rufi read its file, held for that reply's
    // Retry, and one whose file Rufi was reading when it stopped.
    const path = databasePath(home);
    const first = new DatabaseSync(path);
    first.exec(`${MIGRATIONS[0] ?? ""}; PRAGMA user_version = 1;`);
    first.close();
    migrate(path, MIGRATIONS.slice(0, 19));
    const left = new DatabaseSync(path);
    left.exec(`
      INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
      INSERT INTO chats (id, person_id, paused, created_at) VALUES ('c-asha', 'asha', 'stopped', '2026-10-04T09:00:00Z');
      INSERT INTO chat_queue (id, person_id, chat_id, origin, text, position, state, sent_as, created_at, updated_at) VALUES
        ('q-handed', 'asha', 'c-asha', 'person', 'Handed over', 1, 'handing_over', 'q-handed', '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z'),
        ('q-first', 'asha', 'c-asha', 'person', 'hang', 2, 'waiting', NULL, '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z'),
        ('q-second', 'asha', 'c-asha', 'person', 'Second', 3, 'waiting', NULL, '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z');
      INSERT INTO people (id, display_name) VALUES ('ravi', 'Ravi Fictional');
      INSERT INTO chats (id, person_id, created_at) VALUES ('c-ravi', 'ravi', '2026-10-04T09:00:00Z');
      INSERT INTO turns (id, person_id, chat_id, agent_turn_id, thread_id, model, status, end_text, started_at, ended_at) VALUES
        ('t-ended', 'ravi', 'c-ravi', NULL, NULL, 'gpt-6.1-sol', 'failed', 'Couldn''t read scan.pdf', '2026-10-04T10:00:00Z', '2026-10-04T10:01:00Z'),
        ('t-reading', 'ravi', 'c-ravi', NULL, NULL, 'gpt-6.1-sol', 'running', NULL, '2026-10-04T10:02:00Z', NULL);
      INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, revision, created_at, updated_at) VALUES
        ('q-ended', 'ravi', 'c-ravi', 1, 't-ended', 'message', 'Read my scan', 1, '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z'),
        ('q-reading', 'ravi', 'c-ravi', 2, 't-reading', 'message', 'And this one', 2, '2026-10-04T10:02:00Z', '2026-10-04T10:02:00Z');
      INSERT INTO chat_queue (id, person_id, chat_id, origin, text, position, state, held, held_text, hold_id, turn_id, created_at, updated_at) VALUES
        ('q-ended', 'ravi', 'c-ravi', 'person', 'Read my scan', 1, 'waiting', 'reply_ended', 'Couldn''t read scan.pdf', 'hold-1', 't-ended', '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z'),
        ('q-reading', 'ravi', 'c-ravi', 'person', 'And this one', 2, 'handing_over', NULL, NULL, NULL, 't-reading', '2026-10-04T10:02:00Z', '2026-10-04T10:02:00Z');`);
    left.close();
    const said = async (page: Awaited<ReturnType<typeof session>>) =>
      (
        (await page.api("GET", "/api/people/asha/chat")).body["entries"] as {
          id: string;
          kind: string;
          text: string;
        }[]
      ).filter((entry) => entry.kind === "message" || entry.kind === "reply");
    // The first goes and runs on; Rufi closes before the second goes.
    let page = await session(await start());
    await until(async () =>
      (await said(page)).some((entry) => entry.id === "q-first"),
    );
    // Ravi's two go by themselves, each once, and each shows once, where it
    // was; the reply Rufi was reading in ended as cut off.
    const ravi = async () =>
      (await page.api("GET", "/api/people/ravi/chat")).body as {
        entries: { id: string; kind: string; text: string }[];
        turns: { status: string }[];
      };
    await until(async () =>
      (await ravi()).entries.some((entry) => entry.text === "ok:And this one"),
    );
    await sleep(300);
    expect(
      (await ravi()).entries
        .filter((entry) => entry.kind === "message" || entry.kind === "reply")
        .map((entry) => (entry.kind === "message" ? entry.id : entry.text)),
    ).toEqual(["q-ended", "q-reading", "ok:Read my scan", "ok:And this one"]);
    expect((await ravi()).turns.map((turn) => turn.status)).toEqual([
      "failed",
      "interrupted",
      "completed",
      "completed",
    ]);
    expect(
      (await page.api("GET", "/api/people/ravi/chat/queue")).body["items"],
    ).toEqual([]);
    await stop();
    page = await session(await start());
    await until(async () =>
      (await said(page)).some((entry) => entry.text === "ok:Second"),
    );
    await sleep(300);
    // Each message once; the first one's reply was cut, and carries on
    // before the second goes.
    expect(
      (await said(page)).map((entry) =>
        entry.kind === "message" ? entry.id : entry.text,
      ),
    ).toEqual([
      "q-handed",
      "q-first",
      "ok:Rufi stopped suddenly (restart). Please continue.",
      "q-second",
      "ok:Second",
    ]);
    expect(
      (await page.api("GET", "/api/people/asha/chat/queue")).body["items"],
    ).toEqual([]);
  });

  it("marks replies cut off by a crash as interrupted when it starts", async () => {
    // What a crash leaves: a reply still marked running.
    const left = openWritable(databasePath(home));
    left.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
      INSERT INTO chats (id, person_id, created_at) VALUES ('c-asha', 'asha', '2026-10-04T09:00:00Z');
      INSERT INTO turns (id, person_id, chat_id, agent_turn_id, thread_id, model, status, started_at)
        SELECT 't-1', 'asha', id, 'turn-1', 'thread-1', 'gpt-6.1-sol', 'running', '2026-10-04T10:00:00Z' FROM chats;`);
    left.close();
    const core = await start();
    const page = await session(core);
    expect(
      (await page.api("GET", "/api/people/asha/chat")).body["turns"],
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
        (await page.api("POST", "/api/people", aboutYou("Asha Fictional")))
          .status,
      ).toBe(201);
      await rm(join(home, "rufi.lock"), { recursive: true });
      // The lock is checked every few seconds.
      await until(() => logged.includes("core.lock_lost"), 15_000);
      const refused = await page.api(
        "POST",
        "/api/people",
        aboutYou("Ravi Fictional"),
      );
      expect(refused.status).toBe(500);
    },
  );

  it("closes every part when it stops, even when one of them fails", async () => {
    const [adapter] = scripted({});
    if (!adapter) throw new Error("no adapter");
    const core = await start({
      adapters: [
        { ...adapter, close: () => Promise.reject(new Error("close failed")) },
      ],
    });
    const port = core.port;
    // The failure is reported; every other part is closed all the same.
    await expect(stop()).rejects.toThrow("close failed");
    await expect(call(port, "GET", "/api/people")).rejects.toThrow();
    const release = await holdRufiLock(home, () => undefined);
    await release();
    await adapter.close();
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

  it("reaches only the chat of the person in the path", async () => {
    const core = await start();
    const page = await session(core);
    const c = await chat(page);
    const ravi = addRavi();
    await page.say(c.path, "Asha's fictional message");
    const ravis = `/api/people/${ravi.id}/chat`;
    expect((await page.api("GET", ravis)).body["entries"]).toEqual([]);
    expect((await page.api("GET", `${ravis}/draft`)).body).toMatchObject({
      text: "",
    });
    expect((await page.api("GET", "/api/people/nobody/chat")).status).toBe(404);
    expect(
      (
        await page.api("POST", "/api/people/nobody/chat/messages", {
          text: "Hi",
        })
      ).status,
    ).toBe(404);
  });

  it("gives a step's details when it opens, only from the person's own chat; a step kept without them has none", async () => {
    const core = await start();
    const page = await session(core);
    const c = await chat(page);
    await page.say(c.path, "Hello");
    let entries: Entry[] = [];
    await until(async () => {
      entries = (await page.api("GET", c.path)).body["entries"] as Entry[];
      return entries.some((e) => e.activity === "command");
    });
    // The chat itself never carries them.
    expect(JSON.stringify(entries)).not.toContain("notes.txt");
    const command = entries.find((e) => e.activity === "command");
    const message = entries.find((e) => e.kind === "message");
    const details = (id = "") => `${c.path}/entries/${id}`;
    expect((await page.api("GET", details(command?.id))).body).toEqual({
      details: {
        id: "item-ls",
        type: "commandExecution",
        command: "ls",
        commandActions: [],
        status: "completed",
        aggregatedOutput: "notes.txt\n",
        exitCode: 0,
        durationMs: 4,
      },
    });
    const ravi = addRavi();
    expect(
      (
        await page.api(
          "GET",
          `/api/people/${ravi.id}/chat/entries/${command?.id ?? ""}`,
        )
      ).status,
    ).toBe(404);
    expect((await page.api("GET", details(message?.id))).status).toBe(404);
    // A line stored before Rufi kept details.
    const store = openWritable(databasePath(home));
    try {
      store.db
        .prepare(
          `INSERT INTO transcript_entries (id, person_id, chat_id, seq, turn_id, kind, text, activity, detail, status, revision, created_at, updated_at)
           SELECT 'old-step', person_id, chat_id, 9999, turn_id, 'activity', 'Ran a command', 'command', 'ls', 'done', 1, created_at, created_at
           FROM transcript_entries WHERE id = ?`,
        )
        .run(message?.id ?? "");
    } finally {
      store.close();
    }
    expect((await page.api("GET", details("old-step"))).body).toEqual({
      details: null,
    });
  });

  it("stops a sub-agent and the helpers it started from its pop-up, only through its own person's chat", async () => {
    // Both work on until they are stopped.
    const core = await start({
      adapters: scripted({
        callsByText: {
          "Ask a helper": [
            {
              tool: "start_agent",
              arguments: { title: "Helper", task: "helper: hang on" },
            },
          ],
          "helper:": [
            {
              tool: "start_agent",
              arguments: { title: "Second helper", task: "second: hang" },
            },
          ],
        },
      }),
    });
    const page = await session(core);
    const c = await chat(page);
    // Ravi's chat has its own Rufi AI too.
    const ravis = `/api/people/${addRavi().id}/chat`;
    await page.say(ravis, "Hello");
    await until(async () =>
      (
        (await page.api("GET", ravis)).body["turns"] as { status: string }[]
      ).some((turn) => turn.status === "completed"),
    );
    await page.say(c.path, "Ask a helper");
    const agents = async () =>
      (await page.api("GET", `${c.path}/agents`)).body["agents"] as {
        id: string;
        parent: string | null;
        status: string;
      }[];
    await until(async () => {
      const now = await agents();
      return now.length === 2 && now.every((one) => one.status === "running");
    });
    const helper = (await agents()).find((one) => one.parent === null)?.id;
    const stop = (path: string) =>
      page.api(
        "POST",
        `${path}/agents/stop?agent=${encodeURIComponent(helper ?? "")}`,
      );

    expect((await stop(ravis)).status).toBe(404);
    expect((await agents()).map((one) => one.status)).toEqual([
      "running",
      "running",
    ]);

    expect((await stop(c.path)).status).toBe(200);
    await until(async () =>
      (await agents()).every((one) => one.status === "stopped"),
    );
    // Its stopped message goes to Rufi AI, and shows in the chat.
    await until(async () =>
      ((await page.api("GET", c.path)).body["entries"] as Entry[]).some(
        (entry) => entry.kind === "agent" && entry.from?.about === "stopped",
      ),
    );
  });

  it("reads the record only for the person in the path, and only by GET", async () => {
    const store = openWritable(databasePath(home));
    store.db.exec(
      await readFile(
        join(import.meta.dirname, "../../tests/fixtures/fictional-family.sql"),
        "utf8",
      ),
    );
    store.close();
    const core = await start();
    const page = await session(core);
    const asha = "/api/people/asha";
    expect(
      (await page.api("GET", `${asha}/record/result/res-a1`)).body,
    ).toMatchObject({
      row: { kind: "result", id: "res-a1", test: "HbA1c" },
    });
    // Ravi's result, asked for as Asha's: not found, as an unknown one is.
    for (const path of [
      `${asha}/record/result/res-r1`,
      `${asha}/record/result/nothing`,
      `${asha}/record/no_kind`,
      `${asha}/record/no_kind/res-a1`,
      `${asha}/record/none_known`,
      // Results have two pages; the screens open the right one.
      `${asha}/record/result`,
      "/api/people/nobody/record/lab_result",
      "/api/people/nobody/overview",
    ]) {
      expect((await page.api("GET", path)).status, path).toBe(404);
    }
    expect(
      (await page.api("GET", `${asha}/record/lab_result?after=nonsense`))
        .status,
    ).toBe(400);
    expect((await page.api("GET", `${asha}/series`)).status).toBe(400);
    expect(
      (await page.api("GET", `${asha}/series?test=Weight&unit=kg`)).status,
    ).toBe(400);
    expect(
      (
        await page.api(
          "GET",
          `${asha}/series?test=Weight&unit=kg&category=measurement`,
        )
      ).body,
    ).toMatchObject({ values: [{ id: "res-a11" }, { id: "res-a10" }] });
    const ravis = (await page.api("GET", "/api/people/ravi/record/lab_result"))
      .body as {
      groups: { rows: { id: string }[] }[];
    };
    expect(ravis.groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual([
      "res-r1",
      "res-r2",
    ]);
    // The screens can't change the record: no route takes a write.
    expect((await page.api("POST", `${asha}/record/result`, {})).status).toBe(
      404,
    );
    expect(
      (await page.api("PUT", `${asha}/record/result/res-a1`, {})).status,
    ).toBe(404);
  });

  it("changes a profile only for the person in the path, once for one sending, and only the fields that differ", async () => {
    const store = openWritable(databasePath(home));
    store.db.exec(
      await readFile(
        join(import.meta.dirname, "../../tests/fixtures/fictional-family.sql"),
        "utf8",
      ),
    );
    store.close();
    const core = await start();
    const page = await session(core);
    const saves = () => {
      const db = openWritable(databasePath(home));
      try {
        return db.db
          .prepare(
            "SELECT o.person_id, o.origin, c.before, c.after FROM operations o JOIN record_changes c ON c.operation_id = o.id ORDER BY o.seq",
          )
          .all()
          .map((row) => {
            const { person_id, origin, before, after } = row as Record<
              string,
              string
            >;
            const was = JSON.parse(before ?? "{}") as Record<string, unknown>;
            const now = JSON.parse(after ?? "{}") as Record<string, unknown>;
            return {
              person_id,
              origin,
              changed: Object.keys(now).filter(
                (key) => JSON.stringify(was[key]) !== JSON.stringify(now[key]),
              ),
            };
          });
      } finally {
        db.close();
      }
    };
    const sent = {
      sending: "s-1",
      in: "settings",
      changes: { blood_group: "B+", sex_for_ranges: "female" },
    };
    const first = await page.api("PUT", "/api/people/ravi/profile", sent);
    expect(first.body).toMatchObject({
      values: { blood_group: "B+", sex_for_ranges: "female", height: null },
      history: [{ madeIn: "settings" }],
    });
    // The same sending again, after a lost answer: saved once.
    expect(
      (await page.api("PUT", "/api/people/ravi/profile", sent)).status,
    ).toBe(200);
    // Asha's sex is female already: only her height is saved.
    await page.api("PUT", "/api/people/asha/profile", {
      sending: "s-2",
      in: "profile",
      changes: { sex_for_ranges: "female", height: { value: 162, unit: "cm" } },
    });
    expect(saves()).toEqual([
      {
        person_id: "ravi",
        origin: "settings",
        changed: ["sex_for_ranges", "blood_group"],
      },
      {
        person_id: "asha",
        origin: "profile",
        changed: ["height", "height_unit"],
      },
    ]);
    expect(
      (await page.api("GET", "/api/people/asha/profile")).body,
    ).toMatchObject({
      values: {
        birth_date: { date: "1990-03", words: "March 1990" },
        blood_group: null,
      },
    });
    expect(
      (
        await page.api("PUT", "/api/people/nobody/profile", {
          ...sent,
          sending: "s-3",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await page.api("PUT", "/api/people/asha/profile", {
          sending: "s-4",
          in: "settings",
          changes: { birth_date: { date: "1990-13", words: "Smarch 1990" } },
        })
      ).status,
    ).toBe(400);
  });

  it("takes a message at the limit and stores it whole", async () => {
    const core = await start();
    const page = await session(core);
    const c = await chat(page);
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
    const c = await chat(page);
    expect(
      (
        await page.api("POST", `${c.path}/messages`, {
          id: randomUUID(),
          text: "",
        })
      ).status,
    ).toBe(400);
    const tooLong = await page.api("POST", `${c.path}/messages`, {
      text: "x".repeat(10_001),
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toEqual({
      error:
        "A message needs some text or something added to it, and can be at most 10,000 characters.",
    });
    for (const before of ["0", "-1", "1.5", "x", ""]) {
      expect((await page.api("GET", `${c.path}?before=${before}`)).status).toBe(
        400,
      );
    }
    // Only regions Rufi knows, not names every object has.
    for (const emergencyRegion of ["ZZ", "toString"]) {
      expect(
        (await page.api("PUT", "/api/settings", { emergencyRegion })).status,
      ).toBe(400);
    }
  });

  it("keeps each person's chat draft; the last save wins", async () => {
    const core = await start();
    const page = await session(core);
    const c = await chat(page);
    const ravi = addRavi();
    const draft = c.draft;
    expect((await page.api("GET", draft)).body).toEqual({
      text: "",
      refs: [],
    });
    expect((await page.api("PUT", draft, { text: "Start" })).body).toEqual({
      text: "Start",
      refs: [],
    });
    await page.api("PUT", `/api/people/${ravi.id}/chat/draft`, {
      text: "Half written",
    });
    // Another tab saves over it.
    await page.api("PUT", draft, { text: "From the other tab" });
    expect((await page.api("GET", draft)).body).toEqual({
      text: "From the other tab",
      refs: [],
    });
    expect(
      (await page.api("GET", `/api/people/${ravi.id}/chat/draft`)).body,
    ).toMatchObject({ text: "Half written" });

    // Chips are kept with the draft, named from what is stored; another
    // person's is refused and the draft stays as it was.
    const writable = openWritable(databasePath(home));
    try {
      writable.db
        .exec(`INSERT INTO results (id, person_id, category, test_name, value_text, unit, entered_at) VALUES
        ('res-1', '${c.person}', 'lab', 'HbA1c', '6.8', '%', '2026-10-04T09:00:00Z'),
        ('res-r', 'ravi', 'lab', 'LDL', '162', 'mg/dL', '2026-10-04T09:00:00Z')`);
      writable.db
        .exec(`INSERT INTO documents (id, person_id, added_at, added_from, sent_at) VALUES
        ('doc-1', '${c.person}', '2026-10-04T09:00:00Z', 'chat', '2026-10-04T09:00:00Z')`);
    } finally {
      writable.close();
    }
    // A Retry chip keeps its mark to read again through a reload.
    await page.api("PUT", draft, {
      text: "",
      refs: [{ type: "document", id: "doc-1", readAgain: true }],
    });
    expect((await page.api("GET", draft)).body).toMatchObject({
      refs: [{ ref: { type: "document", id: "doc-1", readAgain: true } }],
    });
    const chip = {
      ref: { type: "record", kind: "result", id: "res-1", version: null },
      label: "HbA1c 6.8 %",
      detail: "Lab result in your health record",
    };
    expect(
      (
        await page.api("PUT", draft, {
          text: "Is this high?",
          refs: [{ type: "record", kind: "result", id: "res-1" }],
        })
      ).body,
    ).toEqual({ text: "Is this high?", refs: [chip] });
    expect((await page.api("GET", draft)).body).toEqual({
      text: "Is this high?",
      refs: [chip],
    });
    expect(
      await page.api("PUT", draft, {
        text: "And this?",
        refs: [{ type: "record", kind: "result", id: "res-r" }],
      }),
    ).toMatchObject({
      status: 400,
      body: {
        error:
          "Something added to this message isn't in this person's record. Take it out of the message and add it again.",
      },
    });
    expect((await page.api("GET", draft)).body).toMatchObject({
      text: "Is this high?",
    });
  });

  it("takes a send and empties the box in one step, into the queue or into the running reply; the same send again makes no second message", async () => {
    const core = await start();
    const page = await session(core);
    const c = await chat(page);
    const entries = async () =>
      (
        (await page.api("GET", c.path)).body["entries"] as {
          id: string;
          kind: string;
          text: string;
        }[]
      ).filter((entry) => entry.kind === "message" || entry.kind === "steer");
    // No reply runs: into the queue, and it starts.
    const first = randomUUID();
    expect((await page.say(c.path, "hang", first)).status).toBe(202);
    await until(
      async () =>
        ((await page.api("GET", c.path)).body["turns"] as unknown[]).length > 0,
    );
    // A retry whose answer was lost, while its reply runs: still one
    // message, not passed into the reply, and a newer draft stays.
    await page.api("PUT", c.draft, { text: "A newer draft" });
    expect(await page.say(c.path, "hang", first)).toMatchObject({
      status: 202,
      body: { draft: { text: "A newer draft" } },
    });
    // The reply runs: into it, and the box is empty.
    await page.api("PUT", c.draft, { text: "Only the latest" });
    const id = randomUUID();
    expect(await page.say(c.path, "Only the latest", id)).toMatchObject({
      status: 202,
      body: { id, draft: { text: "", refs: [] } },
    });
    await page.api("PUT", c.draft, { text: "Newer still" });
    expect(await page.say(c.path, "Only the latest", id)).toMatchObject({
      status: 202,
      body: { draft: { text: "Newer still" } },
    });
    await until(async () => (await entries()).length === 2);
    await sleep(200);
    expect(await entries()).toMatchObject([
      { id: first, kind: "message", text: "hang" },
      { id, kind: "steer", text: "Only the latest" },
    ]);
    expect((await page.api("GET", `${c.path}/queue`)).body["items"]).toEqual(
      [],
    );
  });

  it("refuses one person's send of an id another person's send is using", async () => {
    const core = await start({
      adapters: scripted({ slow: ["turn/steer"], slowMs: 600 }),
    });
    const page = await session(core);
    const a = await chat(page);
    // A second person, as family adds one.
    const store = openWritable(databasePath(home));
    store.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('ravi', 'Ravi Fictional');
      INSERT INTO chats (id, person_id, created_at)
        VALUES ('c-ravi', 'ravi', '2026-10-24T09:00:00Z');`);
    store.close();
    const b = { path: "/api/people/ravi/chat" };
    for (const c of [a, b]) await page.say(c.path, "hang");
    // Both replies run, so each send goes into its reply.
    for (const c of [a, b]) {
      await until(async () =>
        (
          (await page.api("GET", c.path)).body["turns"] as { status: string }[]
        ).some((turn) => turn.status === "running"),
      );
    }
    const id = randomUUID();
    const [sentA, sentB] = await Promise.all([
      page.say(a.path, "Fictional A private text", id),
      page.say(b.path, "Fictional B private text", id),
    ]);
    expect(sentA.status).toBe(202);
    expect(sentB).toMatchObject({
      status: 409,
      body: { error: "That message id is already used." },
    });
    const lines = async (path: string) =>
      (
        (await page.api("GET", path)).body["entries"] as {
          id: string;
          text: string;
        }[]
      ).filter((entry) => entry.id === id);
    // It goes into A's reply once Codex takes the steer.
    await until(async () => (await lines(a.path)).length > 0);
    expect(await lines(a.path)).toMatchObject([
      { text: "Fictional A private text" },
    ]);
    expect(await lines(b.path)).toEqual([]);
  });

  it("holds a message the AI couldn't take, with the reason, to send again or remove", async () => {
    // Codex never starts the chat's thread: the message never left.
    const core = await start({
      adapters: scripted({ hang: ["thread/start"] }, { requestMs: 300 }),
    });
    const page = await session(core);
    const c = await chat(page);
    expect((await page.say(c.path, "Hello")).status).toBe(202);
    await until(
      async () =>
        (
          (await page.api("GET", `${c.path}/queue`)).body["items"] as {
            held: string | null;
          }[]
        )[0]?.held === "open_failed",
    );
    expect(
      (await page.api("GET", `${c.path}/queue`)).body["items"],
    ).toMatchObject([
      {
        text: "Hello",
        state: "waiting",
        heldText: "Codex didn't answer thread/start within 0.3 s.",
      },
    ]);
  });

  it("counts a message the AI didn't answer as sent: its reply fails with the error", async () => {
    const core = await start({
      adapters: scripted({ hang: ["turn/start"] }, { requestMs: 300 }),
    });
    const page = await session(core);
    const c = await chat(page);
    await page.say(c.path, "Hello");
    await until(async () => {
      const turns = (await page.api("GET", c.path)).body["turns"] as {
        status: string;
      }[];
      return turns[0]?.status === "failed";
    });
    expect((await page.api("GET", c.path)).body).toMatchObject({
      entries: [{ kind: "message", text: "Hello" }],
      turns: [
        {
          status: "failed",
          endText: "Codex didn't answer turn/start within 0.3 s.",
        },
      ],
    });
    expect((await page.api("GET", `${c.path}/queue`)).body["items"]).toEqual(
      [],
    );
  });

  it("makes the person's chat with them, without the AI; its first message chooses the model, unless one was chosen", async () => {
    // Codex doesn't answer the list of models: the chat doesn't need it.
    let core = await start({ adapters: scripted({ hang: ["model/list"] }) });
    let page = await session(core);
    const c = await chat(page);
    expect(await page.api("GET", c.path)).toMatchObject({
      status: 200,
      body: { chat: { model: null }, entries: [], turns: [], before: null },
    });
    await stop();

    core = await start();
    page = await session(core);
    expect((await page.say(c.path, "Is my TSH still high?")).status).toBe(202);
    await until(
      async () =>
        (
          (await page.api("GET", c.path)).body["chat"] as {
            model: string | null;
          }
        ).model !== null,
    );
    expect((await page.api("GET", c.path)).body["chat"]).toEqual({
      model: "gpt-6-astra",
      effort: "medium",
      context: null,
    });

    // Another person's model, chosen before their first message, stays.
    const ravi = `/api/people/${addRavi().id}/chat`;
    await page.api("PUT", `${ravi}/model`, { model: "gpt-6.1-sol" });
    await page.say(ravi, "Hello");
    await sleep(300);
    expect((await page.api("GET", ravi)).body["chat"]).toEqual({
      model: "gpt-6.1-sol",
      effort: "medium",
      context: null,
    });
  });

  it(
    "keeps a message Rufi stopped during after sending it to the AI as sent, its reply stopped, and goes on",
    { timeout: 20_000 },
    async () => {
      // A core of its own, whose Codex never answers thread/start.
      const child = spawn(
        process.execPath,
        [join(import.meta.dirname, "../../tests/core-process.ts"), home],
        {
          env: {
            ...process.env,
            FAKE_CODEX: JSON.stringify({ hang: ["turn/start"] }),
          },
          stdio: "ignore",
        },
      );
      const exited = new Promise((resolve) => child.once("exit", resolve));
      let queue = "";
      try {
        let link: string | undefined;
        await until(async () => (link = await runningLink(home)) !== undefined);
        const page = await session({
          port: Number(new URL(link ?? "").port),
          launchUrl: () => link ?? "",
        });
        const c = await chat(page);
        queue = `${c.path}/queue`;
        await page.say(c.path, "Outgoing text");
        // Crashed once the message went to the AI: marked as it is sent.
        const sent = openReadOnly(databasePath(home));
        if (!sent) throw new Error("No data yet.");
        try {
          await until(
            () =>
              sent.db
                .prepare(
                  "SELECT 1 FROM chat_queue WHERE state = 'handing_over' AND sent_as IS NOT NULL",
                )
                .get() !== undefined,
          );
        } finally {
          sent.close();
        }
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      // The crash's lock would go stale in 10 s; Rufi starts again.
      await rm(join(home, "rufi.lock"), { recursive: true, force: true });
      const page = await session(await start());
      const path = queue.replace(/\/queue$/, "");
      const turns = async () =>
        (await page.api("GET", path)).body["turns"] as { status: string }[];
      await until(async () => (await turns())[0]?.status === "interrupted");
      expect((await page.api("GET", path)).body).toMatchObject({
        entries: [{ kind: "message", text: "Outgoing text" }],
      });
      expect((await page.api("GET", queue)).body["items"]).toEqual([]);
      // The chat goes on with the next message.
      await page.say(path, "Is my TSH still high?");
      await until(async () => (await turns())[1]?.status === "completed");
    },
  );

  it("takes only Rufi's four models for a chat, also one whose provider isn't signed in, and an old models.json stays as it is, unused", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const old = '{"models": ["gpt-5.5"]}';
    await writeFile(join(home, "models.json"), old);
    const page = await session(await start());
    const c = await chat(page);
    const choose = async (model: string) =>
      (await page.api("PUT", `${c.path}/model`, { model })).status;
    expect(await choose("gpt-5.5")).toBe(400);
    expect(await choose("claude-opus-5-5")).toBe(200);
    expect(await choose("gpt-6.1-sol")).toBe(200);
    expect(await readFile(join(home, "models.json"), "utf8")).toBe(old);
  });

  it("shows the queue and lets the person act on what waits; after a Stop, the next waiting message goes", async () => {
    const core = await start();
    const page = await session(core);
    const c = await chat(page);
    const queue = `${c.path}/queue`;
    await rufiReply(core, page, c.path);
    await page.say(c.path, "B", undefined, "queue");
    await page.say(c.path, "C", undefined, "queue");
    const items = async () =>
      (await page.api("GET", queue)).body["items"] as {
        id: string;
        text: string;
      }[];
    const [b, cc] = await items();
    expect(
      (await page.api("PUT", `${queue}/${b?.id ?? ""}`, { text: "B2" })).status,
    ).toBe(200);
    expect(
      (await page.api("PUT", queue, { ids: [cc?.id, b?.id] })).status,
    ).toBe(200);
    expect((await items()).map((item) => item.text)).toEqual(["C", "B2"]);
    // An order that leaves one out is refused.
    expect((await page.api("PUT", queue, { ids: [b?.id] })).status).toBe(409);
    expect(
      (await page.api("PUT", `${c.path}/model`, { model: "gpt-6.1-sol" }))
        .status,
    ).toBe(409);
    expect((await page.api("DELETE", `${queue}/${b?.id ?? ""}`)).status).toBe(
      200,
    );
    expect(
      (await page.api("DELETE", `${queue}/${b?.id ?? ""}`)).body["error"],
    ).toBe("That message isn't waiting any more.");
    // Stop ends the reply, and what waits goes on by itself.
    expect((await page.api("POST", `${c.path}/stop`)).status).toBe(200);
    await until(async () => (await items()).length === 0);
    await until(async () =>
      (
        (await page.api("GET", c.path)).body["entries"] as {
          kind: string;
          text: string;
        }[]
      ).some((entry) => entry.kind === "reply" && entry.text === "ok:C"),
    );
    expect(
      (
        (await page.api("GET", c.path)).body["entries"] as {
          kind: string;
          text: string;
        }[]
      )
        .filter((entry) => entry.kind === "message")
        .map((entry) => entry.text),
    ).toEqual(["C"]);
  });

  it("streams a snapshot, then every change after it, with no gap", async () => {
    const core = await start();
    const page = await session(core);
    const c = await chat(page);
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

  it("tells an open stream when the chat's model or effort changes", async () => {
    const core = await start();
    const page = await session(core);
    const c = await chat(page);
    const live = stream(core.port, `${c.path}/stream`, page.headers);
    await until(() => live.lines.length > 0);
    expect(live.lines[0]).toMatchObject({
      chat: { model: null, effort: "medium" },
    });
    const changed = () =>
      live.lines.flatMap((line) =>
        line.type === "update" && line.chat ? [line.chat] : [],
      );
    await page.say(c.path, "Hello there");
    await until(async () =>
      (
        (await page.api("GET", c.path)).body["turns"] as { status: string }[]
      ).some((turn) => turn.status === "completed"),
    );
    // The first message chooses the first allowed model; its new thread is
    // told too (it has used no context yet).
    expect(changed()).toEqual([
      { model: "gpt-6-astra", effort: "medium", context: null },
      { model: "gpt-6-astra", effort: "medium", context: null },
    ]);
    await page.api("PUT", `${c.path}/model`, { model: "gpt-6.1-sol" });
    await until(() => changed().length === 3);
    expect(changed()[2]).toEqual({
      model: "gpt-6.1-sol",
      effort: "medium",
      context: null,
    });
    await page.api("PUT", `${c.path}/effort`, { effort: "high" });
    await until(() => changed().length === 4);
    expect(changed()[3]).toEqual({
      model: "gpt-6.1-sol",
      effort: "high",
      context: null,
    });
    expect(
      await page.api("PUT", `${c.path}/effort`, { effort: "ultra" }),
    ).toMatchObject({ status: 400 });
    live.hangUp();
  });

  it("gives a screen that reconnects during a reply the text so far, then the rest", async () => {
    const core = await start();
    const page = await session(core);
    const c = await chat(page);
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

  it("goes on after a move in a fresh AI thread that has the saved chat", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "rufi-moved-"));
    home = (await findDataFolder({ env: {}, userHome })).path;
    const log = join(userHome, "fake.jsonl");
    // Started from the data folder in use: after the move, the moved one,
    // whose AI folder (codex/) is new.
    const adapters = () => [
      codexAdapter({
        home,
        ...agentSetup(home),
        command: { file: process.execPath, args: [FAKE] },
        env: {
          PATH: process.env["PATH"] ?? "",
          FAKE_CODEX: "{}",
          FAKE_CODEX_LOG: log,
        },
        version: "0.0.0",
      }),
    ];
    const turns = async (page: Awaited<ReturnType<typeof session>>) =>
      (await page.api("GET", c.path)).body["turns"] as {
        status: string;
        newThread: boolean;
      }[];
    let page = await session(await start({ adapters: adapters() }));
    const c = await chat(page);
    await page.say(c.path, "Is my TSH still high?");
    await until(async () => (await turns(page))[0]?.status === "completed");
    await stop();

    const moved = join(userHome, "Rufi data");
    await moveData({ env: {}, userHome }, moved, () =>
      Promise.resolve("/dev/disk3s1s1 on / (apfs, local, journaled)\n"),
    );
    home = (await findDataFolder({ env: {}, userHome })).path;
    expect(home).toBe(moved);
    page = await session(await start({ adapters: adapters() }));
    await page.say(c.path, "And my iron?");
    await until(async () => (await turns(page))[1]?.status === "completed");

    expect((await turns(page)).map((turn) => turn.newThread)).toEqual([
      false,
      true,
    ]);
    const entries = (await page.api("GET", c.path)).body["entries"] as {
      kind: string;
      text: string;
    }[];
    expect(
      entries.filter((e) => e.kind === "reply").map((e) => e.text),
    ).toEqual(["ok:Is my TSH still high?", "ok:And my iron?"]);
    const lines = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            received?: {
              method?: string;
              params?: { threadId?: string; input?: { text: string }[] };
            };
          },
      )
      .flatMap(({ received }) => (received ? [received] : []));
    // Rufi doesn't try the old thread: a resume would write to the old folder.
    expect(lines.map((line) => line.method)).not.toContain("thread/resume");
    const started = lines.flatMap((line) =>
      line.method === "turn/start" ? [line.params ?? {}] : [],
    );
    expect(started).toHaveLength(2);
    // Another thread, and its first input holds the chat before the move.
    expect(started[1]?.threadId).not.toBe(started[0]?.threadId);
    const input = (started[1]?.input ?? []).map((part) => part.text).join("\n");
    expect(input).toContain("Is my TSH still high?");
    expect(input).toContain("ok:Is my TSH still high?");
    expect(input).toContain("And my iron?");
  });

  it(
    "closes the stream of a screen that falls behind; it reloads without gaps",
    { timeout: 60_000 },
    async () => {
      const core = await start({ behindMax: 20 });
      const page = await session(core);
      const c = await chat(page);
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
  it("says whether Codex and Claude are signed in, as each reports it", async () => {
    const core = await start({ adapters: scripted({ signedIn: false }) });
    const page = await session(core);
    const out = { state: "signed_out", account: null, text: null };
    expect((await page.api("GET", "/api/status")).body).toEqual({
      codex: out,
      claude: out,
    });
    await stop();
    const again = await session(await start());
    expect((await again.api("GET", "/api/status")).body).toEqual({
      codex: { state: "signed_in", account: "asha@example.com", text: null },
      claude: out,
    });
  });

  it("keeps each provider's sign-in as it last said: a send asks neither provider, and a reply that finds Codex signed out shows it at once", async () => {
    const log = join(home, "fake.jsonl");
    const adapters = scripted({}, { log });
    /** How often Codex itself was asked how it's signed in. */
    const reads = async () =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter((line) => line.includes('"method":"account/read"')).length;
    const codex = codexSignIn(adapters[0] as CodexAdapter, () => undefined);
    let asked = 0;
    let out = false;
    const page = await session(
      await start({
        adapters,
        signIns: {
          codex: {
            ...codex,
            status: (signal) => {
              asked += 1;
              return out
                ? Promise.resolve({
                    state: "signed_out",
                    account: null,
                    text: null,
                  })
                : codex.status(signal);
            },
          },
        },
      }),
    );
    const { path } = await chat(page);
    const replies = async () =>
      ((await page.api("GET", path)).body["turns"] as { status: string }[])
        .length;
    // Rufi's own first ask, at its start.
    await page.api("GET", "/api/status");
    const before = await reads();
    for (const [n, text] of ["Hello", "And again"].entries()) {
      expect((await page.say(path, text)).status).toBe(202);
      await until(async () => (await replies()) === n + 1);
    }
    expect(asked).toBe(1);
    expect(await reads()).toBe(before);

    // Codex's sign-in ends between asks: the reply says so, and Rufi hears it.
    out = true;
    expect((await page.say(path, "sign-in ended")).status).toBe(202);
    await until(
      async () =>
        (
          (await page.api("GET", "/api/status")).body["codex"] as {
            state: string;
          }
        ).state === "signed_out",
    );
    expect((await page.say(path, "Again")).status).toBe(409);
  });

  it("when Rufi can't ask Codex, says Codex's words, and a send says them too, not signed out", async () => {
    const page = await session(
      await start({ adapters: scripted({ refuse: ["account/read"] }) }),
    );
    const text = "Codex refused account/read: The fake refused account/read.";
    expect((await page.api("GET", "/api/status")).body["codex"]).toEqual({
      state: "unavailable",
      account: null,
      text,
    });
    const { path } = await chat(page);
    expect(await page.say(path, "Fictional question")).toMatchObject({
      status: 409,
      body: { error: text },
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

  it("keeps the appearance apart from the region; system until one is chosen", async () => {
    const core = await start();
    const page = await session(core);
    expect((await page.api("GET", "/api/settings")).body["appearance"]).toBe(
      "system",
    );
    await page.api("PUT", "/api/settings", { emergencyRegion: "IN" });
    const dark = await page.api("PUT", "/api/settings", {
      appearance: "dark",
    });
    expect(dark.body).toMatchObject({
      appearance: "dark",
      emergencyRegion: "IN",
    });
    await page.api("PUT", "/api/settings", { emergencyRegion: null });
    expect((await page.api("GET", "/api/settings")).body["appearance"]).toBe(
      "dark",
    );
    for (const appearance of ["blue", null, "toString"]) {
      expect(
        (await page.api("PUT", "/api/settings", { appearance })).status,
      ).toBe(400);
    }
  });

  it("keeps when Activity opens by itself: while the AI works until one is chosen, also after a restart", async () => {
    let core = await start();
    let page = await session(core);
    expect((await page.api("GET", "/api/settings")).body["activity"]).toBe(
      "working",
    );
    expect(
      (await page.api("PUT", "/api/settings", { activity: "hidden" })).body,
    ).toMatchObject({ activity: "hidden", appearance: "system" });
    for (const activity of ["folded", null]) {
      expect(
        (await page.api("PUT", "/api/settings", { activity })).status,
      ).toBe(400);
    }
    await stop();
    core = await start();
    page = await session(core);
    expect((await page.api("GET", "/api/settings")).body["activity"]).toBe(
      "hidden",
    );
  });

  it("converts the device batches stored while it was closed, shows them in Settings, and a shorter keep deletes at once", async () => {
    await start();
    await stop();
    const days = (n: number) =>
      new Date(Date.now() - n * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19) + "Z";
    const resting = (id: string, start: string) => ({
      id,
      type: "HKQuantityTypeIdentifierRestingHeartRate",
      value: 54,
      unit: "count/min",
      start,
      end: start,
    });
    const closed = openWritable(databasePath(home));
    try {
      closed.db.exec(
        "INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional')",
      );
      const store = devices(closed, () => new Date().toISOString());
      const made = await store.addSource({
        name: "Asha's iPhone",
        system: "apple_health",
      });
      if (!("source" in made)) throw new Error("no source");
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          batch: "p-1",
          values: [resting("v-old", days(40)), resting("v-new", days(2))],
          deleted: [],
        }),
      );
      expect(await store.receive(made.source.id, bytes)).toMatchObject({
        answer: "got_it",
      });
    } finally {
      closed.close();
    }

    const core = await start();
    const page = await session(core);
    const values = async () =>
      (
        (await page.api("GET", "/api/devices")).body["sources"] as {
          values: number;
        }[]
      )[0]?.values;
    await until(async () => (await values()) === 2);
    expect((await page.api("GET", "/api/devices")).body).toMatchObject({
      sources: [
        {
          name: "Asha's iPhone",
          person: { name: "Asha Fictional" },
          waiting: 0,
          skipped: 0,
          failed: null,
        },
      ],
      trouble: null,
    });
    expect(
      (await page.api("GET", "/api/settings")).body["deviceKeepValues"],
    ).toBe("forever");
    expect(
      (await page.api("GET", "/api/devices/preview?keep=30d")).body,
    ).toMatchObject({ values: 1 });
    expect(
      (await page.api("GET", "/api/devices/preview?keep=week")).status,
    ).toBe(400);

    const saved = await page.api("PUT", "/api/settings", {
      deviceKeepValues: "30d",
    });
    expect(saved.body["deviceKeepValues"]).toBe("30d");
    // Deleted at once, in the background.
    await until(async () => (await values()) === 1);
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
    await writeFile(
      join(screens, "index.html"),
      '<!doctype html><html lang="en"><p>Rufi',
    );
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

  it("serves the page in the chosen appearance, for the app's window too, also after a restart", async () => {
    let core = await start({ screens });
    const appearance = async (path: string) => {
      const page = await call(core.port, "GET", path);
      return {
        page: /<html[^>]* data-appearance="(\w+)"/.exec(page.text)?.[1],
        app: page.headers[APPEARANCE_HEADER],
      };
    };
    expect(await appearance("/")).toEqual({ page: "system", app: "system" });

    const changed = await (
      await session(core)
    ).api("PUT", "/api/settings", { appearance: "dark" });
    expect(changed.headers[APPEARANCE_HEADER]).toBe("dark");
    for (const path of ["/", "/help/glossary", "/index.html"]) {
      expect(await appearance(path)).toEqual({ page: "dark", app: "dark" });
    }
    // Only pages: the scripts are the same for everyone.
    expect(
      (await call(core.port, "GET", "/assets/app-1a2b.js")).headers[
        APPEARANCE_HEADER
      ],
    ).toBeUndefined();

    await stop();
    core = await start({ screens });
    expect(await appearance("/")).toEqual({ page: "dark", app: "dark" });
    expect(
      (await (await session(core)).api("GET", "/api/settings")).headers[
        APPEARANCE_HEADER
      ],
    ).toBe("dark");
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

describe("the files a reply shows", () => {
  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
    "hex",
  );
  let outside: string;

  beforeEach(async () => {
    const ai = join(home, "ai");
    await mkdir(join(ai, "analysis"), { recursive: true });
    await writeFile(join(ai, "analysis", "sugar-vs-sleep.png"), PNG);
    await writeFile(
      join(ai, "results.html"),
      "<!doctype html><title>Fictional results</title><p>HbA1c",
    );
    await writeFile(join(ai, "notes.md"), "# Fictional notes");
    await writeFile(join(ai, "drawing.svg"), "<svg/>");
    const generated = join(home, "codex", "generated_images", "thread-1");
    await mkdir(generated, { recursive: true });
    await writeFile(join(generated, "call-1.png"), PNG);
    // Beside the data folder, and in it but outside the two roots.
    outside = await mkdtemp(join(tmpdir(), "rufi-outside-"));
    await writeFile(join(outside, "elsewhere.png"), PNG);
    await mkdir(join(home, "codex", "sessions"), { recursive: true });
    await writeFile(join(home, "codex", "sessions", "other.png"), PNG);
    await symlink(join(outside, "elsewhere.png"), join(ai, "escape.png"));
    await symlink(outside, join(ai, "up"));
    await mkdir(join(ai, "folder.png"));
  });
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  const fileOf = (page: Awaited<ReturnType<typeof session>>, path: string) =>
    page.api("GET", `/api/files?path=${encodeURIComponent(path)}`);

  it("gives a short-lived address for a picture or a page in the AI's folder or Codex's generated images, and serves only by it", async () => {
    const core = await start();
    const page = await session(core);

    // A relative path is in the AI's folder; an absolute one as written.
    const chart = await fileOf(page, "analysis/sugar-vs-sleep.png");
    expect(chart.status).toBe(200);
    expect(chart.body).toMatchObject({
      name: "sugar-vs-sleep.png",
      shape: "picture",
    });
    const url = String(chart.body["url"]);
    expect(url).toMatch(/^\/files\/[\w-]{43}\/sugar-vs-sleep\.png$/);
    const picture = await call(core.port, "GET", url);
    expect(picture.status).toBe(200);
    expect(picture.headers["content-type"]).toBe("image/png");
    expect(picture.headers["x-content-type-options"]).toBe("nosniff");
    expect(picture.headers["cache-control"]).toBe("no-store");
    expect(picture.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await call(core.port, "HEAD", url)).status).toBe(200);

    const generated = await fileOf(
      page,
      join(home, "codex", "generated_images", "thread-1", "call-1.png"),
    );
    expect(generated.body["shape"]).toBe("picture");
    expect(
      (await call(core.port, "GET", String(generated.body["url"]))).status,
    ).toBe(200);

    const results = await fileOf(page, join(home, "ai", "results.html"));
    expect(results.body["shape"]).toBe("page");

    // Without the screens' proofs there is no address; a made-up one, or
    // one for another file, serves nothing.
    expect(
      (
        await call(
          core.port,
          "GET",
          `/api/files?path=${encodeURIComponent("results.html")}`,
        )
      ).status,
    ).toBe(401);
    const token = url.split("/")[2] ?? "";
    for (const path of [
      `/files/${"a".repeat(43)}/sugar-vs-sleep.png`,
      `/files/${token}`,
      "/files/",
    ]) {
      expect((await call(core.port, "GET", path)).status).toBe(404);
      expect((await call(core.port, "HEAD", path)).status).toBe(404);
    }
    // The name in the address is only a name: the address names one file.
    expect(
      (await call(core.port, "GET", `/files/${token}/results.html`)).headers[
        "content-type"
      ],
    ).toBe("image/png");
  });

  it("refuses what is outside the two places, a link leading out, and what it doesn't show", async () => {
    const core = await start();
    const page = await session(core);
    for (const path of [
      join(outside, "elsewhere.png"),
      "../codex/sessions/other.png",
      join(home, "codex", "sessions", "other.png"),
      join(home, "rufi.sqlite"),
      "escape.png",
      "up/elsewhere.png",
      "folder.png",
      "notes.md",
      "drawing.svg",
      "https://example.com/chart.png",
      "data:image/png;base64,AAAA",
      "",
    ]) {
      const refused = await fileOf(page, path);
      expect(refused.status, path).toBe(403);
      expect(refused.body["url"], path).toBeUndefined();
    }
  });

  it("says a file is gone when it was, also after its address was given", async () => {
    const core = await start();
    const page = await session(core);
    const gone = await fileOf(page, "reports/old-results.html");
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({
      missing: true,
      error: "This file is no longer in the AI's folder.",
    });

    const results = await fileOf(page, "results.html");
    const chart = await fileOf(page, "analysis/sugar-vs-sleep.png");
    await rm(join(home, "ai", "results.html"));
    await rm(join(home, "ai", "analysis", "sugar-vs-sleep.png"));
    // A page's frame says so; the picture is simply not there.
    const frame = await call(core.port, "GET", String(results.body["url"]));
    expect(frame.status).toBe(404);
    expect(frame.text).toContain("This file is no longer in the AI's folder.");
    expect(frame.headers["content-security-policy"]).toMatch(
      /^sandbox allow-scripts;/,
    );
    expect(
      (await call(core.port, "GET", String(chart.body["url"]))).status,
    ).toBe(404);
  });

  it("checks the file again on every request: a file swapped for a link leading out is refused", async () => {
    const core = await start();
    const page = await session(core);
    const chart = await fileOf(page, "analysis/sugar-vs-sleep.png");
    const target = join(home, "ai", "analysis", "sugar-vs-sleep.png");
    await rm(target);
    await symlink(join(outside, "elsewhere.png"), target);
    expect(
      (await call(core.port, "GET", String(chart.body["url"]))).status,
    ).toBe(404);
  });

  it("stops serving an address after its time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const core = await start();
      const page = await session(core);
      const url = String((await fileOf(page, "results.html")).body["url"]);
      expect((await call(core.port, "GET", url)).status).toBe(200);
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      expect((await call(core.port, "GET", url)).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves a page under its own policy in place of the screens': locked, self-contained, framed only by Rufi", async () => {
    const core = await start();
    const page = await session(core);
    const origin = `http://127.0.0.1:${String(core.port)}`;
    const url = String((await fileOf(page, "results.html")).body["url"]);
    const direct = await call(core.port, "GET", url);
    expect(direct.text).toContain("Open this page from the chat in Rufi.");
    expect(direct.text).not.toContain("Fictional results");
    const served = await call(core.port, "GET", url, {
      "Sec-Fetch-Dest": "iframe",
    });
    expect(served.headers["content-type"]).toBe("text/html; charset=utf-8");
    const policy = String(served.headers["content-security-policy"]);
    // One policy, not the screens' as well.
    expect(policy).not.toContain("script-src 'self'");
    expect(policy.split(/;\s*/)).toEqual(
      expect.arrayContaining([
        "sandbox allow-scripts",
        "default-src 'none'",
        "script-src 'unsafe-inline' 'unsafe-eval'",
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        `frame-ancestors ${origin}`,
      ]),
    );
    expect(policy).not.toMatch(/https?:(?!\/\/127\.0\.0\.1)|allow-same-origin/);
    // The screens may frame only these, and only from Rufi itself.
    const screens = (await page.api("GET", "/api/people")).headers[
      "content-security-policy"
    ];
    expect(screens).toContain(
      `frame-src blob: ${origin}/files/ ${origin}/diagram.html;`,
    );
  });
});

describe("Rufi's log", () => {
  it("holds the core's events and none of the chat", async () => {
    const core = await start({ log: diagnostics(home).log });
    const page = await session(core);
    const c = await chat(page);
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
      prepare: async () => {
        await mkdir(join(home, "codex"));
        await writeFile(join(home, "codex", "auth.json"), "{}");
      },
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
  it("makes one person with one chat from two tabs", async () => {
    const core = await start();
    const page = await session(core);
    const second = await session(core);
    await page.api("POST", "/api/first-run", { step: "welcome" });

    const both = await Promise.all([
      page.api("POST", "/api/people", aboutYou("Asha Fictional")),
      second.api("POST", "/api/people", aboutYou("Asha F.")),
    ]);
    expect(both.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409]);
    const people = (await page.api("GET", "/api/people")).body["people"] as {
      id: string;
    }[];
    expect(people).toHaveLength(1);
    expect(
      (await page.api("GET", `/api/people/${people[0]?.id ?? ""}/chat`)).body,
    ).toMatchObject({ entries: [], before: null });
  });

  it("saves About you whole: the person, their chat and profile together, from the welcome; when a value can't be kept, nobody is left behind and the step stays", async () => {
    const page = await session(await start());
    await page.api("POST", "/api/first-run", { step: "welcome" });
    const refused = await page.api("POST", "/api/people", {
      displayName: "Asha Fictional",
      profile: {
        birth_date: { date: "1990-02-31", words: "31 February 1990" },
        sex_for_ranges: "female",
      },
    });
    expect(refused.status).toBe(400);
    expect((await page.api("GET", "/api/people")).body["people"]).toEqual([]);
    expect((await page.api("GET", "/api/first-run")).body["step"]).toBe("name");

    const added = await page.api("POST", "/api/people", {
      ...aboutYou("Asha Fictional"),
      profile: { ...aboutYou("").profile, blood_group: null },
    });
    expect(added.status).toBe(201);
    const id = (added.body["person"] as { id: string }).id;
    // Blood group and height were left empty: only what was given is saved.
    expect((await page.api("GET", `/api/people/${id}/profile`)).body).toEqual({
      values: {
        name: "Asha Fictional",
        birth_date: { date: "1990-03", words: "March 1990" },
        sex_for_ranges: "female",
        blood_group: null,
        height: null,
      },
      age: expect.any(Array) as unknown,
      history: [
        {
          save: expect.any(String) as unknown,
          at: expect.any(String) as unknown,
          madeIn: "welcome",
          fields: [
            {
              field: "birth_date",
              before: null,
              after: { date: "1990-03", words: "March 1990" },
            },
            { field: "sex_for_ranges", before: null, after: "female" },
          ],
        },
      ],
    });
  });

  it("skips the sign-in step when Codex is already signed in, and stays done after signing out", async () => {
    let codex: ProviderStatus = {
      state: "signed_in",
      account: "asha@example.com",
      text: null,
    };
    const page = await session(
      await start({
        signIns: {
          codex: { status: () => Promise.resolve(codex), start: vi.fn() },
        },
      }),
    );
    await page.api("POST", "/api/first-run", { step: "welcome" });
    await page.api("POST", "/api/people", aboutYou("Asha Fictional"));
    expect((await page.api("GET", "/api/first-run")).body["step"]).toBe(
      "region",
    );
    await page.api("POST", "/api/first-run", { step: "region" });

    codex = { state: "signed_out", account: null, text: null };
    expect((await page.api("GET", "/api/first-run")).body["step"]).toBe("done");
  });
});

describe("signing in from the screens", () => {
  it("opens Codex's own sign-in, gives its link, and is signed in once Codex says so", async () => {
    const page = await session(
      await start({ adapters: scripted({ signedIn: false }) }),
    );
    const state = async () => (await page.api("GET", "/api/signin")).body;
    const codex = async () =>
      (await page.api("GET", "/api/status")).body["codex"];
    expect(await codex()).toMatchObject({ state: "signed_out" });

    await page.api("POST", "/api/signin", { provider: "codex" });
    await until(async () => (await state())["state"] === "done");
    expect(await codex()).toEqual({
      state: "signed_in",
      account: "asha@example.com",
      text: null,
    });
  });

  it("opens one sign-in at a time, gives its link, and says when it is done or why it failed", async () => {
    const runs: PromiseWithResolvers<undefined>[] = [];
    const claude: ProviderSignIn = {
      status: () =>
        Promise.resolve({ state: "signed_out", account: null, text: null }),
      start: ({ showLink }) => {
        showLink("https://claude.ai/oauth/authorize?fictional=1");
        const run = Promise.withResolvers<undefined>();
        runs.push(run);
        return run.promise;
      },
    };
    const page = await session(await start({ signIns: { claude } }));
    const state = async () => (await page.api("GET", "/api/signin")).body;
    expect(await state()).toEqual({
      provider: null,
      state: "idle",
      link: null,
      error: null,
    });

    await page.api("POST", "/api/signin", { provider: "claude" });
    await page.api("POST", "/api/signin", { provider: "claude" });
    expect(runs).toHaveLength(1);
    expect(await state()).toEqual({
      provider: "claude",
      state: "waiting",
      link: "https://claude.ai/oauth/authorize?fictional=1",
      error: null,
    });
    runs[0]?.reject(new Error("Login failed: the code was not accepted."));
    await until(async () => (await state())["state"] === "failed");
    expect((await state())["error"]).toBe(
      "Login failed: the code was not accepted.",
    );

    await page.api("POST", "/api/signin", { provider: "claude" });
    runs[1]?.resolve(undefined);
    await until(async () => (await state())["state"] === "done");
  });
});

describe("documents over the API", () => {
  const FIXTURES = join(import.meta.dirname, "../../tests/fixtures/documents");
  const fixture = async (name: string) =>
    new File([await readFile(join(FIXTURES, name))], name);

  /** Adds `files` as the Documents page does: one form, in order. */
  const add = async (
    core: Core,
    page: Awaited<ReturnType<typeof session>>,
    person: string,
    files: File[],
    together = true,
  ) => {
    const form = new FormData();
    for (const file of files) form.append("file", file);
    form.append("together", together ? "yes" : "no");
    const answer = await fetch(
      `http://127.0.0.1:${String(core.port)}/api/people/${person}/documents`,
      { method: "POST", headers: page.headers, body: form },
    );
    return { status: answer.status, body: (await answer.json()) as unknown };
  };

  it("finishes a document's late file write and record before releasing the data folder", async () => {
    const core = await start();
    const page = await session(core);
    const { person } = await chat(page);
    const file = await fixture("thyroid-recheck.jpg");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = createHash("sha256").update(bytes).digest("hex");
    const path = join(home, "files", id);
    const publishing = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    const rename = fs.rename;
    // Slow disk at the real publication boundary: all document code and
    // the eventual file write run normally.
    const delayed = vi
      .spyOn(fs, "rename")
      .mockImplementation(async (from, to) => {
        if (to === path) {
          publishing.resolve(undefined);
          await finish.promise;
        }
        await rename(from, to);
      });
    syncBuiltinESMExports();
    const adding = add(core, page, person, [file]).catch(() => undefined);
    let stopping: Promise<void> | undefined;
    try {
      await publishing.promise;
      let stopped = false;
      stopping = stop().then(() => {
        stopped = true;
      });
      // Seconds later, the disconnected upload still owns the folder: until
      // its file and rows are kept, nothing else may take it.
      await sleep(3_000);
      expect(stopped).toBe(false);
      await expect(holdRufiLock(home, () => undefined)).rejects.toThrow(
        "already running",
      );

      finish.resolve(undefined);
      await stopping;
      await adding;
      const release = await holdRufiLock(home, () => undefined);
      try {
        expect(await readFile(path)).toEqual(Buffer.from(bytes));
      } finally {
        await release();
      }

      // Its record was kept: the same file again is the document there.
      const reopened = await start();
      expect(
        await add(reopened, await session(reopened), person, [file]),
      ).toMatchObject({
        body: { added: [], already: [{ name: file.name }] },
      });
    } finally {
      finish.resolve(undefined);
      await stopping;
      await adding;
      delayed.mockRestore();
      syncBuiltinESMExports();
    }
  }, 10_000);

  it("keeps an added file unsent in the box until a message sends it; taking its chip out first removes it from Rufi", async () => {
    const core = await start();
    const page = await session(core);
    const { person, path } = await chat(page);
    const documents = `/api/people/${person}/documents`;
    const listed = async () =>
      (
        (await page.api("GET", documents)).body["documents"] as {
          id: string;
        }[]
      ).map((d) => d.id);
    const photo = await fixture("thyroid-recheck.jpg");

    const first = (await add(core, page, person, [photo])).body as {
      added: string[];
    };
    const [unsent = ""] = first.added;
    expect(await listed()).toEqual([]);

    // Its chip taken out: it leaves Rufi, its original too.
    expect(
      (await page.api("DELETE", `${documents}/${unsent}/unsent`)).status,
    ).toBe(200);
    expect(await readdir(join(home, "files"))).toEqual([]);
    const again = (await add(core, page, person, [photo])).body as {
      added: string[];
    };
    const [document = ""] = again.added;
    expect(document).not.toBe(unsent);

    // Sent with no words: listed, and taking its chip out leaves it.
    const sent = await page.api("POST", `${path}/messages`, {
      id: randomUUID(),
      text: "",
      refs: [{ type: "document", id: document }],
    });
    expect(sent.status).toBe(202);
    expect(await listed()).toEqual([document]);
    expect(
      await page.api("DELETE", `${documents}/${document}/unsent`),
    ).toMatchObject({
      status: 409,
      body: { error: "This file was already sent." },
    });
    expect(await listed()).toEqual([document]);
  });

  it("adds documents for the person in the path, and shows each file only to them", async () => {
    const core = await start();
    const page = await session(core);
    const { person } = await chat(page);
    const ravi = addRavi();

    const added = await add(core, page, person, [
      await fixture("sunrise-labs-august.pdf"),
      await fixture("thyroid-recheck.jpg"),
      await fixture("sideways.heic"),
    ]);

    expect(added).toEqual({
      status: 201,
      body: { added: [expect.any(String), expect.any(String)], already: [] },
    });
    // Sent from the box, they are listed.
    await page.api("POST", `/api/people/${person}/chat/messages`, {
      id: randomUUID(),
      text: "",
      refs: (added.body as { added: string[] }).added.map((id) => ({
        type: "document",
        id,
      })),
    });
    const listed = (await page.api("GET", `/api/people/${person}/documents`))
      .body["documents"] as { id: string; files: { id: string }[] }[];
    expect(listed.map((d) => d.files.length).sort((a, b) => a - b)).toEqual([
      1, 2,
    ]);
    const pdf = listed.find((d) => d.files.length === 1);
    const photos = listed.find((d) => d.files.length === 2);
    const file = (person: string, document = pdf) =>
      `/api/people/${person}/documents/${document?.id ?? ""}/files/${document?.files[0]?.id ?? ""}`;
    const shown = await fetch(
      `http://127.0.0.1:${String(core.port)}${file(person)}`,
      { headers: page.headers },
    );
    expect(shown.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await shown.arrayBuffer())).toEqual(
      await readFile(join(FIXTURES, "sunrise-labs-august.pdf")),
    );
    const heic = `/api/people/${person}/documents/${photos?.id ?? ""}/files/${photos?.files[1]?.id ?? ""}/display`;
    expect((await page.api("GET", heic)).headers["content-type"]).toBe(
      "image/jpeg",
    );

    expect(
      (await page.api("GET", `/api/people/${ravi.id}/documents`)).body,
    ).toEqual({
      documents: [],
    });
    expect((await page.api("GET", file(ravi.id))).status).toBe(404);
    expect((await page.api("GET", file("nobody"))).status).toBe(404);
    expect(logged).toContain("documents.added");
  });

  it("shows the document page's pages and items to the person only, and refuses a fix made on an older version", async () => {
    const core = await start();
    const page = await session(core);
    const { person } = await chat(page);
    const ravi = addRavi();
    const added = (await add(core, page, person, [
      await fixture("sunrise-labs-august.pdf"),
    ])) as { body: { added: string[] } };
    const document = added.body.added[0] ?? "";
    const store = openWritable(databasePath(home));
    try {
      store.db.exec(`
        INSERT INTO jobs (id, person_id, kind, document_id, state, attempt, targets, created_at)
          VALUES ('j1', '${person}', 'document_read', '${document}', 'done', 1, '[1]', '2026-10-10T09:00:00Z');
        INSERT INTO draft_items (id, person_id, document_id, page, seq, job_id, kind, fields, original, created_at)
          VALUES ('i1', '${person}', '${document}', 1, 1, 'j1', 'lab_result',
            '{"test_name":"Haemoglobin","value_text":"13.2"}', '{"test_name":"Haemoglobin","value_text":"13.2"}', '2026-10-10T09:00:00Z');
      `);
    } finally {
      store.close();
    }
    const at = (who: string) => `/api/people/${who}/documents/${document}`;

    const image = await page.api("GET", `${at(person)}/pages/1`);
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    const items = await page.api("GET", `${at(person)}/items`);
    expect(items.body["items"]).toMatchObject([{ id: "i1", version: 1 }]);
    const fix = (version: number) =>
      page.api("POST", `${at(person)}/items/i1/fix`, {
        version,
        fields: { value_text: "13.4" },
      });
    expect((await fix(1)).body).toMatchObject({
      version: 2,
      fields: { value_text: "13.4" },
      original: { value_text: "13.2" },
    });
    expect(await fix(1)).toMatchObject({
      status: 409,
      body: {
        error: "This result changed in another tab. Your fix wasn't saved.",
        current: { version: 2, fields: { value_text: "13.4" } },
      },
    });

    expect((await page.api("GET", `${at(ravi.id)}/items`)).status).toBe(404);
    expect((await page.api("GET", `${at(ravi.id)}/pages/1`)).status).toBe(404);
    expect(
      (
        await page.api("POST", `${at(ravi.id)}/items/i1/fix`, {
          version: 2,
          fields: { value_text: "1" },
        })
      ).status,
    ).toBe(404);
  });

  it("takes a photo larger than any other request may be", async () => {
    const core = await start();
    const page = await session(core);
    const { person } = await chat(page);
    // A fictional photo of noise: about 3 MB as PNG, over the 1 MB of others.
    const canvas = createCanvas(1000, 1000);
    const context = canvas.getContext("2d");
    const noise = context.createImageData(1000, 1000);
    noise.data.set(randomBytes(noise.data.length));
    for (let i = 3; i < noise.data.length; i += 4) noise.data[i] = 255;
    context.putImageData(noise, 0, 0);
    const photo = await canvas.encode("png");
    expect(photo.byteLength).toBeGreaterThan(1024 * 1024);

    const added = await add(core, page, person, [
      new File([new Uint8Array(photo)], "big.png"),
    ]);

    expect(added.status).toBe(201);
  });

  it("refuses a file that isn't a document in one sentence, and adds nothing", async () => {
    const core = await start();
    const page = await session(core);
    const { person } = await chat(page);

    const refused = await add(core, page, person, [
      await fixture("thyroid-recheck.jpg"),
      new File(["Fictional notes"], "notes.docx"),
    ]);

    expect(refused).toEqual({
      status: 400,
      body: {
        error:
          "notes.docx isn't a PDF, JPEG, PNG or HEIC photo. Nothing was added. Remove it and add the others again.",
      },
    });
    expect(
      (await page.api("GET", `/api/people/${person}/documents`)).body,
    ).toEqual({ documents: [] });
  });
});

describe("backups and export over the API", () => {
  it("makes a backup at start, another on Back up now, and gives the export as a zip", async () => {
    const page = await session(await start());
    const backups = async () => (await page.api("GET", "/api/backups")).body;
    // The start's backup ends with pruning; Back up now joins it until then.
    await until(async () => (await backups())["running"] === false);
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
    // Sent from its file, which goes once the answer has ended.
    await until(
      async () =>
        (await readdir(home)).filter((n) => n.startsWith(".export-")).length ===
        0,
    );
  });

  it(
    "stops the export and removes it when the person goes while it is made",
    { timeout: 60_000 },
    async () => {
      await start();
      await stop();
      // Enough values that making the export takes a while.
      const record = openWritable(databasePath(home));
      record.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
      INSERT INTO device_sources (id, person_id, system, name, created_at)
        VALUES ('src', 'asha', 'apple_health', 'Asha''s Watch', '2026-10-01T00:00:00Z');
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000)
      INSERT INTO device_values (person_id, system, external_id, source_id, type, value, start_at, end_at)
        SELECT 'asha', 'apple_health', 'v-' || i, 'src', 'heart_rate', 60 + i % 40,
               '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z' FROM n;`);
      record.close();
      const core = await start();
      const page = await session(core);
      const staging = async () =>
        (await readdir(home)).filter((n) => n.startsWith(".export-"));

      const request = httpRequest({
        host: "127.0.0.1",
        port: core.port,
        path: "/api/export",
        headers: { host: `127.0.0.1:${String(core.port)}`, ...page.headers },
      });
      request.on("error", () => undefined);
      request.end();
      await until(async () => (await staging()).length > 0);
      request.destroy();

      await until(async () => (await staging()).length === 0, 20_000);
    },
  );

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
    "restores a backup made during a reply: drafts and history are there, the reply shows interrupted, and the next message starts a new thread",
    { timeout: 30_000 },
    async () => {
      const core = await start();
      const page = await session(core);
      const c = await chat(page);
      await page.say(c.path, "Please remember my fictional cat Biscuit");
      await until(async () =>
        (
          (await page.api("GET", c.path)).body["turns"] as { status: string }[]
        ).every((turn) => turn.status === "completed"),
      );
      await rufiReply(core, page, c.path);
      await page.say(
        c.path,
        "A waiting fictional question",
        undefined,
        "queue",
      );
      await page.api("PUT", c.draft, { text: "An unsent fictional note" });
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
          adapters: scripted({ threads: { earlier: { history: ["a", "b"] } } }),
        }),
      );

      const snapshot = (await restored.api("GET", c.path)).body as {
        turns: { status: string }[];
      };
      expect(snapshot.turns.map((t) => t.status)).toEqual([
        "completed",
        "interrupted",
      ]);
      expect((await restored.api("GET", c.draft)).body["text"]).toBe(
        "An unsent fictional note",
      );
      // What waited comes back held, for the person to send or remove.
      expect(
        (await restored.api("GET", `${c.path}/queue`)).body["items"],
      ).toMatchObject([
        { text: "A waiting fictional question", held: "restored" },
      ]);
      // Nothing ran by itself; the next message starts a new thread (the copy
      // has none of the AI's files), told the chat's last messages.
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
      expect(
        (await restored.api("GET", `${c.path}/queue`)).body["items"],
      ).toMatchObject([{ held: "restored" }]);
      // The chat shows where a new thread started.
      expect(
        (
          (await restored.api("GET", c.path)).body["turns"] as {
            newThread: boolean;
          }[]
        ).map((turn) => turn.newThread),
      ).toEqual([false, false, true]);
    },
  );
});
