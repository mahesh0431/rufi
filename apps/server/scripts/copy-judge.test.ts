import { describe, expect, it } from "vitest";
import { EXPECTED, KEY, type KeyPage } from "../tests/pack/copy-set.ts";
import { readAnswer, tally, type Answer } from "./copy-judge.ts";

const page = (file: KeyPage["file"], n: number): KeyPage => {
  const found = KEY.find((p) => p.file === file && p.page === n);
  if (!found) throw new Error(`No page ${file} ${String(n)}`);
  return found;
};

/** An answer giving every row of `key` the same verdict, but for `but`. */
const answer = (
  key: KeyPage,
  but: Answer["rows"] = [],
  notInKey: Answer["not_in_key"] = [],
): Answer => ({
  rows: [
    ...key.rows
      .map((_, i) => ({ row: i + 1, verdict: "same" as const }))
      .filter((r) => !but.some((b) => b.row === r.row)),
    ...but,
  ],
  not_in_key: notInKey,
});

describe("the reader pack's reading of the judge's answer", () => {
  it("gives each row of the key its verdict, in the key's order, whatever order the judge gave them in", () => {
    const key = page("mixed", 3);
    const judged = readAnswer(
      key,
      answer(key, [
        { row: 2, verdict: "changed silently", why: "the name differs" },
      ]),
    );
    expect(judged.rows.map((r) => r.label)).toEqual(
      key.rows.map((r) => r.label),
    );
    expect(judged.rows[1]).toEqual({
      label: key.rows[1]?.label,
      verdict: "changed silently",
      why: "the name differs",
    });
  });

  it("makes a row unsure when the judge gave it no verdict, or verdicts that differ, and leaves out a row past the key", () => {
    const key = page("mixed", 4);
    const judged = readAnswer(key, {
      rows: [
        ...answer(key).rows.filter((r) => r.row !== 1),
        { row: 2, verdict: "changed silently", why: "a second copy differs" },
        { row: 99, verdict: "same" },
      ],
      not_in_key: [],
    });
    expect(judged.rows).toHaveLength(key.rows.length);
    expect(judged.rows[0]).toMatchObject({ verdict: "unsure" });
    expect(judged.rows[1]).toMatchObject({ verdict: "unsure" });
    expect(judged.rows[1]?.why).toContain("a second copy differs");
    expect(judged.rows.slice(2).every((r) => r.verdict === "same")).toBe(true);
  });
});

describe("the reader pack's totals of a set", () => {
  it("counts each verdict, and values not in the key as silent errors beside the rows changed silently", () => {
    const key = page("mixed", 1);
    const judged = readAnswer(
      key,
      answer(
        key,
        [
          { row: 6, verdict: "changed and marked", why: "smudge marked" },
          {
            row: 7,
            verdict: "changed silently",
            why: "Current and Previous swapped",
          },
          { row: 8, verdict: "missing" },
          { row: 9, verdict: "unsure", why: "can't tell the column" },
        ],
        [{ value: "999", where: "TSH Current" }],
      ),
    );
    expect(tally([{ key, copy: "a copy", judged }])).toEqual({
      pages: 1,
      copied: 1,
      rows: key.rows.length,
      same: key.rows.length - 4,
      changedMarked: 1,
      changedSilently: 1,
      missed: 1,
      unsure: 1,
      notInKey: 1,
      silent: 2,
    });
  });

  it("counts a page with no copy as all its rows missed, and a copy with no verdicts as all its rows unsure", () => {
    const [first, second, third] = KEY;
    if (!first || !second || !third) throw new Error("No pages");
    const totals = tally([
      {
        key: first,
        copy: first.hand,
        judged: readAnswer(first, answer(first)),
      },
      { key: second, copy: undefined },
      { key: third, copy: third.hand, judged: { failed: "no verdicts" } },
    ]);
    expect(totals).toMatchObject({
      pages: 3,
      copied: 2,
      rows: first.rows.length + second.rows.length + third.rows.length,
      same: first.rows.length,
      missed: second.rows.length,
      unsure: third.rows.length,
      silent: 0,
    });
  });
});

describe("the copy set", () => {
  it("has each expected draft's value among its test's cells on its page's key", () => {
    for (const draft of EXPECTED.drafts) {
      const row = page(draft.file, draft.page).rows.find(
        (r) => r.label === draft.test,
      );
      expect(
        row?.cells.some(
          (c) => c === draft.value || c.startsWith(`${draft.value} `),
        ),
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
