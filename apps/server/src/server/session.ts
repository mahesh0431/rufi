// The browser session (PLAN.md §3.3): every API call needs two proofs. A
// cookie alone isn't enough, because cookies aren't kept apart by port.
//   1. Opening Rufi gives a single-use launch token in the URL.
//   2. The page swaps it for an HttpOnly, SameSite=Strict cookie (one per
//      browser) and a proof for this tab, which the page sends as a header.
import { createHash, randomBytes } from "node:crypto";

/** A launch link works once, and only for this long. */
const LAUNCH_MS = 5 * 60_000;

const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

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
