// Each chat's draft: the box's unsent text and its chips, kept by the core
// (docs/adr/0004). The last save wins. A chip is checked against the chat's
// person when it is saved, and named from what is stored when it is read.
// A send moves the text and chips into the queue and empties the draft in
// one transaction (core/chat/queue.ts), so nothing here sends a message.
import type { Draft, Pointer } from "@rufi/contracts";
import type { Store } from "../store/database.ts";
import { chipsOf } from "./refs.ts";

/** Whose draft: the person and their chat. */
interface ChatOf {
  personId: string;
  id: string;
}

export type Drafts = ReturnType<typeof drafts>;

export function drafts(
  store: Store,
  now: () => string = () => new Date().toISOString(),
) {
  const db = store.query;
  return {
    read: async ({ personId, id }: ChatOf): Promise<Draft> => {
      const row = await db
        .selectFrom("drafts")
        .select(["text", "refs"])
        .where("person_id", "=", personId)
        .where("chat_id", "=", id)
        .executeTakeFirst();
      return {
        text: row?.text ?? "",
        refs: await chipsOf(
          db,
          personId,
          JSON.parse(row?.refs ?? "[]") as Pointer[],
          true,
        ),
      };
    },

    /**
     * Saves the box's text and chips over the draft; a chip that isn't the
     * person's is refused (RefRefusal) and nothing is saved.
     */
    save: async (
      { personId, id }: ChatOf,
      text: string,
      refs: readonly Pointer[] = [],
    ): Promise<Draft> => {
      const chips = await chipsOf(db, personId, refs);
      const values = {
        text,
        // Pointers only: a chip's version and name are read when shown.
        refs: JSON.stringify(
          chips.map(({ ref }) =>
            ref.type === "record"
              ? { type: ref.type, kind: ref.kind, id: ref.id }
              : { type: ref.type, id: ref.id },
          ),
        ),
        updated_at: now(),
      };
      await db
        .insertInto("drafts")
        .values({ person_id: personId, chat_id: id, ...values })
        .onConflict((oc) =>
          oc.columns(["person_id", "chat_id"]).doUpdateSet(values),
        )
        .execute();
      return { text, refs: chips };
    },
  };
}
