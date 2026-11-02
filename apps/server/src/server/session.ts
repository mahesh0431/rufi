// The browser session (PLAN.md §3.3): every API call needs two proofs. A
// cookie alone isn't enough, because cookies aren't kept apart by port.
//   1. Opening Rufi gives a single-use launch token in the link's fragment.
//   2. The page swaps it for an HttpOnly, SameSite=Strict cookie (one per
//      browser) and a proof for this tab, which the page sends as a header.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A launch link works once, and only for this long. */
const LAUNCH_MS = 5 * 60_000;

const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

/** A new random secret. */
export const secret = token;

/** Whether `given` is `expected`, in constant time. */
export function sameSecret(given: string | undefined, expected: string) {
  if (given === undefined) return false;
  const a = Buffer.from(hash(given));
  const b = Buffer.from(hash(expected));
  return timingSafeEqual(a, b);
}

export type Sessions = ReturnType<typeof sessions>;

export function sessions(now: () => number = Date.now) {
  const launches = new Map<string, number>(); // hash -> expires at
  const proofs = new Map<string, Set<string>>(); // session hash -> tab proof hashes

  return {
    /** A fresh single-use launch token. */
    launch: (): string => {
      const value = token();
      launches.set(hash(value), now() + LAUNCH_MS);
      return value;
    },

    /**
     * Swaps a launch token for a tab proof, in the browser's session (kept
     * when the cookie is still valid, else a new one). Undefined when the
     * token is unknown, used or expired.
     */
    exchange: (
      launch: string,
      session: string | undefined,
    ): { session: string; proof: string } | undefined => {
      const key = hash(launch);
      const expires = launches.get(key);
      launches.delete(key); // single use, even when expired
      if (expires === undefined || expires < now()) return undefined;
      const current =
        session !== undefined && proofs.has(hash(session)) ? session : token();
      const tabs = proofs.get(hash(current)) ?? new Set();
      const proof = token();
      tabs.add(hash(proof));
      proofs.set(hash(current), tabs);
      return { session: current, proof };
    },

    /** Both proofs, and they belong together. */
    verify: (session: string | undefined, proof: string | undefined): boolean =>
      session !== undefined &&
      proof !== undefined &&
      (proofs.get(hash(session))?.has(hash(proof)) ?? false),
  };
}

/** A paired app's launch link works once, and only for this long. */
const APP_LAUNCH_MS = 60_000;

/**
 * The remote door's sessions (docs/adr/0032): the same two proofs, each
 * launch and session owned by one paired app. Each launch makes a new
 * session; one session per app, so a new one ends the app's old one. A
 * cookie the browser sends is never reused.
 */
export function appSessions(now: () => number = Date.now) {
  const launches = new Map<string, { app: string; expires: number }>();
  // session hash -> its app and its tab proof's hash
  const live = new Map<string, { app: string; proof: string }>();
  const current = new Map<string, string>(); // app -> its session's hash

  /** Ends the app's session; the hash it had, for what it has open. */
  const endSession = (app: string): string | undefined => {
    const ended = current.get(app);
    if (ended !== undefined) live.delete(ended);
    current.delete(app);
    return ended;
  };

  return {
    /** A fresh single-use launch token for `app`. */
    launch: (app: string): string => {
      const value = token();
      launches.set(hash(value), { app, expires: now() + APP_LAUNCH_MS });
      return value;
    },

    /** The app a launch token is for, used up at once; none when unknown, used or expired. */
    take: (launch: string): string | undefined => {
      const key = hash(launch);
      const found = launches.get(key);
      launches.delete(key); // single use, even when expired
      return found && found.expires >= now() ? found.app : undefined;
    },

    /**
     * A new session for `app`, with its tab proof; `ended` is the old
     * session's hash, whose open requests end.
     */
    start: (app: string) => {
      const ended = endSession(app);
      const session = token();
      const proof = token();
      live.set(hash(session), { app, proof: hash(proof) });
      current.set(app, hash(session));
      return { session, proof, ended };
    },

    /** The app and session both proofs belong to; none when they don't. */
    verify: (
      session: string | undefined,
      proof: string | undefined,
    ): { app: string; session: string } | undefined => {
      if (session === undefined || proof === undefined) return undefined;
      const found = live.get(hash(session));
      return found?.proof === hash(proof)
        ? { app: found.app, session: hash(session) }
        : undefined;
    },

    /** Ends the app's launches and session: it was unpaired. */
    end: (app: string): void => {
      for (const [key, launch] of launches) {
        if (launch.app === app) launches.delete(key);
      }
      endSession(app);
    },
  };
}
