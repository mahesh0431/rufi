// A question card Rufi AI asked with (docs/adr/0036), as Rufi draws it: its
// key, the details naming what you approve, the question and its answers,
// and Reply. A click on an answer is your message, quoting the card, sent as
// Enter in the box would while a reply runs; the box's words stay. The card
// then shows the answer on its way (Sending, Waiting in the queue, Not sent
// with Retry when its answer was lost) and, once it went to Rufi AI, the
// answer it chose, with no buttons. Reply puts the card's quote in the box,
// for your own words; it answers nothing. To change your mind, you type.
import type { Entry, QueueItem } from "@rufi/contracts";
import {
  Check,
  Hourglass,
  LoaderCircle,
  MessageCircleQuestionMark,
  Reply,
  RotateCw,
} from "lucide-react";
import { type ReactNode, useEffect, useId } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { boxFor } from "./boxes.ts";
import type { Live } from "./live.ts";
import { askRufi } from "./panel.ts";
import { useSettings } from "./reads.ts";
import { Button, buttonLook } from "./ui.tsx";

/** A waiting message's click on this card: the answer it chose. */
const clickOn = (item: QueueItem, card: string) =>
  item.refs.find(
    ({ ref }) =>
      ref.type === "question" && ref.id === card && ref.answer !== undefined,
  )?.ref;

export function QuestionCard({
  entry,
  live,
  personId,
  details,
}: {
  entry: Entry;
  live: StoreApi<Live>;
  personId: string;
  /** The card's details, drawn as the chat draws Markdown. */
  details: ReactNode;
}) {
  const box = boxFor(personId);
  const send = useStore(box.store, (state) => state.cards[entry.id]);
  const waiting = useStore(live, (state) => {
    for (const item of state.queue.items) {
      const ref = clickOn(item, entry.id);
      if (ref?.type === "question") return ref.answer;
    }
    return undefined;
  });
  const kind = useSettings().data?.whileReplying ?? "steer";
  const key = useId();
  // Once the chat shows the click, the card follows the chat.
  useEffect(() => {
    if (entry.answer !== undefined || waiting !== undefined) {
      box.shown(entry.id);
    }
  }, [box, entry.id, entry.answer, waiting, send?.status]);

  const card = entry.card;
  if (!card) return null;
  const words = (index: number) => card.answers[index] ?? "";
  // The stored answer first, then the click on its way, else open.
  const state: { icon?: typeof Check; text: string; spin?: true } | null =
    entry.answer !== undefined
      ? { icon: Check, text: words(entry.answer.index) }
      : waiting !== undefined
        ? { icon: Hourglass, text: `${words(waiting)} · Waiting` }
        : send?.status === "sending" || send?.status === "sent"
          ? {
              icon: LoaderCircle,
              text: `${words(send.index)} · Sending`,
              spin: true,
            }
          : send?.status === "lost"
            ? { text: `${words(send.index)} · Not sent` }
            : null;

  return (
    <section
      data-entry={entry.id}
      tabIndex={-1}
      aria-labelledby={key}
      className="flex flex-col gap-2 rounded-xl border border-line bg-surface px-3.5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <h3
        id={key}
        className="flex items-center gap-1.5 text-xs font-medium text-muted"
      >
        <MessageCircleQuestionMark size={14} className="shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{card.key}</span>
      </h3>
      {card.details !== undefined && card.details.trim() !== "" && (
        <div className="card-details min-w-0 break-words">{details}</div>
      )}
      <p className="font-medium break-words">{card.question}</p>
      <div className="flex flex-wrap items-center gap-2">
        {state === null ? (
          card.answers.map((answer, index) => (
            // Rufi AI's words alone, in Rufi's plain button look.
            <button
              key={`${String(index)}:${answer}`}
              type="button"
              className={buttonLook({ look: "plain" })}
              onClick={() => {
                void box.choose(entry.id, index, answer, kind);
              }}
            >
              {answer}
            </button>
          ))
        ) : (
          <p className="flex min-h-9 items-center gap-1.5 text-muted">
            {state.icon && (
              <state.icon
                size={14}
                className={`shrink-0 ${state.spin ? "animate-spin" : ""} ${state.icon === Check ? "text-accent-ink" : ""}`}
                aria-hidden
              />
            )}
            <span className={state.icon === Check ? "text-ink" : ""}>
              {state.text}
            </span>
          </p>
        )}
        {send?.status === "lost" && entry.answer === undefined && (
          <Button
            icon={RotateCw}
            onClick={() => {
              void box.retry(entry.id, kind);
            }}
          >
            Retry
          </Button>
        )}
        <Button
          look="quiet"
          icon={Reply}
          className="ml-auto"
          onClick={() => {
            askRufi(personId, [
              {
                pointer: { type: "question", id: entry.id },
                label: card.key,
                detail: "Rufi AI's question",
              },
            ]);
          }}
        >
          Reply
        </Button>
      </div>
      {send?.status === "refused" && entry.answer === undefined && (
        <p role="alert" className="text-muted">
          {send.why}
        </p>
      )}
    </section>
  );
}
