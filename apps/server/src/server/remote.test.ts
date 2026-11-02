// The remote door as a paired app and Settings › iPhone meet it: the core
// started on a fictional data folder, with Tailscale stood in for (no real
// `tailscale` runs), its check reaching the door as Serve would.
import { mkdtemp } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      { host: "127.0.0.1", port, method, path, headers },
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

async function start(tailscale: Tailscale = standIn()): Promise<Core> {
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
  const link = new URL(String((made.body["pairing"] as { link: string }).link));
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

    expect(both.map(({ status }) => status).sort()).toEqual([200, 410]);
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
    await api("DELETE", "/api/paired-apps/pairing");
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
    let core = await start();
    const { port, code } = await pairingLink(await settings(core));
    const key = String((await pair(port, code)).body["key"]);
    await stop();

    core = await start();

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

    const large = await door(
      port,
      "POST",
      "/api/pair",
      {},
      JSON.stringify({ code: "x".repeat(1024 * 1024), name: "Asha's iPhone" }),
    );
    expect(large.status).toBe(413);

    for (const [method, path] of [
      ["GET", "/api/people"],
      ["GET", "/api/settings"],
      ["GET", "/api/paired-apps"],
      ["POST", "/api/paired-apps/pairing"],
      ["GET", "/api/backups"],
      ["GET", "/api/export"],
      ["POST", "/api/launch"],
      ["GET", "/api/people/asha/overview"],
    ] as const) {
      expect((await door(port, method, path, { key })).status).toBe(404);
    }
    expect(logged).toContain("remote.refused");
  });
});
