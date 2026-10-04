// Stands in, in the app under test, for what a test can't drive or must not
// open: the Mac's message box (it answers Quit at once) and the browser.
// Each call is printed as one line, for the test to read. Loaded with -r.
import { dialog, shell } from "electron";

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
