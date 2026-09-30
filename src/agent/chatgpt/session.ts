import { withLock } from "../../platform/files.ts";
import {
  clearCredentials,
  readCredentials,
  readRegistration,
  saveCredentials,
  type Credentials,
} from "./account.ts";
import {
  ChatGptError,
  discover,
  errorCode,
  hasPlanUse,
  parseTokens,
  postForm,
  RESOURCE,
  verifyIdToken,
  type ChatGptDeps,
} from "./openai.ts";

/** Refresh errors that mean the saved sign-in can't be renewed. */
const TERMINAL = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);
const RENEW_BEFORE_MS = 60_000;

export interface Status {
  signedIn: boolean;
  email: string | undefined;
  planUse: boolean;
  expiresAt: number | undefined;
}

export async function status(deps: ChatGptDeps): Promise<Status> {
  const registration = await readRegistration(deps.home);
  const credentials =
    registration && (await readCredentials(deps, registration));
  return {
    signedIn: credentials !== undefined,
    email: registration?.email,
    planUse: credentials !== undefined && hasPlanUse(credentials.scopes),
    expiresAt: credentials?.expiresAt,
  };
}

/**
 * A current access token for ChatGPT plan use, renewed when it has under a
 * minute left. One renewal at a time, within this process and across processes.
 */
export function accessToken(deps: ChatGptDeps): Promise<string> {
  return withLock(deps.home, 5_000, () => accessTokenLocked(deps));
}

async function accessTokenLocked(deps: ChatGptDeps): Promise<string> {
  const registration = await readRegistration(deps.home);
  const credentials =
    registration && (await readCredentials(deps, registration));
  if (!registration || !credentials) {
    throw new ChatGptError(
      "not_signed_in",
      "Not signed in. Run: pnpm rufi signin",
    );
  }
  requirePlanUse(credentials);
  const now = Date.now();
  if (credentials.expiresAt - now > RENEW_BEFORE_MS)
    return credentials.accessToken;
  if (
    credentials.earliestRefreshAt !== undefined &&
    credentials.earliestRefreshAt > now
  ) {
    if (credentials.expiresAt > now) return credentials.accessToken;
    throw new ChatGptError(
      "temporary",
      "ChatGPT can't renew the sign-in yet. Try again shortly.",
    );
  }

  const openai = await discover(deps);
  const response = await postForm(deps, openai.token_endpoint, {
    grant_type: "refresh_token",
    client_id: credentials.clientId,
    refresh_token: credentials.refreshToken,
    resource: RESOURCE,
  });
  if (response.status !== 200) {
    const error = errorCode(response);
    if (TERMINAL.has(error)) {
      await clearCredentials(deps, registration.hostId);
      throw new ChatGptError(
        "sign_in_again",
        "Your ChatGPT sign-in has ended. Run: pnpm rufi signin",
      );
    }
    if (error === "invalid_client") {
      throw new ChatGptError(
        "config",
        "ChatGPT rejected Rufi's registration (invalid_client).",
      );
    }
    throw new ChatGptError(
      response.status >= 500 ? "temporary" : "exchange",
      `ChatGPT couldn't renew the sign-in (${error}). Try again shortly.`,
    );
  }
  const tokens = parseTokens(response.body);
  if (!tokens) {
    // The old refresh token may already be used up; don't replay it.
    await clearCredentials(deps, registration.hostId);
    throw new ChatGptError(
      "sign_in_again",
      "ChatGPT returned an unusable renewal. Run: pnpm rufi signin",
    );
  }
  const idToken = tokens.idToken
    ? await verifyIdToken(
        openai,
        tokens.idToken,
        credentials.clientId,
        undefined,
      ).then(
        () => tokens.idToken ?? credentials.idToken,
        () => credentials.idToken,
      )
    : credentials.idToken;
  const renewed: Credentials = {
    ...credentials,
    scopes: tokens.scopes ?? credentials.scopes,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken,
    expiresAt: tokens.expiresAt,
    earliestRefreshAt: tokens.earliestRefreshAt,
  };
  await saveCredentials(deps, registration.hostId, renewed);
  requirePlanUse(renewed);
  return renewed.accessToken;
}

function requirePlanUse(credentials: Credentials): void {
  if (!hasPlanUse(credentials.scopes)) {
    throw new ChatGptError(
      "plan_use_off",
      "ChatGPT plan use isn't allowed for Rufi. Run pnpm rufi signin to allow it.",
    );
  }
}

export interface SignedOut {
  wasSignedIn: boolean;
  /** False when OpenAI couldn't confirm the revocation; the tokens are cleared anyway. */
  revoked: boolean;
}

/** Revokes the refresh token with OpenAI, then clears the tokens here either way. */
export function signOut(deps: ChatGptDeps): Promise<SignedOut> {
  return withLock(deps.home, 0, async () => {
    const registration = await readRegistration(deps.home);
    const credentials =
      registration && (await readCredentials(deps, registration));
    if (!registration || !credentials)
      return { wasSignedIn: false, revoked: false };
    let revoked = false;
    try {
      const openai = await discover(deps);
      const response = await postForm(deps, openai.revocation_endpoint, {
        token: credentials.refreshToken,
        token_type_hint: "refresh_token",
        client_id: credentials.clientId,
      });
      revoked = response.status === 200;
    } catch (error) {
      if (!(error instanceof ChatGptError)) throw error;
      // OpenAI unreachable: still clear locally; the caller reports it as unconfirmed.
    }
    await clearCredentials(deps, registration.hostId);
    return { wasSignedIn: true, revoked };
  });
}
