// The box's text, kept by the core as the conversation's draft. Saves go one
// after another (one mutation scope per box), a moment after the typing
// stops, and at once when the box leaves the screen; the box says Saving…,
// Saved or Not saved (with Retry). Nothing is saved as the page closes, so
// what was typed since the last Saved can be lost then. A save based on an
// older revision is refused (another tab saved first) and the box shows the
// newer text. A send saves first; then the core holds the draft until the
// agent took the message (the draft empties) or refused it, and nobody can
// change it meanwhile, in this tab or another. A box that finds its draft
// held waits until the send has ended. Nothing here sends a message again.
import { type Draft, MAX_MESSAGE_CHARS } from "@rufi/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { createStore } from "zustand/vanilla";

export interface DraftIo {
  load: () => Promise<Draft>;
  /** Saves `text` on `revision`; a refusal gives the draft as it is now. */
  save: (
    text: string,
    revision: number,
  ) => Promise<{ saved: boolean; draft: Draft }>;
  /** The queries' client, and this box's name: its saves run in turn. */
  client: QueryClient;
  scope: string;
}

export interface BoxState {
  text: string;
  /** The draft as the core has it, as far as the box knows. */
  draft: Draft;
  /** The draft is read: until then the box can't be typed in. */
  loaded: boolean;
  /** A message from this box is on its way. */
  sending: boolean;
  /** The last save failed: the text is only in this tab. */
  failed: boolean;
  /** What the person should know: another tab's change, a failure. */
  notice: string | null;
}

export type DraftBox = ReturnType<typeof draftBox>;

/** How long after the last key the box saves. */
const PAUSE_MS = 400;
/** How often a box whose draft a send holds asks whether it has ended. */
const WAIT_MS = 1_000;

export const CHANGED = "Changed in another tab.";

/**
 * Runs `run` after the earlier runs in the same `scope` have ended, however
 * they ended: TanStack Query runs a scope's mutations one after another.
 */
export const inTurn = <T>(
  client: QueryClient,
  scope: string,
  run: () => Promise<T>,
): Promise<T> =>
  client
    .getMutationCache()
    .build(client, { scope: { id: scope }, mutationFn: run })
    .execute(undefined);

/** A send holds the draft: the box can't be changed. */
export const held = (state: BoxState) =>
  state.sending || state.draft.state === "sending";

export function draftBox(io: DraftIo) {
  const store = createStore<BoxState>(() => ({
    text: "",
    draft: { text: "", revision: 0, state: "editable" },
    loaded: false,
    sending: false,
    failed: false,
    notice: null,
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = false;

  /** The draft as the core has it now, shown as it is. */
  const show = (draft: Draft, notice: string | null = null) => {
    store.setState({ draft, text: draft.text, failed: false, notice });
    if (draft.state === "sending") void wait();
  };

  /** Reads the draft again until no send holds it. */
  async function wait(): Promise<void> {
    if (waiting) return;
    waiting = true;
    try {
      for (;;) {
        try {
          const draft = await io.load();
          store.setState({ draft, text: draft.text });
        } catch (error) {
          // Said in the box; asked again in a moment.
          store.setState({ notice: messageOf(error) });
        }
        if (store.getState().draft.state !== "sending") return;
        await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      }
    } finally {
      waiting = false;
    }
  }

  io.load().then(
    (draft) => {
      store.setState({ loaded: true });
      show(draft);
    },
    (error: unknown) => {
      // The box opens empty: a save then is refused if a draft exists, and
      // shows it.
      store.setState({ loaded: true, notice: messageOf(error) });
    },
  );

  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), PAUSE_MS);
  };

  /** Saves the text if it changed, after this box's earlier saves. */
  function save(): Promise<void> {
    clearTimeout(timer);
    return inTurn(io.client, io.scope, async () => {
      const state = store.getState();
      const { text, draft } = state;
      if (!state.loaded || draft.state === "sending" || tooLong(text)) {
        return;
      }
      if (text === draft.text) {
        store.setState({ failed: false });
        return;
      }
      try {
        const answer = await io.save(text, draft.revision);
        if (!answer.saved) {
          show(answer.draft, answer.draft.state === "sending" ? null : CHANGED);
          return;
        }
        store.setState({ draft: answer.draft, failed: false, notice: null });
        // Typed meanwhile: that is saved next.
        if (store.getState().text !== text) later();
      } catch (error) {
        store.setState({ failed: true, notice: messageOf(error) });
      }
    });
  }

  return {
    store,

    /** The person typed. */
    type(text: string): void {
      const state = store.getState();
      if (!state.loaded || held(state)) return;
      store.setState({ text, notice: null });
      later();
    },

    /** Saves now what isn't saved yet: Retry, or the box leaves the screen. */
    saveNow: save,

    /**
     * Takes the text for a send once the core keeps it as the draft, with
     * its revision. Undefined when it couldn't be saved, or another tab's
     * text replaced it: nothing is sent.
     */
    async take(): Promise<{ text: string; revision: number } | undefined> {
      const state = store.getState();
      if (!state.loaded || held(state) || tooLong(state.text)) return undefined;
      const { text } = state;
      store.setState({ sending: true, notice: null });
      await save();
      const { draft, failed } = store.getState();
      if (failed || draft.text !== text || draft.state === "sending") {
        store.setState({ sending: false });
        return undefined;
      }
      return { text, revision: draft.revision };
    },

    /** The core took the message; the box shows the draft it kept. */
    sent(draft: Draft): void {
      store.setState({ sending: false });
      show(draft);
    },

    /**
     * The message wasn't sent, or the box doesn't know: with the draft as the
     * core has it, the box goes on from it; without, it reads it again (the
     * send may still hold it).
     */
    failed(notice: string, draft?: Draft): void {
      const { draft: before } = store.getState();
      store.setState({ sending: false });
      show(draft ?? { ...before, state: "sending" }, notice);
    },
  };
}

/** Longer than Rufi takes: the box says so, and it isn't saved or sent. */
export const tooLong = (text: string) => text.length > MAX_MESSAGE_CHARS;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Rufi had a problem with that.";
