// The skills as shipped: each file names itself, and the words Rufi says the
// same everywhere stay the same in them.
import { describe, expect, it } from "vitest";
import { DELETED_DOCUMENT } from "../documents/delete.ts";
import { SKILLS } from "./skills.ts";

describe("Rufi's skills", () => {
  it("each has its folder's name, a description and a body", () => {
    expect(SKILLS.map((skill) => skill.name)).toEqual([
      "analysis",
      "changing-the-record",
      "documents",
      "follow-ups",
      "reading-the-record",
      "research",
      "results",
      "saving-a-document",
      "visit-brief",
    ]);
    for (const skill of SKILLS) {
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.text.split("\n---\n")[1]?.trim().length).toBeGreaterThan(0);
    }
  });

  it("tells the AI about a deleted document in the words Rufi uses everywhere", () => {
    const documents = SKILLS.find((skill) => skill.name === "documents");
    expect(documents?.text).toContain(DELETED_DOCUMENT);
  });
});
