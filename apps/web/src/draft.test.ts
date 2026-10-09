import type { Draft } from "@rufi/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DraftApi, draftBox, held } from "./draft.ts";

const editable = (text: string): Draft => ({ text, state: "editable" });

/** The core's refusal, as the API gives it: its words and its answer. */
const refusal = (error: string, draft?: Draft) =>
  Object.assign(new Error(error), {
    body: { error, ...(draft && { draft }) },
  });

/**
 * The chat's API on the core's side: reads answer as `reads` says, one
 * after another (the last one stays; an Error is thrown); each save and send
 * waits until the test answers it.
 */
function core(...reads: (Draft | Error)[]) {
  const asked: {
    method: string;
    path: string;
    body: unknown;
    answer: (json: unknown) => void;
    fail: (error: Error) => void;
  }[] = [];
  const api: DraftApi = {
    call: (method, path, body) => {
      if (method === "GET") {
        const next =
          (reads.length > 1 ? reads.shift() : reads[0]) ?? editable("");
        return next instanceof Error
          ? Promise.reject(next)
          : Promise.resolve(next);
      }
      return new Promise((resolve, reject) => {
        asked.push({ method, path, body, answer: resolve, fail: reject });
      });
    },
    client: new QueryClient({
      defaultOptions: { mutations: { networkMode: "always" } },
    }),
    scope: "draft/test",
  };
  const saves = () => asked.filter((call) => call.method === "PUT");
  const sends = () => asked.filter((call) => call.method === "POST");
  return { api, saves, sends };
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
  it("can't be typed in until the draft is read; a read that fails is tried again", async () => {
    const { api, saves } = core(
      new Error("Rufi can't be reached."),
      editable("Kept from before"),
    );
    const box = draftBox(api);
    await settle();
    box.type("lost");
    expect(box.store.getState()).toMatchObject({
      text: "",
      loaded: false,
      notice: "Rufi can't be reached.",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(box.store.getState()).toMatchObject({
      text: "Kept from before",
      loaded: true,
      notice: null,
    });
    // Nothing was saved over the draft it couldn't read.
    expect(saves()).toHaveLength(0);
  });

  it("saves a moment after typing, one save at a time; an answer never undoes newer typing", async () => {
    const { api, saves } = core();
    const box = draftBox(api);
    await settle();
    box.type("Que");
    await vi.advanceTimersByTimeAsync(399);
    expect(saves()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves().map((save) => save.body)).toEqual([{ text: "Que" }]);

    box.type("Questions");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saves()).toHaveLength(1);
    saves()[0]?.answer(editable("Que"));
    await settle();
    expect(box.store.getState().text).toBe("Questions");
    await vi.advanceTimersByTimeAsync(400);
    expect(saves()[1]?.body).toEqual({ text: "Questions" });
  });

  it("after a save that failed says Not saved, and saves again even when the text is back to the last one kept: the core may have the failed one", async () => {
    const { api, saves } = core();
    const box = draftBox(api);
    await settle();
    box.type("Start");
    await vi.advanceTimersByTimeAsync(400);
    saves()[0]?.answer(editable("Start"));
    box.type("Start, and more");
    await vi.advanceTimersByTimeAsync(400);
    // Its answer is lost: the core may have kept it.
    saves()[1]?.fail(new Error("Rufi can't be reached."));
    await settle();
    expect(box.store.getState()).toMatchObject({
      text: "Start, and more",
      failed: true,
      notice: "Rufi can't be reached.",
    });
    box.type("Start");
    await vi.advanceTimersByTimeAsync(400);
    expect(saves()[2]?.body).toEqual({ text: "Start" });
    saves()[2]?.answer(editable("Start"));
    await settle();
    expect(box.store.getState()).toMatchObject({ failed: false, notice: null });
  });

  it("sends only the text the core keeps: it saves first, and the box can't change until the core answers", async () => {
    const { api, saves, sends } = core();
    const box = draftBox(api);
    await settle();
    box.type("Hello\n");
    const sending = box.submit(false);
    // Saved at once, not a moment later; nothing is sent before it's kept.
    await settle();
    expect(saves().map((save) => save.body)).toEqual([{ text: "Hello\n" }]);
    box.type("Hello!");
    expect(sends()).toHaveLength(0);
    saves()[0]?.answer(editable("Hello\n"));
    await settle();
    expect(sends().map(({ path, body }) => ({ path, body }))).toEqual([
      { path: "messages", body: { text: "Hello" } },
    ]);
    expect(held(box.store.getState())).toBe(true);
    expect(box.store.getState().text).toBe("Hello\n");

    sends()[0]?.answer({ id: "m-1", draft: editable("") });
    await sending;
    expect(box.store.getState()).toMatchObject({ text: "", sending: false });
    expect(held(box.store.getState())).toBe(false);
  });

  it("sends nothing when the text can't be saved", async () => {
    const { api, saves, sends } = core();
    const box = draftBox(api);
    await settle();
    box.type("Mine");
    const sending = box.submit(true);
    await settle();
    saves()[0]?.fail(new Error("Rufi can't be reached."));
    await sending;
    expect(sends()).toHaveLength(0);
    expect(box.store.getState()).toMatchObject({
      text: "Mine",
      sending: false,
      failed: true,
    });
  });

  it("can't be typed in while a send holds the draft, and goes on once it has ended", async () => {
    const holding: Draft = { text: "Sent elsewhere", state: "sending" };
    const { api, saves } = core(holding, holding, editable(""));
    const box = draftBox(api);
    await settle();
    expect(held(box.store.getState())).toBe(true);
    box.type("x");
    expect(box.store.getState().text).toBe("Sent elsewhere");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(held(box.store.getState())).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(box.store.getState().text).toBe("");
    expect(held(box.store.getState())).toBe(false);
    box.type("Next");
    await vi.advanceTimersByTimeAsync(400);
    expect(saves()[0]?.body).toEqual({ text: "Next" });
  });

  it("finds a save held by another tab's send: shows that text, held, until the send has ended", async () => {
    const holding: Draft = { text: "From the other tab", state: "sending" };
    const { api, saves } = core(editable(""), holding, editable(""));
    const box = draftBox(api);
    await settle();
    box.type("Mine");
    await vi.advanceTimersByTimeAsync(400);
    saves()[0]?.fail(refusal("This message is being sent.", holding));
    await settle();
    expect(box.store.getState()).toMatchObject({
      text: "From the other tab",
      failed: false,
    });
    expect(held(box.store.getState())).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(held(box.store.getState())).toBe(false);
  });

  it("after a failed send, goes on from the draft the core has with the reason; without the core's answer, waits until a read says how it ended", async () => {
    const { api, saves, sends } = core(
      editable(""),
      { text: "Again", state: "sending" },
      { text: "Again", state: "unknown" },
    );
    const box = draftBox(api);
    await settle();
    box.type("Keep this");
    const first = box.submit(false);
    await settle();
    saves()[0]?.answer(editable("Keep this"));
    await settle();
    sends()[0]?.fail(
      refusal("No reply is running to steer.", editable("Keep this")),
    );
    await first;
    expect(box.store.getState()).toMatchObject({
      text: "Keep this",
      sending: false,
      notice: "No reply is running to steer.",
    });
    expect(held(box.store.getState())).toBe(false);

    // No answer from the core: the send may still hold the draft.
    box.type("Again");
    const again = box.submit(false);
    await settle();
    saves()[1]?.answer(editable("Again"));
    await settle();
    sends()[1]?.fail(new Error("Rufi can't be reached."));
    await again;
    expect(held(box.store.getState())).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(box.store.getState()).toMatchObject({
      text: "Again",
      draft: { state: "unknown" },
      notice: "Rufi can't be reached.",
    });
    expect(held(box.store.getState())).toBe(false);
    expect(sends()).toHaveLength(2);
  });
});
