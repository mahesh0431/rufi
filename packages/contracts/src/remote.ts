// Paired apps (docs/adr/0032): what Settings › iPhone gets from Rufi's local
// API, and what the remote door answers a paired app, such as Rufi on an
// iPhone.
import { Schema } from "effect";

const Person = Schema.Struct({ id: Schema.String, name: Schema.String });

/** An app paired with this Rufi, for one person. */
export const PairedApp = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("iphone"),
  /** As the app gave it: "Asha's iPhone". */
  name: Schema.String,
  person: Person,
  pairedAt: Schema.String,
  lastSeenAt: Schema.NullOr(Schema.String),
});
export type PairedApp = typeof PairedApp.Type;

/** The live pairing code, as a link for the app to scan or paste. */
export const Pairing = Schema.Struct({
  /** https://<mac>.<tailnet>.ts.net:<door port>/pair#code=<code> */
  link: Schema.String,
  person: Person,
  expiresAt: Schema.String,
});
export type Pairing = typeof Pairing.Type;

/** Settings › iPhone: the apps paired and not revoked, and the live code. */
export const PairedApps = Schema.Struct({
  apps: Schema.Array(PairedApp),
  pairing: Schema.NullOr(Pairing),
  /** Why the door can't open now, as one line, while that lasts. */
  trouble: Schema.NullOr(Schema.String),
});
export type PairedApps = typeof PairedApps.Type;

/** Pair an iPhone: for whose record. */
export const StartPairing = Schema.Struct({ personId: Schema.String });
export type StartPairing = typeof StartPairing.Type;

/** What an app sends the door with the code it scanned or was pasted. */
export const PairRequest = Schema.Struct({
  code: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export type PairRequest = typeof PairRequest.Type;

/**
 * The door's answer to a pairing: the key, shown this once, and what the
 * app keeps beside it. `folder` is the data folder's id: a later pairing to
 * the same folder has the same.
 */
export const Paired = Schema.Struct({
  key: Schema.String,
  app: Schema.Struct({ id: Schema.String }),
  person: Person,
  mac: Schema.String,
  folder: Schema.String,
});
export type Paired = typeof Paired.Type;

/**
 * The version of the routes the iPhone app itself calls; raised only when
 * one of them changes shape.
 */
export const REMOTE_API = 1;

/** `GET /api/me` on the door: who the key or session acts as. */
export const Me = Schema.Struct({
  person: Person,
  mac: Schema.String,
  folder: Schema.String,
  place: Schema.Literal("phone"),
  api: Schema.Number,
});
export type Me = typeof Me.Type;
