import type { Draft } from "@rufi/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DraftApi, draftBox, held } from "./draft.ts";

const editable = (text: string): Draft => ({ text });

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
  let ids = 0;
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
    newId: () => `id-${String(++ids)}`,
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

  it("sends after the box's earlier saves, by an id of its own; the box can't change until the core answers, and empties when it took the text", async () => {
    const { api, saves, sends } = core();
    const box = draftBox(api);
    await settle();
    box.type("Hello");
    await vi.advanceTimersByTimeAsync(400);
    box.type("Hello\n");
    const sending = box.submit(false);
    await settle();
    // The earlier save goes first.
    expect(sends()).toHaveLength(0);
    saves()[0]?.answer(editable("Hello"));
    await settle();
    expect(sends().map(({ path, body }) => ({ path, body }))).toEqual([
      { path: "messages", body: { id: "id-1", text: "Hello" } },
    ]);
    box.type("Hello!");
    expect(held(box.store.getState())).toBe(true);
    expect(box.store.getState().text).toBe("Hello\n");

    sends()[0]?.answer({ id: "id-1", draft: editable("") });
    await sending;
    expect(box.store.getState()).toMatchObject({ text: "", sending: false });
    expect(held(box.store.getState())).toBe(false);
  });

  it("keeps the text with the reason when the core refuses; sends a message whose answer was lost again by the same id, so it is taken once", async () => {
    const { api, sends } = core();
    const box = draftBox(api);
    await settle();
    box.type("Keep this");
    const steered = box.submit(true);
    await settle();
    sends()[0]?.fail(refusal("The reply had ended."));
    await steered;
    expect(box.store.getState()).toMatchObject({
      text: "Keep this",
      sending: false,
      notice: "The reply had ended.",
    });

    // No answer from the core: it may have taken it.
    const first = box.submit(false);
    await settle();
    sends()[1]?.fail(new Error("Rufi can't be reached."));
    await first;
    expect(box.store.getState().text).toBe("Keep this");
    const again = box.submit(false);
    await settle();
    sends()[2]?.answer({ id: "id-2", draft: editable("") });
    await again;
    expect(sends().map(({ body }) => body)).toEqual([
      { id: "id-1", text: "Keep this" },
      { id: "id-2", text: "Keep this" },
      { id: "id-2", text: "Keep this" },
    ]);
    expect(box.store.getState().text).toBe("");
  });
});

describe("adding to the box from another page", () => {
  it("refuses to append to an unresolved send, also after reload; retry keeps its id and text", async () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
      removeItem: (key: string) => {
        stored.delete(key);
      },
    };
    const first = core(editable("Save my earlier report"));
    first.api.storage = storage;
    const box = draftBox(first.api);
    await settle();
    const sending = box.submit(false);
    await settle();
    first.sends()[0]?.fail(new Error("Rufi can't be reached."));
    await sending;

    expect(box.append("Save these 2 results.")).toBe(false);
    await settle();
    expect(box.store.getState().text).toBe("Save my earlier report");
    expect(first.saves()).toHaveLength(0);

    const next = core(editable(""));
    next.api.storage = storage;
    // A new send would have a different id: only the stored id can retry it.
    next.api.newId = () => "id-2";
    const reloaded = draftBox(next.api);
    await settle();
    expect(reloaded.append("Save these 2 results.")).toBe(false);
    await settle();
    expect(reloaded.store.getState().text).toBe("Save my earlier report");
    expect(next.saves()).toHaveLength(0);

    const retry = reloaded.submit(false);
    await settle();
    expect(next.sends()[0]?.body).toEqual({
      id: "id-1",
      text: "Save my earlier report",
    });
    next.sends()[0]?.answer({ id: "id-1", draft: editable("") });
    await retry;
    expect(reloaded.append("Save these 2 results.")).toBe(true);
    await settle();
    expect(next.saves()[0]?.body).toEqual({ text: "Save these 2 results." });
    next.saves()[0]?.answer(editable("Save these 2 results."));
    await settle();
  });

  it("puts the text after what the box holds and saves it; refuses while a send holds the box", async () => {
    const { api, saves, sends } = core(editable("What changed since March?"));
    const box = draftBox(api);
    await settle();

    expect(box.append("Save these 18 results.")).toBe(true);
    await settle();
    expect(box.store.getState().text).toBe(
      "What changed since March?\n\nSave these 18 results.",
    );
    expect(saves()[0]?.body).toEqual({
      text: "What changed since March?\n\nSave these 18 results.",
    });
    saves()[0]?.answer(
      editable("What changed since March?\n\nSave these 18 results."),
    );
    await settle();

    void box.submit(false);
    await settle();
    expect(held(box.store.getState())).toBe(true);
    expect(box.append("Save these 2 results.")).toBe(false);
    expect(box.store.getState().text).toBe(
      "What changed since March?\n\nSave these 18 results.",
    );
    expect(sends()).toHaveLength(1);
  });
});
