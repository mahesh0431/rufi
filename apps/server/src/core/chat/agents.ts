// What Rufi keeps of the agent system (docs/adr/0024): whose each agent is
// (`agent_owners`, a chat's own agent marked as its root), every provider
// conversation a chat's agents have had (`agent_conversations`, the
// ledger, kept even when the agent database is lost, so forget can find
// them), and how far Rufi has read the agent database's events
// (`agent_cursor`). A hand-over Rufi claims for an agent names it in
// `sent_as` (sentAs).
import type { Kysely } from "kysely";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";

/** Whose an agent is. */
export interface Owner {
  agent: string;
  personId: string;
  chatId: string;
  /** The chat's own agent, Rufi AI. */
  root: boolean;
}

/** A conversation as the ledger keeps it. */
export interface Ledgered {
  agent: string;
  conversation: number;
  provider: string;
  ref: string;
}

/** A chat with no agent of its own yet. */
export interface Unrooted {
  personId: string;
  chatId: string;
  /** The model and effort chosen for it; null: Rufi's defaults. */
  model: string | null;
  effort: string | null;
  /** Its thread, when no agent has had it: the new agent takes it over. */
  thread: { provider: string; ref: string; model: string | null } | undefined;
}

/** A row Rufi claimed for an agent's conversation, still handing over. */
export interface Claimed {
  id: string;
  personId: string;
  chatId: string;
}

/** How a claim names the agent and its conversation, in `sent_as`. */
export const sentAs = (agent: string, conversation: number) =>
  `${agent}/${String(conversation)}`;

/**
 * Rufi's id for an agent's call to its tools, for every provider:
 * `<agent>/<conversation>/<provider call id>`. A repeat has the same; two
 * agents, or two conversations of one, never do.
 */
export const callIdOf = (agent: string, conversation: number, call: string) =>
  `${sentAs(agent, conversation)}/${call}`;

/** Threads from before the agent system are all Codex's. */
const OLD_PROVIDER = "codex";

export function chatAgents(
  store: Store,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;
  return {
    /**
     * Where Rufi's reading of the agent database starts. A new one (the
     * first, or one that replaced a lost one): in one transaction, the
     * links to the old one's agents end (never the ledger), and the reading
     * starts at its beginning.
     */
    begin: (fresh: boolean): Promise<number> =>
      db.transaction().execute(async (trx) => {
        const cursor = await trx
          .selectFrom("agent_cursor")
          .select("number")
          .executeTakeFirst();
        if (cursor && !fresh) return cursor.number;
        await trx.deleteFrom("agent_owners").execute();
        await trx
          .insertInto("agent_cursor")
          .values({ id: 1, number: 0 })
          .onConflict((conflict) =>
            conflict.column("id").doUpdateSet({ number: 0 }),
          )
          .execute();
        return 0;
      }),

    /** Rufi has read the events up to `number`; in `trx`, with what it applied of them. */
    advance: async (number: number, trx: Kysely<Tables> = db) => {
      await trx
        .updateTable("agent_cursor")
        .set({ number })
        .where("number", "<", number)
        .execute();
    },

    owners: async (): Promise<Owner[]> =>
      (
        await db
          .selectFrom("agent_owners")
          .select(["agent_id", "person_id", "chat_id", "root"])
          .execute()
      ).map((row) => ({
        agent: row.agent_id,
        personId: row.person_id,
        chatId: row.chat_id,
        root: row.root === 1,
      })),

    /** Whose the agent is; nobody's when Rufi doesn't own it. */
    owner: async (agent: string): Promise<Owner | undefined> => {
      const row = await db
        .selectFrom("agent_owners")
        .select(["person_id", "chat_id", "root"])
        .where("agent_id", "=", agent)
        .executeTakeFirst();
      return (
        row && {
          agent,
          personId: row.person_id,
          chatId: row.chat_id,
          root: row.root === 1,
        }
      );
    },

    /** The chat's own agent, when it has one. */
    root: async (chatId: string) =>
      (
        await db
          .selectFrom("agent_owners")
          .select("agent_id")
          .where("chat_id", "=", chatId)
          .where("root", "=", 1)
          .executeTakeFirst()
      )?.agent_id,

    /** The agent is gone from the agent database: it has no owner. */
    drop: async (agent: string) => {
      await db
        .deleteFrom("agent_owners")
        .where("agent_id", "=", agent)
        .execute();
    },

    /** Chats with no agent of their own yet; only `chatId`, when given. */
    unrooted: async (chatId?: string): Promise<Unrooted[]> => {
      let chats = db
        .selectFrom("chats")
        .select([
          "id",
          "person_id",
          "model",
          "effort",
          "thread_id",
          "thread_provider",
          "thread_model",
        ])
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("agent_owners")
                .select("agent_id")
                .whereRef("agent_owners.chat_id", "=", "chats.id")
                .where("root", "=", 1),
            ),
          ),
        );
      if (chatId !== undefined) chats = chats.where("id", "=", chatId);
      const unrooted: Unrooted[] = [];
      for (const chat of await chats.execute()) {
        const provider = chat.thread_provider ?? OLD_PROVIDER;
        const had =
          chat.thread_id !== null &&
          (await db
            .selectFrom("agent_conversations")
            .select("agent_id")
            .where("provider", "=", provider)
            .where("ref", "=", chat.thread_id)
            .executeTakeFirst()) !== undefined;
        unrooted.push({
          personId: chat.person_id,
          chatId: chat.id,
          model: chat.model,
          effort: chat.effort,
          thread:
            chat.thread_id === null || had
              ? undefined
              : { provider, ref: chat.thread_id, model: chat.thread_model },
        });
      }
      return unrooted;
    },

    /**
     * The agent is the owner's, in one transaction with the conversation
     * it takes over, as its first, in the ledger.
     */
    own: (owner: Owner, adopted?: { provider: string; ref: string }) =>
      db.transaction().execute(async (trx) => {
        const at = now();
        await trx
          .insertInto("agent_owners")
          .values({
            agent_id: owner.agent,
            person_id: owner.personId,
            chat_id: owner.chatId,
            root: owner.root ? 1 : 0,
            created_at: at,
          })
          .execute();
        if (adopted) {
          await trx
            .insertInto("agent_conversations")
            .values({
              person_id: owner.personId,
              chat_id: owner.chatId,
              agent_id: owner.agent,
              conversation: 1,
              provider: adopted.provider,
              ref: adopted.ref,
              created_at: at,
            })
            .execute();
        }
      }),

    /**
     * A new conversation of an owned agent, in the ledger under its chat,
     * before any of Rufi's content goes into it.
     */
    ledger: (entry: Ledgered) =>
      db.transaction().execute(async (trx) => {
        const owner = await trx
          .selectFrom("agent_owners")
          .select(["person_id", "chat_id"])
          .where("agent_id", "=", entry.agent)
          .executeTakeFirst();
        if (!owner) throw new Error(`Agent ${entry.agent} has no owner.`);
        await trx
          .insertInto("agent_conversations")
          .values({
            person_id: owner.person_id,
            chat_id: owner.chat_id,
            agent_id: entry.agent,
            conversation: entry.conversation,
            provider: entry.provider,
            ref: entry.ref,
            created_at: now(),
          })
          .execute();
      }),

    /** Rows Rufi claimed for an agent's conversation, still handing over. */
    claimed: async (): Promise<Claimed[]> =>
      (
        await db
          .selectFrom("chat_queue")
          .select(["id", "person_id", "chat_id"])
          .where("state", "=", "handing_over")
          .where("sent_as", "is not", null)
          .orderBy("position")
          .execute()
      ).map((row) => ({
        id: row.id,
        personId: row.person_id,
        chatId: row.chat_id,
      })),
  };
}
