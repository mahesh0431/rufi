// What waits to go to the AI, shown in the chat after its last message: your
// messages, as dashed bubbles, and Rufi's notes, in the order they go. A
// message shows here as soon as you send it, until the AI takes it: into the
// running reply, or in a reply of its own. A waiting message can be edited,
// moved by its handle (dragged, or by keyboard), sent now or removed; a held
// one says why, and goes only when you send it. A message already in the
// chat (Rufi's part reads its files, or its reply ended there with Retry)
// shows only there.
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
  ArrowUpToLine,
  Bell,
  Check,
  GripVertical,
  MessageSquarePlus,
  Pencil,
  RotateCw,
  Send,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { request } from "./api.ts";
import { ChipView } from "./chips.tsx";
import { chatPath, type Live, messageOf } from "./live.ts";
import { isRunning } from "./transcript-state.ts";
import { Button, buttonLook, ICON, IconButton } from "./ui.tsx";

/**
 * Shown here, unless its reply has it and what it needs: one being read,
 * or one whose reply offers Retry. A message held for another reason
 * (from a backup) shows here with its actions, also when its reply has it.
 */
const waitsHere = (item: QueueItem) =>
  item.state === "not_sure" ||
  item.turnId == null ||
  (item.held !== null && item.held !== "reply_ended");

/** Whether anything waits to show in the chat. */
export const anyWaiting = (state: Live) => state.queue.items.some(waitsHere);

/** Why a row doesn't go by itself, in words for the person. */
function whyHeld(item: QueueItem): string | null {
  if (item.state === "not_sure") {
    return "Not sure this reached the AI. Check the chat before you send it again.";
  }
  if (item.state === "handing_over") return "Sending…";
  switch (item.held) {
    case "restored":
      return "From a backup: it waited when the backup was made.";
    case "signed_out":
    case "failed":
    case "open_failed":
    case "reply_ended":
      return item.heldText;
    case null:
      return null;
  }
}

export function WaitingView({
  live,
  personId,
}: {
  live: StoreApi<Live>;
  personId: string;
}) {
  const { items: all } = useStore(live, (state) => state.queue);
  const items = all.filter(waitsHere);
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
  /** The next to go by itself; the others can be sent now, before it. */
  const next = shown.find(
    (item) => item.state === "waiting" && item.held === null,
  );
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
  const send = (item: QueueItem) =>
    void act(() => request("POST", `${one(item)}/send`));
  /** The person's choice for a message whose AI thread didn't open. */
  const recover = (
    item: QueueItem,
    hold: string,
    choice: "retry" | "new_thread",
  ) =>
    void act(() => request("POST", `${one(item)}/recover`, { hold, choice }));
  const heading = running
    ? "Waiting · these go in order after the reply"
    : items.some((item) => item.state !== "waiting" || item.held !== null)
      ? "Not sent · Rufi sends these only when you say"
      : "Waiting";

  return (
    <section aria-label="Waiting messages" className="mt-3 flex flex-col gap-2">
      <h3 className="flex items-center gap-3 text-xs font-normal text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
        {heading}
      </h3>
      {error !== null && <p className="text-muted">{error}</p>}
      {problem !== null && (
        <p role="alert" className="text-muted">
          {problem}
        </p>
      )}
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
              ) : item.state === "not_sure" || (isWaiting && !free) ? (
                <Button
                  look="quiet"
                  icon={Send}
                  onClick={() => {
                    send(item);
                  }}
                >
                  {item.state === "not_sure" ? "Send again" : "Send"}
                </Button>
              ) : (
                free &&
                item !== next && (
                  <Button
                    look="quiet"
                    icon={ArrowUpToLine}
                    onClick={() => {
                      send(item);
                    }}
                  >
                    Send now
                  </Button>
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
              {item.state !== "handing_over" && (
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
              mine={person}
            >
              {editing?.id === item.id ? (
                <div className="flex w-full max-w-[85%] flex-col gap-1 rounded-2xl border border-dashed border-line px-3.5 py-2">
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
              ) : person ? (
                <div className="flex max-w-[85%] min-w-0 flex-col gap-1 rounded-2xl border border-dashed border-line px-3.5 py-2">
                  {item.refs.length > 0 && (
                    <ul
                      aria-label="Added to this message"
                      className="flex flex-wrap gap-1.5"
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
                  <p className="break-words whitespace-pre-wrap">{item.text}</p>
                  {why !== null && <p className="text-xs text-muted">{why}</p>}
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    {actions}
                  </div>
                </div>
              ) : (
                // Rufi's note for the AI: never your words.
                <div className="flex min-w-0 flex-1 items-start gap-2 rounded-lg border border-dashed border-line bg-side px-3 py-2">
                  <Bell
                    size={14}
                    className="mt-1 shrink-0 text-muted"
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1 break-words">
                    <p className="text-xs text-muted">Rufi's note</p>
                    <p className="whitespace-pre-wrap">{item.text}</p>
                    {why !== null && (
                      <p className="text-xs text-muted">{why}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {actions}
                  </div>
                </div>
              )}
            </Row>
          );
        })}
      </MovableList>
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
        <ol className="flex flex-col gap-2">{children}</ol>
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
 * A row of the list, on your side of the chat for your message; a movable
 * one has its handle on its left. Escape while it moves puts it back and
 * leaves the chat open.
 */
function Row({
  id,
  waiting,
  movable,
  mine,
  children,
}: {
  id: string;
  /** Only waiting rows change places. */
  waiting: boolean;
  movable: boolean;
  mine: boolean;
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
      className={`flex items-start gap-1.5 ${mine ? "justify-end" : ""} ${isDragging ? "relative z-10 rounded-2xl bg-surface shadow-menu" : ""}`}
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
