// save_changes: the one way the AI changes the record, after the user said
// yes in Rufi's chat (docs/adr/0005). Only Rufi's own chat can save, and
// only in a turn the user started. dismiss_items: draft items the user
// doesn't want saved, never saved later.
import { DismissInput, DismissRefused } from "../record/items.ts";
import { SaveInput, SaveRefused } from "../record/save.ts";
import { defineTool, Refusal } from "./registry.ts";

/** Receipt lines the AI gets back at most; the rest are in Rufi's receipt. */
const RECEIPT_LINES = 20;

export const saveChanges = defineTool({
  name: "save_changes",
  shown: "Save to your health record",
  description: `Saves to the active person's record, all or nothing, after the user clearly said yes to exactly this in this chat. Two parts, either or both:
- changes: typed changes from the user's own words. Each is one record: add one, change the fields given (the rest stay as they are), remove one (it stays in history), restore a removed one, or remove_source (take a document page off a record's sources, to undo "another source": the page goes in from, as {document, page} from the record's sources in get_records); ids come from get_overview or get_records. Give only what the user said: a field they didn't give stays out, and a date needs their own words from the source message. A result's category (lab or measurement) is the one field you choose, with the user: every added result needs one, except an amended result, which keeps the category of the one it replaces unless you give one. A result read from a document changes in place only its category, in a change of its own; what it prints and its date change only by amendment. source is the user's own words the change rests on, copied from their message.
- items: draft items of the user's documents (get_documents), each with the version you read and how it goes in: new, another_source (the same result is already saved: its values stay, and the document page becomes another source) or correction (it corrects a saved result: a new result replaces it); record names the saved result, with its version from get_records. category: lab or measurement, for new; a correction keeps the corrected result's unless you give one; never for another_source. Rufi takes each item's values from the stored item, never from you, and its date from the item or, for a lab result, its page; a measurement is dated only by its own date or the user's; fix holds only a value the user corrected in the chat, or the date they gave for an item with none (a rough one is fine, at their precision), with their words. An item already saved at that version returns its earlier save; a dismissed item, or one whose version changed, is refused, and nothing is saved.
No count limit. Rufi refuses a save with any problem and says each one; nothing is saved then. On success Rufi adds its own receipt to the chat and returns it; the same call again returns the same receipt. Never say something was saved without this tool's answer.`,
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
          source: "I started magnesium 200 mg at night last Monday",
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
          source: "I stopped creatine because of a stomach upset",
          fields: { status: "stopped" },
        },
        {
          kind: "symptom",
          action: "add",
          source: "I stopped creatine because of a stomach upset",
          fields: { name: "Stomach upset" },
        },
      ],
    },
    {
      changes: [
        {
          kind: "result",
          action: "add",
          source: "my HbA1c at the clinic was 6.8 on 3 Oct",
          fields: {
            test: "HbA1c",
            value: "6.8",
            category: "lab",
            number: 6.8,
            unit: "%",
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
          source: "that's a measurement",
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
          source: "Undo that",
          from: { document: "0199a0f2-0000-7000-8000-0000000000d1", page: 2 },
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
          fix: {
            source: "the LDL is 132, not 142",
            fields: { value: "132", number: 132 },
          },
        },
      ],
    },
  ],
  run: async (input, { save, callId }) => {
    if (!save || callId === undefined) {
      throw new Refusal("Changes can be saved only in Rufi's own chat.");
    }
    try {
      const saved = await save(input, callId);
      const lines = saved.receipt.split("\n");
      const receipt =
        lines.length > RECEIPT_LINES
          ? `${lines.slice(0, RECEIPT_LINES).join("\n")}\n(${String(lines.length - RECEIPT_LINES)} more lines in Rufi's receipt in the chat)`
          : saved.receipt;
      return {
        ...(saved.receipt !== "" && { receipt }),
        changes: saved.changes,
        ...(saved.earlier.length > 0 && { already_saved: saved.earlier }),
        ...(!saved.fresh &&
          (saved.receipt === ""
            ? {
                note: "Every item was saved before, so nothing new was saved and Rufi added no receipt.",
              }
            : { note: "This call was already saved." })),
      };
    } catch (error) {
      if (error instanceof SaveRefused) {
        throw new Refusal(error.message, error.problems);
      }
      throw error;
    }
  },
});

export const dismissItems = defineTool({
  name: "dismiss_items",
  shown: "Set aside items from a document",
  description:
    "Dismisses draft items of the user's documents that the user doesn't want saved (a test that isn't theirs, a row read by mistake), after you said which items you would set aside and the user clearly said yes to that in this chat ('it isn't mine' alone is not a yes): each is never saved later, and Rufi adds a receipt line to the chat. Give each item's version as you read it with get_documents; one that changed since is refused, and nothing is dismissed. An item already dismissed stays so; a saved item can't be dismissed (remove its record with save_changes instead). Only in a message from the user, never in a turn a Rufi event started.",
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
      const done = await dismiss(input, callId);
      return {
        dismissed: done.dismissed,
        ...(done.already.length > 0 && { already_dismissed: done.already }),
        ...(done.fresh && { receipt: done.receipt }),
      };
    } catch (error) {
      if (error instanceof DismissRefused) {
        throw new Refusal(error.message, error.problems);
      }
      throw error;
    }
  },
});
