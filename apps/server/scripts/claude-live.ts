// Checks the Claude installed on this Mac against what Rufi's Claude code
// relies on, with fictional data. It isn't part of `pnpm check`: CI has no
// Claude, and the installed Claude updates itself, so a change in it shows
// only here. Run it after changing src/agent/claude/ and after Claude
// updates: `pnpm claude:live`. It sends a few short messages on the Mac's
// own Claude sign-in.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeSignIn,
  findClaude,
  type InstalledClaude,
} from "../src/agent/claude/executable.ts";
import { childEnvironment } from "../src/platform/config.ts";

interface Context {
  claude: InstalledClaude;
  /** A fresh, empty folder for this run. */
  folder: string;
  env: Record<string, string>;
}

/** Each case says what it saw, or throws what went wrong. */
const CASES: Record<string, (context: Context) => Promise<string>> = {
  "Claude is signed in": async ({ claude, folder, env }) => {
    const kind = await claudeSignIn(claude, { cwd: folder, env });
    if (kind === "none") throw new Error("Claude isn't signed in.");
    return kind;
  },
};

const claude = await findClaude();
console.log(`Claude ${claude.version} at ${claude.path}`);
const folder = await mkdtemp(join(tmpdir(), "rufi-claude-live-"));
let failed = 0;
for (const [name, run] of Object.entries(CASES)) {
  try {
    console.log(
      `pass  ${name}: ${await run({ claude, folder, env: childEnvironment() })}`,
    );
  } catch (error) {
    failed++;
    console.log(
      `FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
process.exitCode = failed === 0 ? 0 : 1;
