// The core as the screens will meet it: started in a scope on a fictional
// data folder with the scripted Codex, and used over HTTP like a browser.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
import { PROOF_HEADER } from "./api.ts";
import { startCore, type Core, type CoreOptions } from "./core.ts";

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
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
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
async function session(core: Core) {
  const launch = new URL(core.launchUrl()).searchParams.get("launch") ?? "";
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
      // A paused stream learns of a cut connection only as an error.
      res.on("error", () => {
        ended.resolve(undefined);
      });
    },
  );
  // Hanging up, or being cut off, ends the stream; that's not an error here.
  req.on("error", () => {
    ended.resolve(undefined);
  });
  // A paused stream hears of a cut connection only from its socket.
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
    const text = `${"é".repeat(99_999)}x`;
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
      text: "x".repeat(100_001),
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toEqual({
      error:
        "A message needs some text, and can be at most 100,000 characters.",
    });
    // Only regions Rufi knows, not names every object has.
    for (const emergencyRegion of ["ZZ", "toString"]) {
      expect(
        (await page.api("PUT", "/api/settings", { emergencyRegion })).status,
      ).toBe(400);
    }
  });

  it("keeps a draft per conversation, and one for a new conversation", async () => {
    const core = await start();
    const page = await session(core);
    const c = await conversation(page);
    await page.api("PUT", `/api/people/${c.person}/drafts/new`, {
      text: "Start here",
    });
    await page.api("PUT", `/api/people/${c.person}/drafts/${c.id}`, {
      text: "Half written",
    });
    expect(
      (await page.api("GET", `/api/people/${c.person}/drafts/new`)).body,
    ).toEqual({ text: "Start here" });
    expect(
      (await page.api("GET", `/api/people/${c.person}/drafts/${c.id}`)).body,
    ).toEqual({ text: "Half written" });
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
