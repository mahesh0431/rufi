// The chat's transcript as the screens hold it: the latest page and the older
// pages loaded since, and how each line of the live stream and each older
// page change it. Each entry and turn keeps the chat's revision it was read
// at, so a read that comes late never replaces a newer one.
import type { Chat, Entry, Page, StreamLine, Turn } from "@rufi/contracts";

export interface Transcript {
  chat: Chat | null;
  entries: Readonly<Record<string, Entry>>;
  /** Entry ids in transcript order. */
  order: readonly string[];
  turns: Readonly<Record<string, Turn>>;
  /** The chat's revision each entry and turn was read at, by id. */
  seen: Readonly<Record<string, number>>;
  /** The next older page holds the entries before this seq; null: none. */
  before: number | null;
  /**
   * One more with each snapshot (opening, a reconnect): an older page read
   * for an earlier one is dropped.
   */
  window: number;
}

export const emptyTranscript: Transcript = {
  chat: null,
  entries: {},
  order: [],
  turns: {},
  seen: {},
  before: null,
  window: 0,
};

/**
 * A stream line applied to the transcript. A snapshot replaces it with the
 * latest page; an update replaces entries and turns by id. Entries it
 * doesn't change stay the same objects, and the order stays the same array
 * unless an entry was added.
 */
export function apply(state: Transcript, line: StreamLine): Transcript {
  if (line.type === "snapshot") {
    return {
      chat: line.chat,
      entries: byId(line.entries),
      order: inOrder(line.entries),
      turns: byId(line.turns),
      seen: seenAt([...line.entries, ...line.turns], line.revision),
      before: line.before,
      window: state.window + 1,
    };
  }
  if (line.type !== "update") return state;
  const merged = merge(state, line.entries, line.turns, line.revision);
  return line.chat ? { ...merged, chat: line.chat } : merged;
}

/**
 * An older page, asked for in `window`: what it holds is added, unless a
 * newer read already shows it. After a reconnect it changes nothing.
 */
export function addOlder(
  state: Transcript,
  page: Page,
  window: number,
): Transcript {
  if (window !== state.window) return state;
  return {
    ...merge(state, page.entries, page.turns, page.revision),
    before: page.before,
  };
}

function merge(
  state: Transcript,
  entries: readonly Entry[],
  turns: readonly Turn[],
  revision: number,
): Transcript {
  const fresh = <T extends { id: string }>(items: readonly T[]) =>
    items.filter((item) => (state.seen[item.id] ?? -1) <= revision);
  const newEntries = fresh(entries);
  const newTurns = fresh(turns);
  if (newEntries.length === 0 && newTurns.length === 0) return state;
  const all = { ...state.entries, ...byId(newEntries) };
  const added = newEntries.some((entry) => !(entry.id in state.entries));
  return {
    ...state,
    entries: all,
    order: added ? inOrder(Object.values(all)) : state.order,
    turns: { ...state.turns, ...byId(newTurns) },
    seen: { ...state.seen, ...seenAt([...newEntries, ...newTurns], revision) },
  };
}

const byId = <T extends { id: string }>(items: readonly T[]) =>
  Object.fromEntries(items.map((item) => [item.id, item]));
const seenAt = (items: readonly { id: string }[], revision: number) =>
  Object.fromEntries(items.map((item) => [item.id, revision]));
const inOrder = (entries: readonly Entry[]) =>
  [...entries].sort((a, b) => a.seq - b.seq).map((entry) => entry.id);

/** Whether a reply is running in the chat. */
export const isRunning = (state: Transcript) =>
  Object.values(state.turns).some((turn) => turn.status === "running");
