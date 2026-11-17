// A public route in Settings › iPhone says once what being public means: its
// line, Mahesh's words, is never left empty.
import { describe, expect, it } from "vitest";
import { PUBLIC_LINE } from "./public-line.ts";

describe("Settings › iPhone", () => {
  it.each(Object.entries(PUBLIC_LINE))(
    "says once what it means that %s is public",
    (_route, line) => {
      expect(line.trim()).not.toBe("");
    },
  );
});
