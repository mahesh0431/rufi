// What the record's screens get from Rufi's local API: Overview, a page per
// kind, a row with its sources and history, and a test's series. Rows carry
// their fields by the names save_changes uses, as stored.
import { Schema } from "effect";

/** A date at the precision known: YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DDTHH:MM. */
export const RecordDate = Schema.String.check(
  Schema.isPattern(/^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2})?)?)?$/),
);

/** A date with the words it was said or printed in. */
const Dated = Schema.Struct({
  date: RecordDate,
  words: Schema.optionalKey(Schema.String),
});

const Text = Schema.optionalKey(Schema.String);
const When = Schema.optionalKey(Dated);
const Id = Schema.String;

export const ResultRow = Schema.Struct({
  kind: Schema.Literal("result"),
  id: Id,
  test: Schema.String,
  value: Schema.String,
  comparator: Text,
  number: Schema.optionalKey(Schema.Number),
  second_number: Schema.optionalKey(Schema.Number),
  unit: Text,
  range: Text,
  flag: Text,
  context: Text,
  measured: When,
  /** The result this amended one replaces. */
  replaces: Text,
});
export type ResultRow = typeof ResultRow.Type;

export const MedicineUseRow = Schema.Struct({
  kind: Schema.Literal("medicine_use"),
  id: Id,
  name: Schema.String,
  strength: Text,
  amount: Text,
  schedule: Text,
  route: Text,
  purpose: Text,
  status: Schema.Literals([
    "current",
    "paused",
    "stopped",
    "completed",
    "unknown",
  ]),
  started: When,
  ended: When,
});

export const PrescriptionRow = Schema.Struct({
  kind: Schema.Literal("prescription"),
  id: Id,
  item: Schema.String,
  strength: Text,
  amount: Text,
  route: Text,
  schedule: Text,
  period: Text,
  prescriber: Text,
  issued: When,
});

export const SymptomRow = Schema.Struct({
  kind: Schema.Literal("symptom"),
  id: Id,
  name: Schema.String,
  status: Schema.Literals(["ongoing", "resolved", "unknown"]),
  onset: When,
  ended: When,
  severity: Text,
  location: Text,
  intermittent: Schema.optionalKey(Schema.Boolean),
  details: Text,
});

export const ConditionRow = Schema.Struct({
  kind: Schema.Literal("condition"),
  id: Id,
  name: Schema.String,
  certainty: Schema.Literals(["suspected", "diagnosed", "unknown"]),
  status: Schema.Literals(["ongoing", "resolved", "unknown"]),
  recognised: When,
  resolved: When,
  details: Text,
});

export const AllergyRow = Schema.Struct({
  kind: Schema.Literal("allergy"),
  id: Id,
  substance: Schema.String,
  reaction: Text,
  status: Schema.Literals(["active", "inactive", "unknown"]),
  certainty: Schema.Literals(["confirmed", "suspected", "unknown"]),
  reacted: When,
  /** The day the user said it. */
  asserted: Schema.optionalKey(RecordDate),
});

export const CareEventRow = Schema.Struct({
  kind: Schema.Literal("care_event"),
  id: Id,
  type: Schema.Literals(["visit", "procedure", "immunisation"]),
  name: Schema.String,
  status: Schema.Literals(["planned", "done", "not_done", "unknown"]),
  date: When,
  provider: Text,
  details: Text,
});

export const NoneKnownRow = Schema.Struct({
  kind: Schema.Literal("none_known"),
  id: Id,
  category: Schema.Literal("allergies"),
  asserted: Schema.optionalKey(RecordDate),
});

export const FollowUpRow = Schema.Struct({
  kind: Schema.Literal("follow_up"),
  id: Id,
  title: Schema.String,
  due: Schema.optionalKey(Schema.Union([Dated, Schema.Literal("next_visit")])),
  status: Schema.Literals(["open", "done", "dropped"]),
  outcome: Text,
  about: Schema.optionalKey(Schema.Struct({ kind: Schema.String, id: Id })),
});

/** A stored row that doesn't fit its shape: shown as "can't show this row". */
export const BadRow = Schema.Struct({
  kind: Schema.String,
  id: Id,
  problem: Schema.String,
});
export type BadRow = typeof BadRow.Type;

/** One stored record, as the screens show it. */
export const RecordRow = Schema.Union([
  ResultRow,
  MedicineUseRow,
  PrescriptionRow,
  SymptomRow,
  ConditionRow,
  AllergyRow,
  CareEventRow,
  NoneKnownRow,
  FollowUpRow,
]);
export type RecordRow = typeof RecordRow.Type;

export const ShownRow = Schema.Union([RecordRow, BadRow]);
export type ShownRow = typeof ShownRow.Type;

/** The kinds with a page of their own; "none known" shows with allergies. */
export const PageKind = Schema.Literals([
  "result",
  "medicine_use",
  "prescription",
  "condition",
  "allergy",
  "symptom",
  "care_event",
]);
export type PageKind = typeof PageKind.Type;

/**
 * A group on a kind's page: a report (its results), a day of results typed
 * in the chat (or a month or year, at the precision known), or one row.
 */
export const RecordGroup = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["report", "chat", "row"]),
  /** The group's date; none for an undated group. */
  date: Schema.optionalKey(Schema.String),
  /** A report's lab or clinic, as printed. */
  issuer: Schema.optionalKey(Schema.String),
  rows: Schema.Array(ShownRow),
});
export type RecordGroup = typeof RecordGroup.Type;

/** A page of a kind's groups, newest first; `next` reads on. */
export const RecordPage = Schema.Struct({
  groups: Schema.Array(RecordGroup),
  next: Schema.NullOr(Schema.String),
});
export type RecordPage = typeof RecordPage.Type;

/** Where a record came from. */
export const RecordSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("document"),
    document: Id,
    page: Schema.Int,
    file: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("message"),
    entry: Id,
    /** The user's own words. */
    text: Schema.String,
    at: Schema.String,
  }),
]);
export type RecordSource = typeof RecordSource.Type;

/** One field a change changed: its value before and after (absent: not known). */
const FieldChange = Schema.Struct({
  field: Schema.String,
  before: Schema.optionalKey(Schema.Unknown),
  after: Schema.optionalKey(Schema.Unknown),
});

/** One change a save made to this record, in the order of saves. */
export const RecordChange = Schema.Struct({
  /** The save; its receipt in the chat has the same id. */
  save: Id,
  at: Schema.String,
  action: Schema.Literals([
    "add",
    "change",
    "remove",
    "restore",
    "link",
    "unlink",
  ]),
  /** For a change: only what changed. */
  fields: Schema.Array(FieldChange),
  /** The save rested on a message of the user's. */
  fromMessage: Schema.Boolean,
});
export type RecordChange = typeof RecordChange.Type;

/** A row opened: its sources, its history and, for a result, its versions. */
export const RecordDetail = Schema.Struct({
  row: ShownRow,
  removed: Schema.Boolean,
  sources: Schema.Array(RecordSource),
  history: Schema.Array(RecordChange),
  /** The earlier result this amended one replaces. */
  replaces: Schema.optionalKey(ShownRow),
  /** The amended result that replaces this one. */
  replacedBy: Schema.optionalKey(ShownRow),
  /** For a result: when it entered Rufi. */
  entered: Schema.optionalKey(Schema.String),
});
export type RecordDetail = typeof RecordDetail.Type;

/** Every current value of one test in one unit, oldest first, undated last. */
export const Series = Schema.Struct({
  test: Schema.String,
  unit: Schema.NullOr(Schema.String),
  values: Schema.Array(ShownRow),
});
export type Series = typeof Series.Type;

/** A kind's tile on Overview: what it counts, worked out from the record. */
export const Tile = Schema.Struct({
  kind: PageKind,
  /** Current records of the kind. */
  count: Schema.Int,
  /**
   * Those that apply now: medicines taken now, conditions ongoing, allergies
   * active; absent for the other kinds.
   */
  now: Schema.optionalKey(Schema.Int),
  /** Names of those that apply now, or of the latest, a few at most. */
  names: Schema.Array(Schema.String),
  /** The latest group: a report, a day of typed results, or a row. */
  latest: Schema.optionalKey(
    Schema.Struct({
      label: Schema.String,
      date: Schema.optionalKey(Schema.String),
      /** A results group's count, and how many carry a lab's flag. */
      results: Schema.optionalKey(Schema.Int),
      flagged: Schema.optionalKey(Schema.Int),
    }),
  ),
  /** Allergies: the day "none known" was said, when it is current. */
  noneKnown: Schema.optionalKey(Schema.String),
});
export type Tile = typeof Tile.Type;

/** A document waiting for you: read and not saved, or not read. */
export const WaitingDocument = Schema.Struct({
  id: Id,
  name: Schema.String,
  state: Schema.Literals(["to_save", "failed"]),
  results: Schema.Int,
  toCheck: Schema.Int,
});
export type WaitingDocument = typeof WaitingDocument.Type;

/** One of the latest saves, with its receipt. */
export const RecentChange = Schema.Struct({
  id: Id,
  at: Schema.String,
  receipt: Schema.String,
});
export type RecentChange = typeof RecentChange.Type;

/** A person's Overview: what needs them, their record as tiles, the latest saves. */
export const Overview = Schema.Struct({
  person: Schema.String,
  needsYou: Schema.Struct({ documents: Schema.Array(WaitingDocument) }),
  tiles: Schema.Array(Tile),
  recent: Schema.Array(RecentChange),
});
export type Overview = typeof Overview.Type;
