// Rufi's terminal commands. This is the composition root: the real data
// folder, Keychain, OpenAI and Codex are joined here, as Effect layers, and
// each command gets only the parts it needs. Effect closes every part when the
// command ends, fails or is stopped with Ctrl-C.
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { NodeRuntime } from "@effect/platform-node";
import { Cause, Console, Effect, Layer } from "effect";
import { signIn } from "../agent/chatgpt/signin.ts";
import { accessToken, signOut, status } from "../agent/chatgpt/session.ts";
import type { ChatGptDeps } from "../agent/chatgpt/openai.ts";
import { v7 as uuid } from "uuid";
import { codexBinary } from "../agent/codex/binary.ts";
import { codexRuntime } from "../agent/codex/codex.ts";
import { agentCall, type AgentEvent, type TurnEnd } from "../agent/runtime.ts";
import { allowlistFile } from "../core/chat/models.ts";
import { safetyInstructions } from "../core/chat/safety.ts";
import {
  onlyPersonId,
  RecordStore,
  recordLayer,
} from "../core/store/database.ts";
import { restore } from "../core/store/restore.ts";
import { forAgent } from "../core/tools/tools.ts";
import { childEnvironment, Home, homeLayer } from "../platform/config.ts";
import { holdRufiLock } from "../platform/files.ts";
import { Secrets, secretsLayer } from "../platform/keychain.ts";
import {
  diagnostics,
  errorCode,
  Logs,
  logsLayer,
  noEffectLogs,
} from "../platform/logs.ts";
import { runningLink, startCore } from "../server/core.ts";
import { appChannel, closeAppChannel } from "./app.ts";

const USAGE = `Usage: pnpm rufi <command>
  start [--no-open]   start Rufi and open it in your browser (Ctrl-C stops it);
                      while it runs, open it again (pnpm start does both)
  signin [--no-open]  sign in with ChatGPT
  status              who is signed in
  signout             sign out and revoke the sign-in
  ask "question"      ask the AI and watch the answer stream (Ctrl-C stops it)
      [--person id]   whose record Rufi's tools read (not needed with one person)
      [--debug]       also print Rufi's log lines
  restore <backup> <new folder>
                      restore a backup into a new or empty folder (no RUFI_HOME needed)`;

/** A promise-based step, with its error kept as it is. */
const run = <A>(step: () => Promise<A>) =>
  Effect.tryPromise({ try: step, catch: (error) => error });

/** What the sign-in code needs, from the data folder and the Keychain. */
const chatGpt = Effect.gen(function* () {
  const deps: ChatGptDeps = {
    home: yield* Home,
    secrets: yield* Secrets,
    issuer: "https://auth.openai.com",
    sleep: (ms) => sleep(ms),
  };
  return deps;
});

/**
 * rufi.lock for as long as the command runs: a command and the running Rufi
 * never use the data folder at the same time.
 */
const rufiLock = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.flatMap(Home, (home) =>
      run(() =>
        holdRufiLock(home, (error) => {
          console.error(
            `Rufi lost its lock on the data folder (${errorCode(error)}).`,
          );
        }),
      ),
    ),
    (release) => Effect.promise(() => release().catch(() => undefined)),
  ),
);

/** The data folder, its lock and the Keychain; built only for commands that use them. */
const base = Layer.mergeAll(
  homeLayer,
  secretsLayer,
  rufiLock.pipe(Layer.provide(homeLayer)),
);

const main = Effect.gen(function* () {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      return yield* Console.log(USAGE);
    case "start":
      // No rufi.lock here: the core takes it for as long as it runs.
      return yield* startCommand(!rest.includes("--no-open")).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(homeLayer, secretsLayer)),
      );
    case "signin":
      return yield* signinCommand(!rest.includes("--no-open")).pipe(
        Effect.provide(base),
      );
    case "status":
      return yield* statusCommand.pipe(Effect.provide(base));
    case "signout":
      return yield* signoutCommand.pipe(Effect.provide(base));
    case "restore": {
      const [backup, target, ...more] = rest;
      if (backup === undefined || target === undefined || more.length > 0) {
        return yield* usageError;
      }
      return yield* restoreCommand(backup, target);
    }
    case "ask": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { debug: { type: "boolean" }, person: { type: "string" } },
        allowPositionals: true,
      });
      const question = positionals.join(" ").trim();
      if (!question) return yield* usageError;
      // Closed in reverse: Codex first, then the record, then the log.
      return yield* askCommand(question, values.person).pipe(
        Effect.scoped,
        Effect.provide(recordLayer),
        Effect.provide(
          logsLayer(
            values.debug
              ? (line) => {
                  console.error(line);
                }
              : undefined,
          ),
        ),
        Effect.provide(base),
      );
    }
    default:
      return yield* usageError;
  }
});

const usageError = Effect.sync(() => {
  console.log(USAGE);
  process.exitCode = 2;
});

const signinCommand = (open: boolean) =>
  Effect.gen(function* () {
    const deps = yield* chatGpt;
    const result = yield* run(() =>
      signIn(deps, {
        showLink: (link) => {
          console.log(
            open
              ? "Opening your browser to sign in with ChatGPT."
              : "Open this link to sign in with ChatGPT:",
          );
          console.log(
            open ? `If it doesn't open, use this link:\n${link}` : link,
          );
          console.log("Waiting for you to approve (up to 5 minutes)...");
        },
        openBrowser: (link) => {
          if (open) openBrowser(link);
        },
      }),
    );
    console.log(`Signed in as ${result.email ?? "your ChatGPT account"}.`);
    if (!result.planUse) {
      console.log(
        "ChatGPT plan use wasn't allowed, so Rufi can't use your plan yet. Run pnpm rufi signin again to allow it.",
      );
    }
  });

const statusCommand = Effect.gen(function* () {
  const deps = yield* chatGpt;
  const now = yield* run(() => status(deps));
  if (!now.signedIn) {
    console.log(
      now.email
        ? `Not signed in (last account: ${now.email}).`
        : "Not signed in.",
    );
    return;
  }
  const until = now.expiresAt
    ? new Date(now.expiresAt).toLocaleTimeString()
    : "unknown";
  console.log(`Signed in as ${now.email ?? "your ChatGPT account"}.`);
  console.log(`ChatGPT plan use: ${now.planUse ? "allowed" : "not allowed"}.`);
  console.log(
    `Current access token valid until ${until}; Rufi renews it when needed.`,
  );
});

const signoutCommand = Effect.gen(function* () {
  const deps = yield* chatGpt;
  const result = yield* run(() => signOut(deps));
  if (!result.wasSignedIn) console.log("Not signed in.");
  else if (result.revoked)
    console.log("Signed out. ChatGPT confirmed the sign-in is revoked.");
  else {
    console.log(
      "Signed out here, but ChatGPT couldn't confirm the revocation. To be sure, disconnect Rufi in ChatGPT settings.",
    );
  }
});

/**
 * Restores a backup into a new folder. Paths are the person's, from the
 * folder they ran the command in (pnpm runs it from the checkout).
 */
const restoreCommand = (backup: string, target: string) =>
  Effect.gen(function* () {
    const from = process.env["INIT_CWD"] ?? process.cwd();
    const folder = resolve(from, target);
    const { createdAt } = yield* run(() =>
      restore(resolve(from, backup), folder),
    );
    console.log(
      `Restored the backup from ${new Date(createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} into ${folder}.`,
    );
    console.log("It starts signed out. To open it, run:");
    console.log(`RUFI_HOME=${shellQuoted(folder)} pnpm start`);
  });

/** A path as the shell takes it: in single quotes when it needs them. */
const shellQuoted = (path: string) =>
  /^[\w./~-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;

/** The built screens, next to this package. */
// A file path, decoded: a folder name with a space or an accent stays as it is.
const SCREENS = fileURLToPath(new URL("../../../web/dist", import.meta.url));

/**
 * Starts Rufi and opens it in the browser, until Ctrl-C. When Rufi already
 * runs with this data folder, opens a fresh link to it instead. With
 * `open` false, only shows the link. Started by the Rufi app, it gives the
 * links to the app instead (./app.ts) and runs until the app is gone.
 */
const startCommand = (open: boolean) =>
  Effect.gen(function* () {
    const home = yield* Home;
    const app = appChannel();
    const again = yield* run(() => runningLink(home));
    if (again !== undefined && app !== undefined) {
      return yield* app.send({ type: "attached", url: again });
    }
    if (again !== undefined) {
      console.log("Rufi is already running. A new link to it:");
      console.log(again);
      if (open) openBrowser(again);
      return;
    }
    yield* run(() =>
      access(join(SCREENS, "index.html")).catch((error: unknown) => {
        throw new Error(
          "Rufi's screens aren't built. Run pnpm start or pnpm desktop: they build them first.",
          { cause: error },
        );
      }),
    );
    const deps = yield* chatGpt;
    const { log } = diagnostics(home);
    const file = yield* run(() => codexBinary());
    const { version } = createRequire(import.meta.url)(
      "../../package.json",
    ) as {
      version: string;
    };
    const core = yield* startCore({
      home,
      agent: (tools, host) =>
        codexRuntime({
          home,
          command: { file, args: [] },
          env: childEnvironment(),
          token: (validForMs) => accessToken(deps, validForMs),
          version,
          tools,
          host,
          log,
        }),
      signIn: ({ showLink }) =>
        signIn(deps, {
          showLink,
          openBrowser: (link) => {
            openBrowser(link);
          },
        }),
      account: async () => {
        const now = await status(deps);
        return {
          account: !now.signedIn
            ? "signed_out"
            : now.planUse
              ? "signed_in"
              : "no_plan_use",
          email: now.email ?? null,
        };
      },
      screens: SCREENS,
      log,
    });
    const link = core.launchUrl();
    if (app !== undefined) {
      yield* app.send({ type: "owned", url: link });
      // Until the app quits or dies; then Rufi stops as with Ctrl-C.
      return yield* app.serve(core.launchUrl);
    }
    console.log("Rufi is running. Its link (it works once):");
    console.log(link);
    console.log("Press Ctrl-C to stop Rufi.");
    if (open) openBrowser(link);
    return yield* Effect.never;
  });

/**
 * Asks one question in a new thread and streams the answer; nothing is saved
 * in Rufi's conversations. Ctrl-C stops the reply. Rufi's tools read the
 * record for `person`.
 */
const askCommand = (question: string, person: string | undefined) =>
  Effect.gen(function* () {
    const deps = yield* chatGpt;
    const log = yield* Logs;
    const store = yield* RecordStore;
    const personId =
      person ?? (store ? yield* run(() => onlyPersonId(store)) : undefined);
    const tools = forAgent(() => ({ store, personId }), log);
    const { models } = yield* run(() => allowlistFile(deps.home).read());
    const file = yield* run(() => codexBinary());
    const { version } = createRequire(import.meta.url)(
      "../../package.json",
    ) as { version: string };
    const ended = Promise.withResolvers<TurnEnd>();
    let caller:
      | { turnId: string; call: ReturnType<typeof tools.forTurn> }
      | undefined;
    const agent = yield* Effect.acquireRelease(
      Effect.sync(() =>
        codexRuntime({
          home: deps.home,
          command: { file, args: [] },
          env: childEnvironment(),
          token: (validForMs) => accessToken(deps, validForMs),
          version,
          tools: { namespace: tools.namespace, specs: tools.specs },
          host: {
            onEvent: (event) => {
              show(event);
              if (event.type === "turnEnded") ended.resolve(event.end);
            },
            callTool: (_threadId, turnId, name, input) => {
              if (caller?.turnId !== turnId) {
                caller = { turnId, call: tools.forTurn() };
              }
              return caller.call(name, input);
            },
          },
          log,
        }),
      ),
      (runtime) => Effect.promise(() => runtime.close()),
    );
    const op = new AbortController();
    let threadId: string | undefined;
    const started = Date.now();
    const end = yield* agentCall(
      async () => {
        const thread = await agent.startThread(
          {
            model: models[0] ?? "",
            instructions: `${safetyInstructions(undefined)}\n\n${tools.instructions}`,
          },
          op.signal,
        );
        threadId = thread.threadId;
        await agent.send(threadId, { id: uuid(), text: question }, op.signal);
        return ended.promise;
      },
      async () => {
        op.abort();
        if (threadId !== undefined) await agent.stop(threadId);
        ended.resolve({
          status: "interrupted",
          reason: "stopped",
          text: "Stopped.",
        });
      },
      () => {
        console.error("\nStopping…");
      },
    );
    log("turn.ended", { status: end.status, ms: Date.now() - started });
    process.stdout.write("\n");
    if (end.status !== "completed") {
      console.error(end.text ?? end.status);
      process.exitCode = 1;
    }
  });

let midLine = false;
let lastReply: string | undefined;
const shown = new Set<string>();
function show(event: AgentEvent): void {
  if (event.type === "text") {
    // A new reply after an earlier one starts on a new paragraph.
    const gap =
      lastReply !== undefined && lastReply !== event.itemId ? "\n\n" : "";
    lastReply = event.itemId;
    process.stdout.write(gap + event.delta);
    midLine = !event.delta.endsWith("\n");
    return;
  }
  let line: string;
  if (event.type === "activity") {
    if (shown.has(event.itemId)) return;
    // The words of a web search may come only when it ends.
    if (
      event.activity === "web_search" &&
      event.detail === undefined &&
      event.status === "running"
    )
      return;
    shown.add(event.itemId);
    line = `· ${event.title}${event.detail === undefined ? "" : `: ${event.detail}`}`;
  } else if (event.type === "question") {
    line = `\n? ${event.title}${event.options.length > 0 ? `\n  ${event.options.join(" / ")}` : ""}`;
  } else {
    return;
  }
  process.stdout.write(`${midLine ? "\n" : ""}${line}\n`);
  midLine = false;
}

/** Opens the default browser; if that fails, the link is already on screen. */
function openBrowser(link: string): void {
  execFile("open", [link], { timeout: 10_000 }, (error) => {
    if (error) console.log("Couldn't open the browser. Use the link above.");
  });
}

/**
 * A failure shows its message only, as before; the full error never prints.
 * The Rufi app, when it started the command, gets the message too.
 */
const reported = main.pipe(
  Effect.provide(noEffectLogs),
  Effect.catchCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
    const error = Cause.squash(cause);
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
    return appChannel()?.send({ type: "failed", message }) ?? Effect.void;
  }),
  Effect.ensuring(Effect.sync(closeAppChannel)),
);

NodeRuntime.runMain(reported, { disableErrorReporting: true });
