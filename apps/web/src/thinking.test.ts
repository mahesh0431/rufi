import { describe, expect, it } from "vitest";
import { latestHeading } from "./thinking.ts";

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
});
