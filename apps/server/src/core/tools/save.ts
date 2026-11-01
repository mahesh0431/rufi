// save_changes: the one way the AI changes the record, after the user said
// yes in Rufi's chat (docs/adr/0005). Only Rufi's own chat can save, and
// only in a turn the user started. dismiss_items: draft items the user
// doesn't want saved, never saved later.
import {
  DismissInput,
  DismissRefused,
  FIXABLE,
  type Dismissed,
} from "../record/items.ts";
import { KINDS, kindNamed, type Field, type Kind } from "../record/kinds.ts";
import { SaveInput, SaveRefused, type Saved } from "../record/save.ts";
import { defineTool, jsonSchemaOf, Refusal } from "./registry.ts";

/** Receipt lines the AI gets back at most; the rest are in Rufi's receipt. */
const RECEIPT_LINES = 20;

type Json = Record<string, unknown>;

/** A field's fixed values, or what kind of value it takes. */
function valuesOf(field: Field): string {
  switch (field.type) {
    case "date":
      return " (date)";
    case "due":
      return ' (date or "next_visit")';
    case "link": {
      // The kinds it can name, from its object's kind.
      const json = jsonSchemaOf(field.input);
      const kinds = [json, ...((json["anyOf"] ?? []) as Json[])].flatMap(
        (part) =>
          ((part["properties"] as Record<string, Json> | undefined)?.["kind"]?.[
            "enum"
          ] ?? []) as string[],
      );
      return ` ({kind: ${kinds.join("|")}, id} of another record)`;
    }
    case "boolean":
      return " (true|false)";
    case "amount":
      return ' ({"value": 162, "unit": "cm"|"in"})';
    case "value": {
      // A fixed set: an enum, or a union of them.
      const json = jsonSchemaOf(field.input);
      const values = [json, ...((json["anyOf"] ?? []) as Json[])].flatMap(
        (part) => (part["enum"] ?? []) as string[],
      );
      return values.length > 0 ? ` (${values.join("|")})` : "";
    }
  }
}

const named = (fields: Record<string, Field>, names: readonly string[]) =>
  names.map((name) => `${name}${valuesOf(fields[name] as Field)}`).join(", ");

/**
 * Each kind's fields, in the description: Codex cuts an input schema over
 * 5,000 bytes, as this one is, to `unknown` before the model sees it
 * (0.159.3), but keeps the description whole.
 */
const FIELDS = [
  'Fields by kind, in changes[].fields (a date is {"date": "2026-09-28", "words": "last Monday"}: YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DDTHH:MM in local time, at the precision the user gave, with the words it came from):',
  ...KINDS.map(
    (kind) => `- ${kind.name}: ${named(kind.fields, Object.keys(kind.fields))}`,
  ),
  `A draft item's fix.fields: ${named((kindNamed("result") as Kind).fields, FIXABLE)}.`,
].join("\n");

export const saveChanges = defineTool({
  name: "save_changes",
  description: `Saves to the active person's record, all or nothing, after the user clearly said yes to exactly this in this chat. Two parts, either or both:
- changes: typed changes from the user's own words or their documents. Each is one record: add one, change the fields given (the rest stay as they are), remove one (it stays in history), restore a removed one, link (add sources to a record whose values stay as they are) or remove_source (take sources off a record, as get_records lists them, to undo a link or "another source"); ids come from get_overview or get_records. from names the user's document pages ({document, page}) and visits ({visit: id}) a change rests on; a record saved from a visit cites the visit, and the visit cites its page. ref names a record an add makes ("v1"), so a later change in the same save can cite it as {visit: {ref: "v1"}}: add the visit first, then the records from it. Give only what the user said: a field they didn't give stays out, and a date comes with the words it came from. A result's category (lab or measurement) is the one field you choose, with the user: every added result needs one, except an amended result, which keeps the category of the one it replaces unless you give one. A result read from a document changes in place only its category, in a change of its own; what it prints and its date change only by amendment. source is the user's message with the facts the change rests on, so the record shows why it is there: when the facts came in an earlier message than the yes, give that message's position as read_chat shows it; when they are in this turn's message, leave source out. A change with from rests only on it unless you give source too: the user's yes alone is never a source.
- items: draft items of the user's documents (get_documents), each with the version you read and how it goes in: new, another_source (the same result is already saved: its values stay, and the document page becomes another source) or correction (it corrects a saved result: a new result replaces it); record names the saved result, with its version from get_records; for a result printed twice in what this save saves (on two pages, or in two documents), record {item} names the item saved as new in this save, so one save keeps both pages. category: lab or measurement, for new; a correction keeps the corrected result's unless you give one; never for another_source. Rufi takes each item's values and date from the stored item, never from you, except the number of a value the user fixed on the document's page: give it in value_number (and comparator) as you read their value, and ask them when it is unclear; fix holds only a value the user corrected in the chat, or the date they gave for an item with none (a rough one is fine, at their precision), with the words it came from; its source is as a change's. An item saved at that version, and still in the record so (its page a source of that result, the result not removed), returns its earlier save and saves nothing; after an undo took its page off or removed its result, it can be saved again. A dismissed item, or one whose version changed, is refused, and nothing is saved.
No count limit. Rufi refuses a save with any problem and says each one; nothing is saved then. On success Rufi adds its own receipt to the chat and returns it; the same call again returns the same receipt. Never say something was saved without this tool's answer.
${FIELDS}`,
  input: SaveInput,
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [
    {
      changes: [
        {
          kind: "medicine_use",
          action: "add",
          fields: {
            name: "Magnesium",
            strength: "200 mg",
            schedule: "at night",
            status: "current",
            started: { date: "2026-09-28", words: "last Monday" },
          },
        },
      ],
    },
    {
      changes: [
        {
          kind: "medicine_use",
          action: "change",
          id: "0199a0f2-7c1e-7d3a-9b1e-3f5c2a1d4e6f",
          fields: { status: "stopped" },
        },
        {
          kind: "symptom",
          action: "add",
          fields: { name: "Stomach upset" },
        },
      ],
    },
    {
      changes: [
        {
          kind: "result",
          action: "add",
          fields: {
            test: "HbA1c",
            value: "6.8",
            category: "lab",
            number: 6.8,
            measured: { date: "2026-10-03", words: "3 Oct" },
          },
        },
      ],
    },
    {
      changes: [
        {
          kind: "result",
          action: "change",
          id: "0199a0f2-0000-7000-8000-00000000000b",
          source: 41,
          fields: { category: "measurement" },
        },
      ],
    },
    {
      changes: [
        {
          kind: "result",
          action: "remove_source",
          id: "0199a0f2-0000-7000-8000-00000000000a",
          from: [{ document: "0199a0f2-0000-7000-8000-0000000000d1", page: 2 }],
        },
      ],
    },
    {
      changes: [
        {
          kind: "visit",
          action: "add",
          ref: "v1",
          from: [{ document: "0199a0f2-0000-7000-8000-0000000000d2", page: 1 }],
          fields: {
            setting: "Clinic",
            date: { date: "2026-08-20", words: "20/08/2026" },
            doctor: "Dr A. Fictional",
            place: "Lakeview Family Clinic",
            reason: "Iron deficiency anaemia",
            as_written:
              "**Diagnosis:** Iron deficiency anaemia\n\n**Rx**\n1. Ferrous sulfate 200 mg once daily\n\n**Review** in 6 weeks",
          },
        },
        {
          kind: "medicine_use",
          action: "link",
          id: "0199a0f2-7c1e-7d3a-9b1e-3f5c2a1d4e6f",
          from: [{ visit: { ref: "v1" } }],
        },
      ],
    },
    {
      items: [
        {
          item: "0199a0f2-0000-7000-8000-000000000001",
          version: 1,
          as: "new",
          category: "lab",
        },
        {
          item: "0199a0f2-0000-7000-8000-000000000002",
          version: 1,
          as: "another_source",
          record: { id: "0199a0f2-0000-7000-8000-00000000000a", version: null },
        },
        {
          item: "0199a0f2-0000-7000-8000-000000000003",
          version: 2,
          as: "new",
          category: "lab",
          fix: { fields: { value: "132", number: 132 } },
        },
      ],
    },
  ],
  run: async (input, { save, callId }) => {
    if (!save || callId === undefined) {
      throw new Refusal("Changes can be saved only in Rufi's own chat.");
    }
    try {
      return savedResult(await save(input, callId));
    } catch (error) {
      if (error instanceof SaveRefused) {
        throw new Refusal(error.message, error.problems);
      }
      throw error;
    }
  },
});

/** What save_changes answers for a save. */
export function savedResult(saved: Saved) {
  const lines = saved.receipt.split("\n");
  const receipt =
    lines.length > RECEIPT_LINES
      ? `${lines.slice(0, RECEIPT_LINES).join("\n")}\n(${String(lines.length - RECEIPT_LINES)} more lines in Rufi's receipt in the chat)`
      : saved.receipt;
  return {
    ...(saved.receipt !== "" && { receipt }),
    changes: saved.changes,
    ...(saved.earlier.length > 0 && { already_saved: saved.earlier }),
    ...(saved.fresh
      ? saved.earlier.length > 0 && {
          note: "The items in already_saved weren't saved again: each is in the record already, as its earlier save put it.",
        }
      : saved.receipt === ""
        ? {
            note: "Nothing was saved, and Rufi added no receipt: every item is in the record already, as its earlier save in already_saved put it. If the user asked for something else, read the result with get_records and tell them.",
          }
        : { note: "This call was already saved." }),
  };
}

/** What dismiss_items answers for a dismissal. */
export const dismissedResult = (done: Dismissed) => ({
  dismissed: done.dismissed,
  ...(done.already.length > 0 && { already_dismissed: done.already }),
  ...(done.fresh && { receipt: done.receipt }),
});

export const dismissItems = defineTool({
  name: "dismiss_items",
  description:
    "Dismisses draft items of the user's documents that the user doesn't want saved (a test that isn't theirs, a row read by mistake), after you said which items you would set aside and the user clearly said yes to that in this chat ('it isn't mine' alone is not a yes): each is never saved later, and Rufi adds a receipt line to the chat. Give each item's version as you read it with get_documents; one that changed since is refused, and nothing is dismissed. An item already dismissed stays so; a saved item can't be dismissed (remove its record with save_changes instead).",
  input: DismissInput,
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [
    { items: [{ item: "0199a0f2-0000-7000-8000-000000000004", version: 1 }] },
  ],
  run: async (input, { dismiss, callId }) => {
    if (!dismiss || callId === undefined) {
      throw new Refusal("Items can be dismissed only in Rufi's own chat.");
    }
    try {
      return dismissedResult(await dismiss(input, callId));
    } catch (error) {
      if (error instanceof DismissRefused) {
        throw new Refusal(error.message, error.problems);
      }
      throw error;
    }
  },
});
