// The chat's box, the same in every size: what you type is the chat's
// draft, kept by the core, saved quietly; the box says only when it couldn't
// be. Enter sends; while a reply runs the box says so, the message waits,
// and Steer passes it into the reply instead. The box clears only when the
// core took the message, and nothing is sent again by itself. The model and
// effort are chosen beside Send; the waiting messages show above the box.
import {
  Draft,
  DraftChanged,
  MAX_MESSAGE_CHARS,
  NotSent,
  type Person,
  Sent,
  type WaitingMessage,
} from "@rufi/contracts";
import { Schema } from "effect";
import {
  ArrowDown,
  ArrowUp,
  LoaderCircle,
  Pencil,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { ApiError, read, request } from "./api.ts";
import {
  type BoxState,
  type DraftBox,
  type DraftIo,
  draftBox,
  held,
  sending,
  tooLong,
} from "./draft.ts";
import { chatPath, type Live, messageOf } from "./live.ts";
import { ModelMenu } from "./model-menu.tsx";
import { queries } from "./reads.ts";
import { isRunning } from "./transcript-state.ts";
import { Button } from "./ui.tsx";

const boxes = new Map<string, DraftBox>();

function draftIo(personId: string): DraftIo {
  const path = `${chatPath(personId)}/draft`;
  return {
    load: () => read(Draft, "GET", path),
    save: async (text, revision) => {
      try {
        const draft = await read(Draft, "PUT", path, { text, revision });
        return { saved: true, draft };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const { draft } = Schema.decodeUnknownSync(DraftChanged)(error.body);
          return { saved: false, draft };
        }
        throw error;
      }
    },
    client: queries,
    scope: `draft/${personId}`,
  };
}

/** The box of a person's chat, the same in every size. */
function boxFor(personId: string): DraftBox {
  let box = boxes.get(personId);
  if (!box) {
    box = draftBox(draftIo(personId));
    boxes.set(personId, box);
  }
  return box;
}

/** The draft in a refusal's answer, when it has one. */
const draftIn = (error: unknown) => {
  const kept = Schema.decodeUnknownOption(NotSent)(
    error instanceof ApiError ? error.body : undefined,
  );
  return kept._tag === "Some" ? kept.value.draft : undefined;
};

/**
 * What the box says under it: a send on its way, or a draft that couldn't be
 * saved. Saves are quiet, also Send's own: the box is read-only meanwhile.
 */
function saveState(state: BoxState): string | null {
  if (sending(state)) return "Sending…";
  if (state.failed) return "Not saved";
  return null;
}

const UNKNOWN =
  "Rufi doesn't know whether the AI got this message. Check the chat before you send it again.";

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
  const locked = useStore(box.store, held);
  const saved = useStore(box.store, saveState);
  const unknown = useStore(
    box.store,
    (state) => state.draft.state === "unknown",
  );
  const notice = useStore(box.store, (state) => state.notice);
  const running = useStore(live, isRunning);
  const [problem, setProblem] = useState<string | null>(null);
  const long = tooLong(text);
  const hasText = text.trim() !== "" && !long;

  // Leaving the screen, the box saves at once what isn't saved yet.
  useEffect(() => () => void box.saveNow(), [box]);

  async function submit(steer: boolean) {
    const taken = await box.take();
    if (!taken) return;
    const message = taken.text.trim();
    if (message === "") {
      box.sent(box.store.getState().draft);
      return;
    }
    setProblem(null);
    try {
      const sent = await read(
        Sent,
        "POST",
        `${chatPath(person.id)}/${steer ? "steer" : "messages"}`,
        { text: message, draft: taken.revision },
      );
      box.sent(sent.draft);
    } catch (error) {
      box.failed(messageOf(error), draftIn(error));
    }
  }

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
              void submit(false);
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
      className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-page"
    >
      <Square size={12} fill="currentColor" aria-hidden />
    </button>
  );

  return (
    <form
      className={size === "page" ? "flex flex-col gap-2" : "flex flex-col"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
    >
      {size !== "bar" && (
        <Waiting
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
                  void submit(true);
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
      {(notice || problem || long || unknown) && (
        <p role="alert" className="px-3.5 pb-2 text-muted">
          {long
            ? `Too long to keep or send: at most ${MAX_MESSAGE_CHARS.toLocaleString("en")} characters, and this is ${text.length.toLocaleString("en")}.`
            : [notice ?? problem, unknown ? UNKNOWN : null]
                .filter(Boolean)
                .join(" ")}
        </p>
      )}
    </form>
  );
}

/** The messages that wait for the running reply, or for you after a Stop. */
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

function Waiting({
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
  const waiting = useStore(live, (state) => state.waiting);
  const error = useStore(live, (state) => state.waitingError);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(
    null,
  );
  if (waiting.length === 0 && error === null) return null;
  const ids = waiting.map((message) => message.id);
  const move = (index: number, by: -1 | 1) => {
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(index + by, 0, moved);
    void act(() => request("PUT", `${path}/waiting`, { ids: next }));
  };
  const one = (message: WaitingMessage) =>
    `${path}/waiting/${encodeURIComponent(message.id)}`;

  return (
    <section
      aria-label="Waiting messages"
      className="border-b border-line px-3.5 py-2"
    >
      <h3 className="text-xs text-muted">
        {running
          ? "Waiting: these run in order after the reply."
          : "Waiting: send a message or run one to go on."}
      </h3>
      {error !== null && <p className="text-muted">{error}</p>}
      <ol className="mt-1 flex flex-col gap-1">
        {waiting.map((message, index) => (
          <li key={message.id} className="flex items-start gap-1.5">
            {editing?.id === message.id ? (
              <div className="flex flex-1 flex-col gap-1">
                <textarea
                  aria-label="Waiting message"
                  value={editing.text}
                  onChange={(event) => {
                    setEditing({ id: message.id, text: event.target.value });
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
                      void act(() => request("PUT", one(message), { text }));
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
                <p className="line-clamp-2 flex-1 break-words whitespace-pre-wrap">
                  {message.text}
                </p>
                {!running && (
                  <Icon
                    label="Run now"
                    onClick={() =>
                      void act(() => request("POST", `${one(message)}/run`))
                    }
                  >
                    <Play size={13} aria-hidden />
                  </Icon>
                )}
                {index > 0 && (
                  <Icon
                    label="Move up"
                    onClick={() => {
                      move(index, -1);
                    }}
                  >
                    <ArrowUp size={13} aria-hidden />
                  </Icon>
                )}
                {index < waiting.length - 1 && (
                  <Icon
                    label="Move down"
                    onClick={() => {
                      move(index, 1);
                    }}
                  >
                    <ArrowDown size={13} aria-hidden />
                  </Icon>
                )}
                <Icon
                  label="Edit"
                  onClick={() => {
                    setEditing({ id: message.id, text: message.text });
                  }}
                >
                  <Pencil size={13} aria-hidden />
                </Icon>
                <Icon
                  label="Delete"
                  onClick={() =>
                    void act(() => request("DELETE", one(message)))
                  }
                >
                  <Trash2 size={13} aria-hidden />
                </Icon>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
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
