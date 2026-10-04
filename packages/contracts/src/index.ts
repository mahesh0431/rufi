// What Rufi's local API takes and gives, shared by the server and the screens.
// Requests are decoded with these schemas; responses are built to their types.
import { Schema } from "effect";

/** The longest message or draft Rufi takes, in characters. */
export const MAX_MESSAGE_CHARS = 100_000;

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
  title: Schema.String,
  provider: Schema.String,
  model: Schema.String,
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
  }),
  /** The waiting messages changed; read them again. */
  Schema.Struct({ type: Schema.Literal("waiting") }),
  /** Nothing happened for a while; the stream is still open. */
  Schema.Struct({ type: Schema.Literal("ping") }),
]);
export type StreamLine = typeof StreamLine.Type;

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

/** A message: sent, steered in, or a waiting one edited. */
export const MessageText = Schema.Struct({
  text: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_MESSAGE_CHARS),
  ),
});

export const SaveDraft = Schema.Struct({ text: Text(MAX_MESSAGE_CHARS) });

export const ReorderWaiting = Schema.Struct({ ids: Schema.Array(Id) });

export const SelectModel = Schema.Struct({ model: Id });
