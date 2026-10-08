// One live store per open chat: the stream's latest page, then each update
// applied by id, the older pages loaded as the person scrolls up, and the
// waiting messages read again when they change. Entries are kept by id, so a
// streaming reply re-renders only itself. The stream closes when nothing
// shows the chat; when it drops, it connects again and starts from the
// latest page. It never sends anything.
import {
  Page,
  StreamLine,
  type WaitingMessage,
  WaitingMessages,
} from "@rufi/contracts";
import { Schema } from "effect";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ApiError, read, stream } from "./api.ts";
import { queries } from "./reads.ts";
import {
  addOlder,
  apply,
  emptyTranscript,
  type Transcript,
} from "./transcript-state.ts";

export interface Live extends Transcript {
  /** loading: before the first snapshot; missing: no such person. */
  status: "loading" | "open" | "missing";
  /** Loading an older page, or why it couldn't be loaded. */
  older: "idle" | "loading" | "failed";
  waiting: readonly WaitingMessage[];
  /** Why the waiting messages couldn't be read, in the core's words. */
  waitingError: string | null;
}

/** The person's chat in the local API. */
export const chatPath = (personId: string) =>
  `/api/people/${encodeURIComponent(personId)}/chat`;

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
  loadOlder: () => Promise<void>;
  linger?: ReturnType<typeof setTimeout>;
}
const opened = new Map<string, Opened>();

/**
 * The live store of a person's chat. A view that shows it holds its stream
 * open from an effect: `useEffect(() => retain(personId), [personId])`.
 */
export function liveStore(personId: string) {
  return open(personId).store;
}

/** Holds the chat's stream open; the returned function lets it go. */
export function retain(personId: string): () => void {
  const entry = open(personId);
  entry.views += 1;
  clearTimeout(entry.linger);
  entry.start();
  return () => {
    entry.views -= 1;
    if (entry.views > 0) return;
    entry.linger = setTimeout(() => {
      if (entry.views > 0) return;
      entry.close();
      opened.delete(personId);
    }, LINGER_MS);
  };
}

/** Loads the page before what the chat shows, unless one is on its way. */
export const loadOlder = (personId: string) => open(personId).loadOlder();

function open(personId: string): Opened {
  const found = opened.get(personId);
  if (found) return found;
  const store = createStore<Live>(() => ({
    ...emptyTranscript,
    status: "loading",
    older: "idle",
    waiting: [],
    waitingError: null,
  }));
  const stop = new AbortController();
  const path = chatPath(personId);

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
    const next = apply(store.getState(), line);
    if (line.type === "snapshot") {
      // A reconnect: the latest page only; an older page on its way is dropped.
      store.setState({ ...next, status: "open", older: "idle" });
      void readWaiting();
    } else store.setState({ ...next, status: "open" });
    // A reply that ended for the sign-in: the sidebar says so.
    if (line.turns.some((turn) => turn.endReason === "sign_in")) {
      void queries.invalidateQueries({ queryKey: ["status"] });
    }
  };

  const loadOlder = async () => {
    const { before, older, window } = store.getState();
    if (before === null || older === "loading") return;
    store.setState({ older: "loading" });
    try {
      const page = await read(Page, "GET", `${path}?before=${String(before)}`);
      if (store.getState().window !== window) return;
      store.setState({
        ...addOlder(store.getState(), page, window),
        older: "idle",
      });
    } catch {
      if (store.getState().window === window) {
        store.setState({ older: "failed" });
      }
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
    loadOlder,
  };
  opened.set(personId, entry);
  return entry;
}

/** A failure in words for the person: the core's own, or a plain one. */
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Rufi had a problem with that.";
