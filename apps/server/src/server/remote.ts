// The remote door (docs/adr/0032): a second listener, on 127.0.0.1 at a port
// of its own, that paired apps reach through Tailscale Serve. It has the
// shared protections of every listener (http.ts) with its own checks: the
// Mac's tailnet name as Host, and who is asking. It runs while an app is
// paired or a pairing code is live. A pairing code lives in memory only:
// single use, 10 minutes, one at a time.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import {
  PairRequest,
  REMOTE_API,
  type Paired,
  type PairedApps as Listed,
  type Pairing,
} from "@rufi/contracts/remote";
import { Hono, type Context } from "hono";
import type { KeyHolder, PairedApps } from "../core/paired/paired-apps.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import { body, HttpError, shared, type App } from "./http.ts";
import { TailscaleProblem, type Tailscale } from "./tailscale.ts";

/** How long a pairing code works. */
const CODE_MS = 10 * 60 * 1000;

/** The door's address and port, kept at a pairing, so Serve's route and the apps' links stay. */
const HOST_SETTING = "remote.host";
const PORT_SETTING = "remote.port";
/** The port Rufi asked Serve to pass on: its own route, removed when nothing needs it. */
const SERVED_SETTING = "remote.served";

const hashOf = (text: string) => createHash("sha256").update(text).digest();

export interface RemoteDeps {
  apps: PairedApps;
  /** The people in the record, for whose record a code opens. */
  people: () => Promise<readonly { id: string; displayName: string }[]>;
  setting: (key: string) => Promise<string | undefined>;
  /** Saves a setting; null removes it. */
  saveSetting: (key: string, value: string | null) => Promise<void>;
  tailscale: Tailscale;
  log: Log;
}

export interface Remote {
  /** At Rufi's start: opens the door when an app is paired. */
  start: () => Promise<void>;
  /** What Settings › iPhone shows. */
  state: () => Promise<Listed>;
  /**
   * The Tailscale steps, then a new code for `personId`'s record; any older
   * code goes. Refused with one line on what to do when a step fails.
   */
  pair: (personId: string) => Promise<Pairing>;
  /** The live code goes. */
  cancel: () => Promise<void>;
  /** Revokes the app; false when it isn't paired. */
  unpair: (appId: string) => Promise<boolean>;
  /** Closes the door, its connections too; Serve's route stays. */
  close: () => Promise<void>;
}

interface Code {
  hash: Buffer;
  person: { id: string; name: string };
  expiresAt: Date;
  link: string;
  timer: NodeJS.Timeout;
}

export function remote(deps: RemoteDeps): Remote {
  const { apps, log } = deps;
  let server: ServerType | undefined;
  let port: number | undefined;
  let host: string | undefined;
  let code: Code | undefined;
  let trouble: string | null = null;
  /** Codes taken whose app isn't written yet: the door stays open for them. */
  let pairing = 0;

  // Opening, closing and Serve's route change one at a time.
  let line: Promise<unknown> = Promise.resolve();
  const inTurn = <A>(step: () => Promise<A>): Promise<A> => {
    const run = line.then(step);
    line = run.catch(() => undefined);
    return run;
  };

  const dropCode = () => {
    if (code) clearTimeout(code.timer);
    code = undefined;
  };

  /** The live code `sent` is, used up at once; none when it isn't. */
  const take = (sent: string): Code | undefined => {
    const live = code;
    if (!live || Date.now() >= live.expiresAt.getTime()) return undefined;
    if (!timingSafeEqual(hashOf(sent), live.hash)) return undefined;
    dropCode();
    pairing += 1;
    return live;
  };

  /** The app whose key the request carries; 401 when none is paired. */
  const keyHolder = async (c: Context): Promise<KeyHolder> => {
    const key = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const found = key === undefined ? undefined : await apps.byKey(key);
    if (!found) {
      log("remote.refused", { reason: "key" });
      throw new HttpError(
        401,
        "This app isn't paired with Rufi any more. Pair it again.",
        { problem: "unpaired" },
      );
    }
    await apps.seen(found);
    return found;
  };

  /** The Mac's name for the app: the first part of its tailnet name. */
  const mac = () => (host ?? "").split(".")[0] ?? "";

  const door: App = new Hono();
  shared(door, {
    log,
    // Only by the Mac's tailnet name, as Serve passes it on; a page may
    // call only from the door's own origin.
    guard: async (c, next) => {
      if (host === undefined || c.req.header("host") !== host) {
        log("remote.refused", { reason: "host" });
        throw new HttpError(403, "Rufi answers only at its own address.");
      }
      const origin = c.req.header("origin");
      if (origin !== undefined && origin !== `https://${host}`) {
        log("remote.refused", { reason: "origin" });
        throw new HttpError(403, "That request didn't come from Rufi.");
      }
      await next();
    },
  });

  door.post("/api/pair", async (c) => {
    const { code: sent, name } = await body(c, PairRequest);
    const live = take(sent);
    if (!live) {
      log("remote.refused", { reason: "code" });
      throw new HttpError(
        410,
        "This code has expired. Make a new one in Rufi on your Mac.",
        { problem: "code_expired" },
      );
    }
    const added = await apps.add(live.person.id, name).finally(() => {
      pairing -= 1;
      // The code is used up: with no app paired after all, the door closes.
      void inTurn(() => settle());
    });
    log("remote.paired");
    return c.json({ ...added, mac: mac() } satisfies Paired);
  });

  door.get("/api/me", async (c) => {
    const app = await keyHolder(c);
    return c.json({
      person: app.person,
      mac: mac(),
      folder: (await apps.folder()) ?? "",
      place: "phone",
      api: REMOTE_API,
    });
  });

  // The app unpairs itself; the door closes after this answer if it was the last.
  door.post("/api/unpair", async (c) => {
    const app = await keyHolder(c);
    if (await apps.revoke(app.id)) log("remote.unpaired");
    void inTurn(() => settle());
    return c.json({});
  });

  /** Listens on `at` (0: a free port, then kept); the port it got. */
  const open = async (at: number): Promise<number> => {
    if (server && port !== undefined) return port;
    const started = await new Promise<ServerType>((resolve, reject) => {
      const listening = serve(
        { fetch: door.fetch, hostname: "127.0.0.1", port: at },
        () => {
          resolve(listening);
        },
      );
      listening.once("error", reject);
    }).catch((error: unknown) => {
      log("remote.failed", { error: errorCode(error) });
      throw new HttpError(
        409,
        (error as { code?: unknown }).code === "EADDRINUSE"
          ? `Rufi can't open its iPhone port (${String(at)}): another app is using it. Quit that app and restart Rufi.`
          : "Rufi couldn't open its iPhone port. Restart Rufi and try again.",
      );
    });
    server = started;
    port = (started.address() as AddressInfo).port;
    trouble = null;
    if (at === 0) await deps.saveSetting(PORT_SETTING, String(port));
    return port;
  };

  /** Stops listening; open answers finish first. */
  const shut = async (cut = false) => {
    const listening = server;
    server = undefined;
    port = undefined;
    if (!listening) return;
    await new Promise<void>((resolve) => {
      listening.close(() => {
        resolve();
      });
      if (cut && "closeAllConnections" in listening) {
        listening.closeAllConnections();
      } else if ("closeIdleConnections" in listening) {
        listening.closeIdleConnections();
      }
    });
  };

  /** Whether nothing needs the door: no app paired, no code live or being used. */
  const unneeded = async () =>
    !code && pairing === 0 && (await apps.list()).length === 0;

  /** Removes Rufi's own Serve route, when it set one; no other. */
  const unserve = async () => {
    const served = Number(await deps.setting(SERVED_SETTING));
    if (!Number.isInteger(served) || served <= 0) return;
    try {
      await deps.tailscale.off(served);
      await deps.saveSetting(SERVED_SETTING, null);
    } catch (error) {
      log("remote.failed", { error: errorCode(error) });
    }
  };

  /**
   * With no app paired and no code live, the door closes and its Serve
   * route goes; `cut` ends its open answers too (unpaired on the Mac).
   */
  const settle = async (cut = false) => {
    if (!(await unneeded())) return;
    await shut(cut);
    await unserve();
  };

  const savedPort = async () => {
    const saved = Number(await deps.setting(PORT_SETTING));
    return Number.isInteger(saved) && saved > 0 ? saved : 0;
  };

  return {
    start: () =>
      inTurn(async () => {
        // Nothing paired: a route left by a Rufi that stopped mid-pairing goes.
        if ((await apps.list()).length === 0) {
          await unserve();
          return;
        }
        host = await deps.setting(HOST_SETTING);
        await open(await savedPort()).catch((error: unknown) => {
          // Rufi runs on; Settings › iPhone says what to do.
          trouble = (error as Error).message;
        });
      }),

    state: async () => ({
      apps: await apps.list(),
      pairing: code
        ? {
            link: code.link,
            person: code.person,
            expiresAt: code.expiresAt.toISOString(),
          }
        : null,
      trouble,
    }),

    pair: (personId) =>
      inTurn(async () => {
        dropCode();
        const person = (await deps.people()).find(({ id }) => id === personId);
        if (!person) {
          throw new HttpError(404, "That person isn't in this record.");
        }
        try {
          const name = await deps.tailscale.name();
          const at = await open(await savedPort());
          host = `${name}:${String(at)}`;
          await deps.saveSetting(HOST_SETTING, host);
          await deps.tailscale.serve(at);
          await deps.saveSetting(SERVED_SETTING, String(at));
          await deps.tailscale.check(`https://${host}`, async (response) => {
            const answer = (await response.json()) as { problem?: unknown };
            return response.status === 410 && answer.problem === "code_expired";
          });
        } catch (error) {
          await settle(true);
          if (error instanceof TailscaleProblem) {
            throw new HttpError(409, error.message);
          }
          throw error;
        }
        const sent = randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + CODE_MS);
        const made: Code = {
          hash: hashOf(sent),
          person: { id: person.id, name: person.displayName },
          expiresAt,
          link: `https://${host}/pair#code=${sent}`,
          timer: setTimeout(() => {
            if (code === made) {
              code = undefined;
              void inTurn(() => settle());
            }
          }, CODE_MS),
        };
        made.timer.unref();
        code = made;
        return {
          link: made.link,
          person: made.person,
          expiresAt: expiresAt.toISOString(),
        };
      }),

    cancel: () =>
      inTurn(async () => {
        dropCode();
        await settle(true);
      }),

    unpair: async (appId) => {
      const revoked = await apps.revoke(appId);
      if (revoked) log("remote.unpaired");
      await inTurn(() => settle(true));
      return revoked;
    },

    // Quitting: with an app paired, Serve's route stays for the next start;
    // with none, it goes.
    close: () =>
      inTurn(async () => {
        dropCode();
        // A record already closed (Rufi lost its lock) can't say: the next
        // start removes the route then.
        await (async () => {
          if (await unneeded()) await unserve();
        })().catch(() => undefined);
        await shut(true);
      }),
  };
}
