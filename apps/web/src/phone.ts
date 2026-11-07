// Phone mode: the screens inside Rufi's iPhone app (apps/ios). The app marks
// the page before it loads (<html data-place="phone">, with the iPhone's
// body text size and how much its bars cover as CSS values), and draws its
// own sidebar, title bar and Back. Here the page keeps its content and, on
// the pages where you read your health, the chat bar; every move to another
// page goes through the app, which opens it on top or switches place. The
// app talks back by `window.rufi.open(path)`, by `window.rufi.added(answer)`
// after it added files from its box, and by `window.rufi.reconnect()` when it
// reached Rufi again.
import {
  createMemoryHistory,
  useMatch,
  type RouterHistory,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { create } from "zustand/react";
import { checkNow } from "./api.ts";

/** Whether the screens run in Rufi's iPhone app. */
export const onPhone = document.documentElement.dataset["place"] === "phone";

/** What the screens tell the iPhone app. */
export type ToApp =
  /**
   * The person tapped a link to another page: the app opens it. `chat`:
   * they tapped it in the chat open over the page, which Back opens again.
   */
  | { type: "go"; path: string; chat: boolean }
  /**
   * A page has drawn: the app's bar takes its title, and the app shows the
   * chat's box it has (`box`): the chat page's, a reading page's (a tap
   * opens the panel), or none.
   */
  | { type: "page"; path: string; title: string; box: "page" | "bar" | null }
  /** The chat's box as it is now, for the app's own box (phone-box.tsx). */
  | ({ type: "box" } & BoxView)
  /** The session has ended: the app opens Rufi again, or says it's unpaired. */
  | { type: "ended" }
  /**
   * Whether Rufi can be reached now: the app shows its own line and asks
   * again; the page draws none.
   */
  | { type: "connection"; reachable: boolean }
  /**
   * Doses, medicines or the reminder setting may have changed: the app
   * refreshes its reminders.
   */
  | { type: "refresh" }

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
  onAccent: "--on-accent",
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
      box: (command: BoxCommand) => void;
      reconnect: () => void;
    };
  }
}

/** Who takes the app's answer to what it added from its box (`onAdded`). */
const scanning: { added: ((answer: unknown) => void) | null } = { added: null };

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

/** A chip in the box, for the app. */
interface BoxChipView {
  key: string;
  /** Its name; empty while it is being added. */
  label: string;
  kind: "document" | "record" | "other";
}

/**
 * The chat's box, for the app's own: what it shows, and what each control
 * offers. `text` comes only when the page changed it (the draft read, Ask
 * Rufi's words, a send that cleared it), never for what the app typed.
 */
export interface BoxView {
  text?: string;
  placeholder: string;
  chips: BoxChipView[];
  /** The box takes typing: its draft is read, and no send is on its way. */
  ready: boolean;
  /** The round button, and whether it does anything now. */
  button: "send" | "stop" | "steer" | "queue";
  canSend: boolean;
  model: { id: string; name: string };
  effort: { id: string; name: string };
  models: { id: string; name: string; available: boolean }[];
  /** For a provider that isn't signed in: where to sign in. */
  signIn: string[];
  efforts: { id: string; name: string }[];
  effortWords: string;
  /** How much of the AI's memory the chat uses, once known. */
  meter: { used: number; words: string } | null;
  /** Why the box can't keep, send or add, or that its draft isn't saved. */
  line: string | null;
  /** The line is "Not saved": Retry saves again. */
  retry: boolean;
  /** Why nothing can be added now; null when it can. */
  closed: string | null;
  /** Counts the adds from the pages: each one lights the box. */
  asked: number;
  /** The panel is open over the page. */
  panel: boolean;
}

/** What the app's box asks of the page. */
export type BoxCommand =
  | { type: "text"; text: string }
  | { type: "send" }
  | { type: "stop" }
  | { type: "remove"; key: string }
  | { type: "model"; id: string }
  | { type: "effort"; id: string }
  | { type: "retry" }
  | { type: "open" };

/** Who acts on the app's box now; one at a time. */
const boxed: { on: ((command: BoxCommand) => void) | null } = { on: null };

/** Acts on what the app's box asks, until the returned function. */
export function onBox(act: (command: BoxCommand) => void): () => void {
  boxed.on = act;
  return () => {
    if (boxed.on === act) boxed.on = null;
  };
}

/** Takes what the app adds from its box (Photos, Files, Camera), until the returned function. */
export function onAdded(added: (answer: unknown) => void): () => void {
  scanning.added = added;
  return () => {
    if (scanning.added === added) scanning.added = null;
  };
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
    box: (command) => {
      boxed.on?.(command);
    },
    // The app reached Rufi: the page asks now, and reads again.
    reconnect: checkNow,
  };
  return history;
}
