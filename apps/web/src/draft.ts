// The box's text, kept by the core as the chat's draft, and its send. Saves
// go one after another (one mutation scope per box), a moment after the
// typing stops, and at once when the box leaves the screen, silently; the
// box says only Not saved (with Retry). The last save wins: two tabs typing
// at once replace each other's text. Nothing is saved as the page closes,
// so what was typed since the last save can be lost then. A send saves
// first, quietly; then the core keeps the text and holds the draft
// ("Sending…") until the agent took the message (the draft empties) or
// refused it, and nobody can change it meanwhile, in this tab or another. A
// box that finds its draft held follows it until the send has ended.
// Nothing here sends a message again.
import { Draft, MAX_MESSAGE_CHARS, NotDone, Sent } from "@rufi/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { createStore } from "zustand/vanilla";

export interface DraftApi {
  /**
   * One request to the chat's API: the core's JSON answer, or an error with
   * the core's answer as its `body`.
   */
  call: (
    method: "GET" | "PUT" | "POST",
    path: "draft" | "messages" | "steer",
    body?: unknown,
  ) => Promise<unknown>;
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
  /** Send is saving the text first: the box can't change meanwhile. */
  preparing: boolean;
  /** A message from this box is on its way; the core holds its text. */
  sending: boolean;
  /** The last save failed: the text is only in this tab. */
  failed: boolean;
  /** What the person should know: why a read, save or send failed. */
  notice: string | null;
}

export type DraftBox = ReturnType<typeof draftBox>;

/** How long after the last key the box saves. */
const PAUSE_MS = 400;
/** How often a box reads a draft it couldn't read, or a send holds. */
const WAIT_MS = 1_000;

/**
 * Runs `run` after the earlier runs in the same `scope` have ended, however
 * they ended: TanStack Query runs a scope's mutations one after another.
 */
const inTurn = <T>(
  client: QueryClient,
  scope: string,
  run: () => Promise<T>,
): Promise<T> =>
  client
    .getMutationCache()
    .build(client, { scope: { id: scope }, mutationFn: run })
    .execute(undefined);

/** A send has the text: the box can't be changed. */
export const held = (state: BoxState) => state.preparing || sending(state);

/** The core holds the text for a send. */
export const sending = (state: BoxState) =>
  state.sending || state.draft.state === "sending";

/** The draft in the core's refusal, when it has one. */
const draftIn = (error: unknown) => {
  const body =
    typeof error === "object" && error !== null && "body" in error
      ? error.body
      : undefined;
  const found = Schema.decodeUnknownOption(NotDone)(body);
  return found._tag === "Some" ? found.value.draft : undefined;
};

export function draftBox(api: DraftApi) {
  const store = createStore<BoxState>(() => ({
    text: "",
    draft: { text: "", state: "editable" },
    loaded: false,
    preparing: false,
    sending: false,
    failed: false,
    notice: null,
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let following = false;

  /** The draft as the core has it now, shown as it is. */
  const show = (draft: Draft, notice: string | null = null) => {
    store.setState({ draft, text: draft.text, failed: false, notice });
    if (draft.state === "sending") void follow();
  };

  /** Reads the draft until it is read and no send holds it. */
  async function follow(): Promise<void> {
    if (following) return;
    following = true;
    let missed = false;
    try {
      for (;;) {
        try {
          const draft = Schema.decodeUnknownSync(Draft)(
            await api.call("GET", "draft"),
          );
          store.setState({
            draft,
            text: draft.text,
            loaded: true,
            ...(missed && { notice: null }),
          });
          if (draft.state !== "sending") return;
          missed = false;
        } catch (error) {
          // Said in the box; asked again in a moment.
          missed = true;
          store.setState({ notice: messageOf(error) });
        }
        await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      }
    } finally {
      following = false;
    }
  }

  void follow();

  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), PAUSE_MS);
  };

  /**
   * Saves the text if it changed, or the last save failed, after this box's
   * earlier saves. A send holding the draft refuses it: the box shows it.
   */
  function save(): Promise<void> {
    clearTimeout(timer);
    return inTurn(api.client, api.scope, async () => {
      const state = store.getState();
      const { text } = state;
      if (!state.loaded || sending(state) || tooLong(text)) return;
      if (text === state.draft.text && !state.failed) return;
      try {
        const draft = Schema.decodeUnknownSync(Draft)(
          await api.call("PUT", "draft", { text }),
        );
        store.setState({ draft, failed: false, notice: null });
      } catch (error) {
        const holding = draftIn(error);
        if (holding) show(holding);
        else store.setState({ failed: true, notice: messageOf(error) });
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
     * Sends the text, or steers it into the running reply, once the core
     * keeps it as the draft. Nothing is sent when it couldn't be saved.
     */
    async submit(steer: boolean): Promise<void> {
      const state = store.getState();
      const { text } = state;
      if (!state.loaded || held(state) || tooLong(text) || text.trim() === "") {
        return;
      }
      store.setState({ preparing: true, notice: null });
      await save();
      const { draft, failed } = store.getState();
      if (failed || draft.state === "sending") {
        store.setState({ preparing: false });
        return;
      }
      store.setState({ preparing: false, sending: true });
      try {
        const sent = Schema.decodeUnknownSync(Sent)(
          await api.call("POST", steer ? "steer" : "messages", {
            text: text.trim(),
          }),
        );
        store.setState({ sending: false });
        show(sent.draft);
      } catch (error) {
        store.setState({ sending: false });
        // Without the core's answer the send may still hold the draft: the
        // box follows it until a read says how it ended.
        show(draftIn(error) ?? { text, state: "sending" }, messageOf(error));
      }
    },
  };
}

/** Longer than Rufi takes: the box says so, and it isn't saved or sent. */
export const tooLong = (text: string) => text.length > MAX_MESSAGE_CHARS;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Rufi had a problem with that.";
