// Where the person's chat shows: the bar at the bottom right of the page,
// the panel over it, or the chat's own page. Pages add to the chat box with
// `askRufi`: the chips go in the box, the bar lights up, and the page stays
// where it is.
import { create } from "zustand/react";
import { boxFor } from "./boxes.ts";
import type { BoxChip, BoxState } from "./draft.ts";

export const usePanel = create<{
  /** The panel is open over the page. */
  open: boolean;
  /** Where focus was before it opened, to go back to. */
  focusBefore: Element | null;
  /** Counts the adds from the pages: each one lights up the bar. */
  asked: number;
  /** Why the last add from a page didn't go in the box. */
  refused: string | null;
}>(() => ({
  open: false,
  focusBefore: null,
  asked: 0,
  refused: null,
}));

/** Opens the panel, remembering where focus goes back to. */
export const openPanel = () => {
  if (usePanel.getState().open) return;
  usePanel.setState({ open: true, focusBefore: document.activeElement });
};

/** Another page or person: the panel closes and forgets where focus was. */
export const resetPanel = () => {
  usePanel.setState({ open: false, focusBefore: null, refused: null });
};

/** Too small for the panel next to the page: the chat opens as the page. */
export const isSmall = () =>
  matchMedia("(max-width: 799px), (max-height: 499px)").matches;

/** The page of a person's chat. */
export const chatPage = (personId: string) =>
  ({ to: "/people/$personId/chat", params: { personId } }) as const;

/** Why the box takes nothing now, in words for the person; null: it does. */
export function whyClosed(state: BoxState): string | null {
  if (!state.loaded) return "The chat box is still loading.";
  if (state.sending) return "A message is being sent.";
  if (state.unresolved) {
    return "Your last message may not have reached Rufi: send it again or change it first.";
  }
  return null;
}

/**
 * Puts `chips` (and `text`, after what is there) in the person's chat box,
 * from a page: the bar lights up (an open panel's box takes the focus),
 * and the page stays.
 * When the box takes nothing now, the bar says why. False then.
 */
export function askRufi(
  personId: string,
  chips: readonly BoxChip[],
  text = "",
): boolean {
  const box = boxFor(personId);
  const state = box.store.getState();
  const why = whyClosed(state);
  if (why !== null) {
    usePanel.setState({
      refused: state.unresolved ? why : `${why} Add this again in a moment.`,
    });
    return false;
  }
  box.append(text, chips);
  usePanel.setState((now) => ({ asked: now.asked + 1, refused: null }));
  return true;
}
