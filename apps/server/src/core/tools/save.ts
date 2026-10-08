// save_changes: the one way the AI changes the record, after the user said
// yes in Rufi's chat (docs/adr/0005). Only Rufi's own chat can save.
import { Changes, CHANGES_MAX, SaveRefused } from "../record/save.ts";
import { defineTool, Refusal } from "./registry.ts";

export const saveChanges = defineTool({
  name: "save_changes",
  shown: "Save to your record",
  description: `Saves changes to the active person's record, all or nothing, after the user clearly said yes to exactly these changes in this chat. Each change is one record: add one, change the fields given (the rest stay as they are), remove one (it stays in history) or restore a removed one; ids come from get_overview. Give only what the user said: a field they didn't give stays out, and a date needs their own words from the source message. source is the user's own words the change rests on, copied from their message. At most ${String(CHANGES_MAX)} changes. Rufi refuses a save with any problem and says each one; nothing is saved then. On success Rufi adds its own receipt to the chat and returns it; the same call again returns the same receipt. Never say something was saved without this tool's answer.`,
  input: Changes,
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
  ],
  run: async (input, { save, callId }) => {
    if (!save || callId === undefined) {
      throw new Refusal("Changes can be saved only in Rufi's own chat.");
    }
    try {
      const saved = await save(input.changes, callId);
      return {
        receipt: saved.receipt,
        changes: saved.changes,
        ...(!saved.fresh && { note: "This call was already saved." }),
      };
    } catch (error) {
      if (error instanceof SaveRefused) {
        throw new Refusal(error.message, error.problems);
      }
      throw error;
    }
  },
});
