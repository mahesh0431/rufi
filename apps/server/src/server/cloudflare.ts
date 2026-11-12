// Cloudflare Tunnel as a route to the remote door (docs/adr/0035): a tunnel
// of Rufi's own in the person's Cloudflare account, and the address's
// record pointing at it. Setup runs through Cloudflare's API with the
// person's token, used for that call only: never stored or logged. The
// tunnel's own secret stays in the data folder's `cloudflare/`, which Rufi
// AI's commands can't read. cloudflared runs as Rufi's child, so no tunnel
// outlives the door.
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { killGroup, spawnWatched } from "../agent/codex/processes.ts";
import { readJson, writePrivateJson } from "../platform/files.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import { RouteProblem, type RemoteRoute } from "./remote-route.ts";

const API = "https://api.cloudflare.com/client/v4";
/** How long setup may take, and each of its calls to Cloudflare. */
const SETUP_MS = 60_000;
const CALL_MS = 10_000;
/** How long cloudflared has to end before it is killed. */
const STOP_MS = 5_000;

/** Everything Cloudflare in the data folder `home`. */
export const cloudflareFolder = (home: string) => join(home, "cloudflare");

/** The tunnel's credentials, in cloudflared's own file format. */
interface Credentials {
  AccountTag: string;
  TunnelID: string;
  TunnelName: string;
  TunnelSecret: string;
}

/** What Settings shows: the tunnel and the address its record names. */
interface Saved {
  tunnel: string;
  address: string;
}

export interface CloudflareOptions {
  home: string;
  /** Asks Cloudflare's API, as `fetch` does. */
  api?: (url: string, init: RequestInit) => Promise<Response>;
  /** Where cloudflared is looked for, in order. */
  places?: readonly string[];
  log: Log;
}

export interface Cloudflare {
  route: RemoteRoute;
  /** Whether cloudflared is on this Mac, and the address set up. */
  state: () => Promise<{ installed: boolean; address: string | null }>;
  /**
   * Makes the tunnel (or reuses Rufi's own) and the record for `address`
   * with the person's `token`; then the route uses `address`. Refused with
   * one line, leaving the address set up before as it was.
   */
  setup: (address: string, token: string) => Promise<void>;
}

/** Homebrew's places, then the PATH Rufi has. */
const PLACES = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  ...(process.env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== ""),
].map((dir) => join(dir, "cloudflared"));

/** A hostname: letters, digits and hyphens, in two labels or more. */
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function cloudflare(options: CloudflareOptions): Cloudflare {
  const { log } = options;
  const folder = cloudflareFolder(options.home);
  const tunnelFile = join(folder, "tunnel.json");
  const routeFile = join(folder, "route.json");
  const configFile = join(folder, "config.yml");
  const api = options.api ?? ((url, init) => fetch(url, init));
  let child: ChildProcess | undefined;
  let stopped: string | null = null;

  /** The first cloudflared found, or none. */
  const binary = async () => {
    for (const place of options.places ?? PLACES) {
      const found = await access(place, constants.X_OK).then(
        () => true,
        () => false,
      );
      if (found) return place;
    }
    return undefined;
  };

  const saved = async (): Promise<Saved | undefined> => {
    const read = (await readJson(routeFile)) as Partial<Saved> | undefined;
    return typeof read?.tunnel === "string" && typeof read.address === "string"
      ? { tunnel: read.tunnel, address: read.address }
      : undefined;
  };

  const credentials = async (): Promise<Credentials | undefined> => {
    const read = (await readJson(tunnelFile)) as
      | Partial<Credentials>
      | undefined;
    return typeof read?.AccountTag === "string" &&
      typeof read.TunnelID === "string"
      ? (read as Credentials)
      : undefined;
  };

  /** Runs cloudflared for `using` to the door on `port`, unless it runs. */
  const run = async (port: number) => {
    const using = await saved();
    const tunnel = await credentials();
    if (!using || tunnel?.TunnelID !== using.tunnel) {
      throw new RouteProblem("Set up Cloudflare first.");
    }
    if (child) return using.address;
    const command = await binary();
    if (command === undefined) {
      throw new RouteProblem(
        "Install cloudflared on this Mac first: brew install cloudflared",
      );
    }
    // Rufi's own routing: its address to the door, nothing else.
    await writeFile(
      configFile,
      [
        `tunnel: ${using.tunnel}`,
        `credentials-file: ${JSON.stringify(tunnelFile)}`,
        "ingress:",
        `  - hostname: ${using.address}`,
        `    service: http://127.0.0.1:${String(port)}`,
        "  - service: http_status:404",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    // Only file paths in its arguments, and its own HOME: it never reads
    // the person's ~/.cloudflared.
    const started = spawnWatched(
      "rufi-cloudflared",
      command,
      ["tunnel", "--no-autoupdate", "--config", configFile, "run"],
      {
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: folder },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    started.once("error", (error) => {
      log("remote.failed", { error: errorCode(error) });
    });
    started.once("exit", (code, signal) => {
      if (child !== started) return;
      child = undefined;
      log("remote.failed", { code: signal ?? String(code) });
      stopped = "Cloudflare Tunnel stopped. Restart Rufi to start it again.";
    });
    child = started;
    stopped = null;
    return using.address;
  };

  /** Stops cloudflared: TERM, then its group goes after STOP_MS. */
  const stop = async () => {
    const running = child;
    child = undefined;
    stopped = null;
    if (!running || running.exitCode !== null || running.signalCode !== null) {
      return;
    }
    const ended = new Promise<void>((resolve) => {
      running.once("exit", () => {
        resolve();
      });
    });
    const timer = setTimeout(() => {
      killGroup(running.pid ?? 0);
    }, STOP_MS);
    running.kill("SIGTERM");
    await ended;
    clearTimeout(timer);
  };

  const route: RemoteRoute = {
    label: "Cloudflare Tunnel",
    up: (port) => run(port),
    resume: async (port) => {
      await run(port);
    },
    down: stop,
    close: stop,
    trouble: () => stopped,
  };

  return {
    route,

    state: async () => ({
      installed: (await binary()) !== undefined,
      address: (await saved())?.address ?? null,
    }),

    setup: async (address, token) => {
      const name = address.trim().toLowerCase();
      if (!HOSTNAME.test(name)) {
        throw new RouteProblem(
          "Type the address as a name, like rufi.example.com.",
        );
      }
      if ((await binary()) === undefined) {
        throw new RouteProblem(
          "Install cloudflared on this Mac first: brew install cloudflared",
        );
      }
      const deadline = AbortSignal.timeout(SETUP_MS);
      /** One call to Cloudflare with the token; its `result`. */
      const call = async (
        what: string,
        path: string,
        body?: unknown,
      ): Promise<unknown> => {
        let response: Response;
        try {
          response = await api(`${API}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            ...(body !== undefined && { body: JSON.stringify(body) }),
            redirect: "error",
            signal: AbortSignal.any([deadline, AbortSignal.timeout(CALL_MS)]),
          });
        } catch (error) {
          log("remote.failed", { error: errorCode(error) });
          throw new RouteProblem("Rufi couldn't reach Cloudflare. Try again.", {
            cause: error,
          });
        }
        const said = (await response.json().catch(() => ({}))) as {
          success?: unknown;
          errors?: { message?: unknown }[];
          result?: unknown;
        };
        if (!response.ok || said.success !== true) {
          // Cloudflare's own words, as they came.
          const words = (said.errors ?? [])
            .map((error) => error.message)
            .filter((message) => typeof message === "string")
            .join(" ");
          log("remote.failed", { code: String(response.status) });
          throw new RouteProblem(
            `Cloudflare couldn't ${what}: ${words === "" ? `it answered ${String(response.status)}` : words}`,
          );
        }
        return said.result;
      };

      // The domain: the zone whose name is the longest end of the address.
      const labels = name.split(".");
      let zone: { id: string; account: string } | undefined;
      for (let at = 0; at < labels.length - 1 && !zone; at += 1) {
        const candidate = labels.slice(at).join(".");
        const found = (await call(
          "find the address's domain",
          `/zones?name=${encodeURIComponent(candidate)}`,
        )) as { id: string; name: string; account: { id: string } }[];
        const match = found.find((each) => each.name === candidate);
        if (match) zone = { id: match.id, account: match.account.id };
      }
      if (!zone) {
        throw new RouteProblem(
          "That address isn't in a domain this token can reach.",
        );
      }

      // Rufi's own tunnel in this account, or a new one.
      let tunnel = await credentials();
      if (tunnel?.AccountTag !== zone.account) {
        const secret = randomBytes(32).toString("base64");
        const made = (await call(
          "create the tunnel",
          `/accounts/${zone.account}/cfd_tunnel`,
          {
            name: `rufi-${randomBytes(4).toString("hex")}`,
            config_src: "local",
            tunnel_secret: secret,
          },
        )) as { id: string; name: string };
        tunnel = {
          AccountTag: zone.account,
          TunnelID: made.id,
          TunnelName: made.name,
          TunnelSecret: secret,
        };
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await writePrivateJson(tunnelFile, tunnel);
      }

      // The address's record: one to this tunnel stays; Cloudflare refuses
      // to add one beside any other, in its own words, so none is replaced.
      const target = `${tunnel.TunnelID}.cfargotunnel.com`;
      const records = (await call(
        "read the address's records",
        `/zones/${zone.id}/dns_records?name=${encodeURIComponent(name)}`,
      )) as { type: string; content: string; proxied?: boolean }[];
      const ours = records.some(
        (record) =>
          record.type === "CNAME" &&
          record.content === target &&
          record.proxied === true,
      );
      if (!ours) {
        await call(
          "add the address's record",
          `/zones/${zone.id}/dns_records`,
          {
            type: "CNAME",
            name,
            content: target,
            proxied: true,
          },
        );
      }

      // The commit: from now the route uses this address.
      await writePrivateJson(routeFile, {
        tunnel: tunnel.TunnelID,
        address: name,
      } satisfies Saved);
      log("remote.set_up");
    },
  };
}
