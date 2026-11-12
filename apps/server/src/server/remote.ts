// The remote door (docs/adr/0032): a second listener, on 127.0.0.1 at a port
// of its own, that paired apps reach through its route (remote-route.ts),
// Tailscale Serve unless another is chosen. It has the shared protections of
// every listener (http.ts) with its own checks: the route's address as Host,
// and who is asking. Each route is in one
// class: public (the screens' files), a pairing code, a launch token, the
// app's key, or the key or the app's session; everything else is 404, and
// so is another person's route. A paired app's Apple Health batches come in
// by its key only, into its own device source under its person. It runs while an app is paired or a
// pairing code is live. A pairing code lives in memory only: single use,
// 10 minutes, one at a time.
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { serve, type HttpBindings, type ServerType } from "@hono/node-server";
import type { Status } from "@rufi/contracts";
import {
  OpenRequest,
  PairRequest,
  REMOTE_API,
  type BatchAnswer,
  type Opened,
  type Paired,
  type PairedApps as Listed,
  type Pairing,
  type PhoneMe,
  type RouteKind,
} from "@rufi/contracts/remote";
import { Hono, type Context, type Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { failureReason, type Receipt } from "../core/devices/devices.ts";
import type { KeyHolder, PairedApps } from "../core/paired/paired-apps.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import { PROOF_HEADER, screensRoute, type SettingsReads } from "./api.ts";
import { body, HttpError, shared, type App } from "./http.ts";
import type { Cloudflare } from "./cloudflare.ts";
import { personRoutes, type PersonDeps } from "./person-routes.ts";
import {
  ROUTE_SETTING,
  RouteProblem,
  routeKind,
  type RemoteRoute,
  type Routes,
} from "./remote-route.ts";
import { appSessions } from "./session.ts";
import { visualCardRoute, visualFrameRoute } from "./visual-frame.ts";

/** How long a pairing code works. */
const CODE_MS = 10 * 60 * 1000;
/**
 * How long the check through the route may take: the first HTTPS request on
 * a name gets its certificate, and a tunnel takes a moment to connect.
 */
const CHECK_MS = 30_000;
/** How soon the check asks again while what answers isn't Rufi. */
const RECHECK_MS = 2_000;

/** The door's address and port, kept at a pairing, so the route and the apps' links stay. */
const HOST_SETTING = "remote.host";
const PORT_SETTING = "remote.port";

const hashOf = (text: string) => createHash("sha256").update(text).digest();

export interface RemoteDeps {
  apps: PairedApps;
  /** The people in the record, for whose record a code opens. */
  people: () => Promise<readonly { id: string; displayName: string }[]>;
  setting: (key: string) => Promise<string | undefined>;
  /** Saves a setting; null removes it. */
  saveSetting: (key: string, value: string | null) => Promise<void>;
  /** The routes the door can be reached by; `remote.route` names the one in use. */
  routes: Routes;
  /** Cloudflare's setup on this Mac, for its route. */
  cloudflare: Pick<Cloudflare, "state" | "setup">;
  /** Asks a URL, as `fetch` does: the check that the route reaches the door. */
  reach?: Reach;
  /** This Mac's own name, as the paired apps show it. */
  macName: () => Promise<string>;
  /**
   * Keeps each answer in the core's work: Rufi finishes it before closing
   * the record and letting the data folder go, as the screens' answers.
   */
  working: (answer: Promise<Response>) => Promise<Response>;
  /** A person's routes, as the screens have them. */
  person: PersonDeps;
  /**
   * Stores a batch from `app` as it came, in the app's own device source
   * under its person, and has it converted soon.
   */
  receive: (app: KeyHolder, bytes: Uint8Array) => Promise<Receipt>;
  /** Rufi's settings, as the screens read them. */
  read: SettingsReads;
  /** The sign-ins, as the screens read them. */
  account: () => Promise<Status>;
  /** The built screens' folder; none in tests that only use the API. */
  screens?: string;
  log: Log;
}

export interface Remote {
  /** At Rufi's start: opens the door when an app is paired. */
  start: () => Promise<void>;
  /** What Settings › iPhone shows. */
  state: () => Promise<Listed>;
  /**
   * The route's steps and the check through it, then a new code for
   * `personId`'s record; any older code goes. Refused with one line on what
   * to do when a step fails.
   */
  pair: (personId: string) => Promise<Pairing>;
  /** The live code goes. */
  cancel: () => Promise<void>;
  /** Revokes the app; false when it isn't paired. */
  unpair: (appId: string) => Promise<boolean>;
  /**
   * Uses `kind` from now, after taking down what the old route set. Refused
   * while an app is paired or a code is live or being used: their address
   * would change under them; and when the old route can't be taken down,
   * keeping it chosen.
   */
  choose: (kind: RouteKind) => Promise<void>;
  /**
   * Sets up Cloudflare Tunnel at `address` with the person's `token`.
   * Refused as `choose` is; pairing and choosing wait for it.
   */
  setUpCloudflare: (address: string, token: string) => Promise<void>;
  /** Closes the door, its connections too; a route that outlives Rufi stays. */
  close: () => Promise<void>;
}

/**
 * This Mac's own name, as System Settings › General › Sharing shows it;
 * its network name when macOS doesn't say.
 */
export async function computerName(): Promise<string> {
  const named = await promisify(execFile)(
    "/usr/sbin/scutil",
    ["--get", "ComputerName"],
    { timeout: 5_000 },
  ).then(
    ({ stdout }) => stdout.trim(),
    // Not macOS, or no name set: the network name.
    () => "",
  );
  return named !== "" ? named : hostname().replace(/\.local$/, "");
}

/** Asks `url` as `fetch` does. */
export type Reach = (url: string, init: RequestInit) => Promise<Response>;

/** A request on the door. */
type DoorContext = Context<{ Bindings: HttpBindings }>;

/** Who is asking: the app, and its session when not by its key. */
interface Asker {
  app: KeyHolder;
  session: string | undefined;
}

/** A request being answered, to end at once when its app or session ends. */
interface Answering {
  app: string;
  session: string | undefined;
  socket: Socket;
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
  /** Cloudflare's setup is running: pairing and choosing are refused. */
  let settingUp = false;
  const sessions = appSessions();
  const askers = new WeakMap<Request, Asker>();
  const answering = new Set<Answering>();
  /** Apps unpaired while Rufi runs: a request let in just before still ends. */
  const unpairedApps = new Set<string>();
  /** The cookie of the door's sessions, named for its port. */
  const cookie = () => `rufi_${String(port ?? 0)}`;
  const doorOrigin = () => `https://${host ?? ""}`;

  /**
   * Ends at once what `app` (or only its `session`) has open, its streams
   * too, but not `except`: the request asking.
   */
  const cut = (
    app: string,
    { session, except }: { session?: string; except?: Socket } = {},
  ) => {
    for (const open of answering) {
      if (open.app !== app || open.socket === except) continue;
      if (session !== undefined && open.session !== session) continue;
      answering.delete(open);
      open.socket.destroy();
    }
  };

  /** Ends the app's launches, its session and what it has open: unpaired. */
  const ended = (app: string, except?: Socket) => {
    unpairedApps.add(app);
    sessions.end(app);
    cut(app, except ? { except } : {});
  };

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

  const unpaired = () =>
    new HttpError(
      401,
      "This app isn't paired with Rufi any more. Pair it again.",
      { problem: "unpaired" },
    );

  /** Who is asking, as the door's middleware found them. */
  const asker = (c: Context): Asker => {
    const found = askers.get(c.req.raw);
    if (!found) throw unpaired();
    return found;
  };

  /** Only by the app's key: a session can't. */
  const byKey = (c: Context): KeyHolder => {
    const found = asker(c);
    if (found.session !== undefined) throw new HttpError(404, "Not found.");
    return found.app;
  };

  /** The Mac's name for the app, read once. */
  let macName: Promise<string> | undefined;
  const mac = () => (macName ??= deps.macName());

  const door: App = new Hono();
  const { adds } = shared(door, {
    log,
    // Only by the route's address, as the route passes it on; a page may
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
    return c.json({ ...added, mac: await mac() } satisfies Paired);
  });

  // The app's web view swaps a launch token for a new session of that app.
  door.post("/api/session", async (c) => {
    if (c.req.header("origin") !== doorOrigin()) {
      log("remote.refused", { reason: "origin" });
      throw new HttpError(403, "That request didn't come from Rufi.");
    }
    const { launch } = (await c.req.json().catch(() => ({}))) as {
      launch?: unknown;
    };
    const appId =
      typeof launch === "string" ? sessions.take(launch) : undefined;
    const app = appId === undefined ? undefined : await apps.byId(appId);
    if (!app) {
      throw new HttpError(
        401,
        "This Rufi link has expired or was already used. Open Rufi again.",
      );
    }
    const started = sessions.start(app.id);
    if (started.ended !== undefined) cut(app.id, { session: started.ended });
    setCookie(c, cookie(), started.session, {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
    });
    return c.json({ proof: started.proof });
  });

  // Every other API route: the app's key, or the cookie and tab proof of
  // its session, read fresh on each request. A session's change needs the
  // door's own page as Origin.
  door.use("/api/*", async (c: DoorContext, next: Next) => {
    const key = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    let found: Asker | undefined;
    if (key !== undefined) {
      const app = await apps.byKey(key);
      found = app && { app, session: undefined };
    } else {
      const session = sessions.verify(
        getCookie(c, cookie()),
        c.req.header(PROOF_HEADER),
      );
      if (
        session &&
        c.req.method !== "GET" &&
        c.req.method !== "HEAD" &&
        c.req.header("origin") !== doorOrigin()
      ) {
        log("remote.refused", { reason: "origin" });
        throw new HttpError(403, "That request didn't come from Rufi.");
      }
      const app = session && (await apps.byId(session.app));
      found = app && { app, session: session.session };
    }
    if (!found) {
      log("remote.refused", { reason: "key" });
      throw unpaired();
    }
    await apps.seen(found.app);
    askers.set(c.req.raw, found);
    const open: Answering = {
      app: found.app.id,
      session: found.session,
      socket: c.env.incoming.socket,
    };
    answering.add(open);
    c.env.outgoing.once("close", () => {
      answering.delete(open);
    });
    // Unpaired, or its session replaced, while this request was being let
    // in: it ends now, as those already open did.
    const still =
      found.session === undefined
        ? !unpairedApps.has(found.app.id)
        : sessions.verify(getCookie(c, cookie()), c.req.header(PROOF_HEADER))
            ?.session === found.session;
    if (!still) {
      answering.delete(open);
      throw unpaired();
    }
    await next();
  });

  // Only the app's own person: another's is not there.
  door.use("/api/people/:personId/*", async (c: DoorContext, next: Next) => {
    if (c.req.param("personId") !== asker(c).app.person.id) {
      throw new HttpError(404, "Not found.");
    }
    await next();
  });

  door.get("/api/me", async (c) => {
    const { app } = asker(c);
    return c.json({
      person: app.person,
      mac: await mac(),
      folder: (await apps.folder()) ?? "",
      place: "phone",
      api: REMOTE_API,
    } satisfies PhoneMe);
  });
  door.get("/api/settings", async (c) => c.json(await deps.read.settings(c)));
  door.get("/api/status", async (c) => c.json(await deps.account()));

  // The app's web view opens Rufi's screens with a launch link, never its key.
  door.post("/api/open", async (c) => {
    const app = byKey(c);
    const { path } = await body(c, OpenRequest);
    log("remote.opened");
    return c.json({
      url: `${doorOrigin()}${path}#launch=${sessions.launch(app.id)}`,
    } satisfies Opened);
  });

  // The app unpairs itself: what else it has open ends now, this answer
  // goes, and the door closes after it if it was the last.
  door.post("/api/unpair", async (c) => {
    const app = byKey(c);
    if (await apps.revoke(app.id)) log("remote.unpaired");
    ended(app.id, c.env.incoming.socket);
    void inTurn(() => settle());
    return c.json({});
  });

  // Apple Health batches, by the app's key: the person is the app's, never
  // the batch's (ADR 0023).
  door.post("/api/batches", async (c) => {
    const app = byKey(c);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    let receipt: Receipt;
    try {
      receipt = await deps.receive(app, bytes);
    } catch (error) {
      const reason = failureReason(error);
      log("remote.batch", { answer: "couldnt_store", reason });
      return c.json(
        {
          problem: "couldnt_store",
          reason,
          error:
            "Rufi on your Mac couldn't store this. Look at Settings › Data › Device data on your Mac.",
        },
        503,
      );
    }
    log("remote.batch", { answer: receipt.answer, count: bytes.byteLength });
    if (receipt.answer === "refused") {
      return c.json(
        {
          answer: "refused",
          problems: receipt.problems,
          error: `Rufi on your Mac refused a batch (${receipt.problems.join(", ")}). Update Rufi on your iPhone (or on your Mac) so they match.`,
        } satisfies BatchAnswer,
        422,
      );
    }
    return c.json({ answer: receipt.answer } satisfies BatchAnswer);
  });

  // What a person does here is their paired app's.
  personRoutes(door, deps.person, adds, (c) => `app:${asker(c).app.id}`);
  visualFrameRoute(door);
  visualCardRoute(door);
  screensRoute(door, deps.screens, deps.read);

  /** Listens on `at` (0: a free port, then kept); the port it got. */
  const open = async (at: number): Promise<number> => {
    if (server && port !== undefined) return port;
    const started = await new Promise<ServerType>((resolve, reject) => {
      const listening = serve(
        {
          fetch: (request, env) =>
            deps.working(Promise.resolve(door.fetch(request, env))),
          hostname: "127.0.0.1",
          port: at,
        },
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

  /** Refused while Cloudflare's setup runs. */
  const notSettingUp = () => {
    if (settingUp) {
      throw new HttpError(409, "Wait for Cloudflare's setup to finish.");
    }
  };

  /** Whether nothing needs the door: no app paired, no code live or being used. */
  const unneeded = async () =>
    !code && pairing === 0 && (await apps.list()).length === 0;

  /** The route in use. */
  const route = async (): Promise<RemoteRoute> =>
    deps.routes[routeKind(await deps.setting(ROUTE_SETTING))];

  /** Takes down what the route set, and only that. */
  const unroute = async () => {
    try {
      await (await route()).down(await savedPort());
    } catch (error) {
      log("remote.failed", { error: errorCode(error) });
    }
  };

  /**
   * With no app paired and no code live, the door closes and its route
   * goes; `cut` ends its open answers too (unpaired on the Mac).
   */
  const settle = async (cut = false) => {
    if (!(await unneeded())) return;
    await shut(cut);
    await unroute();
  };

  /**
   * The door answers through the route at `origin`: proves the address, its
   * certificate, the route and the door together. Only Rufi's own answer to
   * a used-up code passes. While what answers isn't Rufi (no connection
   * yet, the route's own error page), it asks again until its deadline.
   */
  const reachSelf = async (origin: string, label: string) => {
    const reach: Reach = deps.reach ?? ((url, init) => fetch(url, init));
    const until = Date.now() + CHECK_MS;
    const fails = (why: string, cause?: unknown) =>
      new RouteProblem(
        `Rufi couldn't reach itself through ${label} (${why}). Try again in a minute.`,
        { cause },
      );
    for (;;) {
      let answer: {
        status: number;
        said: { error?: unknown; problem?: unknown };
      };
      try {
        const response = await reach(`${origin}/api/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "check", name: "check" }),
          redirect: "error",
          signal: AbortSignal.timeout(Math.max(until - Date.now(), 1)),
        });
        answer = {
          status: response.status,
          said: ((await response.json().catch(() => ({}))) ?? {}) as {
            error?: unknown;
          },
        };
      } catch (error) {
        if (Date.now() + RECHECK_MS >= until) {
          throw fails(
            (error as Error).name === "TimeoutError"
              ? "no answer in time"
              : "no answer",
            error,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, RECHECK_MS));
        continue;
      }
      if (answer.status === 410 && answer.said.problem === "code_expired") {
        return;
      }
      // Rufi's own words: it answered, and not as the check needs.
      if (
        typeof answer.said.error === "string" ||
        Date.now() + RECHECK_MS >= until
      ) {
        throw fails(`it answered ${String(answer.status)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, RECHECK_MS));
    }
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
          await unroute();
          return;
        }
        host = await deps.setting(HOST_SETTING);
        try {
          const at = await open(await savedPort());
          await (await route()).resume(at);
        } catch (error) {
          // Rufi runs on; Settings › iPhone says what to do.
          trouble = (error as Error).message;
        }
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
      trouble: trouble ?? (await route()).trouble?.() ?? null,
      route: {
        kind: routeKind(await deps.setting(ROUTE_SETTING)),
        cloudflare: await deps.cloudflare.state(),
      },
    }),

    pair: (personId) => {
      notSettingUp();
      return inTurn(async () => {
        dropCode();
        const person = (await deps.people()).find(({ id }) => id === personId);
        if (!person) {
          throw new HttpError(404, "That person isn't in this record.");
        }
        try {
          const using = await route();
          const alone = (await apps.list()).length === 0 && pairing === 0;
          const at = await open(await savedPort());
          host = await using.up(at, alone);
          await deps.saveSetting(HOST_SETTING, host);
          await reachSelf(`https://${host}`, using.label);
        } catch (error) {
          await settle(true);
          if (error instanceof RouteProblem) {
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
      });
    },

    cancel: () =>
      inTurn(async () => {
        dropCode();
        await settle(true);
      }),

    unpair: async (appId) => {
      const revoked = await apps.revoke(appId);
      if (revoked) log("remote.unpaired");
      ended(appId);
      await inTurn(() => settle(true));
      return revoked;
    },

    choose: (kind) => {
      notSettingUp();
      return inTurn(async () => {
        if (!(await unneeded())) {
          throw new HttpError(409, "Unpair your iPhones first.");
        }
        const using = await route();
        if (using === deps.routes[kind]) return;
        // The old route goes first: saved only once it has, so a public
        // route never stays open under a choice that says otherwise.
        try {
          await using.down(await savedPort());
        } catch (error) {
          log("remote.failed", { error: errorCode(error) });
          throw new HttpError(
            409,
            error instanceof RouteProblem
              ? error.message
              : `Rufi couldn't turn off ${using.label}. Try again.`,
          );
        }
        await deps.saveSetting(ROUTE_SETTING, kind);
      });
    },

    setUpCloudflare: async (address, token) => {
      notSettingUp();
      settingUp = true;
      try {
        await inTurn(async () => {
          if (!(await unneeded())) {
            throw new HttpError(409, "Unpair your iPhones first.");
          }
          try {
            await deps.cloudflare.setup(address, token);
          } catch (error) {
            if (error instanceof RouteProblem) {
              throw new HttpError(409, error.message);
            }
            throw error;
          }
        });
      } finally {
        settingUp = false;
      }
    },

    // Quitting: with an app paired, a route that outlives Rufi stays for
    // the next start, and the rest ends; with none, it goes.
    close: () =>
      inTurn(async () => {
        dropCode();
        // A record already closed (Rufi lost its lock) can't say: the next
        // start removes the route then.
        await (async () => {
          if (await unneeded()) await unroute();
        })().catch(() => undefined);
        // What can't outlive Rufi ends, whichever route was in use.
        for (const each of Object.values(deps.routes)) {
          await each.close().catch((error: unknown) => {
            log("remote.failed", { error: errorCode(error) });
          });
        }
        await shut(true);
      }),
  };
}
