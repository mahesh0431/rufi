// Stands in, in the app under test, for what a test can't drive or must not
// open: the Mac's message box (it answers Quit at once), the browser and the
// Mac's notices (kept in `globalThis.notices`, for a test to click). Each
// call is printed as one line, for the test to read. Loaded with -r.
//
// The app's windows load and draw as usual but never show or take the
// focus, so tests never get in the way of the person at the Mac (app.ts runs
// it as a background app, with no icon in the Dock).
import { BrowserWindow, dialog, Notification, shell } from "electron";

for (const method of ["show", "showInactive", "focus", "moveTop"] as const) {
  BrowserWindow.prototype[method] = () => undefined;
}

const told = (kind: string, value: unknown) => {
  console.log(`rufi-test ${kind} ${JSON.stringify(value)}`);
};

dialog.showMessageBox = (...args: unknown[]) => {
  const { message, detail } = args.at(-1) as {
    message: string;
    detail?: string;
  };
  told("dialog", { message, detail });
  return Promise.resolve({ response: 0, checkboxChecked: false });
};
shell.openExternal = (url: string) => {
  told("browser", url);
  return Promise.resolve();
};
// The save dialog: saves in the test's temporary folder, under the name
// Rufi proposed.
dialog.showSaveDialogSync = (...args: unknown[]) => {
  const { defaultPath } = args.at(-1) as { defaultPath?: string };
  const name = (defaultPath ?? "").split("/").at(-1) ?? "";
  const path = `${process.env["TMPDIR"] ?? "/tmp"}/${name}`;
  told("save", { name, path });
  return path;
};
// A notice: shown nowhere, kept for the test.
const notices: Notification[] = [];
(globalThis as { notices?: Notification[] }).notices = notices;
Notification.isSupported = () => true;
Notification.prototype.show = function (this: Notification) {
  told("notice", { title: this.title, body: this.body });
  notices.push(this);
};
