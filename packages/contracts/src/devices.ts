// What Settings → Device data gets from Rufi's local API: each device
// source with its state, how long values are kept, and what a shorter time
// would delete (docs/adr/0023).
import { Schema } from "effect";

/** How long device values are kept, for everyone in the data folder. */
export const KeepValues = Schema.Literals(["30d", "12m", "forever"]);
export type KeepValues = typeof KeepValues.Type;

export const DeviceSource = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  system: Schema.Literal("apple_health"),
  person: Schema.Struct({ id: Schema.String, name: Schema.String }),
  /** Values kept from it, not counting removed ones. */
  values: Schema.Number,
  lastBatchAt: Schema.NullOr(Schema.String),
  /** Its batches received and not converted yet. */
  waiting: Schema.Number,
  /** Items it sent that Rufi couldn't read, in the batches still kept. */
  skipped: Schema.Number,
  /** Its batch that failed, holding back its person's batches of this system. */
  failed: Schema.NullOr(
    Schema.Struct({
      /** disk_full, io_error, or error:<code>. */
      reason: Schema.String,
      tries: Schema.Number,
      retryAt: Schema.NullOr(Schema.String),
    }),
  ),
  /** The source whose failed batch this one's batches wait behind. */
  waitsBehind: Schema.NullOr(Schema.String),
});
export type DeviceSource = typeof DeviceSource.Type;

export const DeviceData = Schema.Struct({
  sources: Schema.Array(DeviceSource),
  /** Why the converter couldn't even save a failure (a full disk), while that lasts. */
  trouble: Schema.NullOr(Schema.String),
});
export type DeviceData = typeof DeviceData.Type;

/** What keeping values for a shorter time would delete now. */
export const KeepPreview = Schema.Struct({
  values: Schema.Number,
  /** Values measured before this instant go; null for forever. */
  before: Schema.NullOr(Schema.String),
});
export type KeepPreview = typeof KeepPreview.Type;
