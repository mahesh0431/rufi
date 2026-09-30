// Where a ChatGPT sign-in is kept: the registration (no secrets) in
// RUFI_HOME/chatgpt.json, the tokens in the Keychain under the host id.
import { join } from "node:path";
import { z } from "zod";
import { readJson, writePrivateJson } from "../../platform/files.ts";
import { ChatGptError, type ChatGptDeps } from "./openai.ts";

const Registration = z.object({
  hostId: z.string().startsWith("urn:uuid:"),
  /** The issued `oaiapp_…` id; set as soon as the first callback arrives. */
  clientId: z.string().optional(),
  /** Set once a sign-in is verified; later sign-ins must match it. */
  subject: z.string().optional(),
  email: z.string().optional(),
});
export type Registration = z.infer<typeof Registration>;

const Credentials = z.object({
  clientId: z.string(),
  subject: z.string(),
  scopes: z.array(z.string()),
  accessToken: z.string(),
  refreshToken: z.string(),
  idToken: z.string(),
  expiresAt: z.number(),
  earliestRefreshAt: z.number().optional(),
});
export type Credentials = z.infer<typeof Credentials>;

const file = (home: string) => join(home, "chatgpt.json");

export async function readRegistration(
  home: string,
): Promise<Registration | undefined> {
  const value = await readJson(file(home));
  if (value === undefined) return undefined;
  const parsed = Registration.safeParse(value);
  if (!parsed.success) {
    throw new ChatGptError(
      "storage",
      `${file(home)} is damaged. Remove it and sign in again.`,
      {
        cause: parsed.error,
      },
    );
  }
  return parsed.data;
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
  const parsed = Credentials.safeParse(parseJson(stored));
  if (
    !parsed.success ||
    parsed.data.clientId !== registration.clientId ||
    parsed.data.subject !== registration.subject
  )
    return undefined;
  return parsed.data;
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
