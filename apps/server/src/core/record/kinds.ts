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
  // Described before the check: a description after it isn't in the JSON schema.
  date: Schema.String.annotate({
    description:
      "YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DDTHH:MM in the user's local time, at the precision they gave: 'since 2019' is 2019. Count relative words from when the user sent the message (read_chat shows it), not from now.",
  }).check(Schema.makeFilter((text: string) => dateProblem(text))),
  words: Text(100).annotate({
    description:
      "The words the date came from, as the user or the document said them: 'last Monday', 'since 2019', 'December'.",
  }),
}).annotate({ identifier: "DateSaid" });

/** Which message of the user's a change rests on: a change's and a fix's source. */
export const Position = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  description:
    "The user's message this rests on. Leave it out for their message in this turn (where they said yes). For an earlier message of theirs, give its position, as read_chat shows it.",
});

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
  /**
   * The field of an add that names an earlier record of the kind (an
   * amended result's replaces): when the add leaves this field out, it
   * takes the earlier record's value, before required is checked.
   */
  inheritsVia?: string;
  /** Always known in the record: "unknown" stands for not known. */
  notNull?: true;
}

/** A record's row as stored. */
export type Row = Record<string, unknown>;

export interface Kind {
  /** The name the AI uses. */
  name: string;
  table: string;
  /** Its words for a person: one, and several. */
  noun: string;
  nouns: string;
  /** Fields by the name the AI uses. */
  fields: Record<string, Field>;
  /** What a receipt calls one, from its row. */
  label: (row: Row) => string;
  /** Fields the label already shows, so an added record's receipt doesn't say them twice. */
  inLabel: readonly string[];
  /** Set by Rufi, never the AI: the day the user said it. */
  asserted?: true;
  /** The field get_records' from and to are compared with ("asserted" for Rufi's own date). */
  dated: string;
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
    nouns: "medicine uses",
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
    dated: "started",
  },
  {
    name: "prescription",
    table: "prescriptions",
    noun: "prescription",
    nouns: "prescriptions",
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
    dated: "issued",
  },
  {
    name: "symptom",
    table: "symptoms",
    noun: "symptom",
    nouns: "symptoms",
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
    dated: "onset",
  },
  {
    name: "condition",
    table: "conditions",
    noun: "condition",
    nouns: "conditions",
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
    dated: "recognised",
  },
  {
    name: "allergy",
    table: "allergies",
    noun: "allergy",
    nouns: "allergies",
    fields: {
      substance: required(text("substance")),
      reaction: text("reaction"),
      status: state("status", ["active", "inactive", "unknown"]),
      certainty: state("certainty", ["confirmed", "suspected", "unknown"]),
      reacted: date("reacted", "reaction date", true),
    },
    label: (row) => join(row["substance"]),
    inLabel: ["substance"],
    dated: "reacted",
    asserted: true,
  },
  {
    name: "result",
    table: "results",
    noun: "result",
    nouns: "results",
    fields: {
      test: required(text("test_name", "test")),
      value: required(text("value_text", "value")),
      // A lab result or a measurement: the AI's choice with the person,
      // never worked out from the test's name (docs/adr/0013).
      category: {
        ...required(choice("category", ["lab", "measurement"])),
        input: Schema.Literals(["lab", "measurement"]).annotate({
          description:
            "lab: a test of a sample, such as blood or urine, whether from a report or typed in (shown on Lab results). measurement: a reading of the body, such as blood pressure, pulse, weight, height, temperature or SpO2 (shown on Measurements). Choose it with the user; an amended result keeps the category of the one it replaces unless you give one.",
        }),
        inheritsVia: "replaces",
      },
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
    dated: "measured",
  },
  {
    name: "care_event",
    table: "care_events",
    noun: "care event",
    nouns: "care events",
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
    dated: "date",
  },
  {
    name: "none_known",
    table: "none_known",
    noun: "statement",
    nouns: "“none known” statements",
    fields: {
      category: required(choice("category", ["allergies"])),
    },
    label: (row) =>
      `no known ${String(row["category"])}${typeof row["asserted"] === "string" ? ` (as of ${shownDate(row["asserted"])})` : ""}`,
    inLabel: ["category"],
    dated: "asserted",
    asserted: true,
  },
  {
    name: "follow_up",
    table: "follow_ups",
    noun: "follow-up",
    nouns: "follow-ups",
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
    dated: "due",
  },
];

/** The column a date field keeps the user's words in. */
export const wordsColumn = (field: Field) =>
  field.wordsColumn ?? `${field.column}_words`;

export const kindNamed = (name: string) =>
  KINDS.find((kind) => kind.name === name);

/** A field's value as its columns, as save_changes stores it. */
export function columnsOf(field: Field, value: unknown): Row {
  switch (field.type) {
    case "value":
      return { [field.column]: value };
    case "boolean":
      return { [field.column]: value === null ? null : value ? 1 : 0 };
    case "due":
    case "date": {
      // A due date is a date, or the next visit.
      if (value === "next_visit") {
        return { [field.column]: value, [wordsColumn(field)]: null };
      }
      const said = value as { date: string; words: string } | null;
      return {
        [field.column]: said?.date ?? null,
        [wordsColumn(field)]: said?.words ?? null,
      };
    }
    case "link": {
      const link = value as { kind: string; id: string } | null;
      return { linked_kind: link?.kind ?? null, linked_id: link?.id ?? null };
    }
  }
}

/**
 * A value as literal Markdown text: on one line, and with every mark that
 * could format it, link it or hide it as HTML escaped.
 */
export const literal = (text: string) =>
  text.replace(/\s*\n\s*/g, " ").replace(/[\\`*_[\]<>~|&!#]/g, "\\$&");
