// What the sign-in accepts from files, the Keychain and OpenAI. Saved data
// keeps its format, so an existing sign-in stays valid.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memorySecrets } from "../../../tests/fakes.ts";
import { readCredentials, readRegistration } from "./account.ts";
import { parseTokens, type ChatGptDeps } from "./openai.ts";

const registration = {
  hostId: "urn:uuid:0b6f2c3e-1f1a-4c55-9a43-0d6c1f3f9e10",
  clientId: "oaiapp_fictional",
  subject: "user-fictional",
  email: "asha@example.com",
};

const credentials = {
  clientId: "oaiapp_fictional",
  subject: "user-fictional",
  scopes: ["openid", "offline_access"],
  accessToken: "access",
  refreshToken: "refresh",
  idToken: "id",
  expiresAt: 1_790_000_000_000,
};

async function homeWith(registrationFile: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "rufi-account-"));
  await writeFile(join(home, "chatgpt.json"), JSON.stringify(registrationFile));
  return home;
}

describe("the saved registration", () => {
  it("is read as it was written", async () => {
    expect(await readRegistration(await homeWith(registration))).toEqual(
      registration,
    );
  });

  it("is damaged without a urn:uuid host id", async () => {
    const home = await homeWith({ ...registration, hostId: "1234" });
    await expect(readRegistration(home)).rejects.toThrow("is damaged");
  });
});

describe("the saved tokens", () => {
  const read = async (stored: unknown) => {
    const secrets = memorySecrets();
    secrets.values.set(registration.hostId, JSON.stringify(stored));
    const deps: ChatGptDeps = {
      home: "",
      secrets,
      issuer: "",
      sleep: () => Promise.resolve(),
    };
    return readCredentials(deps, registration);
  };

  it("are read as they were written", async () => {
    expect(await read(credentials)).toEqual(credentials);
  });

  it("don't count when a field is missing or has the wrong type", async () => {
    const { idToken: _, ...missing } = credentials;
    expect(await read(missing)).toBeUndefined();
    expect(await read({ ...credentials, expiresAt: "soon" })).toBeUndefined();
  });
});

describe("a token response", () => {
  const response = {
    token_type: "Bearer",
    access_token: "access",
    refresh_token: "refresh",
    expires_in: 3600,
  };

  it("is accepted with any case of bearer, and both forms of earliest_refresh_at", () => {
    expect(parseTokens({ ...response, token_type: "bearer" })).toBeDefined();
    expect(
      parseTokens({ ...response, earliest_refresh_at: 1_790_000_000 })
        ?.earliestRefreshAt,
    ).toBe(1_790_000_000_000);
    expect(
      parseTokens({
        ...response,
        earliest_refresh_at: "2026-10-04T09:00:00Z",
      })?.earliestRefreshAt,
    ).toBe(Date.parse("2026-10-04T09:00:00Z"));
  });

  it("is refused when it isn't a usable bearer token", () => {
    for (const bad of [
      { ...response, token_type: "mac" },
      { ...response, access_token: "" },
      { ...response, expires_in: 0 },
      { ...response, expires_in: 1.5 },
      { ...response, refresh_token: undefined },
    ]) {
      expect(parseTokens(bad)).toBeUndefined();
    }
  });
});
