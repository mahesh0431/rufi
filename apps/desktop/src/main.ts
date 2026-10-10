// The Rufi app: Mac windows around Rufi's screens, the core as a child
// process (core.ts), and follow-up notices (notices.ts). It holds no Rufi
// logic and imports neither the core's nor the screens' code. ⌘W closes a
// window and Rufi keeps running; ⌘Q stops what the app started. `pnpm
// desktop` starts it (scripts/desktop.ts).
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  session as sessions,
} from "electron";
import type { PersonNotices } from "@rufi/contracts/app";
import { core, CoreError } from "./core.ts";
import { noticeText, noticeTimer } from "./notices.ts";
import { followAppearance, lockDown, openWindow } from "./window.ts";

const ICON = fileURLToPath(new URL("../assets/rufi-mark.png", import.meta.url));

// Chromium's own files, before anything else can make them in the default
// place. One folder per data folder, so one app runs per data folder; the
// pages keep nothing there (their session is in memory).
const home = resolve(process.env["RUFI_HOME"]?.trim() ?? "");
const profile = createHash("sha256").update(home).digest("hex").slice(0, 16);
app.setPath("userData", join(tmpdir(), `rufi-app-${profile}`));
app.setName("Rufi");

// The pinned Node that runs `pnpm desktop`; Electron's own isn't Rufi's.
const node = app.commandLine.getSwitchValue("rufi-node");

const rufi = core(node, {
  // Its notices, as soon as it is ready: those due while Rufi wasn't running.
  onOwned: () => {
    notices.check();
  },
  onLost: () => {
    fail(
      "Rufi stopped",
      "The Rufi that this app started has stopped. Open the app again to start it.",
    );
  },
});

const notices = noticeTimer({
  claim: rufi.notices,
  tell,
  failed: (error) => {
    // Asked again at the next check; Rufi shows the follow-ups meanwhile.
    console.warn(
      `Rufi couldn't check follow-ups: ${error instanceof CoreError ? error.message : "something went wrong."}`,
    );
  },
});
/** The notices shown, kept until clicked or closed, so a click still reaches them. */
const shown = new Set<Notification>();

let quitting = false;
let failing = false;
let opening: Promise<void> | undefined;

if (!app.requestSingleInstanceLock()) {
  // An app already runs with this data folder: it shows its window.
  app.quit();
} else {
  app.on("second-instance", show);
  app.on("activate", show);
  // ⌘W closes the window; Rufi keeps running until ⌘Q.
  app.on("window-all-closed", () => undefined);
  // ⌘Q, the menu, Ctrl-C and SIGTERM: Rufi stops first, then the app quits.
  // It closes the windows without asking them, so no page can keep the app
  // open once Rufi has stopped.
  app.on("before-quit", (event) => {
    quitting = true;
    event.preventDefault();
    void rufi.stop().then(() => {
      app.exit(0);
    });
  });
  process.on("SIGINT", () => {
    app.quit();
  });
  process.on("SIGTERM", () => {
    app.quit();
  });
  void app.whenReady().then(() => {
    // The system's, until Rufi's first page names the chosen one.
    nativeTheme.themeSource = "system";
    app.dock?.setIcon(ICON);
    Menu.setApplicationMenu(menu());
    lockDown(sessions.fromPartition("rufi"));
    followAppearance(sessions.fromPartition("rufi"));
    powerMonitor.on("resume", notices.check);
    show();
  });
}

/**
 * One neutral Mac notice for a person: counts only, no name or title. Its
 * click opens that person's Follow-ups.
 */
function tell(person: PersonNotices): void {
  if (!Notification.isSupported()) return;
  const notice = new Notification({ title: "Rufi", body: noticeText(person) });
  shown.add(notice);
  notice.on("click", () => {
    shown.delete(notice);
    showFollowUps(person.personId);
  });
  notice.on("close", () => {
    shown.delete(notice);
  });
  notice.show();
}

/** Brings Rufi's window to the front on a person's Follow-ups, or opens one there. */
function showFollowUps(personId: string): void {
  if (!app.isReady() || quitting || failing) return;
  const path = `/people/${encodeURIComponent(personId)}/follow-ups`;
  const open = BrowserWindow.getAllWindows()[0];
  if (open === undefined) {
    opening ??= newWindow(path).finally(() => {
      opening = undefined;
    });
    return;
  }
  if (open.isMinimized()) open.restore();
  open.focus();
  // The same origin, so the window keeps its session.
  const at = URL.parse(open.webContents.getURL());
  if (at?.protocol === "http:" && at.hostname === "127.0.0.1") {
    // A failed load is told by the window's did-fail-load.
    open.webContents
      .loadURL(new URL(path, at.origin).href)
      .catch(() => undefined);
  }
}

/** Brings Rufi's window to the front, or opens one when there is none. */
function show(): void {
  if (!app.isReady() || quitting || failing) return;
  const open = BrowserWindow.getAllWindows()[0];
  if (open !== undefined) {
    if (open.isMinimized()) open.restore();
    open.focus();
    return;
  }
  opening ??= newWindow().finally(() => {
    opening = undefined;
  });
}

/** A new window on a fresh link, at `path` of Rufi's screens. */
async function newWindow(path = "/"): Promise<void> {
  if (node === "") {
    fail("Rufi couldn't start", "Open the app with pnpm desktop.");
    return;
  }
  try {
    const link = await rufi.link();
    if (quitting || failing) return;
    // The page keeps the path when it takes the link's token.
    link.pathname = path;
    openWindow(link, sessions.fromPartition("rufi"), fail);
  } catch (error) {
    fail(
      "Rufi couldn't start",
      error instanceof CoreError ? error.message : "Something went wrong.",
    );
  }
}

/**
 * Says what went wrong in a Mac message, with Quit; the windows close
 * first, so none is left blank.
 */
function fail(title: string, detail: string): void {
  if (quitting || failing) return;
  failing = true;
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  void dialog
    .showMessageBox({
      type: "error",
      message: title,
      detail,
      buttons: ["Quit"],
    })
    .finally(() => {
      app.quit();
    });
}

function menu(): Menu {
  return Menu.buildFromTemplate([
    { role: "appMenu" },
    // ⌘W closes the window; Rufi keeps running.
    { label: "File", submenu: [{ role: "close" }] },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }],
    },
    { role: "windowMenu" },
  ]);
}
