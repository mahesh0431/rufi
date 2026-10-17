// Ask Rufi: the quiet button on a row (a result, a follow-up, a document, a
// draft item, a Needs you line) that puts its chip in the chat box. A click
// on it never leaves the page, and doesn't close an open panel: the chip goes
// in the panel's box, the same draft. On a page with nothing to point at, it
// opens the chat.
import { useNavigate } from "@tanstack/react-router";
import { MessageCircle } from "lucide-react";
import type { ComponentProps } from "react";
import { chatPage, isSmall, openPanel } from "./panel.ts";
import { Button } from "./ui.tsx";

/** Marks a control that adds to the chat: a click on it keeps the panel open. */
export const ASKS = { "data-ask": "" } as const;

export function AskRufi(props: Omit<ComponentProps<"button">, "children">) {
  return (
    <Button look="quiet" icon={MessageCircle} {...ASKS} {...props}>
      Ask Rufi
    </Button>
  );
}

/**
 * Ask Rufi on an empty page: the chat opens over it, or as its page in a
 * small window.
 */
export function AskRufiEmpty({ personId }: { personId: string }) {
  const navigate = useNavigate();
  return (
    <Button
      icon={MessageCircle}
      {...ASKS}
      onClick={() => {
        if (isSmall()) void navigate(chatPage(personId));
        else openPanel();
      }}
    >
      Ask Rufi
    </Button>
  );
}
