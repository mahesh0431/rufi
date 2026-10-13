import { describe, expect, it } from "vitest";
import { saysDraftNotSaved } from "./draft-reply.ts";

describe("a reply about a value only in a document's drafts", () => {
  it.each([
    "Your 2 June 2026 report has a **draft LDL cholesterol result of 109 mg/dL, flagged High**.",
    "There's no LDL result saved in your health record yet. The lotus-jun.pdf report shows LDL 109 mg/dL, as a draft.",
    "There's **no LDL cholesterol result saved in your health record** … The recently read lotus-jun.pdf results aren't saved in your record yet.",
    "The June report shows LDL 109 mg/dL, but its results aren't part of your health record until you save them.",
    "Your lotus-jun.pdf document has LDL 109 mg/dL; it hasn't been saved yet.",
  ])("passes when it says the document's value isn't saved: %s", (reply) => {
    expect(saysDraftNotSaved(reply)).toBe(true);
  });

  it.each([
    "I couldn't find an LDL cholesterol result in your saved health record, so I can't confirm your last LDL value.",
    "I couldn't find an LDL cholesterol result saved in your health record, so I can't tell you your last value.",
    "Your last LDL cholesterol was 109 mg/dL on 2 June 2026, from your report.",
  ])("fails when it answers from the saved record alone: %s", (reply) => {
    expect(saysDraftNotSaved(reply)).toBe(false);
  });
});
