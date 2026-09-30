// Rufi's terminal commands. This is the composition root: real Keychain, real
// OpenAI, the real browser.
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { signIn } from "../agent/chatgpt/signin.ts";
import { signOut, status } from "../agent/chatgpt/session.ts";
import type { ChatGptDeps } from "../agent/chatgpt/openai.ts";
import { rufiHome } from "../platform/config.ts";
import { keychain } from "../platform/keychain.ts";

const USAGE = `Usage: pnpm rufi <command>
  signin [--no-open]  sign in with ChatGPT
  status              who is signed in
  signout             sign out and revoke the sign-in`;

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
        openBrowser: (link) => (open ? openBrowser(link) : Promise.resolve()),
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
    default:
      console.log(USAGE);
      process.exitCode = 2;
  }
}

/** Opens the default browser; if that fails, the link is already on screen. */
function openBrowser(link: string): Promise<void> {
  return new Promise((done) => {
    execFile("open", [link], (error) => {
      if (error) console.log("Couldn't open the browser. Use the link above.");
      done();
    });
  });
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
