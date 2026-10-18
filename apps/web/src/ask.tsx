// Ask Rufi: Rufi's face on its round badge with a blue +, on a row (a result,
// a follow-up, a document, a draft item, a Needs you line, a report) that
// puts its chip in the chat box. It shows when its row is under the pointer
// or has the focus, and always on a touch screen (styles.css); pointing at
// it shows a small label of what it does. A click on it never leaves the
// page, and doesn't close an open panel: the chip goes in the panel's box,
// the same draft.
import { svg } from "@rufi/brand/mark";
import { Plus } from "lucide-react";
import type { ComponentProps } from "react";
import { twMerge } from "tailwind-merge";

/** What the small label beside the face says. */
const TIP = "Ask Rufi about this";

/** Marks a control that adds to the chat: a click on it keeps the panel open. */
export const ASKS = { "data-ask": "" } as const;

// The face, drawn once by the brand package for each theme; the theme on
// <html data-theme> shows one, as for the sidebar's dog.
const face = (palette: "onPeriwinkle" | "inkApricot") =>
  svg({ palette, size: 24, ground: "circle", motion: false });
const LIGHT = face("onPeriwinkle");
const DARK = face("inkApricot");

export function AskRufi({
  className,
  ...props
}: Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      type="button"
      aria-label="Ask Rufi"
      {...ASKS}
      {...props}
      className={twMerge(
        "ask-rufi relative inline-flex size-8 shrink-0 items-center justify-center rounded-full",
        className,
      )}
    >
      <span aria-hidden className="ask-rufi-face relative flex">
        <span data-dog="light" dangerouslySetInnerHTML={{ __html: LIGHT }} />
        <span data-dog="dark" dangerouslySetInnerHTML={{ __html: DARK }} />
        <span className="ask-rufi-plus absolute top-[15px] left-[15px] flex size-3 items-center justify-center rounded-full bg-accent text-on-accent">
          <Plus size={8} strokeWidth={4} />
        </span>
      </span>
      <span
        aria-hidden
        className="ask-rufi-tip pointer-events-none absolute top-1/2 right-full mr-1.5 -translate-y-1/2 rounded-md bg-surface px-2 py-0.5 text-xs font-normal whitespace-nowrap text-muted shadow-menu"
      >
        {TIP}
      </span>
    </button>
  );
}
