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
  "other",
]);
export type ActivityKind = typeof ActivityKind.Type;

/** One item of a conversation's transcript, in order by `seq`. */
export const Entry = Schema.Struct({
  id: Schema.String,
  seq: Schema.Int,
  /** The reply it belongs to. */
  turnId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["message", "steer", "activity", "reply"]),
  /** The message or the reply; an activity's short title. */
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
});
export type Turn = typeof Turn.Type;

export const Conversation = Schema.Struct({
  id: Schema.String,
  /** The first words of the first message Rufi took; null until then. */
  title: Schema.NullOr(Schema.String),
  provider: Schema.String,
  /** The model chosen for it; null: the first allowed one, when the first message goes. */
  model: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type Conversation = typeof Conversation.Type;

/** A message the AI holds until the running reply has ended. */
export const WaitingMessage = Schema.Struct({
  id: Schema.String,
  messageId: Schema.String,
  text: Schema.String,
});
export type WaitingMessage = typeof WaitingMessage.Type;

/**
 * One line of a conversation's live stream (NDJSON). It starts with a
 * snapshot; each update replaces entries and turns by id. A screen that falls
 * behind, or reconnects, gets a new snapshot.
 */
export const StreamLine = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    revision: Schema.Int,
    conversation: Conversation,
    entries: Schema.Array(Entry),
    turns: Schema.Array(Turn),
  }),
  Schema.Struct({
    type: Schema.Literal("update"),
    revision: Schema.Int,
    entries: Schema.Array(Entry),
    turns: Schema.Array(Turn),
    /** The conversation, when its title or model changed. */
    conversation: Schema.optionalKey(Conversation),
  }),
  /** The waiting messages changed; read them again. */
  Schema.Struct({ type: Schema.Literal("waiting") }),
  /** Nothing happened for a while; the stream is still open. */
  Schema.Struct({ type: Schema.Literal("ping") }),
]);
export type StreamLine = typeof StreamLine.Type;

/** A person's conversations, newest first, and the one the chat continues. */
export const Conversations = Schema.Struct({
  conversations: Schema.Array(Conversation),
  /** The conversation to open the chat on: the last choice a tab saved. */
  chosen: Schema.NullOr(Schema.String),
});

export const WaitingMessages = Schema.Struct({
  messages: Schema.Array(WaitingMessage),
});

/**
 * The unsent text of a conversation's box. Its revision grows with every
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

export const Settings = Schema.Struct({
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

/** One current result, exactly as printed. */
export const OverviewResult = Schema.Struct({
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

export const SaveSettings = Schema.Struct({
  /** A region code Rufi knows, such as "IN"; null clears it. */
  emergencyRegion: Schema.NullOr(Line(10)),
});

export const CreateConversation = Schema.Struct({
  title: Schema.optionalKey(Line(200)),
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

/** The conversation Rufi opens the chat on next time. */
export const ChooseConversation = Schema.Struct({ conversationId: Id });

export const ReorderWaiting = Schema.Struct({ ids: Schema.Array(Id) });

export const SelectModel = Schema.Struct({ model: Id });
