// The chat's box, the same in every size: what you type is the chat's
// draft, kept by the core, saved quietly; the box says only when it couldn't
// be. Enter sends into Rufi's queue; while a reply runs the box says so, the
// message waits, and Steer passes it into the reply instead. The box clears
// only when the core took the message, and nothing is sent again by itself.
// The model and effort are chosen beside Send; what waits shows above the
// box.
import {
  MAX_MESSAGE_CHARS,
  type Person,
  type QueueItem,
} from "@rufi/contracts";
import {
  ArrowDown,
  ArrowUp,
  LoaderCircle,
  Pencil,
  Square,
  Trash2,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { request } from "./api.ts";
import { type BoxState, type DraftBox, draftBox, tooLong } from "./draft.ts";
import { chatPath, type Live, messageOf } from "./live.ts";
import { ModelMenu } from "./model-menu.tsx";
import { queries } from "./reads.ts";
import { isRunning } from "./transcript-state.ts";
import { Button } from "./ui.tsx";

const boxes = new Map<string, DraftBox>();

/** The box of a person's chat, the same in every size. */
function boxFor(personId: string): DraftBox {
  let box = boxes.get(personId);
  if (!box) {
    const path = chatPath(personId);
    box = draftBox({
      call: (method, to, body) => request(method, `${path}/${to}`, body),
      client: queries,
      scope: `draft/${personId}`,
      storage: sessionStorage,
    });
    boxes.set(personId, box);
  }
  return box;
}

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
  /** The box's text field, for focus. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const box = boxFor(person.id);
  const text = useStore(box.store, (state) => state.text);
  const loaded = useStore(box.store, (state) => state.loaded);
  const locked = useStore(box.store, (state) => state.sending);
  const saved = useStore(box.store, saveState);
  const notice = useStore(box.store, (state) => state.notice);
  const running = useStore(live, isRunning);
  const [problem, setProblem] = useState<string | null>(null);
  const long = tooLong(text);
  const hasText = text.trim() !== "" && !long;

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

  // The box grows with its text up to a few lines, then scrolls.
  const field = (
    <div
      className="grow-box max-h-40 min-w-0 flex-1 self-center overflow-auto"
      data-text={text}
    >
      <textarea
        ref={inputRef}
        rows={1}
        aria-label="Message to Rufi"
        placeholder={
          running
            ? "Type to queue your next message…"
            : `Ask or tell Rufi about ${person.displayName}…`
        }
        value={text}
        readOnly={!loaded || locked}
        onClick={onOpen}
        onChange={(event) => {
          box.type(event.target.value);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            if (hasText) {
              onOpen?.();
              submit(false);
            }
          }
        }}
        className="resize-none overflow-hidden bg-transparent outline-none placeholder:text-muted"
      />
    </div>
  );
  const choice = <ModelMenu live={live} personId={person.id} act={act} />;
  const sendButton = (
    <button
      type="submit"
      aria-label={running ? "Send (waits for the reply)" : "Send"}
      disabled={!hasText || locked}
      className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-on-accent disabled:bg-muted/40"
    >
      <ArrowUp size={16} aria-hidden />
    </button>
  );
  const stopButton = (
    <button
      type="button"
      aria-label="Stop"
      onClick={() => void stop()}
      className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-surface"
    >
      <Square size={12} fill="currentColor" aria-hidden />
    </button>
  );

  return (
    <form
      className={size === "page" ? "flex flex-col gap-2" : "flex flex-col"}
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
    >
      {size !== "bar" && (
        <QueueView
          live={live}
          path={chatPath(person.id)}
          running={running}
          act={act}
        />
      )}
      {size === "bar" ? (
        <div className="flex items-center gap-1.5 py-1.5 pr-1.5 pl-4">
          {running ? (
            <button
              type="button"
              onClick={onOpen}
              className="min-w-0 flex-1 text-left"
            >
              <Answering live={live} />
            </button>
          ) : (
            field
          )}
          {choice}
          {running ? stopButton : sendButton}
        </div>
      ) : (
        <div
          className={`rounded-2xl border border-line bg-surface px-3.5 pt-2.5 pb-1.5 ${size === "page" ? "shadow-sm" : ""}`}
        >
          <div className="flex">{field}</div>
          <div className="mt-1 flex items-center gap-1.5">
            {running && <Answering live={live} />}
            <span className="flex-1" />
            {running && hasText && (
              <Button
                look="plain"
                className="py-1"
                title="Pass this into the reply that is running"
                disabled={locked}
                onClick={() => {
                  submit(true);
                }}
              >
                Steer
              </Button>
            )}
            {choice}
            {(!running || hasText) && sendButton}
            {running && stopButton}
          </div>
        </div>
      )}
      {saved !== null && (
        <p
          role="status"
          className="flex items-center gap-1.5 px-3.5 pb-1 text-xs text-muted"
        >
          {saved}
          {saved === "Not saved" && (
            <button
              type="button"
              onClick={() => void box.saveNow()}
              className="underline"
            >
              Retry
            </button>
          )}
        </p>
      )}
      {(notice || problem || long) && (
        <p role="alert" className="px-3.5 pb-2 text-muted">
          {long
            ? `Too long to keep or send: at most ${MAX_MESSAGE_CHARS.toLocaleString("en")} characters, and this is ${text.length.toLocaleString("en")}.`
            : (notice ?? problem)}
        </p>
      )}
    </form>
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

/** Why a row doesn't go by itself, in words for the person. */
function whyHeld(item: QueueItem): string | null {
  if (item.state === "not_sure") {
    return "Not sure this reached the AI. Check the chat before you send it again.";
  }
  if (item.state === "handing_over") return "Sending…";
  switch (item.held) {
    case "paused":
    case "signed_out":
      return item.origin === "rufi"
        ? "Goes to the AI with your next message."
        : "You're signed out. Sign in, then Send.";
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
        : items.some((item) => item.state !== "waiting" || item.held !== null)
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
          <TextButton
            onClick={() => {
              send(first);
            }}
          >
            Send now
          </TextButton>
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
                  <div className="flex gap-1">
                    <Button
                      look="main"
                      className="py-0.5"
                      disabled={editing.text.trim() === ""}
                      onClick={() => {
                        const text = editing.text.trim();
                        setEditing(null);
                        void act(() => request("PUT", one(item), { text }));
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      className="py-0.5"
                      onClick={() => {
                        setEditing(null);
                      }}
                    >
                      Cancel
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
                    <TextButton
                      onClick={() => {
                        send(item);
                      }}
                    >
                      {item.state === "not_sure" ? "Send again" : "Send"}
                    </TextButton>
                  )}
                  {free && index > 0 && (
                    <Icon
                      label="Move up"
                      onClick={() => {
                        move(item.id, -1);
                      }}
                    >
                      <ArrowUp size={13} aria-hidden />
                    </Icon>
                  )}
                  {free && index >= 0 && index < ids.length - 1 && (
                    <Icon
                      label="Move down"
                      onClick={() => {
                        move(item.id, 1);
                      }}
                    >
                      <ArrowDown size={13} aria-hidden />
                    </Icon>
                  )}
                  {isWaiting && item.origin === "person" && (
                    <Icon
                      label="Edit"
                      onClick={() => {
                        setEditing({ id: item.id, text: item.text });
                      }}
                    >
                      <Pencil size={13} aria-hidden />
                    </Icon>
                  )}
                  {item.state !== "handing_over" && (
                    <Icon
                      label="Remove"
                      onClick={() =>
                        void act(() => request("DELETE", one(item)))
                      }
                    >
                      <Trash2 size={13} aria-hidden />
                    </Icon>
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

function TextButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-md px-1 py-0.5 text-xs whitespace-nowrap text-accent-ink hover:bg-accent-soft"
    >
      {children}
    </button>
  );
}

function Icon({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-side hover:text-ink"
    >
      {children}
    </button>
  );
}
