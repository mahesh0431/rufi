// The conversation the chat shows, per person. Each tab owns its own: only
// the person changes it here (choosing one, or starting a new one), never a
// read, a late answer or a save that failed. The core keeps the last choice
// a tab saved, only to open the chat on the next time Rufi opens; this tab's
// saves of it go one after another (one mutation scope per person), so the
// core keeps this tab's last one.
import { Conversation, type Conversations } from "@rufi/contracts";
import { Schema } from "effect";
import { useEffect } from "react";
import { create } from "zustand/react";
import { read, request } from "./api.ts";
import { inTurn } from "./draft.ts";
import { conversationsKey, queries, useConversations } from "./reads.ts";

/** By person; absent until the core's choice is read. */
const useChoices = create<Record<string, string | null>>(() => ({}));
/** By person: a new conversation is being made; nothing can be sent. */
const useStarting = create<Record<string, boolean>>(() => ({}));
/** By person: how many times the person chose here. */
const made = new Map<string, number>();

const peoplePath = (personId: string) =>
  `/api/people/${encodeURIComponent(personId)}`;

/**
 * The conversation the chat shows (null: none yet); undefined until read.
 * The core's choice is taken once, from the first read of the list.
 */
export function useChosen(personId: string): string | null | undefined {
  const local = useChoices((choices) => choices[personId]);
  const saved = useConversations(personId).data?.chosen;
  useEffect(() => {
    if (saved === undefined) return;
    if (useChoices.getState()[personId] === undefined) {
      useChoices.setState({ [personId]: saved });
    }
  }, [personId, saved]);
  return local === undefined ? saved : local;
}

/** Whether a new conversation is being made for the person. */
export const useStartingConversation = (personId: string) =>
  useStarting((starting) => starting[personId] === true);

export const startingConversation = (personId: string) =>
  useStarting.getState()[personId] === true;

/** One more of the person's choices; returns its number. */
const next = (personId: string) => {
  const n = (made.get(personId) ?? 0) + 1;
  made.set(personId, n);
  return n;
};

/**
 * The person chose the conversation the chat shows. Also when it already
 * shows it: a New still being made then doesn't take the chat.
 */
export function choose(personId: string, conversationId: string): void {
  useStarting.setState({ [personId]: false });
  next(personId);
  if (useChoices.getState()[personId] === conversationId) return;
  useChoices.setState({ [personId]: conversationId });
  void inTurn(queries, `chosen/${personId}`, () =>
    request("PUT", `${peoplePath(personId)}/chosen`, { conversationId }),
  )
    // Only the next opening of Rufi needed it: the chat stays where it is,
    // and the page already says when Rufi can't be reached.
    .catch(() => undefined);
}

const Created = Schema.Struct({ conversation: Conversation });

/**
 * Starts a new conversation (the core creates it at once) and shows it,
 * unless the person chose another one, or New again, while it was being
 * made: then it is only listed, and undefined. Until then nothing can be
 * sent from the chat, so nothing goes into the conversation before.
 */
export async function startConversation(
  personId: string,
): Promise<Conversation | undefined> {
  const mine = next(personId);
  useStarting.setState({ [personId]: true });
  const current = () => made.get(personId) === mine;
  let conversation: Conversation;
  try {
    ({ conversation } = await read(
      Created,
      "POST",
      `${peoplePath(personId)}/conversations`,
      {},
    ));
  } catch (error) {
    if (current()) useStarting.setState({ [personId]: false });
    throw error;
  }
  // An older read of the list must not drop it.
  await queries.cancelQueries({ queryKey: conversationsKey(personId) });
  queries.setQueryData<typeof Conversations.Type>(
    conversationsKey(personId),
    (list) =>
      list && {
        ...list,
        conversations: [conversation, ...list.conversations],
      },
  );
  if (!current()) return undefined;
  choose(personId, conversation.id);
  return conversation;
}
