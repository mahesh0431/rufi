// One live store per open conversation: the stream's snapshot, then each
// update applied by id, and the waiting messages read again when they change.
// Entries are kept by id, so a streaming reply re-renders only itself. The
// stream closes when nothing shows the conversation; when it drops, it
// connects again and starts from a new snapshot. It never sends anything.
import {
  type Conversation,
  Conversations,
  StreamLine,
  type WaitingMessage,
  WaitingMessages,
} from "@rufi/contracts";
import { Schema } from "effect";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiError, read, request, stream } from "./api.ts";
import { conversationsKey, queries } from "./reads.ts";
import { apply, type Transcript } from "./transcript-state.ts";

export interface Live extends Transcript {
  /** loading: before the first snapshot; missing: no such conversation. */
  status: "loading" | "open" | "missing";
  waiting: readonly WaitingMessage[];
  /** Why the waiting messages couldn't be read, in the core's words. */
  waitingError: string | null;
}

export const conversationPath = (personId: string, conversationId: string) =>
  `/api/people/${encodeURIComponent(personId)}/conversations/${encodeURIComponent(conversationId)}`;

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
 * The live store of a conversation. A view that shows it holds its stream
 * open from an effect: `useEffect(() => retain(personId, id), [personId, id])`.
 */
export function liveStore(personId: string, conversationId: string) {
  return open(personId, conversationId).store;
}

/** Holds the conversation's stream open; the returned function lets it go. */
export function retain(personId: string, conversationId: string): () => void {
  const entry = open(personId, conversationId);
  entry.views += 1;
  clearTimeout(entry.linger);
  entry.start();
  return () => {
    entry.views -= 1;
    if (entry.views > 0) return;
    entry.linger = setTimeout(() => {
      if (entry.views > 0) return;
      entry.close();
      opened.delete(key(personId, conversationId));
    }, LINGER_MS);
  };
}

const key = (personId: string, conversationId: string) =>
  `${personId}/${conversationId}`;

function open(personId: string, conversationId: string): Opened {
  const found = opened.get(key(personId, conversationId));
  if (found) return found;
  const store = createStore<Live>(() => ({
    status: "loading",
    conversation: null,
    entries: {},
    order: [],
    turns: {},
    waiting: [],
    waitingError: null,
  }));
  const stop = new AbortController();
  const path = conversationPath(personId, conversationId);

  const readWaiting = async () => {
    try {
      const { messages } = await read(
        WaitingMessages,
        "GET",
        `${path}/waiting`,
      );
      store.setState({ waiting: messages, waitingError: null });
    } catch (error) {
      store.setState({ waitingError: messageOf(error) });
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
    if (line.type === "update" && line.conversation) {
      showConversation(personId, line.conversation);
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
  opened.set(key(personId, conversationId), entry);
  return entry;
}

/** A conversation's new title or model, in the sidebar and the page title. */
function showConversation(personId: string, conversation: Conversation) {
  queries.setQueryData<typeof Conversations.Type>(
    conversationsKey(personId),
    (list) =>
      list && {
        ...list,
        conversations: list.conversations.some((c) => c.id === conversation.id)
          ? list.conversations.map((c) =>
              c.id === conversation.id ? conversation : c,
            )
          : [conversation, ...list.conversations],
      },
  );
}

/** A new conversation's first message went to the core: the chat continues it. */
export function showStarted(personId: string, conversation: Conversation) {
  showConversation(personId, conversation);
  queries.setQueryData<typeof Conversations.Type>(
    conversationsKey(personId),
    (list) => list && { ...list, chosen: conversation.id },
  );
}

/** Chooses the conversation the chat continues; null starts a new one. */
export async function choose(
  personId: string,
  conversationId: string | null,
): Promise<void> {
  const list = queries.getQueryData<typeof Conversations.Type>(
    conversationsKey(personId),
  );
  if (list?.chosen === conversationId) return;
  queries.setQueryData<typeof Conversations.Type>(
    conversationsKey(personId),
    (current) => current && { ...current, chosen: conversationId },
  );
  await request("PUT", `/api/people/${encodeURIComponent(personId)}/chosen`, {
    conversationId,
  }).catch(() =>
    // Not taken: show what the core keeps.
    queries.invalidateQueries({ queryKey: conversationsKey(personId) }),
  );
}

/** A failure in words for the person: the core's own, or a plain one. */
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Rufi had a problem with that.";
