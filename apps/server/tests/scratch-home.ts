// Every test runs with a scratch Mac home folder, so nothing a test starts
// (in this process or a child) can find, make or move the person's real data
// folder in ~/.rufi. Node's homedir() reads HOME.
import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

process.env["HOME"] = mkdtempSync(join(realpathSync(tmpdir()), "rufi-user-"));
if (!homedir().startsWith(realpathSync(tmpdir()))) {
  throw new Error("The tests' home folder isn't a scratch folder.");
}
