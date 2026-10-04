// A Rufi window: the screens from the core's own origin, as a browser loads
// them, with nothing of Node or Electron in the page. Every setting that
// guards the page is set here on purpose, not left to Electron's defaults.
import { BrowserWindow, type InputEvent, type Session, shell } from "electron";

/** What the screens look for to know they are in the app (apps/web main.tsx). */
const MARK = "RufiApp";

/**
 * The window's session: in memory only, so nothing of the page is kept on
 * disk; no permission, no download, and a user agent with the app's mark.
 */
export function lockDown(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, answer) => {
    answer(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.on("will-download", (event) => {
    event.preventDefault();
  });
  session.setUserAgent(`${session.getUserAgent()} ${MARK}`);
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
      devTools: true,
    },
  });
  const contents = window.webContents;
  const ours = (url: string) => URL.parse(url)?.origin === link.origin;

  // When the person last clicked or pressed Return in the window. These come
  // from the Mac, not from the page, so a page's script can't make one.
  let pressed = Number.NEGATIVE_INFINITY;
  contents.on("input-event", (_event, input) => {
    if (input.type === "mouseUp" || isReturn(input)) pressed = Date.now();
  });
  /** A link is the person's when they clicked or pressed Return just now. */
  const theirs = () => Date.now() - pressed < PRESS_MS;

  // No other window, ever; a link the person opens in one goes to the browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (theirs()) toBrowser(url);
    return { action: "deny" };
  });
  // Only Rufi's own pages, and no frames: Rufi has none. A link to elsewhere
  // that the person follows goes to the browser; the page alone goes nowhere.
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame && ours(event.url)) return;
    event.preventDefault();
    if (event.isMainFrame && theirs()) toBrowser(event.url);
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
 * How soon after the person's click or Return a link counts as theirs. A
 * link's click becomes a navigation within milliseconds.
 */
const PRESS_MS = 1_000;

/**
 * Return pressed. A key's input event carries `key` as the DOM names it,
 * though Electron's types leave it out.
 */
function isReturn(input: InputEvent): boolean {
  return (
    (input.type === "rawKeyDown" || input.type === "keyDown") &&
    "key" in input &&
    input.key === "Enter"
  );
}

/** Opens a web link in the person's browser; any other kind is dropped. */
function toBrowser(url: string): void {
  const protocol = URL.parse(url)?.protocol;
  if (protocol !== "http:" && protocol !== "https:") return;
  shell.openExternal(url).catch(() => {
    console.error("Rufi couldn't open the link in your browser.");
  });
}
