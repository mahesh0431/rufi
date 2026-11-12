// How paired apps reach the remote door (docs/adr/0032, 0035): a route gives the
// door its https address and passes requests on to it on 127.0.0.1. One is
// in use at a time, kept in the record's settings as `remote.route`. Each
// route sets up and takes down only what it set itself. Whether the address
// reaches the door is the door's own check, the same for every route.

import { RouteKind } from "@rufi/contracts/remote";
import { Schema } from "effect";

/** Why a route's step failed, as the one line Settings shows. */
export class RouteProblem extends Error {}

export interface RemoteRoute {
  /** Its name in Rufi's lines, such as "Tailscale". */
  label: string;
  /**
   * Pairing: makes the route pass its address to the door on `port`, and
   * gives the Host the door answers to there. The same Host every time
   * while anything uses the door, so a phone paired before keeps working;
   * `alone`: no app is paired, so the address may change.
   */
  up: (port: number, alone: boolean) => Promise<string>;
  /** Rufi's start with an app paired: brings back what doesn't outlive Rufi. */
  resume: (port: number) => Promise<void>;
  /** Nothing needs the door on `port`: removes only what `up` set. */
  down: (port: number) => Promise<void>;
  /** Rufi quits with an app paired: ends only what can't outlive it. */
  close: () => Promise<void>;
}

export type Routes = Readonly<Record<RouteKind, RemoteRoute>>;

/** The setting that names the route in use. */
export const ROUTE_SETTING = "remote.route";

/** The route `saved` names; Tailscale when none is saved. */
export const routeKind = (saved: string | undefined): RouteKind =>
  Schema.is(RouteKind)(saved) ? saved : "tailscale";
