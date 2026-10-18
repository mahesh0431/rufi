import type { ResultRow } from "@rufi/contracts/record";
import { describe, expect, it } from "vitest";
import { drawTrend } from "./trend-drawing.ts";

const LARGE = { width: 640, height: 150 };

/** A fictional lab result. */
const result = (
  id: string,
  date: string | undefined,
  value: string,
  more: Partial<ResultRow> = {},
): ResultRow => ({
  kind: "result",
  id,
  test: "Ferritin",
  value,
  category: "lab",
  ...(Number.isFinite(Number(value)) && { number: Number(value) }),
  unit: "µg/L",
  ...(date !== undefined && { measured: { date } }),
  ...more,
});

const ferritin = [
  result("f1", "2025-10-12", "31", { range: "30 - 400" }),
  result("f2", "2026-03-04", "18", { range: "30 - 400", flag: "L" }),
  result("f3", "2026-09-01", "26", { range: "30 - 400", flag: "L" }),
];

describe("a ring", () => {
  it("marks each value the lab flagged, and only those: Rufi reads nothing from the range", () => {
    const ringed = (more: Partial<ResultRow>, value = "8") =>
      drawTrend(
        "Ferritin (µg/L)",
        [result("a", "2026-01-01", value, more)],
        LARGE,
      )?.lines[0]?.points[0]?.flagged;
    // The lab's own flag, as printed.
    expect(ringed({ range: "30 - 400", flag: "L" }, "18")).toBe(true);
    expect(ringed({ range: "<5,5", flag: "High" }, "5.3")).toBe(true);
    // No flag: no ring, whatever the range says.
    for (const range of ["30 - 400", "0 - 1,000", "<5", "see note"]) {
      expect(ringed({ range }, "18")).toBe(false);
    }
    expect(ringed({ comparator: "<", number: 5, range: "10 - 20" }, "<5")).toBe(
      false,
    );
    expect(ringed({})).toBe(false);
  });

  it("is drawn on each flagged value of a series, and the newest is filled", () => {
    const drawing = drawTrend("Ferritin (µg/L)", ferritin, LARGE);
    expect(drawing?.lines[0]?.points.map((point) => point.flagged)).toEqual([
      false,
      true,
      true,
    ]);
    expect(drawing?.lines[0]?.points.map((point) => point.last)).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe("the scale", () => {
  it("fits the values, so a wide range can't flatten the line; the range is written as printed", () => {
    const drawing = drawTrend("Ferritin (µg/L)", ferritin, LARGE);
    const ys = drawing?.lines[0]?.points.map((point) => point.y) ?? [];
    // The values use most of the plot's height (22 to 128), not a sliver of it.
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(50);
    expect(drawing?.range).toBe("Lab range 30 - 400");
    // A range in words is written as it came too.
    expect(
      drawTrend(
        "Ferritin (µg/L)",
        [result("f1", "2026-01-01", "31", { range: "see note" })],
        LARGE,
      )?.range,
    ).toBe("Lab range see note");
  });

  it("spaces time by date, oldest at the left", () => {
    const drawing = drawTrend("Ferritin (µg/L)", ferritin, LARGE);
    const xs = drawing?.lines[0]?.points.map((point) => point.x) ?? [];
    expect(xs[0]).toBe(44);
    expect(xs[2]).toBe(616);
    // 4 Mar is 143 of the 324 days from 12 Oct to 1 Sep.
    expect(xs[1]).toBeCloseTo(44 + (143 / 324) * 572, 0);
  });

  it("shows one value as a dot in the middle", () => {
    const drawing = drawTrend(
      "Vitamin D (ng/mL)",
      [result("v1", "2026-05", "22", { range: "30 - 100" })],
      LARGE,
    );
    expect(drawing?.lines).toHaveLength(1);
    expect(drawing?.lines[0]?.points).toEqual([
      expect.objectContaining({ x: 330, last: true, flagged: false }),
    ]);
    expect(drawing?.dates.map((date) => date.text)).toEqual(["May 2026"]);
  });

  it("leaves out values with no date or no number, and draws nothing without any", () => {
    const drawing = drawTrend(
      "Ferritin (µg/L)",
      [
        ...ferritin,
        result("f4", undefined, "40"),
        result("f5", "2026-10-01", "Haemolysed"),
      ],
      LARGE,
    );
    expect(drawing?.lines[0]?.points).toHaveLength(3);
    expect(
      drawTrend("Ferritin (µg/L)", [result("f4", undefined, "40")], LARGE),
    ).toBeUndefined();
  });

  it("draws a two-value result's second number as a second, dashed line", () => {
    const bp = (id: string, date: string, high: number, low: number) =>
      result(id, date, `${String(high)}/${String(low)}`, {
        test: "Blood pressure",
        category: "measurement",
        unit: "mmHg",
        number: high,
        second_number: low,
      });
    const drawing = drawTrend(
      "Blood pressure (mmHg)",
      [bp("b1", "2026-06-01", 126, 82), bp("b2", "2026-09-20", 118, 78)],
      LARGE,
    );
    expect(drawing?.lines.map((line) => line.second)).toEqual([false, true]);
    expect(drawing?.lines[1]?.points.map((point) => point.text)).toEqual([
      "82",
      "78",
    ]);
    expect(drawing?.said).toBe(
      "Blood pressure (mmHg) over time: 126/82 on 1 Jun 2026, 118/78 on 20 Sep 2026",
    );
  });
});

describe("for a screen reader", () => {
  it("says every value with its date, and the range as printed", () => {
    expect(drawTrend("Ferritin (µg/L)", ferritin, LARGE)?.said).toBe(
      "Ferritin (µg/L) over time: 31 on 12 Oct 2025, 18 on 4 Mar 2026, 26 on 1 Sep 2026. Lab range 30 - 400",
    );
  });
});

describe("a small trend", () => {
  it("has the rings, but no numbers, dates or range", () => {
    const drawing = drawTrend("Ferritin", ferritin, {
      width: 88,
      height: 22,
      mini: true,
    });
    expect(drawing?.dates).toEqual([]);
    expect(drawing?.range).toBeUndefined();
    expect(drawing?.lines[0]?.points.map((point) => point.labelled)).toEqual([
      false,
      false,
      false,
    ]);
    expect(drawing?.lines[0]?.points.map((point) => point.flagged)).toEqual([
      false,
      true,
      true,
    ]);
  });
});

describe("labels", () => {
  it("are written where they don't crowd: the newest always", () => {
    const weights = Array.from({ length: 12 }, (_, i) =>
      result(
        `w${String(i)}`,
        `2026-09-${String(i + 1).padStart(2, "0")}`,
        String(60 + i / 10),
        {
          test: "Weight",
          unit: "kg",
        },
      ),
    );
    const drawing = drawTrend("Weight (kg)", weights, LARGE);
    const points = drawing?.lines[0]?.points ?? [];
    const shown = points.filter((point) => point.labelled);
    expect(points.at(-1)?.labelled).toBe(true);
    shown.slice(1).forEach((point, i) => {
      expect(point.x - (shown[i]?.x ?? 0)).toBeGreaterThanOrEqual(30);
    });
    const dates = drawing?.dates ?? [];
    expect(dates.at(-1)?.text).toBe("12 Sep 2026");
    dates.slice(1).forEach((date, i) => {
      expect(date.x - (dates[i]?.x ?? 0)).toBeGreaterThanOrEqual(84);
    });
  });
});
