// A Rufi window: the screens from the core's own origin, as a browser loads
// them, with nothing of Node or Electron in the page. Every setting that
// guards the page is set here on purpose, not left to Electron's defaults.
import { join } from "node:path";
import { Appearance } from "@rufi/contracts";
import { APPEARANCE_HEADER } from "@rufi/contracts/app";
import { Schema } from "effect";
import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  type Session,
  shell,
} from "electron";

/** Chromium's built-in PDF viewer, which Electron runs as an extension. */
const PDF_VIEWER = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai";

/** What the screens look for to know they are in the app (apps/web main.tsx). */
const MARK = "RufiApp";

/** Writing text to the clipboard, for a page's Copy; reading it stays refused. */
const WRITE_CLIPBOARD = "clipboard-sanitized-write";

/**
 * The window's session: in memory only, so nothing of the page is kept on
 * disk; no permission but writing text to the clipboard, and a user agent
 * with the app's mark. The only
 * download is a file the page itself made (a blob of its own origin, such as
 * the export), saved where the person chooses.
 */
export function lockDown(session: Session): void {
  session.setPermissionRequestHandler((_contents, permission, answer) => {
    answer(permission === WRITE_CLIPBOARD);
  });
  session.setPermissionCheckHandler(
    (_contents, permission) => permission === WRITE_CLIPBOARD,
  );
  session.on("will-download", (event, item, contents) => {
    const url = item.getURL();
    const page = URL.parse(contents.getURL())?.origin;
    if (
      !url.startsWith("blob:") ||
      page === undefined ||
      URL.parse(url.slice("blob:".length))?.origin !== page
    ) {
      event.preventDefault();
      return;
    }
    const window = BrowserWindow.fromWebContents(contents);
    const options = {
      defaultPath: join(app.getPath("downloads"), item.getFilename()),
    };
    const path =
      window === null ? undefined : dialog.showSaveDialogSync(window, options);
    if (path === undefined) item.cancel();
    else item.setSavePath(path);
  });
  session.setUserAgent(`${session.getUserAgent()} ${MARK}`);
}

/**
 * The Mac's appearance of every window (its material, and the system's
 * appearance the page sees) follows the one chosen in Rufi, which the core
 * names on each page and on its settings (APPEARANCE_HEADER). The first page
 * of a window says it before the window shows.
 */
export function followAppearance(session: Session): void {
  const decode = Schema.decodeUnknownOption(Appearance);
  session.webRequest.onHeadersReceived((details, answer) => {
    if (URL.parse(details.url)?.hostname === "127.0.0.1") {
      const named = Object.entries(details.responseHeaders ?? {}).find(
        ([name]) => name.toLowerCase() === APPEARANCE_HEADER,
      )?.[1][0];
      const chosen = decode(named);
      if (chosen._tag === "Some") nativeTheme.themeSource = chosen.value;
    }
    answer({});
  });
}

/**
 * Opens a window on `link` (a launch link, checked by core.ts). `failed`
 * hears when the page can't be loaded or stops working.
 */
export function openWindow(
  link: URL,
  session: Session,
  failed: (title: string, detail: string) => void,
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: "Rufi",
    // The Mac look: the window buttons over the sidebar, the Mac's sidebar
    // material behind it (the screens keep their content opaque).
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: "sidebar",
    // Clear: until the page paints, the window shows that material, in the
    // appearance chosen in Rufi, as the page will be (not a colour of the
    // theme; followAppearance).
    // oxlint-disable-next-line rufi/no-raw-colour
    backgroundColor: "#00000000",
    webPreferences: {
      session,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      // The built-in PDF viewer, for a document's original (no other plugin).
      plugins: true,
      devTools: true,
    },
  });
  const contents = window.webContents;
  const ours = (url: string) => URL.parse(url)?.origin === link.origin;

  // Web links open in the browser, as in the web app; what guards them is
  // the page's own security rules (only Rufi's code runs in it). The window
  // itself never leaves Rufi, and opens no other window.
  //
  // A popup's opener isn't told, so one goes to the browser only while the
  // page has no frame. Rufi has none: its pages refuse to be framed, and its
  // CSP blocks frames from elsewhere, but script can still make a blank or
  // srcdoc frame, which takes the page's CSP.
  contents.setWindowOpenHandler(({ url }) => {
    if (contents.mainFrame.frames.length === 0) toBrowser(url);
    return { action: "deny" };
  });
  // Only Rufi's own pages, in any frame, and the built-in PDF viewer inside
  // a frame (a document's original in its popup). A link away goes to the
  // browser when the page itself follows it, not a frame inside it.
  contents.on("will-frame-navigate", (event) => {
    if (ours(event.url)) return;
    // An extension's address has no origin of its own: compared as text.
    if (!event.isMainFrame && event.url.startsWith(`${PDF_VIEWER}/`)) return;
    event.preventDefault();
    if (
      event.isMainFrame &&
      event.initiator?.frameTreeNodeId === contents.mainFrame.frameTreeNodeId
    ) {
      toBrowser(event.url);
    }
  });
  // A redirect away from Rufi is stopped, and opens nothing.
  contents.on("will-redirect", (event) => {
    if (!ours(event.url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  contents.on(
    "did-fail-load",
    (_event, code, _description, _url, mainFrame) => {
      // -3 is a load that was stopped, such as a navigation refused above.
      if (mainFrame && code !== -3) {
        failed(
          "Rufi's page couldn't be loaded",
          "Quit, then open the app again.",
        );
      }
    },
  );
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") {
      failed("Rufi's page stopped working", "Quit, then open the app again.");
    }
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  // A failed load is told by did-fail-load above.
  window.loadURL(link.href).catch(() => undefined);
  return window;
}

/**
 * Opens a web link in the person's browser. Any other kind, or one that
 * carries a name or password, is dropped.
 */
function toBrowser(url: string): void {
  const link = URL.parse(url);
  if (link?.protocol !== "http:" && link?.protocol !== "https:") return;
  if (link.username !== "" || link.password !== "") return;
  shell.openExternal(url).catch(() => {
    console.error("Rufi couldn't open the link in your browser.");
  });
}
