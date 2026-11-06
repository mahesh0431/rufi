// The chat: the person's one chat with Rufi in three sizes, drawn with the
// same transcript and box. The bar, a pill, sits bottom right on the pages
// where you read your health; Ask Rufi on them adds to its box, and the bar
// lights up a moment. Click it or press ⌘J and the panel opens over the
// page, always the same size; –, Esc or a click outside it steps back to
// the bar. "Open as page" shows the chat at its own address, Chat with Rufi
// in the sidebar. A small window opens the page instead of the panel. On a
// phone the bar spans the bottom, and the panel rises from it to under the
// app's title bar, with the keyboard; the arrow down, or a swipe down on
// its top, steps back to the bar.
import type { Person } from "@rufi/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Maximize2, Minus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AgentsAtWork } from "./agents.tsx";
import { FileDrop } from "./attach.tsx";
import { Box } from "./box.tsx";
import { liveStore, loadOlder, retain } from "./live.ts";
import { Menus } from "./model-menu.tsx";
import { chatPage, isSmall, openPanel, usePanel } from "./panel.ts";
import { onPhone } from "./phone.ts";
import { PhoneBox } from "./phone-box.tsx";
import { TranscriptView } from "./transcript.tsx";
import { IconButton } from "./ui.tsx";
import { FloatingWaiting } from "./waiting.tsx";

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
  // Room under the chat's last message for the waiting list over it.
  const [room, setRoom] = useState(0);
  const seen = useRef(asked);
  /** Closing with nowhere to go back to: the bar's box takes the focus. */
  const refocus = useRef(false);
  const live = useLive(person.id);
  const navigate = useNavigate();
  /** The box's text field in the panel; the pill, in the bar. */
  const field = useRef<HTMLElement | null>(null);
  const menus = useRef<HTMLDivElement | null>(null);
  const dock = useRef<HTMLElement | null>(null);

  /** Where a swipe on the panel's top started. */
  const swipe = useRef<number | null>(null);

  const openChat = () => {
    if (usePanel.getState().open) return;
    if (isSmall()) {
      void navigate(chatPage(person.id));
      return;
    }
    if (onPhone) {
      // The keyboard shows only for a focus within the tap itself.
      flushSync(openPanel);
      field.current?.focus();
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

  // On a phone the app draws the box: closed, nothing shows here.
  if (onPhone && !open) return null;
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
            onPhone
              ? open
                ? "fixed inset-x-2 top-[calc(var(--bar-top,0px)+4px)] bottom-[calc(var(--bar-bottom,0px)+8px)] z-20 flex flex-col overflow-hidden rounded-[20px] bg-surface/95 shadow-float backdrop-blur-xl"
                : "fixed inset-x-3 bottom-[calc(var(--bar-bottom,0px)+8px)] z-20 flex flex-col"
              : open
                ? "fixed right-5 bottom-5 z-20 flex h-[min(660px,calc(100vh-40px))] w-[500px] max-w-[calc(100vw-40px)] flex-col overflow-hidden rounded-[20px] bg-surface/95 shadow-float backdrop-blur-xl"
                : "fixed right-5 bottom-5 z-20 flex w-[480px] max-w-[calc(100vw-280px)] flex-col"
          }
        >
          {open && (
            <div
              className="flex h-11 shrink-0 touch-none items-center gap-1.5 border-b border-line px-2"
              onPointerDown={(event) => {
                swipe.current = event.clientY;
              }}
              onPointerUp={(event) => {
                const from = swipe.current;
                swipe.current = null;
                if (onPhone && from !== null && event.clientY - from > 40) {
                  close();
                }
              }}
            >
              <IconButton
                label="Minimise"
                icon={onPhone ? ChevronDown : Minus}
                onClick={close}
              />
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
                room={room}
              />
            )}
            <div
              className={
                open
                  ? "relative px-3 pt-1"
                  : `rounded-full bg-surface/95 shadow-float backdrop-blur-xl transition-shadow ${lit ? "ring-2 ring-accent" : ""}`
              }
            >
              {open && (
                <FloatingWaiting
                  live={live}
                  personId={person.id}
                  onHeight={setRoom}
                  // Over the 4 px above the box, as close as on the page.
                  className="inset-x-3 bottom-[calc(100%-0.25rem)]"
                />
              )}
              {open && <AgentsAtWork personId={person.id} />}
              {!onPhone && (
                <Box
                  person={person}
                  live={live}
                  size={open ? "panel" : "bar"}
                  inputRef={field}
                  onOpen={openChat}
                />
              )}
            </div>
          </FileDrop>
          {open && !onPhone && <AiCanMakeMistakes />}
        </div>
      </Menus>
      <div ref={menus} />
    </section>
  );
}

/**
 * In the iPhone app: the page keeps the box's rules for the app's own box,
 * and, on a reading page (`panel`), draws the panel over it.
 */
export function PhoneChat({
  person,
  panel,
}: {
  person: Person;
  panel: boolean;
}) {
  const live = useLive(person.id);
  return (
    <>
      <PhoneBox person={person} live={live} />
      {panel && <ChatDock person={person} />}
    </>
  );
}

/** The chat at its own address. */
export function ChatPage({ person }: { person: Person }) {
  const live = useLive(person.id);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const menus = useRef<HTMLDivElement | null>(null);
  const [room, setRoom] = useState(0);

  // On a phone, the keyboard waits for a tap in the box.
  useEffect(() => {
    if (!onPhone) field.current?.focus();
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
          inner="mx-auto max-w-[760px] px-gutter py-6 phone:pt-[calc(var(--bar-top,0px)+1.5rem)]"
          room={room}
        />
        <div className="mx-auto w-full max-w-[760px] px-gutter pb-1 phone:pb-(--bar-bottom)">
          <div className="relative">
            <FloatingWaiting
              live={live}
              personId={person.id}
              onHeight={setRoom}
              className="inset-x-0 bottom-full"
            />
            <AgentsAtWork personId={person.id} />
            {/* On a phone the app draws the box and the words under it. */}
            {!onPhone && (
              <>
                <Box person={person} live={live} size="page" inputRef={field} />
                <AiCanMakeMistakes />
              </>
            )}
          </div>
        </div>
      </Menus>
    </FileDrop>
  );
}

/** Under the box: a reminder to check what the AI says. */
function AiCanMakeMistakes() {
  return (
    <p className="pt-1 pb-2 text-center text-[0.71875rem] text-muted">
      AI can make mistakes. Check important health decisions with your doctor.
    </p>
  );
}
