// A stand-in for Cloudflare's API and for cloudflared, for tests: one
// fictional account, its zones, tunnels and DNS records in memory, and a
// cloudflared that only says how it was run. No real Cloudflare is asked.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TOKEN = "fictional-cloudflare-token-5f0c7d";
const ACCOUNT = "acc0fictional";

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

/** One request the stand-in API had. */
interface Asked {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

export interface StandInApi {
  api: (url: string, init: RequestInit) => Promise<Response>;
  asked: Asked[];
  tunnels: { id: string; name: string; secret: string }[];
  records: Map<string, DnsRecord[]>;
  /** Makes the next call to `path` (method and path) fail as Cloudflare would. */
  failNext: (route: string) => void;
  /** Holds every call, once asked, until the function it gives is called. */
  hold: () => () => void;
}

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ok = (result: unknown) =>
  answer(200, { success: true, errors: [], messages: [], result });

const refused = (status: number, code: number, message: string) =>
  answer(status, { success: false, errors: [{ code, message }], result: null });

/**
 * Cloudflare's API with `zones` (name → id), each in `accounts`' account
 * for its id, or the one account.
 */
export function cloudflareApi(
  zones: Record<string, string>,
  accounts: Record<string, string> = {},
): StandInApi {
  const accountOf = (zone: string) => accounts[zone] ?? ACCOUNT;
  const asked: Asked[] = [];
  const tunnels: StandInApi["tunnels"] = [];
  const records = new Map<string, DnsRecord[]>(
    Object.values(zones).map((id) => [id, []]),
  );
  const failing = new Set<string>();
  let held: Promise<void> | undefined;

  const api: StandInApi["api"] = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace(/^\/client\/v4/, "");
    const method = init.method ?? "GET";
    const body =
      typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    asked.push({ method, path, body });
    if (held) await held;
    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return refused(400, 6003, "Invalid request headers");
    }
    const route = `${method} ${path}`;
    if (failing.delete(route)) {
      return refused(500, 10000, "Internal error");
    }
    if (method === "GET" && path === "/zones") {
      const name = searchParams.get("name");
      return ok(
        Object.entries(zones)
          .filter(([zone]) => zone === name)
          .map(([zone, id]) => ({
            id,
            name: zone,
            account: { id: accountOf(id) },
          })),
      );
    }
    const creating = /^\/accounts\/([^/]+)\/cfd_tunnel$/.exec(path);
    if (method === "POST" && creating) {
      const made = {
        id: randomUUID(),
        name: String(body?.["name"]),
        secret: String(body?.["tunnel_secret"]),
      };
      tunnels.push(made);
      return ok({ id: made.id, name: made.name, account_tag: creating[1] });
    }
    const dns = /^\/zones\/([^/]+)\/dns_records$/.exec(path);
    const zone = dns && records.get(dns[1] ?? "");
    if (zone && method === "GET") {
      const name = searchParams.get("name");
      return ok(zone.filter((record) => record.name === name));
    }
    if (zone && method === "POST") {
      const name = String(body?.["name"]);
      if (zone.some((record) => record.name === name)) {
        return refused(
          400,
          81053,
          "An A, AAAA, or CNAME record with that host already exists.",
        );
      }
      const made: DnsRecord = {
        id: randomUUID(),
        type: String(body?.["type"]),
        name,
        content: String(body?.["content"]),
        proxied: body?.["proxied"] === true,
      };
      zone.push(made);
      return ok(made);
    }
    return refused(404, 7003, "Could not route to the path");
  };

  return {
    api,
    asked,
    tunnels,
    records,
    failNext: (route) => {
      failing.add(route);
    },
    hold: () => {
      let release = () => {};
      held = new Promise((resolve) => {
        release = () => {
          held = undefined;
          resolve();
        };
      });
      return release;
    },
  };
}

/**
 * A cloudflared in `dir` that writes its arguments and environment to
 * `ran.json` there, then waits to be stopped.
 */
export async function fakeCloudflared(dir: string) {
  await mkdir(dir, { recursive: true });
  const binary = join(dir, "cloudflared");
  const ran = join(dir, "ran.json");
  await writeFile(
    binary,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(ran)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, pid: process.pid }));
setInterval(() => {}, 1000);
`,
  );
  await chmod(binary, 0o755);
  return {
    binary,
    /** How it was run last, once it has started. */
    ran: async () => {
      for (let tries = 0; tries < 100; tries += 1) {
        const text = await readFile(ran, "utf8").catch(() => "");
        if (text !== "") {
          return JSON.parse(text) as {
            args: string[];
            env: Record<string, string>;
            pid: number;
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("The fake cloudflared didn't start.");
    },
  };
}
