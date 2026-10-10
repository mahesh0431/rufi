// The box's text, kept by the core as the chat's draft, and its send. Saves
// go one after another (one mutation scope per box), a moment after the
// typing stops, and at once when the box leaves the screen, silently; the
// box says only Not saved (with Retry). The last save wins: two tabs typing
// at once replace each other's text. Nothing is saved as the page closes,
// so what was typed since the last save can be lost then. A send goes after
// the box's earlier saves, by an id of its own: the core moves the text into
// the queue and empties the draft in one step. When its answer is lost, the
// tab keeps the id and text through reloads, so an explicit retry uses the
// same id and the core never takes it twice. Autosaves skip that text.
// Nothing here sends a message by itself. The box's chips (references to
// health data) are kept with its text: saved, sent and cleared with it.
import {
  type Chip,
  Draft,
  MAX_MESSAGE_CHARS,
  MAX_REFS,
  Pointer,
  Sent,
} from "@rufi/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { createStore } from "zustand/vanilla";

export interface DraftApi {
  /**
   * One request to the chat's API: the core's JSON answer, or an error with
   * the core's answer as its `body` when it answered.
   */
  call: (
    method: "GET" | "PUT" | "POST",
    path: "draft" | "messages" | "steer",
    body?: unknown,
  ) => Promise<unknown>;
  /** The queries' client, and this box's name: its saves run in turn. */
  client: QueryClient;
  scope: string;
  /** A new id for a send. */
  newId?: () => string;
  /** This tab's storage: an unresolved send survives a reload. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/** A chip in the box: what it points at, and its name and hover text. */
export interface BoxChip {
  pointer: Pointer;
  label: string;
  detail: string;
}

/** A chip's identity: the same thing is one chip. */
export const chipKey = ({ pointer }: Pick<BoxChip, "pointer">) =>
  `${pointer.type}:${pointer.type === "record" ? `${pointer.kind}:` : ""}${pointer.id}`;

/** The box's chips from the core's. */
const shown = (chips: readonly Chip[]): BoxChip[] =>
  chips.map(({ ref, label, detail }) => ({
    pointer:
      ref.type === "record"
        ? { type: ref.type, kind: ref.kind, id: ref.id }
        : { type: ref.type, id: ref.id },
    label,
    detail,
  }));

const pointers = (chips: readonly BoxChip[]) => chips.map((c) => c.pointer);

/** A send kept in this tab's storage: its id, text and chips. */
const Kept = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  refs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        pointer: Pointer,
        label: Schema.String,
        detail: Schema.String,
      }),
    ),
  ),
});
type Kept = typeof Kept.Type;
const sameChips = (a: readonly BoxChip[], b: readonly BoxChip[]) =>
  a.map(chipKey).join("\n") === b.map(chipKey).join("\n");

export interface BoxState {
  text: string;
  /** The box's chips, in the order they were added. */
  refs: BoxChip[];
  /** The draft as the core has it, as far as the box knows. */
  draft: Draft;
  /** The draft is read: until then the box can't be typed in. */
  loaded: boolean;
  /** A send is on its way: the box can't change meanwhile. */
  sending: boolean;
  /** A send has no answer yet: appending must wait for it to be resolved. */
  unresolved: boolean;
  /** The last save failed: the text is only in this tab. */
  failed: boolean;
  /** What the person should know: why a read, save or send failed. */
  notice: string | null;
}

export type DraftBox = ReturnType<typeof draftBox>;

/** How long after the last key the box saves. */
const PAUSE_MS = 400;
/** How often a box reads a draft it couldn't read. */
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
export const held = (state: BoxState) => state.sending;

/** Whether the core answered the request that failed (it refused it). */
const answered = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "body" in error &&
  error.body !== undefined;

export function draftBox(api: DraftApi) {
  const newId = api.newId ?? (() => crypto.randomUUID());
  const sendKey = `rufi/send/${api.scope}`;
  const store = createStore<BoxState>(() => ({
    text: "",
    refs: [],
    draft: { text: "", refs: [] },
    loaded: false,
    sending: false,
    unresolved: false,
    failed: false,
    notice: null,
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** A send whose answer was lost: the same text again keeps its id. */
  let unanswered: Kept | undefined;

  /** Keeps the send's identity before it goes; if storage fails, it doesn't go. */
  function remember(send: Kept): boolean {
    try {
      api.storage?.setItem(sendKey, JSON.stringify(send));
      unanswered = send;
      store.setState({ unresolved: true });
      return true;
    } catch (error) {
      store.setState({ sending: false, notice: messageOf(error) });
      return false;
    }
  }

  function forget(): void {
    api.storage?.removeItem(sendKey);
    unanswered = undefined;
    store.setState({ unresolved: false });
  }

  /** Reads the draft until it is read. */
  async function load(): Promise<void> {
    for (;;) {
      try {
        const saved = api.storage?.getItem(sendKey);
        unanswered = saved
          ? Schema.decodeUnknownSync(Kept)(JSON.parse(saved))
          : undefined;
        const draft = Schema.decodeUnknownSync(Draft)(
          await api.call("GET", "draft"),
        );
        store.setState({
          draft,
          text: unanswered?.text ?? draft.text,
          refs: unanswered?.refs ? [...unanswered.refs] : shown(draft.refs),
          loaded: true,
          unresolved: unanswered !== undefined,
          notice: null,
        });
        return;
      } catch (error) {
        // Said in the box; asked again in a moment.
        store.setState({ notice: messageOf(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    }
  }

  void load();

  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), PAUSE_MS);
  };

  /** Saves the text if it changed, or the last save failed, after this box's earlier saves. */
  function save(): Promise<void> {
    clearTimeout(timer);
    return inTurn(api.client, api.scope, async () => {
      const state = store.getState();
      const { text, refs } = state;
      if (!state.loaded || state.sending || tooLong(text) || tooMany(refs)) {
        return;
      }
      if (unanswered?.text === text.trim()) return;
      // Saving different text replaces the uncertain send with a new draft.
      forget();
      if (
        text === state.draft.text &&
        sameChips(refs, shown(state.draft.refs)) &&
        !state.failed
      ) {
        return;
      }
      try {
        const draft = Schema.decodeUnknownSync(Draft)(
          await api.call("PUT", "draft", { text, refs: pointers(refs) }),
        );
        // The core names the chips; ones taken out meanwhile stay out.
        const now = store.getState().refs;
        store.setState({
          draft,
          refs: now.map(
            (chip) =>
              shown(draft.refs).find((c) => chipKey(c) === chipKey(chip)) ??
              chip,
          ),
          failed: false,
          notice: null,
        });
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
      if (!state.loaded || state.sending) return;
      store.setState({ text, notice: null });
      later();
    },

    /** Saves now what isn't saved yet: Retry, or the box leaves the screen. */
    saveNow: save,

    /**
     * Puts `text` in the box after what it holds, as if typed, and `chips`
     * after its chips (one already there stays once), and saves it now.
     * False, with nothing changed, before the draft is read or while a send
     * holds the box or has an unresolved answer.
     */
    append(text: string, chips: readonly BoxChip[] = []): boolean {
      const state = store.getState();
      if (!state.loaded || state.sending || state.unresolved) return false;
      const before = state.text.trimEnd();
      const keys = new Set(state.refs.map(chipKey));
      store.setState({
        text:
          text === ""
            ? state.text
            : before === ""
              ? text
              : `${before}\n\n${text}`,
        refs: [...state.refs, ...chips.filter((c) => !keys.has(chipKey(c)))],
        notice: null,
      });
      void save();
      return true;
    },

    /** Takes a chip out of the box; nothing it points at changes. */
    remove(chip: Pick<BoxChip, "pointer">): void {
      const state = store.getState();
      if (!state.loaded || state.sending || state.unresolved) return;
      store.setState({
        refs: state.refs.filter((c) => chipKey(c) !== chipKey(chip)),
      });
      void save();
    },

    /**
     * Sends the text into the queue, or steers it into the running reply.
     * The box empties when the core took it; a refusal leaves the text with
     * the reason.
     */
    async submit(steer: boolean): Promise<void> {
      const state = store.getState();
      const text = state.text.trim();
      if (
        !state.loaded ||
        state.sending ||
        tooLong(text) ||
        tooMany(state.refs) ||
        text === ""
      ) {
        return;
      }
      clearTimeout(timer);
      store.setState({ sending: true, notice: null });
      // A steer is never sent twice: a lost answer's text gets a new id.
      const id = !steer && unanswered?.text === text ? unanswered.id : newId();
      await inTurn(api.client, api.scope, async () => {
        try {
          if (!steer && !remember({ id, text, refs: state.refs })) return;
          const sent = Schema.decodeUnknownSync(Sent)(
            await api.call("POST", steer ? "steer" : "messages", {
              id,
              text,
              refs: pointers(state.refs),
            }),
          );
          forget();
          store.setState({
            sending: false,
            draft: sent.draft,
            text: sent.draft.text,
            refs: shown(sent.draft.refs),
            failed: false,
          });
        } catch (error) {
          if (answered(error) || steer) forget();
          store.setState({ sending: false, notice: messageOf(error) });
        }
      });
    },
  };
}

/** Longer than Rufi takes: the box says so, and it isn't saved or sent. */
export const tooLong = (text: string) => text.length > MAX_MESSAGE_CHARS;
export const tooMany = (refs: readonly unknown[]) => refs.length > MAX_REFS;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Rufi had a problem with that.";
