// The kinds of record the AI can change, with the fewest fields each needs
// (PLAN.md §3.2, the M2.2 plan). A change sets only the fields it gives;
// the others stay unknown. One list, so the save, its receipt and the
// overview read every kind the same way.
import { Schema } from "effect";
import { dateProblem, shownDate } from "./dates.ts";

const Text = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const Short = Text(200).annotate({ identifier: "Text" });
const Long = Text(1_000).annotate({ identifier: "LongText" });

/** A date as the user said it: the date the AI worked out, and their words. */
const DateSaid = Schema.Struct({
  date: Schema.String.check(
    Schema.makeFilter((text: string) => dateProblem(text)),
  ).annotate({
    description:
      "YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DDTHH:MM in the user's local time, at the precision they gave: 'since 2019' is 2019. Count relative words from when the user sent the message (read_conversation shows it), not from now.",
  }),
  words: Text(100).annotate({
    description:
      "The user's own words for this date, copied from the source message: 'last Monday', 'since 2019', '28 Sep'.",
  }),
}).annotate({ identifier: "DateSaid" });

export interface Field {
  /** The column it is stored in. */
  column: string;
  /** Its word on a receipt. */
  shown: string;
  /** What the AI may give; null forgets it. */
  input: Schema.Codec<unknown, unknown>;
  /**
   * How it is stored: as given; a yes/no as 1/0; a date with its words in
   * `<column>_words`; a due date or 'next_visit'; a link to another record
   * in linked_kind and linked_id.
   */
  type: "value" | "boolean" | "date" | "due" | "link";
  /** Where a date's words are kept, when not in `<column>_words`. */
  wordsColumn?: string;
  /** A date that must have happened by the time the user said it. */
  past?: boolean | ((after: Row) => boolean);
  /** The AI must give it when adding, and can't forget it. */
  required?: true;
  /** Always known in the record: "unknown" stands for not known. */
  notNull?: true;
}

/** A record's row as stored. */
export type Row = Record<string, unknown>;

export interface Kind {
  /** The name the AI uses. */
  name: string;
  table: string;
  /** Its words for a person. */
  noun: string;
  /** Fields by the name the AI uses. */
  fields: Record<string, Field>;
  /** What a receipt calls one, from its row. */
  label: (row: Row) => string;
  /** Fields the label already shows, so an added record's receipt doesn't say them twice. */
  inLabel: readonly string[];
  /** Set by Rufi, never the AI: the day the user said it. */
  asserted?: true;
}

const text = (column: string, shown = column): Field => ({
  column,
  shown,
  input: Short,
  type: "value",
});
const long = (column: string, shown = column): Field => ({
  column,
  shown,
  input: Long,
  type: "value",
});
const number = (column: string, shown: string): Field => ({
  column,
  shown,
  input: Schema.Finite,
  type: "value",
});
const choice = (
  column: string,
  values: readonly [string, ...string[]],
  shown = column,
): Field => ({ column, shown, input: Schema.Literals(values), type: "value" });
/** A status or certainty: its column always holds one, "unknown" at least. */
const state = (column: string, values: readonly [string, ...string[]]) => ({
  ...choice(column, values),
  notNull: true as const,
});
const date = (
  column: string,
  shown: string,
  past: NonNullable<Field["past"]>,
): Field => ({ column, shown, input: DateSaid, type: "date", past });
const required = (field: Field): Field => ({ ...field, required: true });

const join = (...parts: unknown[]) =>
  parts.filter((part) => typeof part === "string" && part !== "").join(" ");

export const KINDS: readonly Kind[] = [
  {
    name: "medicine_use",
    table: "medicine_uses",
    noun: "medicine use",
    fields: {
      name: required(text("name")),
      strength: text("strength"),
      amount: text("amount"),
      schedule: text("schedule"),
      route: text("route"),
      purpose: text("purpose"),
      status: state("status", [
        "current",
        "paused",
        "stopped",
        "completed",
        "unknown",
      ]),
      started: date("started", "start", false),
      ended: date("ended", "end", false),
    },
    label: (row) => join(row["name"], row["strength"]),
    inLabel: ["name", "strength"],
  },
  {
    name: "prescription",
    table: "prescriptions",
    noun: "prescription",
    fields: {
      item: required(text("item")),
      strength: text("strength"),
      amount: text("amount"),
      route: text("route"),
      schedule: text("schedule"),
      period: text("period"),
      prescriber: text("prescriber"),
      issued: date("issued", "issued", true),
    },
    label: (row) => join(row["item"], row["strength"]),
    inLabel: ["item", "strength"],
  },
  {
    name: "symptom",
    table: "symptoms",
    noun: "symptom",
    fields: {
      name: required(text("name")),
      status: state("status", ["ongoing", "resolved", "unknown"]),
      onset: date("onset", "onset", true),
      ended: date("ended", "end", true),
      severity: text("severity"),
      location: text("location"),
      intermittent: {
        column: "intermittent",
        shown: "comes and goes",
        input: Schema.Boolean,
        type: "boolean",
      },
      details: long("details"),
    },
    label: (row) => join(row["name"]),
    inLabel: ["name"],
  },
  {
    name: "condition",
    table: "conditions",
    noun: "condition",
    fields: {
      name: required(text("name")),
      certainty: state("certainty", ["suspected", "diagnosed", "unknown"]),
      status: state("status", ["ongoing", "resolved", "unknown"]),
      recognised: date("recognised", "recognised", true),
      resolved: date("resolved", "resolved", true),
      details: long("details"),
    },
    label: (row) => join(row["name"]),
    inLabel: ["name"],
  },
  {
    name: "allergy",
    table: "allergies",
    noun: "allergy",
    fields: {
      substance: required(text("substance")),
      reaction: text("reaction"),
      status: state("status", ["active", "inactive", "unknown"]),
      certainty: state("certainty", ["confirmed", "suspected", "unknown"]),
      reacted: date("reacted", "reaction date", true),
    },
    label: (row) => join(row["substance"]),
    inLabel: ["substance"],
    asserted: true,
  },
  {
    name: "result",
    table: "results",
    noun: "result",
    fields: {
      test: required(text("test_name", "test")),
      value: required(text("value_text", "value")),
      comparator: choice("comparator", ["<", "<=", ">", ">="]),
      number: number("value_number", "number"),
      second_number: number("second_number", "second number"),
      unit: text("unit"),
      range: text("reference_range", "range"),
      flag: text("flag_text", "flag"),
      context: text("context_text", "context"),
      measured: {
        ...date("measured_at", "measured", true),
        wordsColumn: "measured_words",
      },
      replaces: text("replaces_id", "replaces"),
    },
    label: (row) => join(row["test_name"], row["value_text"], row["unit"]),
    // The printed value already shows its numbers.
    inLabel: ["test", "value", "unit", "number", "second_number"],
  },
  {
    name: "care_event",
    table: "care_events",
    noun: "care event",
    fields: {
      type: required(choice("type", ["visit", "procedure", "immunisation"])),
      name: required(text("name")),
      status: state("status", ["planned", "done", "not_done", "unknown"]),
      // Done or missed care happened by the time the user said so.
      date: date(
        "date",
        "date",
        (after) => after["status"] === "done" || after["status"] === "not_done",
      ),
      provider: text("provider"),
      details: long("details"),
    },
    label: (row) => join(row["name"]),
    inLabel: ["name"],
  },
  {
    name: "none_known",
    table: "none_known",
    noun: "statement",
    fields: {
      category: required(choice("category", ["allergies"])),
    },
    label: (row) =>
      `no known ${String(row["category"])}${typeof row["asserted"] === "string" ? ` (as of ${shownDate(row["asserted"])})` : ""}`,
    inLabel: ["category"],
    asserted: true,
  },
  {
    name: "follow_up",
    table: "follow_ups",
    noun: "follow-up",
    fields: {
      title: required(text("title")),
      due: {
        column: "due",
        shown: "due",
        input: Schema.Union([DateSaid, Schema.Literal("next_visit")]),
        type: "due",
      },
      status: state("status", ["open", "done", "dropped"]),
      outcome: long("outcome"),
      about: {
        column: "linked_id",
        shown: "about",
        input: Schema.Struct({
          kind: Schema.Literals([
            "medicine_use",
            "prescription",
            "symptom",
            "condition",
            "allergy",
            "result",
            "care_event",
          ]),
          id: Short,
        }),
        type: "link",
      },
    },
    label: (row) => join(row["title"]),
    inLabel: ["title"],
  },
];

/** The column a date field keeps the user's words in. */
export const wordsColumn = (field: Field) =>
  field.wordsColumn ?? `${field.column}_words`;

export const kindNamed = (name: string) =>
  KINDS.find((kind) => kind.name === name);
