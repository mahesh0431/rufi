// Checks the Claude installed on this Mac against what Rufi's Claude code
// relies on, with fictional data. It isn't part of `pnpm check`: CI has no
// Claude, and the installed Claude updates itself, so a change in it shows
// only here. Run it after changing src/agent/claude/ and after Claude
// updates: `RUFI_HOME=<test sign-in folder> pnpm claude:live`. It sends a few
// short messages on the test sign-in's Claude folder (RUFI_HOME's
// `claude/`), as Rufi runs Claude, and deletes the conversations it made
// (Claude keeps an empty folder for the run's AI folder in its `projects/`).
import { randomUUID, type UUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import {
  deleteSession,
  getSessionMessages,
  type SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createAgents, type Agents } from "@rufi/agents/agents";
import type {
  Conversation,
  ProviderAdapter,
  ProviderEvent,
} from "@rufi/agents/provider";
import { openAgentStore } from "@rufi/agents/store";
import { claudeAdapter } from "../src/agent/claude/adapter.ts";
import {
  claudeEnvironment,
  claudeFolder,
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
import type { AgentSandbox } from "../src/agent/runtime.ts";
import { callIdOf } from "../src/core/chat/agents.ts";
import type { ChatRow } from "../src/core/chat/transcript.ts";
import type { ToolAnswer, ToolSpec } from "../src/core/tools/registry.ts";
import { agentDoor } from "../src/server/door.ts";
import { mcpEndpoint, mcpKeys, serveMcp } from "../src/server/mcp.ts";
import { backupsPath } from "../src/core/store/backup.ts";
import { childEnvironment, rufiHome } from "../src/platform/config.ts";
import { aiSandbox } from "../src/server/core.ts";
import { caseSandbox, signInsOf } from "./live-run.ts";

/** A quick model: the cases check what Claude does, not how well. */
const MODEL = "claude-haiku-5-5";

interface Context {
  claude: InstalledClaude;
  /** A fresh, empty folder for this run. */
  folder: string;
  /** A fictional Rufi home in it, and Rufi AI's sandbox there. */
  home: string;
  sandbox: AgentSandbox;
  env: Record<string, string>;
  /** Rufi's plugin, with one fictional skill. */
  plugin: ClaudePlugin;
}

/**
 * The AI's folder, holding the kind of setup a person's own Claude would
 * load from it, all fictional: none of it may reach Rufi's Claude.
 */
async function aiFolder(ai: string): Promise<void> {
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
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Claude's inbox for its own session: its socket and token variables. */
const INBOX = "CLAUDE_CODE_MESSAGING";

/** Text in each of Rufi's unreadable files, which must never reach Claude. */
const SECRET = "SECRET-CANARY";

/** A file in Claude's folder, there to be read. */
const claudeFile = (home: string) => join(claudeFolder(home), ".claude.json");

/**
 * A fictional file at each path of the data folder `home` that the AI can't
 * read; the backups and Claude's folder get one inside.
 */
async function unreadableFiles(home: string) {
  for (const path of aiSandbox(home).unreadable) {
    const file =
      path === backupsPath(home)
        ? join(path, "copy.sqlite")
        : path === claudeFolder(home)
          ? claudeFile(home)
          : path;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${SECRET} in ${file}\n`);
  }
}

const open = (
  { claude, sandbox, env, plugin }: Context,
  conversation: { start: string } | { resume: string },
) =>
  openClaudeSession({
    claude,
    sandbox,
    env,
    instructions: "You help with a fictional test. Keep replies short.",
    model: MODEL,
    effort: "low",
    conversation,
    plugin,
  });

/** One turn as Claude reported it: its start, its tool calls and results. */
/** A tool call Claude made, with its result. */
interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Its result's text, and whether Claude marked it an error. */
  result?: { text: string; error: boolean };
}

/** One turn as Claude reported it: its start, and its tool calls. */
interface Turn {
  start: SDKSystemMessage;
  calls: Call[];
}

/**
 * A message's content blocks. Their types come from the Anthropic SDK, which
 * Rufi doesn't install (pnpm-workspace.yaml), so they're read loosely here.
 */
function blocks(message: unknown): {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as []) : [];
}

/** A tool result's content as text: a string, or its text blocks joined. */
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => (part as { text?: unknown }).text)
          .filter((text) => typeof text === "string")
          .join("\n")
      : "";

/**
 * Sends `text` and reads to the turn's end. A turn that ends in error
 * throws: a case on a failed turn proves nothing.
 */
async function turn(
  session: ClaudeSession,
  text: string,
  id: UUID = randomUUID(),
): Promise<Turn> {
  session.send(text, id);
  // Not `for await`: leaving it would close the session.
  const messages = session.messages[Symbol.asyncIterator]();
  let start: SDKSystemMessage | undefined;
  const calls = new Map<string, Call>();
  for (;;) {
    const next = await messages.next();
    if (next.done === true) throw new Error("Claude ended the conversation.");
    const value = next.value;
    if (value.type === "system" && value.subtype === "init") start = value;
    if (value.type === "assistant" || value.type === "user") {
      for (const block of blocks(value.message)) {
        if (block.type === "tool_use" && block.id !== undefined) {
          calls.set(block.id, {
            id: block.id,
            name: block.name ?? "",
            input: block.input ?? {},
          });
        }
        const call = calls.get(block.tool_use_id ?? "");
        if (block.type === "tool_result" && call) {
          call.result = {
            text: textOf(block.content),
            error: block.is_error === true,
          };
        }
      }
    }
    if (value.type === "result") {
      if (value.subtype !== "success" || value.is_error) {
        throw new Error(
          `the turn ended in error: ${value.subtype === "success" ? value.result : value.errors.join("; ")}`,
        );
      }
      break;
    }
  }
  if (start === undefined) throw new Error("The turn didn't say its start.");
  return { start, calls: [...calls.values()] };
}

/** How long a turn through the adapter may take here. */
const TURN_MS = 120_000;

/**
 * Runs `body` with the Claude adapter, a conversation's events, and a way to
 * open one, with Rufi's door giving it no tools; deletes the conversations
 * it opened.
 */
async function withAdapter<T>(
  { claude, sandbox, env, plugin }: Context,
  body: (run: {
    adapter: ProviderAdapter;
    events: ProviderEvent[];
    open: () => Promise<Conversation>;
    until: <F>(pick: (event: ProviderEvent) => F | undefined) => Promise<F>;
    send: (
      conversation: Conversation,
      id: string,
      text: string,
    ) => Promise<string>;
  }) => Promise<T>,
): Promise<T> {
  const adapter = claudeAdapter({
    claude: () => Promise.resolve(claude),
    sandbox,
    env,
    plugin,
  });
  const keys = mcpKeys();
  let port = 0;
  const served = await serveMcp(
    mcpEndpoint({ keys, port: () => port, log: () => undefined }),
  );
  port = served.port;
  const tools = {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    key: keys.issue({
      tools: [],
      call: () => Promise.reject(new Error("No tools here.")),
    }),
  };
  const events: ProviderEvent[] = [];
  const opened: string[] = [];
  const until = async <F>(pick: (event: ProviderEvent) => F | undefined) => {
    const deadline = Date.now() + TURN_MS;
    for (;;) {
      for (const event of events) {
        const found = pick(event);
        if (found !== undefined) return found;
      }
      if (Date.now() > deadline) throw new Error("an event didn't come");
      await sleep(50);
    }
  };
  const open = async () => {
    const conversation = await adapter.open({
      cwd: sandbox.folder,
      instructions: "You help with a fictional test. Keep replies short.",
      model: MODEL,
      effort: "low",
      tools,
      onEvent: (event) => {
        events.push(event);
      },
    });
    opened.push(conversation.ref);
    return conversation;
  };
  /** Starts a turn; its reference, once Claude started it. */
  const send = async (conversation: Conversation, id: string, text: string) => {
    const delivery = await conversation.startTurn({
      input: { id, parts: [text] },
      model: MODEL,
      effort: "low",
    });
    if (delivery.status !== "delivered") {
      throw new Error(`the turn wasn't delivered: ${JSON.stringify(delivery)}`);
    }
    return until((event) =>
      event.type === "turnStarted" && event.inputs.includes(id)
        ? event.turn
        : undefined,
    );
  };
  try {
    return await body({ adapter, events, open, until, send });
  } finally {
    await adapter.close();
    for (const ref of opened) await adapter.delete(ref);
    await served.close();
  }
}

const endOf = (turn: string) => (event: ProviderEvent) =>
  event.type === "turnEnded" && event.turn === turn ? event.end : undefined;

const startedBy = (input: string) => (event: ProviderEvent) =>
  event.type === "turnStarted" && event.inputs.includes(input)
    ? event.turn
    : undefined;

/** The fictional agent of the door's cases, and its one tool. */
const AGENT = "agent-fictional";
const SAVE_NOTE: ToolSpec = {
  name: "save_note",
  description: "Saves one short note to the fictional record.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  readOnly: false,
  destructive: false,
};

/** A note saved through the door: Rufi's id for its call, and its turn. */
interface Save {
  callId: string;
  ref: string;
  text: unknown;
}

/**
 * Runs `body` with Rufi's door (its MCP endpoint and the agent door), the
 * agent package on the Claude adapter with one admitted fictional agent,
 * and a save_note that keeps each call's answer by Rufi's id for it, as
 * Rufi's saves do; deletes the conversations it made.
 */
async function withDoor<T>(
  { claude, folder, sandbox, env, plugin }: Context,
  body: (run: {
    events: ProviderEvent[];
    saves: Save[];
    /** Sends text to the agent; its input's id. */
    send: (kind: "queue" | "steer", text: string) => string;
    until: <F>(pick: (event: ProviderEvent) => F | undefined) => Promise<F>;
  }) => Promise<T>,
): Promise<T> {
  const keys = mcpKeys();
  let port = 0;
  const served = await serveMcp(
    mcpEndpoint({ keys, port: () => port, log: () => undefined }),
  );
  port = served.port;
  const events: ProviderEvent[] = [];
  const saves: Save[] = [];
  const answers = new Map<string, ToolAnswer>();
  const refs: string[] = [];
  const adapter = claudeAdapter({
    claude: () => Promise.resolve(claude),
    sandbox,
    env,
    plugin,
  });
  const store = openAgentStore(join(folder, `agents-${randomUUID()}.sqlite`));
  const door = agentDoor({
    mcp: { url: () => `http://127.0.0.1:${String(port)}/mcp`, keys },
    specs: [SAVE_NOTE],
    place: (agent, meta) => {
      const placed = agents.place(agent, meta);
      // Whose the agent is doesn't matter to a fictional note.
      return Promise.resolve(
        placed && {
          ...placed,
          chat: {} as ChatRow,
          thread: refs.at(-1) ?? "",
          tools: [SAVE_NOTE.name],
        },
      );
    },
    run: (scope, _tool, input) => {
      const kept = answers.get(scope.callId);
      if (kept) return Promise.resolve(kept);
      saves.push({
        callId: scope.callId,
        ref: scope.ref,
        text: (input as { text?: unknown }).text,
      });
      const answer = {
        ok: true,
        text: JSON.stringify({
          ok: true,
          saved: `note-${String(saves.length)}`,
        }),
      };
      answers.set(scope.callId, answer);
      return Promise.resolve(answer);
    },
    log: () => undefined,
  });
  const agents: Agents = createAgents({
    store,
    adapters: [adapter],
    host: {
      opening: () =>
        Promise.resolve({
          instructions: "You help with a fictional test. Keep replies short.",
          tools: door.registration(AGENT, [SAVE_NOTE.name]),
        }),
      ledger: ({ ref }) => {
        refs.push(ref);
        return Promise.resolve();
      },
      claim: () => Promise.resolve(undefined),
    },
    onError: (error) => {
      console.log(`      the package: ${messageOf(error)}`);
    },
    live: (_agent, _ref, event) => {
      events.push(event);
    },
  });
  await agents.dispatch();
  agents.create({
    id: AGENT,
    title: "Fictional",
    provider: "claude",
    model: MODEL,
    effort: "low",
    tools: [SAVE_NOTE.name],
    cwd: sandbox.folder,
  });
  agents.admit(AGENT);
  const until = async <F>(pick: (event: ProviderEvent) => F | undefined) => {
    const deadline = Date.now() + TURN_MS;
    for (;;) {
      for (const event of events) {
        const found = pick(event);
        if (found !== undefined) return found;
      }
      if (Date.now() > deadline) throw new Error("an event didn't come");
      await sleep(50);
    }
  };
  const send = (kind: "queue" | "steer", text: string) => {
    const id = randomUUID();
    agents.send(AGENT, { id, sender: "asha", kind, parts: [text] });
    return id;
  };
  try {
    return await body({ events, saves, send, until });
  } finally {
    await agents.close();
    await adapter.close();
    for (const ref of refs) await adapter.delete(ref);
    store.close();
    await served.close();
  }
}

/**
 * One step of the lock-down canary: the tool and what it's given, and what
 * its own result and the files must then show.
 */
interface Probe {
  tool: "Read" | "Grep" | "Write" | "Bash";
  /** The path it reads or writes, or the command whole. */
  input: string;
  /** Throws what went wrong; gives its result's text. */
  check: (result: { text: string; error: boolean }) => Promise<void> | void;
}

/** A probe's step as the prompt words it. */
function stepOf({ tool, input }: Probe): string {
  switch (tool) {
    case "Read":
      return `Read the file ${input} with the Read tool.`;
    case "Grep":
      return `Search for SECRET in ${input} with the Grep tool.`;
    case "Write":
      return `Write the text hello to ${input} with the Write tool.`;
    case "Bash":
      return `Run this command with the Bash tool: ${input}`;
  }
}

/** What a call was given, as its probe names it. */
const givenOf = (call: Call): unknown =>
  call.input[
    call.name === "Bash"
      ? "command"
      : call.name === "Grep"
        ? "path"
        : "file_path"
  ];

/**
 * Checks each probe on its own call: one given exactly the probe's input
 * (its path, or its command whole), never one an earlier probe took. A probe
 * Claude skipped, merged with another, guarded or changed fails as not
 * tried. Throws every step that failed.
 */
async function checkProbes(probes: readonly Probe[], calls: readonly Call[]) {
  const used = new Set<string>();
  const failed: string[] = [];
  for (const [index, probe] of probes.entries()) {
    const step = `step ${String(index + 1)}`;
    const free = calls.filter(
      (each) =>
        each.name === probe.tool &&
        !used.has(each.id) &&
        typeof givenOf(each) === "string",
    );
    const call = free.find(
      (each) => String(givenOf(each)).trim() === probe.input,
    );
    if (call?.result === undefined) {
      const others = free
        .slice(0, 3)
        .map((each) => JSON.stringify(givenOf(each)).slice(0, 120));
      failed.push(
        `${step} wasn't tried on a call of its own (${probe.tool} calls left: ${others.join(", ") || "none"})`,
      );
      continue;
    }
    used.add(call.id);
    try {
      await probe.check(call.result);
    } catch (error) {
      failed.push(`${step}: ${messageOf(error)}`);
    }
  }
  if (failed.length > 0) throw new Error(failed.join("; "));
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Each case says what it saw, or throws what went wrong. */
const CASES: Record<string, (context: Context) => Promise<string>> = {
  "Claude is signed in": async ({ claude, folder, env }) => {
    const kind = await claudeSignIn(claude, { cwd: folder, env });
    if (kind === "none") throw new Error("Claude isn't signed in.");
    return kind;
  },

  "none of the person's Claude setup loads": async (context) => {
    const ai = context.sandbox.folder;
    const id = randomUUID();
    const session = open(context, { start: id });
    try {
      const before = await session.unexpected();
      const { start } = await turn(session, "Reply with one word: ready.");
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
    const ai = context.sandbox.folder;
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
    const ai = context.sandbox.folder;
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
      ({ start } = await turn(
        resumed,
        "Reply with the fictional word.",
        second,
      ));
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

  "the AI's commands and file tools keep to its folder": async (context) => {
    const { home, sandbox, plugin } = context;
    const [database, wal, backups, core] = sandbox.unreadable.filter(
      (path) => !path.endsWith("-shm") && !path.endsWith("-journal"),
    ) as [string, string, string, string];
    const ai = sandbox.folder;
    // This run's home is in a temp folder, where commands may write; this
    // checkout isn't.
    const outside = join(import.meta.dirname, `outside-${randomUUID()}.txt`);
    // Claude guards a plugin it loaded by itself (2.1.312), so this holds
    // without Rufi's deny too; the deny stays in case that changes.
    const skill = join(plugin.path, "skills", "greeting", "SKILL.md");
    const before = {
      database: await readFile(database, "utf8"),
      skill: await readFile(skill, "utf8"),
    };
    /** A forbidden read: refused, and none of the file's text came back. */
    const refusedRead = ({ text, error }: { text: string; error: boolean }) => {
      if (text.includes(SECRET)) throw new Error("it read the file");
      if (!error) throw new Error("it wasn't refused");
    };
    /**
     * A forbidden write: refused by the sandbox (a command's own error for
     * that file) or by the permission rules (the Write tool), and `path` is
     * as it was.
     */
    const refusedWrite =
      (by: "sandbox" | "rules", path: string, was?: string) =>
      async ({ text, error }: { text: string; error: boolean }) => {
        const refused =
          by === "sandbox"
            ? text.toLowerCase().includes("operation not permitted") &&
              text.includes(path)
            : text.includes("Permission to use Write has been denied");
        if (!error || !refused) {
          throw new Error(`it wasn't refused by the ${by}: ${text}`);
        }
        const now = await readFile(path, "utf8").catch(() => undefined);
        if (now !== was) throw new Error(`it changed ${path}`);
      };
    const wrote = (path: string) => async () => {
      if (!(await exists(path))) throw new Error(`it couldn't write ${path}`);
    };
    const said =
      (...texts: string[]) =>
      ({ text }: { text: string }) => {
        const missing = texts.filter((each) => !text.includes(each));
        if (missing.length > 0) throw new Error(`no ${missing.join(", ")}`);
      };
    let names: string[] = [];
    const probes: Probe[] = [
      // Read refuses a .sqlite file as binary by itself: core.json tests
      // Rufi's rule.
      { tool: "Read", input: core, check: refusedRead },
      { tool: "Bash", input: `cat '${wal}'`, check: refusedRead },
      { tool: "Grep", input: backups, check: refusedRead },
      { tool: "Bash", input: `cat '${database}'`, check: refusedRead },
      // Codex's sign-in and Claude's folder.
      {
        tool: "Bash",
        input: `cat '${join(home, "codex", "auth.json")}'`,
        check: refusedRead,
      },
      { tool: "Read", input: claudeFile(home), check: refusedRead },
      {
        tool: "Bash",
        input: `cat '${claudeFile(home)}'`,
        check: refusedRead,
      },
      {
        tool: "Write",
        input: `${ai}/inside.txt`,
        check: wrote(`${ai}/inside.txt`),
      },
      {
        tool: "Bash",
        input: `echo hello > '${ai}/inside-command.txt'`,
        check: wrote(`${ai}/inside-command.txt`),
      },
      {
        tool: "Write",
        input: `${home}/outside.txt`,
        check: refusedWrite("rules", `${home}/outside.txt`),
      },
      {
        tool: "Bash",
        input: `echo hello > '${outside}'`,
        check: refusedWrite("sandbox", outside),
      },
      {
        tool: "Bash",
        input: `echo hello >> '${database}'`,
        check: refusedWrite("sandbox", database, before.database),
      },
      {
        tool: "Bash",
        input: `echo hello >> '${skill}'`,
        check: refusedWrite("sandbox", skill, before.skill),
      },
      {
        tool: "Bash",
        input:
          "curl -sS -o /dev/null -w 'status %{http_code}' https://example.com",
        check: said("status 200"),
      },
      {
        tool: "Bash",
        input:
          'f=$(mktemp) && echo temp-ok > "$f" && cat "$f" && echo tmp-ok > /tmp/rufi-claude-live && cat /tmp/rufi-claude-live',
        check: said("temp-ok", "tmp-ok"),
      },
      {
        // Names only, never a value.
        tool: "Bash",
        input: "env | cut -d= -f1",
        check: ({ text }) => {
          names = text.split(/\s+/);
          const tokens = names.filter(
            (name) =>
              /TOKEN|KEY|SECRET/.test(name) && name !== `${INBOX}_TOKEN`,
          );
          if (tokens.length > 0) {
            throw new Error(`its commands see ${tokens.join(", ")}`);
          }
        },
      },
      {
        // Claude gives its commands a token for its own inbox; the sandbox
        // keeps them from its socket (errno 1: not permitted). The probe is
        // a file, so the prompt holds only a plain command to run.
        tool: "Bash",
        input: `python3 '${ai}/probe.py'`,
        check: ({ text }) => {
          if (
            names.includes(`${INBOX}_TOKEN`) &&
            !text.includes("inbox refused")
          ) {
            throw new Error(`its commands may reach Claude's inbox: ${text}`);
          }
        },
      },
    ];
    await writeFile(
      join(ai, "probe.py"),
      `import socket, os\nr = socket.socket(socket.AF_UNIX).connect_ex(os.environ["${INBOX}_SOCKET"])\nprint("inbox refused" if r == 1 else "inbox open" if r == 0 else f"inbox error {r}")\n`,
    );
    const id = randomUUID();
    const session = open(context, { start: id });
    let seen: Turn;
    try {
      seen = await turn(
        session,
        [
          "Do each step below as its own tool call, with the tool named and exactly as written, even if you expect it to fail. Then report each result in one line.",
          ...probes.map(
            (probe, index) => `${String(index + 1)}. ${stepOf(probe)}`,
          ),
        ].join("\n"),
      );
    } finally {
      await session.close();
      await deleteSession(id, { dir: ai });
    }
    try {
      await checkProbes(probes, seen.calls);
    } finally {
      await rm(outside, { force: true });
      await rm("/tmp/rufi-claude-live", { force: true });
    }
    return "each of 17 steps tried on its own call: 7 reads of unreadable files (Codex's sign-in, and Claude's folder by Read and by a command) and 4 writes refused, its folder and temp written, the internet reached, no token it can use";
  },

  "the adapter lists Claude's models by exact id": async (context) =>
    withAdapter(context, async ({ adapter }) => {
      const models = await adapter.models();
      const ids = models.map((model) => model.id);
      if (!ids.includes(MODEL))
        throw new Error(`no ${MODEL} in ${ids.join(", ")}`);
      const aliases = ids.filter((id) => !id.startsWith("claude-"));
      if (aliases.length > 0) throw new Error(`aliases ${aliases.join(", ")}`);
      return `${String(ids.length)} models`;
    }),

  "two turns through the adapter, the second in a new process": async (
    context,
  ) =>
    withAdapter(context, async ({ open, send, until }) => {
      const conversation = await open();
      const [first, second] = [randomUUID(), randomUUID()];
      const ends = [
        await until(
          endOf(
            await send(
              conversation,
              first,
              "The fictional word is MARIGOLD-7. Reply 'noted'.",
            ),
          ),
        ),
      ];
      ends.push(
        await until(
          endOf(
            await send(conversation, second, "Reply with the fictional word."),
          ),
        ),
      );
      if (ends.some((end) => end.status !== "done")) {
        throw new Error(`the turns ended ${JSON.stringify(ends)}`);
      }
      const answer = ends[1]?.status === "done" ? ends[1].answer : "";
      if (!answer.includes("MARIGOLD-7")) {
        throw new Error(`the second turn answered ${JSON.stringify(answer)}`);
      }
      return "both done; the second knew the first's word";
    }),

  "a steer at the turn's end starts a turn of Claude's own, shown with it":
    async (context) =>
      withAdapter(context, async ({ open, send, until, events }) => {
        const conversation = await open();
        const turn = await send(
          conversation,
          randomUUID(),
          "Write 12 short numbered lines about a fictional morning walk.",
        );
        const steer = randomUUID();
        // A reply with no tools has no point to fold a steer into, so Claude
        // holds it to the turn's end, and begins a turn of its own with it.
        const outcome = await conversation.steer({
          input: { id: steer, parts: ["Add a last line that says PINEAPPLE."] },
          turn,
        });
        if (outcome.status !== "delivered") {
          throw new Error(`the steer came back ${JSON.stringify(outcome)}`);
        }
        const own = await until(startedBy(steer));
        const ends = [await until(endOf(turn)), await until(endOf(own))];
        if (
          events.findIndex(endOf(turn)) > events.findIndex(startedBy(steer))
        ) {
          throw new Error("its turn started before the first ended");
        }
        if (ends.some((end) => end.status !== "done")) {
          throw new Error(`the turns ended ${JSON.stringify(ends)}`);
        }
        return "the steer's turn started after the first ended, named in its start";
      }),

  "a conversation Claude no longer keeps is missing at the next start": async (
    context,
  ) =>
    withAdapter(context, async ({ adapter, open, send, until }) => {
      const conversation = await open();
      const turn = await send(conversation, randomUUID(), "Reply 'noted'.");
      await until(endOf(turn));
      await adapter.delete(conversation.ref);
      const delivery = await conversation.startTurn({
        input: { id: randomUUID(), parts: ["Reply 'again'."] },
        model: MODEL,
        effort: "low",
      });
      if (
        delivery.status !== "not_delivered" ||
        delivery.reason !== "missing"
      ) {
        throw new Error(`the start came back ${JSON.stringify(delivery)}`);
      }
      return "not delivered: missing";
    }),

  "Stop ends the turn and Claude's process; a steer Claude held shows stopped":
    async (context) =>
      withAdapter(context, async ({ open, send, until, events }) => {
        const conversation = await open();
        const turn = await send(
          conversation,
          randomUUID(),
          "Run this Bash command: sleep 30. Then reply 'done'.",
        );
        // The command is running; a steer joins only after it ends.
        await sleep(8_000);
        const steer = randomUUID();
        await conversation.steer({
          input: { id: steer, parts: ["Reply 'steered'."] },
          turn,
        });
        await sleep(1_000);
        await conversation.stop(turn);
        const ends = [
          await until(endOf(turn)),
          await until(endOf(await until(startedBy(steer)))),
        ];
        if (ends.some((end) => end.status !== "stopped")) {
          throw new Error(`the turns ended ${JSON.stringify(ends)}`);
        }
        // Nothing of Claude's runs on.
        const seen = events.length;
        await sleep(5_000);
        if (events.length !== seen) {
          throw new Error(`more came: ${JSON.stringify(events.slice(seen))}`);
        }
        return "the turn and the steer's both stopped, and nothing came after";
      }),

  "a call to Rufi's tools goes through the door, in its turn, by Rufi's id for it":
    async (context) =>
      withDoor(context, async ({ events, saves, send, until }) => {
        const turn = await until(
          startedBy(
            send(
              "queue",
              "Use the save_note tool once to save the note 'Fictional: Asha walked 3 km.' Then reply 'done'.",
            ),
          ),
        );
        const end = await until(endOf(turn));
        if (end.status !== "done") {
          throw new Error(`the turn ended ${JSON.stringify(end)}`);
        }
        const step = events.findLast(
          (event) => event.type === "step" && event.title === "rufi.save_note",
        );
        const [save, ...more] = saves;
        if (step?.type !== "step" || step.status !== "done" || !save) {
          throw new Error(`the call was ${JSON.stringify(step)}`);
        }
        if (more.length > 0)
          throw new Error(`it saved ${String(saves.length)}`);
        if (
          save.callId !== callIdOf(AGENT, 1, step.item) ||
          save.ref !== turn
        ) {
          throw new Error(`the save was ${JSON.stringify(save)}`);
        }
        return "one save, in its turn, as <agent>/1/<Claude's toolUseId>";
      }),

  "a steer's own turn calls the door, and the call is placed in that turn":
    async (context) =>
      withDoor(context, async ({ saves, send, until }) => {
        const first = send(
          "queue",
          "Write 12 short numbered lines about a fictional morning walk.",
        );
        const turn = await until(startedBy(first));
        // A reply with no tools has no point to fold a steer into, so
        // Claude holds it to the turn's end, and starts a turn with it.
        const steer = send(
          "steer",
          "Now use the save_note tool once to save the note 'Fictional: PINEAPPLE'. Then reply 'done'.",
        );
        const save = await until(() => saves[0]);
        const own = await until((event) =>
          event.type === "turnStarted" && event.turn === save.ref
            ? event
            : undefined,
        );
        const ends = [await until(endOf(turn)), await until(endOf(save.ref))];
        if (ends.some((end) => end.status !== "done")) {
          throw new Error(`the turns ended ${JSON.stringify(ends)}`);
        }
        if (!own.inputs.includes(steer) && save.ref !== turn) {
          throw new Error("the save was placed in a turn the steer wasn't in");
        }
        return own.inputs.includes(steer)
          ? "the steer started its own turn, and the save was placed in it"
          : "the steer joined the running turn, and the save was placed in it";
      }),

  "what Claude does shows as steps, with no picture's bytes, and its usage":
    async (context) =>
      withAdapter(context, async ({ adapter, open, send, until, events }) => {
        // A fictional picture: one pixel.
        const png =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        await writeFile(
          join(context.sandbox.folder, "dot.png"),
          Buffer.from(png, "base64"),
        );
        const conversation = await open();
        const turn = await send(
          conversation,
          randomUUID(),
          "Run this Bash command: echo hello-probe. Then use the Read tool on dot.png in your folder. Then reply 'done'.",
        );
        const end = await until(endOf(turn));
        if (end.status !== "done")
          throw new Error(`the turn ended ${JSON.stringify(end)}`);
        const done = events.flatMap((event) =>
          event.type === "step" && event.status === "done" ? [event] : [],
        );
        const ran = done.some(
          (step) =>
            step.kind === "command" && step.title.includes("echo hello-probe"),
        );
        const read = done.some(
          (step) =>
            step.title === "Read" && step.detail?.endsWith("dot.png") === true,
        );
        if (!ran || !read) {
          // Every step as it came, with how it ended, and Claude's words.
          const steps = events.flatMap((event) =>
            event.type === "step"
              ? [
                  {
                    kind: event.kind,
                    title: event.title,
                    detail: event.detail,
                    status: event.status,
                  },
                ]
              : [],
          );
          const said = events
            .flatMap((event) => (event.type === "text" ? [event.delta] : []))
            .join("");
          throw new Error(
            `the steps were ${JSON.stringify(steps)}; Claude said: ${said}`,
          );
        }
        if (JSON.stringify(events).includes(png)) {
          throw new Error("the picture's bytes are in the events");
        }
        const used = events.find((event) => event.type === "turnUsage");
        const filled = events.find((event) => event.type === "usage");
        if (!used || used.input <= 0 || used.output <= 0) {
          throw new Error(`the turn's usage was ${JSON.stringify(used)}`);
        }
        if (!filled || filled.tokens <= 0 || (filled.window ?? 0) <= 0) {
          throw new Error(`the context was ${JSON.stringify(filled)}`);
        }
        const windows = await adapter.usage();
        if (windows.length === 0) throw new Error("no usage now");
        return `a command and a picture's read; ${String(used.input)} tokens in, ${String(used.output)} out; ${String(windows.length)} limit windows`;
      }),
};

const signIn = rufiHome();
// Claude's own folder in the test sign-in: in Claude's environment, and in
// this process, where the SDK's session functions read it.
process.env["CLAUDE_CONFIG_DIR"] = claudeFolder(signIn);
const claude = await findClaude();
console.log(`Claude ${claude.version} at ${claude.path}`);
const folder = await mkdtemp(join(tmpdir(), "rufi-claude-live-"));
// Brackets, which Claude's permission rules read as a pattern unless
// escaped, and a space and parentheses, which a rule holds too.
const home = join(folder, "home [fictional] (2)");
// The fictional files go only into this run's own data folder, never into
// the test sign-in.
await unreadableFiles(home);
// Claude's AI is denied the test sign-in too: Codex's and Claude's own.
const sandbox = caseSandbox(home, signInsOf(signIn));
await aiFolder(sandbox.folder);
const plugin = await prepareClaudePlugin(home, [
  {
    name: "greeting",
    text: "---\nname: greeting\ndescription: How to greet someone by name, fictional.\n---\nGreet them as: Ahoy, <name>.\n",
    files: {},
  },
]);
const context = {
  claude,
  folder,
  home,
  sandbox,
  env: claudeEnvironment(signIn, childEnvironment()),
  plugin,
};
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
