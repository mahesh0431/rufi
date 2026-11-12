// Said once under a public route in Settings › iPhone: what it means that
// anyone can reach the door there. Mahesh's words, not written yet:
// `public-line.test.ts` fails until they are, so a route doesn't ship
// without its line.
import type { RouteKind } from "@rufi/contracts/remote";

export const PUBLIC_LINE: Readonly<
  Record<Exclude<RouteKind, "tailscale">, string>
> = {
  funnel: "",
  cloudflare: "",
};
