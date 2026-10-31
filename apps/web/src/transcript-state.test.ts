import type { Entry, Page, QueueItem, Turn } from "@rufi/contracts";
import { describe, expect, it } from "vitest";
import {
  addOlder,
  apply,
  clockOf,
  emptyTranscript,
  goingNow,
  lines,
  workingOf,
} from "./transcript-state.ts";

const at = "2026-10-04T10:00:00.000Z";
const entry = (
  id: string,
  seq: number,
  text: string,
  turnId = "t1",
): Entry => ({
  id,
  seq,
  turnId,
  kind: "reply",
  text,
  activity: null,
  detail: null,
  status: null,
  createdAt: at,
  updatedAt: at,
});
const turn = (status: Turn["status"], id = "t1"): Turn => ({
  id,
  model: "gpt-6.1-sol",
  effort: "medium",
  before: null,
  status,
  endReason: null,
  endText: null,
  resetsAt: null,
  startedAt: at,
  endedAt: null,
  newThread: false,
});
const chat = { model: "gpt-6.1-sol", effort: "medium", context: null } as const;
const page = (
  revision: number,
  entries: Entry[],
  turns: Turn[],
  before: number | null,
): Page => ({ revision, chat, entries, turns, before });

describe("the chat's live stream", () => {
  it("shows the latest page as it is, also over what was loaded before a reconnect", () => {
    const before = apply(emptyTranscript, {
      type: "snapshot",
      ...page(3, [entry("a", 1, "Hel"), entry("b", 2, "gone")], [], null),
      turns: [turn("running")],
    });
    const older = addOlder(
      before,
      page(3, [entry("old", 0, "Older")], [], null),
      before.window,
    );
    const after = apply(older, {
      type: "snapshot",
      ...page(9, [entry("c", 3, "third"), entry("a", 1, "Hello")], [], 1),
      turns: [turn("completed")],
    });
    expect(after.order).toEqual(["a", "c"]);
    expect(after.entries).toEqual({
      a: entry("a", 1, "Hello"),
      c: entry("c", 3, "third"),
    });
    expect(after.turns["t1"]?.status).toBe("completed");
    expect(after.before).toBe(1);
  });

  it("replaces entries and turns by id, adds new ones in order, and leaves the rest as they were", () => {
    const shown = apply(emptyTranscript, {
      type: "snapshot",
      ...page(1, [entry("a", 1, "Question"), entry("b", 2, "o")], [], null),
      turns: [turn("running")],
    });
    const grown = apply(shown, {
      type: "update",
      revision: 2,
      entries: [entry("b", 2, "ok")],
      turns: [],
    });
    expect(grown.entries["b"]?.text).toBe("ok");
    // Only the reply that changed is new: the others don't draw again.
    expect(grown.entries["a"]).toBe(shown.entries["a"]);
    expect(grown.order).toBe(shown.order);

    const ended = apply(grown, {
      type: "update",
      revision: 3,
      entries: [entry("c", 3, "Ran a command")],
      turns: [turn("completed")],
    });
    expect(ended.order).toEqual(["a", "b", "c"]);
    expect(ended.turns["t1"]?.status).toBe("completed");
  });

  it("takes a new model from an update, and keeps it otherwise", () => {
    const shown = apply(emptyTranscript, {
      type: "snapshot",
      ...page(0, [], [], null),
    });
    const changed = apply(shown, {
      type: "update",
      revision: 1,
      entries: [],
      turns: [],
      chat: { model: "gpt-6-astra", effort: "medium", context: null },
    });
    expect(changed.chat?.model).toBe("gpt-6-astra");
    const later = apply(changed, {
      type: "update",
      revision: 2,
      entries: [entry("a", 1, "Hi")],
      turns: [],
    });
    expect(later.chat?.model).toBe("gpt-6-astra");
  });
});

describe("older pages", () => {
  it("are added before what is shown, and never replace what a newer read showed", () => {
    // The latest page, read at revision 10: a reply still running.
    const shown = apply(emptyTranscript, {
      type: "snapshot",
      ...page(10, [entry("c", 30, "Streaming")], [turn("running")], 20),
    });
    // An older page read at revision 8 has an older copy of the same turn.
    const older = addOlder(
      shown,
      page(
        8,
        [entry("a", 10, "First", "t0"), entry("b", 20, "Second", "t0")],
        [turn("completed", "t0"), turn("failed")],
        null,
      ),
      shown.window,
    );
    expect(older.order).toEqual(["a", "b", "c"]);
    expect(older.turns["t1"]?.status).toBe("running");
    expect(older.turns["t0"]?.status).toBe("completed");
    expect(older.before).toBeNull();
    // A page read after the stream's last update is the newer copy, and a
    // late update older than it changes nothing.
    const newer = addOlder(
      shown,
      page(12, [entry("c", 30, "Streaming more")], [], 5),
      shown.window,
    );
    const late = apply(newer, {
      type: "update",
      revision: 11,
      entries: [entry("c", 30, "Stream")],
      turns: [],
    });
    expect(late.entries["c"]?.text).toBe("Streaming more");
  });

  it("asked for before a reconnect change nothing when they come after it", () => {
    const shown = apply(emptyTranscript, {
      type: "snapshot",
      ...page(10, [entry("c", 30, "Latest")], [], 20),
    });
    const asked = shown.window;
    const reconnected = apply(shown, {
      type: "snapshot",
      ...page(12, [entry("c", 30, "Latest"), entry("d", 31, "New")], [], 20),
    });
    const late = addOlder(
      reconnected,
      page(9, [entry("a", 10, "Older")], [], null),
      asked,
    );
    expect(late).toBe(reconnected);
    expect(late.before).toBe(20);
  });
});

describe("what the transcript shows", () => {
  it("keeps a reply's Activity under it when its steps are gone, and gives a reply without steps none", () => {
    const shown = apply(emptyTranscript, {
      type: "snapshot",
      ...page(
        1,
        [entry("a", 1, "Asha's last HbA1c"), entry("b", 2, "Hello", "t2")],
        [{ ...turn("completed"), stepsGone: true }, turn("completed", "t2")],
        null,
      ),
    });
    expect(lines(shown).filter((line) => !line.startsWith("d:"))).toEqual([
      "e:a",
      "s:t1",
      "e:b",
    ]);
  });

  it("gives a running reply its working line from its start: after its message before a step, in a step's place after", () => {
    const message = {
      ...entry("m", 1, "Asha's TSH"),
      kind: "message" as const,
    };
    const thinking = apply(emptyTranscript, {
      type: "snapshot",
      ...page(1, [message], [turn("running")], null),
    });
    expect(lines(thinking).filter((line) => !line.startsWith("d:"))).toEqual([
      "e:m",
      "s:t1",
    ]);
    const stepped = apply(thinking, {
      type: "update",
      revision: 2,
      entries: [
        {
          ...entry("r", 2, "Reading the record"),
          kind: "reasoning",
          status: "running",
        },
      ],
      turns: [],
    });
    expect(lines(stepped).filter((line) => !line.startsWith("d:"))).toEqual([
      "e:m",
      "s:t1",
    ]);
  });
});

describe("the Model changed line", () => {
  it("shows before a reply on another model or effort than the one before, never for a new thread alone, and only for a new model after a reply whose effort is unknown", () => {
    const ran = (
      id: string,
      seq: number,
      now: [string, string | null],
      before: [string, string | null] | null,
      newThread = false,
    ) => ({
      entry: {
        ...entry(`e-${id}`, seq, "Asha's question", id),
        kind: "message" as const,
      },
      turn: {
        ...turn("completed", id),
        startedAt: `2026-10-04T10:0${String(seq)}:00.000Z`,
        model: now[0],
        effort: now[1],
        before: before && { model: before[0], effort: before[1] },
        newThread,
      },
    });
    const replies = [
      ran("old", 1, ["gpt-6.1-sol", null], null),
      // Its effort was unknown: the same model says nothing.
      ran("t2", 2, ["gpt-6.1-sol", "high"], ["gpt-6.1-sol", null]),
      // Only the effort changed.
      ran("t3", 3, ["gpt-6.1-sol", "xhigh"], ["gpt-6.1-sol", "high"]),
      // A new thread on the same model and effort.
      ran("t4", 4, ["gpt-6.1-sol", "xhigh"], ["gpt-6.1-sol", "xhigh"], true),
      ran("t5", 5, ["claude-opus-5-5", "high"], ["gpt-6.1-sol", "xhigh"]),
    ];
    const shown = apply(emptyTranscript, {
      type: "snapshot",
      ...page(
        1,
        replies.map((one) => one.entry),
        replies.map((one) => one.turn),
        null,
      ),
    });
    expect(lines(shown).filter((line) => line.startsWith("m:"))).toEqual([
      "m:t3",
      "m:t5",
    ]);
    const order = lines(shown).filter((line) => !line.startsWith("d:"));
    expect(order.indexOf("m:t5") + 1).toBe(order.indexOf("e:e-t5"));
  });
});

describe("the working status", () => {
  const item = (held: QueueItem["held"] = null): QueueItem => ({
    id: "q1",
    origin: "person",
    text: "And my Free T4?",
    state: "waiting",
    held,
    heldText: null,
    holdId: null,
    refs: [],
  });
  const state = (turns: Turn[], items: QueueItem[] = []) => ({
    turns: Object.fromEntries(turns.map((one) => [one.id, one])),
    queue: { items },
  });

  it("starts with your send, goes on while Rufi hands it over, and is the running reply's once it runs, also with a message queued", () => {
    expect(workingOf(state([]), true)).toEqual({ kind: "starting" });
    expect(workingOf(state([], [item()]), false)).toEqual({
      kind: "starting",
    });
    expect(
      workingOf(
        state([turn("completed"), turn("running", "t2")], [item()]),
        true,
      ),
    ).toEqual({ kind: "turn", id: "t2", startedAt: at });
  });

  it("shows your message Rufi is giving to the AI as sent: the first free one when nothing runs, or one being handed over; not once the chat has it", () => {
    const going = (
      turns: Turn[],
      items: QueueItem[],
      entries: Record<string, Entry> = {},
    ) => goingNow({ ...state(turns, items), entries }).map((one) => one.id);
    const second = { ...item(), id: "q2" };
    expect(going([], [item(), second])).toEqual(["q1"]);
    expect(going([turn("running")], [item(), second])).toEqual([]);
    expect(
      going([turn("running")], [{ ...item(), state: "handing_over" }]),
    ).toEqual(["q1"]);
    expect(going([], [item("stopped"), second])).toEqual(["q2"]);
    expect(going([], [{ ...item(), origin: "rufi" }, second])).toEqual([]);
    expect(
      going([], [item()], { q1: entry("q1", 1, "And my Free T4?") }),
    ).toEqual([]);
  });

  it("ends when the reply ends, or your message is held", () => {
    expect(workingOf(state([turn("interrupted")]), false)).toBeNull();
    expect(workingOf(state([], [item("stopped")]), false)).toBeNull();
    expect(workingOf(state([], [item("open_failed")]), false)).toBeNull();
  });

  it("keeps its start's time when the reply starts, and counts anew for the next reply", () => {
    const sent = "2026-10-04T09:59:58.000Z";
    const starting = clockOf(null, { kind: "starting" }, sent);
    expect(starting).toEqual({ key: "starting", since: sent });
    expect(
      clockOf(starting, { kind: "starting" }, "2026-10-04T09:59:59.000Z"),
    ).toBe(starting);
    const running = clockOf(
      starting,
      { kind: "turn", id: "t1", startedAt: at },
      at,
    );
    expect(running).toEqual({ key: "t1", since: sent });
    expect(
      clockOf(running, { kind: "turn", id: "t1", startedAt: at }, "later"),
    ).toBe(running);
    const next = "2026-10-04T10:01:00.000Z";
    expect(clockOf(running, { kind: "starting" }, next)).toEqual({
      key: "starting",
      since: next,
    });
    // Opened after a reload: the reply's own start.
    expect(
      clockOf(null, { kind: "turn", id: "t1", startedAt: at }, next),
    ).toEqual({ key: "t1", since: at });
    expect(clockOf(running, null, next)).toBeNull();
  });
});
