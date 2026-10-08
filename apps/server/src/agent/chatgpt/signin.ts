import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { withCredentialsLock } from "../../platform/files.ts";
import {
  readCredentials,
  readRegistration,
  saveCredentials,
  saveRegistration,
  type Registration,
} from "./account.ts";
import {
  ChatGptError,
  discover,
  errorCode,
  hasPlanUse,
  parseTokens,
  postForm,
  RESOURCE,
  SCOPE,
  verifyIdToken,
  type ChatGptDeps,
} from "./openai.ts";

const REGISTER = "dynamic_agent_client";
const FIVE_MINUTES = 5 * 60_000;

export interface SignInOptions {
  /** Called with the link to show the person; it never carries a token. */
  showLink: (link: string) => void;
  /**
   * Starts the browser with the link plus the id_token_hint when there is one.
   * Not awaited: sign-in waits only for the callback.
   */
  openBrowser: (link: string) => void;
  waitMs?: number;
}

export interface SignedIn {
  email: string | undefined;
  planUse: boolean;
}

export function signIn(
  deps: ChatGptDeps,
  options: SignInOptions,
): Promise<SignedIn> {
  return withCredentialsLock(deps.home, 0, () => signInLocked(deps, options));
}

async function signInLocked(
  deps: ChatGptDeps,
  options: SignInOptions,
): Promise<SignedIn> {
  let registration = await readRegistration(deps.home);
  if (!registration) {
    // The host id is chosen and saved before the first sign-in.
    registration = { hostId: `urn:uuid:${randomUUID()}` };
    await saveRegistration(deps.home, registration);
  }
  const openai = await discover(deps);
  const previous = await readCredentials(deps, registration);

  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const nonce = base64url(randomBytes(16));
  const callback = await listenForCallback(
    state,
    options.waitMs ?? FIVE_MINUTES,
  );
  try {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: registration.clientId ?? REGISTER,
      redirect_uri: callback.redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      ext_agent_host_id: registration.hostId,
    });
    if (!registration.clientId) query.set("agent_name_hint", "Rufi");
    if (previous && !hasPlanUse(previous.scopes))
      query.set("prompt", "consent");
    options.showLink(`${openai.authorization_endpoint}?${query.toString()}`);
    if (previous) query.set("id_token_hint", previous.idToken);
    options.openBrowser(`${openai.authorization_endpoint}?${query.toString()}`);

    const returned = await callback.result;
    const code = returned.get("code");
    if (!code)
      throw new ChatGptError(
        "callback",
        "ChatGPT sent no sign-in code. Start again.",
      );
    const clientId = await bindClientId(
      deps,
      registration,
      returned.get("client_id"),
    );
    registration = { ...registration, clientId };

    const response = await postForm(deps, openai.token_endpoint, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: callback.redirectUri,
      resource: RESOURCE,
    });
    if (response.status !== 200) {
      const error = errorCode(response);
      if (error === "invalid_grant") {
        throw new ChatGptError(
          "code_expired",
          "The sign-in code expired or was already used. Sign in again.",
        );
      }
      throw new ChatGptError(
        "exchange",
        `ChatGPT refused the sign-in (${error}).`,
      );
    }
    const tokens = parseTokens(response.body);
    if (!tokens?.idToken) {
      throw new ChatGptError(
        "exchange",
        "ChatGPT returned an unusable sign-in. Start again.",
      );
    }
    const identity = await verifyIdToken(
      openai,
      tokens.idToken,
      clientId,
      nonce,
    );
    if (registration.subject && registration.subject !== identity.subject) {
      throw new ChatGptError(
        "different_account",
        "That was a different ChatGPT account. Rufi kept the account it already had.",
      );
    }
    const scopes = tokens.scopes ?? [];
    await saveCredentials(deps, registration.hostId, {
      clientId,
      subject: identity.subject,
      scopes,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt: tokens.expiresAt,
      earliestRefreshAt: tokens.earliestRefreshAt,
    });
    await saveRegistration(deps.home, {
      ...registration,
      subject: identity.subject,
      email: identity.email,
    });
    return { email: identity.email, planUse: hasPlanUse(scopes) };
  } finally {
    await callback.close();
  }
}

/** Checks the client id the callback returned, and saves a newly issued one straight away. */
async function bindClientId(
  deps: ChatGptDeps,
  registration: Registration,
  returned: string | null,
): Promise<string> {
  if (registration.clientId) {
    if (returned && returned !== registration.clientId) {
      throw new ChatGptError(
        "callback",
        "ChatGPT returned a different app registration. Start again.",
      );
    }
    return registration.clientId;
  }
  if (!returned || returned === REGISTER) {
    throw new ChatGptError(
      "callback",
      "ChatGPT didn't register Rufi. Start again.",
    );
  }
  // Kept even if the code exchange fails, so a retry reuses this registration.
  await saveRegistration(deps.home, {
    hostId: registration.hostId,
    clientId: returned,
  });
  return returned;
}

interface Callback {
  redirectUri: string;
  result: Promise<URLSearchParams>;
  close: () => Promise<void>;
}

/** A one-shot loopback listener on 127.0.0.1 for the browser's return. */
async function listenForCallback(
  state: string,
  waitMs: number,
): Promise<Callback> {
  const { promise, resolve, reject } = Promise.withResolvers<URLSearchParams>();
  // The caller awaits `result` after opening the browser; a timeout can land before that.
  promise.catch(() => undefined);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/auth/callback") {
      send(response, 404, "Not found.");
      return;
    }
    if (request.method !== "GET") {
      send(response, 405, "Not allowed.");
      return;
    }
    const params = url.searchParams;
    if (params.get("state") !== state) {
      send(
        response,
        400,
        "This sign-in link didn't match. Go back to Rufi and start again.",
      );
      reject(
        new ChatGptError(
          "callback",
          "The sign-in reply didn't match this attempt. Start again.",
        ),
      );
      return;
    }
    const error = params.get("error");
    if (error) {
      send(response, 200, "Sign-in wasn't completed. You can close this tab.");
      const code = /^[a-z_]{1,64}$/.test(error) ? error : "unknown";
      reject(
        new ChatGptError(
          "callback",
          `ChatGPT sign-in wasn't completed (${code}).`,
        ),
      );
      return;
    }
    send(
      response,
      200,
      "Rufi received your sign-in. You can close this tab and go back to Rufi.",
    );
    resolve(params);
  });
  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", listening);
  });
  const timer = setTimeout(() => {
    reject(
      new ChatGptError(
        "timeout",
        "Sign-in wasn't finished in time. Sign in again.",
      ),
    );
  }, waitMs);
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${String(port)}/auth/callback`,
    result: promise,
    close: () => {
      clearTimeout(timer);
      server.closeAllConnections();
      return new Promise((closed) =>
        server.close(() => {
          closed();
        }),
      );
    },
  };
}

function send(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Rufi</title><p>${text}</p>`,
  );
}

const base64url = (bytes: Buffer): string => bytes.toString("base64url");
