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

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Line = (max: number) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
  );
const Id = Line(100);

// --- What the screens get ---

// TODO: drop the kind if it gets complicated. To an agent everything is a
// tool call; the title and detail already say what it did. Keep this list
// only while it stays small and each adapter can fill it in one line.
export const ActivityKind = Schema.Literals([
  "tool",
  "command",
  "web_search",
  "file_change",
  "sub_agent",
  /** The AI compacted its memory of the chat (shown only once done). */
  "compaction",
  "other",
]);
export type ActivityKind = typeof ActivityKind.Type;

/** One item of a chat's transcript, in order by `seq`. */
export const Entry = Schema.Struct({
  id: Schema.String,
  seq: Schema.Int,
  /** The reply it belongs to. */
  turnId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["message", "steer", "activity", "reply", "receipt"]),
  /**
   * The message; the reply's answer (without its rufi-basis blocks, which
   * the turn's How holds); an activity's short title; a receipt's line.
   */
  text: Schema.String,
  activity: Schema.NullOr(ActivityKind),
  /** An activity's one short detail: the query, the search words, the command. */
  detail: Schema.NullOr(Schema.String),
  status: Schema.NullOr(
    Schema.Literals(["running", "done", "failed", "stopped"]),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
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

/**
 * One thing Rufi saw the AI read in a reply, for Based on's Used: a read of
 * the record by one of Rufi's tools, a web search or page, a command, a
 * sub-agent. What was read, not proof that it supports the answer.
 */
export const Read = Schema.Struct({
  /** What was read, in plain words: "Read your records", "Searched the web". */
  title: Schema.String,
  /** Which records and dates, the search words, the page or the command. */
  detail: Schema.NullOr(Schema.String),
  /**
   * done; capped: a cap left some out; failed: nothing came back;
   * stopped: it ended unfinished; unknown: the AI's agent didn't say what
   * came back.
   */
  outcome: Schema.Literals(["done", "capped", "failed", "stopped", "unknown"]),
  /** What came back, or why not, in Rufi's words: "12 records", the error. */
  note: Schema.NullOr(Schema.String),
});
export type Read = typeof Read.Type;

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
  /** Used: what Rufi saw the AI read in this reply, in order. */
  used: Schema.Array(Read),
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

/** A message the AI holds until the running reply has ended. */
export const WaitingMessage = Schema.Struct({
  id: Schema.String,
  messageId: Schema.String,
  text: Schema.String,
});
export type WaitingMessage = typeof WaitingMessage.Type;

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
  /** The waiting messages changed; read them again. */
  Schema.Struct({ type: Schema.Literal("waiting") }),
  /** Nothing happened for a while; the stream is still open. */
  Schema.Struct({ type: Schema.Literal("ping") }),
]);
export type StreamLine = typeof StreamLine.Type;

export const WaitingMessages = Schema.Struct({
  messages: Schema.Array(WaitingMessage),
});

/**
 * The unsent text of a chat's box. Its revision grows with every
 * change, so a save based on an older revision is refused. `sending`: a
 * send holds it until the agent took or refused the message, and it can't
 * be changed meanwhile; `unknown`: Rufi stopped during that send, so the
 * text stays and nobody knows whether the agent has it.
 */
export const Draft = Schema.Struct({
  text: Schema.String,
  revision: Schema.Int,
  state: Schema.Literals(["editable", "sending", "unknown"]),
});
export type Draft = typeof Draft.Type;

/**
 * A refused save or send: the draft changed meanwhile (another tab), or a
 * send holds it.
 */
export const DraftChanged = Schema.Struct({ draft: Draft });

/** A message the core took, and the box's draft after it. */
export const Sent = Schema.Struct({ id: Schema.String, draft: Draft });

/** A message the core didn't send: the box's draft, which keeps it. */
export const NotSent = Schema.Struct({ draft: Draft });

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

export const Settings = Schema.Struct({
  appearance: Appearance,
  /** The chosen region; null when none is chosen. */
  emergencyRegion: Schema.NullOr(Schema.String),
  emergency: Schema.NullOr(
    Schema.Struct({ name: Schema.String, number: Schema.String }),
  ),
  /** The regions Rufi knows, to choose from. */
  regions: Schema.Array(Region),
});
export type Settings = typeof Settings.Type;

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

/** One current result, exactly as printed. */
export const OverviewResult = Schema.Struct({
  id: Schema.String,
  test: Schema.String,
  value: Schema.String,
  unit: Schema.optionalKey(Schema.String),
  range: Schema.optionalKey(Schema.String),
  flag: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.String),
  /** The date at the precision known: "2026", "2026-08" or "2026-08-12". */
  measured: Schema.optionalKey(Schema.String),
  amended: Schema.optionalKey(Schema.Boolean),
});
export type OverviewResult = typeof OverviewResult.Type;

/** A person's record at a glance (the same read as the AI's get_overview). */
export const Overview = Schema.Struct({
  person: Schema.String,
  documents: Schema.Int,
  reports: Schema.Int,
  /** Current results; `latest_results` shows the newest of them. */
  results: Schema.Int,
  earlier_versions_kept: Schema.Int,
  latest_results: Schema.Array(OverviewResult),
});
export type Overview = typeof Overview.Type;

// --- What the screens send ---

export const AddPerson = Schema.Struct({ displayName: Line(200) });

/** The settings to change; the others stay as they are. */
export const SaveSettings = Schema.Struct({
  appearance: Schema.optionalKey(Appearance),
  /** A region code Rufi knows, such as "IN"; null clears it. */
  emergencyRegion: Schema.optionalKey(Schema.NullOr(Line(10))),
});

const Message = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_MESSAGE_CHARS),
);

/** A waiting message, edited. */
export const MessageText = Schema.Struct({ text: Message });

/**
 * A message from the box: sent or steered in. `draft` is the revision the
 * box saved this text at: the core sends only the text it keeps as the
 * draft at that revision (else 409 with the draft as it is), and holds the
 * draft until the agent took the message (emptied) or refused it.
 */
export const SendMessage = Schema.Struct({ text: Message, draft: Schema.Int });

/** The box's text, based on the draft's revision as the box last saw it. */
export const SaveDraft = Schema.Struct({
  text: Text(MAX_MESSAGE_CHARS),
  revision: Schema.Int,
});

export const ReorderWaiting = Schema.Struct({ ids: Schema.Array(Id) });

/**
 * A first-run step done: welcome (ticked "not a doctor"), sign_in (skipped),
 * region (saved or skipped).
 */
export const FinishStep = Schema.Struct({
  step: Schema.Literals(["welcome", "sign_in", "region"]),
});

export const SelectModel = Schema.Struct({ model: Id });

export const SelectEffort = Schema.Struct({ effort: Effort });
