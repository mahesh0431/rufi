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
import { setTimeout as sleep } from "node:timers/promises";
import type { Status, StreamLine } from "@rufi/contracts";
import { APPEARANCE_HEADER } from "@rufi/contracts/app";
import { createCanvas } from "@napi-rs/canvas";
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexRuntime } from "../agent/codex/codex.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
} from "../core/store/database.ts";
import { backupsPath } from "../core/store/backup.ts";
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
          ...agentSetup(home),
          command: { file: process.execPath, args: [FAKE] },
          env: { PATH: process.env["PATH"] ?? "", FAKE_CODEX: "{}" },
          token: () => Promise.resolve("token"),
          version: "0.0.0",
          tools,
          host,
        }),
      log: (event) => logged.push(event),
      account: () =>
        Promise.resolve({ account: "signed_in", email: "asha@example.com" }),
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
    /** Sends a box's text, by a new send id (or `id`, to send it again). */
    say: (
      path: string,
      text: string,
      kind: "messages" | "steer" = "messages",
      id: string = randomUUID(),
    ) => call(core.port, "POST", `${path}/${kind}`, headers, { id, text }),
  };
}

/** The scripted Codex playing `scenario` (FAKE_CODEX), for start(). */
const scripted =
  (scenario: object, more: { requestMs?: number } = {}) =>
  (...[tools, host]: Parameters<CoreOptions["agent"]>) =>
    codexRuntime({
      home,
      ...agentSetup(home),
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

/** A person, through the API, and their chat. */
async function chat(page: Awaited<ReturnType<typeof session>>) {
  const person = (
    await page.api("POST", "/api/people", { displayName: "Asha Fictional" })
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

  it("marks the hand-overs a crash cut off as not sure, never sends them again, and holds what waits until the person sends", async () => {
    const left = openWritable(databasePath(home));
    left.db.exec(`
      INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional');
      INSERT INTO chats (id, person_id, created_at) VALUES ('c-asha', 'asha', '2026-10-04T09:00:00Z');
      INSERT INTO chat_queue (id, person_id, chat_id, origin, text, position, state, sent_as, created_at, updated_at) VALUES
        ('q-1', 'asha', 'c-asha', 'person', 'Being handed over', 1, 'handing_over', 'q-1', '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z'),
        ('q-2', 'asha', 'c-asha', 'person', 'Waiting', 2, 'waiting', NULL, '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z');`);
    left.close();
    const page = await session(await start());
    await sleep(300);
    expect((await page.api("GET", "/api/people/asha/chat/queue")).body).toEqual(
      {
        paused: "restarted",
        items: [
          {
            id: "q-1",
            origin: "person",
            text: "Being handed over",
            state: "not_sure",
            held: null,
            heldText: null,
            refs: [],
          },
          {
            id: "q-2",
            origin: "person",
            text: "Waiting",
            state: "waiting",
            held: null,
            heldText: null,
            refs: [],
          },
        ],
      },
    );
    expect(
      (await page.api("GET", "/api/people/asha/chat")).body["turns"],
    ).toEqual([]);
    const queue = "/api/people/asha/chat/queue";
    const said = async () =>
      (
        (await page.api("GET", "/api/people/asha/chat")).body["entries"] as {
          id: string;
          kind: string;
          text: string;
        }[]
      ).filter((entry) => entry.kind === "message");
    // The person sends what waits: the one not sure stays.
    expect((await page.api("POST", `${queue}/q-2/send`)).status).toBe(200);
    await until(async () => (await said()).length === 1);
    await sleep(300);
    expect((await page.api("GET", queue)).body["items"]).toMatchObject([
      { id: "q-1", state: "not_sure" },
    ]);
    // Sent again only when asked, as a new message.
    expect((await page.api("POST", `${queue}/q-1/send`)).status).toBe(200);
    await until(async () => (await said()).length === 2);
    const [, again] = await said();
    expect(again?.text).toBe("Being handed over");
    expect(again?.id).not.toBe("q-1");
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
          ...agentSetup(home),
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
      (await page.api("POST", `${c.path}/messages`, { text: "" })).status,
    ).toBe(400);
    const tooLong = await page.api("POST", `${c.path}/messages`, {
      text: "x".repeat(10_001),
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toEqual({
      error: "A message needs some text, and can be at most 10,000 characters.",
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
    } finally {
      writable.close();
    }
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

  it("takes a send into the queue and empties the box in one step; the same send again makes no second message", async () => {
    const core = await start();
    const page = await session(core);
    const c = await chat(page);
    const queue = `${c.path}/queue`;
    // A reply runs, so the send waits.
    expect((await page.say(c.path, "hang")).status).toBe(202);
    await until(
      async () =>
        ((await page.api("GET", c.path)).body["turns"] as unknown[]).length > 0,
    );
    await page.api("PUT", c.draft, { text: "First" });
    const id = randomUUID();
    const sent = await page.say(c.path, "First", "messages", id);
    expect(sent).toMatchObject({
      status: 202,
      body: { id, draft: { text: "", refs: [] } },
    });
    // A retry whose answer was lost: still one waiting row, and the box
    // stays empty.
    expect((await page.say(c.path, "First", "messages", id)).status).toBe(202);
    const waiting = (await page.api("GET", queue)).body["items"] as {
      id: string;
    }[];
    expect(waiting).toMatchObject([{ text: "First", state: "waiting" }]);
    expect((await page.api("GET", c.draft)).body).toEqual({
      text: "",
      refs: [],
    });
    // Sent after a Stop: one message.
    expect((await page.api("POST", `${c.path}/stop`)).status).toBe(200);
    expect(
      (await page.api("POST", `${queue}/${waiting[0]?.id ?? ""}/send`)).status,
    ).toBe(200);
    await until(async () =>
      (
        (await page.api("GET", c.path)).body["turns"] as { status: string }[]
      ).some((turn) => turn.status === "completed"),
    );
    await sleep(200);
    const said = (
      (await page.api("GET", c.path)).body["entries"] as {
        id: string;
        kind: string;
        text: string;
      }[]
    ).filter((entry) => entry.kind === "message");
    expect(said).toMatchObject([{ text: "hang" }, { id, text: "First" }]);
    // A steer after the reply ended: refused, and the box keeps its text.
    await page.api("PUT", c.draft, { text: "Only the latest" });
    expect(await page.say(c.path, "Only the latest", "steer")).toMatchObject({
      status: 409,
      body: {
        error:
          "The reply had ended, so this wasn't passed into it. Send it as a new message.",
      },
    });
    expect((await page.api("GET", c.draft)).body).toEqual({
      text: "Only the latest",
      refs: [],
    });
  });

  it("holds a message the AI couldn't take, with the reason, to send again or remove", async () => {
    // Codex never starts the chat's thread: the message never left.
    const core = await start({
      agent: scripted({ hang: ["thread/start"] }, { requestMs: 300 }),
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
        )[0]?.held === "failed",
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

  it("marks a hand-over the AI didn't answer as not sure, and pauses the chat", async () => {
    const core = await start({
      agent: scripted({ hang: ["turn/start"] }, { requestMs: 300 }),
    });
    const page = await session(core);
    const c = await chat(page);
    await page.say(c.path, "Hello");
    await until(
      async () =>
        (
          (await page.api("GET", `${c.path}/queue`)).body["items"] as {
            state: string;
          }[]
        )[0]?.state === "not_sure",
    );
    expect((await page.api("GET", `${c.path}/queue`)).body["paused"]).toBe(
      "stopped",
    );
  });

  it("makes the person's chat with them, without the AI; its first message chooses the model, unless one was chosen", async () => {
    // Codex doesn't answer the list of models: the chat doesn't need it.
    let core = await start({ agent: scripted({ hang: ["model/list"] }) });
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
    });

    // Another person's model, chosen before their first message, stays.
    const ravi = `/api/people/${addRavi().id}/chat`;
    await page.api("PUT", `${ravi}/model`, { model: "gpt-6.1-sol" });
    await page.say(ravi, "Hello");
    await sleep(300);
    expect((await page.api("GET", ravi)).body["chat"]).toEqual({
      model: "gpt-6.1-sol",
      effort: "medium",
    });
  });

  it(
    "marks a message Rufi stopped during while handing it over as not sure, never sent again",
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
        await until(
          async () =>
            (
              (await page.api("GET", queue)).body["items"] as {
                state: string;
              }[]
            )[0]?.state === "handing_over",
        );
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
      // The crash's lock would go stale in 10 s; Rufi starts again.
      await rm(join(home, "rufi.lock"), { recursive: true, force: true });
      const page = await session(await start());
      await sleep(300);
      expect((await page.api("GET", queue)).body["items"]).toMatchObject([
        { text: "Outgoing text", state: "not_sure" },
      ]);
    },
  );

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

  it("shows the queue and lets the person act on what waits", async () => {
    const core = await start();
    const page = await session(core);
    const c = await chat(page);
    const queue = `${c.path}/queue`;
    expect((await page.say(c.path, "hang")).status).toBe(202);
    await until(
      async () =>
        ((await page.api("GET", c.path)).body["turns"] as unknown[]).length > 0,
    );
    await page.say(c.path, "B");
    await page.say(c.path, "C");
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
    expect((await page.say(c.path, "faster", "steer")).status).toBe(200);
    expect(
      (await page.api("PUT", `${c.path}/model`, { model: "gpt-6.1-sol" }))
        .status,
    ).toBe(409);
    expect((await page.api("POST", `${c.path}/stop`)).status).toBe(200);
    expect((await page.api("GET", queue)).body["paused"]).toBe("stopped");
    expect((await page.api("DELETE", `${queue}/${b?.id ?? ""}`)).status).toBe(
      200,
    );
    expect(
      (await page.api("DELETE", `${queue}/${b?.id ?? ""}`)).body["error"],
    ).toBe("That message isn't waiting any more.");
    expect(
      (await page.api("POST", `${queue}/${cc?.id ?? ""}/send`)).status,
    ).toBe(200);
    await until(async () => (await items()).length === 0);
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
    // The first message chooses the first allowed model.
    await until(() => changed().length === 1);
    expect(changed()).toEqual([{ model: "gpt-6-astra", effort: "medium" }]);
    await until(async () =>
      (
        (await page.api("GET", c.path)).body["turns"] as { status: string }[]
      ).every((turn) => turn.status === "completed"),
    );
    await page.api("PUT", `${c.path}/model`, { model: "gpt-6.1-sol" });
    await until(() => changed().length === 2);
    expect(changed()[1]).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
    await page.api("PUT", `${c.path}/effort`, { effort: "high" });
    await until(() => changed().length === 3);
    expect(changed()[2]).toEqual({ model: "gpt-6.1-sol", effort: "high" });
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
    const agent: CoreOptions["agent"] = (tools, host) =>
      codexRuntime({
        home,
        ...agentSetup(home),
        command: { file: process.execPath, args: [FAKE] },
        env: {
          PATH: process.env["PATH"] ?? "",
          FAKE_CODEX: "{}",
          FAKE_CODEX_LOG: log,
        },
        token: () => Promise.resolve("token"),
        version: "0.0.0",
        tools,
        host,
      });
    const turns = async (page: Awaited<ReturnType<typeof session>>) =>
      (await page.api("GET", c.path)).body["turns"] as {
        status: string;
        afresh: boolean;
      }[];
    let page = await session(await start({ agent }));
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
    page = await session(await start({ agent }));
    await page.say(c.path, "And my iron?");
    await until(async () => (await turns(page))[1]?.status === "completed");

    expect((await turns(page)).map((turn) => turn.afresh)).toEqual([
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
  it("says whether the AI can be used, without a sign-in by default", async () => {
    const core = await start({
      account: () => Promise.resolve({ account: "signed_out", email: null }),
    });
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
  it("makes one person with one chat from two tabs", async () => {
    const core = await start();
    const page = await session(core);
    const second = await session(core);
    await page.api("POST", "/api/first-run", { step: "welcome" });

    const both = await Promise.all([
      page.api("POST", "/api/people", { displayName: "Asha Fictional" }),
      second.api("POST", "/api/people", { displayName: "Asha F." }),
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

      const reopened = await session(await start());
      expect(
        (await reopened.api("GET", `/api/people/${person}/documents`)).body,
      ).toMatchObject({
        documents: [
          {
            files: [{ id, name: file.name, mediaType: "image/jpeg", pages: 1 }],
          },
        ],
      });
    } finally {
      finish.resolve(undefined);
      await stopping;
      await adding;
      delayed.mockRestore();
      syncBuiltinESMExports();
    }
  }, 10_000);

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
      fields: { value_text: "13.4", value_number: 13.4 },
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
      const c = await chat(page);
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
      await page.say(c.path, "A waiting fictional question");
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
      expect(logged).toContain("chat.resume_failed");
      expect(
        (await restored.api("GET", `${c.path}/queue`)).body["items"],
      ).toMatchObject([{ held: "restored" }]);
      // The chat shows where the AI started afresh.
      expect(
        (
          (await restored.api("GET", c.path)).body["turns"] as {
            afresh: boolean;
          }[]
        ).map((turn) => turn.afresh),
      ).toEqual([false, false, true]);
    },
  );
});
