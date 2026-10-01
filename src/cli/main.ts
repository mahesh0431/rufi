// Rufi's terminal commands. This is the composition root: real Keychain, real
// OpenAI, the real browser.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { signIn } from "../agent/chatgpt/signin.ts";
import { accessToken, signOut, status } from "../agent/chatgpt/session.ts";
import type { ChatGptDeps } from "../agent/chatgpt/openai.ts";
import { codexBinary } from "../agent/codex/binary.ts";
import { codexRuntime } from "../agent/codex/codex.ts";
import type { TurnEvent } from "../agent/runtime.ts";
import {
  databasePath,
  onlyPersonId,
  openReadOnly,
} from "../core/store/database.ts";
import { forAgent } from "../core/tools/tools.ts";
import { childEnvironment, rufiHome } from "../platform/config.ts";
import { keychain } from "../platform/keychain.ts";

const USAGE = `Usage: pnpm rufi <command>
  signin [--no-open]  sign in with ChatGPT
  status              who is signed in
  signout             sign out and revoke the sign-in
  ask "question"      ask the AI and watch the answer stream (Ctrl-C stops it)
      [--person id]   whose record Rufi's tools read (not needed with one person)
      [--debug]       also print what Rufi ignored or refused`;

async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  const deps: ChatGptDeps = {
    home: rufiHome(),
    secrets: keychain("Rufi ChatGPT"),
    issuer: "https://auth.openai.com",
    sleep: (ms) => sleep(ms),
  };
  switch (command) {
    case "signin": {
      const open = !rest.includes("--no-open");
      const result = await signIn(deps, {
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
      });
      console.log(`Signed in as ${result.email ?? "your ChatGPT account"}.`);
      if (!result.planUse) {
        console.log(
          "ChatGPT plan use wasn't allowed, so Rufi can't use your plan yet. Run pnpm rufi signin again to allow it.",
        );
      }
      return;
    }
    case "status": {
      const now = await status(deps);
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
      console.log(
        `ChatGPT plan use: ${now.planUse ? "allowed" : "not allowed"}.`,
      );
      console.log(
        `Current access token valid until ${until}; Rufi renews it when needed.`,
      );
      return;
    }
    case "signout": {
      const result = await signOut(deps);
      if (!result.wasSignedIn) console.log("Not signed in.");
      else if (result.revoked)
        console.log("Signed out. ChatGPT confirmed the sign-in is revoked.");
      else {
        console.log(
          "Signed out here, but ChatGPT couldn't confirm the revocation. To be sure, disconnect Rufi in ChatGPT settings.",
        );
      }
      return;
    }
    case "ask": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { debug: { type: "boolean" }, person: { type: "string" } },
        allowPositionals: true,
      });
      const question = positionals.join(" ").trim();
      if (!question) {
        console.log(USAGE);
        process.exitCode = 2;
        return;
      }
      await ask(deps, question, values);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = 2;
  }
}

/** Asks one question and streams the answer; the first Ctrl-C stops the turn. */
async function ask(
  deps: ChatGptDeps,
  question: string,
  options: { debug?: boolean; person?: string },
): Promise<void> {
  const { version } = createRequire(import.meta.url)("../../package.json") as {
    version: string;
  };
  const log = (line: string) => {
    if (options.debug) console.error(`[debug] ${line}`);
  };
  const store = openReadOnly(databasePath(deps.home));
  const personId = options.person ?? (store ? onlyPersonId(store) : undefined);
  const runtime = codexRuntime({
    home: deps.home,
    command: { file: await codexBinary(), args: [] },
    env: childEnvironment(),
    token: (validForMs) => accessToken(deps, validForMs),
    version,
    tools: forAgent(() => ({ store, personId }), log),
    log,
  });
  const onInterrupt = () => {
    process.stderr.write("\nStopping…\n");
    void runtime.stop();
  };
  process.once("SIGINT", onInterrupt);
  try {
    const conversation = await runtime.open();
    const result = await runtime.turn(conversation, question, show);
    process.stdout.write("\n");
    if (result.status !== "completed") {
      console.error(result.reason ?? result.status);
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    await runtime.close();
    store?.close();
  }
}

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

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
