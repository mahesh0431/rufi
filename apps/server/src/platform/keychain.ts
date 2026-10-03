import { AsyncEntry } from "@napi-rs/keyring";

/** A small secret store; the macOS Keychain in the app, an in-memory map in tests. */
export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

// Generous, because macOS may be asking the person to allow access.
const DEADLINE_MS = 60_000;

export function keychain(service: string): SecretStore {
  const entry = (account: string) => new AsyncEntry(service, account);
  const deadline = () => AbortSignal.timeout(DEADLINE_MS);
  return {
    // The library returns null for a missing item, despite its types.
    get: async (account) =>
      (await entry(account).getPassword(deadline())) ?? undefined,
    set: (account, value) => entry(account).setPassword(value, deadline()),
    async delete(account) {
      // false only means there was nothing to delete.
      await entry(account).deletePassword(deadline());
    },
  };
}
