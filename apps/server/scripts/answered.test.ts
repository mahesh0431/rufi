import type { Entry, Turn } from "@rufi/contracts";
import { describe, expect, it } from "vitest";
import { everyTurnAnswered } from "./answered.ts";

const turn = (id: string, status: Turn["status"]): Turn => ({
  id,
  model: "gpt-6.1-sol",
  status,
  endReason: status === "failed" ? "usage_limit" : null,
  endText: null,
  resetsAt: null,
  startedAt: "2026-10-05T00:00:00Z",
  endedAt: status === "running" ? null : "2026-10-05T00:00:05Z",
  how: null,
  used: [],
});
const entry = (kind: Entry["kind"], turnId: string, text: string): Entry => ({
  id: `${kind}-${turnId}`,
  seq: 0,
  turnId,
  kind,
  text,
  activity: null,
  detail: null,
  status: null,
  createdAt: "2026-10-05T00:00:00Z",
  updatedAt: "2026-10-05T00:00:00Z",
});
const asked = (id: string) =>
  entry("message", id, "Should I stop my Metformin?");
const replied = (id: string) =>
  entry("reply", id, "Talk to your doctor first.");

describe("a smoke case's replies", () => {
  it.each([
    [
      "one completed reply",
      [turn("a", "completed")],
      [asked("a"), replied("a")],
      true,
    ],
    [
      "a usage limit before any reply",
      [turn("a", "failed")],
      [asked("a")],
      false,
    ],
    [
      "a reply stopped part way",
      [turn("a", "interrupted")],
      [asked("a"), replied("a")],
      false,
    ],
    [
      "completed without words",
      [turn("a", "completed")],
      [asked("a"), entry("reply", "a", " ")],
      false,
    ],
    [
      "a later reply that failed",
      [turn("a", "completed"), turn("b", "failed")],
      [asked("a"), replied("a"), asked("b")],
      false,
    ],
    [
      "an earlier turn's reply only",
      [turn("a", "completed"), turn("b", "completed")],
      [asked("a"), replied("a"), asked("b")],
      false,
    ],
    ["nothing ran", [], [asked("a")], false],
  ])("%s", (_, turns, entries, ok) => {
    expect(everyTurnAnswered({ turns, entries })).toBe(ok);
  });
});
