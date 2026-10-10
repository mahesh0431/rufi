// The chat: the person's one chat with Rufi in three sizes, drawn with the
// same transcript and box. The bar, a pill, sits bottom right on the
// Overview; click it or press ⌘J and the panel opens over the page, always
// the same size; –, Esc or a click outside it steps back to the bar. "Open as page" shows the chat at its own
// address, Chat with Rufi in the sidebar. A small window opens the page
// instead of the panel.
import type { Person } from "@rufi/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Maximize2, Minus } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { FileDrop } from "./attach.tsx";
import { Box } from "./box.tsx";
import { liveStore, loadOlder, retain } from "./live.ts";
import { Menus } from "./model-menu.tsx";
import { chatPage, isSmall, openPanel, usePanel } from "./panel.ts";
import { useStatus } from "./reads.ts";
import { TranscriptView } from "./transcript.tsx";

/** The chat's name on screen. */
export const CHAT_TITLE = "Chat with Rufi";

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
              ? "fixed right-5 bottom-5 z-20 flex h-[min(660px,calc(100vh-40px))] w-[500px] flex-col overflow-hidden rounded-[20px] bg-surface/95 shadow-float backdrop-blur-xl"
              : "fixed right-5 bottom-5 z-20 flex w-[480px] max-w-[calc(100vw-280px)] flex-col"
          }
        >
          {open && (
            <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line px-2">
              <IconButton label="Minimise" onClick={close}>
                <Minus size={16} aria-hidden />
              </IconButton>
              <h2 className="flex-1 truncate px-1 font-semibold">
                {CHAT_TITLE}
              </h2>
              <IconButton
                label="Open as page"
                onClick={() => {
                  usePanel.setState({ open: false });
                  void navigate(chatPage(person.id));
                }}
              >
                <Maximize2 size={14} aria-hidden />
              </IconButton>
            </div>
          )}
          <FileDrop
            personId={person.id}
            off={!open}
            className={open ? "flex min-h-0 flex-1 flex-col" : ""}
          >
            {open && (
              <TranscriptView
                live={live}
                personId={person.id}
                onOlder={() => void loadOlder(person.id)}
                className="flex-1 overflow-auto px-[18px] py-4"
              />
            )}
            <div
              className={
                open
                  ? "px-3 pt-1"
                  : "rounded-full bg-surface/95 shadow-float backdrop-blur-xl"
              }
            >
              <Box
                person={person}
                live={live}
                size={open ? "panel" : "bar"}
                inputRef={field}
                onOpen={openChat}
              />
            </div>
          </FileDrop>
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
    <FileDrop personId={person.id} className="flex h-full flex-col">
      <div ref={menus} />
      <Menus value={menus}>
        <TranscriptView
          live={live}
          personId={person.id}
          onOlder={() => void loadOlder(person.id)}
          className="flex-1 overflow-auto"
          inner="mx-auto max-w-[760px] px-10 py-6"
        />
        <div className="mx-auto w-full max-w-[760px] px-10 pb-1">
          <Box person={person} live={live} size="page" inputRef={field} />
          <AiCanMakeMistakes />
        </div>
      </Menus>
    </FileDrop>
  );
}

/** Under the box: the plan the chat uses, when signed in, and a reminder. */
function AiCanMakeMistakes() {
  const signedIn = useStatus().data?.account === "signed_in";
  return (
    <p className="pt-1 pb-2 text-center text-[11.5px] text-muted">
      {signedIn && (
        <>
          Using ChatGPT plan ·{" "}
          <a
            href="https://chatgpt.com/codex/settings/usage"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Manage usage
          </a>{" "}
          ·{" "}
        </>
      )}
      AI can make mistakes. Check important info.
    </p>
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
