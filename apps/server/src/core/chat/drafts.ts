// Each chat's draft: the box's unsent text, kept by the core, and the send
// that holds it (docs/adr/0004). The last save wins; only a send's hold
// refuses a save. A send keeps its text as the draft and holds it in one
// short commit before the agent is asked, so nothing changes it meanwhile
// and the text survives Rufi stopping. The hold ends when the agent took
// the message (the draft empties), refused it (the text is back to edit),
// or nobody knows (`unknown`: the text stays, and the person checks the
// chat). After a crash, Rufi ends each hold from the transcript when it
// starts. Nothing here sends a message again.
import type { Draft } from "@rufi/contracts";
import type { Kysely, Transaction } from "kysely";
import { v7 as uuid } from "uuid";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";

/** Whose draft: the person and their chat. */
interface ChatOf {
  personId: string;
  id: string;
}

/** How a send ended, with the draft after it. */
export type SendOutcome =
  | { outcome: "taken"; id: string; draft: Draft }
  /** Another send holds the draft: nothing was sent. */
  | { outcome: "held"; draft: Draft }
  | { outcome: "refused" | "unknown"; error: unknown; draft: Draft };

export type Drafts = ReturnType<typeof drafts>;

/** `refused`: the agent never had the message (the chat's own refusal). */
export function drafts(
  store: Store,
  refused: (error: unknown) => boolean,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;

  const row = (trx: Kysely<Tables>, { personId, id }: ChatOf) =>
    trx
      .selectFrom("drafts")
      .select(["text", "state", "attempt"])
      .where("person_id", "=", personId)
      .where("chat_id", "=", id)
      .executeTakeFirst();

  const toDraft = (
    found: { text: string; state: string } | undefined,
  ): Draft =>
    found
      ? { text: found.text, state: found.state as Draft["state"] }
      : { text: "", state: "editable" };

  const write = async (
    trx: Transaction<Tables>,
    { personId, id }: ChatOf,
    next: Draft & { attempt: string | null },
  ) => {
    const values = { ...next, updated_at: now() };
    await trx
      .insertInto("drafts")
      .values({ person_id: personId, chat_id: id, ...values })
      .onConflict((oc) =>
        oc.columns(["person_id", "chat_id"]).doUpdateSet(values),
      )
      .execute();
  };

  /**
   * Writes the draft as `next` unless a send holds it; undefined when it
   * wrote, else the draft as it is.
   */
  const unlessHeld = (chat: ChatOf, next: Draft & { attempt: string | null }) =>
    db.transaction().execute(async (trx) => {
      const current = toDraft(await row(trx, chat));
      if (current.state === "sending") return current;
      await write(trx, chat, next);
      return undefined;
    });

  /** Ends the hold of the send `attempt`, if it still holds the draft. */
  const end = (
    chat: ChatOf,
    attempt: string,
    outcome: "taken" | "refused" | "unknown",
  ): Promise<Draft> =>
    db.transaction().execute(async (trx) => {
      const current = await row(trx, chat);
      if (current?.attempt !== attempt) return toDraft(current);
      const draft: Draft = {
        text: outcome === "taken" ? "" : current.text,
        state: outcome === "unknown" ? "unknown" : "editable",
      };
      await write(trx, chat, { ...draft, attempt: null });
      return draft;
    });

  return {
    read: async (chat: ChatOf) => toDraft(await row(db, chat)),

    /** Saves the box's text; while a send holds the draft: the draft as it is. */
    save: async (chat: ChatOf, text: string): Promise<Draft> => {
      const draft: Draft = { text, state: "editable" };
      return (await unlessHeld(chat, { ...draft, attempt: null })) ?? draft;
    },

    /**
     * Sends `text` from the box: holds the draft with it, by the message's
     * id, then `deliver`s it by that id, and ends the hold as it went.
     */
    send: async (
      chat: ChatOf,
      text: string,
      deliver: (id: string) => Promise<unknown>,
    ): Promise<SendOutcome> => {
      const id = uuid();
      const held = await unlessHeld(chat, {
        text,
        state: "sending",
        attempt: id,
      });
      if (held) return { outcome: "held", draft: held };
      try {
        await deliver(id);
      } catch (error) {
        // A Stop or the agent's failure may come after the agent took it.
        const outcome = refused(error) ? "refused" : "unknown";
        return { outcome, error, draft: await end(chat, id, outcome) };
      }
      return { outcome: "taken", id, draft: await end(chat, id, "taken") };
    },

    /**
     * When Rufi starts: the sends that held a draft as Rufi stopped have
     * ended. One whose message is in the transcript was taken; otherwise
     * nobody knows, and the text stays. Never sent again. Returns how many.
     */
    endStopped: async (): Promise<number> => {
      const held = await db
        .selectFrom("drafts")
        .select(["person_id", "chat_id", "attempt"])
        .where("state", "=", "sending")
        .execute();
      for (const { person_id, chat_id, attempt } of held) {
        const taken = await db
          .selectFrom("transcript_entries")
          .select("id")
          .where("person_id", "=", person_id)
          .where("id", "=", attempt ?? "")
          .executeTakeFirst();
        await end(
          { personId: person_id, id: chat_id },
          attempt ?? "",
          taken ? "taken" : "unknown",
        );
      }
      return held.length;
    },
  };
}
