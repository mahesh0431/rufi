// create_brief: saves a visit brief the AI wrote from the saved record, in
// Rufi's own chat (docs/help/visit-brief.md).
import { BriefInput, BriefRefused, type Made } from "../briefs/briefs.ts";
import { defineTool, Refusal } from "./registry.ts";

/** What create_brief answers for a brief. */
export const briefResult = (made: Made) => ({
  brief: made.line,
  ...(!made.fresh && { note: "This call already made this brief." }),
});

export const createBrief = defineTool({
  name: "create_brief",
  description:
    "Saves a visit brief for the active person: a dated page Rufi shows with a Copy button, and a line in this chat that opens it. Before you read the record for the brief, take record_version from get_overview, and give it here unchanged. Write the brief from saved records only, and give in cited every record its facts come from (kind and id, at least one); Rufi lists them under the brief as its Sources. Name the facts in plain words in the brief: no ids, footnotes or citation marks. Rufi refuses a record that wasn't saved in this person's record at record_version, or was removed then; nothing is made then. The same call again returns the same brief. The brief never changes once made; for a changed record, make a new one.",
  input: BriefInput,
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [
    {
      markdown:
        "## For the visit on Friday 16 Oct\n\n### Current medicines\n- Metformin 500 mg, twice a day\n\n### Recent results\n- HbA1c 6.8 % (lab range 4.0 - 5.6, marked High), 12 Aug 2026\n\n### Questions to ask\n- Question: Is the HbA1c a reason to change the Metformin?",
      record_version: 3,
      cited: [
        { kind: "medicine_use", id: "0199a0f2-7c1e-7d3a-9b1e-3f5c2a1d4e6f" },
        { kind: "result", id: "0199a0f2-8a41-7b2c-8e0d-6c4b1f9a2e3d" },
      ],
    },
  ],
  run: async (input, { brief, callId }) => {
    if (!brief || callId === undefined) {
      throw new Refusal("A brief can be made only in Rufi's own chat.");
    }
    try {
      return briefResult(await brief(input, callId));
    } catch (error) {
      if (error instanceof BriefRefused) {
        throw new Refusal(error.message, error.problems);
      }
      throw error;
    }
  },
});
