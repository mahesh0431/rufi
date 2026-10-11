// Ask Rufi: the pill on a row (a result, a follow-up, a document, a draft
// item, a Needs you line) that puts its chip in the chat box. A click on it
// never leaves the page, and doesn't close an open panel: the chip goes in
// the panel's box, the same draft.
import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";

/** Marks a control that adds to the chat: a click on it keeps the panel open. */
export const ASKS = { "data-ask": "" } as const;

/** The pill; `shown`: always, not only on the row's pointer or focus. */
export function AskRufi({
  shown = false,
  className,
  ...props
}: ComponentProps<"button"> & { shown?: boolean }) {
  return (
    <button
      type="button"
      {...ASKS}
      {...props}
      className={twMerge(
        "rounded-lg border border-line bg-surface px-2 py-px text-xs whitespace-nowrap text-accent-ink",
        shown
          ? ""
          : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100",
        className,
      )}
    >
      Ask Rufi
    </button>
  );
}
