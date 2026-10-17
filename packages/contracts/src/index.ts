// What Rufi's local API takes and gives, shared by the server and the screens.
// Requests are decoded with these schemas; responses are built to their types.
import { Schema } from "effect";

/**
 * The longest message or draft Rufi takes, in characters. A draft must fit
 * in the last save a page sends as it closes, which browsers cap at 64 KB:
 * 10,000 characters are at most 60,000 bytes, even when every one of them
 * is escaped in JSON (6 bytes).
 */
export const MAX_MESSAGE_CHARS = 10_000;

/** Why nothing goes to the AI without a sign-in; the box adds Sign in. */
export const SIGNED_OUT = "You're signed out. Sign in with ChatGPT to chat.";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Line = (max: number) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
  );
const Id = Line(100);

// --- References ---

/** The most references one message or draft holds. */
export const MAX_REFS = 100;

/**
 * What the box points at: a document, a draft item, a saved record or a
 * report (its results) of the chat's person. Checked against the person when
 * added and when sent.
 */
export const Pointer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("document"), id: Id }),
  Schema.Struct({ type: Schema.Literal("draft_item"), id: Id }),
  Schema.Struct({ type: Schema.Literal("record"), kind: Line(40), id: Id }),
  Schema.Struct({ type: Schema.Literal("report"), id: Id }),
]);
export type Pointer = typeof Pointer.Type;

const Version = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * A reference to health data, exact: a pointer with the version it had when
 * the message was sent (in the box: its version now). A document's version
 * rises when its draft items change; a draft item's when it is fixed or
 * dismissed; a record's is the save that last changed it (null for one no
 * save has changed); a report's, the save that last changed any of its
 * results. The AI reads it with its tools; a save refuses an item
 * whose message's reference has moved on since.
 */
export const Ref = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("document"),
    id: Id,
    version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    type: Schema.Literal("draft_item"),
    id: Id,
    version: Version,
  }),
  Schema.Struct({
    type: Schema.Literal("record"),
    kind: Line(40),
    id: Id,
    version: Schema.NullOr(Id),
  }),
  Schema.Struct({
    type: Schema.Literal("report"),
    id: Id,
    version: Schema.NullOr(Id),
  }),
]);
export type Ref = typeof Ref.Type;

/** A reference as a chip shows it: its name, and where it comes from on hover. */
export const Chip = Schema.Struct({
  ref: Ref,
  /** What the page calls it: "Sunrise Labs August.pdf", "HbA1c 6.8 %". */
  label: Schema.String,
  /** Where it comes from, for the hover: "Draft item · not saved · page 2". */
  detail: Schema.String,
  /**
   * Its document was deleted after it was sent: it keeps its name and
   * opens nothing.
   */
  deleted: Schema.optionalKey(Schema.Literal(true)),
});
export type Chip = typeof Chip.Type;

const Pointers = Schema.Array(Pointer).check(Schema.isMaxLength(MAX_REFS));

// --- What the screens get ---

// TODO: drop the kind if it gets complicated. To an agent everything is a
// tool call; the text and detail already say what it did. Keep this list
// only while it stays small and each adapter can fill it in one line.
export const ActivityKind = Schema.Literals([
  "tool",
  "command",
  "web_search",
  "file_change",
  "sub_agent",
  /** The AI compacted its memory of the chat (shown only once done). */
  "compaction",
  /** A picture the AI generated: the reply shows it; `detail` is its path. */
  "picture",
  /** The AI's progress note, its words as they came: a step, not a reply. */
  "note",
  "other",
]);
export type ActivityKind = typeof ActivityKind.Type;

/** One item of a chat's transcript, in order by `seq`. */
export const Entry = Schema.Struct({
  id: Schema.String,
  seq: Schema.Int,
  /** The reply it belongs to. */
  turnId: Schema.NullOr(Schema.String),
  /**
   * reasoning: the AI's thinking for a step, with its summary as the AI
   * service gave it (status running while it thinks, then done, or stopped
   * when its turn ends before the summary is whole); event:
   * Rufi's own factual line about something that happened, never the
   * person's words; brief: the line of a visit brief, whose id is the brief's.
   */
  kind: Schema.Literals([
    "message",
    "steer",
    "activity",
    "reply",
    "reasoning",
    "receipt",
    "event",
    "brief",
  ]),
  /**
   * The message; the reply's answer (without its rufi-basis blocks, which
   * the turn's How holds); an activity's text as the agent reported it (the
   * command, `server.tool`, the paths, a note's words; a line stored before
   * notes, its title); the reasoning's summary so far; a receipt's, an
   * event's or a brief's line.
   */
  text: Schema.String,
  activity: Schema.NullOr(ActivityKind),
  /**
   * An activity's second reported part: a tool's arguments, a command's exit
   * code, a page's address; a picture's path, whole. Everything the agent
   * gave about it comes only on request (EntryDetails).
   */
  detail: Schema.NullOr(Schema.String),
  status: Schema.NullOr(
    Schema.Literals(["running", "done", "failed", "stopped"]),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** A message's references, as its chips. */
  refs: Schema.optionalKey(Schema.Array(Chip)),
  /** An event's way to its document: open its reading, or read it again. */
  link: Schema.optionalKey(
    Schema.Struct({
      document: Schema.String,
      action: Schema.Literals(["open", "retry"]),
    }),
  ),
});
export type Entry = typeof Entry.Type;

export const EndReason = Schema.Literals([
  "stopped",
  "timeout",
  "usage_limit",
  "rate_limit",
  "sign_in",
  "connection",
  "provider_failed",
  "save_failed",
]);
export type EndReason = typeof EndReason.Type;

/** One reply the AI ran: how it went, and how it ended. */
export const Turn = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  status: Schema.Literals(["running", "completed", "interrupted", "failed"]),
  endReason: Schema.NullOr(EndReason),
  /** Why it didn't complete, in plain words. */
  endText: Schema.NullOr(Schema.String),
  /** When a usage limit resets, when the provider said. */
  resetsAt: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  /**
   * The AI started afresh for this reply: it ran on another agent thread
   * than the reply before it (a model or tool change, a lost thread).
   */
  afresh: Schema.Boolean,
  /**
   * How, from the reply's last rufi-basis block: where the answer comes
   * from, in the AI's words. Only once the reply completed.
   */
  how: Schema.NullOr(Schema.String),
});
export type Turn = typeof Turn.Type;

/** How hard the AI thinks for a reply: low is faster, high thinks longer. */
export const Effort = Schema.Literals(["low", "medium", "high"]);
export type Effort = typeof Effort.Type;

/** A chat's effort until one is chosen for it. */
export const DEFAULT_EFFORT: Effort = "medium";

/** A person's one chat with Rufi's AI. */
export const Chat = Schema.Struct({
  /** The model chosen for it; null: the first allowed one, when the first message goes. */
  model: Schema.NullOr(Schema.String),
  /** The effort chosen for it, or the default. */
  effort: Effort,
});
export type Chat = typeof Chat.Type;

/**
 * A page of the chat's transcript, in order, with each of its turns whole:
 * the latest one when the chat opens, then older ones as the person scrolls
 * up. `revision` is the chat's when it was read.
 */
const PageFields = {
  revision: Schema.Int,
  chat: Chat,
  entries: Schema.Array(Entry),
  turns: Schema.Array(Turn),
  /** The next older page holds the entries before this seq; null: none. */
  before: Schema.NullOr(Schema.Int),
};
export const Page = Schema.Struct(PageFields);
export type Page = typeof Page.Type;

/**
 * One row of the chat's queue: a message of the person's, or Rufi's note
 * for the AI about an event (its text is the event's line). waiting: it
 * goes in turn, unless held; handing_over: Rufi is giving it to the AI;
 * not_sure: Rufi stopped while handing it over, so nobody knows whether
 * the AI got it, and it is never sent again by itself.
 */
export const QueueItem = Schema.Struct({
  id: Schema.String,
  origin: Schema.Literals(["person", "rufi"]),
  text: Schema.String,
  state: Schema.Literals(["waiting", "handing_over", "not_sure"]),
  /**
   * Why a waiting row doesn't go by itself: paused or signed_out (an event
   * that rides with the person's next message), restored (from a backup),
   * failed (the AI refused it; heldText says why).
   */
  held: Schema.NullOr(
    Schema.Literals(["paused", "signed_out", "restored", "failed"]),
  ),
  heldText: Schema.NullOr(Schema.String),
  /** A message's references, as its chips. */
  refs: Schema.Array(Chip),
});
export type QueueItem = typeof QueueItem.Type;

/**
 * What waits, in order, and why nothing goes until the person sends:
 * stopped (Stop) or restarted (Rufi started again with rows waiting).
 */
export const Queue = Schema.Struct({
  items: Schema.Array(QueueItem),
  paused: Schema.NullOr(Schema.Literals(["stopped", "restarted"])),
});
export type Queue = typeof Queue.Type;

/**
 * One line of the chat's live stream (NDJSON). It starts with the latest
 * page; each update replaces entries and turns by id. A screen that falls
 * behind, or reconnects, gets a new latest page.
 */
export const StreamLine = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), ...PageFields }),
  Schema.Struct({
    type: Schema.Literal("update"),
    revision: Schema.Int,
    entries: Schema.Array(Entry),
    turns: Schema.Array(Turn),
    /** The chat, when its model changed. */
    chat: Schema.optionalKey(Chat),
  }),
  /** The queue changed; read it again. */
  Schema.Struct({ type: Schema.Literal("queue") }),
  /** The person's documents or their readings changed; read them again. */
  Schema.Struct({ type: Schema.Literal("documents") }),
  /** Nothing happened for a while; the stream is still open. */
  Schema.Struct({ type: Schema.Literal("ping") }),
]);
export type StreamLine = typeof StreamLine.Type;

/** The unsent text of a chat's box and its chips; the last save wins. */
export const Draft = Schema.Struct({
  text: Schema.String,
  refs: Schema.Array(Chip),
});
export type Draft = typeof Draft.Type;

/** A message the core took into the queue, and the box's draft after it. */
export const Sent = Schema.Struct({ id: Schema.String, draft: Draft });

export const Model = Schema.Struct({ id: Schema.String, name: Schema.String });
export type Model = typeof Model.Type;

/** The allowed models offered now, and any problem with the allowlist. */
export const Models = Schema.Struct({
  models: Schema.Array(Model),
  allowlistError: Schema.NullOr(Schema.String),
});

/** The page's tab proof, for the session's header. */
export const SessionProof = Schema.Struct({ proof: Schema.String });

export const Person = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
});
export type Person = typeof Person.Type;

export const People = Schema.Struct({ people: Schema.Array(Person) });

/** A region whose emergency number Rufi knows. */
export const Region = Schema.Struct({
  region: Schema.String,
  name: Schema.String,
  number: Schema.String,
});
export type Region = typeof Region.Type;

/**
 * How Rufi looks: system follows the Mac's light or dark appearance; light
 * and dark stay so.
 */
export const Appearance = Schema.Literals(["system", "light", "dark"]);
export type Appearance = typeof Appearance.Type;

/**
 * When a reply's Activity is open by itself: while the AI works (working),
 * always (shown), or never (hidden). It folds or opens by hand in each.
 */
export const ActivityShown = Schema.Literals(["working", "shown", "hidden"]);
export type ActivityShown = typeof ActivityShown.Type;

export const Settings = Schema.Struct({
  appearance: Appearance,
  activity: ActivityShown,
  /** The chosen region; null when none is chosen. */
  emergencyRegion: Schema.NullOr(Schema.String),
  emergency: Schema.NullOr(
    Schema.Struct({ name: Schema.String, number: Schema.String }),
  ),
  /** The regions Rufi knows, to choose from. */
  regions: Schema.Array(Region),
  /** The document reader's model and effort, and the models it can run on. */
  reader: Schema.Struct({
    model: Schema.String,
    effort: Effort,
    models: Schema.Array(Model),
  }),
});
export type Settings = typeof Settings.Type;

/**
 * Everything the agent gave about one step of a reply's Activity, as it
 * came (plain JSON, in the agent's own shape), read when the step opens;
 * null when Rufi kept none.
 */
export const EntryDetails = Schema.Struct({ details: Schema.Unknown });
export type EntryDetails = typeof EntryDetails.Type;

/** The ChatGPT sign-in, as the screens need it. */
export const Status = Schema.Struct({
  account: Schema.Literals(["signed_out", "signed_in", "no_plan_use"]),
  email: Schema.NullOr(Schema.String),
});
export type Status = typeof Status.Type;

/** How a sign-in from the screens goes: waiting has the link once it is known. */
export const SignInState = Schema.Struct({
  state: Schema.Literals(["idle", "waiting", "done", "failed"]),
  link: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type SignInState = typeof SignInState.Type;

/** The last good backup, and the last failed try when it is newer. */
export const Backups = Schema.Struct({
  last: Schema.NullOr(
    Schema.Struct({ name: Schema.String, createdAt: Schema.String }),
  ),
  failed: Schema.NullOr(
    Schema.Struct({ at: Schema.String, reason: Schema.String }),
  ),
  running: Schema.Boolean,
});
export type Backups = typeof Backups.Type;

/**
 * Where Rufi keeps its data: the folder Rufi made (default), one the person
 * moved it to (moved), or one RUFI_HOME picked for this run.
 */
export const DataFolder = Schema.Struct({
  path: Schema.String,
  source: Schema.Literals(["default", "moved", "RUFI_HOME"]),
});
export type DataFolder = typeof DataFolder.Type;

/**
 * A file a reply shows (a picture or a page the AI made), found now: a
 * short-lived address for that one file, and its name.
 */
export const ShownFile = Schema.Struct({
  url: Schema.String,
  name: Schema.String,
  /** The canonical path from the resolver: aliases name the same file. */
  path: Schema.String,
  shape: Schema.Literals(["picture", "page"]),
});
export type ShownFile = typeof ShownFile.Type;

/** Escape from a generated page. Accept only from the currently open frame. */
export const PAGE_ESCAPE = "rufi-page-escape";

/** The first step of the first run not done yet, or done. */
export const FirstRunStep = Schema.Literals([
  "welcome",
  "name",
  "sign_in",
  "region",
  "done",
]);
export const FirstRun = Schema.Struct({ step: FirstRunStep });
export type FirstRun = typeof FirstRun.Type;

// --- What the screens send ---

export const AddPerson = Schema.Struct({ displayName: Line(200) });

/** The settings to change; the others stay as they are. */
export const SaveSettings = Schema.Struct({
  appearance: Schema.optionalKey(Appearance),
  activity: Schema.optionalKey(ActivityShown),
  /** A region code Rufi knows, such as "IN"; null clears it. */
  emergencyRegion: Schema.optionalKey(Schema.NullOr(Line(10))),
  /** The document reader's model: one of the models it can run on. */
  readerModel: Schema.optionalKey(Id),
  readerEffort: Schema.optionalKey(Effort),
});

const Message = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_MESSAGE_CHARS),
);

/** A waiting message, edited. */
export const MessageText = Schema.Struct({ text: Message });

/**
 * A message from the box, sent into the queue or steered into the running
 * reply. `id` is the send's own: the same send again (a retry) finds the
 * message it made and never makes a second one.
 */
export const SendMessage = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  text: Message,
  /** Its chips: what it points at. */
  refs: Schema.optionalKey(Pointers),
});

/** The box's text and chips, saved over the draft unless a send holds it. */
export const SaveDraft = Schema.Struct({
  text: Text(MAX_MESSAGE_CHARS),
  refs: Schema.optionalKey(Pointers),
});

export const ReorderQueue = Schema.Struct({ ids: Schema.Array(Id) });

/**
 * A first-run step done: welcome (ticked "not a doctor"), sign_in (skipped),
 * region (saved or skipped).
 */
export const FinishStep = Schema.Struct({
  step: Schema.Literals(["welcome", "sign_in", "region"]),
});

export const SelectModel = Schema.Struct({ model: Id });

export const SelectEffort = Schema.Struct({ effort: Effort });
