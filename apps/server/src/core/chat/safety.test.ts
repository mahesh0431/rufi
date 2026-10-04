import { describe, expect, it } from "vitest";
import { emergencyFor, safetyInstructions } from "./safety.ts";

describe("the emergency number", () => {
  it("is the local one for a region Rufi doesn't know, or none", () => {
    for (const region of [undefined, "ZZ", "toString", "constructor"]) {
      expect(emergencyFor(region)).toBeUndefined();
      expect(safetyInstructions(region)).toContain(
        "call their local emergency number now",
      );
    }
  });
});
