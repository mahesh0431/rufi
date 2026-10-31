// What waits to go to the AI, shown over the chat's bottom edge, just above
// the box, out of the chat's flow: the box stays put and the chat keeps its
// size when something starts or stops waiting. Your messages and Rufi's
// notes, in the order they go, a compact list that scrolls when long. A message shows here while it waits for a running
// reply, or is held; one Rufi is giving to the AI shows in the chat as
// sent. A waiting message can be steered
// into the running reply, edited, moved by its handle (dragged, or by
// keyboard) or removed; one Rufi didn't send says Failed, or Not sent, with
// why as it came, and goes only when you send it. One on its way to the AI
// says nothing: the chat's working line shows it.
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
import type { QueueItem } from "@rufi/contracts";
import {
  Bell,
  Check,
  GripVertical,
  Merge,
  MessageSquarePlus,
  Pencil,
  Send,
  X,
} from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/shallow";
import type { StoreApi } from "zustand/vanilla";
import { request } from "./api.ts";
import { ChipView } from "./chips.tsx";
import { chatPath, type Live, messageOf } from "./live.ts";
import { goingNow, isRunning } from "./transcript-state.ts";
import { Button, buttonLook, ICON, IconButton } from "./ui.tsx";

/** Why a row doesn't go by itself: Failed, or Not sent, and why as it came. */
function whyHeld(item: QueueItem): string | null {
  switch (item.held) {
    case "restored":
      return "Not sent · From a backup: it waited when the backup was made.";
    case "stopped":
      return `Not sent · ${item.heldText ?? ""}`;
    case "failed":
    case "open_failed":
      return `Failed · ${item.heldText ?? ""}`;
    case "signed_out":
      return item.heldText;
    case null:
      return null;
  }
}

/**
 * The waiting list over the chat's bottom edge, just above what holds it
 * (the box). It tells its height, so the chat leaves that much room under
 * its last message: at the chat's end, the newest lines show above it.
 */
export function FloatingWaiting({
  live,
  personId,
  onHeight,
  className,
}: {
  live: StoreApi<Live>;
  personId: string;
  onHeight: (height: number) => void;
  /** Where it sits across. */
  className: string;
}) {
  const here = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = here.current;
    if (!element) return;
    const sizes = new ResizeObserver(() => {
      onHeight(element.offsetHeight);
    });
    sizes.observe(element);
    return () => {
      sizes.disconnect();
      onHeight(0);
    };
  }, [onHeight]);
  return (
    <div ref={here} className={`absolute bottom-full z-10 ${className}`}>
      <WaitingView live={live} personId={personId} />
    </div>
  );
}

function WaitingView({
  live,
  personId,
}: {
  live: StoreApi<Live>;
  personId: string;
}) {
  // Not what shows as sent: being given to the AI, or in the chat already.
  const items = useStore(
    live,
    useShallow((state) => {
      const going = goingNow(state);
      return state.queue.items.filter(
        (item) => !going.includes(item) && !(item.id in state.entries),
      );
    }),
  );
  const error = useStore(live, (state) => state.queueError);
  const running = useStore(live, isRunning);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  );
  // A dropped order shows until the queue is read again, or is refused.
  const [dropped, setDropped] = useState<{
    from: readonly QueueItem[];
    ids: readonly string[];
  } | null>(null);
  if (items.length === 0 && error === null) return null;
  const path = chatPath(personId);
  const act = async (action: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await action();
    } catch (refused) {
      setProblem(messageOf(refused));
    }
  };
  const shown = dropped?.from === items ? inOrder(items, dropped.ids) : items;
  const ids = shown
    .filter((item) => item.state === "waiting")
    .map((item) => item.id);
  const reorder = (order: readonly string[]) => {
    setDropped({ from: items, ids: order });
    void act(async () => {
      try {
        await request("PUT", `${path}/queue`, { ids: order });
      } catch (refused) {
        setDropped(null);
        throw refused;
      }
    });
  };
  const one = (item: QueueItem) =>
    `${path}/queue/${encodeURIComponent(item.id)}`;
  /** A waiting row into the running reply; a held one sent. */
  const steer = (item: QueueItem) =>
    void act(() => request("POST", `${one(item)}/steer`));
  const send = (item: QueueItem) =>
    void act(() => request("POST", `${one(item)}/send`));
  /** The person's choice for a message whose AI thread didn't open. */
  const recover = (
    item: QueueItem,
    hold: string,
    choice: "retry" | "new_thread",
  ) =>
    void act(() => request("POST", `${one(item)}/recover`, { hold, choice }));
  // Held for the sign-in, a row goes by itself once you sign in; any
  // other hold waits for you.
  const heading = running
    ? "Waiting · these go in order after the reply"
    : items.some((item) => item.held !== null && item.held !== "signed_out")
      ? "Not sent · Rufi sends these only when you say"
      : items.some((item) => item.held === "signed_out")
        ? "Waiting until you sign in"
        : "Waiting";

  return (
    <section
      aria-label="Waiting messages"
      className="mb-1.5 flex flex-col rounded-xl border border-line bg-surface"
    >
      <h3 className="px-3 pt-1.5 text-xs font-normal text-muted">{heading}</h3>
      {error !== null && <p className="px-3 text-xs text-muted">{error}</p>}
      {problem !== null && (
        <p role="alert" className="px-3 text-xs text-muted">
          {problem}
        </p>
      )}
      {/* A long list scrolls here; the box stays where it is. */}
      <div className="max-h-40 overflow-auto px-1 pb-1">
        <MovableList ids={ids} onMove={reorder}>
          {shown.map((item) => {
            const why = whyHeld(item);
            // Its AI thread didn't open: the person chooses, for this hold.
            const hold = item.held === "open_failed" ? item.holdId : null;
            const isWaiting = item.state === "waiting";
            const free = isWaiting && item.held === null;
            const person = item.origin === "person";
            const actions = (
              <>
                {hold !== null ? (
                  <>
                    <IconButton
                      label="Send"
                      icon={Send}
                      onClick={() => {
                        recover(item, hold, "retry");
                      }}
                    />
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
                ) : isWaiting && !free ? (
                  <IconButton
                    label="Send"
                    icon={Send}
                    onClick={() => {
                      send(item);
                    }}
                  />
                ) : (
                  free &&
                  running && (
                    <IconButton
                      label="Steer"
                      icon={Merge}
                      onClick={() => {
                        steer(item);
                      }}
                    />
                  )
                )}
                {isWaiting && person && (
                  <IconButton
                    label="Edit"
                    icon={Pencil}
                    onClick={() => {
                      setEditing({ id: item.id, text: item.text });
                    }}
                  />
                )}
                {isWaiting && (
                  <IconButton
                    label="Remove"
                    icon={X}
                    onClick={() => void act(() => request("DELETE", one(item)))}
                  />
                )}
              </>
            );
            return (
              <Row
                key={item.id}
                id={item.id}
                waiting={isWaiting}
                movable={free && ids.length > 1}
              >
                {editing?.id === item.id ? (
                  <div className="flex min-w-0 flex-1 flex-col gap-1 py-1">
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
                  <div className="flex min-w-0 flex-1 items-center gap-2 py-0.5 pl-1">
                    {!person && (
                      // Rufi's note for the AI: never your words.
                      <Bell
                        size={14}
                        className="shrink-0 text-muted"
                        aria-hidden
                      />
                    )}
                    <div className="min-w-0 flex-1 break-words">
                      {!person && (
                        <p className="text-xs text-muted">Rufi's note</p>
                      )}
                      {item.refs.length > 0 && (
                        <ul
                          aria-label="Added to this message"
                          className="mb-0.5 flex flex-wrap gap-1"
                        >
                          {item.refs.map(({ ref, label, detail, deleted }) => (
                            <li
                              key={`${ref.type}:${ref.id}`}
                              className="max-w-full"
                            >
                              <ChipView
                                chip={{ pointer: ref, label, detail, deleted }}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="line-clamp-2" title={item.text}>
                        {item.text}
                      </p>
                      {why !== null && (
                        <p className="text-xs text-muted">{why}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {actions}
                    </div>
                  </div>
                )}
              </Row>
            );
          })}
        </MovableList>
      </div>
    </section>
  );
}

/**
 * The waiting list, whose waiting rows (`ids`, in order) change places by
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
        <ol className="flex flex-col">{children}</ol>
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
 * A row of the list; a movable one has its handle on its left. Escape while it moves puts it back and
 * leaves the chat open.
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
      className={`flex items-center gap-1 ${isDragging ? "relative z-10 rounded-lg bg-surface shadow-menu" : ""}`}
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
