import type { Entry, Page, Turn } from "@rufi/contracts";
import { describe, expect, it } from "vitest";
import { addOlder, apply, emptyTranscript, lines } from "./transcript-state.ts";

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
});
