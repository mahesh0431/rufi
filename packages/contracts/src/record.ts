// What the record's screens get from Rufi's local API: Overview, a page per
// kind (Lab results by test), a test's page, and a row with its sources and
// history. Rows carry their fields by the names save_changes uses, as
// stored.
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

/** A result is a lab result or a measurement; each has its own page. */
export const ResultCategory = Schema.Literals(["lab", "measurement"]);
export type ResultCategory = typeof ResultCategory.Type;

export const ResultRow = Schema.Struct({
  kind: Schema.Literal("result"),
  id: Id,
  test: Schema.String,
  value: Schema.String,
  category: ResultCategory,
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
  /** The person's test it is in. */
  in_test: Id,
  /** Its numbers in its test's unit, when the AI could give them. */
  test_number: Schema.optionalKey(Schema.Number),
  test_second_number: Schema.optionalKey(Schema.Number),
});
export type ResultRow = typeof ResultRow.Type;

/** One of the person's tests: its name, section and unit, in the AI's words. */
export const TestRow = Schema.Struct({
  kind: Schema.Literal("test"),
  id: Id,
  name: Schema.String,
  section: Text,
  unit: Text,
});
export type TestRow = typeof TestRow.Type;

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

/** A visit that happened, with the doctor's words as written. */
export const VisitRow = Schema.Struct({
  kind: Schema.Literal("visit"),
  id: Id,
  setting: Schema.String,
  /** When it happened; a hospital stay's admission. */
  date: When,
  /** A hospital stay's discharge. */
  ended: When,
  doctor: Text,
  place: Text,
  reason: Text,
  /** The doctor's words as written, in Markdown. */
  as_written: Schema.String,
  /** On the Visits page: how many current records cite it now. */
  cited: Schema.optionalKey(Schema.Int),
});
export type VisitRow = typeof VisitRow.Type;

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
  type: Schema.Literals(["procedure", "immunisation"]),
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
export type FollowUpRow = typeof FollowUpRow.Type;

/** The person's profile: shown where a visit or a page it rests on lists it. */
export const ProfileRow = Schema.Struct({
  kind: Schema.Literal("profile"),
  id: Id,
  birth_date: When,
  sex_for_ranges: Schema.optionalKey(Schema.Literals(["female", "male"])),
  blood_group: Text,
  height: Schema.optionalKey(
    Schema.Struct({ value: Schema.Number, unit: Schema.String }),
  ),
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
  TestRow,
  MedicineUseRow,
  VisitRow,
  SymptomRow,
  ConditionRow,
  AllergyRow,
  CareEventRow,
  NoneKnownRow,
  FollowUpRow,
  ProfileRow,
]);
export type RecordRow = typeof RecordRow.Type;

export const ShownRow = Schema.Union([RecordRow, BadRow]);
export type ShownRow = typeof ShownRow.Type;

/**
 * The record's pages: one per kind, but results have two, Lab results and
 * Measurements, by their category; "none known" shows with allergies.
 */
export const PageKind = Schema.Literals([
  "lab_result",
  "measurement",
  "medicine_use",
  "visit",
  "condition",
  "allergy",
  "symptom",
  "care_event",
]);
export type PageKind = typeof PageKind.Type;

/**
 * A group on a page: on Lab results, a report (its lab results) or a day of
 * lab results typed in the chat; on Measurements, the day they were taken;
 * a day can be a month or year, at the precision known. On other pages,
 * one row.
 */
export const RecordGroup = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["report", "chat", "day", "row"]),
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
  /**
   * On a results page, a row's small trend, by the row's id: the latest
   * values of its test's line up to it, oldest first, a few at most, each
   * with a date and a number in the test's unit. Only for a row with two or
   * more.
   */
  trends: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Array(ResultRow)),
  ),
});
export type RecordPage = typeof RecordPage.Type;

/** A test on Lab results: its latest current lab result, and how many there are. */
export const LabTest = Schema.Struct({
  test: ShownRow,
  latest: ShownRow,
  count: Schema.Int,
});
export type LabTest = typeof LabTest.Type;
/**
 * Lab results: each of the person's tests that has a current lab result,
 * by section in name order, no section last; a section's tests by name.
 * Its latest is the newest by sample date, undated only when none is dated.
 */
export const LabResults = Schema.Struct({
  sections: Schema.Array(
    Schema.Struct({
      /** In the AI's words; none for tests with no section. */
      section: Schema.NullOr(Schema.String),
      tests: Schema.Array(LabTest),
    }),
  ),
  /** A test's small trend, by its latest's id, as on a results page. */
  trends: Schema.Record(Schema.String, Schema.Array(ResultRow)),
});
export type LabResults = typeof LabResults.Type;
/** A value on a test's page: a result, and the report it was printed in. */
export const TestValue = Schema.Struct({
  row: ShownRow,
  /** Its report, with the lab or clinic as printed; null: not from a report. */
  report: Schema.NullOr(
    Schema.Struct({ issuer: Schema.optionalKey(Schema.String) }),
  ),
});
export type TestValue = typeof TestValue.Type;
/**
 * A test's page: the test, and its current values newest first, by sample
 * date, then the undated ones, the later saved first.
 */
export const TestPage = Schema.Struct({
  test: ShownRow,
  values: Schema.Array(TestValue),
});
export type TestPage = typeof TestPage.Type;
/** Where a record came from. */
export const RecordSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("document"),
    document: Id,
    page: Schema.Int,
    file: Schema.String,
    /** The document was deleted: its name and page stay, nothing to open. */
    deleted: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("message"),
    entry: Id,
    /** The user's own words. */
    text: Schema.String,
    at: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("visit"),
    visit: Id,
    /** Its doctor, place and date: "Dr A. Fictional · Lakeview Family Clinic · 20 Aug 2026". */
    label: Schema.String,
    /** The visit was removed: its name stays, nothing to open. */
    removed: Schema.Boolean,
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
  /** The save rested on a visit. */
  fromVisit: Schema.Boolean,
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
  /** For a visit: the current records that cite it now, From this visit. */
  fromVisit: Schema.optionalKey(Schema.Array(ShownRow)),
});
export type RecordDetail = typeof RecordDetail.Type;

/** A page's tile on Overview: what it counts, worked out from the record. */
export const Tile = Schema.Struct({
  kind: PageKind,
  /** Current records on the page; on Lab results, its tests. */
  count: Schema.Int,
  /**
   * Those that apply now: medicines taken now, conditions ongoing, allergies
   * active; absent for the other kinds.
   */
  now: Schema.optionalKey(Schema.Int),
  /** Names of those that apply now, or of the latest, a few at most. */
  names: Schema.Array(Schema.String),
  /** The latest group: a report, a day of results, or a row. */
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

/**
 * A document waiting for you: read with results not saved, read with pages
 * that couldn't be read, or a reading that failed.
 */
export const WaitingDocument = Schema.Struct({
  id: Id,
  name: Schema.String,
  state: Schema.Literals(["to_save", "unread_pages", "failed"]),
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

/**
 * Where an open follow-up stands now, by the core's due rules
 * (docs/help/follow-ups.md): coming up is due in the next 30 days.
 */
export const DueClass = Schema.Literals([
  "overdue",
  "due",
  "coming_up",
  "later",
  "next_visit",
  "no_date",
]);
export type DueClass = typeof DueClass.Type;

/** An open follow-up that needs the person: overdue, due now or coming up. */
export const FollowUpNeed = Schema.Struct({
  state: Schema.Literals(["overdue", "due", "coming_up"]),
  followUp: FollowUpRow,
});
export type FollowUpNeed = typeof FollowUpNeed.Type;

/** A person's Overview: what needs them, their record as tiles, the latest saves. */
export const Overview = Schema.Struct({
  person: Schema.String,
  needsYou: Schema.Struct({
    documents: Schema.Array(WaitingDocument),
    /** Overdue first, then due now, then coming up. */
    followUps: Schema.Array(FollowUpNeed),
  }),
  tiles: Schema.Array(Tile),
  recent: Schema.Array(RecentChange),
  /** How many follow-ups are open. */
  openFollowUps: Schema.Int,
});
export type Overview = typeof Overview.Type;

/**
 * The person's follow-ups in the Follow-ups page's groups, in its order:
 * the open ones by where they stand, then done, then dropped. A group with
 * no follow-up is left out.
 */
export const FollowUps = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      group: Schema.Union([DueClass, Schema.Literals(["done", "dropped"])]),
      rows: Schema.Array(ShownRow),
    }),
  ),
});
export type FollowUps = typeof FollowUps.Type;

/**
 * The person's profile: their name, never empty, and the few facts their
 * record is read with, each null until given. A birth date is at the
 * precision given, with its words; a height is a number and its unit.
 */
export const BirthDate = Schema.Struct({
  date: RecordDate,
  words: Schema.String,
});
export const SexForRanges = Schema.Literals(["female", "male"]);
export const ProfileValues = Schema.Struct({
  name: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
  ),
  birth_date: Schema.NullOr(BirthDate),
  sex_for_ranges: Schema.NullOr(SexForRanges),
  blood_group: Schema.NullOr(
    Schema.Literals(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]),
  ),
  height: Schema.NullOr(
    Schema.Struct({
      value: Schema.Finite,
      unit: Schema.Literals(["cm", "in"]),
    }),
  ),
});
export type ProfileValues = typeof ProfileValues.Type;
export type ProfileField = keyof ProfileValues;

/** Where a save was made: in the chat, or entered in a form. */
export const MadeIn = Schema.Literals([
  "chat",
  "welcome",
  "profile",
  "settings",
]);
export type MadeIn = typeof MadeIn.Type;

/** A field of the profile, before and after a save: null when not set. */
const fieldChange = <K extends ProfileField>(field: K) =>
  Schema.Struct({
    field: Schema.Literal(field),
    before: ProfileValues.fields[field],
    after: ProfileValues.fields[field],
  });

/** One save that changed the profile: when, where, and each field it changed. */
export const ProfileChange = Schema.Struct({
  save: Id,
  at: Schema.String,
  madeIn: MadeIn,
  fields: Schema.Array(
    Schema.Union([
      fieldChange("name"),
      fieldChange("birth_date"),
      fieldChange("sex_for_ranges"),
      fieldChange("blood_group"),
      fieldChange("height"),
    ]),
  ),
});
export type ProfileChange = typeof ProfileChange.Type;

/**
 * The profile page: the values now, the age today from the birth date
 * (youngest and oldest it can be, the same when the date settles it), and
 * each save that changed it, oldest first.
 */
export const Profile = Schema.Struct({
  values: ProfileValues,
  age: Schema.NullOr(Schema.Tuple([Schema.Int, Schema.Int])),
  history: Schema.Array(ProfileChange),
});
export type Profile = typeof Profile.Type;

/**
 * A change entered in the profile's form: only the fields changed, in one
 * sending, named by the form so the same sending again saves once.
 */
export const SaveProfile = Schema.Struct({
  sending: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  in: Schema.Literals(["profile", "settings"]),
  changes: Schema.Struct({
    name: Schema.optionalKey(ProfileValues.fields.name),
    birth_date: Schema.optionalKey(ProfileValues.fields.birth_date),
    sex_for_ranges: Schema.optionalKey(ProfileValues.fields.sex_for_ranges),
    blood_group: Schema.optionalKey(ProfileValues.fields.blood_group),
    height: Schema.optionalKey(ProfileValues.fields.height),
  }),
});
export type SaveProfile = typeof SaveProfile.Type;
