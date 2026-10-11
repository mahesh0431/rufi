import { describe, expect, it } from "vitest";
import { latestHeading, thoughtFor } from "./thinking.ts";

describe("the AI's thinking", () => {
  it("shows the latest heading of the summary, else its first line", () => {
    expect(latestHeading("")).toBe("");
    expect(latestHeading("**Reading the record**")).toBe("Reading the record");
    // A heading half streamed already shows.
    expect(
      latestHeading("**Reading the record**\n\nI read it.\n\n**Comp"),
    ).toBe("Comp");
    // The body under a heading keeps the heading.
    expect(
      latestHeading("**Reading the record**\n\nI read it.\nThen more."),
    ).toBe("Reading the record");
    expect(latestHeading("The user asks about Asha.\nShe is 34.")).toBe(
      "The user asks about Asha.",
    );
  });

  it("says how long it thought, from its start to its end", () => {
    const at = (s: number) =>
      new Date(Date.UTC(2026, 9, 11, 8, 0, s)).toISOString();
    expect(thoughtFor(at(0), at(0))).toBe("Thought briefly");
    expect(thoughtFor(at(0), at(8))).toBe("Thought for 8 s");
    expect(thoughtFor(at(0), at(59))).toBe("Thought for 59 s");
    expect(thoughtFor(at(0), at(60))).toBe("Thought for 1 min");
    expect(thoughtFor(at(0), at(125))).toBe("Thought for 2 min 5 s");
  });
});
