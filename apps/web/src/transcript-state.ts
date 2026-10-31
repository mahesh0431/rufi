// The chat's transcript as the screens hold it: the latest page and the older
// pages loaded since, and how each line of the live stream and each older
// page change it, and what it shows in order. Each entry and turn keeps the
// chat's revision it was read at, so a read that comes late never replaces a
// newer one.
import type { Chat, Entry, Page, StreamLine, Turn } from "@rufi/contracts";
import { dayOf } from "./dates.ts";

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

/** A reply that ended without completing says how. */
const cut = (turn: Turn) =>
  turn.status !== "running" && turn.status !== "completed";

/**
 * Whether an entry is part of its reply's Activity: the AI's thinking, its
 * notes and its steps; not a compaction (a quiet line of its own) or a
 * picture the reply shows.
 */
export const inActivity = (entry: Entry) =>
  entry.kind === "reasoning" ||
  (entry.kind === "activity" &&
    entry.activity !== "compaction" &&
    !(
      entry.activity === "picture" &&
      entry.status === "done" &&
      entry.detail !== null
    ));

/**
 * What the transcript shows, in order, each as a key: "d:" a day's line
 * before an entry, "a:" a new thread started for a turn, "k:" a compaction
 * running, "c:" a compaction completed, "e:" an entry, "s:" a turn's
 * Activity, "x:" how a turn ended. A turn's Activity takes the place of its
 * first line while it runs, and sits under its answer once it ended, also
 * when its steps are gone. Keys, so the list draws again only when what it
 * shows changes.
 */
export function lines(state: Transcript): string[] {
  const { order, entries } = state;
  const first = new Map<string, string>();
  const last = new Map<string, string>();
  const lastReply = new Map<string, string>();
  const firstStep = new Map<string, string>();
  for (const id of order) {
    const entry = entries[id];
    if (!entry?.turnId) continue;
    if (!first.has(entry.turnId)) first.set(entry.turnId, id);
    last.set(entry.turnId, id);
    if (entry.kind === "reply") lastReply.set(entry.turnId, id);
    if (inActivity(entry) && !firstStep.has(entry.turnId)) {
      firstStep.set(entry.turnId, id);
    }
  }
  /** Lines before an entry, and after one ("": before them all). */
  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  const add = (to: Map<string, string[]>, at: string, line: string) => {
    to.set(at, [...(to.get(at) ?? []), line]);
  };
  const turns = Object.values(state.turns).toSorted((a, b) =>
    a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
  );
  for (const turn of turns) {
    const opens = first.get(turn.id);
    const closes = last.get(turn.id);
    if (opens === undefined || closes === undefined) {
      // Nothing of it was stored: its lines go where it started.
      const at =
        order.findLast(
          (id) => (entries[id]?.createdAt ?? "") <= turn.startedAt,
        ) ?? "";
      if (turn.newThread) add(after, at, `a:${turn.id}`);
      if (turn.cause) add(after, at, `w:${turn.id}`);
      if (cut(turn)) add(after, at, `x:${turn.id}`);
      continue;
    }
    if (turn.newThread) add(before, opens, `a:${turn.id}`);
    if (turn.cause) add(before, opens, `w:${turn.id}`);
    const step = firstStep.get(turn.id);
    const answer = lastReply.get(turn.id);
    if (turn.status !== "running" && answer !== undefined) {
      // Its steps went with the agent database: its Activity says so.
      if (step !== undefined || turn.stepsGone === true) {
        add(after, answer, `s:${turn.id}`);
      }
    } else if (step !== undefined) add(before, step, `s:${turn.id}`);
    if (cut(turn)) add(after, closes, `x:${turn.id}`);
  }
  const shown = [...(after.get("") ?? [])];
  let day = "";
  for (const id of order) {
    const entry = entries[id];
    if (!entry) continue;
    shown.push(...(before.get(id) ?? []));
    // A line of a turn's Activity shows in it.
    const stepOf = entry.turnId !== null && state.turns[entry.turnId];
    if (!(stepOf && inActivity(entry))) {
      const today = dayOf(entry.createdAt);
      if (today !== day) shown.push(`d:${id}`);
      day = today;
      if (entry.activity === "compaction") {
        // One running shows until it ends; one cut (a Stop, a crash) shows
        // nothing.
        if (entry.status === "running") shown.push(`k:${id}`);
        if (entry.status === "done") shown.push(`c:${id}`);
      } else shown.push(`e:${id}`);
    }
    shown.push(...(after.get(id) ?? []));
  }
  return shown;
}
