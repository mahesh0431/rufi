// Test fakes, injected where the CLI injects the real Keychain and OpenAI.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type { SecretStore } from "../src/platform/keychain.ts";

export function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: (account) => Promise.resolve(values.get(account)),
    set: (account, value) => {
      values.set(account, value);
      return Promise.resolve();
    },
    delete: (account) => {
      values.delete(account);
      return Promise.resolve();
    },
  };
}

export const FULL_SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

/** How the fake misbehaves in a test. */
export interface Tamper {
  state?: string;
  nonce?: string;
  omitNonce?: boolean;
  audience?: string;
  issuer?: string;
  omitSub?: boolean;
  expired?: boolean;
  untrustedKey?: boolean;
  /** Replaces or removes (null) the client_id on the callback. */
  callbackClientId?: string | null;
  foreignTokenEndpoint?: boolean;
}

interface Pending {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
}

/** A local stand-in for auth.openai.com that checks requests the way the docs describe. */
export async function fakeOpenAI() {
  const key = await generateKeyPair("RS256");
  const untrusted = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "k1",
    alg: "RS256",
    use: "sig",
  };
  const codes = new Map<string, Pending>();
  const refreshTokens = new Map<string, string>(); // token -> client id
  const fake = {
    issuer: "",
    issuedClientId: "oaiapp_test",
    subject: "user-amma",
    email: "amma@example.com",
    scope: FULL_SCOPE,
    tamper: {} as Tamper,
    /** Queued replies for /token, used before normal behaviour. */
    tokenReplies: [] as { status: number; body?: unknown }[],
    revokeStatuses: [] as number[],
    discoveryStatuses: [] as number[],
    authorize: [] as URLSearchParams[],
    token: [] as URLSearchParams[],
    revoke: [] as URLSearchParams[],
    /** Plays the browser: follows the authorize redirect to Rufi's callback. */
    async browser(link: string): Promise<void> {
      const response = await fetch(link, { redirect: "manual" });
      const location = response.headers.get("location");
      if (location) await fetch(location);
    },
    close: () =>
      new Promise<void>((done) =>
        server.close(() => {
          done();
        }),
      ),
  };

  /** A signed id_token; renewals pass no nonce. */
  async function idToken(clientId: string, nonce?: string): Promise<string> {
    const t = fake.tamper;
    const claims: Record<string, unknown> = { email: fake.email };
    if (nonce !== undefined && !t.omitNonce) claims["nonce"] = t.nonce ?? nonce;
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(t.issuer ?? fake.issuer)
      .setAudience(t.audience ?? clientId)
      .setIssuedAt()
      .setExpirationTime(
        Math.floor(Date.now() / 1000) + (t.expired ? -60 : 3600),
      );
    if (!t.omitSub) jwt = jwt.setSubject(fake.subject);
    const signingKey: CryptoKey = t.untrustedKey
      ? untrusted.privateKey
      : key.privateKey;
    return jwt.sign(signingKey);
  }

  function tokens(clientId: string, id?: string) {
    const refresh = `rt-${randomBytes(8).toString("hex")}`;
    refreshTokens.set(refresh, clientId);
    return {
      token_type: "Bearer",
      access_token: `at-${randomBytes(8).toString("hex")}`,
      refresh_token: refresh,
      expires_in: 3600,
      scope: fake.scope,
      ...(id ? { id_token: id } : {}),
    };
  }

  interface Reply {
    status: number;
    body?: unknown;
    location?: string;
  }
  const reply = (status: number, body?: unknown): Reply => ({ status, body });

  async function handle(request: IncomingMessage): Promise<Reply> {
    const url = new URL(request.url ?? "/", fake.issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      const status = fake.discoveryStatuses.shift() ?? 200;
      if (status !== 200) return reply(status);
      return reply(200, {
        issuer: fake.issuer,
        authorization_endpoint: `${fake.issuer}/authorize`,
        token_endpoint: fake.tamper.foreignTokenEndpoint
          ? "https://evil.example/token"
          : `${fake.issuer}/token`,
        jwks_uri: `${fake.issuer}/jwks`,
        revocation_endpoint: `${fake.issuer}/revoke`,
      });
    }
    if (url.pathname === "/jwks") return reply(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const q = url.searchParams;
      fake.authorize.push(q);
      const registering = q.get("client_id") === "dynamic_agent_client";
      const clientId = registering
        ? fake.issuedClientId
        : (q.get("client_id") ?? "");
      const code = `code-${randomBytes(8).toString("hex")}`;
      codes.set(code, {
        clientId,
        redirectUri: q.get("redirect_uri") ?? "",
        challenge: q.get("code_challenge") ?? "",
        nonce: q.get("nonce") ?? "",
      });
      const back = new URL(q.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", fake.tamper.state ?? q.get("state") ?? "");
      const returnedId =
        fake.tamper.callbackClientId !== undefined
          ? fake.tamper.callbackClientId
          : registering
            ? clientId
            : null;
      if (returnedId !== null) back.searchParams.set("client_id", returnedId);
      return { status: 302, location: back.toString() };
    }
    const form = new URLSearchParams(await body(request));
    if (url.pathname === "/token") {
      fake.token.push(form);
      const queued = fake.tokenReplies.shift();
      if (queued) return reply(queued.status, queued.body);
      if (form.get("resource") !== "https://api.openai.com/v1") {
        return reply(400, { error: "invalid_target" });
      }
      if (form.get("grant_type") === "authorization_code") {
        const pending = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          !pending ||
          pending.clientId !== form.get("client_id") ||
          pending.redirectUri !== form.get("redirect_uri") ||
          pending.challenge !== challenge
        ) {
          return reply(400, { error: "invalid_grant" });
        }
        const id = await idToken(pending.clientId, pending.nonce);
        return reply(200, tokens(pending.clientId, id));
      }
      if (form.get("grant_type") === "refresh_token") {
        const old = form.get("refresh_token") ?? "";
        if (
          refreshTokens.get(old) !== form.get("client_id") ||
          form.has("scope")
        ) {
          return reply(400, { error: "invalid_grant" });
        }
        refreshTokens.delete(old);
        const clientId = form.get("client_id") ?? "";
        return reply(200, tokens(clientId, await idToken(clientId)));
      }
      return reply(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/revoke") {
      fake.revoke.push(form);
      const status = fake.revokeStatuses.shift() ?? 200;
      if (status === 200) refreshTokens.delete(form.get("token") ?? "");
      return reply(status);
    }
    return reply(404);
  }

  const server = createServer((request, response) => {
    handle(request).then(
      ({ status, body, location }) => {
        response.writeHead(status, {
          "content-type": "application/json",
          ...(location ? { location } : {}),
        });
        response.end(body === undefined ? "" : JSON.stringify(body));
      },
      (error: unknown) => {
        response.writeHead(500);
        response.end(String(error));
      },
    );
  });
  await new Promise<void>((listening) =>
    server.listen(0, "127.0.0.1", listening),
  );
  fake.issuer = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return fake;
}

function body(request: IncomingMessage): Promise<string> {
  return new Promise((done, failed) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (text += chunk));
    request.on("end", () => {
      done(text);
    });
    request.on("error", failed);
  });
}
