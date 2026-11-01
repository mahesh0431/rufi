// How the user likes replies reaches Rufi AI after Rufi's rules, never above them.
import { describe, expect, it } from "vitest";
import { coreInstructions } from "./instructions.ts";

describe("Rufi AI's instructions", () => {
  it("end with the reply style the user chose, then their own words, after all of Rufi's rules; blank words add nothing", () => {
    const simple = coreInstructions("IN", { style: "simple", words: "" });
    expect(coreInstructions("IN", { style: "visual", words: "" })).not.toBe(
      simple,
    );
    const words = "Explain medical words simply.\nUse kg and cm.";
    const wished = coreInstructions("IN", { style: "simple", words });
    // Everything Rufi says comes first, unchanged; their words only follow.
    expect(wished.startsWith(simple)).toBe(true);
    expect(wished.slice(simple.length)).toContain(words);
    expect(coreInstructions("IN", { style: "simple", words: " \n " })).toBe(
      simple,
    );
  });
});
