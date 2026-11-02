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
export const PhoneMe = Schema.Struct({
  person: Person,
  mac: Schema.String,
  folder: Schema.String,
  place: Schema.Literal("phone"),
  api: Schema.Number,
});
export type PhoneMe = typeof PhoneMe.Type;

/**
 * `GET /api/me`: where the screens run. On the Mac they show every person
 * and Rufi's own pages; on the phone, only the paired person's.
 */
export const Me = Schema.Union([
  Schema.Struct({ place: Schema.Literal("mac") }),
  PhoneMe,
]);
export type Me = typeof Me.Type;

/**
 * `POST /api/open` on the door, with the app's key: a launch link that
 * opens Rufi's screens at `path`, once, within 60 seconds.
 */
export const OpenRequest = Schema.Struct({
  path: Schema.String.check(
    Schema.isPattern(/^\/(?!\/)[^\s#]*$/),
    Schema.isMaxLength(2000),
  ),
});
export type OpenRequest = typeof OpenRequest.Type;

export const Opened = Schema.Struct({ url: Schema.String });
export type Opened = typeof Opened.Type;

/**
 * `POST /api/batches` on the door, with the app's key: a batch of Apple
 * Health values, stored as it came in the app's own device source. A
 * refusal (422, or 413 over 4 MB) says why; one that couldn't be stored
 * answers 503 `{ problem: "couldnt_store" }`.
 */
export type BatchAnswer =
  | { answer: "got_it" | "already_got" }
  | { answer: "refused"; problems: readonly string[]; error: string };
