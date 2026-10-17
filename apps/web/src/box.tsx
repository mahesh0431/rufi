// The chat's box, the same in every size: what you type is the chat's
// draft, kept by the core, saved quietly; the box says only when it couldn't
// be. Enter sends into Rufi's queue; while a reply runs the box says so, the
// message waits, and Add to reply passes it into the reply instead. The box
// clears only when the core took the message, and nothing is sent again by
// itself. Signed out, the core takes nothing: the box says so, with Sign in.
// The model and effort are chosen beside Send; what waits shows above the
// box. Chips (references to documents, draft items and records) sit above
// the text and go with it; a document's chip says what Rufi is doing with
// it. The paperclip adds files as documents. The bar is a pill of one fixed
// size that opens the panel: on one line, what was added (the first chip's
// name and how many more), then the text's start, or a reason when there is
// one; the panel shows it whole.
import {
  MAX_MESSAGE_CHARS,
  MAX_REFS,
  type Person,
  SIGNED_OUT,
  type QueueItem,
} from "@rufi/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CornerUpRight,
  LoaderCircle,
  LogIn,
  type LucideProps,
  Pencil,
  RotateCw,
  Send,
  Square,
  X,
} from "lucide-react";
import { type RefObject, useEffect, useId, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { request } from "./api.ts";
import { AttachButton, AttachStatus } from "./attach.tsx";
import { boxFor } from "./boxes.ts";
import { ChipView, useChipStates } from "./chips.tsx";
import {
  type BoxChip,
  type BoxState,
  chipKey,
  tooLong,
  tooMany,
} from "./draft.ts";
import { chatPath, type Live, messageOf } from "./live.ts";
import { ReaderStrip } from "./reading.tsx";
import { ModelMenu } from "./model-menu.tsx";
import { usePanel } from "./panel.ts";
import { useStatus } from "./reads.ts";
import { isRunning } from "./transcript-state.ts";
import { Button, IconButton } from "./ui.tsx";

/**
 * What the box says under it: a send on its way, or a draft that couldn't be
 * saved. Saves are quiet: the box says nothing then.
 */
function saveState(state: BoxState): string | null {
  if (state.sending) return "Sending…";
  if (state.failed) return "Not saved";
  return null;
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
  const stateOf = useChipStates(person.id);
  const running = useStore(live, isRunning);
  const account = useStatus().data?.account;
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const long = tooLong(text);
  const many = tooMany(chips);
  const hasText = text.trim() !== "" && !long && !many;

  // Leaving the screen, the box saves at once what isn't saved yet.
  useEffect(() => () => void box.saveNow(), [box]);

  const submit = (steer: boolean) => {
    setProblem(null);
    void box.submit(steer);
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

  const told = refused ?? notice ?? problem;
  /**
   * Why the box can't keep, send or add what it should, in words; an add
   * refused just now comes first. A send refused signed out is past once
   * signed in.
   */
  const why = long
    ? `Too long to keep or send: at most ${MAX_MESSAGE_CHARS.toLocaleString("en")} characters, and this is ${text.length.toLocaleString("en")}.`
    : many
      ? `Too many added to keep or send: at most ${String(MAX_REFS)}, and this has ${String(chips.length)}. Take some out.`
      : told === SIGNED_OUT && account === "signed_in"
        ? null
        : told;
  /** In the pill, for the moment, in place of the text. */
  const reason = why ?? saved;
  const pill = useId();

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
        placeholder={
          running
            ? "Type to queue your next message…"
            : `Ask or tell Rufi about ${person.displayName}…`
        }
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
            if (hasText) submit(false);
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
      label={running ? "Send (waits for the reply)" : "Send"}
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

  return (
    <form
      className={size === "page" ? "flex flex-col gap-2" : "flex flex-col"}
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
    >
      {size !== "bar" && <ReaderStrip personId={person.id} />}
      {size !== "bar" && (
        <QueueView
          live={live}
          path={chatPath(person.id)}
          running={running}
          act={act}
        />
      )}
      {size !== "bar" && <AttachStatus personId={person.id} />}
      {size === "bar" ? (
        <div className="flex h-11 items-center gap-1.5 pr-1.5">
          <button
            type="button"
            ref={(element) => {
              inputRef.current = element;
            }}
            aria-label="Open the chat"
            aria-describedby={pill}
            onClick={onOpen}
            className="flex h-full min-w-0 flex-1 items-center rounded-l-full pl-3 text-left"
          >
            <span
              id={pill}
              className="flex min-w-0 flex-1 items-center gap-1.5"
            >
              <Added chips={chips} />{" "}
              {reason !== null ? (
                <span className="truncate text-muted">{reason}</span>
              ) : running ? (
                <Answering live={live} />
              ) : (
                <span
                  className={`truncate ${text.trim() === "" ? "text-muted" : ""}`}
                >
                  {text.trim() === ""
                    ? `Ask or tell Rufi about ${person.displayName}…`
                    : text}
                </span>
              )}
            </span>
          </button>
          {choice}
          {running ? stopButton : sendButton}
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
                    state={stateOf(chip.pointer)}
                    {...(!locked && {
                      onRemove: () => {
                        box.remove(chip);
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
            {running && <Answering live={live} />}
            <span className="flex-1" />
            {running && hasText && (
              <Button
                icon={CornerUpRight}
                title="Pass this into the reply that is running"
                disabled={locked}
                onClick={() => {
                  submit(true);
                }}
              >
                Add to reply
              </Button>
            )}
            {choice}
            {(!running || hasText) && sendButton}
            {running && stopButton}
          </div>
        </div>
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
          {why === SIGNED_OUT && (
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

/** While a reply runs: how long Rufi has been answering, counting up. */
function Answering({ live }: { live: StoreApi<Live> }) {
  const started = useStore(
    live,
    (state) =>
      Object.values(state.turns).find((turn) => turn.status === "running")
        ?.startedAt,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(tick);
    };
  }, []);
  const seconds =
    started === undefined
      ? 0
      : Math.max(0, Math.floor((now - Date.parse(started)) / 1_000));
  return (
    <span className="flex items-center gap-2 text-[13px] whitespace-nowrap text-muted">
      <LoaderCircle size={14} className="animate-spin" aria-hidden />
      Rufi is answering · {seconds}s
    </span>
  );
}

/** Rufi's note that goes with the person's next message. */
const rides = (item: QueueItem) =>
  item.origin === "rufi" &&
  (item.held === "paused" || item.held === "signed_out");

/** Why a row doesn't go by itself, in words for the person. */
function whyHeld(item: QueueItem): string | null {
  if (item.state === "not_sure") {
    return "Not sure this reached the AI. Check the chat before you send it again.";
  }
  if (item.state === "handing_over") return "Sending…";
  switch (item.held) {
    case "paused":
    case "signed_out":
      // A message an older Rufi held signed out says no more: Send or Remove.
      return item.origin === "rufi"
        ? "Goes to the AI with your next message."
        : null;
    case "restored":
      return "From a backup: it waited when the backup was made.";
    case "failed":
      return item.heldText;
    case null:
      return null;
  }
}

/**
 * What waits to go to the AI: your messages and Rufi's notes, in order. A
 * waiting message can be edited, moved or removed; a held one says why,
 * and goes only when you Send it.
 */
function QueueView({
  live,
  path,
  running,
  act,
}: {
  live: StoreApi<Live>;
  path: string;
  running: boolean;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const { items, paused } = useStore(live, (state) => state.queue);
  const error = useStore(live, (state) => state.queueError);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  );
  if (items.length === 0 && error === null) return null;
  const waiting = items.filter((item) => item.state === "waiting");
  const ids = waiting.map((item) => item.id);
  const move = (id: string, by: -1 | 1) => {
    const next = [...ids];
    const index = next.indexOf(id);
    next.splice(index, 1);
    next.splice(index + by, 0, id);
    void act(() => request("PUT", `${path}/queue`, { ids: next }));
  };
  const one = (item: QueueItem) =>
    `${path}/queue/${encodeURIComponent(item.id)}`;
  const send = (item: QueueItem) =>
    void act(() => request("POST", `${one(item)}/send`));
  // What goes on when you say: the first row that only waits for the pause.
  const first = waiting.find(
    (item) => item.held === null || item.held === "paused",
  );
  const heading = running
    ? "Waiting · these go in order after the reply"
    : paused === "stopped"
      ? "Stopped · these go when you send a message"
      : paused === "restarted"
        ? "Rufi restarted · these go when you send a message"
        : items.some(
              (item) =>
                item.state !== "waiting" ||
                (item.held !== null && !rides(item)),
            )
          ? "Not sent · Rufi sends these only when you say"
          : "Waiting";

  return (
    <section
      aria-label="Waiting messages"
      className="border-b border-line px-3.5 py-2"
    >
      <h3 className="flex items-center gap-2 text-xs font-normal text-muted">
        <span className="flex-1">{heading}</span>
        {!running && paused !== null && first && (
          <Button
            look="quiet"
            icon={Send}
            onClick={() => {
              send(first);
            }}
          >
            Send now
          </Button>
        )}
      </h3>
      {error !== null && <p className="text-muted">{error}</p>}
      <ol className="mt-1 flex flex-col gap-1">
        {items.map((item) => {
          const why = whyHeld(item);
          const index = ids.indexOf(item.id);
          const isWaiting = item.state === "waiting";
          const free =
            isWaiting && (item.held === null || item.held === "paused");
          return (
            <li key={item.id} className="flex items-start gap-1.5">
              {editing?.id === item.id ? (
                <div className="flex flex-1 flex-col gap-1">
                  <textarea
                    aria-label="Waiting message"
                    value={editing.text}
                    onChange={(event) => {
                      setEditing({ id: item.id, text: event.target.value });
                    }}
                    className="rounded-lg border border-line bg-surface px-2 py-1"
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      icon={X}
                      onClick={() => {
                        setEditing(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      look="main"
                      icon={Check}
                      disabled={editing.text.trim() === ""}
                      onClick={() => {
                        const text = editing.text.trim();
                        setEditing(null);
                        void act(() => request("PUT", one(item), { text }));
                      }}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p
                    className={`min-w-0 flex-1 break-words whitespace-pre-wrap ${item.origin === "rufi" ? "text-muted" : ""}`}
                  >
                    <span className="line-clamp-2">
                      {item.origin === "rufi"
                        ? `Rufi's note: ${item.text}`
                        : item.text}
                    </span>
                    {item.refs.length > 0 && (
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {item.refs.map(({ ref, label, detail, deleted }) => (
                          <ChipView
                            key={`${ref.type}:${ref.id}`}
                            chip={{ pointer: ref, label, detail, deleted }}
                          />
                        ))}
                      </span>
                    )}
                    {why !== null && (
                      <span className="block text-xs text-muted">{why}</span>
                    )}
                  </p>
                  {item.origin === "rufi" && (
                    <span className="rounded-full border border-line px-1.5 text-[11px] text-muted">
                      Rufi
                    </span>
                  )}
                  {(item.state === "not_sure" || (isWaiting && !free)) && (
                    <Button
                      look="quiet"
                      icon={Send}
                      onClick={() => {
                        send(item);
                      }}
                    >
                      {item.state === "not_sure" ? "Send again" : "Send"}
                    </Button>
                  )}
                  {free && index > 0 && (
                    <IconButton
                      label="Move up"
                      icon={ArrowUp}
                      onClick={() => {
                        move(item.id, -1);
                      }}
                    />
                  )}
                  {free && index >= 0 && index < ids.length - 1 && (
                    <IconButton
                      label="Move down"
                      icon={ArrowDown}
                      onClick={() => {
                        move(item.id, 1);
                      }}
                    />
                  )}
                  {isWaiting && item.origin === "person" && (
                    <IconButton
                      label="Edit"
                      icon={Pencil}
                      onClick={() => {
                        setEditing({ id: item.id, text: item.text });
                      }}
                    />
                  )}
                  {item.state !== "handing_over" && (
                    <IconButton
                      label="Remove"
                      icon={X}
                      onClick={() =>
                        void act(() => request("DELETE", one(item)))
                      }
                    />
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Stop: a filled square, the one filled icon. */
function Stop(props: LucideProps) {
  return <Square {...props} size={12} fill="currentColor" />;
}
