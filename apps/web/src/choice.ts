// The conversation the chat continues, per person. This tab owns it: the
// core's choice is taken once, from the first read of the list, and from then
// on only the person changes it here, so no read, late answer or other tab
// moves the chat. The core's copy is for the next time Rufi opens. Every
// write of it goes in one line per person, the first message of a new
// conversation too (the core chooses the conversation it starts), so the core
// keeps the person's last choice whatever order the answers come in.
import { Conversations } from "@rufi/contracts";
import { create } from "zustand/react";
import { read, request } from "./api.ts";

/** By person; undefined until known. */
const useChoices = create<Record<string, string | null | undefined>>(
  () => ({}),
);
/** By person: how many choices the person made in this tab. */
const made = new Map<string, number>();
/** By person: the last write of the core's choice, in line. */
const lines = new Map<string, Promise<unknown>>();

const peoplePath = (personId: string) =>
  `/api/people/${encodeURIComponent(personId)}`;

/** The conversation the chat continues (null: a new one); undefined until read. */
export const useChosen = (personId: string) =>
  useChoices((choices) => choices[personId]);

/** The core's choice, read with the list: taken while this tab has none. */
export function adopt(personId: string, chosen: string | null): void {
  if (useChoices.getState()[personId] === undefined) {
    useChoices.setState({ [personId]: chosen });
  }
}

/** Runs `write` after the person's earlier writes of the core's choice. */
export function inLine<T>(
  personId: string,
  write: () => Promise<T>,
): Promise<T> {
  const run = (lines.get(personId) ?? Promise.resolve()).then(write);
  const done = run.then(
    () => undefined,
    () => undefined,
  );
  lines.set(personId, done);
  void done.then(() => {
    if (lines.get(personId) === done) lines.delete(personId);
  });
  return run;
}

/** Chooses the conversation the chat continues; null starts a new one. */
export function choose(personId: string, conversationId: string | null): void {
  if (useChoices.getState()[personId] === conversationId) return;
  made.set(personId, (made.get(personId) ?? 0) + 1);
  useChoices.setState({ [personId]: conversationId });
  void inLine(personId, async () => {
    try {
      await request("PUT", `${peoplePath(personId)}/chosen`, {
        conversationId,
      });
    } catch {
      // Not kept: the chat shows what the core keeps, unless the person
      // chose again meanwhile. If even that can't be read, the page says
      // Rufi can't be reached, and the choice stays as it is.
      const kept = await read(
        Conversations,
        "GET",
        `${peoplePath(personId)}/conversations`,
      ).catch(() => undefined);
      if (kept && useChoices.getState()[personId] === conversationId) {
        useChoices.setState({ [personId]: kept.chosen });
      }
    }
  });
}

/**
 * A new conversation's first message is about to go: the returned function
 * says, when it comes back, whether the chat may continue the conversation
 * it started, which it may unless the person chose another one meanwhile.
 */
export function beforeFirstMessage(personId: string): () => boolean {
  const before = made.get(personId) ?? 0;
  return () => (made.get(personId) ?? 0) === before;
}

/** The chat continues the conversation a first message started (the core chose it). */
export function continueStarted(personId: string, conversationId: string) {
  useChoices.setState({ [personId]: conversationId });
}
