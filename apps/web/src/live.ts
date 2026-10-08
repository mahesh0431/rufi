// One live store per open chat: the stream's snapshot, then each
// update applied by id, and the waiting messages read again when they change.
// Entries are kept by id, so a streaming reply re-renders only itself. The
// stream closes when nothing shows the chat; when it drops, it
// connects again and starts from a new snapshot. It never sends anything.
import {
  type Chat,
  Chats,
  StreamLine,
  type WaitingMessage,
  WaitingMessages,
} from "@rufi/contracts";
import { Schema } from "effect";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiError, read, stream } from "./api.ts";
import { chatsKey, queries } from "./reads.ts";
import { apply, type Transcript } from "./transcript-state.ts";

export interface Live extends Transcript {
  /** loading: before the first snapshot; missing: no such chat. */
  status: "loading" | "open" | "missing";
  waiting: readonly WaitingMessage[];
  /** Why the waiting messages couldn't be read, in the core's words. */
  waitingError: string | null;
}

export const chatPath = (personId: string, chatId: string) =>
  `/api/people/${encodeURIComponent(personId)}/chats/${encodeURIComponent(chatId)}`;

/** How long a store stays open after the last view leaves (bar to page). */
const LINGER_MS = 1_000;
const RETRY_MS = 500;
const RETRY_MAX_MS = 10_000;

interface Opened {
  store: StoreApi<Live>;
  views: number;
  /** Starts the stream, once. */
  start: () => void;
  close: () => void;
  linger?: ReturnType<typeof setTimeout>;
}
const opened = new Map<string, Opened>();

/**
 * The live store of a chat. A view that shows it holds its stream
 * open from an effect: `useEffect(() => retain(personId, id), [personId, id])`.
 */
export function liveStore(personId: string, chatId: string) {
  return open(personId, chatId).store;
}

/** Holds the chat's stream open; the returned function lets it go. */
export function retain(personId: string, chatId: string): () => void {
  const entry = open(personId, chatId);
  entry.views += 1;
  clearTimeout(entry.linger);
  entry.start();
  return () => {
    entry.views -= 1;
    if (entry.views > 0) return;
    entry.linger = setTimeout(() => {
      if (entry.views > 0) return;
      entry.close();
      opened.delete(key(personId, chatId));
    }, LINGER_MS);
  };
}

const key = (personId: string, chatId: string) => `${personId}/${chatId}`;

function open(personId: string, chatId: string): Opened {
  const found = opened.get(key(personId, chatId));
  if (found) return found;
  const store = createStore<Live>(() => ({
    status: "loading",
    chat: null,
    entries: {},
    order: [],
    turns: {},
    waiting: [],
    waitingError: null,
  }));
  const stop = new AbortController();
  const path = chatPath(personId, chatId);

  // Each change starts a read; only the last one started is shown, so an
  // older answer that comes late never replaces a newer one.
  let reads = 0;
  const readWaiting = async () => {
    const mine = (reads += 1);
    try {
      const { messages } = await read(
        WaitingMessages,
        "GET",
        `${path}/waiting`,
      );
      if (mine === reads) {
        store.setState({ waiting: messages, waitingError: null });
      }
    } catch (error) {
      if (mine === reads) store.setState({ waitingError: messageOf(error) });
    }
  };

  const onLine = (raw: unknown) => {
    const line = Schema.decodeUnknownSync(StreamLine)(raw);
    if (line.type === "ping") return;
    if (line.type === "waiting") {
      void readWaiting();
      return;
    }
    const before = store.getState();
    const next = apply(before, line);
    store.setState({ ...next, status: "open" });
    if (line.type === "snapshot") void readWaiting();
    if (line.type === "update" && line.chat) {
      showChat(personId, line.chat);
    }
    // A reply that ended for the sign-in: the sidebar says so.
    if (line.turns.some((turn) => turn.endReason === "sign_in")) {
      void queries.invalidateQueries({ queryKey: ["status"] });
    }
  };

  const stopped = () => stop.signal.aborted;
  const run = async () => {
    let wait = RETRY_MS;
    while (!stopped()) {
      try {
        await stream(`${path}/stream`, onLine, stop.signal);
        wait = RETRY_MS;
      } catch (error) {
        if (stopped()) return;
        if (error instanceof ApiError && error.status === 404) {
          store.setState({ status: "missing" });
          return;
        }
        if (error instanceof ApiError && error.status === 401) return;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, RETRY_MAX_MS);
    }
  };
  let started = false;
  const entry: Opened = {
    store,
    views: 0,
    start: () => {
      if (started) return;
      started = true;
      void run();
    },
    close: () => {
      stop.abort();
    },
  };
  opened.set(key(personId, chatId), entry);
  return entry;
}

/** A chat's new title or model, in the sidebar and the page title. */
function showChat(personId: string, chat: Chat) {
  // An older read of the list, still on its way, must not undo this.
  void queries.cancelQueries({ queryKey: chatsKey(personId) }).then(() => {
    queries.setQueryData<typeof Chats.Type>(
      chatsKey(personId),
      (list) =>
        list && {
          ...list,
          chats: list.chats.map((c) => (c.id === chat.id ? chat : c)),
        },
    );
  });
}

/** A failure in words for the person: the core's own, or a plain one. */
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Rufi had a problem with that.";
