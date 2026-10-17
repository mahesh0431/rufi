import { describe, expect, it } from "vitest";
import { type Flags, moodOf } from "./mood.ts";

// The rule as agreed, first line first: what is going on, and the face.
const RULE: [Flags, string][] = [
  [{ away: true }, "resting"],
  [{ failed: true }, "sorry"],
  [{ chosen: "found" }, "found"],
  [{ reading: true }, "reading"],
  [{ working: true }, "thinking"],
  [{ justDone: true }, "done"],
  [{ emptyChat: true }, "hello"],
];

describe("the sidebar dog's face", () => {
  it("is calm when nothing is going on", () => {
    expect(moodOf({})).toBe("calm");
  });

  it("follows the first line of the rule that applies", () => {
    RULE.forEach(([flags, face], line) => {
      // This line and every later one apply at once: this line wins.
      const later: Flags = Object.assign(
        {},
        ...RULE.slice(line).map(([f]) => f),
      ) as Flags;
      expect(moodOf(later), face).toBe(face);
      // Alone, it sets the face too.
      expect(moodOf(flags), face).toBe(face);
    });
  });
});
