// The box's text, kept by the core as the conversation's draft. Saves go one
// at a time, a moment after the typing stops; an answer never replaces newer
// text. A save based on an older revision is refused (another tab saved
// first) and the box shows the newer text. Nothing here sends a message: a
// send takes the text, and the box clears only when the core took it.
import type { Draft } from "@rufi/contracts";
import { createStore } from "zustand/vanilla";

export interface DraftIo {
  load: () => Promise<Draft>;
  /** Saves `text` on `revision`; a refusal gives the draft as it is now. */
  save: (
    text: string,
    revision: number,
  ) => Promise<{ saved: boolean; draft: Draft }>;
  /** The last save as the page goes away; nobody waits for its answer. */
  saveOnLeave: (text: string, revision: number) => void;
}

export interface BoxState {
  text: string;
  /** The draft is read: until then the box can't be typed in. */
  loaded: boolean;
  /** A message from the box is on its way: the text can't change meanwhile. */
  sending: boolean;
  /** What the person should know: another tab's change, a send that failed. */
  notice: string | null;
}

export type DraftBox = ReturnType<typeof draftBox>;

/** How long after the last key the box saves. */
const PAUSE_MS = 400;

export const CHANGED = "Changed in another tab.";

export function draftBox(
  io: DraftIo,
  start?: { draft: Draft; notice: string | null },
) {
  const store = createStore<BoxState>(() => ({
    text: start?.draft.text ?? "",
    loaded: start !== undefined,
    sending: false,
    notice: start?.notice ?? null,
  }));
  /** The draft as the core has it, as far as the box knows. */
  let stored: Draft = start?.draft ?? { text: "", revision: 0 };
  let saving: Promise<undefined> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (!start) {
    io.load().then(
      (draft) => {
        stored = draft;
        store.setState({ text: draft.text, loaded: true });
      },
      (error: unknown) => {
        // The box opens empty: a save then is refused if a draft exists, and
        // shows it.
        store.setState({ loaded: true, notice: messageOf(error) });
      },
    );
  }

  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), PAUSE_MS);
  };

  /** Saves the text if it changed; one save at a time. */
  async function flush(): Promise<void> {
    clearTimeout(timer);
    while (saving) await saving;
    const { text, loaded, sending } = store.getState();
    if (!loaded || sending || text === stored.text) return;
    const done = Promise.withResolvers<undefined>();
    saving = done.promise;
    try {
      const { saved, draft } = await io.save(text, stored.revision);
      stored = draft;
      if (!saved) store.setState({ text: draft.text, notice: CHANGED });
      // Typed meanwhile: that is saved next.
      else if (store.getState().text !== draft.text) later();
    } catch (error) {
      store.setState({ notice: messageOf(error) });
    } finally {
      saving = undefined;
      done.resolve(undefined);
    }
  }

  return {
    store,

    /** The person typed. */
    type(text: string): void {
      const { loaded, sending } = store.getState();
      if (!loaded || sending) return;
      store.setState({ text, notice: null });
      later();
    },

    /**
     * Takes the text for a send, after the save under way. Undefined when
     * another tab's text replaced it meanwhile: that isn't sent.
     */
    async take(): Promise<{ text: string; revision: number } | undefined> {
      const { text, loaded, sending } = store.getState();
      if (!loaded || sending) return undefined;
      clearTimeout(timer);
      store.setState({ sending: true, notice: null });
      while (saving) await saving;
      if (store.getState().text !== text) {
        store.setState({ sending: false });
        return undefined;
      }
      return { text, revision: stored.revision };
    },

    /** The core took the message; the box shows the draft it kept. */
    sent(draft: Draft): void {
      stored = draft;
      store.setState({ text: draft.text, sending: false, notice: null });
    },

    /** The message wasn't sent: the text stays, with why. */
    failed(notice: string | null): void {
      store.setState({ sending: false, notice });
      if (store.getState().text !== stored.text) later();
    },

    /** The page goes away: what wasn't saved yet goes in one last save. */
    leave(): void {
      clearTimeout(timer);
      const { text, loaded } = store.getState();
      if (loaded && text !== stored.text) io.saveOnLeave(text, stored.revision);
    },
  };
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Rufi had a problem with that.";
