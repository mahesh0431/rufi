import type { Draft } from "@rufi/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANGED, type DraftIo, draftBox, held } from "./draft.ts";

const editable = (text: string, revision: number): Draft => ({
  text,
  revision,
  state: "editable",
});

/**
 * The core's side: the draft is read as `drafts` says, one after another
 * (the last one stays); each save waits until the test answers it.
 */
function core(...drafts: Draft[]) {
  const saves: {
    text: string;
    revision: number;
    answer: (saved: boolean, draft: Draft) => void;
    fail: (error: Error) => void;
  }[] = [];
  const reads = drafts.length > 0 ? drafts : [editable("", 0)];
  const io: DraftIo = {
    load: () =>
      Promise.resolve(
        (reads.length > 1 ? reads.shift() : reads[0]) ?? editable("", 0),
      ),
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
    client: new QueryClient({
      defaultOptions: { mutations: { networkMode: "always" } },
    }),
    scope: "draft/test",
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
    const { io } = core(editable("Kept from before", 4));
    const box = draftBox(io);
    box.type("lost");
    expect(box.store.getState()).toMatchObject({ text: "", loaded: false });
    await settle();
    expect(box.store.getState()).toMatchObject({
      text: "Kept from before",
      loaded: true,
    });
  });

  it("saves a moment after typing, one save at a time; only the text the core kept is saved", async () => {
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

    // Typing on while the first save is out: no second save meanwhile, and
    // its answer doesn't make the newer text saved.
    box.type("Questions");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saves).toHaveLength(1);
    saves[0]?.answer(true, editable("Que", 1));
    await settle();
    expect(box.store.getState()).toMatchObject({
      text: "Questions",
      draft: { text: "Que" },
    });

    await vi.advanceTimersByTimeAsync(400);
    expect(saves[1]).toMatchObject({ text: "Questions", revision: 1 });
  });

  it("shows the newer text when another tab saved first", async () => {
    const { io, saves } = core();
    const box = draftBox(io);
    await settle();
    box.type("Mine");
    await vi.advanceTimersByTimeAsync(400);
    saves[0]?.answer(false, editable("From the other tab", 3));
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

  it("after a save whose answer didn't come, asks the core first: goes on from it when it was kept, with what was typed since", async () => {
    // The core kept the first save; its answer was lost.
    const { io, saves } = core(editable("", 0), editable("Start", 1));
    const box = draftBox(io);
    await settle();
    box.type("Start");
    await vi.advanceTimersByTimeAsync(400);
    box.type("Start, and more");
    saves[0]?.fail(new Error("Rufi can't be reached."));
    await settle();
    expect(box.store.getState()).toMatchObject({
      text: "Start, and more",
      failed: true,
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(saves[1]).toMatchObject({ text: "Start, and more", revision: 1 });
    saves[1]?.answer(true, editable("Start, and more", 2));
    await settle();
    expect(box.store.getState()).toMatchObject({
      text: "Start, and more",
      failed: false,
      notice: null,
    });
  });

  it("after a save whose answer didn't come, Retry finds it kept: Saved, and the old reason goes", async () => {
    const { io, saves } = core(editable("", 0), editable("Start", 1));
    const box = draftBox(io);
    await settle();
    box.type("Start");
    await vi.advanceTimersByTimeAsync(400);
    saves[0]?.fail(new Error("Rufi can't be reached."));
    await settle();
    void box.saveNow();
    await settle();
    expect(saves).toHaveLength(1);
    expect(box.store.getState()).toMatchObject({
      draft: { revision: 1 },
      failed: false,
      notice: null,
    });
  });

  it("gives a send the text only once the core keeps it as the draft, with its revision", async () => {
    const { io, saves } = core();
    const box = draftBox(io);
    await settle();
    box.type("Hello");
    const taken = box.take();
    // Saved at once, not a moment later; the box can't change meanwhile.
    await settle();
    expect(saves.map(({ text, revision }) => ({ text, revision }))).toEqual([
      { text: "Hello", revision: 0 },
    ]);
    box.type("Hello!");
    saves[0]?.answer(true, editable("Hello", 1));
    expect(await taken).toEqual({ text: "Hello", revision: 1 });
    expect(held(box.store.getState())).toBe(true);
    expect(box.store.getState().text).toBe("Hello");

    box.sent(editable("", 3));
    expect(box.store.getState()).toMatchObject({ text: "", sending: false });
  });

  it("sends nothing when the text can't be saved, or another tab's replaced it", async () => {
    const { io, saves } = core();
    const box = draftBox(io);
    await settle();
    box.type("Mine");
    const failing = box.take();
    await settle();
    saves[0]?.fail(new Error("Rufi can't be reached."));
    expect(await failing).toBeUndefined();
    expect(box.store.getState()).toMatchObject({
      text: "Mine",
      sending: false,
      failed: true,
    });

    const replaced = box.take();
    await settle();
    saves[1]?.answer(false, editable("Theirs", 2));
    expect(await replaced).toBeUndefined();
    expect(box.store.getState()).toMatchObject({
      text: "Theirs",
      sending: false,
      notice: CHANGED,
    });
  });

  it("can't be typed in while a send holds the draft, and goes on once it has ended", async () => {
    const holding: Draft = {
      text: "Sent elsewhere",
      revision: 5,
      state: "sending",
    };
    const { io, saves } = core(holding, holding, editable("", 6));
    const box = draftBox(io);
    await settle();
    expect(held(box.store.getState())).toBe(true);
    box.type("x");
    expect(box.store.getState().text).toBe("Sent elsewhere");
    await vi.advanceTimersByTimeAsync(999);
    expect(held(box.store.getState())).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(box.store.getState()).toMatchObject({
      text: "",
      draft: { revision: 6 },
    });
    box.type("Next");
    await vi.advanceTimersByTimeAsync(400);
    expect(saves[0]).toMatchObject({ text: "Next", revision: 6 });
  });

  it("after a send that failed, goes on from the draft the core has, or reads it again", async () => {
    const { io, saves } = core(editable("", 3), editable("", 5));
    const box = draftBox(io);
    await settle();
    box.type("Keep this");
    const taken = box.take();
    await settle();
    saves[0]?.answer(true, editable("Keep this", 4));
    await taken;
    // Another tab changed the draft before the send: the box shows its text.
    box.failed(CHANGED, editable("From the other tab", 5));
    expect(box.store.getState()).toMatchObject({
      text: "From the other tab",
      sending: false,
      notice: CHANGED,
    });

    // No answer from the core: the send may still hold the draft, so the box
    // stays held until a read says how it ended.
    box.type("Again");
    const again = box.take();
    await settle();
    saves[1]?.answer(true, editable("Again", 6));
    await again;
    box.failed("Rufi can't be reached.");
    expect(held(box.store.getState())).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(box.store.getState()).toMatchObject({
      text: "",
      draft: { revision: 5 },
    });
    expect(held(box.store.getState())).toBe(false);
  });
});
