// Checks the Claude installed on this Mac against what Rufi's Claude code
// relies on, with fictional data. It isn't part of `pnpm check`: CI has no
// Claude, and the installed Claude updates itself, so a change in it shows
// only here. Run it after changing src/agent/claude/ and after Claude
// updates: `pnpm claude:live`. It sends a few short messages on the Mac's
// own Claude sign-in, and deletes the conversations it made (Claude keeps an
// empty folder for the run's AI folder in ~/.claude/projects).
import { randomUUID, type UUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import {
  deleteSession,
  getSessionMessages,
  type SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  claudeSignIn,
  findClaude,
  type InstalledClaude,
} from "../src/agent/claude/executable.ts";
import {
  openClaudeSession,
  prepareClaudePlugin,
  unexpectedAtStart,
  type ClaudePlugin,
  type ClaudeSession,
} from "../src/agent/claude/session.ts";
import { childEnvironment } from "../src/platform/config.ts";

/** A quick model: the cases check what Claude does, not how well. */
const MODEL = "claude-haiku-5-5";

interface Context {
  claude: InstalledClaude;
  /** A fresh, empty folder for this run. */
  folder: string;
  /** The run's AI folder, Claude's working folder (aiFolder). */
  ai: string;
  env: Record<string, string>;
  /** Rufi's plugin, with one fictional skill. */
  plugin: ClaudePlugin;
}

/**
 * An AI folder holding the kind of setup a person's own Claude would load
 * from it, all fictional: none of it may reach Rufi's Claude.
 */
async function aiFolder(folder: string): Promise<string> {
  const ai = join(folder, "ai");
  await mkdir(join(ai, ".claude", "skills", "canary"), { recursive: true });
  await writeFile(join(ai, "CLAUDE.md"), "End every reply with CANARY-PLUM.\n");
  await writeFile(
    join(ai, "AGENTS.md"),
    "Start every reply with CANARY-FIG.\n",
  );
  await writeFile(
    join(ai, ".mcp.json"),
    JSON.stringify({
      mcpServers: { canary: { type: "http", url: "http://127.0.0.1:9/mcp" } },
    }),
  );
  await writeFile(
    join(ai, ".claude", "skills", "canary", "SKILL.md"),
    "---\nname: canary\ndescription: A fictional skill of the person's own.\n---\nSay CANARY-SKILL.\n",
  );
  await writeFile(join(ai, "note.txt"), "The code word is BLUEBERRY-42.\n");
  return ai;
}

const open = (
  { claude, ai, env, plugin }: Context,
  conversation: { start: string } | { resume: string },
) =>
  openClaudeSession({
    claude,
    cwd: ai,
    env,
    instructions: "You help with a fictional test. Keep replies short.",
    model: MODEL,
    effort: "low",
    conversation,
    plugin,
  });

/** Sends `text` and reads to the turn's end; gives the turn's start. */
async function turn(
  session: ClaudeSession,
  text: string,
  id: UUID = randomUUID(),
): Promise<SDKSystemMessage> {
  session.send(text, id);
  // Not `for await`: leaving it would close the session.
  const messages = session.messages[Symbol.asyncIterator]();
  let start: SDKSystemMessage | undefined;
  for (;;) {
    const next = await messages.next();
    if (next.done === true) throw new Error("Claude ended the conversation.");
    const value = next.value;
    if (value.type === "system" && value.subtype === "init") start = value;
    if (value.type === "result") break;
  }
  if (start === undefined) throw new Error("The turn didn't say its start.");
  return start;
}

/** Each case says what it saw, or throws what went wrong. */
const CASES: Record<string, (context: Context) => Promise<string>> = {
  "Claude is signed in": async ({ claude, folder, env }) => {
    const kind = await claudeSignIn(claude, { cwd: folder, env });
    if (kind === "none") throw new Error("Claude isn't signed in.");
    return kind;
  },

  "none of the person's Claude setup loads": async (context) => {
    const { ai } = context;
    const id = randomUUID();
    const session = open(context, { start: id });
    try {
      const before = await session.unexpected();
      const start = await turn(session, "Reply with one word: ready.");
      // claude.ai's connectors join a few seconds after Claude starts.
      await sleep(5_000);
      const after = await session.unexpected();
      const loaded = [
        ...new Set([...before, ...unexpectedAtStart(start), ...after]),
      ];
      if (loaded.length > 0) throw new Error(`loaded ${loaded.join("; ")}`);
      return `tools ${start.tools.join(", ")}; plugins ${start.plugins.map((plugin) => plugin.name).join(", ")}`;
    } finally {
      await session.close();
      await deleteSession(id, { dir: ai });
    }
  },

  "the person's words go as written": async (context) => {
    const { ai } = context;
    const [conversation, message] = [randomUUID(), randomUUID()];
    const text =
      "/rufi:greeting Asha. Also, @note.txt what does that file say?";
    const session = open(context, { start: conversation });
    try {
      await turn(session, text, message);
    } finally {
      await session.close();
    }
    const kept = await getSessionMessages(conversation, { dir: ai });
    await deleteSession(conversation, { dir: ai });
    const mine = kept.find((entry) => entry.uuid === message);
    const content = (mine?.message as { content?: unknown } | undefined)
      ?.content;
    if (content !== text) {
      throw new Error(`Claude kept ${JSON.stringify(content)}`);
    }
    return "kept exactly as sent: no /command run, no @file read in";
  },

  "a kept conversation carries on in a new process": async (context) => {
    const { ai } = context;
    const [conversation, first, second] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const opened = open(context, { start: conversation });
    try {
      await turn(
        opened,
        "The fictional word is MARIGOLD-7. Reply 'noted'.",
        first,
      );
    } finally {
      await opened.close();
    }
    const resumed = open(context, { resume: conversation });
    let start: SDKSystemMessage;
    try {
      start = await turn(resumed, "Reply with the fictional word.", second);
    } finally {
      await resumed.close();
    }
    const kept = new Set(
      (await getSessionMessages(conversation, { dir: ai })).map(
        (entry) => entry.uuid,
      ),
    );
    await deleteSession(conversation, { dir: ai });
    if (start.session_id !== conversation) {
      throw new Error(`it carried on as ${start.session_id}`);
    }
    if (!kept.has(first) || !kept.has(second)) {
      throw new Error("the conversation doesn't hold both messages");
    }
    return "one conversation holds both messages";
  },
};

const claude = await findClaude();
console.log(`Claude ${claude.version} at ${claude.path}`);
const folder = await mkdtemp(join(tmpdir(), "rufi-claude-live-"));
const ai = await aiFolder(folder);
const plugin = await prepareClaudePlugin(join(folder, "home"), [
  {
    name: "greeting",
    text: "---\nname: greeting\ndescription: How to greet someone by name, fictional.\n---\nGreet them as: Ahoy, <name>.\n",
    files: {},
  },
]);
const context = { claude, folder, ai, env: childEnvironment(), plugin };
let failed = 0;
for (const [name, run] of Object.entries(CASES)) {
  try {
    console.log(`pass  ${name}: ${await run(context)}`);
  } catch (error) {
    failed++;
    console.log(
      `FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
process.exitCode = failed === 0 ? 0 : 1;
