// How the user likes replies reaches Rufi AI after Rufi's rules, never above them.
import { describe, expect, it } from "vitest";
import {
  coreInstructions,
  editSetting,
  instructionParts,
  REPLY_SETTINGS,
  toldOf,
} from "./instructions.ts";

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

    const visuals = own.parts.find((part) => part.id === "visual")?.text;
    expect(visuals).toBeDefined();
    kept.set(editSetting("visual", "visual"), "Never add visuals.");
    const edited = await told();
    expect(edited.instructions).toContain("Never add visuals.");
    expect(edited.instructions).not.toContain(visuals);
    expect(edited.parts.filter((part) => part.edited)).toEqual([
      { id: "visual", text: "Never add visuals.", edited: true },
    ]);
    // The others are as Rufi has them now.
    expect(edited.parts.filter((part) => !part.edited)).toEqual(
      own.parts.filter((part) => part.id !== "visual"),
    );

    kept.delete(editSetting("visual", "visual"));
    expect((await told()).instructions).toBe(own.instructions);
  });

  it("are the parts as shown, each told on its own: edited core and visual instructions both stay, and the line before the user's words is a part too", async () => {
    const kept = new Map<string, string>([
      [editSetting("core", "visual"), "My shorter core."],
      [editSetting("visual", "visual"), "- Draw only tables."],
      [REPLY_SETTINGS.words, "Use kg and cm."],
    ]);
    const now = await toldOf((key) => Promise.resolve(kept.get(key)));
    const instructions = coreInstructions(now.region, now.replies, now.edits);
    const parts = instructionParts(now);
    // Nothing is told that isn't shown, in the order shown.
    let from = 0;
    for (const { text } of parts) {
      const at = instructions.indexOf(text, from);
      expect(at).toBeGreaterThanOrEqual(from);
      from = at + text.length;
    }
    expect(
      instructions.length - parts.map((part) => part.text).join("").length,
    ).toBeLessThan(parts.length * 2);
    expect(instructions).toContain("My shorter core.");
    expect(instructions).toContain("- Draw only tables.");
  });
});
