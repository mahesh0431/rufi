// Said once under a public route in Settings › iPhone: what it means that
// anyone can reach the door there, in Mahesh's words. Each public route in
// Settings takes its line from here, so one can't show without it, and
// `public-line.test.ts` checks that none is empty.
import type { RouteKind } from "@rufi/contracts/remote";

export const PUBLIC_LINE = {
  funnel:
    "Public: anyone with the address can reach this Mac. Only a paired iPhone can open your data.",
  cloudflare: "",
} as const satisfies Partial<Record<Exclude<RouteKind, "tailscale">, string>>;
