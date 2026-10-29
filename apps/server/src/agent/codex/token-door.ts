// The token door: how a Codex app-server gets a fresh ChatGPT token from the
// running Rufi. Codex runs its provider's auth command (token-command.ts)
// when it needs a token: for its first request, again once the token it has
// is older than REFRESH_MS, and when OpenAI refuses one (a 401). The command
// reads the door's address and key from a file in a folder the AI's sandbox
// can't read (aiSandbox), and asks; the door checks the key on every request
// and answers with Rufi's token, renewed when its end is near. Nothing
// secret is in Codex's environment or arguments, which the AI's commands can
// read through the system (docs/adr/0024).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writePrivateJson } from "../../platform/files.ts";
import { ChatGptError } from "../chatgpt/openai.ts";

/** How long Codex keeps a token before it asks again (its refresh_interval_ms). */
export const REFRESH_MS = 60_000;

/**
 * How long Codex waits for the command (its timeout_ms): longer than the
 * sign-in's own wait for OpenAI and its lock.
 */
export const COMMAND_MS = 35_000;

/**
 * A token the door gives stays valid for this long, at least, so it outlasts
 * Codex's use of it. Not longer: a longer ask can fall between the token's
 * end and the earliest renewal ChatGPT allows, when Rufi has no token to give.
 */
export const TOKEN_VALID_MS = 2 * REFRESH_MS;

/** The command Codex runs, with Rufi's own node. */
export const TOKEN_COMMAND = fileURLToPath(
  new URL("./token-command.ts", import.meta.url),
);

/**
 * The folder of the door's file, for the Codex home kept in `home`: the AI's
 * sandbox denies the whole folder, the file's temporary copy too.
 */
export const doorFolder = (home: string) => join(home, "codex-door");

/** The file the command reads: the door's address and key. */
export const doorFile = (home: string) => join(doorFolder(home), "door.json");

/** Sign-in failures that only signing in again ends. */
const SIGNED_OUT = new Set(["not_signed_in", "sign_in_again", "plan_use_off"]);

export interface TokenDoor {
  /** When the door last gave no token because Rufi is signed out, if ever. */
  signedOutAt: () => number | undefined;
  close: () => Promise<void>;
}

/**
 * Opens the door for the Codex home kept in `home`, on loopback with a new
 * key, and writes its file. `token` is Rufi's sign-in.
 */
export async function openTokenDoor(
  home: string,
  token: (validForMs: number) => Promise<string>,
): Promise<TokenDoor> {
  const key = randomBytes(32);
  const expected = Buffer.from(`Bearer ${key.toString("base64url")}`);
  let signedOutAt: number | undefined;
  const server: Server = createServer((request, response) => {
    request.resume();
    const given = Buffer.from(request.headers.authorization ?? "");
    if (
      request.method !== "POST" ||
      given.length !== expected.length ||
      !timingSafeEqual(given, expected)
    ) {
      response.writeHead(401).end("Not Rufi's token command.");
      return;
    }
    token(TOKEN_VALID_MS).then(
      (value) => {
        response.writeHead(200, { "content-type": "text/plain" }).end(value);
      },
      (error: unknown) => {
        if (error instanceof ChatGptError && SIGNED_OUT.has(error.code)) {
          signedOutAt = Date.now();
        }
        // Codex shows the command's reason with its error.
        response
          .writeHead(503)
          .end(
            error instanceof ChatGptError
              ? error.message
              : "Rufi couldn't renew its ChatGPT sign-in.",
          );
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const file = doorFile(home);
  try {
    await writePrivateJson(file, {
      url: `http://127.0.0.1:${String(port)}/`,
      key: key.toString("base64url"),
    });
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    signedOutAt: () => signedOutAt,
    // The file stays: its key opens nothing once the door is closed, and
    // the next door replaces it.
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
