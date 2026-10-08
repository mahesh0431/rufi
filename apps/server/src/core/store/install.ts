// Whether a data folder holds a record, so Rufi never starts over without
// one. A marker is written right after the database is first made; a folder
// with the marker and no database has lost its record, and Rufi stops
// instead of starting empty. A folder with neither is new.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writePrivateJson } from "../../platform/files.ts";
import { databasePath, openWritable, type Store } from "./database.ts";

/** Says a record was made in this folder. */
export const markerPath = (home: string) => join(home, "installed.json");

/** There while a restore puts a backup into this folder (./restore.ts). */
export const restoringPath = (home: string) => join(home, "restoring");

/**
 * Opens the record for the running Rufi, which holds rufi.lock: creates it
 * in a new folder, and refuses a folder whose record was lost or whose
 * restore didn't finish.
 */
export async function openRecord(home: string): Promise<Store> {
  if (existsSync(restoringPath(home))) {
    throw new Error(
      `A restore into ${home} didn't finish, so Rufi won't open it. Delete that folder and restore again (Help: Backups and export).`,
    );
  }
  const database = databasePath(home);
  const marked = existsSync(markerPath(home));
  if (marked && !existsSync(database)) {
    throw new Error(
      `Rufi's record is missing from ${home}: rufi.sqlite isn't there. Rufi won't start empty in its place. To bring it back, restore your last backup into a new folder (Help: Backups and export).`,
    );
  }
  const store = openWritable(database);
  if (!marked) {
    try {
      await writePrivateJson(markerPath(home), {
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      store.close();
      throw error;
    }
  }
  return store;
}
