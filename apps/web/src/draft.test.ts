import type { Draft } from "@rufi/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BoxChip, type DraftApi, draftBox, held } from "./draft.ts";

const editable = (text: string): Draft => ({ text, refs: [] });

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
    expect(saves().map((save) => save.body)).toEqual([
      { text: "Que", refs: [] },
    ]);

    box.type("Questions");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saves()).toHaveLength(1);
    saves()[0]?.answer(editable("Que"));
    await settle();
    expect(box.store.getState().text).toBe("Questions");
    await vi.advanceTimersByTimeAsync(400);
    expect(saves()[1]?.body).toEqual({ text: "Questions", refs: [] });
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
    expect(saves()[2]?.body).toEqual({ text: "Start", refs: [] });
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
    const sending = box.submit();
    await settle();
    // The earlier save goes first.
    expect(sends()).toHaveLength(0);
    saves()[0]?.answer(editable("Hello"));
    await settle();
    expect(sends().map(({ path, body }) => ({ path, body }))).toEqual([
      { path: "messages", body: { id: "id-1", text: "Hello", refs: [] } },
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
    const { api, saves, sends } = core();
    const box = draftBox(api);
    await settle();
    box.type("Keep this");
    const refused = box.submit();
    await settle();
    sends()[0]?.fail(refusal("Not signed in."));
    await refused;
    expect(box.store.getState()).toMatchObject({
      text: "Keep this",
      sending: false,
      notice: "Not signed in.",
    });

    // Refused, the text is the draft again, so a reload keeps it.
    await settle();
    expect(saves()[0]?.body).toEqual({ text: "Keep this", refs: [] });
    saves()[0]?.answer(editable("Keep this"));
    await settle();
    expect(box.store.getState().notice).toBe("Not signed in.");

    // No answer from the core: it may have taken it.
    const first = box.submit();
    await settle();
    sends()[1]?.fail(new Error("Rufi can't be reached."));
    await first;
    expect(box.store.getState().text).toBe("Keep this");
    const again = box.submit();
    await settle();
    sends()[2]?.answer({ id: "id-2", draft: editable("") });
    await again;
    expect(sends().map(({ body }) => body)).toEqual([
      { id: "id-1", text: "Keep this", refs: [] },
      { id: "id-2", text: "Keep this", refs: [] },
      { id: "id-2", text: "Keep this", refs: [] },
    ]);
    expect(box.store.getState().text).toBe("");
  });
});

describe("words that couldn't be saved", () => {
  it("come back first in a new page, as when the session ends while Rufi is away, and are saved then", async () => {
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
    const chip = {
      pointer: { type: "document", id: "doc-1" },
      label: "Sunrise Labs August.pdf",
      detail: "Lab report",
    } as const;
    const first = core(editable("Is my"));
    first.api.storage = storage;
    const box = draftBox(first.api);
    await settle();
    box.append("Is my HbA1c better?", [chip]);
    await settle();
    first.saves()[0]?.fail(new Error("Rufi can't be reached."));
    await settle();

    // A new session's page: the Mac still has the older draft.
    const next = core(editable("Is my"));
    next.api.storage = storage;
    const reloaded = draftBox(next.api);
    await settle();
    expect(reloaded.store.getState()).toMatchObject({
      text: "Is my\n\nIs my HbA1c better?",
      refs: [chip],
    });
    expect(next.saves()[0]?.body).toEqual({
      text: "Is my\n\nIs my HbA1c better?",
      refs: [{ type: "document", id: "doc-1" }],
    });
    next.saves()[0]?.answer({
      text: "Is my\n\nIs my HbA1c better?",
      refs: [
        {
          ref: { type: "document", id: "doc-1", version: 1 },
          label: chip.label,
          detail: chip.detail,
        },
      ],
    });
    await settle();

    // Saved: a page after that reads the Mac's draft again.
    const after = core(editable("From the Mac"));
    after.api.storage = storage;
    const later = draftBox(after.api);
    await settle();
    expect(later.store.getState().text).toBe("From the Mac");
  });
});

describe("the box's chips", () => {
  const doc = {
    pointer: { type: "document", id: "doc-1" },
    label: "",
    detail: "",
  } as const;
  const named = {
    ref: { type: "document", id: "doc-1", version: 2 },
    label: "Sunrise Labs August.pdf",
    detail: "Lab report",
  } as const;

  it("adds chips after the text and saves them with it, once each; the core names them; they go with the send and clear with it", async () => {
    const { api, saves, sends } = core(editable("What changed?"));
    const box = draftBox(api);
    await settle();

    expect(box.append("", [doc])).toBe(true);
    expect(box.append("", [doc])).toBe(true);
    await settle();
    expect(saves()[0]?.body).toEqual({
      text: "What changed?",
      refs: [{ type: "document", id: "doc-1" }],
    });
    saves()[0]?.answer({ text: "What changed?", refs: [named] });
    await settle();
    expect(box.store.getState().refs).toEqual([
      {
        pointer: { type: "document", id: "doc-1" },
        label: "Sunrise Labs August.pdf",
        detail: "Lab report",
      },
    ]);
    // Nothing new to save for the second add of the same chip.
    expect(saves()).toHaveLength(1);

    void box.submit();
    await settle();
    expect(sends()[0]?.body).toEqual({
      id: "id-1",
      text: "What changed?",
      refs: [{ type: "document", id: "doc-1" }],
    });
    sends()[0]?.answer({ id: "id-1", draft: editable("") });
    await settle();
    expect(box.store.getState()).toMatchObject({ text: "", refs: [] });
  });

  it("reads the draft with its chips, as after a reload; a chip taken out is saved without it", async () => {
    const { api, saves } = core({
      text: "",
      refs: [{ ...named, ref: { ...named.ref, readAgain: true } }],
    });
    const box = draftBox(api);
    await settle();
    expect(box.store.getState().refs).toEqual([
      {
        pointer: { type: "document", id: "doc-1", readAgain: true },
        label: named.label,
        detail: named.detail,
      },
    ]);
    box.remove(doc);
    await settle();
    expect(saves()[0]?.body).toEqual({ text: "", refs: [] });
    expect(box.store.getState().refs).toEqual([]);
  });

  it("keeps and sends no more than 100 chips: past that, nothing is saved or sent until some are taken out", async () => {
    const { api, saves, sends } = core(editable("Save these"));
    const box = draftBox(api);
    await settle();
    const many = Array.from({ length: 101 }, (_, n) => ({
      pointer: { type: "document", id: `doc-${String(n)}` },
      label: "",
      detail: "",
    })) satisfies BoxChip[];
    box.append("", many);
    await box.submit();
    await settle();
    expect(saves()).toHaveLength(0);
    expect(sends()).toHaveLength(0);
    box.remove(many[0] as BoxChip);
    await settle();
    expect(saves()[0]?.body).toMatchObject({ text: "Save these" });
  });
});

describe("a lost send's chips", () => {
  it("are kept in this tab with its text: after a reload the box shows them, and the retry sends them with the same id", async () => {
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
    const chip = {
      ref: { type: "document", id: "doc-1", version: 1 },
      label: "Sunrise Labs August.pdf",
      detail: "Lab report",
    } as const;
    const first = core({ text: "Save it", refs: [chip] });
    first.api.storage = storage;
    const box = draftBox(first.api);
    await settle();
    const sending = box.submit();
    await settle();
    first.sends()[0]?.fail(new Error("Rufi can't be reached."));
    await sending;

    // The core took it and emptied the draft; this tab reloads.
    const next = core(editable(""));
    next.api.storage = storage;
    next.api.newId = () => "id-2";
    const reloaded = draftBox(next.api);
    await settle();
    expect(reloaded.store.getState()).toMatchObject({
      text: "Save it",
      refs: [
        {
          pointer: { type: "document", id: "doc-1" },
          label: "Sunrise Labs August.pdf",
        },
      ],
    });
    void reloaded.submit();
    await settle();
    expect(next.sends()[0]?.body).toEqual({
      id: "id-1",
      text: "Save it",
      refs: [{ type: "document", id: "doc-1" }],
    });
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
    const sending = box.submit();
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

    const retry = reloaded.submit();
    await settle();
    expect(next.sends()[0]?.body).toEqual({
      id: "id-1",
      text: "Save my earlier report",
      refs: [],
    });
    next.sends()[0]?.answer({ id: "id-1", draft: editable("") });
    await retry;
    expect(reloaded.append("Save these 2 results.")).toBe(true);
    await settle();
    expect(next.saves()[0]?.body).toEqual({
      text: "Save these 2 results.",
      refs: [],
    });
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
      refs: [],
    });
    saves()[0]?.answer(
      editable("What changed since March?\n\nSave these 18 results."),
    );
    await settle();

    void box.submit();
    await settle();
    expect(held(box.store.getState())).toBe(true);
    expect(box.append("Save these 2 results.")).toBe(false);
    expect(box.store.getState().text).toBe(
      "What changed since March?\n\nSave these 18 results.",
    );
    expect(sends()).toHaveLength(1);
  });
});

describe("a click on a question card's answer", () => {
  /** A card's send as the box keeps it, by card. */
  const cardOf = (box: ReturnType<typeof draftBox>, card: string) =>
    box.store.getState().cards[card];

  it("sends the answer as the person's message, quoting the card with the answer it chose, the box's words kept; a second click while it goes sends nothing", async () => {
    const { api, sends } = core(editable("And my ferritin"));
    const box = draftBox(api);
    await settle();

    void box.choose("card-1", 0, "Save", "queue");
    void box.choose("card-1", 1, "Not now", "queue");
    await settle();
    expect(sends().map((send) => send.body)).toEqual([
      {
        id: "id-1",
        text: "Save",
        refs: [{ type: "question", id: "card-1", answer: 0 }],
        kind: "queue",
        draft: "keep",
      },
    ]);
    expect(cardOf(box, "card-1")).toMatchObject({ status: "sending" });

    sends()[0]?.answer({ id: "id-1" });
    await settle();
    // Taken: the card waits for the chat to show it.
    expect(cardOf(box, "card-1")).toMatchObject({ status: "sent", index: 0 });
    expect(box.store.getState().text).toBe("And my ferritin");
    box.settle((id) => id === "id-1");
    expect(cardOf(box, "card-1")).toBeUndefined();
  });

  it("keeps an answer with no answer yet through a reload: the new page shows it Not sent, and Retry sends the same id and payload; once the chat has it, the tab forgets it", async () => {
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
    const first = core(editable(""));
    first.api.storage = storage;
    const box = draftBox(first.api);
    await settle();
    void box.choose("card-1", 0, "Save", "queue");
    await settle();
    // The page reloads before any answer came.
    const second = core(editable(""));
    second.api.storage = storage;
    const reloaded = draftBox(second.api);
    await settle();
    expect(cardOf(reloaded, "card-1")).toMatchObject({
      status: "lost",
      id: "id-1",
      index: 0,
    });
    // Another answer can't take its place; Retry sends it as it went.
    void reloaded.choose("card-1", 1, "Not now", "steer");
    void reloaded.retry("card-1");
    await settle();
    expect(second.sends().map((send) => send.body)).toEqual([
      first.sends()[0]?.body,
    ]);
    reloaded.settle((id) => id === "id-1");
    expect(stored.has("rufi/cards/draft/test")).toBe(false);
  });

  it("settles an answer once the chat has its message, whatever its request does: a lost one isn't Not sent, a late end changes nothing, and once its row is gone the card is open", async () => {
    const { api, sends } = core(editable(""));
    const box = draftBox(api);
    await settle();

    // The core took it and its queue row shows, but the answer is lost.
    void box.choose("card-1", 0, "Save", "queue");
    await settle();
    box.settle((id) => id === "id-1");
    sends()[0]?.fail(new Error("Rufi can't be reached."));
    await settle();
    expect(cardOf(box, "card-1")).toBeUndefined();

    // Its row removed: a new click is a new message; the first request's
    // late end, had it come now, wouldn't touch it.
    void box.choose("card-1", 1, "Not now", "queue");
    await settle();
    expect(sends()[1]?.body).toMatchObject({ id: "id-2", text: "Not now" });
    box.settle((id) => id === "id-2");
    sends()[1]?.answer({ id: "id-2" });
    await settle();
    expect(cardOf(box, "card-1")).toBeUndefined();
    expect(box.store.getState().accepted).toBeNull();
  });

  it("keeps an answer that was lost, and sends it again by the same id with the same answer and way; a refusal leaves the card open with the core's words", async () => {
    const { api, sends } = core(editable(""));
    const box = draftBox(api);
    await settle();

    void box.choose("card-1", 0, "Save", "queue");
    await settle();
    sends()[0]?.fail(new Error("Rufi can't be reached."));
    await settle();
    expect(cardOf(box, "card-1")).toMatchObject({ status: "lost", index: 0 });
    // Another answer can't take its place while it is unresolved.
    void box.choose("card-1", 1, "Not now", "steer");
    await settle();
    expect(sends()).toHaveLength(1);

    // Settings say Steer by now: Retry still sends it as it went, queued.
    void box.retry("card-1");
    await settle();
    expect(sends()[1]?.body).toEqual(sends()[0]?.body);
    expect(sends()[1]?.body).toMatchObject({ kind: "queue" });
    sends()[1]?.fail(refusal("Sign in to Codex on your Mac."));
    await settle();
    expect(cardOf(box, "card-1")).toMatchObject({
      status: "refused",
      why: "Sign in to Codex on your Mac.",
    });

    // Open again: a new click is a new message.
    void box.choose("card-1", 1, "Not now", "steer");
    await settle();
    expect(sends()[2]?.body).toMatchObject({ id: "id-2", text: "Not now" });
  });
});
