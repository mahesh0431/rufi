// ask: Rufi AI asks the person with a question card (docs/adr/0036), in its
// own chat. It gives words only; Rufi draws the card as the question panel,
// in the chat box's place, and the answer comes later as the person's
// message, quoting the card.
import { Schema } from "effect";
import type { Asked } from "../chat/transcript.ts";
import { questionLink } from "../chat/questions.ts";
import { defineTool, Refusal } from "./registry.ts";

const Words = Schema.String.check(Schema.isMinLength(1));

export const AskInput = Schema.Struct({
  key: Words.annotate({
    description: "The card's title: a few words naming what it is about.",
  }),
  details: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "What the user decides on, as a short line or list in Markdown: the values themselves when they are few, each as printed in its source, or a short summary of a long list (what, how many, from where, when). Leave it out for a question that needs none.",
    }),
  ),
  question: Words.annotate({ description: "The question, in plain text." }),
  answers: Schema.Array(
    Schema.Struct({
      label: Words.annotate({
        description: "The answer, in a few words: what the user taps.",
      }),
      description: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "A short line under the label, only when the label alone doesn't say what choosing it means.",
        }),
      ),
      recommended: Schema.optionalKey(
        Schema.Boolean.annotate({
          description:
            "true only when you truly recommend this answer; leave it out otherwise.",
        }),
      ),
    }),
  )
    .check(Schema.isMinLength(1))
    .annotate({
      description:
        "Each answer the user can choose: the answers they would reasonably give, including a way to decline or wait. Their own answer covers anything else.",
    }),
});
export type AskInput = typeof AskInput.Type;

/** What ask answers: the card's id and the link the answer will quote. */
export const askedResult = (asked: Asked) => ({
  id: asked.id,
  link: questionLink(asked.id),
  ...(!asked.fresh && { note: "This call already asked this card." }),
});

export const ask = defineTool({
  name: "ask",
  description:
    "Asks the user a question, as a card in this chat: whenever you ask them to decide or answer something (a yes to changes you proposed, a choice between options, anything you need from them), ask with this; a question in passing inside an explanation stays in your text. The card has a key, details naming exactly what they decide on, the question and its answers, in plain words. Rufi shows it where the user types, in place of the chat box, until they answer: they tap an answer or write their own, which covers any answer you didn't offer, such as a date. It returns at once with the card's id and link; the user's answer comes later as their message, quoting the card by that link. A card is not the user's yes: judge their answer as any message. Put your analysis (text, visuals) in your reply before asking, keep the card small and text only, and ask last: don't repeat the question or ask again after it. Only you, in Rufi's own chat, ask the user; a sub-agent sends its question to its parent with send_agent. The same call again returns the same card.",
  input: AskInput,
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [
    {
      key: "Lipid panel, 12 Aug 2026",
      details: "- Total cholesterol 212 mg/dL\n- LDL 138 mg/dL\n- HDL 41 mg/dL",
      question: "Save these 3 results to your health record?",
      answers: [{ label: "Save" }, { label: "Not now" }],
    },
  ],
  run: async (input, { ask: write, callId }) => {
    if (!write || callId === undefined) {
      throw new Refusal(
        "Only Rufi AI asks the user, in Rufi's own chat. A sub-agent sends its question to its parent with send_agent.",
      );
    }
    return askedResult(await write(input, callId));
  },
});
