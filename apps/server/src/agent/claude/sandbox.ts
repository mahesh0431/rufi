// Rufi AI's lock-down on Claude, as the `rufi-ai` permission profile is on
// Codex (ADR 0016): the AI's file tools write only in its folder, and its
// commands there and in the temp folders; both read anything but Rufi's
// unreadable paths (the record's database, its backups, the core's secret),
// and its commands reach the internet. Claude's sandbox holds its commands;
// its permission rules hold its own file tools, which the sandbox doesn't
// cover. Nothing waits for an approval: what the rules don't allow is
// refused (`dontAsk`), and no command can leave the sandbox.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Settings } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSandbox } from "../runtime.ts";

/**
 * A path in a Claude permission rule, which is a gitignore pattern: `//`
 * starts an absolute one, and `*`, `?`, `[`, `]` and `\` are escaped so that
 * a folder named, say, `Health [Asha]` stands for itself.
 */
const rulePath = (path: string) => `/${path.replace(/[\\*?[\]]/g, "\\$&")}`;

/** The tools Rufi AI uses without asking, beside writing in its folder. */
const ALLOWED = [
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "WebFetch",
  "WebSearch",
  "Skill",
];

export interface ClaudeLockDown {
  permissionMode: NonNullable<Options["permissionMode"]>;
  settings: Pick<Settings, "sandbox" | "permissions">;
  /**
   * For the AI's commands: their caches in its folder (on macOS, pip's and
   * matplotlib's own are in HOME, which they can't write).
   */
  env: Record<string, string>;
}

/**
 * `skills` is Rufi's plugin: the AI reads it but never changes it, also when
 * Rufi's home is itself in a temp folder, as a test's is.
 */
export function claudeLockDown(
  sandbox: AgentSandbox,
  skills: string,
): ClaudeLockDown {
  const cache = join(sandbox.folder, ".cache");
  return {
    permissionMode: "dontAsk",
    settings: {
      sandbox: {
        enabled: true,
        // No sandbox on this Mac means no Claude, never an unguarded one.
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: {
          // Programs write temp files, often in /tmp whatever TMPDIR says.
          // Claude's sandbox ignores /tmp itself (2.1.312), a link on macOS,
          // and takes its real path.
          allowWrite: [sandbox.folder, realpathSync("/tmp"), tmpdir()],
          denyRead: [...sandbox.unreadable],
          denyWrite: [...sandbox.unreadable, skills],
        },
        // The AI researches and installs what its programs need.
        network: { allowedDomains: ["*"] },
      },
      permissions: {
        allow: [...ALLOWED, `Edit(${rulePath(sandbox.folder)}/**)`],
        // A path and, if it's a folder, everything in it.
        deny: sandbox.unreadable.flatMap((path) => [
          `Read(${rulePath(path)})`,
          `Read(${rulePath(path)}/**)`,
        ]),
      },
    },
    env: {
      XDG_CACHE_HOME: cache,
      PIP_CACHE_DIR: join(cache, "pip"),
      MPLCONFIGDIR: join(cache, "matplotlib"),
    },
  };
}
