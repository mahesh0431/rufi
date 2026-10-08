// The chat's model and effort, chosen in its box: one button that says
// both, and one menu with the allowed models, then the effort. Both are kept
// for the chat. A new model starts the AI afresh; a new effort applies from
// the next reply.
import { Menu } from "@base-ui/react/menu";
import { DEFAULT_EFFORT, type Effort } from "@rufi/contracts";
import { Check, ChevronDown } from "lucide-react";
import { createContext, type RefObject, useContext } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { request } from "./api.ts";
import { chatPath, type Live } from "./live.ts";
import { useModels } from "./reads.ts";

/** Where the chat's menus open: inside the chat, beside its glass. */
export const Menus = createContext<RefObject<HTMLDivElement | null> | null>(
  null,
);

const EFFORTS: readonly { id: Effort; name: string }[] = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
];

const POPUP =
  "z-30 w-72 rounded-xl bg-white/95 p-1.5 shadow-[0_0_0_1px_rgba(0,0,0,.06),0_8px_28px_rgba(0,0,0,.12)] backdrop-blur-xl outline-none";
const LABEL = "px-2 pt-1.5 pb-1 text-xs text-muted";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 outline-none select-none data-[highlighted]:bg-side";

export function ModelMenu({
  live,
  personId,
  act,
}: {
  live: StoreApi<Live>;
  personId: string;
  /** Runs a change; a refusal shows in the box. */
  act: (change: () => Promise<unknown>) => Promise<void>;
}) {
  const menus = useContext(Menus);
  const models = useModels();
  const chosen = useStore(live, (state) => state.chat);
  const offered = models.data?.models ?? [];
  // With none chosen yet, the first one, which the first message takes.
  const current = chosen?.model ?? offered[0]?.id;
  // Until the list comes: the chat's own model, or nothing in its place.
  const name = offered.find((m) => m.id === current)?.name ?? current;
  const effort = chosen?.effort ?? DEFAULT_EFFORT;
  const effortName = EFFORTS.find((e) => e.id === effort)?.name ?? effort;
  const path = chatPath(personId);

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Model and effort: ${name ?? "loading"}, ${effortName}`}
        className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[13px] whitespace-nowrap hover:bg-side data-[popup-open]:bg-side"
      >
        {name ?? <span className="inline-block w-[5.5rem]" />}
        <span className="text-muted">{effortName}</span>
        <ChevronDown size={14} className="text-muted" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal container={menus}>
        <Menu.Positioner side="top" align="end" sideOffset={8} className="z-30">
          <Menu.Popup className={POPUP}>
            <Menu.Group>
              <Menu.GroupLabel className={LABEL}>Model</Menu.GroupLabel>
              {models.error ? (
                <p className="px-2 py-1.5 text-muted">{models.error.message}</p>
              ) : (
                <Menu.RadioGroup
                  value={current}
                  onValueChange={(next: string) => {
                    if (next === current) return;
                    void act(() =>
                      request("PUT", `${path}/model`, { model: next }),
                    );
                  }}
                >
                  {offered.map((m) => (
                    <Menu.RadioItem
                      key={m.id}
                      value={m.id}
                      closeOnClick
                      className={ITEM}
                    >
                      <span className="grid size-4 place-items-center text-accent">
                        <Menu.RadioItemIndicator>
                          <Check size={15} aria-hidden />
                        </Menu.RadioItemIndicator>
                      </span>
                      {m.name}
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              )}
            </Menu.Group>
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.Group>
              <Menu.GroupLabel className={LABEL}>Effort</Menu.GroupLabel>
              <Menu.RadioGroup
                value={effort}
                onValueChange={(next: Effort) => {
                  if (next === effort) return;
                  void act(() =>
                    request("PUT", `${path}/effort`, { effort: next }),
                  );
                }}
                className="mx-1.5 flex rounded-[10px] bg-side p-[3px]"
              >
                {EFFORTS.map((e) => (
                  <Menu.RadioItem
                    key={e.id}
                    value={e.id}
                    closeOnClick
                    className="flex-1 cursor-default rounded-lg py-1 text-center text-muted outline-none select-none data-[checked]:bg-white data-[checked]:text-ink data-[checked]:shadow-sm data-[highlighted]:text-ink"
                  >
                    {e.name}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
              <p className="px-2 pt-1.5 pb-1 text-xs text-muted">
                Medium: careful answers at a good speed. Low is faster; High
                thinks longer.
              </p>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
