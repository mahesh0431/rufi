// Each person's chat and its transcript (docs/adr/0004): what the user
// said, one line per thing the AI did with everything it sent and got back,
// the AI's reasoning and its replies, in order, and each call to Rufi's
// tools. Every change is one transaction that moves the chat's revision
// on, and is published to listeners only after it is stored.
import type {
  ActivityKind,
  Chat,
  Draft,
  EndReason,
  Entry,
  Page,
  Turn,
} from "@rufi/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Saved } from "../record/save.ts";
import { splitBasis } from "./basis.ts";
import { usedOf } from "./used.ts";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";

/** A person's chat with the agent thread it points at. */
export interface ChatRow extends Chat {
  id: string;
  personId: string;
  threadId: string | null;
  threadProvider: string | null;
  threadModel: string | null;
  threadTools: string | null;
}

/** What one write changed, for the live stream. */
export interface Change {
  chatId: string;
  revision: number;
  entries: Entry[];
  turns: Turn[];
  /** The chat, when its model changed. */
  chat?: Chat;
}

export interface TurnEnding {
  status: "completed" | "interrupted" | "failed";
  reason?: EndReason;
  text?: string;
  resetsAt?: string;
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

/** An entry as the screens get it; a reply shows its answer (docs/adr/0007). */
const toEntry = (row: EntryRow, finished: boolean): Entry => ({
  id: row.id,
  seq: row.seq,
  turnId: row.turn_id,
  kind: row.kind as Entry["kind"],
  text: row.kind === "reply" ? splitBasis(row.text, finished).answer : row.text,
  activity: row.activity as Entry["activity"],
  detail: row.detail,
  status: row.status as Entry["status"],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** A chat as the screens get it, without its thread. */
const shown = ({ model }: Chat): Chat => ({ model });

const toChat = (row: Selectable<Tables["chats"]>): ChatRow => ({
  id: row.id,
  personId: row.person_id,
  model: row.model,
  threadId: row.thread_id,
  threadProvider: row.thread_provider,
  threadModel: row.thread_model,
  threadTools: row.thread_tools,
});

/**
 * Entries as the screens get them: the AI's reasoning stays in the
 * database, and a reply is split by whether its turn completed.
 */
async function entriesOut(trx: Db, rows: EntryRow[]): Promise<Entry[]> {
  const shown = rows.filter((row) => row.kind !== "reasoning");
  const replyTurns = [
    ...new Set(
      shown.flatMap((row) =>
        row.kind === "reply" && row.turn_id !== null ? [row.turn_id] : [],
      ),
    ),
  ];
  const completed = new Set(
    replyTurns.length === 0
      ? []
      : (
          await trx
            .selectFrom("turns")
            .select("id")
            .where("id", "in", replyTurns)
            .where("status", "=", "completed")
            .execute()
        ).map((turn) => turn.id),
  );
  return shown.map((row) =>
    toEntry(row, row.turn_id !== null && completed.has(row.turn_id)),
  );
}

/**
 * Turns as the screens get them, each with its Based on built from its own
 * entries and calls: How from its replies once it completed, and Used. A
 * turn on another agent thread than the turn before it started afresh;
 * the chat's first turn didn't.
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
  const entries = await trx
    .selectFrom("transcript_entries")
    .select([
      "turn_id",
      "kind",
      "text",
      "activity",
      "detail",
      "status",
      "agent_item_id",
      sql<number>`details IS NOT NULL`.as("captured"),
    ])
    .where("person_id", "=", first.person_id)
    .where("turn_id", "in", ids)
    .where("kind", "in", ["reply", "activity"])
    .orderBy("seq")
    .execute();
  const calls = await trx
    .selectFrom("tool_calls")
    .select([
      "turn_id",
      "call_id",
      "tool",
      "ok",
      "input",
      sql<number | null>`json_extract(answer, '$.result.returned')`.as(
        "returned",
      ),
      sql<number | null>`json_extract(answer, '$.result.complete')`.as(
        "complete",
      ),
      sql<string | null>`json_extract(answer, '$.error')`.as("error"),
    ])
    .where("person_id", "=", first.person_id)
    .where("turn_id", "in", ids)
    .orderBy("started_at")
    .orderBy("id")
    .execute();
  return rows.map((row) => {
    const own = entries.filter((entry) => entry.turn_id === row.id);
    const how =
      row.status === "completed"
        ? own
            .filter((entry) => entry.kind === "reply")
            .map((entry) => splitBasis(entry.text, true).how)
            .findLast((found) => found !== undefined)
        : undefined;
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
      afresh: threadBefore !== null && threadBefore !== row.thread_id,
      how: how ?? null,
      used: usedOf(
        own.filter((entry) => entry.kind === "activity"),
        calls.filter((call) => call.turn_id === row.id),
      ),
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
      { entries: string[]; turns: string[]; chat?: true } | undefined
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
        entries: await entriesOut(trx, entries),
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

  async function insertEntry(
    trx: Transaction<Tables>,
    chat: ChatRow,
    revision: number,
    entry: {
      id?: string;
      turnId: string | null;
      kind: Entry["kind"] | "reasoning";
      text: string;
      activity?: ActivityKind;
      detail?: string;
      status?: NonNullable<Entry["status"]>;
      agentItemId?: string;
      details?: string;
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
        status: entry.status ?? null,
        agent_item_id: entry.agentItemId ?? null,
        revision,
        created_at: at,
        updated_at: at,
      })
      .execute();
    return id;
  }

  const draftRow = (trx: Db, personId: string, chatId: string) =>
    trx
      .selectFrom("drafts")
      .select(["text", "revision", "state", "attempt"])
      .where("person_id", "=", personId)
      .where("chat_id", "=", chatId)
      .executeTakeFirst();

  const toDraft = (
    row: { text: string; revision: number; state: string } | undefined,
  ): Draft =>
    row
      ? {
          text: row.text,
          revision: row.revision,
          state: row.state as Draft["state"],
        }
      : { text: "", revision: 0, state: "editable" };

  /**
   * Changes a draft when it is at `revision`, moving its revision on.
   * Refused: undefined.
   */
  async function writeDraft(
    trx: Transaction<Tables>,
    personId: string,
    chatId: string,
    revision: number,
    next: { text: string; state: Draft["state"]; attempt: string | null },
  ): Promise<Draft | undefined> {
    const row = await draftRow(trx, personId, chatId);
    if (toDraft(row).revision !== revision) return undefined;
    const draft = {
      text: next.text,
      revision: revision + 1,
      state: next.state,
    };
    const values = { ...next, revision: draft.revision, updated_at: now() };
    if (row === undefined) {
      await trx
        .insertInto("drafts")
        .values({
          person_id: personId,
          chat_id: chatId,
          ...values,
        })
        .execute();
    } else {
      await trx
        .updateTable("drafts")
        .set(values)
        .where("person_id", "=", personId)
        .where("chat_id", "=", chatId)
        .execute();
    }
    return draft;
  }

  /** Ends the send that holds the draft (by its message id), if it still does. */
  async function endSend(
    trx: Transaction<Tables>,
    personId: string,
    chatId: string,
    attempt: string,
    outcome: "taken" | "refused" | "unknown",
  ): Promise<Draft> {
    const row = await draftRow(trx, personId, chatId);
    if (row?.attempt !== attempt) return toDraft(row);
    return (await writeDraft(trx, personId, chatId, row.revision, {
      text: outcome === "taken" ? "" : row.text,
      state: outcome === "unknown" ? "unknown" : "editable",
      attempt: null,
    })) as Draft;
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
     * Adds the first person, as first run does, and with them their chat, in
     * one transaction; undefined when someone is already there. The person
     * is added only when there is none, so two tabs never make two people or
     * two chats.
     */
    addFirstPerson: (displayName: string) =>
      db.transaction().execute(async (trx) => {
        const id = uuid();
        const { numAffectedRows } = await sql`
          INSERT INTO people (id, display_name)
          SELECT ${id}, ${displayName} WHERE NOT EXISTS (SELECT 1 FROM people)
        `.execute(trx);
        if (numAffectedRows !== 1n) return undefined;
        await trx
          .insertInto("chats")
          .values({
            id: uuid(),
            person_id: id,
            model: null,
            thread_id: null,
            thread_provider: null,
            thread_model: null,
            thread_tools: null,
            revision: 0,
            created_at: now(),
          })
          .execute();
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

    /** The thread the chat now uses, and what it started with. */
    setThread: async (
      chat: ChatRow,
      thread: { id: string; provider: string; model: string; tools: string },
    ) => {
      await db
        .updateTable("chats")
        .set({
          thread_id: thread.id,
          thread_provider: thread.provider,
          thread_model: thread.model,
          thread_tools: thread.tools,
        })
        .where("id", "=", chat.id)
        .execute();
    },

    setModel: (chat: ChatRow, model: string) =>
      change(chat.id, async (trx) => {
        await trx
          .updateTable("chats")
          .set({ model })
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
        return {
          revision: row.revision,
          chat: shown(toChat(row)),
          entries: await entriesOut(trx, entries),
          turns: await turnsOut(trx, turns),
          before: older ? (low ?? null) : null,
        };
      }),

    /**
     * A reply the agent started, with the thread and model it runs on. Once
     * per agent turn.
     */
    startTurn: (
      chat: ChatRow,
      agentTurnId: string,
      thread: { id: string; model: string },
    ) =>
      change(chat.id, async (trx) => {
        if (await turnOf(trx, chat.id, agentTurnId)) return undefined;
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
            status: "running",
            end_reason: null,
            end_text: null,
            resets_at: null,
            started_at: now(),
            ended_at: null,
          })
          .execute();
        return { entries: [], turns: [id] };
      }),

    /**
     * A reply ended: final from now on. Its unfinished activity is stopped,
     * and its replies are sent again, now split as an ended reply.
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
        const replies = await trx
          .selectFrom("transcript_entries")
          .select("id")
          .where("person_id", "=", turn.person_id)
          .where("turn_id", "=", turn.id)
          .where("kind", "=", "reply")
          .execute();
        return {
          entries: [...stopped, ...replies].map((row) => row.id),
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
        });
        return { entries: [id], turns: [] };
      }),

    /** More of a reply's text; the reply is created by its first part. */
    appendReply: (
      chat: ChatRow,
      agentTurnId: string,
      itemId: string,
      text: string,
    ) =>
      change(chat.id, async (trx, revision) => {
        const turn = await turnOf(trx, chat.id, agentTurnId);
        if (turn?.status !== "running" || text === "") return undefined;
        const reply = await itemOf(trx, turn, itemId, "reply");
        if (!reply) {
          const id = await insertEntry(trx, chat, revision, {
            turnId: turn.id,
            kind: "reply",
            text,
            agentItemId: itemId,
          });
          return { entries: [id], turns: [] };
        }
        await trx
          .updateTable("transcript_entries")
          .set({
            text: sql<string>`text || ${text}`,
            revision,
            updated_at: now(),
          })
          .where("id", "=", reply.id)
          .execute();
        return { entries: [reply.id], turns: [] };
      }),

    /**
     * A save to the record and its receipt, in one transaction
     * (docs/adr/0005): `save` writes the record in it. The line is added
     * also when the reply has ended meanwhile (a Stop, a deadline): what is
     * saved is shown. The same call saved before adds no second line.
     */
    saveWithReceipt: async (
      chat: ChatRow,
      agentTurnId: string,
      save: (trx: Transaction<Tables>, at: string) => Promise<Saved>,
    ): Promise<Saved> => {
      let saved: Saved | undefined;
      await change(chat.id, async (trx, revision) => {
        saved = await save(trx, now());
        if (!saved.fresh) return undefined;
        const turn = await turnOf(trx, chat.id, agentTurnId);
        const id = await insertEntry(trx, chat, revision, {
          id: saved.id,
          turnId: turn?.id ?? null,
          kind: "receipt",
          text: saved.receipt,
        });
        return { entries: [id], turns: [] };
      });
      return saved as Saved;
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
     * The AI's reasoning for a step, kept and never shown yet: its summary,
     * and everything the agent gave. Once per agent item.
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
        if (await itemOf(trx, turn, itemId, "reasoning")) return undefined;
        const id = await insertEntry(trx, chat, revision, {
          turnId: turn.id,
          kind: "reasoning",
          text: reasoning.summary,
          agentItemId: itemId,
          details: JSON.stringify(reasoning.details),
        });
        return { entries: [id], turns: [] };
      }),

    /**
     * A call the AI made to one of Rufi's tools, with what it sent and
     * exactly what it got back, kept before the AI gets the answer. Also
     * after the reply ended (a save that finished after a Stop). The turn
     * is sent again, with its Used.
     */
    recordToolCall: (
      chat: ChatRow,
      agentTurnId: string,
      call: {
        callId: string;
        tool: string;
        input: unknown;
        answer: { ok: boolean; text: string };
        startedAt: string;
      },
    ) =>
      change(chat.id, async (trx) => {
        const turn = await turnOf(trx, chat.id, agentTurnId);
        if (!turn) throw new Error("The call's reply isn't saved.");
        await trx
          .insertInto("tool_calls")
          .values({
            id: uuid(),
            person_id: turn.person_id,
            chat_id: chat.id,
            turn_id: turn.id,
            call_id: call.callId,
            tool: call.tool,
            input: JSON.stringify(call.input ?? null),
            answer: call.answer.text,
            ok: call.answer.ok ? 1 : 0,
            started_at: call.startedAt,
            ended_at: now(),
          })
          .execute();
        return { entries: [], turns: [turn.id] };
      }),

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
              end_text: "Rufi closed before the reply finished.",
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
     * The last `count` messages (the user's, the AI's replies and Rufi's
     * receipts) from replies that have ended, oldest first: what a new
     * thread starts with. A reply that completed is as it came, with its
     * rufi-basis block, so the new thread sees the convention; one that
     * didn't is its answer only, marked unfinished.
     */
    lastMessages: async (chat: ChatRow, count: number) => {
      const rows = await db
        .selectFrom("transcript_entries as e")
        .leftJoin("turns as t", (join) =>
          join
            .onRef("t.person_id", "=", "e.person_id")
            .onRef("t.id", "=", "e.turn_id"),
        )
        .select(["e.kind", "e.text", "t.status"])
        .where("e.person_id", "=", chat.personId)
        .where("e.chat_id", "=", chat.id)
        .where("e.kind", "in", ["message", "steer", "reply", "receipt"])
        .where((eb) =>
          eb.or([eb("t.status", "is", null), eb("t.status", "!=", "running")]),
        )
        .orderBy("e.seq", "desc")
        .limit(count)
        .execute();
      return rows.reverse().map((row) => {
        if (row.kind !== "reply") {
          return {
            from:
              row.kind === "receipt" ? ("rufi" as const) : ("user" as const),
            text: row.text,
          };
        }
        const finished = row.status === "completed";
        return {
          from: "ai" as const,
          text: finished ? row.text : splitBasis(row.text, false).answer,
          ...(!finished && { unfinished: true }),
        };
      });
    },

    /** Whether a message was saved, by the id the agent got. */
    hasMessage: async (id: string) =>
      (await db
        .selectFrom("transcript_entries")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst()) !== undefined,

    draft: async (personId: string, chatId: string) =>
      toDraft(await draftRow(db, personId, chatId)),

    /**
     * Saves the box's text when the draft is still at `revision` (the one
     * the box last saw) and no send holds it; otherwise it is refused, with
     * the draft as it is now.
     */
    saveDraft: (
      personId: string,
      chatId: string,
      text: string,
      revision: number,
    ): Promise<{ saved: boolean; draft: Draft }> =>
      db.transaction().execute(async (trx) => {
        const current = toDraft(await draftRow(trx, personId, chatId));
        const saved =
          current.state === "sending"
            ? undefined
            : await writeDraft(trx, personId, chatId, revision, {
                text,
                state: "editable",
                attempt: null,
              });
        return saved
          ? { saved: true, draft: saved }
          : { saved: false, draft: current };
      }),

    /**
     * A send holds the draft for its message (`attempt`, the id the agent
     * gets): only when the draft is at `revision`, holds `text` and no
     * other send holds it. Nothing can change the draft until the send ends.
     */
    holdForSend: (
      personId: string,
      chatId: string,
      text: string,
      revision: number,
      attempt: string,
    ): Promise<{ held: boolean; draft: Draft }> =>
      db.transaction().execute(async (trx) => {
        const current = toDraft(await draftRow(trx, personId, chatId));
        const held =
          current.state !== "sending" && current.text.trim() === text
            ? await writeDraft(trx, personId, chatId, revision, {
                text: current.text,
                state: "sending",
                attempt,
              })
            : undefined;
        return held
          ? { held: true, draft: held }
          : { held: false, draft: current };
      }),

    /**
     * The send that holds the draft ended: taken, the draft is emptied;
     * refused, its text is back to edit; unknown, the text stays and the
     * person is told to check the chat.
     */
    endSend: (
      personId: string,
      chatId: string,
      attempt: string,
      outcome: "taken" | "refused" | "unknown",
    ): Promise<Draft> =>
      db
        .transaction()
        .execute((trx) => endSend(trx, personId, chatId, attempt, outcome)),

    /**
     * When Rufi starts: sends that held a draft as Rufi stopped have ended.
     * One whose message is in the transcript was taken; otherwise nobody
     * knows, and the text stays. Never sent again. Returns how many.
     */
    endStoppedSends: async (): Promise<number> => {
      const held = await db
        .selectFrom("drafts")
        .select(["person_id", "chat_id", "attempt"])
        .where("state", "=", "sending")
        .execute();
      for (const row of held) {
        const attempt = row.attempt ?? "";
        const taken = await db
          .selectFrom("transcript_entries")
          .select("id")
          .where("person_id", "=", row.person_id)
          .where("id", "=", attempt)
          .executeTakeFirst();
        await db
          .transaction()
          .execute((trx) =>
            endSend(
              trx,
              row.person_id,
              row.chat_id,
              attempt,
              taken ? "taken" : "unknown",
            ),
          );
      }
      return held.length;
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
