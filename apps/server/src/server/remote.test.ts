// The remote door as a paired app, its web view and Settings › iPhone meet
// it: the core started on a fictional data folder, with Tailscale stood in
// for (no real `tailscale` runs), its check reaching the door as Serve would.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexAdapter } from "../agent/codex/adapter.ts";
import { databasePath, openWritable } from "../core/store/database.ts";
import { PROOF_HEADER } from "./api.ts";
import { agentSetup, startCore, type Core } from "./core.ts";
import { TailscaleProblem, type Tailscale } from "./tailscale.ts";

const FAKE = join(import.meta.dirname, "../../tests/fake-codex.ts");
const NAME = "asha-mbp.tail1234.ts.net";

let home: string;
let scope: Scope.Closeable | undefined;
/** What the stand-in Tailscale was asked: "serve <port>", "off <port>". */
let asked: string[];
let logged: string[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rufi-remote-"));
  asked = [];
  logged = [];
  const store = openWritable(databasePath(home));
  store.db.exec(`
    INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional'), ('ravi', 'Ravi Fictional');
    INSERT INTO chats (id, person_id, created_at) VALUES
      ('c-asha', 'asha', '2026-10-04T09:00:00Z'), ('c-ravi', 'ravi', '2026-10-04T09:00:00Z');
  `);
  store.close();
});
afterEach(async () => {
  vi.useRealTimers();
  await stop();
});

interface Reply {
  status: number;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      // A connection of its own: one a refusal (413) closed is never reused.
      { host: "127.0.0.1", port, method, path, headers, agent: false },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: text.startsWith("{")
              ? (JSON.parse(text) as Record<string, unknown>)
              : {},
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.setHeader("content-type", "application/json");
      req.end(typeof body === "string" ? body : JSON.stringify(body));
    } else req.end();
  });
}

/** Tailscale as on a Mac signed in with HTTPS on; `more` changes a step. */
const standIn = (more: Partial<Tailscale> = {}): Tailscale => ({
  name: () => Promise.resolve(NAME),
  serve: (port) => {
    asked.push(`serve ${String(port)}`);
    return Promise.resolve();
  },
  off: (port) => {
    asked.push(`off ${String(port)}`);
    return Promise.resolve();
  },
  // Serve passes the request on with its Host, as it came.
  check: async (origin, answers) => {
    const { host, port } = new URL(origin);
    const answer = await call(
      Number(port),
      "POST",
      "/api/pair",
      { host },
      { code: "check", name: "check" },
    );
    const response = new Response(JSON.stringify(answer.body), {
      status: answer.status,
    });
    if (!(await answers(response))) throw new TailscaleProblem("no answer");
  },
  ...more,
});

async function start(
  tailscale: Tailscale = standIn(),
  screens?: string,
): Promise<Core> {
  const opened = await Effect.runPromise(Scope.make());
  const core = await Effect.runPromise(
    startCore({
      home,
      adapters: [
        codexAdapter({
          home,
          ...agentSetup(home),
          command: { file: process.execPath, args: [FAKE] },
          env: { PATH: process.env["PATH"] ?? "", FAKE_CODEX: "{}" },
          version: "0.0.0",
        }),
      ],
      log: (event) => logged.push(event),
      tailscale,
      ...(screens !== undefined && { screens }),
    }).pipe(Scope.provide(opened)),
  );
  scope = opened;
  return core;
}

async function stop(): Promise<void> {
  const open = scope;
  scope = undefined;
  if (open) await Effect.runPromise(Scope.close(open, Exit.void));
}

/** Settings on the Mac: the screens' session, as a page has it. */
async function settings(core: Core) {
  const launch =
    new URLSearchParams(new URL(core.launchUrl()).hash.slice(1)).get(
      "launch",
    ) ?? "";
  const origin = `http://127.0.0.1:${String(core.port)}`;
  const host = `127.0.0.1:${String(core.port)}`;
  const swapped = await call(
    core.port,
    "POST",
    "/api/session",
    { host, origin },
    { launch },
  );
  const headers = {
    host,
    origin,
    cookie: String(swapped.headers["set-cookie"]?.[0]).split(";")[0] ?? "",
    [PROOF_HEADER]: String(swapped.body["proof"]),
  };
  return (method: string, path: string, body?: unknown) =>
    call(core.port, method, path, headers, body);
}

/** Pair an iPhone for `personId`: the link Settings shows. */
async function pairingLink(
  api: Awaited<ReturnType<typeof settings>>,
  personId = "asha",
) {
  const made = await api("POST", "/api/paired-apps/pairing", { personId });
  expect(made.status).toBe(200);
  const link = new URL((made.body["pairing"] as { link: string }).link);
  return {
    port: Number(link.port),
    code: new URLSearchParams(link.hash.slice(1)).get("code") ?? "",
  };
}

/** A request to the door, through Serve: by the Mac's tailnet name. */
const door = (
  port: number,
  method: string,
  path: string,
  { key, ...headers }: Record<string, string> = {},
  body?: unknown,
) =>
  call(
    port,
    method,
    path,
    {
      host: `${NAME}:${String(port)}`,
      ...(key !== undefined && { authorization: `Bearer ${key}` }),
      ...headers,
    },
    body,
  );

const pair = (port: number, code: string) =>
  door(port, "POST", "/api/pair", {}, { code, name: "Asha's iPhone" });

/** An app paired for `personId`: the door's port, its key and its id. */
async function paired(
  api: Awaited<ReturnType<typeof settings>>,
  personId = "asha",
) {
  const { port, code } = await pairingLink(api, personId);
  const answer = (await pair(port, code)).body;
  return {
    port,
    key: String(answer["key"]),
    id: (answer["app"] as { id: string }).id,
  };
}

/** The launch token of a link the app asked for with its key. */
async function launchOf(port: number, key: string, path = "/") {
  const opened = await door(port, "POST", "/api/open", { key }, { path });
  expect(opened.status).toBe(200);
  const url = new URL(String(opened.body["url"]));
  expect(`${url.origin}${url.pathname}`).toBe(
    `https://${NAME}:${String(port)}${path}`,
  );
  return new URLSearchParams(url.hash.slice(1)).get("launch") ?? "";
}

/**
 * The app's web view swapping a launch for its session, sending `cookie`
 * if its cookie jar has one: the headers its page then sends.
 */
async function webView(port: number, launch: string, cookie?: string) {
  const origin = `https://${NAME}:${String(port)}`;
  const swapped = await door(
    port,
    "POST",
    "/api/session",
    { origin, ...(cookie !== undefined && { cookie }) },
    { launch },
  );
  const set = swapped.headers["set-cookie"]?.[0] ?? "";
  return {
    status: swapped.status,
    set,
    headers: {
      origin,
      cookie: set.split(";")[0] ?? "",
      [PROOF_HEADER]: String(swapped.body["proof"]),
    },
  };
}

/** A live chat stream through the door: whether it ended, and a way to hang up. */
function stream(
  port: number,
  path: string,
  { key, ...headers }: Record<string, string>,
) {
  const lines: unknown[] = [];
  const ended = Promise.withResolvers<undefined>();
  let status = 0;
  const done = () => {
    ended.resolve(undefined);
  };
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path,
      headers: {
        host: `${NAME}:${String(port)}`,
        ...(key !== undefined && { authorization: `Bearer ${key}` }),
        ...headers,
      },
    },
    (res) => {
      status = res.statusCode ?? 0;
      createInterface({ input: res })
        .on("line", (line) => lines.push(line))
        .on("error", done);
      res.on("close", done);
      res.on("error", done);
    },
  );
  req.on("error", done);
  req.end();
  return {
    lines,
    ended: ended.promise,
    status: () => status,
    hangUp: () => {
      req.destroy();
    },
  };
}

/**
 * The answer to a body over 1 MB. It is sent and then held open: the door
 * refuses as soon as it has read past the limit, and closes, so nothing may
 * still be writing then.
 */
function tooLarge(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/pair",
        headers: {
          host: `${NAME}:${String(port)}`,
          "content-type": "application/json",
        },
        agent: false,
      },
      (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
        req.destroy();
      },
    );
    req.on("error", reject);
    req.write(`{"code":"${"x".repeat(1024 * 1024 + 1)}`);
  });
}

/** Whether `promise` settles within `ms`. */
const within = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

async function until(ready: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(20);
  }
}

describe("pairing", () => {
  it("pairs once for the person chosen; the key reads who it is, and the same code again makes nothing", async () => {
    const core = await start();
    const api = await settings(core);
    const { port, code } = await pairingLink(api);
    expect(asked).toEqual([`serve ${String(port)}`]);

    const paired = await pair(port, code);
    expect(paired.status).toBe(200);
    expect(paired.body).toMatchObject({
      app: { id: expect.any(String) as string },
      person: { id: "asha", name: "Asha Fictional" },
      mac: "asha-mbp",
    });
    const key = String(paired.body["key"]);
    const me = await door(port, "GET", "/api/me", { key });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      person: { id: "asha", name: "Asha Fictional" },
      mac: "asha-mbp",
      folder: paired.body["folder"],
      place: "phone",
      api: 1,
    });

    const again = await pair(port, code);
    expect(again.status).toBe(410);
    expect(again.body["problem"]).toBe("code_expired");
    const listed = await api("GET", "/api/paired-apps");
    expect(listed.body).toMatchObject({
      apps: [
        {
          name: "Asha's iPhone",
          person: { id: "asha", name: "Asha Fictional" },
        },
      ],
      pairing: null,
    });
    expect(logged).toContain("remote.paired");
  });

  it("pairs one app when two use the same code at once", async () => {
    const core = await start();
    const api = await settings(core);
    const { port, code } = await pairingLink(api);

    const both = await Promise.all([pair(port, code), pair(port, code)]);

    expect(both.map(({ status }) => status).sort((a, b) => a - b)).toEqual([
      200, 410,
    ]);
    expect(
      ((await api("GET", "/api/paired-apps")).body["apps"] as unknown[]).length,
    ).toBe(1);
  });

  it("makes nothing with a code past its 10 minutes, and the door closes when nothing is paired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const core = await start();
    const api = await settings(core);
    const { port, code } = await pairingLink(api);

    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    const late = await pair(port, code);

    expect(late.status).toBe(410);
    expect(
      ((await api("GET", "/api/paired-apps")).body["apps"] as unknown[]).length,
    ).toBe(0);
    // Closing the pairing: no code, no app, so Serve stops and the door closes.
    await api("POST", "/api/paired-apps/pairing/cancel");
    expect(asked).toEqual([`serve ${String(port)}`, `off ${String(port)}`]);
    await expect(pair(port, code)).rejects.toThrow();
  });

  it("shows Tailscale's line and no code when a step fails, and leaves nothing open", async () => {
    const core = await start(
      standIn({
        serve: () =>
          Promise.reject(
            new TailscaleProblem(
              "Tailscale couldn't serve Rufi: Serve is not enabled on your tailnet.",
            ),
          ),
      }),
    );
    const api = await settings(core);

    const made = await api("POST", "/api/paired-apps/pairing", {
      personId: "asha",
    });

    expect(made.status).toBe(409);
    expect(made.body["error"]).toBe(
      "Tailscale couldn't serve Rufi: Serve is not enabled on your tailnet.",
    );
    expect((await api("GET", "/api/paired-apps")).body["pairing"]).toBeNull();
  });
});

describe("a paired app's key", () => {
  it("stops working once unpaired on the Mac, or by the app itself; the door closes after the last", async () => {
    const core = await start();
    const api = await settings(core);
    let link = await pairingLink(api);
    const first = String((await pair(link.port, link.code)).body["key"]);
    link = await pairingLink(api);
    const second = (await pair(link.port, link.code)).body;
    const { port } = link;

    // The app unpairs itself: its key is refused from then on.
    expect(
      (await door(port, "POST", "/api/unpair", { key: first })).status,
    ).toBe(200);
    const refused = await door(port, "GET", "/api/me", { key: first });
    expect(refused.status).toBe(401);
    expect(refused.body["problem"]).toBe("unpaired");
    expect(
      (await door(port, "GET", "/api/me", { key: String(second["key"]) }))
        .status,
    ).toBe(200);

    // Unpaired on the Mac: the last one, so Serve stops and the door closes.
    const appId = (second["app"] as { id: string }).id;
    const unpaired = await api("POST", `/api/paired-apps/${appId}/unpair`);
    expect(unpaired.body["apps"]).toEqual([]);
    expect(asked.at(-1)).toBe(`off ${String(port)}`);
    await expect(
      door(port, "GET", "/api/me", { key: String(second["key"]) }),
    ).rejects.toThrow();
    expect(logged.filter((event) => event === "remote.unpaired")).toHaveLength(
      2,
    );
  });

  it("opens the door again when Rufi starts with an app paired, on the same port", async () => {
    const { port, code } = await pairingLink(await settings(await start()));
    const key = String((await pair(port, code)).body["key"]);
    await stop();

    await start();

    expect((await door(port, "GET", "/api/me", { key })).status).toBe(200);
    expect(asked).toEqual([`serve ${String(port)}`]);
  });
});

describe("the door", () => {
  it("answers only by the Mac's tailnet name, with the shared protections, and none of the Mac's own routes", async () => {
    const core = await start();
    const api = await settings(core);
    const { port, code } = await pairingLink(api);
    const key = String((await pair(port, code)).body["key"]);

    const wrongHost = await call(port, "GET", "/api/me", {
      host: `127.0.0.1:${String(port)}`,
      authorization: `Bearer ${key}`,
    });
    expect(wrongHost.status).toBe(403);
    expect(
      (
        await door(port, "GET", "/api/me", {
          key,
          origin: "https://elsewhere.example",
        })
      ).status,
    ).toBe(403);

    const me = await door(port, "GET", "/api/me", { key });
    expect(me.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(me.headers["cache-control"]).toBe("no-store");
    expect(wrongHost.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );

    expect(await tooLarge(port)).toBe(413);

    for (const [method, path] of [
      ["GET", "/api/people"],
      ["PUT", "/api/settings"],
      ["GET", "/api/first-run"],
      ["GET", "/api/instructions"],
      ["GET", "/api/signin"],
      ["GET", "/api/paired-apps"],
      ["POST", "/api/paired-apps/pairing"],
      ["GET", "/api/backups"],
      ["GET", "/api/devices"],
      ["GET", "/api/data-folder"],
      ["GET", "/api/export"],
      ["GET", "/api/files?path=a.png"],
      ["POST", "/api/launch"],
    ] as const) {
      expect((await door(port, method, path, { key })).status).toBe(404);
    }
    expect(logged).toContain("remote.refused");
  });
});

describe("a person's routes through the door", () => {
  // Never delete: a paired app reaches only its own person.
  it("refuse another person's id with 404, by key or session, and change nothing", async () => {
    const core = await start();
    const { port, key } = await paired(await settings(core));
    const page = await webView(port, await launchOf(port, key));

    // Asha's own: a read.
    expect(
      (await door(port, "GET", "/api/people/asha/overview", { key })).status,
    ).toBe(200);
    for (const by of [{ key }, page.headers]) {
      for (const [method, path, body] of [
        ["GET", "/api/people/ravi/overview", undefined],
        ["GET", "/api/people/ravi/chat", undefined],
        [
          "POST",
          "/api/people/ravi/chat/messages",
          { id: randomUUID(), text: "What does my report say?" },
        ],
        ["POST", "/api/people/ravi/documents", {}],
      ] as const) {
        expect((await door(port, method, path, by, body)).status).toBe(404);
      }
      const watched = stream(port, "/api/people/ravi/chat/stream", by);
      await watched.ended;
      expect(watched.status()).toBe(404);
    }
    await stop();
    const db = new DatabaseSync(databasePath(home), { readOnly: true });
    try {
      for (const table of ["chat_queue", "turns", "documents"]) {
        expect(
          db
            .prepare(
              `SELECT count(*) AS n FROM ${table} WHERE person_id = 'ravi'`,
            )
            .get(),
        ).toEqual({ n: 0 });
      }
    } finally {
      db.close();
    }
  });
});

describe("the app's sessions", () => {
  let screens: string;
  beforeEach(async () => {
    screens = join(home, "..", `${String(Date.now())}-dist`);
    await mkdir(screens, { recursive: true });
    await writeFile(
      join(screens, "index.html"),
      '<!doctype html><html lang="en"><p>Rufi',
    );
  });

  // Never delete: a launch and a session belong to one app.
  it("open cold from a launch link: the screens, a session, then the person's reads", async () => {
    const core = await start(standIn(), screens);
    const { port, key } = await paired(await settings(core));

    const shell = await door(port, "GET", "/chat");
    expect(shell.status).toBe(200);
    expect(shell.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    const launch = await launchOf(port, key, "/chat");
    const page = await webView(port, launch);
    expect(page.status).toBe(200);
    expect(page.set).toMatch(new RegExp(`^rufi_${String(port)}=`));
    expect(page.set).toContain("Secure");
    expect(page.set).toContain("HttpOnly");
    expect(page.set).toContain("SameSite=Strict");

    const me = await door(port, "GET", "/api/me", page.headers);
    expect(me.body).toMatchObject({
      person: { id: "asha", name: "Asha Fictional" },
      place: "phone",
    });
    for (const path of [
      "/api/settings",
      "/api/status",
      "/api/people/asha/overview",
    ]) {
      expect((await door(port, "GET", path, page.headers)).status).toBe(200);
    }
    // A change needs the door's own page as Origin.
    const { origin: _origin, ...noOrigin } = page.headers;
    expect(
      (
        await door(port, "PUT", "/api/people/asha/chat/draft", noOrigin, {
          text: "Hello",
        })
      ).status,
    ).toBe(403);
    // A session can't do what only the key may.
    expect(
      (await door(port, "POST", "/api/open", page.headers, { path: "/" }))
        .status,
    ).toBe(404);
    expect(
      (
        await door(
          port,
          "POST",
          "/api/open",
          { key },
          {
            path: "//elsewhere.example/",
          },
        )
      ).status,
    ).toBe(400);
  });

  it("take a launch once, within 60 seconds, and never one made before unpairing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const core = await start();
    const api = await settings(core);
    const { port, key, id } = await paired(api);

    const launch = await launchOf(port, key);
    expect((await webView(port, launch)).status).toBe(200);
    expect((await webView(port, launch)).status).toBe(401);

    const late = await launchOf(port, key);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await webView(port, late)).status).toBe(401);

    const before = await launchOf(port, key);
    // A second app keeps the door open after the first is unpaired.
    await paired(api, "ravi");
    await api("POST", `/api/paired-apps/${id}/unpair`);
    expect((await webView(port, before)).status).toBe(401);
  });

  it("give two apps in one cookie jar two sessions, each reaching only its own person", async () => {
    const core = await start();
    const api = await settings(core);
    const asha = await paired(api, "asha");
    const ravi = await paired(api, "ravi");
    const { port } = asha;

    const first = await webView(port, await launchOf(port, asha.key));
    // The jar sends Asha's cookie with Ravi's launch: never reused.
    const second = await webView(
      port,
      await launchOf(port, ravi.key),
      first.headers.cookie,
    );
    expect(second.headers.cookie).not.toBe(first.headers.cookie);

    const reads = async (headers: Record<string, string>) => [
      (await door(port, "GET", "/api/people/asha/overview", headers)).status,
      (await door(port, "GET", "/api/people/ravi/overview", headers)).status,
    ];
    expect(await reads(first.headers)).toEqual([200, 404]);
    expect(await reads(second.headers)).toEqual([404, 200]);
    // One app's cookie with the other's proof belongs to neither.
    expect(
      await reads({ ...first.headers, cookie: second.headers.cookie }),
    ).toEqual([401, 401]);
  });

  it("end the app's old session when it opens a new one, its open stream too", async () => {
    const core = await start();
    const { port, key } = await paired(await settings(core));
    const old = await webView(port, await launchOf(port, key));
    const watched = stream(port, "/api/people/asha/chat/stream", old.headers);
    await until(() => watched.lines.length > 0);

    const fresh = await webView(port, await launchOf(port, key));

    expect(await within(watched.ended, 2_000)).toBe(true);
    expect(
      (await door(port, "GET", "/api/people/asha/overview", old.headers))
        .status,
    ).toBe(401);
    expect(
      (await door(port, "GET", "/api/people/asha/overview", fresh.headers))
        .status,
    ).toBe(200);
  });
});

describe("unpairing", () => {
  // Never delete: unpair ends the app's sessions and streams at once.
  it("ends that app's open streams, and its reconnect gets 401; another app's goes on", async () => {
    const core = await start();
    const api = await settings(core);
    const asha = await paired(api, "asha");
    const ravi = await paired(api, "ravi");
    const { port } = asha;
    const ashaPage = await webView(port, await launchOf(port, asha.key));
    const raviPage = await webView(port, await launchOf(port, ravi.key));
    const ashas = stream(
      port,
      "/api/people/asha/chat/stream",
      ashaPage.headers,
    );
    const ravis = stream(
      port,
      "/api/people/ravi/chat/stream",
      raviPage.headers,
    );
    await until(() => ashas.lines.length > 0 && ravis.lines.length > 0);

    await api("POST", `/api/paired-apps/${asha.id}/unpair`);

    expect(await within(ashas.ended, 2_000)).toBe(true);
    const again = stream(
      port,
      "/api/people/asha/chat/stream",
      ashaPage.headers,
    );
    await again.ended;
    expect(again.status()).toBe(401);
    expect(await within(ravis.ended, 300)).toBe(false);
    expect(
      (await door(port, "GET", "/api/people/ravi/overview", raviPage.headers))
        .status,
    ).toBe(200);
    ravis.hangUp();
  });
});
