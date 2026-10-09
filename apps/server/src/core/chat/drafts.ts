// Each chat's draft: the box's unsent text, kept by the core
// (docs/adr/0004). The last save wins. A send moves the text into the queue
// and empties the draft in one transaction (core/chat/queue.ts), so nothing
// here sends a message.
import type { Draft } from "@rufi/contracts";
import type { Store } from "../store/database.ts";

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
    read: async ({ personId, id }: ChatOf): Promise<Draft> => ({
      text:
        (
          await db
            .selectFrom("drafts")
            .select("text")
            .where("person_id", "=", personId)
            .where("chat_id", "=", id)
            .executeTakeFirst()
        )?.text ?? "",
    }),

    /** Saves the box's text over the draft. */
    save: async ({ personId, id }: ChatOf, text: string): Promise<Draft> => {
      const values = { text, updated_at: now() };
      await db
        .insertInto("drafts")
        .values({ person_id: personId, chat_id: id, ...values })
        .onConflict((oc) =>
          oc.columns(["person_id", "chat_id"]).doUpdateSet(values),
        )
        .execute();
      return { text };
    },
  };
}
