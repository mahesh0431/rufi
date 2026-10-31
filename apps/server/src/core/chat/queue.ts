// Each chat's queue, Rufi's own (docs/adr/0004): the person's messages and
// Rufi's notes that ask the AI, waiting their turn. A send moves the box's
// text into a new row and empties the draft in one transaction; the row's id
// is the send's, so a retried send never makes a second row. A message sent
// while a reply runs goes into it (steer) or after it (queue), as the
// person chose. The agent system's queue hands each row over in order, by
// its id (server/chat.ts); as a row goes to the AI, Rufi claims it here:
// one transaction marks it handing over to that agent's conversation
// (`sent_as`) and gives back its words, so an edit that came first is what
// goes and one after is refused. A row Rufi didn't send shows why, and
// goes when the person sends it; one whose AI thread didn't open can go in
// a new thread too. A message with files goes like any other: Rufi's note
// on them goes with it (server/chat.ts).
import type { Chip, Pointer, Queue, QueueItem } from "@rufi/contracts";
import type { Kysely, Transaction } from "kysely";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";
import { chipsOf, RefRefusal } from "./refs.ts";

/** Whose queue: the person and their chat. */
interface ChatOf {
  personId: string;
  id: string;
}

type Db = Kysely<Tables> | Transaction<Tables>;

/** A change to the queue Rufi doesn't make, in words for the person. */
export class QueueRefusal extends Error {}

/** A row as it goes to the AI, as one turn's input. */
export interface HandOver {
  /** The id the AI gets it under: the row's. */
  id: string;
  /** The person's message: their turn; else Rufi's note, a Rufi event turn. */
  origin: "person" | "rufi";
  /** Rufi's notes for the AI: a Rufi event's. */
  notes: string[];
  /** The person's message, when it is one. */
  text: string | undefined;
  /** The person's message's references, as its chips. */
  refs: Chip[];
}

/** Rufi's answer when the agent system claims a row (Host.claim). */
export type Claimed =
  /** It was waiting: its words. */
  | { status: "claimed"; handOver: HandOver }
  /** It doesn't wait any more, or is held: it doesn't go. */
  | { status: "gone" };

/** A waiting row, in order, as the hand-over to the agent queue sees it. */
export interface Waiting {
  id: string;
  origin: "person" | "rufi";
  /** While a reply runs: into it, or after it. */
  kind: "steer" | "queue";
  held: string | null;
  refs: Chip[];
}

const handOverOf = (row: {
  id: string;
  origin: string;
  text: string;
  refs: string;
}): HandOver => ({
  id: row.id,
  origin: row.origin as HandOver["origin"],
  notes: row.origin === "rufi" ? [row.text] : [],
  text: row.origin === "person" ? row.text : undefined,
  refs: row.origin === "person" ? (JSON.parse(row.refs) as Chip[]) : [],
});

const CHANGED_ELSEWHERE =
  "The waiting messages changed meanwhile. Look again, then try again.";

/** A new waiting row at the end, in `trx`. */
export async function addRow(
  trx: Transaction<Tables>,
  chat: ChatOf,
  row: {
    id: string;
    origin: "person" | "rufi";
    kind?: "steer" | "queue";
    text: string;
    eventId?: string;
    refs?: readonly Chip[];
  },
  at: string,
): Promise<void> {
  const { last } = await trx
    .selectFrom("chat_queue")
    .select((eb) => eb.fn.max<number | null>("position").as("last"))
    .where("person_id", "=", chat.personId)
    .where("chat_id", "=", chat.id)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("chat_queue")
    .values({
      id: row.id,
      person_id: chat.personId,
      chat_id: chat.id,
      origin: row.origin,
      kind: row.kind ?? "queue",
      text: row.text,
      refs: JSON.stringify(row.refs ?? []),
      event_id: row.eventId ?? null,
      position: (last ?? 0) + 1,
      state: "waiting",
      held: null,
      held_text: null,
      hold_id: null,
      sent_as: null,
      turn_id: null,
      created_at: at,
      updated_at: at,
    })
    .execute();
}

/**
 * Sends the person's unsent documents among `ids`, in the transaction of
 * the message that sends them: from now on they are in the lists and the
 * AI's tools. A document sent before keeps its time.
 */
export async function sendDocuments(
  trx: Transaction<Tables>,
  personId: string,
  ids: readonly string[],
  at: string,
): Promise<void> {
  if (ids.length === 0) return;
  await trx
    .updateTable("documents")
    .set({ sent_at: at })
    .where("person_id", "=", personId)
    .where("id", "in", ids)
    .where("sent_at", "is", null)
    .execute();
}

export type ChatQueue = ReturnType<typeof chatQueue>;

export function chatQueue(
  store: Store,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;
  const listeners = new Map<string, Set<() => void>>();

  const changed = (chatId: string) => {
    for (const listener of listeners.get(chatId) ?? []) listener();
  };

  /** One write to a chat's queue; its listeners hear of it after the commit. */
  async function write<T>(
    chat: ChatOf,
    run: (trx: Transaction<Tables>) => Promise<T>,
  ): Promise<T> {
    const result = await db.transaction().execute(run);
    changed(chat.id);
    return result;
  }

  const rows = (trx: Db, chat: ChatOf) =>
    trx
      .selectFrom("chat_queue")
      .where("person_id", "=", chat.personId)
      .where("chat_id", "=", chat.id);

  /** A waiting row of the chat, or a refusal. */
  async function waitingRow(trx: Db, chat: ChatOf, id: string) {
    const row = await rows(trx, chat)
      .selectAll()
      .where("id", "=", id)
      .where("state", "=", "waiting")
      .executeTakeFirst();
    if (!row) throw new QueueRefusal("That message isn't waiting any more.");
    return row;
  }

  /** The position before every waiting row. */
  const front = async (trx: Db, chat: ChatOf) =>
    ((
      await rows(trx, chat)
        .select((eb) => eb.fn.min<number | null>("position").as("first"))
        .where("state", "=", "waiting")
        .executeTakeFirst()
    )?.first ?? 1) - 1;

  return {
    subscribe(chatId: string, listener: () => void): () => void {
      const set = listeners.get(chatId) ?? new Set();
      set.add(listener);
      listeners.set(chatId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(chatId);
      };
    },

    /** Tells the chat's listeners: a transcript write changed its queue. */
    changed,

    /** What waits, in order. */
    list: async (chat: ChatOf): Promise<Queue> => {
      const found = await db
        .selectFrom("chat_queue as q")
        .leftJoin("transcript_entries as e", (join) =>
          join
            .onRef("e.person_id", "=", "q.person_id")
            .onRef("e.id", "=", "q.event_id"),
        )
        .select([
          "q.id",
          "q.origin",
          "q.text",
          "q.state",
          "q.held",
          "q.held_text",
          "q.hold_id",
          "q.refs",
          "e.text as line",
        ])
        .where("q.person_id", "=", chat.personId)
        .where("q.chat_id", "=", chat.id)
        .where("q.state", "in", ["waiting", "handing_over"])
        .orderBy("q.position")
        .execute();
      return {
        items: found.map((row): QueueItem => ({
          id: row.id,
          origin: row.origin as QueueItem["origin"],
          // An event shows its line, the words written for the person.
          text: row.line ?? row.text,
          state: row.state as QueueItem["state"],
          held: row.held as QueueItem["held"],
          heldText: row.held_text,
          holdId: row.hold_id,
          refs: JSON.parse(row.refs) as Chip[],
        })),
      };
    },

    /** The waiting rows, in order, held or not. */
    waiting: async (chat: ChatOf): Promise<Waiting[]> =>
      (
        await rows(db, chat)
          .select(["id", "origin", "kind", "held", "refs"])
          .where("state", "=", "waiting")
          .orderBy("position")
          .execute()
      ).map((row) => ({
        id: row.id,
        origin: row.origin as Waiting["origin"],
        kind: row.kind as Waiting["kind"],
        held: row.held,
        refs: JSON.parse(row.refs) as Chip[],
      })),

    /** The words of these rows of the chat, by id, as they are now. */
    words: async (
      chat: ChatOf,
      ids: readonly string[],
    ): Promise<ReadonlyMap<string, string>> =>
      ids.length === 0
        ? new Map()
        : new Map(
            (
              await rows(db, chat)
                .select(["id", "text"])
                .where("id", "in", ids)
                .execute()
            ).map((row) => [row.id, row.text]),
          ),

    /**
     * Takes a message from the box: a new waiting row by the send's id, with
     * how it goes while a reply runs, its references checked against the
     * person, its unsent documents sent and the draft emptied, in one
     * transaction. The same id again finds the row it made, or the message
     * it sent into a running reply: `fresh` is false then, and nothing
     * changes.
     */
    accept: (
      chat: ChatOf,
      id: string,
      text: string,
      refs: readonly Pointer[] = [],
      kind: "steer" | "queue" = "steer",
    ) =>
      write(chat, async (trx) => {
        const there = await trx
          .selectFrom("chat_queue")
          .select(["chat_id"])
          .where("id", "=", id)
          .executeTakeFirst();
        if (there) {
          if (there.chat_id !== chat.id) {
            throw new QueueRefusal("That message id is already used.");
          }
          return { id, fresh: false };
        }
        // It becomes the message's id in the transcript too.
        const entry = await trx
          .selectFrom("transcript_entries")
          .select(["chat_id", "kind"])
          .where("id", "=", id)
          .executeTakeFirst();
        if (entry !== undefined) {
          if (entry.chat_id === chat.id && entry.kind === "steer") {
            return { id, fresh: false };
          }
          throw new QueueRefusal("That message id is already used.");
        }
        let chips: Chip[];
        try {
          chips = await chipsOf(trx, chat.personId, refs);
        } catch (error) {
          if (error instanceof RefRefusal) {
            throw new QueueRefusal(error.message, { cause: error });
          }
          throw error;
        }
        const at = now();
        // The files that waited unsent in the box go with it.
        await sendDocuments(
          trx,
          chat.personId,
          chips.flatMap((chip) =>
            chip.ref.type === "document" ? [chip.ref.id] : [],
          ),
          at,
        );
        await addRow(
          trx,
          chat,
          { id, origin: "person", kind, text, refs: chips },
          at,
        );
        await trx
          .insertInto("drafts")
          .values({
            person_id: chat.personId,
            chat_id: chat.id,
            text: "",
            refs: "[]",
            updated_at: at,
          })
          .onConflict((oc) =>
            oc
              .columns(["person_id", "chat_id"])
              .doUpdateSet({ text: "", refs: "[]", updated_at: at }),
          )
          .execute();
        return { id, fresh: true };
      }),

    /** A waiting message of the person's, edited. */
    edit: (chat: ChatOf, id: string, text: string) =>
      write(chat, async (trx) => {
        const row = await waitingRow(trx, chat, id);
        if (row.origin !== "person") {
          throw new QueueRefusal("Only your own messages can be edited.");
        }
        await trx
          .updateTable("chat_queue")
          .set({ text, updated_at: now() })
          .where("id", "=", id)
          .execute();
      }),

    /** A waiting row, removed: it never goes to the AI. */
    remove: (chat: ChatOf, id: string) =>
      write(chat, async (trx) => {
        const { numUpdatedRows } = await trx
          .updateTable("chat_queue")
          .set({
            state: "removed",
            held: null,
            hold_id: null,
            updated_at: now(),
          })
          .where("person_id", "=", chat.personId)
          .where("chat_id", "=", chat.id)
          .where("id", "=", id)
          .where("state", "=", "waiting")
          .executeTakeFirst();
        if (numUpdatedRows !== 1n) {
          throw new QueueRefusal("That message isn't waiting any more.");
        }
      }),

    /** The waiting rows in a new order; `ids` must be all of them. */
    reorder: (chat: ChatOf, ids: readonly string[]) =>
      write(chat, async (trx) => {
        const waiting = await rows(trx, chat)
          .select(["id", "position"])
          .where("state", "=", "waiting")
          .orderBy("position")
          .execute();
        const known = new Set(waiting.map((row) => row.id));
        if (
          ids.length !== known.size ||
          new Set(ids).size !== ids.length ||
          !ids.every((id) => known.has(id))
        ) {
          throw new QueueRefusal(CHANGED_ELSEWHERE);
        }
        for (const [index, id] of ids.entries()) {
          await trx
            .updateTable("chat_queue")
            .set({
              position: waiting[index]?.position ?? index + 1,
              updated_at: now(),
            })
            .where("id", "=", id)
            .execute();
        }
      }),

    /**
     * The person steers a waiting row: first in line, into the running
     * reply as soon as it can take it.
     */
    steer: (chat: ChatOf, id: string) =>
      write(chat, async (trx) => {
        const row = await waitingRow(trx, chat, id);
        if (row.held !== null) {
          throw new QueueRefusal("That message isn't waiting any more.");
        }
        await trx
          .updateTable("chat_queue")
          .set({
            kind: "steer",
            position: await front(trx, chat),
            updated_at: now(),
          })
          .where("id", "=", id)
          .execute();
      }),

    /**
     * The person sends a row Rufi didn't: first in line, no longer held. A
     * row whose thread didn't open goes by `recover`.
     */
    send: (chat: ChatOf, id: string) =>
      write(chat, async (trx) => {
        const row = await waitingRow(trx, chat, id);
        if (row.held === "open_failed") {
          throw new QueueRefusal(CHANGED_ELSEWHERE);
        }
        await trx
          .updateTable("chat_queue")
          .set({
            held: null,
            held_text: null,
            position: await front(trx, chat),
            updated_at: now(),
          })
          .where("id", "=", id)
          .execute();
      }),

    /**
     * The person's choice for a message whose AI thread didn't open, for
     * the hold they saw: it goes first in line; for a new thread, the chat
     * lets its thread go, in the same transaction.
     * An older hold, or a row no longer held so, changes nothing.
     */
    recover: (chat: ChatOf, id: string, hold: string, newThread: boolean) =>
      write(chat, async (trx) => {
        const row = await rows(trx, chat)
          .select("id")
          .where("id", "=", id)
          .where("state", "=", "waiting")
          .where("held", "=", "open_failed")
          .where("hold_id", "=", hold)
          .executeTakeFirst();
        if (!row) throw new QueueRefusal(CHANGED_ELSEWHERE);
        const position = await front(trx, chat);
        await trx
          .updateTable("chat_queue")
          .set({
            held: null,
            held_text: null,
            hold_id: null,
            position,
            updated_at: now(),
          })
          .where("id", "=", id)
          .execute();
        if (newThread) {
          await trx
            .updateTable("chats")
            .set({
              thread_id: null,
              thread_provider: null,
              thread_model: null,
              thread_tools: null,
            })
            .where("id", "=", chat.id)
            .execute();
        }
      }),

    /**
     * Rufi's claim of a row the agent system hands over to an agent's
     * conversation (`sentAs`), in one transaction: a waiting row is handing
     * over to it, and its words go. Any other is gone.
     */
    claim: (chat: ChatOf, id: string, sentAs: string): Promise<Claimed> =>
      write(chat, async (trx) => {
        const row = await rows(trx, chat)
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst();
        if (row?.state !== "waiting" || row.held !== null) {
          return { status: "gone" };
        }
        await trx
          .updateTable("chat_queue")
          .set({ state: "handing_over", sent_as: sentAs, updated_at: now() })
          .where("id", "=", id)
          .execute();
        return { status: "claimed", handOver: handOverOf(row) };
      }),

    /**
     * A waiting row the AI couldn't be given now waits held with `why`, to
     * send again or remove.
     */
    hold: (chat: ChatOf, id: string, why: string) =>
      write(chat, async (trx) => {
        await trx
          .updateTable("chat_queue")
          .set({ held: "failed", held_text: why, updated_at: now() })
          .where("person_id", "=", chat.personId)
          .where("chat_id", "=", chat.id)
          .where("id", "=", id)
          .where("state", "=", "waiting")
          .where("held", "is", null)
          .execute();
      }),

    /**
     * Rows held as signed out go again, now the sign-in is back; returns
     * their ids.
     */
    signedIn: (chat: ChatOf) =>
      write(chat, async (trx) =>
        (
          await trx
            .updateTable("chat_queue")
            .set({ held: null, held_text: null, updated_at: now() })
            .where("person_id", "=", chat.personId)
            .where("chat_id", "=", chat.id)
            .where("state", "=", "waiting")
            .where("held", "=", "signed_out")
            .returning("id")
            .execute()
        ).map((row) => row.id),
      ),
  };
}
