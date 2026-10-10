// Whether a data folder holds a record, so Rufi never starts over without
// one. A marker is written right after the database is first made; a folder
// with the marker and no database has lost its record, and Rufi stops
// instead of starting empty. A folder with neither is new.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writePrivateJson } from "../../platform/files.ts";
import { makeBackup, upgradeBackupsPath } from "./backup.ts";
import {
  CantOpen,
  databasePath,
  openWritable,
  type Store,
} from "./database.ts";
import { inspect, migrate } from "./migrations.ts";

/** Says a record was made in this folder. */
export const markerPath = (home: string) => join(home, "installed.json");

/** There while a restore puts a backup into this folder (./restore.ts). */
export const restoringPath = (home: string) => join(home, "restoring");

/**
 * Opens the record for the running Rufi, which holds rufi.lock: creates it
 * in a new folder, and refuses a folder whose record was lost or whose
 * restore didn't finish. The startup gate: a record from a newer Rufi, or
 * one it doesn't know, is refused unchanged; an older one is backed up into
 * backups/before-upgrade, the backup checked, then upgraded in one
 * transaction (./migrations.ts). A failure at any step leaves it as it was.
 */
export async function openRecord(
  home: string,
  now: () => Date = () => new Date(),
): Promise<Store> {
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
  if (existsSync(database)) await upgrade(home, now());
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

/** Upgrades an older record, after a checked backup of it as it is. */
async function upgrade(home: string, now: Date): Promise<void> {
  const database = databasePath(home);
  const db = new DatabaseSync(database, { readOnly: true });
  let found;
  try {
    found = inspect(db);
  } finally {
    db.close();
  }
  if (found.state === "current" || found.state === "empty") return;
  if (found.state !== "older") throw new CantOpen(database, found);
  try {
    await makeBackup(home, now, { folder: upgradeBackupsPath(home) });
  } catch (error) {
    throw new Error(
      `Rufi needs to upgrade the record in ${home}, and couldn't back it up first, so it left it as it was. Check that the disk has space, and start Rufi again.`,
      { cause: error },
    );
  }
  migrate(database);
}
