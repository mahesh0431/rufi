// The chat's model and effort, chosen in its box: one button that says
// both, and one menu with Rufi's four models, then the effort. A provider
// that isn't signed in shows its models greyed, with a line that signs in.
// Choosing keeps the menu open, to set both in one go; a click outside, the
// button again or Esc closes it. Both are kept for the chat. Both apply from the next reply, in the same
// AI thread.
import { Menu } from "@base-ui/react/menu";
import {
  DEFAULT_EFFORT,
  type Effort,
  EFFORTS,
  MODELS,
  modelOf,
  type Provider,
} from "@rufi/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, LogIn } from "lucide-react";
import { createContext, Fragment, type RefObject, useContext } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { request } from "./api.ts";
import { chatPath, type Live } from "./live.ts";
import { useStatus } from "./reads.ts";
import { ICON } from "./ui.tsx";

/** Where the chat's menus open: inside the chat, beside its glass. */
export const Menus = createContext<RefObject<HTMLDivElement | null> | null>(
  null,
);

/** Each effort's name on screen, as the menu shows it. */
const EFFORT_NAMES: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
};

/** An effort's name on screen; one Rufi doesn't know, as it is. */
export const effortName = (effort: string) =>
  effort in EFFORT_NAMES ? EFFORT_NAMES[effort as Effort] : effort;

/** The line that signs a provider in, under its models. */
const SIGN_IN: Record<Provider, string> = {
  codex: "Sign in with ChatGPT",
  claude: "Sign in to Claude",
};

const POPUP =
  "z-30 w-72 rounded-xl bg-surface/95 p-1.5 shadow-menu backdrop-blur-xl outline-none";
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
  const navigate = useNavigate();
  const status = useStatus().data;
  // Until the sign-ins are read, every model shows as it can run.
  const out = (provider: Provider) =>
    status !== undefined && status[provider].state !== "signed_in";
  const chosen = useStore(live, (state) => state.chat);
  // With none chosen yet, a new chat's, which the first message takes.
  const current = chosen?.model ?? MODELS[0].id;
  const name = modelOf(current)?.name ?? current;
  const effort = chosen?.effort ?? DEFAULT_EFFORT;
  const shownEffort = effortName(effort);
  const path = chatPath(personId);
  const providers = [...new Set(MODELS.map((m) => m.provider))];

  return (
    // Not modal: a click outside closes the menu and reaches the page, so
    // it closes the panel too.
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label={`Model and effort: ${name}, ${shownEffort}`}
        className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] whitespace-nowrap hover:bg-side data-[popup-open]:bg-side"
      >
        {name}
        {/* A space between the two, so the menu's name holds what it shows. */}{" "}
        <span className="text-muted">{shownEffort}</span>
        <ChevronDown size={ICON} className="text-muted" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal container={menus}>
        <Menu.Positioner side="top" align="end" sideOffset={8} className="z-30">
          <Menu.Popup className={POPUP}>
            <Menu.Group>
              <Menu.GroupLabel className={LABEL}>Model</Menu.GroupLabel>
              <Menu.RadioGroup
                value={current}
                onValueChange={(next: string) => {
                  if (next === current) return;
                  void act(() =>
                    request("PUT", `${path}/model`, { model: next }),
                  );
                }}
              >
                {providers.map((provider) => (
                  <Fragment key={provider}>
                    {MODELS.filter((m) => m.provider === provider).map((m) => (
                      <Menu.RadioItem
                        key={m.id}
                        value={m.id}
                        closeOnClick={false}
                        disabled={out(provider)}
                        className={`${ITEM} data-[disabled]:text-muted`}
                      >
                        <span className="grid size-4 place-items-center text-accent">
                          <Menu.RadioItemIndicator>
                            <Check size={ICON} aria-hidden />
                          </Menu.RadioItemIndicator>
                        </span>
                        {m.name}
                      </Menu.RadioItem>
                    ))}
                    {out(provider) && (
                      <Menu.Item
                        className={`${ITEM} text-accent-ink`}
                        onClick={() => void navigate({ to: "/sign-in" })}
                      >
                        <LogIn size={ICON} aria-hidden />
                        {SIGN_IN[provider]}
                      </Menu.Item>
                    )}
                  </Fragment>
                ))}
              </Menu.RadioGroup>
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
                    key={e}
                    value={e}
                    closeOnClick={false}
                    className="flex-1 cursor-default rounded-lg py-1 text-center text-muted outline-none select-none data-[checked]:bg-surface data-[checked]:text-ink data-[checked]:shadow-sm data-[highlighted]:text-ink"
                  >
                    {EFFORT_NAMES[e]}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
              <p className="px-2 pt-1.5 pb-1 text-xs text-muted">
                Medium: careful answers at a good speed. Low is faster; High and
                XHigh think longer.
              </p>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
