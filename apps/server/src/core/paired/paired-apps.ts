// Paired apps (docs/adr/0032): an app given its own key for one person for
// good. The key is made here and shown once; the record keeps only its
// hash, so whoever holds the key acts as that person, and only that person.
// A revoked app never matches its key again.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PairedApp } from "@rufi/contracts/remote";
import { v7 as uuid } from "uuid";
import type { Store } from "../store/database.ts";

/** The data folder's id, made at the first pairing; a restored copy keeps it. */
const FOLDER_SETTING = "remote.folder";

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

/** The app a key belongs to, while it isn't revoked. */
export interface KeyHolder {
  id: string;
  person: { id: string; name: string };
  lastSeenAt: string | null;
}

export type PairedApps = ReturnType<typeof pairedApps>;

export function pairedApps(store: Store, now: () => string) {
  const { query } = store;
  return {
    /**
     * Pairs a new app for `personId`, in one transaction with the folder's
     * id when it has none yet. Gives the key, the only time it exists
     * outside the app.
     */
    add: async (personId: string, name: string) => {
      const key = randomBytes(32).toString("base64url");
      const id = uuid();
      return query.transaction().execute(async (trx) => {
        const person = await trx
          .selectFrom("people")
          .select(["id", "display_name"])
          .where("id", "=", personId)
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("paired_apps")
          .values({
            id,
            person_id: personId,
            kind: "iphone",
            name,
            key_sha256: hashOf(key),
            paired_at: now(),
          })
          .execute();
        await trx
          .insertInto("settings")
          .values({ key: FOLDER_SETTING, value: randomUUID() })
          .onConflict((oc) => oc.column("key").doNothing())
          .execute();
        const { value: folder } = await trx
          .selectFrom("settings")
          .select("value")
          .where("key", "=", FOLDER_SETTING)
          .executeTakeFirstOrThrow();
        return {
          key,
          app: { id },
          person: { id: person.id, name: person.display_name },
          folder,
        };
      });
    },

    /** The app `key` belongs to; none when it is unknown or revoked. */
    byKey: async (key: string): Promise<KeyHolder | undefined> => {
      const row = await query
        .selectFrom("paired_apps")
        .innerJoin("people", "people.id", "paired_apps.person_id")
        .select([
          "paired_apps.id",
          "paired_apps.person_id",
          "people.display_name",
          "paired_apps.last_seen_at",
        ])
        .where("paired_apps.key_sha256", "=", hashOf(key))
        .where("paired_apps.revoked_at", "is", null)
        .executeTakeFirst();
      return (
        row && {
          id: row.id,
          person: { id: row.person_id, name: row.display_name },
          lastSeenAt: row.last_seen_at,
        }
      );
    },

    /** Marks the app seen now, at most once a minute. */
    seen: async (app: KeyHolder) => {
      const at = now();
      if (
        app.lastSeenAt !== null &&
        Date.parse(at) - Date.parse(app.lastSeenAt) < 60_000
      ) {
        return;
      }
      await query
        .updateTable("paired_apps")
        .set({ last_seen_at: at })
        .where("id", "=", app.id)
        .execute();
    },

    /** The apps paired and not revoked, the first paired first. */
    list: async (): Promise<PairedApp[]> =>
      (
        await query
          .selectFrom("paired_apps")
          .innerJoin("people", "people.id", "paired_apps.person_id")
          .select([
            "paired_apps.id",
            "paired_apps.kind",
            "paired_apps.name",
            "paired_apps.person_id",
            "people.display_name",
            "paired_apps.paired_at",
            "paired_apps.last_seen_at",
          ])
          .where("paired_apps.revoked_at", "is", null)
          .orderBy("paired_apps.paired_at")
          .execute()
      ).map((row) => ({
        id: row.id,
        kind: row.kind as PairedApp["kind"],
        name: row.name,
        person: { id: row.person_id, name: row.display_name },
        pairedAt: row.paired_at,
        lastSeenAt: row.last_seen_at,
      })),

    /** Revokes the app; false when it was unknown or revoked already. */
    revoke: async (id: string): Promise<boolean> => {
      const { numUpdatedRows } = await query
        .updateTable("paired_apps")
        .set({ revoked_at: now() })
        .where("id", "=", id)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return numUpdatedRows > 0n;
    },

    /** The data folder's id; none before the first pairing. */
    folder: async (): Promise<string | undefined> =>
      (
        await query
          .selectFrom("settings")
          .select("value")
          .where("key", "=", FOLDER_SETTING)
          .executeTakeFirst()
      )?.value,
  };
}
