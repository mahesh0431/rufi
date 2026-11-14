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
// Words that couldn't be saved stay in the tab's storage too, until a save
// or a send takes them: a new page in the same tab, as when its session
// ended while Rufi was away, shows them first and saves them. A click on a
// question card's answer is a send of its own, kept here by card until the
// chat shows it, so a card drawn again finds it (docs/adr/0036); one with
// no answer yet is kept in the tab's storage too, so after a reload its
// Retry has the same id and payload.
import {
  type Chip,
  Draft,
  MAX_MESSAGE_CHARS,
  MAX_REFS,
  Pointer,
  Sent,
  WhileReplying,
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
    path: "draft" | "messages",
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
        : {
            type: ref.type,
            id: ref.id,
            ...(ref.type === "document" &&
              ref.readAgain === true && { readAgain: true as const }),
          },
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

/** Card clicks with no answer yet, kept in this tab by card: what Retry sends. */
const KeptCards = Schema.Record(
  Schema.String,
  Schema.Struct({
    id: Schema.String,
    index: Schema.Number,
    text: Schema.String,
    kind: WhileReplying,
  }),
);

/** Words that couldn't be saved, kept in this tab: the text and its chips. */
const Unsaved = Kept.mapFields(({ text, refs }) => ({ text, refs }));
const sameChips = (a: readonly BoxChip[], b: readonly BoxChip[]) =>
  JSON.stringify(pointers(a)) === JSON.stringify(pointers(b));

/**
 * A click on a question card's answer on its way, by card: sending, no
 * answer yet; sent, the core took it, until the chat shows it; lost, no
 * answer came, so Retry sends it again by the same id and payload; refused,
 * the core's words why, the card open again. Once the chat shows its
 * message (`settle`), the card follows the chat, whatever the request did.
 */
export interface CardSend {
  id: string;
  index: number;
  text: string;
  /** As the click went while a reply ran: kept for Retry. */
  kind: WhileReplying;
  status: "sending" | "sent" | "lost" | "refused";
  why?: string;
}

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
  /** A send the core took, by id, until the chat shows it. */
  accepted: string | null;
  /** How many sends the person started: the chat follows each to its end. */
  sends: number;
  /** A send has no answer yet: appending must wait for it to be resolved. */
  unresolved: boolean;
  /** The last save failed: the text is only in this tab. */
  failed: boolean;
  /** What the person should know: why a read, save or send failed. */
  notice: string | null;
  /** Clicks on question cards' answers on their way, by card. */
  cards: Record<string, CardSend>;
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
  const unsavedKey = `rufi/unsaved/${api.scope}`;
  const cardsKey = `rufi/cards/${api.scope}`;
  /** Card clicks the tab kept with no answer: lost until the chat shows them. */
  const keptCards = (): Record<string, CardSend> => {
    try {
      const kept = api.storage?.getItem(cardsKey);
      if (!kept) return {};
      const cards = Schema.decodeUnknownSync(KeptCards)(JSON.parse(kept));
      return Object.fromEntries(
        Object.entries(cards).map(([card, send]) => [
          card,
          { ...send, status: "lost" as const },
        ]),
      );
    } catch {
      return {};
    }
  };
  const store = createStore<BoxState>(() => ({
    text: "",
    refs: [],
    draft: { text: "", refs: [] },
    loaded: false,
    sending: false,
    accepted: null,
    sends: 0,
    unresolved: false,
    failed: false,
    notice: null,
    cards: keptCards(),
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** A send whose answer was lost: the same text again keeps its id. */
  let unanswered: Kept | undefined;

  /** The person sent something: the chat follows it. */
  function counted(): void {
    store.setState((state) => ({ sends: state.sends + 1 }));
  }

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

  /** Keeps words that couldn't be saved in this tab; none when `text` is undefined. */
  function keepUnsaved(text?: string, refs?: readonly BoxChip[]): void {
    try {
      if (text === undefined) api.storage?.removeItem(unsavedKey);
      else api.storage?.setItem(unsavedKey, JSON.stringify({ text, refs }));
    } catch (error) {
      // The box still says Not saved, with Retry.
      store.setState({ notice: messageOf(error) });
    }
  }

  /** Reads the draft until it is read. */
  async function load(): Promise<void> {
    for (;;) {
      try {
        const saved = api.storage?.getItem(sendKey);
        unanswered = saved
          ? Schema.decodeUnknownSync(Kept)(JSON.parse(saved))
          : undefined;
        const left = api.storage?.getItem(unsavedKey);
        const unsaved = left
          ? Schema.decodeUnknownSync(Unsaved)(JSON.parse(left))
          : undefined;
        const draft = Schema.decodeUnknownSync(Draft)(
          await api.call("GET", "draft"),
        );
        const mine = unanswered ?? unsaved;
        store.setState({
          draft,
          text: mine?.text ?? draft.text,
          refs: mine?.refs ? [...mine.refs] : shown(draft.refs),
          loaded: true,
          unresolved: unanswered !== undefined,
          failed: unanswered === undefined && unsaved !== undefined,
          notice: null,
        });
        if (unanswered === undefined && unsaved !== undefined) void save();
        return;
      } catch (error) {
        // Said in the box; asked again in a moment.
        store.setState({ notice: messageOf(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
    }
  }

  void load();

  /**
   * Keeps the card clicks with no answer yet in this tab, as they went;
   * false when the tab can't keep them.
   */
  function keepCards(): boolean {
    const open = Object.entries(store.getState().cards).filter(
      ([, send]) => send.status === "sending" || send.status === "lost",
    );
    try {
      if (open.length === 0) api.storage?.removeItem(cardsKey);
      else {
        api.storage?.setItem(
          cardsKey,
          JSON.stringify(
            Object.fromEntries(
              open.map(([card, { id, index, text, kind }]) => [
                card,
                { id, index, text, kind },
              ]),
            ),
          ),
        );
      }
      return true;
    } catch {
      return false;
    }
  }

  const setCard = (card: string, send: CardSend): boolean => {
    store.setState((state) => ({ cards: { ...state.cards, [card]: send } }));
    return keepCards();
  };

  /**
   * Sends a card's click; the chat follows it once the core took it. A
   * send the chat already shows (settled) ignores its request's late end.
   */
  async function go(card: string, send: CardSend): Promise<void> {
    // Kept in the tab before it goes; if it can't be, it doesn't go.
    if (!setCard(card, send)) {
      setCard(card, { ...send, status: "refused", why: "" });
      return;
    }
    const { id, index, text, kind } = send;
    const current = () => store.getState().cards[card]?.id === id;
    try {
      await api.call("POST", "messages", {
        id,
        text,
        refs: [{ type: "question", id: card, answer: index }],
        kind,
        draft: "keep",
      });
      if (!current()) return;
      setCard(card, { ...send, status: "sent" });
      store.setState({ accepted: id });
      counted();
    } catch (error) {
      if (!current()) return;
      setCard(
        card,
        answered(error)
          ? { ...send, status: "refused", why: messageOf(error) }
          : { ...send, status: "lost" },
      );
    }
  }

  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), PAUSE_MS);
  };

  /** Saves the text if it changed, or the last save failed, after this box's earlier saves. */
  function save(keepNotice = false): Promise<void> {
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
          refs: now.map((chip) => {
            const named = shown(draft.refs).find(
              (c) => chipKey(c) === chipKey(chip),
            );
            return named ? { ...named, pointer: chip.pointer } : chip;
          }),
          failed: false,
          ...(!keepNotice && { notice: null }),
        });
        keepUnsaved();
      } catch (error) {
        store.setState({ failed: true, notice: messageOf(error) });
        keepUnsaved(text, refs);
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

    /**
     * A waiting message the person sent or steered, or one they chose how
     * to send again: the chat follows it, as it follows the box's own.
     */
    sent: counted,

    /**
     * A click on answer `index` (its words `text`) of question card `card`:
     * the person's message, quoting the card with the answer it chose,
     * under a new id, as Enter in the box would while a reply runs (`kind`).
     * The box's text and draft stay. Nothing while the card's last click is
     * on its way or unresolved.
     */
    choose(
      card: string,
      index: number,
      text: string,
      kind: WhileReplying,
    ): Promise<void> {
      const was = store.getState().cards[card];
      if (was && was.status !== "refused") return Promise.resolve();
      return go(card, { id: newId(), index, text, kind, status: "sending" });
    },

    /**
     * Sends a card's lost click again: the same id, answer and way it went
     * while a reply ran, whatever Settings says now.
     */
    retry(card: string): Promise<void> {
      const was = store.getState().cards[card];
      if (was?.status !== "lost") return Promise.resolve();
      return go(card, { ...was, status: "sending" });
    },

    /**
     * The chat has these messages (`has`: its entries and queue rows, any
     * state): a card's send among them is the core's now, whatever its
     * request said or will say, and the card follows the chat.
     */
    settle(has: (id: string) => boolean): void {
      const { cards } = store.getState();
      const done = Object.keys(cards).filter((card) => {
        const send = cards[card];
        return send !== undefined && has(send.id);
      });
      if (done.length === 0) return;
      store.setState((state) => ({
        cards: Object.fromEntries(
          Object.entries(state.cards).filter(([card]) => !done.includes(card)),
        ),
      }));
      keepCards();
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
      const merged = new Map(state.refs.map((chip) => [chipKey(chip), chip]));
      for (const chip of chips) {
        const before = merged.get(chipKey(chip));
        if (
          !before ||
          (chip.pointer.type === "document" && chip.pointer.readAgain === true)
        )
          merged.set(chipKey(chip), chip);
      }
      store.setState({
        text:
          text === ""
            ? state.text
            : before === ""
              ? text
              : `${before}\n\n${text}`,
        refs: [...merged.values()],
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
     * Sends the text; while a reply runs, into it (steer) or after it
     * (queue). The box empties when the core took it; a refusal leaves the
     * text with the reason.
     */
    async submit(kind?: WhileReplying): Promise<void> {
      const state = store.getState();
      const text = state.text.trim();
      if (
        !state.loaded ||
        state.sending ||
        tooLong(text) ||
        tooMany(state.refs) ||
        (text === "" && state.refs.length === 0)
      ) {
        return;
      }
      clearTimeout(timer);
      store.setState({ sending: true, notice: null });
      counted();
      const id = unanswered?.text === text ? unanswered.id : newId();
      await inTurn(api.client, api.scope, async () => {
        try {
          if (!remember({ id, text, refs: state.refs })) return;
          const sent = Schema.decodeUnknownSync(Sent)(
            await api.call("POST", "messages", {
              id,
              text,
              refs: pointers(state.refs),
              ...(kind && { kind }),
            }),
          );
          forget();
          keepUnsaved();
          store.setState({
            sending: false,
            accepted: id,
            draft: sent.draft,
            text: sent.draft.text,
            refs: shown(sent.draft.refs),
            failed: false,
          });
        } catch (error) {
          if (answered(error)) forget();
          store.setState({ sending: false, notice: messageOf(error) });
          void save(true);
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
