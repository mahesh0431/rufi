// The chat the chat shows, per person. Each tab owns its own: only
// the person changes it here (choosing one, or starting a new one), never a
// read, a late answer or a save that failed. The core keeps the last choice
// a tab saved, only to open the chat on the next time Rufi opens; this tab's
// saves of it go one after another (one mutation scope per person), so the
// core keeps this tab's last one.
import { Chat, type Chats } from "@rufi/contracts";
import { Schema } from "effect";
import { useEffect } from "react";
import { create } from "zustand/react";
import { read, request } from "./api.ts";
import { inTurn } from "./draft.ts";
import { chatsKey, queries, useChats } from "./reads.ts";

/** By person; absent until the core's choice is read. */
const useChoices = create<Record<string, string | null>>(() => ({}));
/** By person: a new chat is being made; nothing can be sent. */
const useStarting = create<Record<string, boolean>>(() => ({}));
/** By person: how many times the person chose here. */
const made = new Map<string, number>();

const peoplePath = (personId: string) =>
  `/api/people/${encodeURIComponent(personId)}`;

/**
 * The chat the chat shows (null: none yet); undefined until read.
 * The core's choice is taken once, from the first read of the list.
 */
export function useChosen(personId: string): string | null | undefined {
  const local = useChoices((choices) => choices[personId]);
  const saved = useChats(personId).data?.chosen;
  useEffect(() => {
    if (saved === undefined) return;
    if (useChoices.getState()[personId] === undefined) {
      useChoices.setState({ [personId]: saved });
    }
  }, [personId, saved]);
  return local === undefined ? saved : local;
}

/** Whether a new chat is being made for the person. */
export const useStartingChat = (personId: string) =>
  useStarting((starting) => starting[personId] === true);

export const startingChat = (personId: string) =>
  useStarting.getState()[personId] === true;

/** One more of the person's choices; returns its number. */
const next = (personId: string) => {
  const n = (made.get(personId) ?? 0) + 1;
  made.set(personId, n);
  return n;
};

/**
 * The person chose the chat the chat shows. Also when it already
 * shows it: a New still being made then doesn't take the chat.
 */
export function choose(personId: string, chatId: string): void {
  useStarting.setState({ [personId]: false });
  next(personId);
  if (useChoices.getState()[personId] === chatId) return;
  useChoices.setState({ [personId]: chatId });
  void inTurn(queries, `chosen/${personId}`, () =>
    request("PUT", `${peoplePath(personId)}/chosen`, { chatId }),
  )
    // Only the next opening of Rufi needed it: the chat stays where it is,
    // and the page already says when Rufi can't be reached.
    .catch(() => undefined);
}

const Created = Schema.Struct({ chat: Chat });

/**
 * Starts a new chat (the core creates it at once) and shows it,
 * unless the person chose another one, or New again, while it was being
 * made: then it is only listed, and undefined. Until then nothing can be
 * sent from the chat, so nothing goes into the chat before.
 */
export async function startChat(personId: string): Promise<Chat | undefined> {
  const mine = next(personId);
  useStarting.setState({ [personId]: true });
  const current = () => made.get(personId) === mine;
  let chat: Chat;
  try {
    ({ chat } = await read(
      Created,
      "POST",
      `${peoplePath(personId)}/chats`,
      {},
    ));
  } catch (error) {
    if (current()) useStarting.setState({ [personId]: false });
    throw error;
  }
  // An older read of the list must not drop it.
  await queries.cancelQueries({ queryKey: chatsKey(personId) });
  queries.setQueryData<typeof Chats.Type>(
    chatsKey(personId),
    (list) =>
      list && {
        ...list,
        chats: [chat, ...list.chats],
      },
  );
  if (!current()) return undefined;
  choose(personId, chat.id);
  return chat;
}
