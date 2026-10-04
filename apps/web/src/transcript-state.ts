// A conversation's transcript as the screens hold it, and how each line of
// its live stream changes it.
import type { Conversation, Entry, StreamLine, Turn } from "@rufi/contracts";

export interface Transcript {
  conversation: Conversation | null;
  entries: Readonly<Record<string, Entry>>;
  /** Entry ids in transcript order. */
  order: readonly string[];
  turns: Readonly<Record<string, Turn>>;
}

/**
 * A stream line applied to the transcript. A snapshot replaces it; an update
 * replaces entries and turns by id. Entries it doesn't change stay the same
 * objects, and the order stays the same array unless an entry was added.
 */
export function apply(state: Transcript, line: StreamLine): Transcript {
  if (line.type === "snapshot") {
    return {
      conversation: line.conversation,
      entries: byId(line.entries),
      order: inOrder(line.entries),
      turns: byId(line.turns),
    };
  }
  if (line.type !== "update") return state;
  const entries = { ...state.entries, ...byId(line.entries) };
  const added = line.entries.some((entry) => !(entry.id in state.entries));
  return {
    conversation: line.conversation ?? state.conversation,
    entries,
    order: added ? inOrder(Object.values(entries)) : state.order,
    turns: { ...state.turns, ...byId(line.turns) },
  };
}

const byId = <T extends { id: string }>(items: readonly T[]) =>
  Object.fromEntries(items.map((item) => [item.id, item]));
const inOrder = (entries: readonly Entry[]) =>
  [...entries].sort((a, b) => a.seq - b.seq).map((entry) => entry.id);

/** Whether a reply is running in the conversation. */
export const isRunning = (state: Transcript) =>
  Object.values(state.turns).some((turn) => turn.status === "running");
