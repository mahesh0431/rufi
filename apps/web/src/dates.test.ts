import { afterAll, describe, expect, it } from "vitest";
import { dayLine, printedDate, printedTime } from "./dates.ts";

// The Mac is in India here: its days start 5½ hours before UTC's.
const TZ = process.env["TZ"];
process.env["TZ"] = "Asia/Kolkata";
afterAll(() => {
  if (TZ === undefined) delete process.env["TZ"];
  else process.env["TZ"] = TZ;
});

describe("dates", () => {
  it("prints a date at the precision known, and other text as it is", () => {
    expect(printedDate("2026-08-12")).toBe("12 Aug 2026");
    expect(printedDate("2026-09-01")).toBe("1 Sep 2026");
    expect(printedDate("2026-05")).toBe("May 2026");
    expect(printedDate("2026")).toBe("2026");
    // A time is the Mac's local time as stored: never moved through UTC.
    expect(printedDate("2026-05-20T08:30")).toBe("20 May 2026 08:30");
    expect(printedDate("2026-13")).toBe("2026-13");
    expect(printedDate("early 2025")).toBe("early 2025");
  });

  it("prints a time in this Mac's time zone, and other text as it is", () => {
    expect(printedTime(new Date(2026, 9, 4, 18, 5).toISOString())).toBe(
      "at 18:05 on 4 Oct 2026",
    );
    expect(printedTime("soon")).toBe("soon");
  });

  it("names the chat's days in this Mac's time zone: Today, Yesterday, then the date", () => {
    const now = new Date("2026-10-08T10:00:00+05:30");
    // Still 7 Oct in UTC, but today on this Mac.
    expect(dayLine("2026-10-07T19:00:00Z", now)).toBe("Today");
    expect(dayLine("2026-10-07T23:59:00+05:30", now)).toBe("Yesterday");
    expect(dayLine("2026-10-01T12:00:00+05:30", now)).toBe("Thu 1 Oct");
    expect(dayLine("2025-12-31T12:00:00+05:30", now)).toBe("Wed 31 Dec 2025");
    expect(
      dayLine(
        "2025-12-31T12:00:00+05:30",
        new Date("2026-01-01T08:00:00+05:30"),
      ),
    ).toBe("Yesterday");
  });
});
