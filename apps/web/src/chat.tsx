// The chat: one conversation in three sizes, drawn with the same header,
// transcript and box. The bar sits bottom right and continues the
// conversation you chose last; click it or press ⌘J and the panel opens over
// the page, always the same size; Esc steps back to the bar. "Open as page"
// shows the conversation at its own address. A small window opens the page
// instead of the panel.
import { Menu } from "@base-ui/react/menu";
import type { Conversation, Person } from "@rufi/contracts";
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
  choose,
  conversationPath,
  type Live,
  liveStore,
  messageOf,
  retain,
  showStarted,
} from "./live.ts";
import { useConversations, useModels } from "./reads.ts";
import { FirstMessage, TranscriptView } from "./transcript.tsx";

/** Where the chat's menus open: inside the chat, beside its glass. */
const Menus = createContext<RefObject<HTMLDivElement | null> | null>(null);

/** Whether the chat panel is open over the page, and where focus was before. */
const useChat = create<{ open: boolean; focusBefore: Element | null }>(() => ({
  open: false,
  focusBefore: null,
}));

/** Opens the panel, remembering where focus goes back to. */
const openPanel = () => {
  useChat.setState({ open: true, focusBefore: document.activeElement });
};

/** Too small for the panel next to the page: the chat opens as the page. */
const isSmall = () =>
  matchMedia("(max-width: 799px), (max-height: 499px)").matches;

export const titleOf = (conversation: Conversation | null | undefined) =>
  conversation?.title ?? "New conversation";

/** The page of a person's conversation; "new" for a new one. */
const pageOf = (personId: string, conversationId: string | null) =>
  ({
    to: "/people/$personId/conversations/$conversationId",
    params: { personId, conversationId: conversationId ?? "new" },
  }) as const;

/** The live store of a conversation, open while this view shows it. */
function useLive(personId: string, conversationId: string | null) {
  useEffect(
    () =>
      conversationId === null ? undefined : retain(personId, conversationId),
    [personId, conversationId],
  );
  return conversationId === null ? null : liveStore(personId, conversationId);
}

/** "New conversation": the chat starts a new one, in the panel or a page. */
export function useNewConversation(personId: string) {
  const navigate = useNavigate();
  return (onPage: boolean) => {
    void choose(personId, null);
    if (onPage || isSmall()) {
      void navigate(pageOf(personId, null));
      return;
    }
    openPanel();
  };
}

/** The bar and the panel, on every page but a conversation's own. */
export function ChatDock({ person }: { person: Person }) {
  const open = useChat((state) => state.open);
  const list = useConversations(person.id);
  const chosen = list.data?.chosen;
  const conversationId = chosen ?? null;
  const live = useLive(person.id, conversationId);
  const navigate = useNavigate();
  const field = useRef<HTMLTextAreaElement | null>(null);
  const menus = useRef<HTMLDivElement | null>(null);
  const [model, setModel] = useState<string>();

  const openChat = () => {
    if (useChat.getState().open) return;
    if (isSmall()) {
      void navigate(pageOf(person.id, conversationId));
      return;
    }
    openPanel();
  };
  const close = () => {
    const back = useChat.getState().focusBefore;
    useChat.setState({ open: false, focusBefore: null });
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
      if (useChat.getState().open) close();
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

  if (chosen === undefined) return null;
  const title = titleOf(
    list.data?.conversations.find((c) => c.id === conversationId),
  );
  return (
    <section aria-label="Chat">
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
            conversationId={conversationId}
            title={title}
            live={live}
            model={model}
            setModel={setModel}
            withModel={open}
            actions={
              <IconButton
                label="Open as page"
                onClick={() => {
                  useChat.setState({ open: false });
                  void navigate(pageOf(person.id, conversationId));
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
          {open &&
            (live ? (
              <TranscriptView
                live={live}
                className="flex-1 overflow-auto px-[18px] py-4"
              />
            ) : (
              <div className="flex-1 px-[18px] py-4">
                <FirstMessage />
              </div>
            ))}
          <div className={open ? "border-t border-line" : undefined}>
            <Box
              key={conversationId ?? "new"}
              person={person}
              conversationId={conversationId}
              live={live}
              model={model}
              size={open ? "panel" : "bar"}
              inputRef={field}
              onOpen={openChat}
              onStarted={(conversation) => {
                setModel(undefined);
                showStarted(person.id, conversation);
              }}
            />
          </div>
          <AiCanBeWrong />
        </div>
      </Menus>
      <div ref={menus} />
    </section>
  );
}

/** A conversation at its own address; viewing it chooses it for the bar. */
export function ConversationPage({
  person,
  conversationId,
}: {
  person: Person;
  conversationId: string | null;
}) {
  const live = useLive(person.id, conversationId);
  const navigate = useNavigate();
  const field = useRef<HTMLTextAreaElement | null>(null);
  const menus = useRef<HTMLDivElement | null>(null);
  const [model, setModel] = useState<string>();

  useEffect(() => {
    void choose(person.id, conversationId);
    field.current?.focus();
  }, [person.id, conversationId]);
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
          conversationId={conversationId}
          title={null}
          live={live}
          model={model}
          setModel={setModel}
          withModel
        />
        {live ? (
          <TranscriptView
            live={live}
            className="flex-1 overflow-auto"
            inner="mx-auto max-w-[760px] px-10 py-6"
          />
        ) : (
          <div className="mx-auto w-full max-w-[760px] flex-1 px-10 py-6">
            <FirstMessage />
          </div>
        )}
        <div className="mx-auto w-full max-w-[760px] px-10 pb-1">
          <Box
            key={conversationId ?? "new"}
            person={person}
            conversationId={conversationId}
            live={live}
            model={model}
            size="page"
            inputRef={field}
            onStarted={(conversation) => {
              setModel(undefined);
              showStarted(person.id, conversation);
              void navigate({
                ...pageOf(person.id, conversation.id),
                replace: true,
              });
            }}
          />
          <AiCanBeWrong />
        </div>
      </Menus>
    </div>
  );
}

function AiCanBeWrong() {
  return (
    <p className="pt-1 pb-2 text-center text-[11.5px] text-muted">
      AI can be wrong
    </p>
  );
}

/**
 * The chat's header: the conversation's switcher and the size buttons (bar
 * and panel), then, quietly, the model menu and the plan it uses (panel and
 * page).
 */
function Header({
  className,
  person,
  conversationId,
  title,
  live,
  model,
  setModel,
  withModel,
  lead,
  actions,
}: {
  className: string;
  person: Person;
  conversationId: string | null;
  /** The switcher's title; null on the page, whose title is the toolbar's. */
  title: string | null;
  live: StoreApi<Live> | null;
  model: string | undefined;
  setModel: (model: string) => void;
  withModel: boolean;
  lead?: ReactNode;
  actions?: ReactNode;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className={`${className} flex-col`}>
      {title !== null && (
        <div className="flex h-12 items-center gap-1.5 px-2.5">
          {lead}
          <Switcher
            person={person}
            conversationId={conversationId}
            title={title}
          />
          <span className="flex-1" />
          {actions}
        </div>
      )}
      {withModel && (
        <div
          className={`flex items-center gap-0.5 px-3 pb-1.5 text-xs text-muted ${title === null ? "justify-end pt-2" : "-mt-2"}`}
        >
          {live ? (
            <LiveModel
              live={live}
              onChange={(next) => {
                setProblem(null);
                request(
                  "PUT",
                  `${conversationPath(person.id, conversationId ?? "")}/model`,
                  { model: next },
                ).catch((error: unknown) => {
                  setProblem(messageOf(error));
                });
              }}
            />
          ) : (
            <ModelMenu value={model} onChange={setModel} />
          )}
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
  const model = useStore(live, (state) => state.conversation?.model);
  return <ModelMenu value={model} onChange={onChange} />;
}

const POPUP =
  "z-30 min-w-48 rounded-xl bg-white/90 p-1 shadow-[0_0_0_1px_rgba(0,0,0,.06),0_8px_28px_rgba(0,0,0,.12)] backdrop-blur-xl outline-none";
const ITEM =
  "flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none select-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-ink";

/** The allowed models; for a new conversation, the first one unless chosen. */
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

/** The person's conversations, to continue another one or start a new one. */
function Switcher({
  person,
  conversationId,
  title,
}: {
  person: Person;
  conversationId: string | null;
  title: string;
}) {
  const menus = useContext(Menus);
  const conversations = useConversations(person.id).data?.conversations ?? [];
  return (
    <Menu.Root>
      <Menu.Trigger className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 font-semibold hover:bg-side">
        <span className="max-w-72 truncate">{title}</span>
        <ChevronDown size={13} className="shrink-0 text-muted" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal container={menus}>
        <Menu.Positioner sideOffset={6} align="start" className="z-30">
          <Menu.Popup className={`${POPUP} max-h-80 overflow-auto`}>
            <Menu.RadioGroup
              value={conversationId ?? "new"}
              onValueChange={(next: string) => {
                void choose(person.id, next === "new" ? null : next);
              }}
            >
              {conversations.map((c) => (
                <Menu.RadioItem
                  key={c.id}
                  value={c.id}
                  closeOnClick
                  className={ITEM}
                >
                  <span className="max-w-64 flex-1 truncate">{titleOf(c)}</span>
                  <Menu.RadioItemIndicator>
                    <Check size={13} aria-hidden />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
              {conversations.length > 0 && (
                <Menu.Separator className="my-1 h-px bg-line" />
              )}
              <Menu.RadioItem value="new" closeOnClick className={ITEM}>
                <span className="flex-1">New conversation</span>
                <Menu.RadioItemIndicator>
                  <Check size={13} aria-hidden />
                </Menu.RadioItemIndicator>
              </Menu.RadioItem>
            </Menu.RadioGroup>
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
