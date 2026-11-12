// The public routes' line in Settings › iPhone is Mahesh's to write. Until
// he has, this fails, so the route can't ship without it.
import { describe, expect, it } from "vitest";
import { PUBLIC_LINE } from "./public-line.ts";

describe("Settings › iPhone", () => {
  it.each(Object.entries(PUBLIC_LINE))(
    "says once what it means that %s is public: Mahesh's words are written",
    (_route, line) => {
      expect(line.trim()).not.toBe("");
    },
  );
});
