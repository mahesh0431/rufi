// Where a ChatGPT sign-in is kept: the registration (no secrets) in
// RUFI_HOME/chatgpt.json, the tokens in the Keychain under the host id.
import { join } from "node:path";
import { Result, Schema } from "effect";
import { readJson, writePrivateJson } from "../../platform/files.ts";
import { ChatGptError, type ChatGptDeps } from "./openai.ts";

const Registration = Schema.Struct({
  hostId: Schema.String.check(Schema.isPattern(/^urn:uuid:/)),
  /** The issued `oaiapp_…` id; set as soon as the first callback arrives. */
  clientId: Schema.optional(Schema.String),
  /** Set once a sign-in is verified; later sign-ins must match it. */
  subject: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});
export type Registration = typeof Registration.Type;

const Credentials = Schema.Struct({
  clientId: Schema.String,
  subject: Schema.String,
  scopes: Schema.Array(Schema.String),
  accessToken: Schema.String,
  refreshToken: Schema.String,
  idToken: Schema.String,
  expiresAt: Schema.Finite,
  earliestRefreshAt: Schema.optional(Schema.Finite),
});
export type Credentials = typeof Credentials.Type;

const file = (home: string) => join(home, "chatgpt.json");

export async function readRegistration(
  home: string,
): Promise<Registration | undefined> {
  const value = await readJson(file(home));
  if (value === undefined) return undefined;
  const parsed = Schema.decodeUnknownResult(Registration)(value);
  if (Result.isFailure(parsed)) {
    throw new ChatGptError(
      "storage",
      `${file(home)} is damaged. Remove it and sign in again.`,
      {
        cause: parsed.failure,
      },
    );
  }
  return parsed.success;
}

export async function saveRegistration(
  home: string,
  registration: Registration,
): Promise<void> {
  try {
    await writePrivateJson(file(home), registration);
  } catch (error) {
    throw new ChatGptError("storage", "Couldn't save the sign-in details.", {
      cause: error,
    });
  }
}

/**
 * The tokens for this registration, or undefined. Tokens for another client id
 * or subject don't count: the registration is written after the tokens, so a
 * failed write leaves them unused.
 */
export async function readCredentials(
  deps: ChatGptDeps,
  registration: Registration,
): Promise<Credentials | undefined> {
  let stored: string | undefined;
  try {
    stored = await deps.secrets.get(registration.hostId);
  } catch (error) {
    throw new ChatGptError(
      "storage",
      "Couldn't read the sign-in from the Keychain.",
      {
        cause: error,
      },
    );
  }
  if (stored === undefined) return undefined;
  const parsed = Schema.decodeUnknownResult(Credentials)(parseJson(stored));
  if (
    Result.isFailure(parsed) ||
    parsed.success.clientId !== registration.clientId ||
    parsed.success.subject !== registration.subject
  )
    return undefined;
  return parsed.success;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function saveCredentials(
  deps: ChatGptDeps,
  hostId: string,
  credentials: Credentials,
): Promise<void> {
  try {
    await deps.secrets.set(hostId, JSON.stringify(credentials));
  } catch (error) {
    throw new ChatGptError(
      "storage",
      "Couldn't save the sign-in to the Keychain.",
      {
        cause: error,
      },
    );
  }
}

export async function clearCredentials(
  deps: ChatGptDeps,
  hostId: string,
): Promise<void> {
  try {
    await deps.secrets.delete(hostId);
  } catch (error) {
    throw new ChatGptError(
      "storage",
      "Couldn't remove the sign-in from the Keychain.",
      {
        cause: error,
      },
    );
  }
}
