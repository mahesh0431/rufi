// Each person's chat and its transcript (docs/adr/0004): what the user
// said, the AI's replies and the questions it asked, receipts and events,
// in order, and each call to Rufi's tools. Rufi AI's steps and reasoning
// are kept by the agent system and merged into their replies when read;
// older replies keep theirs here. Every change is one transaction that
// moves the chat's revision on, and is published to listeners only after
// it is stored.
import {
  type ActivityKind,
  type AgentAbout,
  type Chat,
  type Chip,
  DEFAULT_EFFORT,
  type Effort,
  type EndReason,
  type Entry,
  type Page,
  type Pointer,
  type Ref,
  type Turn,
} from "@rufi/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Made } from "../briefs/briefs.ts";
import { literal } from "../record/kinds.ts";
import type { Saved } from "../record/save.ts";
import { changeProfile } from "../record/profile.ts";
import type { AddPerson } from "@rufi/contracts";
import { addRow } from "./queue.ts";
import { chipsOf } from "./refs.ts";
import { CLOSED_WHILE_READING } from "../documents/reading.ts";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";

/** What a receipt is written for: a save, or a dismissal of draft items. */
interface Receipted {
  /** The receipt's id. */
  id: string;
  receipt: string;
  /** False: nothing new, so no receipt. */
  fresh: boolean;
}

/** A person's chat with the agent thread it points at. */
export interface ChatRow extends Chat {
  id: string;
  personId: string;
  /** The provider its model runs on, kept with the choice. */
  modelProvider: string | null;
  threadId: string | null;
  threadProvider: string | null;
  /** The model the thread started with; each turn keeps its own. */
  threadModel: string | null;
  /**
   * The version of the rules the thread started with (core/chat/
   * instructions.ts); the column's name is from when it named the tools.
   * Rules told to it since are known while Rufi runs (server/rufi-ai.ts).
   */
  threadTools: string | null;
}

/** What one write changed, for the live stream. */
export interface Change {
  chatId: string;
  revision: number;
  entries: Entry[];
  turns: Turn[];
  /** The chat, when its model, effort or context used changed. */
  chat?: Chat;
}

export interface TurnEnding {
  status: "completed" | "interrupted" | "failed";
  reason?: EndReason;
  text?: string;
  resetsAt?: string;
}

/**
 * What a reply reported, as the agent system keeps it (server/rufi-ai.ts):
 * its steps, notes and reasoning show from there.
 */
export interface Step {
  /** The agent's item id. */
  id: string;
  /** Its place in its reply, from when the reply first reported it. */
  position: number;
  type: "text" | "note" | "question" | "reasoning" | "step";
  kind: string | null;
  title: string | null;
  detail: string | null;
  /** A step's, as reported; `done` for a note or reasoning once whole. */
  status: string | null;
  text: string | null;
  createdAt: string;
  updatedAt: string;
  /** The sub-agent this step started. */
  agent?: string;
}

/** Where the agent system keeps the steps of a chat's replies, by its agent. */
export interface Steps {
  /**
   * What these turns of the agent reported, by agent turn: each turn it
   * keeps, also one that reported nothing.
   */
  of: (
    agent: string,
    agentTurns: readonly string[],
  ) => ReadonlyMap<string, readonly Step[]>;
  /** Everything the agent gave about one item; undefined when it has none. */
  details: (
    agent: string,
    agentTurn: string,
    id: string,
  ) => { details: unknown } | undefined;
}

/** A question the AI asked in its reply, as it gave it. */
export interface Question {
  title: string;
  options: readonly string[];
}

/** An agent's call to Rufi's tools, as Rufi keeps it with its answer. */
export interface ToolCall {
  /** The agent, and its turn in the agent database. */
  agent: string;
  agentTurn: string;
  /** That turn as its provider names it: a root turn's reply has it. */
  ref: string;
  /** Rufi's id for the call. */
  callId: string;
  tool: string;
  /** What the AI sent, as it came. */
  input: unknown;
  startedAt: string;
  /** A sub-agent's title, which the call's line in the chat names. */
  label?: string;
}

/** A receipt's heading, then the sub-agent's title that saved it, if any. */
const labelled = (receipt: string, label: string | undefined) => {
  if (label === undefined) return receipt;
  const [head = "", ...rest] = receipt.split("\n\n");
  return [`${head} · ${literal(label)}`, ...rest].join("\n\n");
};

/** The answer the AI gets, as Rufi keeps it. */
export interface Answered {
  ok: boolean;
  text: string;
}

type Db = Kysely<Tables> | Transaction<Tables>;

/**
 * Transcript rows in one page, at most, before it is widened to whole
 * turns: the latest page opens the chat, and each older one is read as the
 * person scrolls up.
 */
export const PAGE_ROWS = 60;

type EntryRow = Selectable<Tables["transcript_entries"]>;
type TurnRow = Selectable<Tables["turns"]>;

/** Places a reply's steps may take between two of Rufi's entries. */
const STEP_PLACES = 1_000_000;

/** What a reply reported that shows in its Activity, not as its answer. */
const isStep = (step: Step) =>
  step.type === "note" || step.type === "reasoning" || step.type === "step";

/** A step's id on the screens: its reply's, then the agent's item id. */
const stepId = (turnId: string, itemId: string) =>
  `${turnId}.${Buffer.from(itemId).toString("base64url")}`;

/**
 * A step's status as the screens show it, as reported; a note or a
 * reasoning is done once whole. One still running when its turn `ended`
 * was stopped.
 */
export function shownStatus(
  step: Pick<Step, "type" | "status">,
  ended: boolean,
): Entry["status"] {
  const reported = step.status as Entry["status"];
  return step.type === "step"
    ? reported === "running" && ended
      ? "stopped"
      : reported
    : reported === "done"
      ? "done"
      : ended
        ? "stopped"
        : "running";
}

/**
 * A step as the screens get it, after `anchor` by its place in its reply.
 * One still running when its reply ended was stopped.
 */
function stepEntry(turn: TurnRow, step: Step, anchor: number): Entry {
  return {
    id: stepId(turn.id, step.id),
    seq: anchor + step.position / STEP_PLACES,
    turnId: turn.id,
    kind: step.type === "reasoning" ? "reasoning" : "activity",
    text: (step.type === "step" ? step.title : step.text) ?? "",
    activity:
      step.type === "note"
        ? "note"
        : step.type === "step"
          ? (step.kind as ActivityKind)
          : null,
    detail: step.type === "step" ? step.detail : null,
    status: shownStatus(step, turn.status !== "running"),
    createdAt: step.createdAt,
    updatedAt: step.updatedAt,
    ...(step.agent !== undefined && { agent: step.agent }),
  };
}

/** A reply's questions, as its row keeps them apart from its answer. */
const questionsOf = (questions: string | null): Question[] =>
  questions === null ? [] : (JSON.parse(questions) as Question[]);

/** A reply's text as it shows: its answer, then each question it asked. */
export const withQuestions = (answer: string, questions: string | null) =>
  [
    answer,
    ...questionsOf(questions).map(
      ({ title, options }) =>
        `**${title}**${options.map((option) => `\n- ${option}`).join("")}`,
    ),
  ]
    .filter((part) => part !== "")
    .join("\n\n");

/**
 * Whether a reply or note is whole: its turn completed and it wasn't cut
 * (a message sent into the reply can cut it while the turn goes on). An older reply has no
 * status and follows its turn.
 */
const whole = (
  status: EntryRow["status"],
  turnStatus: TurnRow["status"] | null | undefined,
) => turnStatus === "completed" && status !== "stopped";

/** An entry as the screens get it. */
const toEntry = (
  row: EntryRow,
  turnStatus: TurnRow["status"] | undefined,
): Entry => ({
  id: row.id,
  seq: row.seq,
  turnId: row.turn_id,
  kind: row.kind as Entry["kind"],
  text:
    row.kind === "reply" ? withQuestions(row.text, row.questions) : row.text,
  activity: row.activity as Entry["activity"],
  detail: row.detail,
  // Reasoning is whole once the agent gave all of it; a partial summary
  // stops with its turn, without changing what the agent gave.
  status:
    row.kind === "reasoning"
      ? row.details === null
        ? turnStatus === "running"
          ? "running"
          : "stopped"
        : "done"
      : row.kind === "reply"
        ? null
        : (row.status as Entry["status"]),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.refs !== null && { refs: JSON.parse(row.refs) as Chip[] }),
  ...(row.kind === "event" && linkOf(row.details)),
  ...(row.activity === "reading" && linkOf(row.details, true)),
  ...(row.kind === "agent" && senderOf(row.details)),
});

/**
 * A message to Rufi AI from an agent it started, as Rufi AI took it: its
 * input's id, the agent, its name then, why it came and its own words.
 */
export interface AgentMessage {
  input: string;
  agent: string;
  title: string;
  about: AgentAbout;
  said: string;
}

/** An agent's message's agent and its name and why, from its stored facts. */
export function senderOf(
  details: string | null,
): Pick<Entry, "agent" | "from"> {
  const { agent, title, about } = JSON.parse(details ?? "{}") as Partial<
    Omit<AgentMessage, "input" | "said">
  >;
  return agent === undefined || title === undefined || about === undefined
    ? {}
    : { agent, from: { title, about } };
}

const SAYS = {
  done: "done:",
  asked: "asks:",
  wrote: "writes:",
  stopped: "stopped.",
  failed: "failed:",
} as const;

/**
 * An agent's message as Rufi AI gets it from an earlier thread: Rufi's line
 * naming the agent by its name and id, then its words.
 */
function agentLine(details: string | null, text: string): string {
  const { agent, from } = senderOf(details);
  if (agent === undefined || from === undefined) return text;
  return [`${from.title} (${agent}) ${SAYS[from.about]}`, text]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * An event's link to its document, from its facts, or a reading step's to
 * its reading; none once it is deleted.
 */
function linkOf(details: string | null, reading = false): Pick<Entry, "link"> {
  type Facts = { document?: unknown; action?: unknown; deleted?: unknown };
  const stored = JSON.parse(details ?? "{}") as Facts & { facts?: Facts };
  const facts = reading ? { ...stored, action: "open" } : stored.facts;
  return typeof facts?.document === "string" &&
    facts.deleted !== true &&
    (facts.action === "open" || facts.action === "retry")
    ? { link: { document: facts.document, action: facts.action } }
    : {};
}

/** A chat as the screens get it, without its thread. */
const shown = ({ model, effort, context }: Chat): Chat => ({
  model,
  effort,
  context,
});

/**
 * The context the chat's thread used, as last reported: only a report of
 * the thread it uses now, with a window.
 */
const contextOf = (row: Selectable<Tables["chats"]>): Chat["context"] =>
  row.context_thread !== null &&
  row.context_thread === row.thread_id &&
  row.context_tokens !== null &&
  row.context_window !== null &&
  row.context_window > 0
    ? { tokens: row.context_tokens, window: row.context_window }
    : null;

const toChat = (row: Selectable<Tables["chats"]>): ChatRow => ({
  id: row.id,
  personId: row.person_id,
  model: row.model,
  modelProvider: row.model_provider,
  effort: (row.effort as Effort | null) ?? DEFAULT_EFFORT,
  context: contextOf(row),
  threadId: row.thread_id,
  threadProvider: row.thread_provider,
  threadModel: row.thread_model,
  threadTools: row.thread_tools,
});

/** Entries as the screens get them, with replies and reasoning by their turn's state. */
async function entriesOut(trx: Db, rows: EntryRow[]): Promise<Entry[]> {
  const turnIds = [
    ...new Set(
      rows.flatMap((row) =>
        (row.kind === "reply" || row.kind === "reasoning") &&
        row.turn_id !== null
          ? [row.turn_id]
          : [],
      ),
    ),
  ];
  const statuses = new Map(
    turnIds.length === 0
      ? []
      : (
          await trx
            .selectFrom("turns")
            .select(["id", "status"])
            .where("id", "in", turnIds)
            .execute()
        ).map((turn) => [turn.id, turn.status]),
  );
  return rows.map((row) =>
    toEntry(row, row.turn_id === null ? undefined : statuses.get(row.turn_id)),
  );
}

/**
 * Turns as the screens get them. A turn on another agent thread than the turn before it is on a new thread;
 * the chat's first turn isn't.
 */
async function turnsOut(trx: Db, rows: TurnRow[]): Promise<Turn[]> {
  const first = rows[0];
  if (!first) return [];
  const ids = rows.map((row) => row.id);
  const before = new Map(
    (
      await trx
        .selectFrom("turns as t")
        .select((eb) => [
          "t.id",
          eb
            .selectFrom("turns as p")
            .select("p.thread_id")
            .whereRef("p.person_id", "=", "t.person_id")
            .whereRef("p.chat_id", "=", "t.chat_id")
            .where("p.thread_id", "is not", null)
            .where((p) =>
              p.or([
                p("p.started_at", "<", p.ref("t.started_at")),
                p.and([
                  p("p.started_at", "=", p.ref("t.started_at")),
                  p("p.id", "<", p.ref("t.id")),
                ]),
              ]),
            )
            .orderBy("p.started_at", "desc")
            .orderBy("p.id", "desc")
            .limit(1)
            .as("thread_before"),
        ])
        .where("t.person_id", "=", first.person_id)
        .where("t.id", "in", ids)
        .execute()
    ).map((row) => [row.id, row.thread_before]),
  );
  return rows.map((row) => {
    const threadBefore = before.get(row.id) ?? null;
    return {
      id: row.id,
      model: row.model,
      status: row.status as Turn["status"],
      endReason: row.end_reason as Turn["endReason"],
      endText: row.end_text,
      resetsAt: row.resets_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      newThread:
        row.thread_id !== null &&
        threadBefore !== null &&
        threadBefore !== row.thread_id,
    };
  });
}

export type Transcripts = ReturnType<typeof transcripts>;

export function transcripts(
  store: Store,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;
  const listeners = new Map<string, Set<(change: Change) => void>>();
  /** Where the agent system keeps replies' steps, once it says. */
  let steps: Steps | undefined;

  /**
   * One write to a chat: `write` gets the new revision and returns
   * the ids of the entries and turns it changed. Listeners hear of it after
   * the commit; undefined when nothing changed.
   */
  async function change(
    chatId: string,
    write: (
      trx: Transaction<Tables>,
      revision: number,
    ) => Promise<
      | {
          entries: string[];
          turns: string[];
          chat?: true;
          /** Steps shown as they are, stored elsewhere. */
          shown?: Entry[];
        }
      | undefined
    >,
  ): Promise<Change | undefined> {
    const changed = await db.transaction().execute(async (trx) => {
      const { revision } = await trx
        .updateTable("chats")
        .set((eb) => ({ revision: eb("revision", "+", 1) }))
        .where("id", "=", chatId)
        .returning("revision")
        .executeTakeFirstOrThrow();
      const ids = await write(trx, revision);
      if (!ids) {
        // Nothing to store: the revision goes back too.
        await trx
          .updateTable("chats")
          .set({ revision: revision - 1 })
          .where("id", "=", chatId)
          .execute();
        return undefined;
      }
      const entries =
        ids.entries.length === 0
          ? []
          : await trx
              .selectFrom("transcript_entries")
              .selectAll()
              .where("id", "in", ids.entries)
              .orderBy("seq")
              .execute();
      const turns =
        ids.turns.length === 0
          ? []
          : await trx
              .selectFrom("turns")
              .selectAll()
              .where("id", "in", ids.turns)
              .execute();
      const chat = ids.chat
        ? await trx
            .selectFrom("chats")
            .selectAll()
            .where("id", "=", chatId)
            .executeTakeFirstOrThrow()
        : undefined;
      return {
        chatId,
        revision,
        entries: [...(await entriesOut(trx, entries)), ...(ids.shown ?? [])],
        turns: await turnsOut(trx, turns),
        ...(chat && {
          chat: shown(toChat(chat)),
        }),
      };
    });
    if (changed) {
      for (const listener of listeners.get(chatId) ?? []) {
        listener(changed);
      }
    }
    return changed;
  }

  const nextSeq = async (trx: Db, chatId: string) =>
    ((
      await trx
        .selectFrom("transcript_entries")
        .select((eb) => eb.fn.max("seq").as("last"))
        .where("chat_id", "=", chatId)
        .executeTakeFirst()
    )?.last ?? 0) + 1;

  const turnOf = (trx: Db, chatId: string, agentTurnId: string) =>
    trx
      .selectFrom("turns")
      .selectAll()
      .where("chat_id", "=", chatId)
      .where("agent_turn_id", "=", agentTurnId)
      .executeTakeFirst();

  /**
   * An agent's call, with the answer the AI got: in its reply, when it is
   * a root turn's.
   */
  const keepCall = async (
    trx: Db,
    chat: ChatRow,
    reply: TurnRow | undefined,
    call: ToolCall,
    answer: Answered,
  ) => {
    await trx
      .insertInto("tool_calls")
      .values({
        id: uuid(),
        person_id: chat.personId,
        chat_id: chat.id,
        turn_id: reply?.id ?? null,
        agent_id: call.agent,
        agent_turn_id: call.agentTurn,
        call_id: call.callId,
        tool: call.tool,
        input: JSON.stringify(call.input ?? null),
        answer: answer.text,
        ok: answer.ok ? 1 : 0,
        started_at: call.startedAt,
        ended_at: now(),
      })
      .execute();
  };

  /** The reply or activity entry for an agent item of a turn. */
  const itemOf = (trx: Db, turn: TurnRow, itemId: string, kind: string) =>
    trx
      .selectFrom("transcript_entries")
      .selectAll()
      .where("person_id", "=", turn.person_id)
      .where("turn_id", "=", turn.id)
      .where("agent_item_id", "=", itemId)
      .where("kind", "=", kind)
      .executeTakeFirst();

  /**
   * Where a reply's steps go: after the last of what it started with (its
   * messages, its agents' messages, Rufi's events and Rufi's reading), else
   * after the last entry before it started.
   */
  async function anchorOf(trx: Db, turn: TurnRow): Promise<number> {
    const { opening } = await trx
      .selectFrom("transcript_entries")
      .select((eb) => eb.fn.max<number | null>("seq").as("opening"))
      .where("person_id", "=", turn.person_id)
      .where("turn_id", "=", turn.id)
      .where((eb) =>
        eb.or([
          eb("kind", "in", ["message", "event", "activity"]),
          // An agent's message it started with; not one steered in later.
          eb.and([
            eb("kind", "=", "agent"),
            eb(sql`json_extract(details, '$.steered')`, "is", null),
          ]),
        ]),
      )
      .executeTakeFirstOrThrow();
    if (opening !== null) return opening;
    const { before } = await trx
      .selectFrom("transcript_entries")
      .select((eb) => eb.fn.max<number | null>("seq").as("before"))
      .where("person_id", "=", turn.person_id)
      .where("chat_id", "=", turn.chat_id)
      .where("created_at", "<=", turn.started_at)
      .executeTakeFirstOrThrow();
    return before ?? 0;
  }

  /** The chat's own agent in the agent system, when it has one. */
  const rootOf = async (trx: Db, chat: ChatRow) =>
    (
      await trx
        .selectFrom("agent_owners")
        .select("agent_id")
        .where("person_id", "=", chat.personId)
        .where("chat_id", "=", chat.id)
        .where("root", "=", 1)
        .executeTakeFirst()
    )?.agent_id;

  /**
   * The steps of these replies the agent system keeps, as the screens get
   * them, and the replies whose steps it no longer keeps (`gone`: a new
   * agent database). A reply whose steps Rufi stored itself (one from
   * before) has none from there.
   */
  async function stepsOf(
    trx: Db,
    chat: ChatRow,
    turns: readonly TurnRow[],
  ): Promise<{ entries: Entry[]; gone: Set<string> }> {
    const gone = new Set<string>();
    if (!steps) return { entries: [], gone };
    const fresh: (TurnRow & { agent_turn_id: string })[] = [];
    for (const turn of turns) {
      if (turn.agent_turn_id === null) continue;
      const stored = await trx
        .selectFrom("transcript_entries")
        .select("id")
        .where("person_id", "=", turn.person_id)
        .where("turn_id", "=", turn.id)
        .where((eb) =>
          eb.or([
            eb("kind", "=", "reasoning"),
            eb.and([
              eb("kind", "=", "activity"),
              eb("activity", "!=", "reading"),
            ]),
          ]),
        )
        .executeTakeFirst();
      if (!stored) fresh.push({ ...turn, agent_turn_id: turn.agent_turn_id });
    }
    const agent = await rootOf(trx, chat);
    if (fresh.length === 0 || agent === undefined) return { entries: [], gone };
    const kept = steps.of(
      agent,
      fresh.map((turn) => turn.agent_turn_id),
    );
    const out: Entry[] = [];
    for (const turn of fresh) {
      const reported = kept.get(turn.agent_turn_id);
      if (!reported) gone.add(turn.id);
      const shown = (reported ?? []).filter(isStep);
      if (shown.length === 0) continue;
      const anchor = await anchorOf(trx, turn);
      out.push(...shown.map((step) => stepEntry(turn, step, anchor)));
    }
    return { entries: out, gone };
  }

  async function insertEntry(
    trx: Transaction<Tables>,
    chat: ChatRow,
    revision: number,
    entry: {
      id?: string;
      turnId: string | null;
      kind: Entry["kind"];
      text: string;
      activity?: ActivityKind;
      detail?: string;
      status?: NonNullable<Entry["status"]>;
      agentItemId?: string;
      details?: string;
      /** A reply's questions, JSON. */
      questions?: string;
      /** A message's chips. */
      refs?: readonly Chip[];
    },
  ): Promise<string> {
    const id = entry.id ?? uuid();
    const at = now();
    await trx
      .insertInto("transcript_entries")
      .values({
        id,
        person_id: chat.personId,
        chat_id: chat.id,
        seq: await nextSeq(trx, chat.id),
        turn_id: entry.turnId,
        kind: entry.kind,
        text: entry.text,
        activity: entry.activity ?? null,
        detail: entry.detail ?? null,
        details: entry.details ?? null,
        questions: entry.questions ?? null,
        refs:
          entry.refs === undefined || entry.refs.length === 0
            ? null
            : JSON.stringify(entry.refs),
        status: entry.status ?? null,
        agent_item_id: entry.agentItemId ?? null,
        revision,
        created_at: at,
        updated_at: at,
      })
      .execute();
    return id;
  }

  /** The queue's rows among `inputs` the AI got that aren't marked sent. */
  const handedOver = (trx: Db, chat: ChatRow, inputs: readonly string[]) =>
    trx
      .selectFrom("chat_queue")
      .select(["id", "origin", "text", "refs", "turn_id"])
      .where("person_id", "=", chat.personId)
      .where("chat_id", "=", chat.id)
      .where("id", "in", inputs.length === 0 ? [""] : inputs)
      .where("state", "in", ["waiting", "handing_over"])
      .orderBy("position")
      .execute();

  /**
   * A turn starts with these rows, in `trx`: its reply, the rows sent, the
   * person's message in the transcript by its row's id (once: one already
   * there stays where it is), and the turn's origin from them. Nothing when
   * the turn has its reply.
   */
  async function begin(
    trx: Transaction<Tables>,
    chat: ChatRow,
    revision: number,
    agentTurnId: string,
    thread: { id: string; model: string },
    inputs: readonly string[],
    /** The messages of Rufi AI's agents among the inputs. */
    messages: readonly AgentMessage[],
  ): Promise<{ entries: string[]; turns: string[] } | undefined> {
    if (await turnOf(trx, chat.id, agentTurnId)) return undefined;
    const rows = await handedOver(trx, chat, inputs);
    const id = uuid();
    await trx
      .insertInto("turns")
      .values({
        id,
        person_id: chat.personId,
        chat_id: chat.id,
        agent_turn_id: agentTurnId,
        thread_id: thread.id,
        model: thread.model,
        origin:
          rows.length > 0 && rows.every((row) => row.origin === "rufi")
            ? "rufi"
            : "person",
        status: "running",
        end_reason: null,
        end_text: null,
        resets_at: null,
        started_at: now(),
        ended_at: null,
      })
      .execute();
    // In the order the turn took them.
    const entries: string[] = [];
    for (const input of inputs) {
      const row = rows.find((one) => one.id === input);
      if (row) entries.push(...(await sent(trx, chat, revision, [row], id)));
      const message = messages.find((one) => one.input === input);
      const made =
        message && (await agentEntry(trx, chat, revision, message, id));
      if (made !== undefined) entries.push(made);
    }
    return { entries, turns: [id] };
  }

  /**
   * An agent's message enters the transcript, in `turnId`, by its input's
   * id: once (one already there stays where it is). One steered into the
   * running reply says so: it isn't what the reply opened with (anchorOf).
   */
  async function agentEntry(
    trx: Transaction<Tables>,
    chat: ChatRow,
    revision: number,
    message: AgentMessage,
    turnId: string | null,
    steered = false,
  ): Promise<string | undefined> {
    if (
      await trx
        .selectFrom("transcript_entries")
        .select("id")
        .where("id", "=", message.input)
        .executeTakeFirst()
    ) {
      return undefined;
    }
    const { input, said, ...sender } = message;
    return insertEntry(trx, chat, revision, {
      id: input,
      turnId,
      kind: "agent",
      text: said,
      details: JSON.stringify({ ...sender, ...(steered && { steered }) }),
    });
  }

  /** Marks handed-over rows sent; the person's message enters the transcript. */
  async function sent(
    trx: Transaction<Tables>,
    chat: ChatRow,
    revision: number,
    rows: { id: string; origin: string; text: string; refs: string }[],
    turnId: string | null,
    /** A steer went into a turn that ran already. */
    kind: "message" | "steer" = "message",
  ): Promise<string[]> {
    if (rows.length === 0) return [];
    await trx
      .updateTable("chat_queue")
      .set({ state: "sent", turn_id: turnId, updated_at: now() })
      .where(
        "id",
        "in",
        rows.map((row) => row.id),
      )
      .execute();
    const entries: string[] = [];
    for (const row of rows) {
      if (row.origin !== "person") continue;
      if (
        await trx
          .selectFrom("transcript_entries")
          .select("id")
          .where("id", "=", row.id)
          .executeTakeFirst()
      ) {
        continue;
      }
      entries.push(
        await insertEntry(trx, chat, revision, {
          id: row.id,
          turnId,
          kind,
          text: row.text,
          refs: JSON.parse(row.refs) as Chip[],
        }),
      );
    }
    return entries;
  }

  return {
    subscribe(chatId: string, listener: (change: Change) => void): () => void {
      const set = listeners.get(chatId) ?? new Set();
      set.add(listener);
      listeners.set(chatId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(chatId);
      };
    },

    people: () =>
      db
        .selectFrom("people")
        .select(["id", "display_name as displayName"])
        .orderBy("display_name")
        .execute(),

    /**
     * Adds the first person, as the welcome's "About you" does, and with
     * them their chat and their profile, its values saved as the welcome's
     * save, all in one transaction or none (SaveRefused, or the disk's
     * error); undefined when someone is already there. The person is added
     * only when there is none, so two tabs never make two people or two
     * chats.
     */
    addFirstPerson: (
      displayName: string,
      profile: (typeof AddPerson.Type)["profile"],
    ) =>
      db.transaction().execute(async (trx) => {
        const id = uuid();
        const { numAffectedRows } = await sql`
          INSERT INTO people (id, display_name)
          SELECT ${id}, ${displayName} WHERE NOT EXISTS (SELECT 1 FROM people)
        `.execute(trx);
        if (numAffectedRows !== 1n) return undefined;
        await trx
          .insertInto("profiles")
          .values({
            id,
            person_id: id,
            birth_date: null,
            birth_date_words: null,
            sex_for_ranges: null,
            blood_group: null,
            height: null,
            height_unit: null,
            removed: 0,
          })
          .execute();
        await trx
          .insertInto("chats")
          .values({
            id: uuid(),
            person_id: id,
            model: null,
            model_provider: null,
            effort: null,
            thread_id: null,
            thread_provider: null,
            thread_model: null,
            thread_tools: null,
            revision: 0,
            context_tokens: null,
            context_window: null,
            context_thread: null,
            created_at: now(),
          })
          .execute();
        await changeProfile(
          trx,
          { personId: id, form: "welcome", sending: uuid(), now: now() },
          profile,
        );
        return { id, displayName };
      }),

    person: (id: string) =>
      db
        .selectFrom("people")
        .select(["id", "display_name as displayName"])
        .where("id", "=", id)
        .executeTakeFirst(),

    /** The person's chat; undefined for no such person. */
    chat: async (personId: string) => {
      const row = await db
        .selectFrom("chats")
        .selectAll()
        .where("person_id", "=", personId)
        .executeTakeFirst();
      return row && toChat(row);
    },

    /** The chat an agent thread belongs to. */
    byThread: async (threadId: string) => {
      const row = await db
        .selectFrom("chats")
        .selectAll()
        .where("thread_id", "=", threadId)
        .executeTakeFirst();
      return row && toChat(row);
    },

    /**
     * The thread the chat now uses, and what it started with; the screens
     * hear of it, as the context used was the old thread's.
     */
    setThread: (
      chat: ChatRow,
      thread: { id: string; provider: string; model: string; tools: string },
    ) =>
      change(chat.id, async (trx) => {
        await trx
          .updateTable("chats")
          .set({
            thread_id: thread.id,
            thread_provider: thread.provider,
            thread_model: thread.model,
            thread_tools: thread.tools,
          })
          .where("id", "=", chat.id)
          .execute();
        return { entries: [], turns: [], chat: true };
      }),

    /**
     * How much of the model's context `threadId` used, as the agent last
     * reported it; a report of a thread the chat no longer uses changes
     * nothing.
     */
    setContext: (
      chat: ChatRow,
      threadId: string,
      used: { tokens: number; window: number | null },
    ) =>
      change(chat.id, async (trx) => {
        const { numUpdatedRows } = await trx
          .updateTable("chats")
          .set({
            context_tokens: used.tokens,
            context_window: used.window,
            context_thread: threadId,
          })
          .where("id", "=", chat.id)
          .where("thread_id", "=", threadId)
          .executeTakeFirst();
        return numUpdatedRows === 0n
          ? undefined
          : { entries: [], turns: [], chat: true };
      }),

    /** The chat's model, with the provider it runs on. */
    setModel: (chat: ChatRow, model: string, provider: string) =>
      change(chat.id, async (trx) => {
        await trx
          .updateTable("chats")
          .set({ model, model_provider: provider })
          .where("id", "=", chat.id)
          .execute();
        return { entries: [], turns: [], chat: true };
      }),

    setEffort: (chat: ChatRow, effort: Effort) =>
      change(chat.id, async (trx) => {
        await trx
          .updateTable("chats")
          .set({ effort })
          .where("id", "=", chat.id)
          .execute();
        return { entries: [], turns: [], chat: true };
      }),

    /**
     * A page of the transcript and the chat's revision, read in one go: the
     * latest rows, or those before `before` (a seq), widened down so that
     * each turn in it is whole. It holds every entry in its range, also one
     * of no turn (a message recovered after a crash), and the turns with no
     * entry that started in its time, so pages never skip or repeat
     * anything. Its `before` is where the next older page ends; null: it
     * starts the chat.
     */
    page: (chat: ChatRow, before?: number): Promise<Page> =>
      db.transaction().execute(async (trx) => {
        // As stored now: its model may have changed since it was read.
        const row = await trx
          .selectFrom("chats")
          .selectAll()
          .where("id", "=", chat.id)
          .executeTakeFirstOrThrow();
        const rows = () => {
          const all = trx
            .selectFrom("transcript_entries")
            .where("person_id", "=", chat.personId)
            .where("chat_id", "=", chat.id);
          return before === undefined ? all : all.where("seq", "<", before);
        };
        let low = (
          await rows()
            .select("seq")
            .orderBy("seq", "desc")
            .limit(PAGE_ROWS)
            .execute()
        ).at(-1)?.seq;
        // Down to the first entry of each turn in it, until none is cut.
        while (low !== undefined) {
          const from = low;
          const { first } = await trx
            .selectFrom("transcript_entries")
            .select((eb) => eb.fn.min<number | null>("seq").as("first"))
            .where("person_id", "=", chat.personId)
            .where(
              "turn_id",
              "in",
              rows()
                .select("turn_id")
                .where("seq", ">=", from)
                .where("turn_id", "is not", null),
            )
            .executeTakeFirstOrThrow();
          if (first === null || first >= low) break;
          low = first;
        }
        const entries =
          low === undefined
            ? []
            : await rows()
                .selectAll()
                .where("seq", ">=", low)
                .orderBy("seq")
                .execute();
        const older =
          low !== undefined &&
          (await rows()
            .select("seq")
            .where("seq", "<", low)
            .executeTakeFirst()) !== undefined;
        // A turn with no entry belongs to the page of its time: from this
        // page's first entry (or the start) to the newer page's first.
        const since = older ? entries[0]?.created_at : undefined;
        const until =
          before === undefined
            ? undefined
            : (
                await trx
                  .selectFrom("transcript_entries")
                  .select("created_at")
                  .where("chat_id", "=", chat.id)
                  .where("seq", ">=", before)
                  .orderBy("seq")
                  .executeTakeFirst()
              )?.created_at;
        let empty = trx
          .selectFrom("turns as t")
          .select("t.id")
          .where("t.person_id", "=", chat.personId)
          .where("t.chat_id", "=", chat.id)
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom("transcript_entries as e")
                  .select("e.id")
                  .whereRef("e.person_id", "=", "t.person_id")
                  .whereRef("e.turn_id", "=", "t.id"),
              ),
            ),
          );
        if (since !== undefined)
          empty = empty.where("t.started_at", ">=", since);
        if (until !== undefined)
          empty = empty.where("t.started_at", "<", until);
        const ids = [
          ...new Set(entries.flatMap((entry) => entry.turn_id ?? [])),
          ...(await empty.execute()).map((turn) => turn.id),
        ];
        const turns =
          ids.length === 0
            ? []
            : await trx
                .selectFrom("turns")
                .selectAll()
                .where("person_id", "=", chat.personId)
                .where("id", "in", ids)
                .orderBy("started_at")
                .orderBy("id")
                .execute();
        const kept = await stepsOf(trx, chat, turns);
        return {
          revision: row.revision,
          chat: shown(toChat(row)),
          entries: [
            ...(await entriesOut(trx, entries)),
            ...kept.entries,
          ].toSorted((a, b) => a.seq - b.seq),
          turns: (await turnsOut(trx, turns)).map((turn) =>
            kept.gone.has(turn.id)
              ? { ...turn, stepsGone: true as const }
              : turn,
          ),
          before: older ? (low ?? null) : null,
        };
      }),

    /** The agent system says where it keeps replies' steps. */
    readSteps: (source: Steps) => {
      steps = source;
    },

    /**
     * Steps of a reply as the agent reports them, shown on the screens and
     * stored only where the agent system keeps them; without `shown`, all
     * it kept of the reply, as they end with it. They move the chat's
     * revision on like any change.
     */
    show: (chat: ChatRow, agentTurnId: string, shown?: readonly Step[]) =>
      change(chat.id, async (trx) => {
        const turn = await turnOf(trx, chat.id, agentTurnId);
        if (!turn) return undefined;
        let entries: Entry[];
        if (shown === undefined) {
          entries = (await stepsOf(trx, chat, [turn])).entries;
        } else {
          const anchor = await anchorOf(trx, turn);
          entries = shown
            .filter(isStep)
            .map((step) => stepEntry(turn, step, anchor));
        }
        if (entries.length === 0) return undefined;
        return { entries: [], turns: [], shown: entries };
      }),

    /**
     * A reply the agent started, with the thread and model it runs on. Once
     * per agent turn. `inputs` are the queue's rows it took: in the same
     * transaction they are sent, the person's message enters the transcript
     * by its row's id, and the turn takes its origin from them.
     */
    startTurn: (
      chat: ChatRow,
      agentTurnId: string,
      thread: { id: string; model: string },
      inputs: readonly string[] = [],
      messages: readonly AgentMessage[] = [],
    ) =>
      change(chat.id, (trx, revision) =>
        begin(trx, chat, revision, agentTurnId, thread, inputs, messages),
      ),

    /** The chips of references, each checked to be the person's (RefRefusal). */
    chips: (personId: string, refs: readonly Pointer[]) =>
      chipsOf(db, personId, refs),

    /**
     * A Rufi event: its outcome (`write`, the producer's own), the line in
     * the chat and, when it asks the AI, its note in the queue, all in one
     * transaction.
     */
    addEvent: (
      chat: ChatRow,
      event: {
        kind: string;
        line: string;
        facts?: unknown;
        /** Rufi's note for the AI, when the AI should hear of it. */
        ask?: string;
        /** Its row's id in the queue, when the producer keeps it (a sort's request). */
        askId?: string;
      },
      /** Returns the entries it changed too, when it changes any. */
      write?: (
        trx: Transaction<Tables>,
        revision: number,
      ) => Promise<string[] | undefined>,
    ) =>
      change(chat.id, async (trx, revision) => {
        const changed = (await write?.(trx, revision)) ?? [];
        const id = await insertEntry(trx, chat, revision, {
          turnId: null,
          kind: "event",
          text: event.line,
          details: JSON.stringify({
            kind: event.kind,
            facts: event.facts ?? null,
          }),
        });
        if (event.ask !== undefined) {
          await addRow(
            trx,
            chat,
            {
              id: event.askId ?? uuid(),
              origin: "rufi",
              text: event.ask,
              eventId: id,
            },
            now(),
          );
        }
        return { entries: [...changed, id], turns: [] };
      }),

    /**
     * A reply ended: final from now on. Its unfinished activity and answers
     * are stopped, and its replies and reasoning are sent again by the ended
     * turn's state.
     */
    endTurn: (chat: ChatRow, agentTurnId: string, end: TurnEnding) =>
      change(chat.id, async (trx, revision) => {
        const turn = await turnOf(trx, chat.id, agentTurnId);
        if (turn?.status !== "running") return undefined;
        await trx
          .updateTable("turns")
          .set({
            status: end.status,
            end_reason: end.reason ?? null,
            end_text: end.text ?? null,
            resets_at: end.resetsAt ?? null,
            ended_at: now(),
          })
          .where("id", "=", turn.id)
          .execute();
        const stopped = await trx
          .updateTable("transcript_entries")
          .set({ status: "stopped", revision, updated_at: now() })
          .where("person_id", "=", turn.person_id)
          .where("turn_id", "=", turn.id)
          .where("status", "=", "running")
          .returning("id")
          .execute();
        const entries = await trx
          .selectFrom("transcript_entries")
          .select("id")
          .where("person_id", "=", turn.person_id)
          .where("turn_id", "=", turn.id)
          .where("kind", "in", ["reply", "reasoning"])
          .execute();
        return {
          entries: [...stopped, ...entries].map((row) => row.id),
          turns: [turn.id],
        };
      }),

    /**
     * A turn's start as the agent database keeps it (server/rufi-ai.ts),
     * with `write` in the same transaction: its reply, running, with the
     * rows it took sent, when the chat didn't save it. Its end follows the
     * same way; at a start, one that still runs once Rufi has read the
     * events is ended (interruptRunning).
     */
    applyStart: (
      chat: ChatRow,
      agentTurnId: string,
      thread: { id: string; model: string },
      inputs: readonly string[],
      messages: readonly AgentMessage[],
      write: (trx: Transaction<Tables>) => Promise<void>,
    ) =>
      change(chat.id, async (trx, revision) => {
        await write(trx);
        return begin(
          trx,
          chat,
          revision,
          agentTurnId,
          thread,
          inputs,
          messages,
        );
      }),

    /**
     * A message from one of Rufi AI's agents that the agent system steered
     * into Rufi AI's turn (server/rufi-ai.ts), with `write` in the same
     * transaction: it enters the transcript in that turn's reply.
     */
    applyAgentMessage: (
      chat: ChatRow,
      message: AgentMessage,
      agentTurn: string | null,
      write: (trx: Transaction<Tables>) => Promise<void>,
    ) =>
      change(chat.id, async (trx, revision) => {
        await write(trx);
        const turn =
          agentTurn === null
            ? undefined
            : await turnOf(trx, chat.id, agentTurn);
        const made = await agentEntry(
          trx,
          chat,
          revision,
          message,
          turn?.id ?? null,
          true,
        );
        return made === undefined ? undefined : { entries: [made], turns: [] };
      }),

    /**
     * What became of a row the agent system handed over, from its events
     * (server/rufi-ai.ts), with `write` in the same transaction. Delivered:
     * sent, in the reply of the agent's turn, if Rufi has it. Waiting: it
     * goes again. Held: it waits with the hold and its line.
     */
    applyInput: (
      chat: ChatRow,
      input: string,
      outcome:
        | { state: "delivered"; agentTurn: string | null }
        | { state: "waiting" }
        /** Its hold lifted: it goes. */
        | { state: "released" }
        | {
            state: "held";
            held: "signed_out" | "open_failed" | "failed" | "stopped";
            text: string;
          },
      write: (trx: Transaction<Tables>) => Promise<void>,
    ) =>
      change(chat.id, async (trx, revision) => {
        await write(trx);
        const [row] = await handedOver(trx, chat, [input]);
        if (!row) return undefined;
        const at = now();
        // A turn's own inputs are sent as it starts: one taken into a turn
        // the package names went into a turn that ran already, a steer. One
        // with no turn is a message.
        if (outcome.state === "delivered") {
          const turn =
            outcome.agentTurn === null
              ? undefined
              : await turnOf(trx, chat.id, outcome.agentTurn);
          const entries = await sent(
            trx,
            chat,
            revision,
            [row],
            turn?.id ?? null,
            outcome.agentTurn === null ? "message" : "steer",
          );
          return { entries, turns: [] };
        }
        if (outcome.state === "waiting") {
          await trx
            .updateTable("chat_queue")
            .set({ state: "waiting", sent_as: null, updated_at: at })
            .where("id", "=", input)
            .where("state", "=", "handing_over")
            .execute();
          return undefined;
        }
        if (outcome.state === "released") {
          await trx
            .updateTable("chat_queue")
            .set({ held: null, held_text: null, hold_id: null, updated_at: at })
            .where("id", "=", input)
            .where("state", "=", "waiting")
            .execute();
          return undefined;
        }
        await trx
          .updateTable("chat_queue")
          .set({
            state: "waiting",
            sent_as: null,
            held: outcome.held,
            held_text: outcome.text,
            hold_id: outcome.held === "open_failed" ? uuid() : null,
            updated_at: at,
          })
          .where("id", "=", input)
          .where("state", "in", ["waiting", "handing_over"])
          .execute();
        return undefined;
      }),

    /**
     * A turn's end as the agent database keeps it (server/rufi-ai.ts), with
     * `write` in the same transaction. The end goes on a reply still
     * running, or one Rufi closed before it saved it. A whole answer goes on
     * the reply row of the item it streamed as (or its own row when nothing
     * streamed), also after the chat saved the end itself, unless Rufi
     * ended the turn on its own (Stop, a failed save). The row's questions
     * stay as they are.
     */
    applyEnd: (
      chat: ChatRow,
      agentTurnId: string,
      end: TurnEnding,
      answer: { text: string; item?: string } | undefined,
      write: (trx: Transaction<Tables>) => Promise<void>,
    ) =>
      change(chat.id, async (trx, revision) => {
        await write(trx);
        const turn = await turnOf(trx, chat.id, agentTurnId);
        if (!turn) return undefined;
        const closed =
          turn.status === "interrupted" && turn.end_reason === null;
        const ends =
          turn.status === "running" || (answer !== undefined && closed);
        if (!ends && !(answer !== undefined && turn.status === "completed")) {
          return undefined;
        }
        const at = now();
        if (ends) {
          await trx
            .updateTable("turns")
            .set({
              status: end.status,
              end_reason: end.reason ?? null,
              end_text: end.text ?? null,
              resets_at: end.resetsAt ?? null,
              ended_at: at,
            })
            .where("id", "=", turn.id)
            .execute();
        }
        const entries: string[] = [];
        if (answer !== undefined) {
          const reply = await trx
            .selectFrom("transcript_entries")
            .select(["id", "text", "status"])
            .where("person_id", "=", turn.person_id)
            .where("turn_id", "=", turn.id)
            .where("kind", "=", "reply")
            .where((eb) =>
              answer.item === undefined
                ? eb("agent_item_id", "is", null)
                : eb("agent_item_id", "=", answer.item),
            )
            .executeTakeFirst();
          if (reply) {
            // Only its text: its questions are kept apart.
            if (reply.text !== answer.text || reply.status !== "done") {
              await trx
                .updateTable("transcript_entries")
                .set({
                  text: answer.text,
                  status: "done",
                  revision,
                  updated_at: at,
                })
                .where("id", "=", reply.id)
                .execute();
              entries.push(reply.id);
            }
          } else if (answer.text !== "") {
            entries.push(
              await insertEntry(trx, chat, revision, {
                turnId: turn.id,
                kind: "reply",
                text: answer.text,
                status: "done",
                ...(answer.item !== undefined && { agentItemId: answer.item }),
              }),
            );
          }
        }
        if (!ends) {
          return entries.length > 0 ? { entries, turns: [] } : undefined;
        }
        const stopped = await trx
          .updateTable("transcript_entries")
          .set({ status: "stopped", revision, updated_at: at })
          .where("person_id", "=", turn.person_id)
          .where("turn_id", "=", turn.id)
          .where("status", "=", "running")
          .returning("id")
          .execute();
        return {
          entries: [...entries, ...stopped.map((row) => row.id)],
          turns: [turn.id],
        };
      }),

    /**
     * A message of the user's, saved once by its id (the id the agent got).
     * Undefined when it is already saved.
     */
    addMessage: (
      chat: ChatRow,
      message: {
        id: string;
        kind: "message" | "steer";
        text: string;
        agentTurnId?: string;
        refs?: readonly Chip[];
      },
    ) =>
      change(chat.id, async (trx, revision) => {
        const saved = await trx
          .selectFrom("transcript_entries")
          .select("id")
          .where("id", "=", message.id)
          .executeTakeFirst();
        if (saved) return undefined;
        const turn =
          message.agentTurnId === undefined
            ? undefined
            : await turnOf(trx, chat.id, message.agentTurnId);
        const id = await insertEntry(trx, chat, revision, {
          id: message.id,
          turnId: turn?.id ?? null,
          kind: message.kind,
          text: message.text,
          ...(message.refs !== undefined && { refs: message.refs }),
        });
        return { entries: [id], turns: [] };
      }),

    /**
     * More of a reply's text; the reply is created by its first part. It
     * runs until `done`, when the agent gave it whole; one still running
     * when its turn ends was cut.
     */
    appendReply: (
      chat: ChatRow,
      agentTurnId: string,
      itemId: string,
      text: string,
      done = false,
    ) =>
      change(chat.id, async (trx, revision) => {
        const turn = await turnOf(trx, chat.id, agentTurnId);
        if (turn?.status !== "running" || (text === "" && !done)) {
          return undefined;
        }
        const reply = await itemOf(trx, turn, itemId, "reply");
        if (!reply) {
          if (text === "") return undefined;
          const id = await insertEntry(trx, chat, revision, {
            turnId: turn.id,
            kind: "reply",
            text,
            status: done ? "done" : "running",
            agentItemId: itemId,
          });
          return { entries: [id], turns: [] };
        }
        await trx
          .updateTable("transcript_entries")
          .set({
            text: sql<string>`text || ${text}`,
            ...(done && { status: "done" }),
            revision,
            updated_at: now(),
          })
          .where("id", "=", reply.id)
          .execute();
        return { entries: [reply.id], turns: [] };
      }),

    /**
     * A question the AI asks in its reply, kept apart from the answer's
     * text so the answer can be made whole without it.
     */
    addQuestion: (
      chat: ChatRow,
      agentTurnId: string,
      itemId: string,
      question: Question,
    ) =>
      change(chat.id, async (trx, revision) => {
        const turn = await turnOf(trx, chat.id, agentTurnId);
        if (turn?.status !== "running") return undefined;
        const reply = await itemOf(trx, turn, itemId, "reply");
        if (!reply) {
          const id = await insertEntry(trx, chat, revision, {
            turnId: turn.id,
            kind: "reply",
            text: "",
            status: "running",
            agentItemId: itemId,
            questions: JSON.stringify([question]),
          });
          return { entries: [id], turns: [] };
        }
        await trx
          .updateTable("transcript_entries")
          .set({
            questions: JSON.stringify([
              ...questionsOf(reply.questions),
              question,
            ]),
            revision,
            updated_at: now(),
          })
          .where("id", "=", reply.id)
          .execute();
        return { entries: [reply.id], turns: [] };
      }),

    /**
     * More of the AI's progress note, a step of its reply's Activity: the
     * line is made by its first part, running until `done`. Its text is
     * the note's words as they came.
     */
    appendNote: (
      chat: ChatRow,
      agentTurnId: string,
      itemId: string,
      text: string,
      done: boolean,
    ) =>
      change(chat.id, async (trx, revision) => {
        const turn = await turnOf(trx, chat.id, agentTurnId);
        if (turn?.status !== "running") return undefined;
        const note = await itemOf(trx, turn, itemId, "activity");
        const status = done ? "done" : "running";
        if (!note) {
          const id = await insertEntry(trx, chat, revision, {
            turnId: turn.id,
            kind: "activity",
            text,
            activity: "note",
            status,
            agentItemId: itemId,
          });
          return { entries: [id], turns: [] };
        }
        if (note.status !== "running" || (text === "" && !done)) {
          return undefined;
        }
        await trx
          .updateTable("transcript_entries")
          .set({
            text: sql<string>`text || ${text}`,
            status,
            revision,
            updated_at: now(),
          })
          .where("id", "=", note.id)
          .execute();
        return { entries: [note.id], turns: [] };
      }),

    /**
     * A save to the record (or a dismissal of draft items), its receipt and
     * the call with the answer the AI gets (`answer`), in one transaction
     * (docs/adr/0005): `save` writes it, given the references of the
     * user's messages in this turn and the turn's id (the turn its messages
     * belong to). The line is added also when the reply has ended
     * meanwhile (a Stop, a deadline): what is saved is shown. The same call
     * saved before adds no second line.
     */
    saveWithReceipt: async <T extends Receipted = Saved>(
      chat: ChatRow,
      call: ToolCall,
      save: (
        trx: Transaction<Tables>,
        at: string,
        refs: Ref[],
        turnId: string | undefined,
      ) => Promise<T>,
      answer: (saved: T) => Answered,
    ): Promise<T> => {
      let saved: T | undefined;
      await change(chat.id, async (trx, revision) => {
        const turn = await turnOf(trx, chat.id, call.ref);
        // What the user pointed at in this turn's messages.
        const messages =
          turn === undefined
            ? []
            : await trx
                .selectFrom("transcript_entries")
                .select("refs")
                .where("person_id", "=", chat.personId)
                .where("turn_id", "=", turn.id)
                .where("refs", "is not", null)
                .execute();
        saved = await save(
          trx,
          now(),
          messages.flatMap((m) =>
            (JSON.parse(m.refs ?? "[]") as Chip[]).map((chip) => chip.ref),
          ),
          turn?.id,
        );
        await keepCall(trx, chat, turn, call, answer(saved));
        if (!saved.fresh) return undefined;
        const id = await insertEntry(trx, chat, revision, {
          id: saved.id,
          turnId: turn?.id ?? null,
          kind: "receipt",
          text: labelled(saved.receipt, call.label),
        });
        return { entries: [id], turns: [] };
      });
      return saved as T;
    },

    /**
     * A visit brief, its line and the call with the answer the AI gets
     * (`answer`), in one transaction: `make` writes the brief in it. Like a
     * receipt, the line is added also when the reply has ended meanwhile,
     * and the same call made before adds no second line.
     */
    briefWithLine: async (
      chat: ChatRow,
      call: ToolCall,
      make: (
        trx: Transaction<Tables>,
        at: string,
        turnId: string | null,
      ) => Promise<Made>,
      answer: (made: Made) => Answered,
    ): Promise<Made> => {
      let made: Made | undefined;
      await change(chat.id, async (trx, revision) => {
        const turn = await turnOf(trx, chat.id, call.ref);
        made = await make(trx, now(), turn?.id ?? null);
        await keepCall(trx, chat, turn, call, answer(made));
        if (!made.fresh) return undefined;
        const id = await insertEntry(trx, chat, revision, {
          id: made.id,
          turnId: turn?.id ?? null,
          kind: "brief",
          text:
            call.label === undefined
              ? made.line
              : `${made.line} · ${call.label}`,
        });
        return { entries: [id], turns: [] };
      });
      return made as Made;
    },

    /**
     * One thing the agent did: added when it starts, updated when it ends.
     * `details`, everything the agent gave about it, replaces what it gave
     * before.
     */
    setActivity: (
      chat: ChatRow,
      agentTurnId: string,
      itemId: string,
      activity: {
        activity: ActivityKind;
        title: string;
        detail?: string;
        status: "running" | "done" | "failed";
        details?: unknown;
      },
    ) =>
      change(chat.id, async (trx, revision) => {
        const turn = await turnOf(trx, chat.id, agentTurnId);
        if (turn?.status !== "running") return undefined;
        const line = await itemOf(trx, turn, itemId, "activity");
        const details =
          activity.details === undefined
            ? undefined
            : JSON.stringify(activity.details);
        if (!line) {
          const id = await insertEntry(trx, chat, revision, {
            turnId: turn.id,
            kind: "activity",
            text: activity.title,
            activity: activity.activity,
            ...(activity.detail !== undefined && { detail: activity.detail }),
            status: activity.status,
            agentItemId: itemId,
            ...(details !== undefined && { details }),
          });
          return { entries: [id], turns: [] };
        }
        await trx
          .updateTable("transcript_entries")
          .set({
            text: activity.title,
            activity: activity.activity,
            detail: activity.detail ?? line.detail,
            details: details ?? line.details,
            status: activity.status,
            revision,
            updated_at: now(),
          })
          .where("id", "=", line.id)
          .execute();
        return { entries: [line.id], turns: [] };
      }),

    /**
     * The AI's reasoning for a step as it goes: the line is made when it
     * starts thinking, and its summary grows as it streams. Its time is from
     * then until it is whole.
     */
    appendReasoning: (
      chat: ChatRow,
      agentTurnId: string,
      itemId: string,
      text: string,
    ) =>
      change(chat.id, async (trx, revision) => {
        const turn = await turnOf(trx, chat.id, agentTurnId);
        if (turn?.status !== "running") return undefined;
        const line = await itemOf(trx, turn, itemId, "reasoning");
        if (!line) {
          const id = await insertEntry(trx, chat, revision, {
            turnId: turn.id,
            kind: "reasoning",
            text,
            agentItemId: itemId,
          });
          return { entries: [id], turns: [] };
        }
        if (text === "" || line.details !== null) return undefined;
        await trx
          .updateTable("transcript_entries")
          .set({
            text: sql<string>`text || ${text}`,
            revision,
            updated_at: now(),
          })
          .where("id", "=", line.id)
          .execute();
        return { entries: [line.id], turns: [] };
      }),

    /**
     * The AI's reasoning for a step, once it is whole: its summary, which
     * replaces what streamed, and everything the agent gave. Once per agent
     * item.
     */
    addReasoning: (
      chat: ChatRow,
      agentTurnId: string,
      itemId: string,
      reasoning: { summary: string; details: unknown },
    ) =>
      change(chat.id, async (trx, revision) => {
        const turn = await turnOf(trx, chat.id, agentTurnId);
        if (turn?.status !== "running") return undefined;
        const line = await itemOf(trx, turn, itemId, "reasoning");
        const details = JSON.stringify(reasoning.details);
        if (!line) {
          const id = await insertEntry(trx, chat, revision, {
            turnId: turn.id,
            kind: "reasoning",
            text: reasoning.summary,
            agentItemId: itemId,
            details,
          });
          return { entries: [id], turns: [] };
        }
        if (line.details !== null) return undefined;
        await trx
          .updateTable("transcript_entries")
          .set({
            text: reasoning.summary,
            details,
            revision,
            updated_at: now(),
          })
          .where("id", "=", line.id)
          .execute();
        return { entries: [line.id], turns: [] };
      }),

    /**
     * A call the AI made to one of Rufi's tools, with what it sent and
     * exactly what it got back, kept before the AI gets the answer. Also
     * after the reply ended (a save that finished after a Stop). Nothing
     * the screens show changes, so the chat's revision stays.
     */
    recordToolCall: (chat: ChatRow, call: ToolCall, answer: Answered) =>
      change(chat.id, async (trx) => {
        await keepCall(
          trx,
          chat,
          await turnOf(trx, chat.id, call.ref),
          call,
          answer,
        );
        return undefined;
      }),

    /**
     * A call that changes what Rufi keeps, with its trace, in one
     * transaction: `run` writes in it, and the call and the answer the AI
     * gets are kept with what it wrote. If the trace can't be kept, nothing
     * is.
     */
    withToolCall: async <T>(
      chat: ChatRow,
      call: ToolCall,
      run: (trx: Transaction<Tables>) => Promise<T>,
      answer: (result: T) => Answered,
    ): Promise<T> => {
      let result: T | undefined;
      await change(chat.id, async (trx) => {
        const turn = await turnOf(trx, chat.id, call.ref);
        const done = await run(trx);
        result = done;
        await keepCall(trx, chat, turn, call, answer(done));
        return undefined;
      });
      return result as T;
    },

    /** When it is now, as the transcript writes times. */
    now,

    /**
     * After a crash or a hard stop: replies still running were cut off. They
     * become interrupted, never replayed. Returns how many.
     */
    interruptRunning: async (): Promise<number> => {
      const running = await db
        .selectFrom("turns")
        .select(["id", "person_id", "chat_id", "agent_turn_id"])
        .where("status", "=", "running")
        .execute();
      for (const turn of running) {
        await change(turn.chat_id, async (trx, revision) => {
          await trx
            .updateTable("turns")
            .set({
              status: "interrupted",
              // Before the agent's turn, Rufi was reading the files.
              end_text:
                turn.agent_turn_id === null
                  ? `${CLOSED_WHILE_READING}.`
                  : "Rufi closed before the reply finished.",
              ended_at: now(),
            })
            .where("id", "=", turn.id)
            .execute();
          await trx
            .updateTable("transcript_entries")
            .set({ status: "stopped", revision, updated_at: now() })
            .where("person_id", "=", turn.person_id)
            .where("turn_id", "=", turn.id)
            .where("status", "=", "running")
            .execute();
          return { entries: [], turns: [turn.id] };
        });
      }
      return running.length;
    },

    /**
     * The last `count` messages (the user's, the AI's replies and progress
     * notes, Rufi's receipts, events and brief lines) from replies that
     * reached the AI and have ended, oldest first: what a new thread starts
     * with. A reply an older Rufi ended while it read the files never had
     * the AI. The user's message is there once it went, in a reply that has
     * ended (also when it went again after such a reply), or with no turn of
     * Rufi's, when a start confirmed it after a crash. A reply that
     * completed is as it came; one that didn't is marked unfinished, as are
     * its notes. Commands and thinking are left out.
     */
    lastMessages: async (chat: ChatRow, count: number) => {
      const rows = await db
        .selectFrom("transcript_entries as e")
        .leftJoin("turns as t", (join) =>
          join
            .onRef("t.person_id", "=", "e.person_id")
            .onRef("t.id", "=", "e.turn_id"),
        )
        // The message's row in the queue, and the reply it went in.
        .leftJoin("chat_queue as q", (join) =>
          join
            .onRef("q.person_id", "=", "e.person_id")
            .onRef("q.id", "=", "e.id"),
        )
        .leftJoin("turns as d", (join) =>
          join
            .onRef("d.person_id", "=", "q.person_id")
            .onRef("d.id", "=", "q.turn_id"),
        )
        .select([
          "e.kind",
          "e.text",
          "e.activity",
          "e.details",
          "e.questions",
          "e.status as entryStatus",
          "t.status",
        ])
        .where("e.person_id", "=", chat.personId)
        .where("e.chat_id", "=", chat.id)
        .where((eb) =>
          eb.or([
            eb("e.kind", "in", [
              "message",
              "steer",
              "reply",
              "receipt",
              "event",
              "brief",
              "agent",
            ]),
            eb.and([
              eb("e.kind", "=", "activity"),
              eb("e.activity", "=", "note"),
            ]),
          ]),
        )
        .where((eb) =>
          eb.or([
            // Sent: in a reply that has ended, or confirmed with no turn.
            eb.and([
              eb("e.kind", "=", "message"),
              eb("q.state", "=", "sent"),
              eb.or([eb("d.id", "is", null), eb("d.status", "!=", "running")]),
            ]),
            eb.and([
              eb("e.kind", "!=", "message"),
              eb.or([
                eb("t.id", "is", null),
                eb.and([
                  eb("t.status", "!=", "running"),
                  eb("t.agent_turn_id", "is not", null),
                ]),
              ]),
            ]),
          ]),
        )
        .orderBy("e.seq", "desc")
        .limit(count)
        .execute();
      return rows.reverse().map((row) => {
        const finished = whole(row.entryStatus, row.status);
        if (row.kind === "activity") {
          return {
            from: "note" as const,
            text: row.text,
            ...(!finished && { unfinished: true }),
          };
        }
        // Rufi's line names the agent, as when Rufi AI first got it.
        if (row.kind === "agent") {
          return {
            from: "agent" as const,
            text: agentLine(row.details, row.text),
          };
        }
        if (row.kind !== "reply") {
          return {
            from:
              row.kind === "receipt" ||
              row.kind === "event" ||
              row.kind === "brief"
                ? ("rufi" as const)
                : ("user" as const),
            text: row.text,
          };
        }
        return {
          from: "ai" as const,
          text: withQuestions(row.text, row.questions),
          ...(!finished && { unfinished: true }),
        };
      });
    },

    /**
     * Everything the agent gave about one activity line of the chat (plain
     * JSON, as it came); null when none was kept, undefined when the chat
     * has no such line.
     */
    details: async (chat: ChatRow, entryId: string) => {
      // A step the agent system keeps: `<reply>.<item, base64url>`.
      const dot = entryId.indexOf(".");
      if (dot !== -1) {
        const turn = await db
          .selectFrom("turns")
          .select("agent_turn_id")
          .where("person_id", "=", chat.personId)
          .where("chat_id", "=", chat.id)
          .where("id", "=", entryId.slice(0, dot))
          .executeTakeFirst();
        const agent = await rootOf(db, chat);
        if (!turn?.agent_turn_id || !steps || agent === undefined) {
          return undefined;
        }
        return steps.details(
          agent,
          turn.agent_turn_id,
          Buffer.from(entryId.slice(dot + 1), "base64url").toString(),
        );
      }
      const row = await db
        .selectFrom("transcript_entries")
        .select("details")
        .where("person_id", "=", chat.personId)
        .where("chat_id", "=", chat.id)
        .where("id", "=", entryId)
        .where("kind", "=", "activity")
        .executeTakeFirst();
      return row && { details: JSON.parse(row.details ?? "null") as unknown };
    },

    setting: async (key: string) =>
      (
        await db
          .selectFrom("settings")
          .select("value")
          .where("key", "=", key)
          .executeTakeFirst()
      )?.value,

    saveSetting: async (key: string, value: string | null) => {
      if (value === null) {
        await db.deleteFrom("settings").where("key", "=", key).execute();
        return;
      }
      await db
        .insertInto("settings")
        .values({ key, value })
        .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
        .execute();
    },
  };
}
