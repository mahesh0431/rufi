// One temporary folder for a whole test run (Vitest's and Playwright's
// global setup): every test's temporary files, and those of the processes it
// starts, go inside it through TMPDIR, and the run removes it at the end. A
// run never leaves folders behind in the Mac's temporary folder.
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const folder = mkdtempSync(join(tmpdir(), "rufi-test-"));
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
