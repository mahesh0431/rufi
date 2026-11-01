// How the user likes replies reaches Rufi AI after Rufi's rules, never above them.
import { describe, expect, it } from "vitest";
import {
  coreInstructions,
  editSetting,
  instructionParts,
  toldOf,
} from "./instructions.ts";
import { REPLY_PARTS } from "./replies.ts";

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

  it("take the user's edit of a part from the next reply on; a part not edited, and a part put back, are Rufi's own", async () => {
    const kept = new Map<string, string>([["emergency_region", "IN"]]);
    const told = async () => {
      const now = await toldOf((key) => Promise.resolve(kept.get(key)));
      return {
        instructions: coreInstructions(now.region, now.replies, now.edits),
        parts: instructionParts(now),
      };
    };
    const own = await told();

    kept.set(editSetting("replyRules", "visual"), "- Answer in French.");
    const edited = await told();
    expect(edited.instructions).toContain("- Answer in French.");
    expect(edited.instructions).not.toContain(REPLY_PARTS.replyRules);
    expect(edited.parts.filter((part) => part.edited)).toEqual([
      { id: "replyRules", text: "- Answer in French.", edited: true },
    ]);
    // The others are as Rufi has them now.
    expect(edited.parts.filter((part) => !part.edited)).toEqual(
      own.parts.filter((part) => part.id !== "replyRules"),
    );

    kept.delete(editSetting("replyRules", "visual"));
    expect((await told()).instructions).toBe(own.instructions);
  });
});
