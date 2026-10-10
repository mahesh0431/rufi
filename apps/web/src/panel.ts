// Where the person's chat shows: the panel over the Overview, or the
// chat's own page. Pages that add to the chat box show it after.
import { useLocation, useNavigate } from "@tanstack/react-router";
import { create } from "zustand/react";

/** Whether the chat panel is open over the page, and where focus was before. */
export const usePanel = create<{ open: boolean; focusBefore: Element | null }>(
  () => ({
    open: false,
    focusBefore: null,
  }),
);

/** Opens the panel, remembering where focus goes back to. */
export const openPanel = () => {
  if (usePanel.getState().open) return;
  usePanel.setState({ open: true, focusBefore: document.activeElement });
};

/** Too small for the panel next to the page: the chat opens as the page. */
export const isSmall = () =>
  matchMedia("(max-width: 799px), (max-height: 499px)").matches;

/** The page of a person's chat. */
export const chatPage = (personId: string) =>
  ({ to: "/people/$personId/chat", params: { personId } }) as const;

/**
 * Shows the person's chat: the panel over the Overview, else the chat's
 * page; after "+ Add to chat", so the person sees the chips and sends.
 */
export function useShowChat(personId: string) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return () => {
    if (pathname === "/" && !isSmall()) openPanel();
    else void navigate(chatPage(personId));
  };
}
