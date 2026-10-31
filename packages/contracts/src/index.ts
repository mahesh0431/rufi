// What Rufi's local API takes and gives, shared by the server and the screens.
// Requests are decoded with these schemas; responses are built to their types.
import { Schema } from "effect";
import { KeepValues } from "./devices.ts";
import { BirthDate, ProfileValues, SexForRanges } from "./record.ts";

/**
 * The longest message or draft Rufi takes, in characters. A draft must fit
 * in the last save a page sends as it closes, which browsers cap at 64 KB:
 * 10,000 characters are at most 60,000 bytes, even when every one of them
 * is escaped in JSON (6 bytes).
 */
export const MAX_MESSAGE_CHARS = 10_000;

/** Why nothing goes to the AI without a sign-in; the box adds Sign in. */
export const SIGNED_OUT = "You're signed out. Sign in with ChatGPT to chat.";
/** The same, for a chat on one of Claude's models. */
export const CLAUDE_SIGNED_OUT =
  "You're signed out of Claude. Sign in to Claude to chat.";

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
  Schema.Struct({
    type: Schema.Literal("document"),
    id: Id,
    /** Retry: Send reads again the pages its reading couldn't read. */
    readAgain: Schema.optionalKey(Schema.Literal(true)),
  }),
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
    readAgain: Schema.optionalKey(Schema.Literal(true)),
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
  /** Codex compacts the AI's memory of the chat: a line while it runs, and once done. */
  "compaction",
  /** A picture the AI generated: the reply shows it; `detail` is its path. */
  "picture",
  /** The AI's progress note, its words as they came: a step, not a reply. */
  "note",
  /**
   * An older Rufi's reader copying one document, before the AI got the
   * message: `detail` says how far; its details name the document.
   */
  "reading",
  "other",
]);
export type ActivityKind = typeof ActivityKind.Type;

/**
 * A face Rufi's AI may show on the dog during a chat (the show_face tool):
 * about the conversation, never about a health result, so none is sad.
 */
export const Face = Schema.Literals([
  "question",
  "found",
  "tip",
  "playful",
  "alert",
]);
export type Face = typeof Face.Type;

/** One item of a chat's transcript, in order by `seq`. */
/**
 * Why an agent's message to the agent that started it came: its turn ended
 * done, stopped or failed, it asked a question, or it wrote.
 */
export const AgentAbout = Schema.Literals([
  "done",
  "asked",
  "wrote",
  "stopped",
  "failed",
]);
export type AgentAbout = typeof AgentAbout.Type;

export const Entry = Schema.Struct({
  id: Schema.String,
  /**
   * Its place: Rufi's own entries count up by one; a step of a reply, kept
   * by the agent system, sits after what its reply started with and before
   * the next of Rufi's entries.
   */
  seq: Schema.Number,
  /** The reply it belongs to. */
  turnId: Schema.NullOr(Schema.String),
  /**
   * reasoning: the AI's thinking for a step, with its summary as the AI
   * service gave it (status running while it thinks, then done, or stopped
   * when its turn ends before the summary is whole); event:
   * Rufi's own factual line about something that happened, never the
   * person's words; brief: the line of a visit brief, whose id is the brief's;
   * agent: a message to Rufi AI from an agent it started, where Rufi AI took it.
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
    "agent",
  ]),
  /**
   * The message; the reply as it came; an activity's text as the agent reported it (the
   * command, `server.tool`, the paths, a note's words; a line stored before
   * notes, its title); the reasoning's summary so far; a receipt's, an
   * event's or a brief's line; an agent's message in its own words (empty
   * when it stopped).
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
  /**
   * The sub-agent this step started: its line shows it (SubAgent); for an
   * agent's message, the agent that sent it.
   */
  agent: Schema.optionalKey(Schema.String),
  /** An agent's message: the agent's name when it sent it, and why it came. */
  from: Schema.optionalKey(
    Schema.Struct({ title: Schema.String, about: AgentAbout }),
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

/** A reply's model and the effort it ran with; null: from before replies kept it. */
const RanOn = Schema.Struct({
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
});

/** One reply the AI ran: how it went, and how it ended. */
export const Turn = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  /** The effort it ran with; null: from before replies kept it. */
  effort: Schema.NullOr(Schema.String),
  /**
   * What the reply before it in the chat ran on, also when that one isn't
   * on the page; null: it is the chat's first.
   */
  before: Schema.NullOr(RanOn),
  status: Schema.Literals(["running", "completed", "interrupted", "failed"]),
  endReason: Schema.NullOr(EndReason),
  /** Why it didn't complete, in plain words. */
  endText: Schema.NullOr(Schema.String),
  /** When a usage limit resets, when the provider said. */
  resetsAt: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  /**
   * A new thread started for this reply: it ran on another agent thread
   * than the reply before it (a lost thread, a move, the person's choice).
   */
  newThread: Schema.Boolean,
  /** Its steps are gone: the agent database that kept them is new. */
  stepsGone: Schema.optionalKey(Schema.Literal(true)),
});
export type Turn = typeof Turn.Type;

/**
 * How hard the AI thinks for a reply: low is faster, xhigh thinks longest.
 * The same four for every model, in order.
 */
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export const Effort = Schema.Literals(EFFORTS);
export type Effort = typeof Effort.Type;

/** A chat's effort until one is chosen for it. */
export const DEFAULT_EFFORT: Effort = "medium";

/**
 * The models Rufi's AI and its agents run on: these four, always, in the
 * menu's order. Rufi never asks the providers for theirs. The first is a
 * new chat's.
 */
export const MODELS = [
  { id: "gpt-6-astra", name: "GPT-6-Astra", provider: "codex" },
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", provider: "codex" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "claude" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "claude" },
] as const;
export type ModelId = (typeof MODELS)[number]["id"];
export const ModelId = Schema.Literals(MODELS.map((model) => model.id));

/** One of the four by its id; another (stored before) is none of them. */
export const modelOf = (id: string) => MODELS.find((model) => model.id === id);

/** A person's one chat with Rufi's AI. */
export const Chat = Schema.Struct({
  /** The model chosen for it; null: the first allowed one, when the first message goes. */
  model: Schema.NullOr(Schema.String),
  /** The effort chosen for it, or the default. */
  effort: Effort,
  /**
   * How much of the model's context the AI's thread used, as the agent last
   * reported it: the last request's tokens and the model's context window.
   * Null before the first report of this thread, or when the agent didn't
   * say the window.
   */
  context: Schema.NullOr(
    Schema.Struct({ tokens: Schema.Int, window: Schema.Int }),
  ),
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
 * goes in turn, unless held; handing_over: Rufi is giving it to the AI.
 */
export const QueueItem = Schema.Struct({
  id: Schema.String,
  origin: Schema.Literals(["person", "rufi"]),
  text: Schema.String,
  state: Schema.Literals(["waiting", "handing_over"]),
  /**
   * Why a waiting row doesn't go by itself: signed_out (the AI found the
   * sign-in missing; it goes once the sign-in is back; heldText says so),
   * restored (from a backup), failed (the AI couldn't take it; heldText
   * says why, as it came), stopped (a Stop came before it went),
   * open_failed (the AI's thread didn't open; heldText says why, and the
   * person chooses Send or New thread).
   */
  held: Schema.NullOr(
    Schema.Literals([
      "signed_out",
      "restored",
      "failed",
      "stopped",
      "open_failed",
    ]),
  ),
  heldText: Schema.NullOr(Schema.String),
  /** Which open_failed hold it is: the person's choice names it. */
  holdId: Schema.NullOr(Schema.String),
  /** A message's references, as its chips. */
  refs: Schema.Array(Chip),
});
export type QueueItem = typeof QueueItem.Type;

/** What waits, in order. */
export const Queue = Schema.Struct({
  items: Schema.Array(QueueItem),
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
    /** The chat, when its model, effort or context used changed. */
    chat: Schema.optionalKey(Chat),
  }),
  /** The queue changed; read it again. */
  Schema.Struct({ type: Schema.Literal("queue") }),
  /** The person's documents or their readings changed; read them again. */
  Schema.Struct({ type: Schema.Literal("documents") }),
  /** The chat's sub-agents did something; read what shows them again. */
  Schema.Struct({ type: Schema.Literal("agents") }),
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

/** What a message sent while a reply runs does: goes into it, or after it. */
export const WhileReplying = Schema.Literals(["steer", "queue"]);
export type WhileReplying = typeof WhileReplying.Type;

export const Settings = Schema.Struct({
  appearance: Appearance,
  activity: ActivityShown,
  /** What Enter does while a reply runs. */
  whileReplying: WhileReplying,
  /** The chosen region; null when none is chosen. */
  emergencyRegion: Schema.NullOr(Schema.String),
  emergency: Schema.NullOr(
    Schema.Struct({ name: Schema.String, number: Schema.String }),
  ),
  /** The regions Rufi knows, to choose from. */
  regions: Schema.Array(Region),
  /** How many restarts in a row Rufi carries on a reply that ran. */
  continuesAfterRestart: Schema.Int,
  /** How long device values are kept (docs/adr/0023). */
  deviceKeepValues: KeepValues,
});
export type Settings = typeof Settings.Type;

/**
 * Everything the agent gave about one step of a reply's Activity, as it
 * came (plain JSON, in the agent's own shape), read when the step opens;
 * null when Rufi kept none.
 */
export const EntryDetails = Schema.Struct({ details: Schema.Unknown });
export type EntryDetails = typeof EntryDetails.Type;

/** A sub-agent of the chat, as its line shows it. */
export const SubAgent = Schema.Struct({
  id: Schema.String,
  /** The name the agent that started it gave it. */
  title: Schema.String,
  status: Schema.Literals([
    "idle",
    "running",
    "continuing",
    "done",
    "stopped",
    "failed",
  ]),
  /** Its latest result, its start: its last answer, or why it stopped or failed. */
  result: Schema.NullOr(Schema.String),
  /** The agent that started it: Rufi AI's own agents have none here. */
  parent: Schema.NullOr(Schema.String),
  /** When its turn now began, while it works and has begun one. */
  since: Schema.NullOr(Schema.String),
  /** What its next turn runs on. */
  model: Schema.String,
  effort: Schema.String,
});
export type SubAgent = typeof SubAgent.Type;

export const SubAgents = Schema.Struct({ agents: Schema.Array(SubAgent) });

/**
 * One line of a sub-agent's Activity, as its agent reported it: a message
 * it took (`from` whom), its answer (reply), a note or a step (activity),
 * its thinking, a question it asked (`detail`: the options), how a turn
 * that didn't finish ended, or that a turn ran on another model or effort
 * than the one before (model).
 */
export const AgentLine = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "message",
    "reply",
    "activity",
    "reasoning",
    "question",
    "end",
    "model",
  ]),
  /** A model line: the turn before ran on `from`, this one on `to`. */
  changed: Schema.optionalKey(Schema.Struct({ from: RanOn, to: RanOn })),
  text: Schema.String,
  from: Schema.optionalKey(Schema.String),
  activity: Schema.NullOr(ActivityKind),
  detail: Schema.NullOr(Schema.String),
  status: Schema.NullOr(
    Schema.Literals(["running", "done", "failed", "stopped"]),
  ),
  updatedAt: Schema.String,
  /** The sub-agent this step started. */
  agent: Schema.optionalKey(Schema.String),
});
export type AgentLine = typeof AgentLine.Type;

/** A sub-agent's latest lines, and whether it has earlier ones. */
export const AgentLog = Schema.Struct({
  lines: Schema.Array(AgentLine),
  earlier: Schema.Boolean,
});
export type AgentLog = typeof AgentLog.Type;

/** The providers the AI runs on, each signed in by itself. */
export const Provider = Schema.Literals(["codex", "claude"]);
export type Provider = typeof Provider.Type;

/**
 * A provider's sign-in, as the provider reports it: its account when it
 * names one. Unavailable: Rufi can't ask it (not installed, say), with why.
 */
export const ProviderStatus = Schema.Struct({
  state: Schema.Literals(["signed_in", "signed_out", "unavailable"]),
  account: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
});
export type ProviderStatus = typeof ProviderStatus.Type;

/** Each provider's sign-in, as the screens need it; the chat runs on Codex. */
export const Status = Schema.Struct({
  codex: ProviderStatus,
  claude: ProviderStatus,
});
export type Status = typeof Status.Type;

/**
 * How a sign-in from the screens goes, one at a time: the provider's own
 * sign-in in the browser; waiting has its link once it is known.
 */
export const SignInState = Schema.Struct({
  provider: Schema.NullOr(Provider),
  state: Schema.Literals(["idle", "waiting", "done", "failed"]),
  link: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type SignInState = typeof SignInState.Type;

/** Starts a provider's sign-in. */
export const StartSignIn = Schema.Struct({ provider: Provider });
export type StartSignIn = typeof StartSignIn.Type;

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

/**
 * The welcome's "About you": your name and your profile, its birth date and
 * sex needed, its blood group and height when given. All saved together.
 */
export const AddPerson = Schema.Struct({
  displayName: Line(200),
  profile: Schema.Struct({
    birth_date: BirthDate,
    sex_for_ranges: SexForRanges,
    blood_group: Schema.optionalKey(ProfileValues.fields.blood_group),
    height: Schema.optionalKey(ProfileValues.fields.height),
  }),
});

/** The settings to change; the others stay as they are. */
export const SaveSettings = Schema.Struct({
  appearance: Schema.optionalKey(Appearance),
  activity: Schema.optionalKey(ActivityShown),
  whileReplying: Schema.optionalKey(WhileReplying),
  /** A region code Rufi knows, such as "IN"; null clears it. */
  emergencyRegion: Schema.optionalKey(Schema.NullOr(Line(10))),
  /** How many restarts in a row Rufi carries on a reply that ran: 0 to 10. */
  continuesAfterRestart: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(10),
    ),
  ),
  /** A shorter time deletes at once: the screen confirms it first. */
  deviceKeepValues: Schema.optionalKey(KeepValues),
});

const Message = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_MESSAGE_CHARS),
);

/** A waiting message, edited. */
export const MessageText = Schema.Struct({ text: Message });

/**
 * A message from the box, sent into the queue, from where it goes into the
 * running reply or in its turn. `id` is the send's own: the same send again (a retry) finds the
 * message it made and never makes a second one. Its text may be empty when
 * something is added to it (files sent with no words).
 */
export const SendMessage = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  text: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMaxLength(MAX_MESSAGE_CHARS),
  ),
  /** Its chips: what it points at. */
  refs: Schema.optionalKey(Pointers),
  /** While a reply runs: into it (steer, the default), or after it (queue). */
  kind: Schema.optionalKey(WhileReplying),
});

/** The box's text and chips, saved over the draft unless a send holds it. */
export const SaveDraft = Schema.Struct({
  text: Text(MAX_MESSAGE_CHARS),
  refs: Schema.optionalKey(Pointers),
});

export const ReorderQueue = Schema.Struct({ ids: Schema.Array(Id) });

/**
 * The person's choice for a message whose AI thread didn't open, naming
 * the hold they saw: try the same thread again, or start a new thread.
 */
export const RecoverMessage = Schema.Struct({
  hold: Id,
  choice: Schema.Literals(["retry", "new_thread"]),
});

/**
 * A first-run step done: welcome (ticked "not a doctor"), sign_in (skipped),
 * region (saved or skipped).
 */
export const FinishStep = Schema.Struct({
  step: Schema.Literals(["welcome", "sign_in", "region"]),
});

export const SelectModel = Schema.Struct({ model: ModelId });

export const SelectEffort = Schema.Struct({ effort: Effort });
