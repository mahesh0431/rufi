// Rufi's conversations and their transcripts (docs/adr/0004): what the user
// said, one line per thing the AI did, and the AI's replies, in order. Every
// change is one transaction that moves the conversation's revision on, and is
// published to listeners only after it is stored.
import type {
  ActivityKind,
  Conversation,
  Draft,
  EndReason,
  Entry,
  Turn,
} from "@rufi/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";

/** A conversation with the agent thread it points at. */
export interface ConversationRow extends Conversation {
  personId: string;
  threadId: string | null;
  threadProvider: string | null;
  threadModel: string | null;
  threadTools: string | null;
}

/** What one write changed, for the live stream. */
export interface Change {
  conversationId: string;
  revision: number;
  entries: Entry[];
  turns: Turn[];
  /** The conversation, when its title or model changed. */
  conversation?: Conversation;
}

export interface Snapshot {
  revision: number;
  conversation: Conversation;
  entries: Entry[];
  turns: Turn[];
}

export interface TurnEnding {
  status: "completed" | "interrupted" | "failed";
  reason?: EndReason;
  text?: string;
  resetsAt?: string;
}

type Db = Kysely<Tables> | Transaction<Tables>;

/** The longest title Rufi makes from a message, in characters. */
const TITLE_MAX = 60;

/**
 * A conversation's title from its first message: the first words of its
 * first line, cut at a word to at most TITLE_MAX characters.
 */
export function titleFrom(message: string): string {
  const line = (message.trim().split("\n")[0] ?? "").replace(/\s+/g, " ");
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  // Cut at the last whole word; a word longer than the title is cut in it.
  const end = line[cut.length] === " " ? cut.length : cut.lastIndexOf(" ");
  return `${(end > 0 ? cut.slice(0, end) : cut).trimEnd()}…`;
}
type EntryRow = Selectable<Tables["transcript_entries"]>;
type TurnRow = Selectable<Tables["turns"]>;

const toEntry = (row: EntryRow): Entry => ({
  id: row.id,
  seq: row.seq,
  turnId: row.turn_id,
  kind: row.kind as Entry["kind"],
  text: row.text,
  activity: row.activity as Entry["activity"],
  detail: row.detail,
  status: row.status as Entry["status"],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toTurn = (row: TurnRow): Turn => ({
  id: row.id,
  model: row.model,
  status: row.status as Turn["status"],
  endReason: row.end_reason as Turn["endReason"],
  endText: row.end_text,
  resetsAt: row.resets_at,
  startedAt: row.started_at,
  endedAt: row.ended_at,
});

/** A conversation as the screens get it, without its thread. */
export const shown = ({
  id,
  title,
  provider,
  model,
  createdAt,
}: Conversation): Conversation => ({ id, title, provider, model, createdAt });

const toConversation = (
  row: Selectable<Tables["conversations"]>,
): ConversationRow => ({
  id: row.id,
  personId: row.person_id,
  title: row.title,
  provider: row.provider,
  model: row.model,
  createdAt: row.created_at,
  threadId: row.thread_id,
  threadProvider: row.thread_provider,
  threadModel: row.thread_model,
  threadTools: row.thread_tools,
});

export type Transcripts = ReturnType<typeof transcripts>;

export function transcripts(
  store: Store,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;
  const listeners = new Map<string, Set<(change: Change) => void>>();

  /**
   * One write to a conversation: `write` gets the new revision and returns
   * the ids of the entries and turns it changed. Listeners hear of it after
   * the commit; undefined when nothing changed.
   */
  async function change(
    conversationId: string,
    write: (
      trx: Transaction<Tables>,
      revision: number,
    ) => Promise<
      { entries: string[]; turns: string[]; conversation?: true } | undefined
    >,
  ): Promise<Change | undefined> {
    const changed = await db.transaction().execute(async (trx) => {
      const { revision } = await trx
        .updateTable("conversations")
        .set((eb) => ({ revision: eb("revision", "+", 1) }))
        .where("id", "=", conversationId)
        .returning("revision")
        .executeTakeFirstOrThrow();
      const ids = await write(trx, revision);
      if (!ids) {
        // Nothing to store: the revision goes back too.
        await trx
          .updateTable("conversations")
          .set({ revision: revision - 1 })
          .where("id", "=", conversationId)
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
      const conversation = ids.conversation
        ? await trx
            .selectFrom("conversations")
            .selectAll()
            .where("id", "=", conversationId)
            .executeTakeFirstOrThrow()
        : undefined;
      return {
        conversationId,
        revision,
        entries: entries.map(toEntry),
        turns: turns.map(toTurn),
        ...(conversation && {
          conversation: shown(toConversation(conversation)),
        }),
      };
    });
    if (changed) {
      for (const listener of listeners.get(conversationId) ?? []) {
        listener(changed);
      }
    }
    return changed;
  }

  const nextSeq = async (trx: Db, conversationId: string) =>
    ((
      await trx
        .selectFrom("transcript_entries")
        .select((eb) => eb.fn.max("seq").as("last"))
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst()
    )?.last ?? 0) + 1;

  const turnOf = (trx: Db, conversationId: string, agentTurnId: string) =>
    trx
      .selectFrom("turns")
      .selectAll()
      .where("conversation_id", "=", conversationId)
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
    conversation: ConversationRow,
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
    },
  ): Promise<string> {
    const id = entry.id ?? uuid();
    const at = now();
    await trx
      .insertInto("transcript_entries")
      .values({
        id,
        person_id: conversation.personId,
        conversation_id: conversation.id,
        seq: await nextSeq(trx, conversation.id),
        turn_id: entry.turnId,
        kind: entry.kind,
        text: entry.text,
        activity: entry.activity ?? null,
        detail: entry.detail ?? null,
        status: entry.status ?? null,
        agent_item_id: entry.agentItemId ?? null,
        revision,
        created_at: at,
        updated_at: at,
      })
      .execute();
    return id;
  }

  /** A draft as stored; revision 0 when there is none yet. */
  async function draftOf(
    trx: Db,
    personId: string,
    conversationId: string | null,
  ): Promise<Draft> {
    const row = await trx
      .selectFrom("drafts")
      .select(["text", "revision"])
      .where("person_id", "=", personId)
      .where((eb) =>
        conversationId === null
          ? eb("conversation_id", "is", null)
          : eb("conversation_id", "=", conversationId),
      )
      .executeTakeFirst();
    return row ?? { text: "", revision: 0 };
  }

  return {
    subscribe(
      conversationId: string,
      listener: (change: Change) => void,
    ): () => void {
      const set = listeners.get(conversationId) ?? new Set();
      set.add(listener);
      listeners.set(conversationId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(conversationId);
      };
    },

    people: () =>
      db
        .selectFrom("people")
        .select(["id", "display_name as displayName"])
        .orderBy("display_name")
        .execute(),

    addPerson: async (displayName: string) => {
      const person = { id: uuid(), display_name: displayName };
      await db.insertInto("people").values(person).execute();
      return { id: person.id, displayName };
    },

    person: (id: string) =>
      db
        .selectFrom("people")
        .select(["id", "display_name as displayName"])
        .where("id", "=", id)
        .executeTakeFirst(),

    conversations: async (personId: string): Promise<Conversation[]> =>
      (
        await db
          .selectFrom("conversations")
          .selectAll()
          .where("person_id", "=", personId)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .execute()
      ).map((row) => shown(toConversation(row))),

    /** One of the person's conversations; another person's is not found. */
    conversation: async (personId: string, id: string) => {
      const row = await db
        .selectFrom("conversations")
        .selectAll()
        .where("person_id", "=", personId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row && toConversation(row);
    },

    /** The conversation an agent thread belongs to. */
    byThread: async (threadId: string) => {
      const row = await db
        .selectFrom("conversations")
        .selectAll()
        .where("thread_id", "=", threadId)
        .executeTakeFirst();
      return row && toConversation(row);
    },

    createConversation: async (
      personId: string,
      title: string | null,
      provider: string,
      model: string,
    ): Promise<ConversationRow> => {
      const row = {
        id: uuid(),
        person_id: personId,
        title,
        provider,
        model,
        thread_id: null,
        thread_provider: null,
        thread_model: null,
        thread_tools: null,
        revision: 0,
        created_at: now(),
      };
      await db.insertInto("conversations").values(row).execute();
      return toConversation(row);
    },

    /** The thread the conversation now uses, and what it started with. */
    setThread: async (
      conversation: ConversationRow,
      thread: { id: string; provider: string; model: string; tools: string },
    ) => {
      await db
        .updateTable("conversations")
        .set({
          thread_id: thread.id,
          thread_provider: thread.provider,
          thread_model: thread.model,
          thread_tools: thread.tools,
        })
        .where("id", "=", conversation.id)
        .execute();
    },

    setModel: (conversation: ConversationRow, model: string) =>
      change(conversation.id, async (trx) => {
        await trx
          .updateTable("conversations")
          .set({ model })
          .where("id", "=", conversation.id)
          .execute();
        return { entries: [], turns: [], conversation: true };
      }),

    /** Titles a conversation that has no title yet; a title is never replaced. */
    setTitle: (conversation: ConversationRow, title: string) =>
      change(conversation.id, async (trx) => {
        const titled = await trx
          .updateTable("conversations")
          .set({ title })
          .where("id", "=", conversation.id)
          .where("title", "is", null)
          .returning("id")
          .executeTakeFirst();
        return titled && { entries: [], turns: [], conversation: true };
      }),

    /** The whole transcript and its revision, read in one go. */
    snapshot: (conversation: ConversationRow): Promise<Snapshot> =>
      db.transaction().execute(async (trx) => {
        // As stored now: its title or model may have changed since it was read.
        const row = await trx
          .selectFrom("conversations")
          .selectAll()
          .where("id", "=", conversation.id)
          .executeTakeFirstOrThrow();
        const entries = await trx
          .selectFrom("transcript_entries")
          .selectAll()
          .where("person_id", "=", conversation.personId)
          .where("conversation_id", "=", conversation.id)
          .orderBy("seq")
          .execute();
        const turns = await trx
          .selectFrom("turns")
          .selectAll()
          .where("person_id", "=", conversation.personId)
          .where("conversation_id", "=", conversation.id)
          .orderBy("started_at")
          .execute();
        return {
          revision: row.revision,
          conversation: shown(toConversation(row)),
          entries: entries.map(toEntry),
          turns: turns.map(toTurn),
        };
      }),

    /** A reply the agent started, with the model it runs on. Once per agent turn. */
    startTurn: (
      conversation: ConversationRow,
      agentTurnId: string,
      model: string,
    ) =>
      change(conversation.id, async (trx) => {
        if (await turnOf(trx, conversation.id, agentTurnId)) return undefined;
        const id = uuid();
        await trx
          .insertInto("turns")
          .values({
            id,
            person_id: conversation.personId,
            conversation_id: conversation.id,
            agent_turn_id: agentTurnId,
            model,
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

    /** A reply ended: final from now on. Its unfinished activity is stopped. */
    endTurn: (
      conversation: ConversationRow,
      agentTurnId: string,
      end: TurnEnding,
    ) =>
      change(conversation.id, async (trx, revision) => {
        const turn = await turnOf(trx, conversation.id, agentTurnId);
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
        return { entries: stopped.map((row) => row.id), turns: [turn.id] };
      }),

    /**
     * A message of the user's, saved once by its id (the id the agent got).
     * Undefined when it is already saved.
     */
    addMessage: (
      conversation: ConversationRow,
      message: {
        id: string;
        kind: "message" | "steer";
        text: string;
        agentTurnId?: string;
      },
    ) =>
      change(conversation.id, async (trx, revision) => {
        const saved = await trx
          .selectFrom("transcript_entries")
          .select("id")
          .where("id", "=", message.id)
          .executeTakeFirst();
        if (saved) return undefined;
        const turn =
          message.agentTurnId === undefined
            ? undefined
            : await turnOf(trx, conversation.id, message.agentTurnId);
        const id = await insertEntry(trx, conversation, revision, {
          id: message.id,
          turnId: turn?.id ?? null,
          kind: message.kind,
          text: message.text,
        });
        return { entries: [id], turns: [] };
      }),

    /** More of a reply's text; the reply is created by its first part. */
    appendReply: (
      conversation: ConversationRow,
      agentTurnId: string,
      itemId: string,
      text: string,
    ) =>
      change(conversation.id, async (trx, revision) => {
        const turn = await turnOf(trx, conversation.id, agentTurnId);
        if (turn?.status !== "running" || text === "") return undefined;
        const reply = await itemOf(trx, turn, itemId, "reply");
        if (!reply) {
          const id = await insertEntry(trx, conversation, revision, {
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

    /** One thing the agent did: added when it starts, updated when it ends. */
    setActivity: (
      conversation: ConversationRow,
      agentTurnId: string,
      itemId: string,
      activity: {
        activity: ActivityKind;
        title: string;
        detail?: string;
        status: "running" | "done" | "failed";
      },
    ) =>
      change(conversation.id, async (trx, revision) => {
        const turn = await turnOf(trx, conversation.id, agentTurnId);
        if (turn?.status !== "running") return undefined;
        const line = await itemOf(trx, turn, itemId, "activity");
        if (!line) {
          const id = await insertEntry(trx, conversation, revision, {
            turnId: turn.id,
            kind: "activity",
            text: activity.title,
            activity: activity.activity,
            ...(activity.detail !== undefined && { detail: activity.detail }),
            status: activity.status,
            agentItemId: itemId,
          });
          return { entries: [id], turns: [] };
        }
        await trx
          .updateTable("transcript_entries")
          .set({
            text: activity.title,
            activity: activity.activity,
            detail: activity.detail ?? line.detail,
            status: activity.status,
            revision,
            updated_at: now(),
          })
          .where("id", "=", line.id)
          .execute();
        return { entries: [line.id], turns: [] };
      }),

    /**
     * After a crash or a hard stop: replies still running were cut off. They
     * become interrupted, never replayed. Returns how many.
     */
    interruptRunning: async (): Promise<number> => {
      const running = await db
        .selectFrom("turns")
        .select(["id", "person_id", "conversation_id", "agent_turn_id"])
        .where("status", "=", "running")
        .execute();
      for (const turn of running) {
        await change(turn.conversation_id, async (trx, revision) => {
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
     * The last `count` messages (the user's and the AI's replies) from replies
     * that have ended, oldest first: what a new thread starts with.
     */
    lastMessages: async (conversation: ConversationRow, count: number) => {
      const rows = await db
        .selectFrom("transcript_entries as e")
        .leftJoin("turns as t", (join) =>
          join
            .onRef("t.person_id", "=", "e.person_id")
            .onRef("t.id", "=", "e.turn_id"),
        )
        .select(["e.kind", "e.text"])
        .where("e.person_id", "=", conversation.personId)
        .where("e.conversation_id", "=", conversation.id)
        .where("e.kind", "in", ["message", "steer", "reply"])
        .where((eb) =>
          eb.or([eb("t.status", "is", null), eb("t.status", "!=", "running")]),
        )
        .orderBy("e.seq", "desc")
        .limit(count)
        .execute();
      return rows.reverse().map((row) => ({
        from: row.kind === "reply" ? ("ai" as const) : ("user" as const),
        text: row.text,
      }));
    },

    /** Whether a message was saved, by the id the agent got. */
    hasMessage: async (id: string) =>
      (await db
        .selectFrom("transcript_entries")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst()) !== undefined,

    draft: (personId: string, conversationId: string | null) =>
      draftOf(db, personId, conversationId),

    /**
     * Keeps the draft when it is still at `revision` (the one the box last
     * saw), and moves its revision on; otherwise it is refused, with the
     * draft as it is now.
     */
    saveDraft: (
      personId: string,
      conversationId: string | null,
      text: string,
      revision: number,
    ): Promise<{ saved: boolean; draft: Draft }> =>
      db.transaction().execute(async (trx) => {
        const current = await draftOf(trx, personId, conversationId);
        if (current.revision !== revision)
          return { saved: false, draft: current };
        const next = { text, revision: revision + 1 };
        if (revision === 0) {
          await trx
            .insertInto("drafts")
            .values({
              person_id: personId,
              conversation_id: conversationId,
              ...next,
              updated_at: now(),
            })
            .execute();
        } else {
          await trx
            .updateTable("drafts")
            .set({ ...next, updated_at: now() })
            .where("person_id", "=", personId)
            .where((eb) =>
              conversationId === null
                ? eb("conversation_id", "is", null)
                : eb("conversation_id", "=", conversationId),
            )
            .execute();
        }
        return { saved: true, draft: next };
      }),

    /** The conversation the chat continues for the person; null: a new one. */
    chosen: async (personId: string) =>
      (
        await db
          .selectFrom("chosen_conversations")
          .select("conversation_id")
          .where("person_id", "=", personId)
          .executeTakeFirst()
      )?.conversation_id ?? null,

    /** Chooses the conversation the chat continues; null starts a new one. */
    choose: (personId: string, conversationId: string | null) =>
      db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("chosen_conversations")
          .where("person_id", "=", personId)
          .execute();
        if (conversationId === null) return;
        await trx
          .insertInto("chosen_conversations")
          .values({ person_id: personId, conversation_id: conversationId })
          .execute();
      }),

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
