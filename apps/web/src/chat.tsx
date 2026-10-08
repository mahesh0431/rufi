// The chat: the person's one chat with Rufi in three sizes, drawn with the
// same header, transcript and box. The bar sits bottom right on the
// Overview; click it or press ⌘J and the panel opens over the page, always
// the same size; Esc or a click outside it steps back to the bar. "Open as page" shows the chat at its own
// address, Chat with Rufi in the sidebar. A small window opens the page
// instead of the panel.
import { Menu } from "@base-ui/react/menu";
import type { Person } from "@rufi/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, Maximize2, Minus } from "lucide-react";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { create } from "zustand/react";
import type { StoreApi } from "zustand/vanilla";
import { request } from "./api.ts";
import { Box } from "./box.tsx";
import {
  chatPath,
  type Live,
  liveStore,
  loadOlder,
  messageOf,
  retain,
} from "./live.ts";
import { useModels, useStatus } from "./reads.ts";
import { TranscriptView } from "./transcript.tsx";

/** Where the chat's menus open: inside the chat, beside its glass. */
const Menus = createContext<RefObject<HTMLDivElement | null> | null>(null);

/** Whether the chat panel is open over the page, and where focus was before. */
const usePanel = create<{ open: boolean; focusBefore: Element | null }>(() => ({
  open: false,
  focusBefore: null,
}));

/** Opens the panel, remembering where focus goes back to. */
const openPanel = () => {
  if (usePanel.getState().open) return;
  usePanel.setState({ open: true, focusBefore: document.activeElement });
};

/** Too small for the panel next to the page: the chat opens as the page. */
const isSmall = () =>
  matchMedia("(max-width: 799px), (max-height: 499px)").matches;

/** The chat's name on screen. */
export const CHAT_TITLE = "Chat with Rufi";

/** The page of a person's chat. */
const chatPage = (personId: string) =>
  ({ to: "/people/$personId/chat", params: { personId } }) as const;

/** The live store of the person's chat, open while this view shows it. */
function useLive(personId: string) {
  useEffect(() => retain(personId), [personId]);
  return liveStore(personId);
}

/** The bar and the panel, on the Overview. */
export function ChatDock({ person }: { person: Person }) {
  const open = usePanel((state) => state.open);
  const live = useLive(person.id);
  const navigate = useNavigate();
  const field = useRef<HTMLTextAreaElement | null>(null);
  const menus = useRef<HTMLDivElement | null>(null);
  const dock = useRef<HTMLElement | null>(null);

  const openChat = () => {
    if (usePanel.getState().open) return;
    if (isSmall()) {
      void navigate(chatPage(person.id));
      return;
    }
    openPanel();
  };
  const close = () => {
    const back = usePanel.getState().focusBefore;
    usePanel.setState({ open: false, focusBefore: null });
    if (
      back instanceof HTMLElement &&
      back.isConnected &&
      back !== document.body
    ) {
      back.focus();
    } else field.current?.focus();
  };

  // ⌘J opens the chat, and closes it again.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "j"
      ) {
        return;
      }
      event.preventDefault();
      if (usePanel.getState().open) close();
      else openChat();
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
    };
  });
  // The panel opens with the box ready for typing.
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  // A click outside the panel and its menus steps back to the bar; focus
  // goes where the click put it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && dock.current?.contains(event.target))
        return;
      usePanel.setState({ open: false, focusBefore: null });
    };
    addEventListener("pointerdown", onDown);
    return () => {
      removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <section ref={dock} aria-label="Chat">
      <Menus value={menus}>
        <div
          onKeyDown={(event) => {
            if (event.key === "Escape" && open && !event.defaultPrevented) {
              event.preventDefault();
              close();
            }
          }}
          className={
            open
              ? "fixed right-5 bottom-5 z-20 flex h-[min(660px,calc(100vh-40px))] w-[500px] flex-col overflow-hidden rounded-[20px] bg-white/95 shadow-[0_0_0_1px_rgba(0,0,0,.06),0_8px_28px_rgba(0,0,0,.10)] backdrop-blur-xl"
              : "group fixed right-5 bottom-5 z-20 flex w-[480px] max-w-[calc(100vw-280px)] flex-col overflow-hidden rounded-[20px] bg-white/95 shadow-[0_0_0_1px_rgba(0,0,0,.06),0_8px_28px_rgba(0,0,0,.10)] backdrop-blur-xl"
          }
        >
          <Header
            className={
              open
                ? "flex border-b border-line"
                : "hidden group-focus-within:flex group-hover:flex"
            }
            person={person}
            titled
            live={live}
            withModel={open}
            actions={
              <IconButton
                label="Open as page"
                onClick={() => {
                  usePanel.setState({ open: false });
                  void navigate(chatPage(person.id));
                }}
              >
                <Maximize2 size={14} aria-hidden />
              </IconButton>
            }
            lead={
              open ? (
                <IconButton label="Minimise" onClick={close}>
                  <Minus size={16} aria-hidden />
                </IconButton>
              ) : null
            }
          />
          {open && (
            <TranscriptView
              live={live}
              onOlder={() => void loadOlder(person.id)}
              className="flex-1 overflow-auto px-[18px] py-4"
            />
          )}
          <div className={open ? "border-t border-line" : undefined}>
            <Box
              person={person}
              live={live}
              size={open ? "panel" : "bar"}
              inputRef={field}
              onOpen={openChat}
            />
          </div>
          <AiCanMakeMistakes />
        </div>
      </Menus>
      <div ref={menus} />
    </section>
  );
}

/** The chat at its own address. */
export function ChatPage({ person }: { person: Person }) {
  const live = useLive(person.id);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const menus = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    field.current?.focus();
  }, [person.id]);
  // ⌘J goes to the box.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        field.current?.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div ref={menus} />
      <Menus value={menus}>
        <Header
          className="flex px-5"
          person={person}
          titled={false}
          live={live}
          withModel
        />
        <TranscriptView
          live={live}
          onOlder={() => void loadOlder(person.id)}
          className="flex-1 overflow-auto"
          inner="mx-auto max-w-[760px] px-10 py-6"
        />
        <div className="mx-auto w-full max-w-[760px] px-10 pb-1">
          <Box person={person} live={live} size="page" inputRef={field} />
          <AiCanMakeMistakes />
        </div>
      </Menus>
    </div>
  );
}

function AiCanMakeMistakes() {
  return (
    <p className="pt-1 pb-2 text-center text-[11.5px] text-muted">
      AI can make mistakes. Check important info.
    </p>
  );
}

/**
 * The chat's header: its name and the size buttons (bar and panel), then,
 * quietly, the model menu and the plan it uses (panel and page).
 */
function Header({
  className,
  person,
  titled,
  live,
  withModel,
  lead,
  actions,
}: {
  className: string;
  person: Person;
  /** With its name; not on the page, whose name is the toolbar's. */
  titled: boolean;
  live: StoreApi<Live>;
  withModel: boolean;
  lead?: ReactNode;
  actions?: ReactNode;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  // The plan is used only when signed in.
  const signedIn = useStatus().data?.account === "signed_in";
  return (
    <div className={`${className} flex-col`}>
      {titled && (
        <div className="flex h-12 items-center gap-1.5 px-2.5">
          {lead}
          <h2 className="truncate px-1.5 font-semibold">{CHAT_TITLE}</h2>
          <span className="flex-1" />
          {actions}
        </div>
      )}
      {withModel && (
        <div
          className={`flex items-center gap-0.5 px-3 pb-1.5 text-xs text-muted ${titled ? "-mt-2" : "justify-end pt-2"}`}
        >
          <LiveModel
            live={live}
            onChange={(next) => {
              setProblem(null);
              request("PUT", `${chatPath(person.id)}/model`, {
                model: next,
              }).catch((error: unknown) => {
                setProblem(messageOf(error));
              });
            }}
          />
          {signedIn && (
            <span className="whitespace-nowrap">
              · Using ChatGPT plan ·{" "}
              <a
                href="https://chatgpt.com/codex/settings/usage"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Manage usage
              </a>
            </span>
          )}
        </div>
      )}
      {problem !== null && (
        <p role="alert" className="px-3.5 pb-2 text-muted">
          {problem}
        </p>
      )}
    </div>
  );
}

function LiveModel({
  live,
  onChange,
}: {
  live: StoreApi<Live>;
  onChange: (model: string) => void;
}) {
  const model = useStore(live, (state) => state.chat?.model ?? undefined);
  return <ModelMenu value={model} onChange={onChange} />;
}

const POPUP =
  "z-30 min-w-48 rounded-xl bg-white/90 p-1 shadow-[0_0_0_1px_rgba(0,0,0,.06),0_8px_28px_rgba(0,0,0,.12)] backdrop-blur-xl outline-none";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none select-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-ink";

/** The allowed models; with none chosen yet, the first one, which the first message takes. */
function ModelMenu({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (model: string) => void;
}) {
  const menus = useContext(Menus);
  const models = useModels();
  const offered = models.data?.models ?? [];
  const current = value ?? offered[0]?.id;
  const name =
    offered.find((m) => m.id === current)?.name ?? current ?? "Model";
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Model: ${name}`}
        className="-ml-1.5 flex items-center gap-0.5 rounded-md px-1.5 py-0.5 whitespace-nowrap hover:bg-side"
      >
        {name}
        <ChevronDown size={13} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal container={menus}>
        <Menu.Positioner sideOffset={6} align="end" className="z-30">
          <Menu.Popup className={POPUP}>
            {models.error ? (
              <p className="max-w-64 px-2.5 py-1.5 text-muted">
                {models.error.message}
              </p>
            ) : (
              <Menu.RadioGroup
                value={current}
                onValueChange={(next: string) => {
                  if (next !== current) onChange(next);
                }}
              >
                {offered.map((m) => (
                  <Menu.RadioItem
                    key={m.id}
                    value={m.id}
                    closeOnClick
                    className={ITEM}
                  >
                    <span className="flex-1">{m.name}</span>
                    <Menu.RadioItemIndicator>
                      <Check size={13} aria-hidden />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-side hover:text-ink"
    >
      {children}
    </button>
  );
}
