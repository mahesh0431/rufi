// Rufi's terminal commands. This is the composition root: the real data
// folder, Keychain, OpenAI and Codex are joined here, as Effect layers, and
// each command gets only the parts it needs. Effect closes every part when the
// command ends, fails or is stopped with Ctrl-C.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { NodeRuntime } from "@effect/platform-node";
import { Cause, Console, Effect, Layer } from "effect";
import { signIn } from "../agent/chatgpt/signin.ts";
import { accessToken, signOut, status } from "../agent/chatgpt/session.ts";
import type { ChatGptDeps } from "../agent/chatgpt/openai.ts";
import { codexBinary } from "../agent/codex/binary.ts";
import { codexRuntime } from "../agent/codex/codex.ts";
import { Agent, agentCall, type TurnEvent } from "../agent/runtime.ts";
import {
  onlyPersonId,
  RecordStore,
  recordLayer,
} from "../core/store/database.ts";
import { forAgent } from "../core/tools/tools.ts";
import { childEnvironment, Home, homeLayer } from "../platform/config.ts";
import { Secrets, secretsLayer } from "../platform/keychain.ts";
import { Logs, logsLayer } from "../platform/logs.ts";

const USAGE = `Usage: pnpm rufi <command>
  signin [--no-open]  sign in with ChatGPT
  status              who is signed in
  signout             sign out and revoke the sign-in
  ask "question"      ask the AI and watch the answer stream (Ctrl-C stops it)
      [--person id]   whose record Rufi's tools read (not needed with one person)
      [--debug]       also print Rufi's log lines`;

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

/** The data folder and the Keychain; built only for commands that use them. */
const base = Layer.mergeAll(homeLayer, secretsLayer);

const main = Effect.gen(function* () {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      return yield* Console.log(USAGE);
    case "signin":
      return yield* signinCommand(!rest.includes("--no-open")).pipe(
        Effect.provide(base),
      );
    case "status":
      return yield* statusCommand.pipe(Effect.provide(base));
    case "signout":
      return yield* signoutCommand.pipe(Effect.provide(base));
    case "ask": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { debug: { type: "boolean" }, person: { type: "string" } },
        allowPositionals: true,
      });
      const question = positionals.join(" ").trim();
      if (!question) return yield* usageError;
      // Closed in reverse: Codex first, then the record, then the log.
      return yield* askCommand(question).pipe(
        Effect.provide(agentLayer(values.person)),
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

/** Codex, with Rufi's tools reading the record for `person`; closed at the end. */
const agentLayer = (person: string | undefined) =>
  Layer.effect(
    Agent,
    Effect.gen(function* () {
      const deps = yield* chatGpt;
      const log = yield* Logs;
      const store = yield* RecordStore;
      const personId =
        person ?? (store ? yield* run(() => onlyPersonId(store)) : undefined);
      const file = yield* run(() => codexBinary());
      const { version } = createRequire(import.meta.url)(
        "../../package.json",
      ) as { version: string };
      return yield* Effect.acquireRelease(
        Effect.sync(() =>
          codexRuntime({
            home: deps.home,
            command: { file, args: [] },
            env: childEnvironment(),
            token: (validForMs) => accessToken(deps, validForMs),
            version,
            tools: forAgent(() => ({ store, personId }), log),
            log,
          }),
        ),
        (runtime) => Effect.promise(() => runtime.close()),
      );
    }),
  );

/** Asks one question and streams the answer; Ctrl-C stops the turn. */
const askCommand = (question: string) =>
  Effect.gen(function* () {
    const agent = yield* Agent;
    const log = yield* Logs;
    const stopping = () => {
      console.error("\nStopping…");
    };
    const conversation = yield* agentCall(agent, () => agent.open(), stopping);
    const started = Date.now();
    const result = yield* agentCall(
      agent,
      () => agent.turn(conversation, question, show),
      stopping,
    );
    log("turn.ended", { status: result.status, ms: Date.now() - started });
    process.stdout.write("\n");
    if (result.status !== "completed") {
      console.error(result.reason ?? result.status);
      process.exitCode = 1;
    }
  });

let midLine = false;
function show(event: TurnEvent): void {
  if (event.type === "text") {
    process.stdout.write(event.delta);
    midLine = !event.delta.endsWith("\n");
    return;
  }
  const line =
    event.type === "activity"
      ? `· ${event.text}`
      : event.type === "question"
        ? `\n? ${event.title}${event.options.length > 0 ? `\n  ${event.options.join(" / ")}` : ""}`
        : `· the AI did something Rufi can't display yet (${event.what})`;
  process.stdout.write(`${midLine ? "\n" : ""}${line}\n`);
  midLine = false;
}

/** Opens the default browser; if that fails, the link is already on screen. */
function openBrowser(link: string): void {
  execFile("open", [link], { timeout: 10_000 }, (error) => {
    if (error) console.log("Couldn't open the browser. Use the link above.");
  });
}

/** A failure shows its message only, as before; the full error never prints. */
const reported = main.pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : Effect.sync(() => {
          const error = Cause.squash(cause);
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }),
  ),
);

NodeRuntime.runMain(reported, { disableErrorReporting: true });
