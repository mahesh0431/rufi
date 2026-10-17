import { describe, expect, it } from "vitest";
import { type Flags, moodOf } from "./mood.ts";

// The rule as agreed, first line first: what is going on, and the face.
const RULE: [keyof Flags, string][] = [
  ["signedOut", "resting"],
  ["failed", "sorry"],
  ["needsYou", "question"],
  ["reading", "reading"],
  ["working", "thinking"],
  ["justDone", "done"],
  ["newNotice", "alert"],
  ["emptyChat", "hello"],
];

describe("the sidebar dog's face", () => {
  it("is calm when nothing is going on", () => {
    expect(moodOf({})).toBe("calm");
  });

  it("follows the first line of the rule that applies", () => {
    RULE.forEach(([flag, face], line) => {
      // This line and every later one apply at once: this line wins.
      const later = Object.fromEntries(
        RULE.slice(line).map(([other]) => [other, true]),
      );
      expect(moodOf(later), flag).toBe(face);
      // Alone, it sets the face too.
      expect(moodOf({ [flag]: true }), flag).toBe(face);
    });
  });
});
