import { describe, expect, it } from "vitest";
import { splitBasis } from "./basis.ts";

const FENCE = "```";
const block = (how: string, tag = "rufi-basis") =>
  `${FENCE}${tag}\n${how}\n${FENCE}`;

describe("splitting a reply into its answer and How", () => {
  it("takes the closing rufi-basis block out of the answer as How", () => {
    expect(
      splitBasis(
        `Your last HbA1c was **6.8 %**.\n\n${block("From your record, read now.")}\n`,
        true,
      ),
    ).toEqual({
      answer: "Your last HbA1c was **6.8 %**.",
      how: "From your record, read now.",
    });
  });

  it("takes every rufi-basis block out, wherever it is; the last one is How", () => {
    const text = [
      "First part.",
      block("An early note."),
      "- a list item\n\n  " +
        block("Nested in the list.").replaceAll("\n", "\n  "),
      "Text after the blocks.",
      block("The last one."),
    ].join("\n\n");
    const { answer, how } = splitBasis(text, true);
    expect(how).toBe("The last one.");
    expect(answer).not.toContain("rufi-basis");
    expect(answer).not.toContain("note");
    expect(answer).toContain("Text after the blocks.");
    expect(answer).toContain("- a list item");
  });

  it("leaves other code blocks in the answer, also ones with a longer tag", () => {
    const text = [
      "Answer.",
      block("print(1)", "python"),
      block("Not How.", "rufi-basis-draft"),
      block("Nor this.", "rufi-basis extra"),
    ].join("\n\n");
    expect(splitBasis(text, true)).toEqual({ answer: text, how: undefined });
  });

  it("keeps a reply with no block as it is", () => {
    expect(splitBasis("Thanks, glad it helped!", true)).toEqual({
      answer: "Thanks, glad it helped!",
      how: undefined,
    });
  });

  it("takes an unclosed last block as How when the reply finished", () => {
    expect(
      splitBasis(`Answer.\n\n${FENCE}rufi-basis\nGeneral knowledge.`, true),
    ).toEqual({ answer: "Answer.", how: "General knowledge." });
  });

  it("shows no half block in a reply that hasn't finished, wherever it was cut", () => {
    const answer = "Your last HbA1c was 6.8 %.";
    for (const cut of [
      `${FENCE}rufi-basis\nFrom your rec`,
      `${FENCE}rufi-basis`,
      `${FENCE}rufi-ba`,
      FENCE,
      "``",
      "`",
      "~~~rufi",
    ]) {
      expect(splitBasis(`${answer}\n\n${cut}`, false).answer).toBe(answer);
    }
  });

  it("shows no half block or empty marker in a quote or a list, finished or not", () => {
    const answer = "Your last HbA1c was 6.8 %.";
    for (const [cut, finished] of [
      [`> ${FENCE}rufi-ba`, false],
      [`- ${FENCE}rufi-basis`, false],
      [`1. ${FENCE}`, false],
      [`> - ${FENCE}rufi`, false],
      [`> ${FENCE}rufi-basis\n> From your rec`, false],
      [`- ${FENCE}rufi-basis\n  From your rec`, false],
      [`> ${FENCE}rufi-basis\n> From your record.\n> ${FENCE}`, true],
      [`1. ${FENCE}rufi-basis\n   From your record.\n   ${FENCE}`, true],
    ] as const) {
      expect(splitBasis(`${answer}\n\n${cut}`, finished).answer).toBe(answer);
    }
  });

  it("keeps a rule or a list before the block", () => {
    for (const answer of [
      "- one\n- two\n\n---",
      "Answer.\n\n* * *",
      "Answer.\n\n- - -",
      "Answer.\n\n***",
      "Answer.\n\n> * * *",
    ]) {
      expect(splitBasis(`${answer}\n\n${block("How.")}`, true).answer).toBe(
        answer,
      );
    }
  });

  it("keeps a line that only looks like a fence once the reply finished", () => {
    expect(splitBasis("Answer.\n\n``", true).answer).toBe("Answer.\n\n``");
  });

  it("keeps an unfinished reply's own code block", () => {
    const text = `Answer.\n\n${FENCE}python\nprint(1)`;
    expect(splitBasis(text, false).answer).toBe(text);
  });
});
