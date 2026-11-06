// Phone mode: the screens inside Rufi's iPhone app (apps/ios). The app marks
// the page before it loads (<html data-place="phone">, with the iPhone's
// body text size and how much its bars cover as CSS values), and draws its
// own sidebar, title bar and Back. Here the page keeps its content and, on
// the pages where you read your health, the chat bar; every move to another
// page goes through the app, which opens it on top or switches place. The
// app talks back by `window.rufi.open(path)`, and by
// `window.rufi.added(answer)` after it uploaded a scan.
import {
  createMemoryHistory,
  useMatch,
  type RouterHistory,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { create } from "zustand/react";

/** Whether the screens run in Rufi's iPhone app. */
export const onPhone = document.documentElement.dataset["place"] === "phone";

/** What the screens tell the iPhone app. */
export type ToApp =
  /**
   * The person tapped a link to another page: the app opens it. `chat`:
   * they tapped it in the chat open over the page, which Back opens again.
   */
  | { type: "go"; path: string; chat: boolean }
  /** A page has drawn: the app's bar takes its title. */
  | { type: "page"; path: string; title: string }
  /** The session has ended: the app opens Rufi again, or says it's unpaired. */
  | { type: "ended" }
  /**
   * Doses, medicines or the reminder setting may have changed: the app
   * refreshes its reminders.
   */
  | { type: "refresh" }
  /** Scan: the app's document camera, then it adds the pages to the chat. */
  | { type: "scan" }

  /** View original: the app fetches the document's files and shows them. */
  | {
      type: "original";
      documentId: string;
      files: { id: string; name: string }[];
    }
  /**
   * The colours the page draws in now (the theme chosen on the Mac, in the
   * iPhone's light or dark): the app's own parts take them.
   */
  | { type: "theme"; dark: boolean; colours: Record<ThemeColour, string> };

/** The theme's colours the app's own parts take. */
const THEME_COLOURS = {
  page: "--page",
  side: "--side",
  surface: "--surface",
  accent: "--accent",
  accentSoft: "--accent-soft",
  accentInk: "--accent-ink",
} as const;
type ThemeColour = keyof typeof THEME_COLOURS;

/** Tells the app the page's colours now, and again whenever they change. */
export function tellTheme(): () => void {
  const root = document.documentElement;
  const send = () => {
    const style = getComputedStyle(root);
    const colours = Object.fromEntries(
      Object.entries(THEME_COLOURS).map(([name, token]) => [
        name,
        style.getPropertyValue(token).trim(),
      ]),
    ) as Record<ThemeColour, string>;
    tell({ type: "theme", dark: root.dataset["theme"] === "dark", colours });
  };
  send();
  const changes = new MutationObserver(send);
  changes.observe(root, { attributeFilter: ["data-theme", "data-colour"] });
  return () => {
    changes.disconnect();
  };
}

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        rufi?: { postMessage: (message: ToApp) => void };
      };
    };
    rufi?: {
      open: (path: string, chat?: boolean) => void;
      added: (answer: unknown) => void;
    };
  }
}

/**
 * Who takes the app's answer to the last scan asked for. It lives here, not
 * in the button, so an answer that arrives while the person is on another
 * tab still reaches their chat box.
 */
const scanning: { added: ((answer: unknown) => void) | null } = { added: null };

/** Asks the app to scan; `added` takes what it adds, whenever that comes. */
export function scan(added: (answer: unknown) => void): void {
  scanning.added = added;
  tell({ type: "scan" });
}

/** A page's own name, at its address, for the app's title bar. */
export const useNamed = create<{
  named: { path: string; title: string } | null;
}>(() => ({ named: null }));

/**
 * Gives the app's title bar the page's own name ("HbA1c", a document's
 * name) instead of its kind, once the page has it. At the page's own
 * address: as another page opens, this one can still draw once.
 */
export function useAppTitle(title: string | undefined): void {
  const path = useMatch({ strict: false, select: (match) => match.pathname });
  useEffect(() => {
    if (onPhone && title !== undefined) {
      useNamed.setState({ named: { path, title } });
    }
  }, [path, title]);
}

/** Tells the iPhone app; nothing outside it. */
export function tell(message: ToApp): void {
  window.webkit?.messageHandlers?.rufi?.postMessage(message);
}

/**
 * The router's history on a phone: one page at a time, in memory. A tap that
 * would push another page tells the app instead (`go`); the app opens it
 * by `window.rufi.open`, which replaces the page and opens its chat over it
 * or closes it (`chat`). A change within the same page (what it opens, a
 * dialog) stays here.
 */
export function phoneHistory(chat: {
  open: () => boolean;
  show: (open: boolean) => void;
}): RouterHistory {
  const history = createMemoryHistory({
    initialEntries: [location.pathname + location.search],
  });
  history.block({
    enableBeforeUnload: false,
    blockerFn: ({ currentLocation, nextLocation, action }) => {
      if (action !== "PUSH") return false;
      if (nextLocation.pathname === currentLocation.pathname) return false;
      tell({
        type: "go",
        path: nextLocation.pathname + nextLocation.search,
        chat: chat.open(),
      });
      return true;
    },
  });
  window.rufi = {
    open: (path, open = false) => {
      history.replace(path);
      chat.show(open);
    },
    added: (answer) => {
      scanning.added?.(answer);
    },
  };
  return history;
}
