// The chat's box, one for each conversation (and one for a new one) in every
// size: what you type is the conversation's draft, kept by the core. Enter
// sends; while a reply runs the message waits, and Steer passes it into the
// reply instead. The box clears only when the core took the message, and
// nothing is sent again by itself. The waiting messages show above it.
import {
  type Conversation,
  Draft,
  DraftChanged,
  MAX_MESSAGE_CHARS,
  NotSent,
  NotStarted,
  type Person,
  Sent,
  Started,
  type WaitingMessage,
} from "@rufi/contracts";
import { Schema } from "effect";
import { ArrowDown, ArrowUp, Pencil, Play, Square, Trash2 } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiError, putOnLeave, read, request } from "./api.ts";
import { beforeFirstMessage, continueStarted, inLine } from "./choice.ts";
import { type DraftBox, type DraftIo, draftBox, tooLong } from "./draft.ts";
import {
  conversationPath,
  type Live,
  messageOf,
  showConversation,
} from "./live.ts";
import { isRunning } from "./transcript-state.ts";
import { Button } from "./ui.tsx";

const boxes = new Map<string, DraftBox>();
const boxKey = (personId: string, conversationId: string | null) =>
  `${personId}/${conversationId ?? "new"}`;

/** This page's name in its draft saves, so its last save can follow its own. */
const TAB = crypto.randomUUID();

function draftIo(personId: string, conversationId: string | null): DraftIo {
  const path = `/api/people/${encodeURIComponent(personId)}/drafts/${encodeURIComponent(conversationId ?? "new")}`;
  return {
    load: () => read(Draft, "GET", path),
    save: async (text, revision) => {
      try {
        const draft = await read(Draft, "PUT", path, {
          text,
          revision,
          tab: TAB,
        });
        return { saved: true, draft };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const { draft } = Schema.decodeUnknownSync(DraftChanged)(error.body);
          return { saved: false, draft };
        }
        throw error;
      }
    },
    saveOnLeave: (text, revision) => {
      putOnLeave(path, { text, revision, tab: TAB, leaving: true });
    },
  };
}

/** The box of a conversation (null: a new one), the same in every size. */
function boxFor(personId: string, conversationId: string | null): DraftBox {
  const key = boxKey(personId, conversationId);
  let box = boxes.get(key);
  if (!box) {
    box = draftBox(draftIo(personId, conversationId));
    boxes.set(key, box);
  }
  return box;
}

/**
 * A new conversation's first message went to the core: its box starts from
 * the draft the core kept, and the next new conversation's box reads afresh.
 */
function moveBox(
  personId: string,
  conversation: Conversation,
  draft: Draft,
  notice: string | null,
) {
  boxes.delete(boxKey(personId, null));
  boxes.set(
    boxKey(personId, conversation.id),
    draftBox(draftIo(personId, conversation.id), { draft, notice }),
  );
}

// Reloading or closing the page: what wasn't saved yet goes in one last save.
// Only the box on screen can have such text (see Box), so the last save
// stays within what a browser sends after a page has gone (64 KiB).
addEventListener("pagehide", () => {
  for (const box of boxes.values()) box.leave();
});

/** The draft in a refusal's answer, when it has one. */
const draftIn = (body: unknown) => {
  const kept = Schema.decodeUnknownOption(NotSent)(body);
  return kept._tag === "Some" ? kept.value.draft : undefined;
};

/** For a new conversation, which has no live store yet. */
const IDLE = createStore<Live>(() => ({
  status: "open",
  conversation: null,
  entries: {},
  order: [],
  turns: {},
  waiting: [],
  waitingError: null,
}));

export function Box({
  person,
  conversationId,
  live,
  model,
  size,
  onStarted,
  onOpen,
  inputRef,
}: {
  person: Person;
  /** null: a new conversation, started by its first message. */
  conversationId: string | null;
  live: StoreApi<Live> | null;
  /** The model chosen for a new conversation. */
  model?: string | undefined;
  size: "bar" | "panel" | "page";
  /** A first message started this conversation; the chat continues it. */
  onStarted: (conversation: Conversation) => void;
  /** The bar: a click opens the chat. */
  onOpen?: () => void;
  /** The box's text field, for focus. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const box = boxFor(person.id, conversationId);
  const text = useStore(box.store, (state) => state.text);
  const loaded = useStore(box.store, (state) => state.loaded);
  const sending = useStore(box.store, (state) => state.sending);
  const paused = useStore(box.store, (state) => state.paused);
  const notice = useStore(box.store, (state) => state.notice);
  const running = useStore(live ?? IDLE, isRunning);
  const [problem, setProblem] = useState<string | null>(null);
  const long = tooLong(text);
  const hasText = text.trim() !== "" && !long;

  // Only the box on screen holds text the core may not have yet: when a box
  // comes on screen, every other box saves at once, and this one can be
  // typed in when those saves are done.
  useEffect(() => {
    box.pauseUntil(
      Promise.all(
        [...boxes.values()]
          .filter((other) => other !== box)
          .map((other) => other.saveNow()),
      ),
    );
  }, [box]);

  async function submit(steer: boolean) {
    const taken = await box.take();
    if (!taken) return;
    const message = taken.text.trim();
    if (message === "") {
      box.failed(null);
      return;
    }
    setProblem(null);
    const people = `/api/people/${encodeURIComponent(person.id)}`;
    if (conversationId === null) {
      // The core chooses the conversation it starts: in line with the
      // person's choices, and the chat goes there unless they chose again.
      const mayContinue = beforeFirstMessage(person.id);
      const started = (conversation: Conversation) => {
        showConversation(person.id, conversation);
        if (!mayContinue()) return;
        continueStarted(person.id, conversation.id);
        onStarted(conversation);
      };
      try {
        const answer = await inLine(person.id, () =>
          read(Started, "POST", `${people}/conversations/new/messages`, {
            text: message,
            draft: taken.revision,
            ...(model !== undefined && { model }),
          }),
        );
        moveBox(person.id, answer.conversation, answer.draft, null);
        started(answer.conversation);
      } catch (error) {
        const body = error instanceof ApiError ? error.body : undefined;
        const kept = Schema.decodeUnknownOption(NotStarted)(body);
        if (kept._tag === "Some") {
          // The conversation stays, with your text as its draft.
          moveBox(
            person.id,
            kept.value.conversation,
            kept.value.draft,
            messageOf(error),
          );
          started(kept.value.conversation);
        } else box.failed(messageOf(error), draftIn(body));
      }
      return;
    }
    try {
      const sent = await read(
        Sent,
        "POST",
        `${conversationPath(person.id, conversationId)}/${steer ? "steer" : "messages"}`,
        { text: message, draft: taken.revision },
      );
      box.sent(sent.draft);
    } catch (error) {
      box.failed(
        messageOf(error),
        draftIn(error instanceof ApiError ? error.body : undefined),
      );
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

  const stop = () =>
    act(() =>
      request(
        "POST",
        `${conversationPath(person.id, conversationId ?? "")}/stop`,
      ),
    );

  return (
    <form
      className={size === "page" ? "flex flex-col gap-2" : "flex flex-col"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
    >
      {live && conversationId !== null && size !== "bar" && (
        <Waiting
          live={live}
          path={conversationPath(person.id, conversationId)}
          running={running}
          act={act}
        />
      )}
      <div
        className={
          size === "page"
            ? "flex items-end gap-2 rounded-2xl border border-line bg-white py-2 pr-2 pl-3.5 shadow-sm"
            : "flex items-end gap-2 py-2.5 pr-2.5 pl-3.5"
        }
      >
        {/* The box grows with its text up to a few lines, then scrolls. */}
        <div
          className="grow-box max-h-40 min-w-0 flex-1 self-center overflow-auto"
          data-text={text}
        >
          <textarea
            ref={inputRef}
            rows={1}
            aria-label="Message to Rufi"
            placeholder={`Ask or tell Rufi about ${person.displayName}…`}
            value={text}
            readOnly={!loaded || sending || paused}
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
        {size === "bar" && running && (
          <span className="self-center rounded-full bg-side px-2.5 py-0.5 text-xs text-muted">
            Replying…
          </span>
        )}
        {running && hasText && (
          <Button
            look="plain"
            className="py-1"
            title="Pass this into the reply that is running"
            disabled={sending}
            onClick={() => {
              void submit(true);
            }}
          >
            Steer
          </Button>
        )}
        {(!running || hasText) && (
          <button
            type="submit"
            aria-label={running ? "Send (waits for the reply)" : "Send"}
            disabled={!hasText || sending}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-white disabled:bg-muted/40"
          >
            <ArrowUp size={16} aria-hidden />
          </button>
        )}
        {running && (
          <button
            type="button"
            aria-label="Stop"
            onClick={() => void stop()}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-white"
          >
            <Square size={12} fill="currentColor" aria-hidden />
          </button>
        )}
      </div>
      {(notice || problem || long) && (
        <p role="alert" className="px-3.5 pb-2 text-muted">
          {long
            ? `Too long to keep or send: at most ${MAX_MESSAGE_CHARS.toLocaleString("en")} characters, and this is ${text.length.toLocaleString("en")}.`
            : notice || problem}
        </p>
      )}
    </form>
  );
}

/** The messages that wait for the running reply, or for you after a Stop. */
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
                  className="rounded-lg border border-line bg-white px-2 py-1"
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
