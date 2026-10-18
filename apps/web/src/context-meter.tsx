// How much of the AI's memory the chat uses: a small grey ring and the
// percentage beside the model and effort, as the agent last reported it (the
// last request's tokens over the model's context window). Hover or focus
// shows what it means. One colour: a full memory is normal, Codex compacts
// it. Nothing shows before the first report, or when the window is unknown.
import { Tooltip } from "@base-ui/react/tooltip";
import { useContext } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { Live } from "./live.ts";
import { Menus } from "./model-menu.tsx";

/** The ring's radius in its 36-unit box, and its length. */
const R = 14;
const AROUND = 2 * Math.PI * R;

export function ContextMeter({ live }: { live: StoreApi<Live> }) {
  const menus = useContext(Menus);
  const context = useStore(live, (state) => state.chat?.context ?? null);
  if (context === null) return null;
  const used = Math.min(
    100,
    Math.max(0, Math.round((100 * context.tokens) / context.window)),
  );
  const title = `Context used: ${String(used)}%`;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            type="button"
            aria-label={title}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[13px] text-muted hover:bg-side hover:text-ink data-[popup-open]:bg-side data-[popup-open]:text-ink"
          />
        }
      >
        <svg viewBox="0 0 36 36" className="size-4 -rotate-90" aria-hidden>
          <circle
            cx="18"
            cy="18"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.22}
            strokeWidth={5}
          />
          <circle
            cx="18"
            cy="18"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth={5}
            strokeDasharray={`${String((used / 100) * AROUND)} ${String(AROUND)}`}
          />
        </svg>
        {used}%
      </Tooltip.Trigger>
      {/* Inside the chat, beside its glass, as its menus. */}
      <Tooltip.Portal container={menus}>
        <Tooltip.Positioner side="top" sideOffset={8} className="z-50">
          <Tooltip.Popup className="w-64 rounded-xl bg-surface/95 px-3 py-2 text-xs text-ink shadow-menu backdrop-blur-xl">
            <p className="font-semibold">{title}</p>
            <p>
              Of the AI's memory for this chat. Near full, Codex compacts the
              chat history.
            </p>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
