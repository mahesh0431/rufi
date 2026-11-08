import { describe, expect, it } from "vitest";
import { finishedBlocks, paced, WordPace, wordsEnd } from "./reply-flow.ts";

describe("finishedBlocks", () => {
  it("shows nothing until the first block is whole", () => {
    expect(finishedBlocks("Your HbA1c was 6.1")).toBe("");
    expect(finishedBlocks("Your HbA1c was 6.1%.\n\n")).toBe("");
  });

  it("shows each block once the next one starts, never the one being written", () => {
    const text = "Your HbA1c was 6.1%.\n\n## What it means\n\nIt is a lit";
    expect(finishedBlocks(text)).toBe(
      "Your HbA1c was 6.1%.\n\n## What it means",
    );
  });

  it("holds a list or a table until it ends, as the parser reads them", () => {
    const list = "Two things:\n\n- fasting glucose\n- HbA1c\n\n";
    expect(finishedBlocks(list)).toBe("Two things:");
    expect(finishedBlocks(`${list}- lipids`)).toBe("Two things:");
    expect(finishedBlocks(`${list}Both are fine.`)).toBe(
      "Two things:\n\n- fasting glucose\n- HbA1c",
    );
    const table = "| Test | Value |\n| --- | --- |\n| HbA1c | 6.1% |\n";
    expect(finishedBlocks(`Lab:\n\n${table}`)).toBe("Lab:");
    expect(finishedBlocks(`Lab:\n\n${table}\nDone`)).toBe(
      `Lab:\n\n${table.trimEnd()}`,
    );
  });

  it("holds a visual, its blank lines too, until the block after it starts", () => {
    const visual = "```rufi-visual\n<div>\n\n<p>Chart</p>\n</div>\n```";
    expect(finishedBlocks(`Drawn:\n\n${visual.slice(0, 30)}`)).toBe("Drawn:");
    expect(finishedBlocks(`Drawn:\n\n${visual}`)).toBe("Drawn:");
    expect(finishedBlocks(`Drawn:\n\n${visual}\n\nAs you see`)).toBe(
      `Drawn:\n\n${visual}`,
    );
  });
});

describe("wordsEnd", () => {
  it("ends at the last whole word up to a point, never inside one", () => {
    const text = "Your **HbA1c** was 6.1%";
    expect(wordsEnd(text, 3)).toBe(0);
    expect(wordsEnd(text, 4)).toBe(4);
    expect(wordsEnd(text, 10)).toBe(4);
    // The pace is between characters.
    expect(wordsEnd(text, 14.7)).toBe(14);
    expect(wordsEnd(text, 14)).toBe(14);
    // The last word may still be growing: it waits for what follows it.
    expect(wordsEnd(text, text.length)).toBe(18);
    expect(wordsEnd(`${text} `, text.length + 1)).toBe(text.length);
  });

  it("takes a fence's opening line as one word, so a visual is never shown as code", () => {
    const text = "Drawn:\n\n```rufi-visual\n<div>";
    expect(text.slice(0, wordsEnd(text, 20))).toBe("Drawn:");
    expect(text.slice(0, wordsEnd(text, text.length))).toBe(
      "Drawn:\n\n```rufi-visual",
    );
  });
});

describe("paced", () => {
  it("shows a steady flow when little waits, and catches up in about a quarter second when much does", () => {
    // 10 characters waiting: the floor of one character every 5 ms.
    expect(paced(0, 10, 16)).toBeCloseTo(3.2);
    // 1000 waiting: a quarter of a second's worth goes in 16 ms.
    expect(paced(0, 1000, 16)).toBeCloseTo(64);
    expect(paced(5, 10, 1000)).toBe(10);
    expect(paced(10, 10, 16)).toBe(10);
  });
});

describe("WordPace", () => {
  it("keeps the words flowing when text comes faster than a frame, and catches up after", () => {
    // As the hook runs it: each new text steps at once, and cancels the
    // frame it asked for; here text comes every 8 ms.
    const pace = new WordPace();
    let text = "";
    const shown: number[] = [];
    for (let part = 0; part < 60; part++) {
      text += "word ";
      shown.push(pace.step(text, 8 * part));
    }
    expect(shown[0]).toBe(4);
    expect(shown[30]).toBeGreaterThan(shown[10] ?? 0);
    expect(shown[59]).toBeGreaterThan(shown[30] ?? 0);
    // At least one character every 5 ms.
    expect(shown[59]).toBeGreaterThanOrEqual((8 * 59) / 5 - 5);
    let now = 8 * 59;
    while (!pace.caughtUp(text)) pace.step(text, (now += 16));
    expect(pace.step(text, now)).toBe(text.length - 1);
  });
});
