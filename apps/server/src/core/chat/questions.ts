// Question cards (docs/adr/0036): Rufi AI asks the person with ask, giving
// words only, and Rufi draws the card. A click on an answer is the person's
// message through the normal send, quoting the card; the card is answered
// once that message went to Rufi AI. These are the card's words as text:
// the card for a screen that can't draw it, and the quote Rufi AI reads
// wherever it reads a message, so an answer always names its card.
import type { Chip, QuestionCard } from "@rufi/contracts";
import { literal } from "../record/kinds.ts";

/** Where Rufi AI finds a card again: read_chat with its id. */
export const questionLink = (id: string) => `rufi:/chat/questions/${id}`;

/**
 * The card as Markdown: its key, details, question and answers. Rufi AI's
 * key, question and answers are plain text, so each is literal here; its
 * details are Markdown as it gave them.
 */
export function cardText(card: QuestionCard): string {
  return [
    `**${literal(card.key)}**`,
    card.details,
    literal(card.question),
    card.answers.map((answer) => `- ${literal(answer)}`).join("\n"),
  ]
    .filter((part) => part !== undefined && part.trim() !== "")
    .join("\n\n");
}

/** A message's quote of a card: its key, linked to the card. */
export const quoteOf = (id: string, key: string) =>
  `> [${literal(key)}](${questionLink(id)})`;

/**
 * A message as Rufi AI reads it: the quote of each card it answers, then
 * the person's words.
 */
export function quoted(text: string, chips: readonly Chip[] | undefined) {
  const quotes = (chips ?? []).flatMap((chip) =>
    chip.ref.type === "question" ? [quoteOf(chip.ref.id, chip.label)] : [],
  );
  return [...quotes, text].filter((part) => part !== "").join("\n\n");
}

/**
 * A card as Rufi AI reads it back: its link, the card, and the answer a
 * click chose, by its message.
 */
export function cardForAi(
  id: string,
  card: QuestionCard,
  answer: { message: string; index: number } | undefined,
): string {
  const chosen = answer && card.answers[answer.index];
  return [
    `Your question card ${questionLink(id)}:`,
    cardText(card),
    chosen === undefined
      ? "Not answered by a click yet."
      : `Answered by a click: ${literal(chosen)} (message ${answer?.message ?? ""}).`,
  ].join("\n\n");
}

/**
 * A message's chips once its words are the person's own (an edit): a card's
 * quote stays, the answer a click chose doesn't.
 */
export const asTyped = (chips: readonly Chip[]): Chip[] =>
  chips.map((chip) =>
    chip.ref.type === "question" && chip.ref.answer !== undefined
      ? { ...chip, ref: { type: "question", id: chip.ref.id } }
      : chip,
  );
