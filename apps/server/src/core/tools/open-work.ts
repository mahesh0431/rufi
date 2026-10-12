// get_open_work and track_open_work: the AI's side of open work
// (core/work/open-work.ts, docs/adr/0016). Questions it asked the person and
// tasks it took on are kept for them, and for a later reply or a new AI.
// Only in Rufi's own chat: Rufi gives the person, chat, reply and call.
import { OpenWorkRefusal, ReadInput, TrackInput } from "../work/open-work.ts";
import { defineTool, Refusal } from "./registry.ts";

const NOT_HERE = "Open work is kept only in Rufi's own chat.";

/** The module's refusal, as the tool's. */
async function refused<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof OpenWorkRefusal) throw new Refusal(error.message);
    throw error;
  }
}

export const getOpenWork = defineTool({
  name: "get_open_work",
  shown: (input) =>
    typeof input === "object" &&
    input !== null &&
    "item" in input &&
    input.item !== undefined
      ? "Read a question or task Rufi keeps"
      : "Read what is open",
  description: `The active person's open work, which Rufi keeps across replies, restarts and new AI threads: questions you asked the user that wait for their answer, and tasks you took on that wait for you. Without item: a list (show: open, the default, not on Later; later; or closed in the last 30 days), newest first, 20 at a time (read on with next), each with its id, kind, text, version and dates; counts of every group and of what else waits in Needs you (documents with results to save, pages that couldn't be read, failed readings, follow-ups overdue, due or coming up); with show open, those documents and follow-ups too. With item: that one whole, any age: its text, status, version, what it is about (each document, draft item, record or report with the version it had then and how it stands now: same, changed, removed, deleted or gone), when it was asked and whether that reply finished, and its history.`,
  input: ReadInput,
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [
    {},
    { item: "0199a0f2-0000-7000-8000-0000000000e1" },
    { show: "later" },
  ],
  run: (input, { work }) => {
    if (!work) throw new Refusal(NOT_HERE);
    return refused(() => work.read(input));
  },
});

export const trackOpenWork = defineTool({
  name: "track_open_work",
  shown: (input) => {
    const change =
      typeof input === "object" && input !== null && "change" in input
        ? input.change
        : undefined;
    switch (change) {
      case "add":
        return "Keep this for later";
      case "later":
        return "Put a question on Later";
      case "close":
        return "Close a question or task";
      default:
        return "Update what is open";
    }
  },
  description: `Changes the active person's open work, one change per call; Rufi gives the person, chat and reply. This is not the health record: it saves nothing to it and is never the user's yes.
- add: a question you ask the user that waits for their answer (a save, a choice, something to review), or a task you accepted that spans replies. text: complete in itself (what, with names, values and dates); refs: the data it is about, with ids your tools gave. Rufi checks each ref is this person's and keeps its version.
- later: hides an open item until a local day (until, YYYY-MM-DD; 7 days by default). bring_back: shows it again now.
- close: as done with the operation id save_changes returned when a save answered it, or a reason; as dropped with a reason.
- reopen: a closed item is open again; its earlier closing stays in its history.
Every change but add needs the item's version as you read it; when it changed since, it is refused with how it is now. The same call again returns its first answer and changes nothing.
In a turn a Rufi event started you can add, and close as done only a task of yours, or an item a save already answered (with its operation); the rest waits for the user's own message.`,
  input: TrackInput,
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [
    {
      change: "add",
      kind: "question",
      text: "Save HbA1c 6.1 % from Sunrise Labs, 12 Mar 2026, as a lab result?",
      refs: [{ type: "document", id: "0199a0f2-0000-7000-8000-0000000000d1" }],
    },
    {
      change: "close",
      item: "0199a0f2-0000-7000-8000-0000000000e1",
      version: 1,
      as: "done",
      operation: "0199a0f2-0000-7000-8000-0000000000f1",
    },
    {
      change: "later",
      item: "0199a0f2-0000-7000-8000-0000000000e1",
      version: 1,
    },
  ],
  run: (input, { work, callId }) => {
    if (!work || callId === undefined) throw new Refusal(NOT_HERE);
    return refused(() => work.track(input, callId));
  },
});
