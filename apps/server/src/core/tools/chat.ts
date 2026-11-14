// read_chat: earlier parts of the chat the AI is in, for when
// a new thread started with only the last messages, and a question card
// by its id, for an answer that quotes it.
import type { Chip, QuestionCard } from "@rufi/contracts";
import { Schema } from "effect";
import { cardForAi, quoted } from "../chat/questions.ts";
import { senderOf, withQuestions } from "../chat/transcript.ts";
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
  question: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "A question card's id, from its link rufi:/chat/questions/<id>: that card alone.",
    }),
  ),
});

/** An agent's message's agent, its name then and why it came. */
function agentOf(details: string | null) {
  const { agent, from } = senderOf(details);
  return agent === undefined || from === undefined
    ? {}
    : { agent, title: from.title, about: from.about };
}

export const readChat = defineTool({
  name: "read_chat",
  description: `Earlier parts of this chat, newest first. Each entry's kind is "message" (the user's), "steer" (the user's, sent while you were replying), "reply" (yours), "activity" (one thing you did: a title and one short detail, never its output), "receipt" (Rufi's line for a save to the record: what was saved), "event" (Rufi's own line about something that happened, never the user's words), "brief" (Rufi's line for a visit brief made with create_brief), "agent" (a message to you from an agent you started, in its own words, with its agent's id, its name then and why it came: done, asked, wrote, stopped, failed or signed_out (its start waits for a sign-in); never the user's words) or "question" (a question card you asked with ask, with its id and the answer a click chose, if one did). A user's message that answers a card starts with its quote, a link rufi:/chat/questions/<id>; pass that id as question to read the card alone. "at" is when it was written. At most ${String(PAGE_MAX)} entries a page; pass the page's next_before to read further back. Rufi chooses the chat, not you.`,
  input: Input,
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [
    {},
    { before: 41, limit: 20 },
    { question: "019a6c2e-5b1f-7c3d-8e4a-2f6b9d1c7e05" },
  ],
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
        "id",
        "seq",
        "kind",
        "text",
        "activity",
        "detail",
        "status",
        "details",
        "questions",
        "refs",
        "card",
        "answer",
        "created_at",
      ])
      .where("person_id", "=", personId)
      .where("chat_id", "=", chatId)
      // The AI's reasoning is kept for people to trace, not read back.
      .where("kind", "!=", "reasoning");
    if (input.question !== undefined) {
      query = query
        .where("id", "=", input.question)
        .where("kind", "=", "question");
    }
    if (input.before !== undefined)
      query = query.where("seq", "<", input.before);
    const rows = await query
      .orderBy("seq", "desc")
      .limit(limit + 1)
      .execute();
    if (input.question !== undefined && rows.length === 0) {
      throw new Refusal("This chat has no question card with that id.");
    }
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((row) => ({
        position: row.seq,
        kind: row.kind,
        ...(row.kind === "question" && { id: row.id }),
        text:
          row.card !== null
            ? cardForAi(
                row.id,
                JSON.parse(row.card) as QuestionCard,
                row.answer === null
                  ? undefined
                  : (JSON.parse(row.answer) as {
                      message: string;
                      index: number;
                    }),
              )
            : row.refs !== null
              ? quoted(row.text, JSON.parse(row.refs) as Chip[])
              : // A reply with the questions it asked, as the chat shows it.
                withQuestions(row.text, row.questions),
        ...(row.detail !== null && { detail: row.detail }),
        ...(row.status !== null &&
          row.status !== "done" && { status: row.status }),
        ...(row.kind === "agent" && agentOf(row.details)),
        at: row.created_at,
      })),
      ...(rows.length > limit && last && { next_before: last.seq }),
    };
  },
});
