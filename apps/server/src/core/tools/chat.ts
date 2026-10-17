// read_chat: earlier parts of the chat the AI is in, for when
// a new thread started with only the last messages.
import { Schema } from "effect";
import { defineTool, Refusal } from "./registry.ts";

/** Entries in one page at most; the description says the same number. */
const PAGE_MAX = 50;

const Input = Schema.Struct({
  before: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).annotate({
      description:
        "Read entries before this position: the `next_before` of the previous page.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: PAGE_MAX }),
    ).annotate({
      description: `How many entries, 1 to ${String(PAGE_MAX)}; 20 when left out.`,
    }),
  ),
});

export const readChat = defineTool({
  name: "read_chat",
  description: `Earlier parts of this chat, newest first. Each entry's kind is "message" (the user's), "steer" (the user's, sent while you were replying), "reply" (yours), "activity" (one thing you did: a title and one short detail, never its output), "receipt" (Rufi's line for a save to the record: what was saved), "event" (Rufi's own line about something that happened, never the user's words) or "brief" (Rufi's line for a visit brief made with create_brief). "at" is when it was written. At most ${String(PAGE_MAX)} entries a page; pass the page's next_before to read further back. Rufi chooses the chat, not you.`,
  input: Input,
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [{}, { before: 41, limit: 20 }],
  run: async (input, { store, personId, chatId }) => {
    if (!store || personId === undefined || chatId === undefined) {
      throw new Refusal(
        "This isn't Rufi's chat, so it has nothing earlier to read.",
      );
    }
    const limit = input.limit ?? 20;
    let query = store.query
      .selectFrom("transcript_entries")
      .select([
        "seq",
        "kind",
        "text",
        "activity",
        "detail",
        "status",
        "created_at",
      ])
      .where("person_id", "=", personId)
      .where("chat_id", "=", chatId)
      // The AI's reasoning is kept for people to trace, not read back.
      .where("kind", "!=", "reasoning");
    if (input.before !== undefined)
      query = query.where("seq", "<", input.before);
    const rows = await query
      .orderBy("seq", "desc")
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((row) => ({
        position: row.seq,
        kind: row.kind,
        text: row.text,
        ...(row.detail !== null && { detail: row.detail }),
        ...(row.status !== null &&
          row.status !== "done" && { status: row.status }),
        at: row.created_at,
      })),
      ...(rows.length > limit && last && { next_before: last.seq }),
    };
  },
});
