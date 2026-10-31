// The entry an older reader wrote in its notebook for a page: Rufi no
// longer writes entries, but the old ones are kept and shown as they are.
import { Schema } from "effect";

const Text = (max: number, description: string) =>
  Schema.String.annotate({ description }).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
  );

const Printed = (description: string) =>
  Schema.optionalKey(Text(200, `${description}, exactly as printed.`));

/** A date on the page with the words printed next to it. */
const PrintedDate = Schema.Struct({
  label: Text(100, "The words printed with the date: 'Collected', 'Reported'."),
  date: Text(100, "The date exactly as printed: '14/08/2026 08:10'."),
  iso: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\d{4}(-\d{2}(-\d{2})?)?$/)).annotate(
      {
        description:
          "The same date as YYYY-MM-DD (or YYYY-MM, YYYY), only when the order of day and month is certain; leave it out when it isn't.",
      },
    ),
  ),
});

/** One result read from a page (a lab result or a measurement), in Rufi's result fields, as printed. */
const Item = Schema.Struct({
  test_name: Text(200, "The test's or measurement's name, exactly as printed."),
  value_text: Text(
    100,
    "The value exactly as printed: '<5', '4,6', 'Negative'.",
  ),
  comparator: Schema.optionalKey(
    Schema.Literals(["<", "<=", ">", ">="]).annotate({
      description: "The comparator printed before the value, if any.",
    }),
  ),
  value_number: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "The value as a plain number, when it is one: '4,6' is 4.6.",
    }),
  ),
  unit: Printed("The unit"),
  reference_range: Printed("The reference range"),
  flag_text: Printed("The flag ('H', 'Low')"),
  context_text: Printed("The method or context ('Fasting', 'Calculated')"),
  date: Schema.optionalKey(PrintedDate),
  column: Schema.optionalKey(
    Schema.Literals(["current", "earlier"]).annotate({
      description: "'earlier' for a column of earlier results.",
    }),
  ),
  from_page: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).annotate({
      description:
        "The page another fact of this item came from, such as its date on page 1.",
    }),
  ),
  unsure: Schema.optionalKey(
    Text(300, "Why you aren't sure of this item; leave it out when you are."),
  ),
});

/** A page's entry, as an older reader saved it with save_page. */
export const Entry = Schema.Struct({
  outcome: Schema.Literals(["read", "nothing_here", "unreadable"]).annotate({
    description:
      "read: you read the page (it may have no results); nothing_here: a blank or empty page; unreadable: you couldn't read it (say why).",
  }),
  why: Schema.optionalKey(Text(300, "Why the page is unreadable.")),
  facts: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.optionalKey(
        Schema.Literals(["lab_report", "prescription", "letter", "other"]),
      ),
      dates: Schema.optionalKey(
        Schema.Array(PrintedDate).annotate({
          description:
            "Every date printed on the page with its label; the sample's collection date first when there is one.",
        }),
      ),
      issuer: Printed("The lab or clinic"),
      name: Printed("The patient's name on the page"),
      report_number: Printed("The report number"),
      report_status: Printed("The report's status ('Final', 'Amended')"),
    }),
  ),
  items: Schema.Array(Item),
  issues: Schema.optionalKey(
    Schema.Array(
      Text(
        300,
        "Something that needs the person: another name, an unclear date.",
      ),
    ),
  ),
});
export type Entry = typeof Entry.Type;

/**
 * Checks an older Rufi stored with an entry. Rufi doesn't check entries any
 * more: the reader says itself what it isn't sure of. Old entries keep theirs,
 * and they are still read and shown.
 */
export interface Checks {
  /** The reader saw more or fewer rows than it saved items. */
  incomplete?: { rows_seen: number; items: number };
  /** Items (1, 2, 3... on the page) that may be wrong, and why. */
  items: { item: number; why: string }[];
}
