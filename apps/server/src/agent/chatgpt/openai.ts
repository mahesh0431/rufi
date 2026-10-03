// OpenAI's Sign in with ChatGPT for open-source local apps, as documented at
// https://developers.openai.com/siwc/token-sharing-open-source (checked 30 Sep 2026).
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Result, Schema } from "effect";
import type { SecretStore } from "../../platform/keychain.ts";

export const SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_USE_SCOPE = "chatgpt.tokens.use.direct";
export const RESOURCE = "https://api.openai.com/v1";
const DEADLINE_MS = 20_000;
const TRIES = 3;

export interface ChatGptDeps {
  /** Rufi's data folder. */
  home: string;
  secrets: SecretStore;
  /** "https://auth.openai.com"; a local fake in tests. */
  issuer: string;
  sleep: (ms: number) => Promise<void>;
}

export type ChatGptErrorCode =
  | "discovery"
  | "callback"
  | "timeout"
  | "exchange"
  | "code_expired"
  | "verify"
  | "different_account"
  | "not_signed_in"
  | "plan_use_off"
  | "sign_in_again"
  | "config"
  | "temporary"
  | "storage";

export class ChatGptError extends Error {
  readonly code: ChatGptErrorCode;
  constructor(code: ChatGptErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

const Url = Schema.String.check(
  Schema.makeFilter((text: string) => URL.canParse(text), {
    expected: "a URL",
  }),
);

const Discovery = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Url,
  token_endpoint: Url,
  jwks_uri: Url,
  revocation_endpoint: Url,
});

export interface OpenAI extends Schema.Schema.Type<typeof Discovery> {
  keys: ReturnType<typeof createRemoteJWKSet>;
}

/** Fetches OpenAI's sign-in configuration and checks every endpoint is on the issuer's own origin. */
export async function discover(deps: ChatGptDeps): Promise<OpenAI> {
  const response = await request(
    deps,
    `${deps.issuer}/.well-known/openid-configuration`,
    {},
  );
  let doc: typeof Discovery.Type;
  try {
    if (response.status !== 200)
      throw new Error(`HTTP ${String(response.status)}`);
    doc = Schema.decodeUnknownSync(Discovery)(JSON.parse(response.text));
  } catch (error) {
    throw new ChatGptError(
      "discovery",
      "Couldn't read ChatGPT's sign-in configuration. Try again.",
      { cause: error },
    );
  }
  const origin = new URL(deps.issuer).origin;
  const endpoints = [
    doc.authorization_endpoint,
    doc.token_endpoint,
    doc.jwks_uri,
    doc.revocation_endpoint,
  ];
  if (
    doc.issuer !== deps.issuer ||
    endpoints.some((url) => new URL(url).origin !== origin)
  ) {
    throw new ChatGptError(
      "discovery",
      "ChatGPT sign-in configuration couldn't be verified.",
    );
  }
  return { ...doc, keys: createRemoteJWKSet(new URL(doc.jwks_uri)) };
}

export interface FormResponse {
  status: number;
  body: Record<string, unknown> | undefined;
}

/** POSTs a form; see `request` for deadlines and retries. */
export async function postForm(
  deps: ChatGptDeps,
  url: string,
  form: Record<string, string>,
): Promise<FormResponse> {
  const response = await request(deps, url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(form),
  });
  return { status: response.status, body: parseObject(response.text) };
}

/** Fetches with a deadline; network errors and 5xx get up to three tries. */
async function request(
  deps: ChatGptDeps,
  url: string,
  init: RequestInit,
): Promise<{ status: number; text: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(DEADLINE_MS),
      });
      const text = await response.text();
      if (response.status < 500 || attempt === TRIES) {
        return { status: response.status, text };
      }
    } catch (error) {
      if (attempt === TRIES) {
        throw new ChatGptError(
          "temporary",
          "Couldn't reach ChatGPT. Try again shortly.",
          { cause: error },
        );
      }
    }
    await deps.sleep(500 * attempt);
  }
}

/** The OAuth error code of a failed response, or its HTTP status. */
export function errorCode(response: FormResponse): string {
  const error = response.body?.["error"];
  return typeof error === "string" ? error : `HTTP ${String(response.status)}`;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const TokenResponse = Schema.Struct({
  token_type: Schema.String.check(
    Schema.makeFilter((type: string) => type.toLowerCase() === "bearer"),
  ),
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  id_token: Schema.optional(Schema.NonEmptyString),
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: Schema.optional(Schema.String),
  earliest_refresh_at: Schema.optional(
    Schema.Union([Schema.Finite, Schema.String]),
  ),
});

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string | undefined;
  expiresAt: number;
  earliestRefreshAt: number | undefined;
  scopes: string[] | undefined;
}

/** Parses a token response, or undefined when it's unusable. */
export function parseTokens(body: unknown): TokenSet | undefined {
  const parsed = Schema.decodeUnknownResult(TokenResponse)(body);
  if (Result.isFailure(parsed)) return undefined;
  const tokens = parsed.success;
  const earliest = tokens.earliest_refresh_at;
  const earliestMs =
    earliest === undefined
      ? undefined
      : typeof earliest === "number"
        ? earliest * 1000
        : Date.parse(earliest);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    earliestRefreshAt: Number.isFinite(earliestMs) ? earliestMs : undefined,
    scopes: tokens.scope?.split(" ").filter(Boolean),
  };
}

export interface Identity {
  subject: string;
  email: string | undefined;
}

/** Verifies an id_token: signature, issuer, audience, expiry, subject and (at sign-in) the nonce. */
export async function verifyIdToken(
  openai: OpenAI,
  idToken: string,
  clientId: string,
  nonce: string | undefined,
): Promise<Identity> {
  try {
    const { payload } = await jwtVerify(idToken, openai.keys, {
      issuer: openai.issuer,
      audience: clientId,
      algorithms: ["RS256", "ES256"],
      requiredClaims:
        nonce === undefined ? ["sub", "exp"] : ["sub", "exp", "nonce"],
      clockTolerance: 5,
    });
    if (nonce !== undefined && payload.nonce !== nonce)
      throw new Error("nonce mismatch");
    return {
      subject: payload.sub ?? "",
      email:
        typeof payload["email"] === "string" ? payload["email"] : undefined,
    };
  } catch (error) {
    throw new ChatGptError(
      "verify",
      "ChatGPT sign-in couldn't be verified. Start again.",
      {
        cause: error,
      },
    );
  }
}

export const hasPlanUse = (scopes: readonly string[]): boolean =>
  scopes.includes(PLAN_USE_SCOPE);
