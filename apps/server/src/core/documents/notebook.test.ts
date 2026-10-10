// Rufi's checks of a reader's page entry: they flag a row count that
// differs from the items, a number that isn't its printed value, and a
// printed value missing from the PDF page's own text. They never change
// the entry.
import { describe, expect, it } from "vitest";
import { check, type Entry } from "./notebook.ts";

const entry = (
  items: { value_text: string; value_number?: number }[],
  rows_seen?: number,
): Entry => ({
  outcome: "read",
  ...(rows_seen !== undefined && { rows_seen }),
  items: items.map((item) => ({ test_name: "Fictional test", ...item })),
});

describe("the checks of a saved page", () => {
  it.each([
    ["4,6", 4.6],
    ["1,200", 1200],
    ["1.20", 1.2],
    ["<5", 5],
    ["13.2 H", 13.2],
    ["-2.1", -2.1],
  ])("takes %s as the number %d", (value_text, value_number) => {
    expect(check(entry([{ value_text, value_number }]), undefined)).toEqual({
      items: [],
    });
  });

  it("flags a number that isn't its printed value, and a value that has none", () => {
    expect(
      check(
        entry([
          { value_text: "4,6", value_number: 46 },
          { value_text: "Negative", value_number: 0 },
        ]),
        undefined,
      ).items,
    ).toEqual([
      { item: 1, why: `its number 46 isn't the printed value "4,6"` },
      { item: 2, why: `its number 0 isn't the printed value "Negative"` },
    ]);
  });

  it("flags a value missing from the page's own text, ignoring case and spacing", () => {
    const text = "Haemoglobin 13.2 g/dL\nCRP < 5 mg/L\nHIV NEGATIVE";
    expect(
      check(
        entry([
          { value_text: "13.2" },
          { value_text: "<5" },
          { value_text: "Negative" },
          { value_text: "13.8" },
        ]),
        text,
      ).items,
    ).toEqual([{ item: 4, why: `"13.8" isn't in the page's own text` }]);
    // A scan or a photo has no text to compare with.
    expect(check(entry([{ value_text: "13.8" }]), undefined).items).toEqual([]);
  });

  it("flags a page whose row count differs from its items; a row's earlier result isn't a row", () => {
    expect(check(entry([{ value_text: "1" }], 2), undefined)).toEqual({
      incomplete: { rows_seen: 2, items: 1 },
      items: [],
    });
    const withEarlier: Entry = {
      outcome: "read",
      rows_seen: 1,
      items: [
        { test_name: "TSH", value_text: "1.18" },
        { test_name: "TSH", value_text: "3.28", column: "earlier" },
      ],
    };
    expect(check(withEarlier, undefined)).toEqual({ items: [] });
  });
});
