import { describe, expect, it } from "vitest";
import { emergencyFor, safetyInstructions } from "./safety.ts";

const NOT_SET = "also say that their region isn't set in Rufi";

describe("the emergency number", () => {
  it("is the local one for a region Rufi doesn't know, or none; the AI says the region isn't set", () => {
    for (const region of [undefined, "ZZ", "toString", "constructor"]) {
      expect(emergencyFor(region)).toBeUndefined();
      const told = safetyInstructions(region);
      expect(told).toContain("call their local emergency number now");
      expect(told).toContain(NOT_SET);
    }
  });

  it("is the region's own when it is set, with nothing about a missing region", () => {
    const told = safetyInstructions("IN");
    expect(told).toContain("call 112 (the emergency number in India) now");
    expect(told).not.toContain(NOT_SET);
  });
});
