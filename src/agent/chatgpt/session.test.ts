import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeOpenAI, memorySecrets } from "../../../tests/fakes.ts";
import type { Credentials } from "./account.ts";
import type { ChatGptDeps } from "./openai.ts";
import { accessToken, signOut, status } from "./session.ts";
import { signIn } from "./signin.ts";

let openai: Awaited<ReturnType<typeof fakeOpenAI>>;
let secrets: ReturnType<typeof memorySecrets>;
let deps: ChatGptDeps;
let hostId: string;

beforeEach(async () => {
  openai = await fakeOpenAI();
  secrets = memorySecrets();
  deps = {
    home: await mkdtemp(join(tmpdir(), "rufi-session-")),
    secrets,
    issuer: openai.issuer,
    sleep: () => Promise.resolve(),
  };
  await signIn(deps, {
    showLink: () => undefined,
    openBrowser: (link) => void openai.browser(link),
  });
  hostId = (
    JSON.parse(await readFile(join(deps.home, "chatgpt.json"), "utf8")) as {
      hostId: string;
    }
  ).hostId;
  openai.token.length = 0;
});
afterEach(() => openai.close());

const stored = (): Credentials =>
  JSON.parse(secrets.values.get(hostId) ?? "null") as Credentials;
const store = (change: Partial<Credentials>) =>
  secrets.values.set(hostId, JSON.stringify({ ...stored(), ...change }));
const nearExpiry = () => store({ expiresAt: Date.now() + 30_000 });

describe("access token", () => {
  it("returns the current token without renewing while it has time left", async () => {
    await expect(accessToken(deps)).resolves.toBe(stored().accessToken);
    expect(openai.token).toHaveLength(0);
  });

  it("renews near expiry with the documented request and keeps the rotated refresh token", async () => {
    nearExpiry();
    const before = stored();
    const token = await accessToken(deps);

    expect(Object.fromEntries(openai.token[0] ?? [])).toEqual({
      grant_type: "refresh_token",
      client_id: "oaiapp_test",
      refresh_token: before.refreshToken,
      resource: "https://api.openai.com/v1",
    });
    expect(token).not.toBe(before.accessToken);
    expect(stored().accessToken).toBe(token);
    expect(stored().refreshToken).not.toBe(before.refreshToken);
    expect(stored().idToken).not.toBe(before.idToken);
  });

  it("keeps the saved id_token when the renewed one doesn't verify", async () => {
    nearExpiry();
    const before = stored();
    openai.tamper = { untrustedKey: true };
    const token = await accessToken(deps);
    expect(stored()).toMatchObject({
      accessToken: token,
      idToken: before.idToken,
    });
  });

  it("ends the sign-in when a renewal names a different account", async () => {
    nearExpiry();
    openai.subject = "someone-else";
    await expect(accessToken(deps)).rejects.toThrow("different account");
    expect(secrets.values.size).toBe(0);
  });

  it("renews once when two callers ask at the same time", async () => {
    nearExpiry();
    const [a, b] = await Promise.all([accessToken(deps), accessToken(deps)]);
    expect(a).toBe(b);
    expect(openai.token).toHaveLength(1);
  });

  it("honours earliest_refresh_at", async () => {
    store({
      expiresAt: Date.now() + 30_000,
      earliestRefreshAt: Date.now() + 60_000,
    });
    await expect(accessToken(deps)).resolves.toBe(stored().accessToken);
    store({ expiresAt: Date.now() - 1_000 });
    await expect(accessToken(deps)).rejects.toThrow(
      "can't renew the sign-in yet",
    );
    expect(openai.token).toHaveLength(0);
  });

  it.each([
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
  ])("%s ends the sign-in but keeps the registration", async (error) => {
    nearExpiry();
    openai.tokenReplies.push({ status: 400, body: { error } });
    await expect(accessToken(deps)).rejects.toThrow("sign-in has ended");
    expect(secrets.values.size).toBe(0);
    expect(await status(deps)).toMatchObject({
      signedIn: false,
      email: "amma@example.com",
    });
  });

  it("keeps the tokens on invalid_client and on a lasting outage", async () => {
    nearExpiry();
    openai.tokenReplies.push({
      status: 401,
      body: { error: "invalid_client" },
    });
    await expect(accessToken(deps)).rejects.toThrow("invalid_client");
    openai.tokenReplies.push({ status: 503 }, { status: 503 }, { status: 503 });
    await expect(accessToken(deps)).rejects.toThrow("Try again shortly");
    expect((await status(deps)).signedIn).toBe(true);
  });

  it("retries a brief outage", async () => {
    nearExpiry();
    openai.tokenReplies.push({ status: 503 }, { status: 502 });
    await expect(accessToken(deps)).resolves.toMatch(/^at-/);
    expect(openai.token).toHaveLength(3);
  });

  it("doesn't replay a refresh token after an unusable renewal", async () => {
    nearExpiry();
    openai.tokenReplies.push({
      status: 200,
      body: { token_type: "Bearer", access_token: "at-x", expires_in: 3600 },
    });
    await expect(accessToken(deps)).rejects.toThrow("unusable renewal");
    expect(secrets.values.size).toBe(0);
  });

  it("refuses a token once plan use is no longer granted", async () => {
    nearExpiry();
    openai.scope = "openid profile email offline_access resource.invoke";
    await expect(accessToken(deps)).rejects.toThrow("plan use isn't allowed");
    expect(await status(deps)).toMatchObject({
      signedIn: true,
      planUse: false,
    });
    await expect(accessToken(deps)).rejects.toThrow("plan use isn't allowed");
  });

  it("ignores tokens stored for another client id", async () => {
    store({ clientId: "oaiapp_old" });
    await expect(accessToken(deps)).rejects.toThrow("Not signed in");
  });
});

describe("sign-out", () => {
  it("revokes the refresh token, clears the tokens and keeps the registration", async () => {
    const refresh = stored().refreshToken;
    await expect(signOut(deps)).resolves.toEqual({
      wasSignedIn: true,
      revoked: true,
    });
    expect(Object.fromEntries(openai.revoke[0] ?? [])).toEqual({
      token: refresh,
      token_type_hint: "refresh_token",
      client_id: "oaiapp_test",
    });
    expect(secrets.values.size).toBe(0);
    expect(await status(deps)).toMatchObject({
      signedIn: false,
      email: "amma@example.com",
    });
  });

  it("retries a brief outage, then signs in again without a hint", async () => {
    openai.revokeStatuses.push(503);
    await expect(signOut(deps)).resolves.toEqual({
      wasSignedIn: true,
      revoked: true,
    });
    await signIn(deps, {
      showLink: () => undefined,
      openBrowser: (link) => void openai.browser(link),
    });
    const q = openai.authorize.at(-1);
    expect(q?.get("client_id")).toBe("oaiapp_test");
    expect(q?.has("id_token_hint")).toBe(false);
  });

  it("clears locally and says so when revocation can't be confirmed", async () => {
    openai.revokeStatuses.push(503, 503, 503);
    await expect(signOut(deps)).resolves.toEqual({
      wasSignedIn: true,
      revoked: false,
    });
    expect(secrets.values.size).toBe(0);
  });

  it("retries a brief outage of the sign-in configuration", async () => {
    openai.discoveryStatuses.push(503);
    await expect(signOut(deps)).resolves.toEqual({
      wasSignedIn: true,
      revoked: true,
    });
  });

  it("reports a Keychain failure instead of claiming success", async () => {
    secrets.delete = () => Promise.reject(new Error("keychain locked"));
    await expect(signOut(deps)).rejects.toThrow("Keychain");
  });

  it("is harmless when not signed in", async () => {
    await signOut(deps);
    await expect(signOut(deps)).resolves.toEqual({
      wasSignedIn: false,
      revoked: false,
    });
  });
});
