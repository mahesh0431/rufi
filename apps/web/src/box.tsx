// The chat's box, the same in every size: what you type is the chat's
// draft, kept by the core, saved quietly; the box says only when it couldn't
// be. Enter sends into Rufi's queue; while a reply runs Stop is beside the
// box (Activity shows what the AI does; the bar, where it doesn't show, has
// a busy sign), the message waits, and Add to reply passes it into the reply
// instead. The box clears only when the core took the message, and nothing
// is sent again by itself. Signed out, the core takes nothing: the box says so, with Sign in.
// The model and effort are chosen beside Send; what waits shows above the
// box. Chips (references to documents, draft items and records) sit above
// the text and go with it; a document's chip says what Rufi is doing with
// it. The paperclip adds files as documents. The bar is a pill of one fixed
// size that opens the panel: on one line, what was added (the first chip's
// name and how many more), then the text's start, or a reason when there is
// one; the panel shows it whole.
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  MAX_MESSAGE_CHARS,
  MAX_REFS,
  type Person,
  SIGNED_OUT,
  type QueueItem,
} from "@rufi/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  Check,
  CornerUpRight,
  GripVertical,
  LoaderCircle,
  LogIn,
  MessageSquarePlus,
  type LucideProps,
  Pencil,
  RotateCw,
  Send,
  Square,
  X,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useState,
} from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { request } from "./api.ts";
import { AttachButton, AttachStatus } from "./attach.tsx";
import { boxFor } from "./boxes.ts";
import { ChipView, useChipStates } from "./chips.tsx";
import { ContextMeter } from "./context-meter.tsx";
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
import { isRunning } from "./transcript-state.ts";
import { Button, buttonLook, ICON, IconButton } from "./ui.tsx";

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
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const long = tooLong(text);
  const many = tooMany(chips);
  const hasText = text.trim() !== "" && !long && !many;
  const placeholder = running
    ? "Type to queue your next message…"
    : `Ask or tell Rufi about ${person.displayName}…`;

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
              {running && (
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
            <ContextMeter live={live} />
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
      // A sort goes in a reply of its own. A message an older Rufi held
      // signed out says no more: Send or Remove.
      if (item.sort) {
        return item.held === "paused"
          ? "Goes after your next message, in a reply of its own."
          : "Goes by itself once you sign in.";
      }
      return item.origin === "rufi"
        ? "Goes to the AI with your next message."
        : null;
    case "restored":
      return "From a backup: it waited when the backup was made.";
    case "failed":
    case "open_failed":
      return item.heldText;
    case null:
      return null;
  }
}

/**
 * What waits to go to the AI: your messages and Rufi's notes, in order. A
 * waiting message can be edited, moved by its handle (dragged, or by
 * keyboard) or removed; a held one says why, and goes only when you Send it.
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
  // A dropped order shows until the queue is read again, or is refused.
  const [dropped, setDropped] = useState<{
    from: readonly QueueItem[];
    ids: readonly string[];
  } | null>(null);
  if (items.length === 0 && error === null) return null;
  const shown = dropped?.from === items ? inOrder(items, dropped.ids) : items;
  const ids = shown
    .filter((item) => item.state === "waiting")
    .map((item) => item.id);
  const reorder = (next: readonly string[]) => {
    setDropped({ from: items, ids: next });
    void act(async () => {
      try {
        await request("PUT", `${path}/queue`, { ids: next });
      } catch (refused) {
        setDropped(null);
        throw refused;
      }
    });
  };
  const one = (item: QueueItem) =>
    `${path}/queue/${encodeURIComponent(item.id)}`;
  const send = (item: QueueItem) =>
    void act(() => request("POST", `${one(item)}/send`));
  /** The person's choice for a message whose AI thread didn't open. */
  const recover = (
    item: QueueItem,
    hold: string,
    choice: "retry" | "new_thread",
  ) =>
    void act(() => request("POST", `${one(item)}/recover`, { hold, choice }));
  // What goes on when you say: the first row that only waits for the pause.
  const first = shown.find(
    (item) =>
      item.state === "waiting" &&
      (item.held === null || item.held === "paused"),
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
      <MovableList ids={ids} onMove={reorder}>
        {shown.map((item) => {
          const why = whyHeld(item);
          // Its AI thread didn't open: the person chooses, for this hold.
          const hold = item.held === "open_failed" ? item.holdId : null;
          const isWaiting = item.state === "waiting";
          const free =
            isWaiting && (item.held === null || item.held === "paused");
          return (
            <Row
              key={item.id}
              id={item.id}
              waiting={isWaiting}
              movable={free && ids.length > 1}
            >
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
                  {hold !== null ? (
                    <>
                      <Button
                        look="quiet"
                        icon={RotateCw}
                        onClick={() => {
                          recover(item, hold, "retry");
                        }}
                      >
                        Try again
                      </Button>
                      {/* Not while a reply runs: its thread stays. */}
                      {!running && (
                        <Button
                          look="quiet"
                          icon={MessageSquarePlus}
                          onClick={() => {
                            recover(item, hold, "new_thread");
                          }}
                        >
                          New thread
                        </Button>
                      )}
                    </>
                  ) : (
                    (item.state === "not_sure" || (isWaiting && !free)) && (
                      <Button
                        look="quiet"
                        icon={Send}
                        onClick={() => {
                          send(item);
                        }}
                      >
                        {item.state === "not_sure" ? "Send again" : "Send"}
                      </Button>
                    )
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
            </Row>
          );
        })}
      </MovableList>
    </section>
  );
}

/**
 * The queue's list, whose waiting rows (`ids`, in order) change places by
 * their handles, dragged or by keyboard; `onMove` gets the new order.
 */
function MovableList({
  ids,
  onMove,
  children,
}: {
  ids: string[];
  onMove: (ids: string[]) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[upOrDown]}
      onDragEnd={({ active, over }) => {
        if (over === null || active.id === over.id) return;
        onMove(
          arrayMove(
            ids,
            ids.indexOf(String(active.id)),
            ids.indexOf(String(over.id)),
          ),
        );
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol className="mt-1 flex flex-col gap-1">{children}</ol>
      </SortableContext>
    </DndContext>
  );
}

/** A dragged row moves only up or down. */
const upOrDown: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** The waiting rows in the order `ids` gives; the others stay where they are. */
function inOrder(items: readonly QueueItem[], ids: readonly string[]) {
  const waiting = ids.flatMap((id) => items.filter((item) => item.id === id));
  let next = 0;
  return items.map((item) =>
    item.state === "waiting" ? (waiting[next++] ?? item) : item,
  );
}

/**
 * A row of the queue; a movable one has its handle on the left. Escape
 * while it moves puts it back and leaves the chat open.
 */
function Row({
  id,
  waiting,
  movable,
  children,
}: {
  id: string;
  /** Only waiting rows change places. */
  waiting: boolean;
  movable: boolean;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled: { draggable: !movable, droppable: !waiting },
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onKeyDown={(event) => {
        if (isDragging && event.key === "Escape") event.preventDefault();
      }}
      className={`flex items-start gap-1.5 ${isDragging ? "relative z-10 rounded-lg bg-surface shadow-menu" : ""}`}
    >
      {movable && (
        // No tooltip: its Escape would end before the move's.
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label="Move"
          {...attributes}
          {...listeners}
          className={buttonLook({
            look: "quiet",
            shape: "icon",
            className: "cursor-grab touch-none active:cursor-grabbing",
          })}
        >
          <GripVertical size={ICON} aria-hidden />
        </button>
      )}
      {children}
    </li>
  );
}

/** Stop: a filled square, the one filled icon. */
function Stop(props: LucideProps) {
  return <Square {...props} size={12} fill="currentColor" />;
}
