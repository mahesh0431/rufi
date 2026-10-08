import type { Entry, Turn } from "@rufi/contracts";
import { describe, expect, it } from "vitest";
import { apply, type Transcript } from "./transcript-state.ts";

const at = "2026-10-04T10:00:00.000Z";
const entry = (id: string, seq: number, text: string): Entry => ({
  id,
  seq,
  turnId: "t1",
  kind: "reply",
  text,
  activity: null,
  detail: null,
  status: null,
  createdAt: at,
  updatedAt: at,
});
const turn = (status: Turn["status"]): Turn => ({
  id: "t1",
  model: "gpt-6.1-sol",
  status,
  endReason: null,
  endText: null,
  resetsAt: null,
  startedAt: at,
  endedAt: null,
  how: null,
  used: [],
});
const conversation = {
  id: "c1",
  title: null,
  provider: "codex",
  model: "gpt-6.1-sol",
  createdAt: at,
};
const empty: Transcript = {
  conversation: null,
  entries: {},
  order: [],
  turns: {},
};

describe("a conversation's live stream", () => {
  it("shows a snapshot as it is, also over what was shown before a reconnect", () => {
    const before = apply(empty, {
      type: "snapshot",
      revision: 3,
      conversation,
      entries: [entry("a", 1, "Hel"), entry("b", 2, "gone")],
      turns: [turn("running")],
    });
    const after = apply(before, {
      type: "snapshot",
      revision: 9,
      conversation,
      entries: [entry("c", 3, "third"), entry("a", 1, "Hello")],
      turns: [turn("completed")],
    });
    expect(after.order).toEqual(["a", "c"]);
    expect(after.entries).toEqual({
      a: entry("a", 1, "Hello"),
      c: entry("c", 3, "third"),
    });
    expect(after.turns["t1"]?.status).toBe("completed");
  });

  it("replaces entries and turns by id, adds new ones in order, and leaves the rest as they were", () => {
    const shown = apply(empty, {
      type: "snapshot",
      revision: 1,
      conversation,
      entries: [entry("a", 1, "Question"), entry("b", 2, "o")],
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

  it("takes a new title or model from an update, and keeps it otherwise", () => {
    const shown = apply(empty, {
      type: "snapshot",
      revision: 0,
      conversation,
      entries: [],
      turns: [],
    });
    const titled = apply(shown, {
      type: "update",
      revision: 1,
      entries: [],
      turns: [],
      conversation: { ...conversation, title: "Thyroid results" },
    });
    expect(titled.conversation?.title).toBe("Thyroid results");
    const later = apply(titled, {
      type: "update",
      revision: 2,
      entries: [entry("a", 1, "Hi")],
      turns: [],
    });
    expect(later.conversation?.title).toBe("Thyroid results");
  });
});
