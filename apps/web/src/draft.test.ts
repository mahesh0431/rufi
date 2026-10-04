import type { Draft } from "@rufi/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANGED, type DraftIo, draftBox } from "./draft.ts";

/** The core's side: each save waits until the test answers it. */
function core(start: Draft = { text: "", revision: 0 }) {
  const saves: {
    text: string;
    revision: number;
    answer: (saved: boolean, draft: Draft) => void;
    fail: (error: Error) => void;
  }[] = [];
  const io: DraftIo = {
    load: () => Promise.resolve(start),
    save: (text, revision) =>
      new Promise((resolve, reject) => {
        saves.push({
          text,
          revision,
          answer: (saved, draft) => {
            resolve({ saved, draft });
          },
          fail: reject,
        });
      }),
    saveOnLeave: () => undefined,
  };
  return { io, saves };
}

/** Lets the box's promises run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the box's draft", () => {
  it("can't be typed in until the draft is read", async () => {
    const { io } = core({ text: "Kept from before", revision: 4 });
    const box = draftBox(io);
    box.type("lost");
    expect(box.store.getState()).toMatchObject({ text: "", loaded: false });
    await settle();
    expect(box.store.getState()).toMatchObject({
      text: "Kept from before",
      loaded: true,
    });
  });

  it("saves a moment after typing, one save at a time; an older answer never replaces newer text", async () => {
    const { io, saves } = core();
    const box = draftBox(io);
    await settle();
    box.type("Que");
    await vi.advanceTimersByTimeAsync(399);
    expect(saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves.map(({ text, revision }) => ({ text, revision }))).toEqual([
      { text: "Que", revision: 0 },
    ]);

    // Typing on while the first save is out: no second save meanwhile.
    box.type("Questions");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saves).toHaveLength(1);
    saves[0]?.answer(true, { text: "Que", revision: 1 });
    await settle();
    expect(box.store.getState().text).toBe("Questions");

    await vi.advanceTimersByTimeAsync(400);
    expect(saves[1]).toMatchObject({ text: "Questions", revision: 1 });
  });

  it("shows the newer text when another tab saved first", async () => {
    const { io, saves } = core();
    const box = draftBox(io);
    await settle();
    box.type("Mine");
    await vi.advanceTimersByTimeAsync(400);
    saves[0]?.answer(false, { text: "From the other tab", revision: 3 });
    await settle();
    expect(box.store.getState()).toMatchObject({
      text: "From the other tab",
      notice: CHANGED,
    });
    box.type("From the other tab, and more");
    expect(box.store.getState().notice).toBeNull();
    await vi.advanceTimersByTimeAsync(400);
    expect(saves[1]).toMatchObject({ revision: 3 });
  });

  it("gives a send the text after the save under way, with its revision", async () => {
    const { io, saves } = core();
    const box = draftBox(io);
    await settle();
    box.type("Hello");
    await vi.advanceTimersByTimeAsync(400);
    const taken = box.take();
    // The box can't change while the message is on its way.
    box.type("Hello!");
    saves[0]?.answer(true, { text: "Hello", revision: 1 });
    expect(await taken).toEqual({ text: "Hello", revision: 1 });
    expect(box.store.getState()).toMatchObject({
      text: "Hello",
      sending: true,
    });

    box.sent({ text: "", revision: 2 });
    expect(box.store.getState()).toMatchObject({ text: "", sending: false });
  });

  it("sends nothing when another tab's text replaced yours during the save", async () => {
    const { io, saves } = core();
    const box = draftBox(io);
    await settle();
    box.type("Mine");
    await vi.advanceTimersByTimeAsync(400);
    const taken = box.take();
    saves[0]?.answer(false, { text: "Theirs", revision: 2 });
    expect(await taken).toBeUndefined();
    expect(box.store.getState()).toMatchObject({
      text: "Theirs",
      sending: false,
      notice: CHANGED,
    });
  });

  it("keeps the text of a send that failed, says why, and saves it", async () => {
    const { io, saves } = core();
    const box = draftBox(io);
    await settle();
    box.type("Keep this");
    await box.take();
    box.failed("Rufi can't be reached.");
    expect(box.store.getState()).toMatchObject({
      text: "Keep this",
      sending: false,
      notice: "Rufi can't be reached.",
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(saves[0]).toMatchObject({ text: "Keep this", revision: 0 });
  });

  it("goes on from the draft the core kept for a send that failed", async () => {
    const { io, saves } = core({ text: "", revision: 3 });
    const box = draftBox(io);
    await settle();
    box.type("Keep this");
    await box.take();
    box.failed("The AI couldn't take the message.", {
      text: "Keep this",
      revision: 4,
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(saves).toHaveLength(0);
    box.type("Keep this, please");
    await vi.advanceTimersByTimeAsync(400);
    expect(saves[0]).toMatchObject({ text: "Keep this, please", revision: 4 });
  });
});
