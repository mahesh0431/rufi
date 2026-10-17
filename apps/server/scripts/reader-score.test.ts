import { describe, expect, it } from "vitest";
import { EXPECTED, KEY, type KeyPage } from "../tests/pack/copy-set.ts";
import { PRESCRIPTION } from "../tests/pack/reports.ts";
import {
  chooseItems,
  copyLines,
  scoreCopy,
  scoreItems,
  silent,
  tally,
  type Draft,
} from "./reader-score.ts";

const draft = (
  test: string,
  value: string,
  iso?: string,
  more: Partial<Draft["fields"]> = {},
): Draft => ({
  page: 1,
  fields: {
    test_name: test,
    value_text: value,
    ...(Number.isFinite(Number(value)) && { value_number: Number(value) }),
    ...(iso !== undefined && { date: { iso } }),
    ...more,
  },
  unsure: false,
});

describe("the reader pack's score", () => {
  it("counts a measurement's wrong date apart from its value: the collection date given to the visit's measurements, and a date given to one with none", () => {
    const score = scoreItems(PRESCRIPTION.key.items, [
      draft("Blood pressure", "130/85", "2026-10-01"),
      draft("Weight", "72", "2026-10-05"),
      draft("Height", "160", "2026-10-01"),
      // A lab value's own date isn't scored.
      draft("TSH", "4.8"),
    ]);
    expect(score).toEqual({
      correct: 4,
      missed: 0,
      wrongFlagged: 0,
      wrongSilent: 0,
      extra: 0,
      wrongItemDates: 2,
      wrong: [
        "p1 Blood pressure: date 2026-10-01 for 2026-10-05",
        "p1 Height: date 2026-10-01 for none",
      ],
    });
  });
  it("counts a value wrong when its number or comparator isn't the key's, also when its printed text is right", () => {
    const key = [
      { page: 1, test: "TSH", value: "4,6", number: 4.6 },
      {
        page: 1,
        test: "CRP",
        value: "<5",
        number: 5,
        comparator: "<" as const,
      },
      { page: 1, test: "Protein", value: "Trace", number: null },
      { page: 1, test: "pH", value: "6.0", number: 6 },
    ];
    const score = scoreItems(key, [
      draft("TSH", "4,6", undefined, { value_number: 46 }),
      draft("CRP", "<5", undefined, { value_number: 5 }),
      {
        ...draft("Protein", "Trace", undefined, { value_number: 1 }),
        unsure: true,
      },
      draft("pH", "6.0"),
    ]);
    expect(score).toMatchObject({
      correct: 1,
      wrongFlagged: 1,
      wrongSilent: 2,
      wrong: [
        "p1 TSH: number 46 for 4.6",
        "p1 CRP: comparator none for <",
        "p1 Protein: number 1 for none (unsure)",
      ],
    });
  });
});

describe("the reader pack's documents", () => {
  it("reads a document named with --only once, also when both sets have it", () => {
    const shared = { name: "prescription" };
    const dense = [{ name: "big_300_2_pages" }, shared];
    const pack = [{ name: "cbc" }, shared];
    expect(
      chooseItems(dense, pack, { only: ["prescription"], all: false }),
    ).toEqual([shared]);
    expect(chooseItems(dense, pack, { all: false })).toBe(dense);
    expect(chooseItems(dense, pack, { all: true })).toBe(pack);
  });
});

const page = (file: KeyPage["file"], n: number): KeyPage => {
  const found = KEY.find((p) => p.file === file && p.page === n);
  if (!found) throw new Error(`No page ${file} ${String(n)}`);
  return found;
};

/** A page's hand-checked copy with one piece changed. */
const edited = (key: KeyPage, from: string | RegExp, to: string) => {
  const there =
    typeof from === "string" ? key.hand.includes(from) : from.test(key.hand);
  if (!there) throw new Error(`No ${String(from)} in the copy`);
  return key.hand.replace(from, to);
};

/** Page 1 laid out as a Markdown table, as a reader may copy it. */
const MARKDOWN_PAGE_1 = [
  "Sunrise Labs",
  "Patient: Asha Fictional — Report No: SL-2231",
  "Age/Sex: 41 Y / F — Collected: 12 Jun 2026 08:10",
  "Reported: 13 Jun 2026 17:45",
  "| Test | Current | Previous | Unit | Reference Range |",
  "|---|---|---|---|---|",
  "| Glucose, Fasting | 104 H | 98 | mg/dL | 70-100 |",
  "| HbA1c | 6.8 H | 7.1 | % | 4.0 - 5.6 |",
  "| Creatinine | 0.92 | 0.88 | mg/dL | 0.60–1.10 |",
  "| CRP | \\<0.5 | 1.2 | mg/L | 0.0 – 5.0 |",
  "| Haemoglobin | 13.2 | 13.0 | g/dL | 12.0 – 15.5 |",
  "| Total Cholesterol | 212 H | 225 | mg/dL | <200 |",
  "| Triglycerides | 148 | 162 | mg/dL | <150 |",
  "| HDL Cholesterol | 48 | 45 | mg/dL | >40 |",
  "Previous: results of report SL-1874, collected 03 Mar 2026.",
  "Page 1 of 2",
].join("\n");

/** The photo's smudged glucose cell, as its hand-checked copy has it. */
const SMUDGED = "<b>1[?]4 H</b> [unclear: the middle digit is smudged]";

describe("the reader pack's score of a page copy", () => {
  it("scores every hand-checked copy whole but for its marked cells: each row found, nothing invented or doubled, the doubts marked", () => {
    for (const key of KEY) {
      const score = scoreCopy(key, key.hand);
      const where = `${key.file} page ${String(key.page)}`;
      expect(score.missed, where).toEqual([]);
      expect(score.duplicated, where).toEqual([]);
      expect(score.invented, where).toEqual([]);
      expect(silent(score), where).toBe(0);
      expect(
        score.doubts.map((d) => d.outcome),
        where,
      ).toEqual(key.doubts.map(() => "marked"));
    }
    // The hard parts are the only rows not copied as printed: they are marked.
    expect(scoreCopy(page("photo", 1), page("photo", 1).hand).changed).toEqual([
      { row: "Glucose, Fasting", wrong: [], marked: ["104", "H"] },
    ]);
    expect(scoreCopy(page("mixed", 2), page("mixed", 2).hand).changed).toEqual([
      { row: "TSH", wrong: [], marked: ["5.3", "H", "5.8"] },
    ]);
  });

  it("takes a page's layout as the copy gives it: a Markdown table for the HTML one, other spacing, no bold", () => {
    const score = scoreCopy(page("mixed", 1), MARKDOWN_PAGE_1);
    expect(score).toMatchObject({
      found: score.rows,
      missed: [],
      changed: [],
      duplicated: [],
      invented: [],
    });
  });

  it("finds a missed row, a changed digit, a lost comparator, an invented number and a row copied twice", () => {
    const key = page("mixed", 3);
    // The hand-checked copy may be padded by the formatter: edit by row.
    let copy = edited(key, "**11,6**", "**11,8**");
    copy = copy.replace(/^\| Ferritin .*\n/m, "");
    copy = copy.replace(/^(\| CRP\s*\|\s*)<0,5/m, "$10,5");
    copy = copy.replace(/^(\| TIBC .*\n)/m, "$1$1");
    const score = scoreCopy(key, copy);
    // Ferritin's name is still in the page's method line: that isn't its row.
    expect(score.missed).toEqual(["Ferritin"]);
    expect(score.changed).toEqual([
      { row: "Transferrin Saturation", wrong: ["11,6"], marked: [] },
      { row: "CRP", wrong: ["<0,5"], marked: [] },
    ]);
    expect(score.invented).toEqual(["11,8"]);
    expect(score.duplicated).toEqual(["TIBC"]);
    expect(silent(score)).toBe(3);
  });

  it.each([
    ["Current and Previous swapped", "<td><b>7.1 H</b></td><td>6.8</td>"],
    ["a minus sign added", "<td><b>-6.8 H</b></td><td>7.1</td>"],
    ["the comparator's side changed", "<td><b>6.8 H</b></td><td>&lt;7.1</td>"],
  ])(
    "finds a value in the wrong column or with another sign: %s",
    (_, cells) => {
      const key = page("mixed", 1);
      const score = scoreCopy(
        key,
        edited(key, "<td><b>6.8 H</b></td><td>7.1</td>", cells),
      );
      expect(score.found).toBe(score.rows - 1);
      expect(score.changed).toEqual([
        expect.objectContaining({ row: "HbA1c", marked: [] }),
      ]);
      expect(silent(score)).toBe(1);
    },
  );

  it("finds Current and Previous swapped in a Markdown table too", () => {
    const score = scoreCopy(
      page("mixed", 1),
      MARKDOWN_PAGE_1.replace(
        "| Glucose, Fasting | 104 H | 98 |",
        "| Glucose, Fasting | 98 | 104 H |",
      ),
    );
    expect(score.changed).toEqual([
      expect.objectContaining({ row: "Glucose, Fasting", marked: [] }),
    ]);
    expect(silent(score)).toBe(1);
  });

  it("counts a second row of a test that disagrees, beside a right one, as copied twice and changed", () => {
    const key = page("mixed", 1);
    const right =
      "<tr><td>HbA1c</td><td><b>6.8 H</b></td><td>7.1</td><td>%</td><td>4.0 – 5.6</td></tr>";
    const score = scoreCopy(
      key,
      edited(
        key,
        right,
        `${right}\n<tr><td>HbA1c</td><td><b>7.1 H</b></td><td>7.1</td><td>%</td><td>4.0 – 5.6</td></tr>`,
      ),
    );
    expect(score.duplicated).toEqual(["HbA1c"]);
    expect(score.changed).toEqual([
      { row: "HbA1c", wrong: ["6.8"], marked: [] },
    ]);
    expect(score.found).toBe(score.rows - 1);
    expect(silent(score)).toBe(1);
  });

  it("lets a mark excuse only its own cell: a Previous value changed beside a handwritten one is a silent change", () => {
    const key = page("mixed", 2);
    const score = scoreCopy(
      key,
      edited(key, /(\[handwritten: 5\.8\]\s*\|\s*)4\.9/, "$14.8"),
    );
    expect(score.changed).toEqual([
      { row: "TSH", wrong: ["4.9"], marked: ["5.3", "H", "5.8"] },
    ]);
    expect(score.invented).toEqual(["4.8"]);
    expect(silent(score)).toBe(2);
  });

  it("holds a value only whole: 6.8 isn't in 16.8 or 6.85", () => {
    const key = page("mixed", 1);
    for (const wrong of ["16.8 H", "6.85 H"]) {
      const score = scoreCopy(
        key,
        edited(key, "<td><b>6.8 H</b></td>", `<td>${wrong}</td>`),
      );
      expect(score.changed).toEqual([
        { row: "HbA1c", wrong: ["6.8"], marked: [] },
      ]);
    }
  });

  it.each([
    ["1[0?]4 H", "marked"],
    ["1?4 H", "marked"],
    ["184 H [unclear]", "marked"],
    ["104 H", "right, not marked"],
    ["184 H", "wrong, not marked"],
  ] as const)(
    "tells what a copy did with the smudged digit: %s is %s",
    (cell, outcome) => {
      const key = page("photo", 1);
      expect(scoreCopy(key, edited(key, SMUDGED, cell)).doubts).toEqual([
        {
          row: "Glucose, Fasting",
          outcome,
          line: expect.stringContaining(cell) as unknown,
        },
      ]);
    },
  );

  it("doesn't count a guess with its own mark as an invented number, but counts one with a mark on another cell", () => {
    const key = page("photo", 1);
    expect(
      scoreCopy(key, edited(key, SMUDGED, "184 H [unclear]")).invented,
    ).toEqual([]);
    const elsewhere = edited(key, SMUDGED, "184 H").replace(
      "<td>98</td>",
      "<td>98 [faint]</td>",
    );
    const score = scoreCopy(key, elsewhere);
    expect(score.invented).toEqual(["184"]);
    expect(score.doubts[0]?.outcome).toBe("wrong, not marked");
  });

  it.each([
    ["~~5.3 H~~ [handwritten: 5.8]", "marked"],
    ["<del>5.3 H</del> 5.8 [handwritten]", "marked"],
    ["5.3 H [crossed out] [handwritten: 5.8]", "marked"],
    ["5.3 H [handwritten: 5.8]", "marked, crossing-out not shown"],
    ["5.3 H 5.8", "right, not marked"],
  ] as const)(
    "tells whether a copy shows the crossed-out print: %s is %s",
    (cell, outcome) => {
      const key = page("mixed", 2);
      const copy = edited(key, "~~5.3 H~~ [handwritten: 5.8]", cell);
      expect(scoreCopy(key, copy).doubts[0]?.outcome).toBe(outcome);
    },
  );

  it("doesn't take a note outside a row as marking its cell, and counts a doubt missing without its row", () => {
    const key = page("photo", 1);
    const noted = `${edited(key, SMUDGED, "184 H")}\nNote: the fasting glucose value is smudged.`;
    expect(scoreCopy(key, noted).doubts[0]?.outcome).toBe("wrong, not marked");
    const without = edited(key, /<tr><td>Glucose, Fasting.*<\/tr>\n/, "");
    expect(scoreCopy(key, without).doubts).toEqual([
      { row: "Glucose, Fasting", outcome: "missing" },
    ]);
  });

  it("reads an HTML row over several lines as one line, with its entities", () => {
    expect(
      copyLines(
        "<table>\n<tr>\n  <td>CRP</td>\n  <td>&lt;0.5</td>\n</tr>\n</table>",
      ),
    ).toEqual(["CRP | <0.5 |"]);
  });
});

describe("the reader pack's totals of a set", () => {
  it("counts a page with no copy as all its rows missed", () => {
    const [first, second] = KEY;
    if (!first || !second) throw new Error("No pages");
    const totals = tally([
      { key: first, copy: first.hand },
      { key: second, copy: undefined },
    ]);
    expect(totals).toMatchObject({
      pages: 2,
      copied: 1,
      rows: first.rows.length + second.rows.length,
      found: first.rows.length,
      missed: second.rows.length,
      silent: 0,
    });
  });
});

describe("the copy set's expected drafts", () => {
  it("each holds its value as printed on its page's hand-checked copy, in its test's row, except where the copy marks it unclear", () => {
    for (const draft of EXPECTED.drafts) {
      const key = page(draft.file, draft.page);
      if (key.doubts.some((d) => d.row === draft.test && d.truth.length === 1))
        continue;
      const rows = copyLines(key.hand).filter((line) =>
        line.toLowerCase().includes(draft.test.toLowerCase()),
      );
      expect(
        rows.some((line) => line.includes(draft.value)),
        `${draft.file} page ${String(draft.page)} ${draft.test}`,
      ).toBe(true);
    }
  });

  it("puts every page of each file in exactly one expected document", () => {
    for (const file of ["mixed", "photo"] as const) {
      const pages = EXPECTED.documents
        .filter((d) => d.file === file)
        .flatMap((d) => d.pages)
        .sort((a, b) => a - b);
      expect(pages).toEqual(
        KEY.filter((p) => p.file === file).map((p) => p.page),
      );
    }
  });
});
