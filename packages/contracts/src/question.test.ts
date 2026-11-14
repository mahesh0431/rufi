// A question card on the wire (docs/adr/0036): a screen draws a card whose
// kind it knows, and shows any other card's text, so a kind added later
// never stops an older screen from reading the chat.
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { QuestionCard, StreamLine } from "./index.ts";

const line = (card: unknown) => ({
  type: "update",
  revision: 7,
  entries: [
    {
      id: "q-1",
      seq: 5,
      turnId: null,
      kind: "question",
      text: "**Next visit**\n\nWhich day suits you?",
      activity: null,
      detail: null,
      status: null,
      createdAt: "2026-11-15T09:00:00.000Z",
      updatedAt: "2026-11-15T09:00:00.000Z",
      card,
    },
  ],
  turns: [],
});

describe("a question card on the wire", () => {
  it("reads with a kind a screen doesn't know, keeping its text; only a known kind reads as a card", () => {
    const later = {
      kind: "date",
      key: "Next visit",
      question: "Which day suits you?",
    };
    const read = Schema.decodeUnknownSync(StreamLine)(line(later));
    expect(read.type === "update" && read.entries[0]?.text).toBe(
      "**Next visit**\n\nWhich day suits you?",
    );
    expect(Schema.decodeUnknownOption(QuestionCard)(later)._tag).toBe("None");

    const choice = {
      kind: "choice",
      key: "Next visit",
      question: "Book Tuesday?",
      answers: ["Book", "Not now"],
    };
    const known = Schema.decodeUnknownSync(StreamLine)(line(choice));
    expect(
      known.type === "update" &&
        Schema.decodeUnknownSync(QuestionCard)(known.entries[0]?.card),
    ).toEqual(choice);
  });
});
