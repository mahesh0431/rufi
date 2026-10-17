// The skills as shipped: each file names itself, and the words Rufi says the
// same everywhere stay the same in them.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

  it("gives analysis the brand package's paper, named in its SKILL.md, and no other skill a file", () => {
    const paper = readFileSync(
      createRequire(import.meta.url).resolve("@rufi/brand/paper.css"),
      "utf8",
    );
    for (const skill of SKILLS) {
      expect(skill.files).toEqual(
        skill.name === "analysis" ? { "paper.css": paper } : {},
      );
    }
    expect(SKILLS.find((skill) => skill.name === "analysis")?.text).toContain(
      "`paper.css`, beside this file",
    );
  });

  it("tells the AI about a deleted document in the words Rufi uses everywhere", () => {
    const documents = SKILLS.find((skill) => skill.name === "documents");
    expect(documents?.text).toContain(DELETED_DOCUMENT);
  });
});
