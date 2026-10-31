// The chat: the person's one chat with Rufi in three sizes, drawn with the
// same transcript and box. The bar, a pill, sits bottom right on the pages
// where you read your health; Ask Rufi on them adds to its box, and the bar
// lights up a moment. Click it or press ⌘J and the panel opens over the
// page, always the same size; –, Esc or a click outside it steps back to
// the bar. "Open as page" shows the chat at its own address, Chat with Rufi
// in the sidebar. A small window opens the page instead of the panel.
import type { Person } from "@rufi/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Maximize2, Minus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentsAtWork } from "./agents.tsx";
import { FileDrop } from "./attach.tsx";
import { Box } from "./box.tsx";
import { liveStore, loadOlder, retain } from "./live.ts";
import { Menus } from "./model-menu.tsx";
import { chatPage, isSmall, openPanel, usePanel } from "./panel.ts";
import { TranscriptView } from "./transcript.tsx";
import { IconButton } from "./ui.tsx";

/** The chat's name on screen. */
export const CHAT_TITLE = "Chat with Rufi";

/** How long the bar stays lit after a page added to it. */
const LIT_MS = 900;

/** The live store of the person's chat, open while this view shows it. */
function useLive(personId: string) {
  useEffect(() => retain(personId), [personId]);
  return liveStore(personId);
}

/** The bar and the panel, over the pages where you read your health. */
export function ChatDock({ person }: { person: Person }) {
  const open = usePanel((state) => state.open);
  const asked = usePanel((state) => state.asked);
  const [lit, setLit] = useState(false);
  const seen = useRef(asked);
  /** Closing with nowhere to go back to: the bar's box takes the focus. */
  const refocus = useRef(false);
  const live = useLive(person.id);
  const navigate = useNavigate();
  /** The box's text field in the panel; the pill, in the bar. */
  const field = useRef<HTMLElement | null>(null);
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
    } else refocus.current = true;
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
  // The panel opens with the box ready for typing; the bar's box, drawn
  // anew, takes the focus when it had nowhere else to go back to.
  useEffect(() => {
    if (open || refocus.current) field.current?.focus();
    refocus.current = false;
  }, [open]);
  // A page added to the box: the bar lights up a moment; an open panel's
  // box takes the focus.
  useEffect(() => {
    if (asked === seen.current) return;
    seen.current = asked;
    if (usePanel.getState().open) field.current?.focus();
    setLit(true);
    const off = setTimeout(() => {
      setLit(false);
    }, LIT_MS);
    return () => {
      clearTimeout(off);
    };
  }, [asked]);
  // A click outside the panel and its menus steps back to the bar; focus
  // goes where the click put it. Ask Rufi on the page adds to the open
  // panel's box instead, and an agent's pop-up opens over the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && dock.current?.contains(event.target))
        return;
      if (
        event.target instanceof Element &&
        event.target.closest("[data-ask], [data-over-chat]")
      )
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
              ? "fixed right-5 bottom-5 z-20 flex h-[min(660px,calc(100vh-40px))] w-[500px] max-w-[calc(100vw-40px)] flex-col overflow-hidden rounded-[20px] bg-surface/95 shadow-float backdrop-blur-xl"
              : "fixed right-5 bottom-5 z-20 flex w-[480px] max-w-[calc(100vw-280px)] flex-col"
          }
        >
          {open && (
            <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line px-2">
              <IconButton label="Minimise" icon={Minus} onClick={close} />
              <h2 className="flex-1 truncate px-1 font-semibold">
                {CHAT_TITLE}
              </h2>
              <IconButton
                label="Open as page"
                icon={Maximize2}
                onClick={() => {
                  usePanel.setState({ open: false });
                  void navigate(chatPage(person.id));
                }}
              />
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
                  : `rounded-full bg-surface/95 shadow-float backdrop-blur-xl transition-shadow ${lit ? "ring-2 ring-accent" : ""}`
              }
            >
              {open && <AgentsAtWork personId={person.id} />}
              <Box
                person={person}
                live={live}
                size={open ? "panel" : "bar"}
                inputRef={field}
                onOpen={openChat}
              />
            </div>
          </FileDrop>
          {open && <AiCanMakeMistakes />}
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
          <AgentsAtWork personId={person.id} />
          <Box person={person} live={live} size="page" inputRef={field} />
          <AiCanMakeMistakes />
        </div>
      </Menus>
    </FileDrop>
  );
}

/** Under the box: a reminder to check what the AI says. */
function AiCanMakeMistakes() {
  return (
    <p className="pt-1 pb-2 text-center text-[11.5px] text-muted">
      AI can make mistakes. Check important health decisions with your doctor.
    </p>
  );
}
