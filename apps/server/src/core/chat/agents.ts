// What Rufi keeps of the agent system (docs/adr/0024): whose each agent is
// (`agent_owners`, a chat's own agent marked as its root), every provider
// conversation a chat's agents have had (`agent_conversations`, the
// ledger, kept even when the agent database is lost, so forget can find
// them), and how far Rufi has read the agent database's events
// (`agent_cursor`, by that database's generation). A hand-over Rufi claims
// for an agent names it in `sent_as` (sentAs).
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

/** A row handing over to an agent's conversation, as Rufi claimed it. */
export interface Claimed {
  id: string;
  agent: string;
  conversation: number;
}

/** What a provider said of a claimed row. */
export type Answer = "received" | "not_received" | "unknown";

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

const claimOf = (value: string) => {
  const at = value.lastIndexOf("/");
  const conversation = Number(value.slice(at + 1));
  return at > 0 && Number.isInteger(conversation) && conversation > 0
    ? { agent: value.slice(0, at), conversation }
    : undefined;
};

/** Threads from before the agent system are all Codex's. */
const OLD_PROVIDER = "codex";

export function chatAgents(
  store: Store,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;
  return {
    /**
     * Where Rufi's reading of this agent database starts. A database Rufi
     * hasn't read (the first, or one that replaced a lost one): in one
     * transaction, the links to the old one's agents end (never the
     * ledger), a claimed row still handing over is not sure, keeping
     * `sent_as`, and the reading starts at its beginning.
     */
    begin: (generation: string): Promise<number> =>
      db.transaction().execute(async (trx) => {
        const cursor = await trx
          .selectFrom("agent_cursor")
          .selectAll()
          .executeTakeFirst();
        if (cursor?.generation === generation) return cursor.number;
        await trx.deleteFrom("agent_owners").execute();
        // A row Rufi claimed but didn't mark surely never went: today's
        // recovery has it wait again (queue.ts, endStopped).
        await trx
          .updateTable("chat_queue")
          .set({ state: "not_sure", updated_at: now() })
          .where("state", "=", "handing_over")
          .where("sent_as", "is not", null)
          .execute();
        await trx
          .insertInto("agent_cursor")
          .values({ id: 1, generation, number: 0 })
          .onConflict((conflict) =>
            conflict.column("id").doUpdateSet({ generation, number: 0 }),
          )
          .execute();
        return 0;
      }),

    /** How far Rufi has read, and in which agent database; none yet. */
    cursor: () =>
      db
        .selectFrom("agent_cursor")
        .select(["generation", "number"])
        .executeTakeFirst(),

    /**
     * Rufi has read the events up to `number`, of this generation; in
     * `trx`, with what Rufi applied of them.
     */
    advance: async (
      generation: string,
      number: number,
      trx: Kysely<Tables> = db,
    ) => {
      const moved = await trx
        .updateTable("agent_cursor")
        .set({ number })
        .where("generation", "=", generation)
        .where("number", "<", number)
        .executeTakeFirst();
      if (moved.numUpdatedRows === 0n) {
        const cursor = await trx
          .selectFrom("agent_cursor")
          .select("generation")
          .executeTakeFirst();
        if (cursor?.generation !== generation) {
          throw new Error("Rufi is reading another agent database.");
        }
      }
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

    /**
     * Rows still handing over that Rufi claimed. One whose agent Rufi
     * doesn't own, or whose claim names none, can't be asked about.
     */
    claimed: async (): Promise<Claimed[]> => {
      const owned = new Set(
        (await db.selectFrom("agent_owners").select("agent_id").execute()).map(
          (row) => row.agent_id,
        ),
      );
      const rows = await db
        .selectFrom("chat_queue")
        .select(["id", "sent_as"])
        .where("state", "=", "handing_over")
        .where("sent_as", "is not", null)
        .execute();
      return rows.map((row) => {
        const claim = claimOf(row.sent_as ?? "");
        return claim && owned.has(claim.agent)
          ? { id: row.id, ...claim }
          : { id: row.id, agent: "", conversation: 0 };
      });
    },

    /**
     * Claimed rows the agent database doesn't hold, settled by what their
     * provider said, in one transaction. Not received: waiting again, in
     * its place. Unknown: not sure, keeping `sent_as`, never sent again by
     * itself. Received: not sure too, until a delivered message becomes
     * sent with its reply's history.
     */
    settle: (answers: ReadonlyMap<string, Answer>) =>
      db.transaction().execute(async (trx) => {
        const at = now();
        for (const [id, answer] of answers) {
          await trx
            .updateTable("chat_queue")
            .set(
              answer === "not_received"
                ? { state: "waiting", sent_as: null, updated_at: at }
                : { state: "not_sure", updated_at: at },
            )
            .where("id", "=", id)
            .where("state", "=", "handing_over")
            .execute();
        }
      }),
  };
}
