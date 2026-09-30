import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FULL_SCOPE,
  fakeOpenAI,
  memorySecrets,
  type Tamper,
} from "../../../tests/fakes.ts";
import { rufiHome } from "../../platform/config.ts";
import { withLock } from "../../platform/files.ts";
import type { ChatGptDeps } from "./openai.ts";
import { status } from "./session.ts";
import { signIn, type SignInOptions } from "./signin.ts";

let openai: Awaited<ReturnType<typeof fakeOpenAI>>;
let secrets: ReturnType<typeof memorySecrets>;
let deps: ChatGptDeps;
let shown: string[];

beforeEach(async () => {
  openai = await fakeOpenAI();
  secrets = memorySecrets();
  shown = [];
  deps = {
    home: await mkdtemp(join(tmpdir(), "rufi-signin-")),
    secrets,
    issuer: openai.issuer,
    sleep: () => Promise.resolve(),
  };
});
afterEach(() => openai.close());

const options = (overrides: Partial<SignInOptions> = {}): SignInOptions => ({
  showLink: (link) => shown.push(link),
  openBrowser: (link) => openai.browser(link),
  ...overrides,
});

const registration = async () =>
  JSON.parse(await readFile(join(deps.home, "chatgpt.json"), "utf8")) as Record<
    string,
    string
  >;

describe("first sign-in", () => {
  it("registers Rufi with every required parameter and stores the tokens in the Keychain only", async () => {
    const result = await signIn(deps, options());

    expect(result).toEqual({ email: "amma@example.com", planUse: true });
    const q = openai.authorize[0];
    const params = Object.fromEntries(q ?? []);
    expect(Object.keys(params).sort()).toEqual(
      [
        "agent_name_hint",
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "ext_agent_host_id",
        "nonce",
        "redirect_uri",
        "resource",
        "response_type",
        "scope",
        "state",
      ].sort(),
    );
    expect(params).toMatchObject({
      response_type: "code",
      client_id: "dynamic_agent_client",
      agent_name_hint: "Rufi",
      scope: FULL_SCOPE,
      resource: "https://api.openai.com/v1",
      code_challenge_method: "S256",
    });
    expect(params["redirect_uri"]).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
    expect(params["ext_agent_host_id"]).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    for (const name of ["state", "nonce", "code_challenge"]) {
      expect(params[name]).toMatch(/^[\w-]{16,}$/);
    }
    const exchange = Object.fromEntries(openai.token[0] ?? []);
    expect(exchange).toMatchObject({
      grant_type: "authorization_code",
      client_id: "oaiapp_test",
      redirect_uri: q?.get("redirect_uri"),
      resource: "https://api.openai.com/v1",
    });

    const saved = await registration();
    expect(saved).toEqual({
      hostId: q?.get("ext_agent_host_id"),
      clientId: "oaiapp_test",
      subject: "user-amma",
      email: "amma@example.com",
    });
    expect((await stat(join(deps.home, "chatgpt.json"))).mode & 0o777).toBe(
      0o600,
    );
    const stored = JSON.parse(
      secrets.values.get(saved["hostId"] ?? "") ?? "{}",
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      clientId: "oaiapp_test",
      subject: "user-amma",
    });
    expect(stored["accessToken"]).toMatch(/^at-/);
    expect(JSON.stringify(saved)).not.toMatch(/at-|rt-|eyJ/);
  });

  it("uses fresh state, nonce and PKCE on every attempt", async () => {
    await signIn(deps, options());
    await signIn(deps, options());
    const [first, second] = openai.authorize;
    for (const name of ["state", "nonce", "code_challenge", "redirect_uri"]) {
      expect(first?.get(name)).not.toBe(second?.get(name));
    }
  });
});

describe("returning sign-in", () => {
  it("reuses the issued client id and sends the id_token_hint to the browser, never to the screen", async () => {
    await signIn(deps, options());
    const idToken = (
      JSON.parse(secrets.values.values().next().value ?? "{}") as {
        idToken: string;
      }
    ).idToken;
    await signIn(deps, options());

    const q = openai.authorize[1];
    expect(q?.get("client_id")).toBe("oaiapp_test");
    expect(q?.has("agent_name_hint")).toBe(false);
    expect(q?.get("id_token_hint")).toBe(idToken);
    expect(shown.join("\n")).not.toContain(idToken);
    expect(shown.join("\n")).not.toContain("id_token_hint");
  });

  it("refuses a different account and keeps the one it had", async () => {
    await signIn(deps, options());
    const before = [...secrets.values.values()];
    openai.subject = "someone-else";

    await expect(signIn(deps, options())).rejects.toThrow(
      "different ChatGPT account",
    );
    expect([...secrets.values.values()]).toEqual(before);
    expect((await registration())["subject"]).toBe("user-amma");
  });

  it("rejects a callback naming a different client id; a missing one is fine", async () => {
    await signIn(deps, options());
    openai.tamper = { callbackClientId: "oaiapp_other" };
    await expect(signIn(deps, options())).rejects.toThrow(
      "different app registration",
    );
    openai.tamper = {};
    await expect(signIn(deps, options())).resolves.toMatchObject({
      planUse: true,
    });
  });
});

describe("rejects a sign-in that can't be trusted", () => {
  const cases: [string, Tamper, string][] = [
    ["a callback with the wrong state", { state: "forged" }, "didn't match"],
    ["the wrong nonce", { nonce: "forged" }, "couldn't be verified"],
    ["no nonce", { omitNonce: true }, "couldn't be verified"],
    [
      "the wrong audience",
      { audience: "oaiapp_other" },
      "couldn't be verified",
    ],
    [
      "the wrong issuer",
      { issuer: "https://evil.example" },
      "couldn't be verified",
    ],
    [
      "an untrusted signing key",
      { untrustedKey: true },
      "couldn't be verified",
    ],
    ["an expired id_token", { expired: true }, "couldn't be verified"],
    ["no subject", { omitSub: true }, "couldn't be verified"],
    [
      "an endpoint on another origin",
      { foreignTokenEndpoint: true },
      "couldn't be verified",
    ],
    [
      "a first callback without a client id",
      { callbackClientId: null },
      "didn't register",
    ],
    [
      "a placeholder client id",
      { callbackClientId: "dynamic_agent_client" },
      "didn't register",
    ],
  ];
  it.each(cases)("%s", async (_name, tamper, message) => {
    openai.tamper = tamper;
    await expect(signIn(deps, options())).rejects.toThrow(message);
    expect(secrets.values.size).toBe(0);
    expect((await status(deps)).signedIn).toBe(false);
  });

  it.each([
    ["not Bearer", { token_type: "mac" }],
    ["no access token", { access_token: "" }],
    ["no refresh token", { refresh_token: undefined }],
    ["a bad expiry", { expires_in: -5 }],
  ])("a token response with %s", async (_name, change) => {
    openai.tokenReplies.push({
      status: 200,
      body: {
        token_type: "Bearer",
        access_token: "at-x",
        refresh_token: "rt-x",
        id_token: "x.y.z",
        expires_in: 3600,
        ...change,
      },
    });
    await expect(signIn(deps, options())).rejects.toThrow("unusable sign-in");
    expect(secrets.values.size).toBe(0);
  });
});

describe("recovery", () => {
  it("keeps a verified sign-in without plan use, then asks for consent next time", async () => {
    openai.scope = "openid profile email offline_access resource.invoke";
    await expect(signIn(deps, options())).resolves.toEqual({
      email: "amma@example.com",
      planUse: false,
    });
    expect(await status(deps)).toMatchObject({
      signedIn: true,
      planUse: false,
    });

    openai.scope = FULL_SCOPE;
    await signIn(deps, options());
    expect(openai.authorize[1]?.get("prompt")).toBe("consent");
    expect(openai.authorize[1]?.get("scope")).toBe(FULL_SCOPE);
    expect(await status(deps)).toMatchObject({ planUse: true });
  });

  it("keeps the issued client id when the first code expires, and retries with it", async () => {
    openai.tokenReplies.push({ status: 400, body: { error: "invalid_grant" } });
    await expect(signIn(deps, options())).rejects.toThrow("expired");
    expect((await registration())["clientId"]).toBe("oaiapp_test");

    await signIn(deps, options());
    expect(openai.authorize[1]?.get("client_id")).toBe("oaiapp_test");
  });

  it("gives up after the wait, closes the listener, and a later attempt works", async () => {
    await expect(
      signIn(
        deps,
        options({ openBrowser: () => Promise.resolve(), waitMs: 50 }),
      ),
    ).rejects.toThrow("in time");
    await expect(fetch(redirectFrom(shown[0]))).rejects.toThrow();
    await expect(signIn(deps, options())).resolves.toMatchObject({
      planUse: true,
    });
  });

  it("ignores other paths and methods on the listener", async () => {
    const result = signIn(
      deps,
      options({
        openBrowser: async (link) => {
          const back = new URL(redirectFrom(link));
          expect((await fetch(new URL("/favicon.ico", back))).status).toBe(404);
          expect((await fetch(back, { method: "POST" })).status).toBe(405);
          await openai.browser(link);
        },
      }),
    );
    await expect(result).resolves.toMatchObject({ planUse: true });
  });

  it("reports a Keychain failure and doesn't claim to be signed in", async () => {
    secrets.set = () => Promise.reject(new Error("keychain locked"));
    await expect(signIn(deps, options())).rejects.toThrow("Keychain");
    expect((await registration())["subject"]).toBeUndefined();
    expect((await status(deps)).signedIn).toBe(false);
  });

  it("lets only one sign-in run at a time", async () => {
    const waiting = signIn(
      deps,
      options({ openBrowser: () => Promise.resolve(), waitMs: 500 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(signIn(deps, options())).rejects.toThrow(
      "Another Rufi sign-in",
    );
    await expect(waiting).rejects.toThrow("in time");
    await expect(
      withLock(deps.home, 0, () => Promise.resolve("free")),
    ).resolves.toBe("free");
  });
});

describe("RUFI_HOME", () => {
  it("is required", () => {
    expect(() => rufiHome({})).toThrow("Set RUFI_HOME");
    expect(rufiHome({ RUFI_HOME: "/tmp/rufi-x" })).toBe("/tmp/rufi-x");
  });
});

function redirectFrom(link: string | undefined): string {
  return new URL(link ?? "").searchParams.get("redirect_uri") ?? "";
}
