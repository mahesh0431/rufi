import { describe, expect, it } from "vitest";
import { greeting, printedDate, printedTime } from "./dates.ts";

describe("dates", () => {
  it("prints a date at the precision known, and other text as it is", () => {
    expect(printedDate("2026-08-12")).toBe("12 Aug 2026");
    expect(printedDate("2026-09-01")).toBe("1 Sep 2026");
    expect(printedDate("2026-05")).toBe("May 2026");
    expect(printedDate("2026")).toBe("2026");
    expect(printedDate("2026-13")).toBe("2026-13");
    expect(printedDate("early 2025")).toBe("early 2025");
  });

  it("prints a time in this Mac's time zone, and other text as it is", () => {
    expect(printedTime(new Date(2026, 9, 4, 18, 5).toISOString())).toBe(
      "at 18:05 on 4 Oct 2026",
    );
    expect(printedTime("soon")).toBe("soon");
  });

  it("greets by the hour", () => {
    expect(greeting(new Date(2026, 9, 4, 9))).toBe("Good morning");
    expect(greeting(new Date(2026, 9, 4, 12))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 9, 4, 17))).toBe("Good evening");
  });
});
