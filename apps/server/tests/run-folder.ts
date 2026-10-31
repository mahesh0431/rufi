// One temporary folder for a whole test run (Vitest's and Playwright's
// global setup): every test's temporary files, and those of the processes it
// starts, go inside it through TMPDIR, and the run removes it at the end. A
// run never leaves folders behind in the Mac's temporary folder.
//
// On Linux (CI) it isn't in /tmp: Codex lets the AI write there, so a data
// folder in it would be under a folder the AI can write, as a real one never
// is. For each denied path missing there, Codex makes an empty file while a
// command runs and removes it after, and a command starting meanwhile fails
// on it (bwrap: "Can't bind mount … No such file or directory").
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const base = process.platform === "linux" ? "/var/tmp" : tmpdir();
  const folder = mkdtempSync(join(base, "rufi-test-"));
  process.env["TMPDIR"] = folder;
  return () => {
    // Some tests leave a folder read-only, to show nothing is written there.
    for (const entry of readdirSync(folder, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isDirectory())
        chmodSync(join(entry.parentPath, entry.name), 0o700);
    }
    rmSync(folder, { recursive: true, force: true });
  };
}
