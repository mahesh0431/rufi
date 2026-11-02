// Phone mode: the screens inside Rufi's iPhone app (apps/ios). The app marks
// the page before it loads (<html data-place="phone">, with the iPhone's
// body text size and how much its bars cover as CSS values), and draws its
// own tabs, bars and back. Here the page keeps only its content, and every
// move to another page goes through the app, which pushes it in a tab's
// stack or switches tab. The app talks back by `window.rufi.open(path)`, and
// by `window.rufi.added(answer)` after it uploaded a scan.
import {
  createMemoryHistory,
  type RouterHistory,
} from "@tanstack/react-router";

/** Whether the screens run in Rufi's iPhone app. */
export const onPhone = document.documentElement.dataset["place"] === "phone";

/** What the screens tell the iPhone app. */
export type ToApp =
  /** The person tapped a link to another page: the app opens it. */
  | { type: "go"; path: string }
  /** A page has drawn: the app's bar takes its title. */
  | { type: "page"; path: string; title: string }
  /** The session has ended: the app opens Rufi again, or says it's unpaired. */
  | { type: "ended" }
  /** Scan: the app's document camera, then it adds the pages to the chat. */
  | { type: "scan" }

  /** View original: the app fetches the document's files and shows them. */
  | {
      type: "original";
      documentId: string;
      files: { id: string; name: string }[];
    };

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        rufi?: { postMessage: (message: ToApp) => void };
      };
    };
    rufi?: { open: (path: string) => void; added: (answer: unknown) => void };
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

/** Tells the iPhone app; nothing outside it. */
export function tell(message: ToApp): void {
  window.webkit?.messageHandlers?.rufi?.postMessage(message);
}

/**
 * The router's history on a phone: one page at a time, in memory. A tap that
 * would push another page tells the app instead (`go`); the app opens it,
 * here or in another tab, by `window.rufi.open`, which replaces the page. A
 * change within the same page (what it opens, a dialog) stays here.
 */
export function phoneHistory(): RouterHistory {
  const history = createMemoryHistory({
    initialEntries: [location.pathname + location.search],
  });
  history.block({
    enableBeforeUnload: false,
    blockerFn: ({ currentLocation, nextLocation, action }) => {
      if (action !== "PUSH") return false;
      if (nextLocation.pathname === currentLocation.pathname) return false;
      tell({ type: "go", path: nextLocation.pathname + nextLocation.search });
      return true;
    },
  });
  window.rufi = {
    open: (path) => {
      history.replace(path);
    },
    added: (answer) => {
      scanning.added?.(answer);
    },
  };
  return history;
}
