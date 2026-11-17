// Which of Rufi AI's question cards (docs/adr/0036) is open, and the sends
// that answer one. A card isn't drawn in the chat: the open one is the
// question panel in the box's place (question.tsx), and a message's quote
// opens its card read-only (QuestionSheet).
import { type Entry, QuestionCard as Card } from "@rufi/contracts";
import { Option, Schema } from "effect";
import { useLayoutEffect } from "react";
import { create } from "zustand/react";
import type { StoreApi } from "zustand/vanilla";
import { boxFor } from "./boxes.ts";
import type { Live } from "./live.ts";

/** The card, when its kind is one Rufi draws; else the chat shows its text. */
export const cardOf = (entry: Entry): Card | undefined =>
  entry.kind === "question"
    ? Option.getOrUndefined(Schema.decodeUnknownOption(Card)(entry.card))
    : undefined;

/**
 * The open question: the newest card in the chat, when no message of the
 * person's came after it and none waits in the queue quoting it.
 */
export function openCardOf(state: Live): string | undefined {
  for (let at = state.order.length - 1; at >= 0; at--) {
    const entry = state.entries[state.order[at] ?? ""];
    if (!entry) continue;
    if (entry.kind === "message" || entry.kind === "steer") return undefined;
    if (entry.kind !== "question") continue;
    if (!cardOf(entry)) return undefined;
    const waiting = state.queue.items.some((item) =>
      item.refs.some(
        ({ ref }) => ref.type === "question" && ref.id === entry.id,
      ),
    );
    return waiting ? undefined : entry.id;
  }
  return undefined;
}

/**
 * Keeps the box's card sends in step with the chat, while the chat shows:
 * a send whose message the chat has (an entry, or a queue row in any state)
 * is settled, and its card follows the chat from then on.
 */
export function useCardSends(live: StoreApi<Live>, personId: string) {
  useLayoutEffect(() => {
    const box = boxFor(personId);
    const update = () => {
      const { entries, queue } = live.getState();
      box.settle(
        (id) => id in entries || queue.items.some((item) => item.id === id),
      );
    };
    update();
    const stops = [live.subscribe(update), box.store.subscribe(update)];
    return () => {
      for (const stop of stops) stop();
    };
  }, [live, personId]);
}

/**
 * The card a message's quote opened, read-only: the person's, the card,
 * and the answer that message chose, if a click sent it.
 */
export const useQuestionSheet = create<{
  personId: string;
  card: string;
  answer: number | undefined;
} | null>(() => null);

export const openQuestion = (
  personId: string,
  card: string,
  answer: number | undefined,
) => {
  useQuestionSheet.setState({ personId, card, answer }, true);
};
