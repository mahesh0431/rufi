// Each chat's queue, Rufi's own (docs/adr/0004): the person's messages and
// Rufi's events that ask the AI, waiting their turn. A send moves the box's
// text into a new row and empties the draft in one transaction; the row's id
// is the send's, so a retried send never makes a second row. Rufi claims a
// turn's rows here before it calls the AI, and never hands a row over
// twice: one Rufi stopped while handing it over is "not sure", shown and
// never sent again by itself. A paused chat (Stop, or Rufi started again
// with rows waiting) hands nothing over until the person sends; an event
// that comes meanwhile rides with their next message. A message whose AI
// thread didn't open waits with that hold until the person chooses Try
// again or New thread for it. A claimed row is marked just before the AI
// is called (`mark`): without the mark it surely never reached the AI.
// A message whose reply ended in Rufi's part (its files' reading stopped
// or failed, server/chat.ts) is in the chat already and waits with a hold
// of its own until the person presses its reply's Retry.
import type { Chip, Pointer, Queue, QueueItem } from "@rufi/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import { v7 as uuid } from "uuid";
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

/** Rows handed to the AI together, as one turn's input. */
export interface HandOver {
  /** The id the AI gets it under: the person's message's, or the first event's. */
  id: string;
  /** A person's message is in it: their turn; else a Rufi event turn. */
  origin: "person" | "rufi";
  /** Rufi's notes for the AI, oldest first. */
  notes: string[];
  /** The person's message, when there is one. */
  text: string | undefined;
  /** The person's message's references, as its chips. */
  refs: Chip[];
}

/** A hold that lets an event ride with the person's next message. */
const RIDES = ["paused", "signed_out"];

const CHANGED_ELSEWHERE =
  "The waiting messages changed meanwhile. Look again, then try again.";

/** A new waiting row at the end, in `trx`; held when the chat is paused. */
export async function addRow(
  trx: Transaction<Tables>,
  chat: ChatOf,
  row: {
    id: string;
    origin: "person" | "rufi";
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
  const paused = await pausedOf(trx, chat);
  await trx
    .insertInto("chat_queue")
    .values({
      id: row.id,
      person_id: chat.personId,
      chat_id: chat.id,
      origin: row.origin,
      text: row.text,
      refs: JSON.stringify(row.refs ?? []),
      event_id: row.eventId ?? null,
      position: (last ?? 0) + 1,
      state: "waiting",
      held: row.origin === "rufi" && paused !== null ? "paused" : null,
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
 * In the transaction that ends a reply in Rufi's part (server/chat.ts): its
 * message, in the chat already, waits held with `why` and a new hold for
 * its reply's Retry; events that rode with it wait to ride again.
 */
export async function endPart(
  trx: Transaction<Tables>,
  chat: ChatOf,
  why: string,
  at: string,
): Promise<void> {
  const ending = trx
    .updateTable("chat_queue")
    .where("person_id", "=", chat.personId)
    .where("chat_id", "=", chat.id)
    .where("state", "=", "handing_over");
  await ending
    .set({
      state: "waiting",
      sent_as: null,
      held: "reply_ended",
      held_text: why,
      hold_id: uuid(),
      updated_at: at,
    })
    .where("origin", "=", "person")
    .execute();
  await ending
    .set({ state: "waiting", sent_as: null, held: "paused", updated_at: at })
    .where("origin", "=", "rufi")
    .execute();
}

const pausedOf = async (trx: Db, chat: ChatOf) =>
  ((
    await trx
      .selectFrom("chats")
      .select("paused")
      .where("id", "=", chat.id)
      .executeTakeFirst()
  )?.paused ?? null) as Queue["paused"];

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

    /** What waits, in order, and why the chat is paused. */
    list: (chat: ChatOf): Promise<Queue> =>
      db.transaction().execute(async (trx) => {
        const found = await trx
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
            "q.turn_id",
            "e.text as line",
          ])
          .where("q.person_id", "=", chat.personId)
          .where("q.chat_id", "=", chat.id)
          .where("q.state", "in", ["waiting", "handing_over", "not_sure"])
          .orderBy("q.position")
          .execute();
        return {
          paused: await pausedOf(trx, chat),
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
            ...(row.held === "reply_ended" && { turnId: row.turn_id }),
          })),
        };
      }),

    /** Whether a send's id was used already: by a row here, or in a chat. */
    known: async (id: string) =>
      (await db
        .selectFrom("chat_queue")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst()) !== undefined ||
      (await db
        .selectFrom("transcript_entries")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst()) !== undefined,

    /**
     * Takes a message from the box: a new waiting row by the send's id, with
     * its references checked against the person, its unsent documents sent,
     * the draft emptied and the pause ended, in one transaction. The same id again finds the row it
     * made, or the message it sent into a running reply: `fresh` is false
     * then, and nothing changes.
     */
    accept: (
      chat: ChatOf,
      id: string,
      text: string,
      refs: readonly Pointer[] = [],
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
        await trx
          .updateTable("chats")
          .set({ paused: null })
          .where("id", "=", chat.id)
          .execute();
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
          { id, origin: "person", text, refs: chips },
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

    /** A waiting or not-sure row, removed: it never goes to the AI. */
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
          .where("state", "in", ["waiting", "not_sure"])
          .executeTakeFirst();
        if (numUpdatedRows !== 1n) {
          throw new QueueRefusal("That message isn't waiting any more.");
        }
      }),

    /** The waiting rows in a new order; `ids` must be all of them. */
    reorder: (chat: ChatOf, ids: readonly string[]) =>
      write(chat, async (trx) => {
        const waiting = await rows(trx, chat)
          .select("id")
          .where("state", "=", "waiting")
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
            .set({ position: index + 1, updated_at: now() })
            .where("id", "=", id)
            .execute();
        }
      }),

    /**
     * The person sends one row now: first in line, no longer held, and the
     * pause ends. A not-sure row goes again as a new row (its own id), and
     * the old one is removed, so one id is never handed over twice. A row
     * whose thread didn't open goes only by `recover`.
     */
    sendNow: (chat: ChatOf, id: string) =>
      write(chat, async (trx) => {
        const row = await rows(trx, chat)
          .selectAll()
          .where("id", "=", id)
          .where("state", "in", ["waiting", "not_sure"])
          .where("held", "is not", "open_failed")
          .executeTakeFirst();
        if (!row)
          throw new QueueRefusal("That message isn't waiting any more.");
        const at = now();
        const position = await front(trx, chat);
        await trx
          .updateTable("chats")
          .set({ paused: null })
          .where("id", "=", chat.id)
          .execute();
        if (row.state === "waiting") {
          await trx
            .updateTable("chat_queue")
            .set({ held: null, held_text: null, position, updated_at: at })
            .where("id", "=", id)
            .execute();
          return id;
        }
        await trx
          .updateTable("chat_queue")
          .set({ state: "removed", updated_at: at })
          .where("id", "=", id)
          .execute();
        const again = uuid();
        await trx
          .insertInto("chat_queue")
          .values({
            ...row,
            id: again,
            state: "waiting",
            held: null,
            held_text: null,
            hold_id: null,
            sent_as: null,
            turn_id: null,
            position,
            created_at: at,
            updated_at: at,
          })
          .execute();
        return again;
      }),

    /**
     * The person's choice for a message whose AI thread didn't open, for
     * the hold they saw: it goes first in line, and the pause ends; for a
     * new thread, the chat lets its thread go, in the same transaction.
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
        await trx
          .updateTable("chats")
          .set({
            paused: null,
            ...(newThread && {
              thread_id: null,
              thread_provider: null,
              thread_model: null,
              thread_tools: null,
            }),
          })
          .where("id", "=", chat.id)
          .execute();
      }),

    /**
     * Pauses the chat (Stop), stored before anything is stopped: nothing
     * more is handed over until the person sends.
     */
    pause: (chat: ChatOf) =>
      write(chat, async (trx) => {
        await trx
          .updateTable("chats")
          .set({ paused: "stopped" })
          .where("id", "=", chat.id)
          .execute();
        await trx
          .updateTable("chat_queue")
          .set({ held: "paused", updated_at: now() })
          .where("person_id", "=", chat.personId)
          .where("chat_id", "=", chat.id)
          .where("origin", "=", "rufi")
          .where("state", "=", "waiting")
          .where("held", "is", null)
          .execute();
      }),

    /**
     * Claims the next turn's rows, or none. A person's message goes with
     * every event held to ride with it; events next to each other at the
     * head go together. Paused or signed out: none, and events wait to
     * ride. The rows are handing over, not yet marked (`mark`).
     */
    claim: (chat: ChatOf, signedIn: boolean): Promise<HandOver | undefined> =>
      write(chat, async (trx) => {
        const at = now();
        const holdEvents = (held: string) =>
          trx
            .updateTable("chat_queue")
            .set({ held, updated_at: at })
            .where("person_id", "=", chat.personId)
            .where("chat_id", "=", chat.id)
            .where("origin", "=", "rufi")
            .where("state", "=", "waiting")
            .where("held", "is", null)
            .execute();
        const paused = await pausedOf(trx, chat);
        if (paused !== null) {
          await holdEvents("paused");
          return undefined;
        }
        if (
          (await rows(trx, chat)
            .select("id")
            .where("state", "=", "handing_over")
            .executeTakeFirst()) !== undefined
        ) {
          return undefined;
        }
        const waiting = await rows(trx, chat)
          .selectAll()
          .where("state", "=", "waiting")
          .orderBy("position")
          .execute();
        const free = waiting.filter((row) => row.held === null);
        const head = free[0];
        if (!head) return undefined;
        if (!signedIn) {
          await holdEvents("signed_out");
          return undefined;
        }
        let batch: typeof waiting;
        if (head.origin === "person") {
          const riding = waiting.filter(
            (row) => row.origin === "rufi" && RIDES.includes(row.held ?? ""),
          );
          batch = [...riding, head];
        } else {
          const stop = free.findIndex((row) => row.origin !== "rufi");
          batch = stop === -1 ? free : free.slice(0, stop);
        }
        const id = head.id;
        await trx
          .updateTable("chat_queue")
          .set({
            state: "handing_over",
            held: null,
            sent_as: null,
            updated_at: at,
          })
          .where(
            "id",
            "in",
            batch.map((row) => row.id),
          )
          .execute();
        return {
          id,
          origin: head.origin as HandOver["origin"],
          notes: batch
            .filter((row) => row.origin === "rufi")
            .map((row) => row.text),
          text: head.origin === "person" ? head.text : undefined,
          refs:
            head.origin === "person" ? (JSON.parse(head.refs) as Chip[]) : [],
        };
      }),

    /**
     * The claimed rows are about to go to the AI, under `id`: marked in
     * the database first, so a crash from now on leaves them not sure.
     */
    mark: (chat: ChatOf, id: string) =>
      write(chat, async (trx) => {
        await trx
          .updateTable("chat_queue")
          .set({ sent_as: id, updated_at: now() })
          .where("person_id", "=", chat.personId)
          .where("chat_id", "=", chat.id)
          .where("state", "=", "handing_over")
          .execute();
      }),

    /**
     * The person's Retry of a message whose reply ended in Rufi's part, for
     * the hold they saw: it goes first in line, and the pause ends (a Retry
     * is a send of theirs). An older hold changes nothing.
     */
    retry: (chat: ChatOf, id: string, hold: string) =>
      write(chat, async (trx) => {
        const row = await rows(trx, chat)
          .select("id")
          .where("id", "=", id)
          .where("state", "=", "waiting")
          .where("held", "=", "reply_ended")
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
            // Its next reply is a new one.
            turn_id: null,
            position,
            updated_at: now(),
          })
          .where("id", "=", id)
          .execute();
        await trx
          .updateTable("chats")
          .set({ paused: null })
          .where("id", "=", chat.id)
          .execute();
      }),

    /**
     * A hand-over the AI never got: its rows wait again. The person's row
     * is held with `why` (to send again or remove), unless it went back for
     * a Stop; events wait to ride with the next message. `notOpened`: the
     * AI's thread didn't open, and the hold is a new one of its kind. Only
     * before Rufi's part of its reply started (endPart after).
     */
    notTaken: (chat: ChatOf, why?: string, notOpened = false) =>
      write(chat, async (trx) => {
        const at = now();
        const back = rows(trx, chat)
          .select("id")
          .where("state", "=", "handing_over");
        const held =
          why === undefined ? null : notOpened ? "open_failed" : "failed";
        await trx
          .updateTable("chat_queue")
          .set({
            state: "waiting",
            sent_as: null,
            held,
            held_text: why ?? null,
            hold_id: held === "open_failed" ? uuid() : null,
            updated_at: at,
          })
          .where("id", "in", back.where("origin", "=", "person"))
          .execute();
        await trx
          .updateTable("chat_queue")
          .set({
            state: "waiting",
            sent_as: null,
            held: "paused",
            updated_at: at,
          })
          .where("id", "in", back.where("origin", "=", "rufi"))
          .execute();
      }),

    /**
     * A hand-over nobody knows the end of: its rows are not sure, and the
     * chat pauses, so nothing else starts beside a turn that may run.
     */
    unknown: (chat: ChatOf, id: string) =>
      write(chat, async (trx) => {
        const cut = await trx
          .updateTable("chat_queue")
          .set({ state: "not_sure", updated_at: now() })
          .where("person_id", "=", chat.personId)
          .where("sent_as", "=", id)
          .where("state", "=", "handing_over")
          .executeTakeFirst();
        // Its turn started meanwhile: nothing is unknown.
        if (cut.numUpdatedRows === 0n) return;
        await trx
          .updateTable("chats")
          .set({ paused: "stopped" })
          .where("id", "=", chat.id)
          .execute();
      }),

    /**
     * When Rufi starts: rows it stopped after their mark are not sure,
     * never sent again by itself. Rows it stopped before the mark surely
     * never reached the AI: a message whose reply had started waits held
     * with `why` for its reply's Retry; one whose thread was opening waits
     * again; events wait to ride. A chat with rows waiting is paused until
     * the person sends. Returns how many rows were cut off.
     */
    endStopped: (why: string): Promise<number> =>
      db.transaction().execute(async (trx) => {
        const at = now();
        const unmarked = trx
          .updateTable("chat_queue")
          .where("state", "=", "handing_over")
          .where("sent_as", "is", null);
        const ended = await unmarked
          .set({
            state: "waiting",
            held: "reply_ended",
            held_text: why,
            hold_id: sql<string>`lower(hex(randomblob(16)))`,
            updated_at: at,
          })
          .where("origin", "=", "person")
          .where("turn_id", "is not", null)
          .executeTakeFirst();
        await unmarked
          .set({ state: "waiting", held: null, updated_at: at })
          .where("origin", "=", "person")
          .where("turn_id", "is", null)
          .execute();
        await unmarked
          .set({ state: "waiting", held: "paused", updated_at: at })
          .where("origin", "=", "rufi")
          .execute();
        const cut = await trx
          .updateTable("chat_queue")
          .set({ state: "not_sure", updated_at: at })
          .where("state", "=", "handing_over")
          .executeTakeFirst();
        await trx
          .updateTable("chats")
          .set({ paused: "restarted" })
          .where("paused", "is", null)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom("chat_queue as q")
                .select("q.id")
                .whereRef("q.chat_id", "=", "chats.id")
                .where("q.state", "=", "waiting")
                .where("q.held", "is", null),
            ),
          )
          .execute();
        // Events wait to ride with the person's next message, as after a Stop.
        await trx
          .updateTable("chat_queue")
          .set({ held: "paused", updated_at: at })
          .where("origin", "=", "rufi")
          .where("state", "=", "waiting")
          .where("held", "is", null)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom("chats as c")
                .select("c.id")
                .whereRef("c.id", "=", "chat_queue.chat_id")
                .where("c.paused", "is not", null),
            ),
          )
          .execute();
        return Number(cut.numUpdatedRows) + Number(ended.numUpdatedRows);
      }),
  };
}
