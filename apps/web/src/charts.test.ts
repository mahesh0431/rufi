import { _adapters } from "chart.js";
import { expect, test } from "vitest";
import "./charts.ts";

test("a time axis's step always moves on, even by a fraction of a whole unit", () => {
  const adapter = new _adapters._date();
  const start = new Date(2025, 2, 1).getTime();
  // Half a day: a whole day on; half a millisecond: one.
  expect(adapter.add(start, 0.5, "day")).toBe(new Date(2025, 2, 2).getTime());
  expect(adapter.add(start, 0.5, "millisecond")).toBe(start + 1);
  // Whole steps are as date-fns adds them.
  expect(adapter.add(start, 2, "month")).toBe(new Date(2025, 4, 1).getTime());
});
