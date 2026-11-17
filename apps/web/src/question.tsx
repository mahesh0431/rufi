// Rufi AI's open question (docs/adr/0036), as Rufi draws it: the question
// panel, in the box's place until the person answers. Rufi's dog peeks over
// its top; it says "Rufi asks" and the card's key, with Minimise, then the
// details, the question, each answer as a raised button that sends it (a
// short description under its label, and Recommended on one Rufi AI
// recommends), and a field for the person's own answer. A click, or the
// own answer sent, is the person's message quoting the card, sent as Enter
// in the box would while a reply runs; the box's words stay. While it goes,
// the panel says so (Sending, Not sent with Retry, Can't send or signed out
// with Sign in); once the chat has the message, the panel goes and the box
// is back. Minimise folds it to one line, until the question changes or the
// page loads again. A message's quote opens its card read-only
// (QuestionSheet), with the answer that message chose.
import { Dialog } from "@base-ui/react/dialog";
import {
  CLAUDE_SIGNED_OUT,
  MAX_MESSAGE_CHARS,
  type QuestionCard as Card,
  SIGNED_OUT,
} from "@rufi/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  LogIn,
  Pencil,
  RotateCw,
  Send,
  X,
} from "lucide-react";
import { type RefObject, useEffect, useId, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { boxFor } from "./boxes.ts";
import { ApricotDog } from "./dog.tsx";
import { type Live, liveStore, loadOlder, retain } from "./live.ts";
import { cardOf, openCardOf, useQuestionSheet } from "./question-card.ts";
import { useSettings } from "./reads.ts";
import { Marked } from "./transcript.tsx";
import { Button, IconButton } from "./ui.tsx";

/** The open question's card id, if Rufi AI's newest card waits for an answer. */
export const useOpenCard = (live: StoreApi<Live>) => useStore(live, openCardOf);

/** "Rufi asks · <key>": the panel's name, and its folded line. */
function Asks({ id, card }: { id?: string; card: Card }) {
  return (
    <span id={id} className="min-w-0 flex-1 truncate text-muted">
      <span className="font-semibold text-ink">Rufi asks</span> · {card.key}
    </span>
  );
}

/**
 * The question panel, in the box's place: open, or folded to one line. In
 * the bar (`onOpen`), always the line, and a click opens the chat.
 */
export function QuestionPanel({
  live,
  personId,
  card: id,
  inputRef,
  onOpen,
}: {
  live: StoreApi<Live>;
  personId: string;
  card: string;
  /** The own answer's field, for focus; in the bar, the line. */
  inputRef: RefObject<HTMLElement | null>;
  onOpen?: () => void;
}) {
  const entry = useStore(live, (state) => state.entries[id]);
  const card = entry && cardOf(entry);
  const [folded, setFolded] = useState(false);
  if (!card) return null;
  if (onOpen || folded) {
    return (
      <button
        type="button"
        ref={(element) => {
          if (onOpen) inputRef.current = element;
        }}
        onClick={() => {
          if (onOpen) onOpen();
          else setFolded(false);
        }}
        className={`flex h-11 w-full cursor-pointer items-center gap-2 rounded-full pr-1.5 pl-2 text-left ${onOpen ? "" : "bg-side shadow-float"}`}
      >
        <ApricotDog size={28} />
        <Asks card={card} />
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface text-muted shadow-[0_0_0_1px_var(--line)]">
          <ChevronUp size={16} aria-hidden />
        </span>
        <span className="sr-only">Open the question</span>
      </button>
    );
  }
  return (
    <Open
      id={id}
      card={card}
      personId={personId}
      inputRef={inputRef}
      onFold={() => {
        setFolded(true);
      }}
    />
  );
}

function Open({
  id,
  card,
  personId,
  inputRef,
  onFold,
}: {
  id: string;
  card: Card;
  personId: string;
  inputRef: RefObject<HTMLElement | null>;
  onFold: () => void;
}) {
  const box = boxFor(personId);
  const send = useStore(box.store, (state) => state.cards[id]);
  const kind = useSettings().data?.whileReplying ?? "steer";
  const navigate = useNavigate();
  const name = useId();
  const [own, setOwn] = useState("");
  const words = own.trim();
  const canSend = words !== "" && own.length <= MAX_MESSAGE_CHARS;
  const answer = (index: number | undefined, text: string) => {
    void box.choose(id, index, text, kind);
  };
  // The answer on its way, in place of the answers, until the chat has it.
  const going =
    send?.status === "sending" || send?.status === "sent"
      ? { text: send.text, spin: true }
      : send?.status === "lost"
        ? { text: `${send.text} · Not sent`, spin: false }
        : null;

  return (
    <section
      aria-labelledby={name}
      className="@container relative mt-3 flex flex-col gap-2.5 rounded-[22px] bg-side px-3 pt-2.5 pb-3 shadow-float"
    >
      <span className="absolute -top-3 left-3">
        <ApricotDog size={30} />
      </span>
      <div className="flex min-h-8 items-center gap-2 pl-9">
        <Asks id={name} card={card} />
        <IconButton
          label="Minimise"
          icon={ChevronDown}
          onClick={onFold}
          className="rounded-full bg-surface shadow-[0_0_0_1px_var(--line)]"
        />
      </div>
      {card.details !== undefined && card.details.trim() !== "" && (
        <div className="card-details min-w-0 px-1 break-words">
          <Marked text={card.details} />
        </div>
      )}
      <p className="px-1 text-[0.9375rem] font-semibold break-words">
        {card.question}
      </p>
      {going ? (
        <div className="flex min-h-11 items-center gap-2 px-1 text-muted">
          {going.spin && (
            <LoaderCircle
              size={14}
              className="shrink-0 animate-spin"
              aria-hidden
            />
          )}
          <span className="min-w-0 flex-1 truncate">
            {going.spin && <span className="sr-only">Sending: </span>}
            {going.text}
          </span>
          {send?.status === "lost" && (
            <Button
              icon={RotateCw}
              onClick={() => {
                void box.retry(id);
              }}
            >
              Retry
            </Button>
          )}
        </div>
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-2 @min-[460px]:grid-cols-2">
            {card.answers.map((one, index) => (
              <li key={`${String(index)}:${one.label}`} className="flex">
                <AnswerButton
                  label={one.label}
                  description={one.description}
                  recommended={one.recommended === true}
                  onClick={() => {
                    answer(index, one.label);
                  }}
                />
              </li>
            ))}
          </ul>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canSend) answer(undefined, words);
            }}
            className="flex items-end gap-2 rounded-[18px] bg-surface py-1 pr-1 pl-3 shadow-[0_0_0_1px_var(--line)]"
          >
            <Pencil
              size={15}
              className="mb-2.5 shrink-0 text-muted"
              aria-hidden
            />
            <div
              className="grow-box max-h-32 min-w-0 flex-1 self-center overflow-auto"
              data-text={own}
            >
              <textarea
                ref={(element) => {
                  inputRef.current = element;
                }}
                rows={1}
                aria-label="Your own answer"
                placeholder="Your own answer…"
                value={own}
                onChange={(event) => {
                  setOwn(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (canSend) answer(undefined, words);
                  }
                }}
                className="resize-none overflow-hidden bg-transparent outline-none placeholder:text-muted"
              />
            </div>
            <IconButton
              type="submit"
              look="main"
              label="Send"
              icon={Send}
              disabled={!canSend}
              className="rounded-full disabled:bg-muted/40 disabled:opacity-100"
            />
          </form>
        </>
      )}
      {send?.status === "refused" &&
        // Signed out, the box's own line and Sign in; else a few words.
        (send.why === SIGNED_OUT || send.why === CLAUDE_SIGNED_OUT ? (
          <p role="alert" className="flex items-center gap-1.5 px-1 text-muted">
            {send.why}
            <Button
              look="quiet"
              icon={LogIn}
              onClick={() => void navigate({ to: "/sign-in" })}
            >
              Sign in
            </Button>
          </p>
        ) : (
          <p role="alert" className="px-1 text-muted">
            Can't send
          </p>
        ))}
    </section>
  );
}

/**
 * One answer: a raised button with its send arrow. Under the pointer it
 * presses in and its arrow fills; one Rufi AI recommends has a ring, a tag
 * and a filled arrow.
 */
function AnswerButton({
  label,
  description,
  recommended,
  onClick,
}: {
  label: string;
  description: string | undefined;
  recommended: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-[14px] bg-surface py-1.5 pr-1.5 pl-3.5 text-left transition-[background-color,box-shadow,translate] duration-100 hover:translate-y-px hover:bg-accent-soft motion-reduce:transition-none ${recommended ? "shadow-chosen hover:shadow-chosen" : "shadow-raised hover:shadow-pressed"}`}
    >
      <span className="min-w-0 flex-1 py-1">
        <span className="block break-words">{label}</span>
        {description !== undefined && description.trim() !== "" && (
          <span className="block text-xs break-words text-muted">
            {description}
          </span>
        )}
      </span>
      {recommended && (
        <span className="shrink-0 rounded-full border border-accent px-2 text-xs font-semibold whitespace-nowrap">
          Recommended
        </span>
      )}
      <span
        className={`grid size-7 shrink-0 place-items-center rounded-full ${recommended ? "bg-accent text-on-accent" : "bg-side text-ink group-hover:bg-accent group-hover:text-on-accent"}`}
      >
        <ArrowRight size={15} aria-hidden />
      </span>
    </button>
  );
}

const SHEET =
  "fixed top-1/2 left-1/2 z-40 flex max-h-[85vh] w-[480px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[14px] bg-surface shadow-menu outline-none";
const BACKDROP = "fixed inset-0 z-40 bg-ink/25";

/** The card a message's quote opened, over any screen. */
export function QuestionSheet() {
  const open = useQuestionSheet();
  if (!open) return null;
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) useQuestionSheet.setState(null, true);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop data-over-chat className={BACKDROP} />
        <Dialog.Popup data-over-chat className={SHEET}>
          <Sheet {...open} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The card, read-only: its key, details, question and answers, with the
 * one this message chose marked. A card on an earlier page loads with it.
 */
function Sheet({
  personId,
  card: id,
  answer,
}: {
  personId: string;
  card: string;
  answer: number | undefined;
}) {
  const live = liveStore(personId);
  useEffect(() => retain(personId), [personId]);
  const entry = useStore(live, (state) => state.entries[id]);
  const card = entry && cardOf(entry);
  // Earlier pages load until the card is there, or the chat's start.
  const before = useStore(live, (state) => state.before);
  const older = useStore(live, (state) => state.older);
  useEffect(() => {
    if (entry || before === null || older !== "idle") return;
    void loadOlder(personId);
  }, [entry, before, older, personId]);
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-2.5">
        <ApricotDog size={24} />
        <Dialog.Title className="min-w-0 flex-1 truncate text-muted">
          <span className="font-semibold text-ink">Rufi asked</span>
          {card && ` · ${card.key}`}
        </Dialog.Title>
        <Dialog.Close render={<IconButton label="Close" icon={X} />} />
      </div>
      <div className="flex flex-col gap-2.5 overflow-auto px-4 py-3">
        {!card ? (
          <p className="text-muted">
            {older === "failed" || (before === null && older === "idle")
              ? "Can't load the question"
              : "Loading…"}
          </p>
        ) : (
          <>
            {card.details !== undefined && card.details.trim() !== "" && (
              <div className="card-details min-w-0 break-words">
                <Marked text={card.details} />
              </div>
            )}
            <p className="text-[0.9375rem] font-semibold break-words">
              {card.question}
            </p>
            <ul className="flex flex-col gap-1.5">
              {card.answers.map((one, index) => {
                const chosen = index === answer;
                return (
                  <li
                    key={`${String(index)}:${one.label}`}
                    className={`flex items-center gap-2 rounded-[12px] px-3 py-2 ${chosen ? "bg-accent-soft" : "bg-side"}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-words">
                        {chosen && (
                          <span className="sr-only">Your answer: </span>
                        )}
                        {one.label}
                      </span>
                      {one.description !== undefined &&
                        one.description.trim() !== "" && (
                          <span className="block text-xs break-words text-muted">
                            {one.description}
                          </span>
                        )}
                    </span>
                    {one.recommended === true && (
                      <span className="shrink-0 rounded-full border border-line px-2 text-xs font-semibold whitespace-nowrap text-muted">
                        Recommended
                      </span>
                    )}
                    {chosen && (
                      <Check
                        size={16}
                        className="shrink-0 text-accent-ink"
                        aria-hidden
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
