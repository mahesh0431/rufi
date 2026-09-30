import { AsyncEntry } from "@napi-rs/keyring";

/** A small secret store; the macOS Keychain in the app, an in-memory map in tests. */
export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export function keychain(service: string): SecretStore {
  const entry = (account: string) => new AsyncEntry(service, account);
  return {
    // The library returns null for a missing item, despite its types.
    get: async (account) => (await entry(account).getPassword()) ?? undefined,
    set: (account, value) => entry(account).setPassword(value),
    async delete(account) {
      // false only means there was nothing to delete.
      await entry(account).deletePassword();
    },
  };
}
