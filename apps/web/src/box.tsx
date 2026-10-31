// The chat's box, the same in every size: what you type is the chat's
// draft, kept by the core, saved quietly; the box says only when it couldn't
// be. Enter sends. While a reply runs, the one round button is Stop while
// the box is empty, and sends once you type: Enter or a click does what
// Settings chose (Steer puts the message into the reply, Queue keeps it for
// after it), ⌘Enter or a ⌘-click the other, as a line under the box says
// (Activity shows what the AI does; the bar, where it
// doesn't show, has a busy sign from the send on; the chat's working line
// shows the send, not the box). The box clears only when the core took the message, and nothing
// is sent again by itself. Signed out, the core takes nothing: the box says so, with Sign in.
// The model and effort are chosen beside Send; what waits shows in the
// chat (waiting.tsx). Chips (references to documents, draft items and records) sit above
// the text and go with it; a document's chip names it. The paperclip adds files as documents. The bar is a pill of one fixed
// size that opens the panel: on one line, what was added (the first chip's
// name and how many more), then the text's start, or a reason when there is
// one; the panel shows it whole.
import {
  MAX_MESSAGE_CHARS,
  MAX_REFS,
  type Person,
  CLAUDE_SIGNED_OUT,
  SIGNED_OUT,
  type WhileReplying,
} from "@rufi/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  LoaderCircle,
  LogIn,
  type LucideProps,
  RotateCw,
  Send,
  Square,
} from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { ApiError, request } from "./api.ts";
import { AttachButton, AttachStatus } from "./attach.tsx";
import { boxFor } from "./boxes.ts";
import { ChipView } from "./chips.tsx";
import { ContextMeter } from "./context-meter.tsx";
import {
  type BoxChip,
  type BoxState,
  chipKey,
  tooLong,
  tooMany,
} from "./draft.ts";
import { chatPath, type Live, messageOf } from "./live.ts";
import { ModelMenu } from "./model-menu.tsx";
import { usePanel } from "./panel.ts";
import { useSettings } from "./reads.ts";
import { isRunning, workingOf } from "./transcript-state.ts";
import { Button, IconButton } from "./ui.tsx";

/**
 * What the box says under it: a draft that couldn't be saved. Saves are
 * quiet: the box says nothing then; a send shows in the chat.
 */
function saveState(state: BoxState): string | null {
  return state.failed ? "Not saved" : null;
}

export function Box({
  person,
  live,
  size,
  onOpen,
  inputRef,
}: {
  person: Person;
  live: StoreApi<Live>;
  size: "bar" | "panel" | "page";
  /** The bar: a click opens the chat. */
  onOpen?: () => void;
  /** The box's text field, for focus; in the bar, the pill. */
  inputRef: RefObject<HTMLElement | null>;
}) {
  const box = boxFor(person.id);
  const text = useStore(box.store, (state) => state.text);
  const loaded = useStore(box.store, (state) => state.loaded);
  const locked = useStore(box.store, (state) => state.sending);
  const saved = useStore(box.store, saveState);
  const notice = useStore(box.store, (state) => state.notice);
  const chips = useStore(box.store, (state) => state.refs);
  const refused = usePanel((state) => state.refused);
  const running = useStore(live, isRunning);
  // From the send until the reply ends: the bar's busy sign.
  const busy = useStore(live, (state) => workingOf(state, locked) !== null);
  // What Enter does while a reply runs, and ⌘Enter.
  const enter = useSettings().data?.whileReplying ?? "steer";
  const other: WhileReplying = enter === "steer" ? "queue" : "steer";
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const long = tooLong(text);
  const many = tooMany(chips);
  const hasText = (text.trim() !== "" || chips.length > 0) && !long && !many;
  const placeholder = `Ask or tell Rufi about ${person.displayName}…`;

  // Leaving the screen, the box saves at once what isn't saved yet.
  useEffect(() => () => void box.saveNow(), [box]);

  const submit = (kind: WhileReplying = enter) => {
    setProblem(null);
    void box.submit(kind);
  };

  async function act(action: () => Promise<unknown>) {
    setProblem(null);
    try {
      await action();
    } catch (error) {
      setProblem(messageOf(error));
    }
  }

  const stop = () => act(() => request("POST", `${chatPath(person.id)}/stop`));

  /**
   * Why the box can't keep, send or add what it should, in words; an add
   * refused just now comes first.
   */
  const why = long
    ? `Too long to keep or send: at most ${MAX_MESSAGE_CHARS.toLocaleString("en")} characters, and this is ${text.length.toLocaleString("en")}.`
    : many
      ? `Too many added to keep or send: at most ${String(MAX_REFS)}, and this has ${String(chips.length)}. Take some out.`
      : (refused ?? notice ?? problem);
  /** In the pill, for the moment, in place of the text. */
  const reason = why ?? saved;

  // The box grows with its text up to a few lines, then scrolls.
  const field = (
    <div
      className="grow-box max-h-40 min-w-0 flex-1 self-center overflow-auto"
      data-text={text}
    >
      <textarea
        ref={(element) => {
          inputRef.current = element;
        }}
        rows={1}
        aria-label="Message to Rufi"
        placeholder={placeholder}
        value={text}
        readOnly={!loaded || locked}
        onChange={(event) => {
          box.type(event.target.value);
          if (refused !== null) usePanel.setState({ refused: null });
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            if (hasText) {
              submit(
                running && (event.metaKey || event.ctrlKey) ? other : enter,
              );
            }
          }
        }}
        className="resize-none overflow-hidden bg-transparent outline-none placeholder:text-muted"
      />
    </div>
  );
  const choice = <ModelMenu live={live} personId={person.id} act={act} />;
  const sendButton = (
    <IconButton
      type="submit"
      look="main"
      label="Send"
      icon={Send}
      disabled={!hasText || locked}
      className="rounded-full disabled:bg-muted/40 disabled:opacity-100"
    />
  );
  const stopButton = (
    <IconButton
      look="main"
      label="Stop"
      icon={Stop}
      onClick={() => void stop()}
      className="rounded-full bg-ink text-surface not-disabled:hover:bg-ink"
    />
  );
  /**
   * While a reply runs, the one button: Stop until you type, then what
   * Settings chose, the other with ⌘.
   */
  const whileRunning = hasText ? (
    <IconButton
      look="main"
      label={enter === "steer" ? "Steer" : "Queue"}
      icon={Send}
      disabled={locked}
      onClick={(event) => {
        submit(event.metaKey || event.ctrlKey ? other : enter);
      }}
      className="rounded-full"
    />
  ) : (
    stopButton
  );

  return (
    <form
      className={size === "page" ? "flex flex-col gap-2" : "flex flex-col"}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {size !== "bar" && <AttachStatus personId={person.id} />}
      {size === "bar" ? (
        <div className="flex h-11 items-center gap-1.5 pr-1.5">
          <button
            type="button"
            ref={(element) => {
              inputRef.current = element;
            }}
            onClick={onOpen}
            className="flex h-full min-w-0 flex-1 items-center rounded-l-full pl-3 text-left"
          >
            {/* Its name says what it does, then what it shows. */}
            <span className="sr-only">Open the chat: </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {busy && (
                <LoaderCircle
                  size={14}
                  className="shrink-0 animate-spin text-muted"
                  aria-hidden
                />
              )}
              <Added chips={chips} />{" "}
              {reason !== null ? (
                <span className="truncate text-muted">{reason}</span>
              ) : (
                <span
                  className={`truncate ${text.trim() === "" ? "text-muted" : ""}`}
                >
                  {text.trim() === "" ? placeholder : text}
                </span>
              )}
            </span>
          </button>
          {choice}
          {running ? whileRunning : sendButton}
        </div>
      ) : (
        <div
          className={`rounded-2xl border border-line bg-surface px-3.5 pt-2.5 pb-1.5 ${size === "page" ? "shadow-sm" : ""}`}
        >
          {chips.length > 0 && (
            <ul
              aria-label="Added to this message"
              className="mb-1.5 flex max-h-24 flex-wrap gap-1.5 overflow-auto"
            >
              {chips.map((chip) => (
                <li key={chipKey(chip)} className="max-w-full">
                  <ChipView
                    chip={chip}
                    {...(!locked && {
                      onRemove: () => {
                        void act(async () => {
                          if (chip.pointer.type === "document") {
                            try {
                              await request(
                                "DELETE",
                                `/api/people/${encodeURIComponent(person.id)}/documents/${encodeURIComponent(chip.pointer.id)}/unsent`,
                              );
                            } catch (error) {
                              // Sent files stay in Rufi; only their chip leaves the box.
                              if (
                                !(
                                  error instanceof ApiError &&
                                  error.status === 409
                                )
                              )
                                throw error;
                            }
                          }
                          box.remove(chip);
                        });
                      },
                    })}
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="flex">{field}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <AttachButton personId={person.id} />
            <span className="flex-1" />
            {choice}
            <ContextMeter live={live} />
            {running ? whileRunning : sendButton}
          </div>
        </div>
      )}
      {size !== "bar" && running && hasText && (
        // The other way to send, light, while a reply runs.
        <p className="px-3.5 pt-1 text-xs text-muted">
          {other === "queue" ? "⌘↵ to queue" : "⌘↵ to steer"}
        </p>
      )}
      {size === "bar"
        ? why !== null && (
            <p role="alert" className="sr-only">
              {why}
            </p>
          )
        : saved !== null && (
            <p
              role="status"
              className="flex items-center gap-1.5 px-3.5 pb-1 text-xs text-muted"
            >
              {saved}
              {saved === "Not saved" && (
                <Button
                  look="quiet"
                  icon={RotateCw}
                  onClick={() => void box.saveNow()}
                >
                  Retry
                </Button>
              )}
            </p>
          )}
      {size !== "bar" && why !== null && (
        <p
          role="alert"
          className="flex items-center gap-1.5 px-3.5 pb-2 text-muted"
        >
          {why}
          {(why === SIGNED_OUT || why === CLAUDE_SIGNED_OUT) && (
            <Button
              look="quiet"
              icon={LogIn}
              onClick={() => void navigate({ to: "/sign-in" })}
            >
              Sign in
            </Button>
          )}
        </p>
      )}
    </form>
  );
}

/** In the bar: what is added to the message, as its first chip and how many more. */
function Added({ chips }: { chips: readonly BoxChip[] }) {
  const first = chips[0];
  if (first === undefined) return null;
  return (
    <span
      title={chips.map((chip) => chip.label).join("\n")}
      className="inline-flex max-w-[180px] shrink-0 items-center gap-1 rounded-lg border border-line bg-side px-1.5 text-xs"
    >
      <span className="truncate">
        {first.label === "" ? "Adding…" : first.label}
      </span>
      {chips.length > 1 && (
        <span className="font-semibold text-accent-ink">
          {" "}
          +{chips.length - 1}
        </span>
      )}
    </span>
  );
}

/** Stop: a filled square, the one filled icon. */
function Stop(props: LucideProps) {
  return <Square {...props} size={12} fill="currentColor" />;
}
