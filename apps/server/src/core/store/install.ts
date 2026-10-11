// Whether a data folder holds a record, so Rufi never starts over without
// one. creating.json owns the first start before the database is made;
// installed.json is written once it is complete. An installed folder with
// no database has lost its record, and Rufi stops instead of starting empty.
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import {
  readJson,
  syncFolder,
  writePrivateJson,
} from "../../platform/files.ts";
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

/** Durable ownership of a new, not-yet-installed record; never authorizes replacing an installed or unknown record. */
export const creatingPath = (home: string) => join(home, "creating.json");
const Creating = Schema.Struct({ version: Schema.Literal(1) });

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
  const present = existsSync(database);
  const marked = existsSync(markerPath(home));
  if (marked && !present) {
    throw new Error(
      `Rufi's record is missing from ${home}: rufi.sqlite isn't there. Rufi won't start empty in its place. To bring it back, restore your last backup into a new folder (Help: Backups and export).`,
    );
  }
  const creating = await readJson(creatingPath(home));
  if (creating !== undefined) {
    try {
      Schema.decodeUnknownSync(Creating)(creating);
    } catch (error) {
      throw new Error(
        `${creatingPath(home)} is damaged, so Rufi won't resume making its record.`,
        { cause: error },
      );
    }
  }
  const resuming = creating !== undefined && !marked;
  const owned = creating !== undefined || (!marked && !present);
  if (present) await upgrade(home, now(), resuming);
  else if (!marked && creating === undefined) {
    // This is the only evidence that an empty database belongs to a first
    // start, and it must be on disk before the database can be made.
    await writePrivateJson(creatingPath(home), { version: 1 });
  }
  const store = openWritable(database, { resumeEmpty: resuming });
  try {
    if (!marked) {
      await writePrivateJson(markerPath(home), {
        createdAt: new Date().toISOString(),
      });
    }
    // installed.json is durable now. A crash before this cleanup still
    // takes the normal installed-record gate at the next start.
    if (owned) {
      for (const name of await readdir(home)) {
        if (/^(installed|creating)\.json\.[\w-]+\.tmp$/.test(name))
          await rm(join(home, name));
      }
      await rm(creatingPath(home), { force: true });
      await syncFolder(home);
    }
  } catch (error) {
    store.close();
    throw error;
  }
  return store;
}

/** Upgrades an older record, after a checked backup of it as it is. */
async function upgrade(
  home: string,
  now: Date,
  resumeEmpty: boolean,
): Promise<void> {
  const database = databasePath(home);
  // An owned first start may have died during its schema transaction.
  // SQLite needs a writable connection to roll that journal back; this
  // exception never applies to an installed or unowned record.
  const db = new DatabaseSync(database, {
    readOnly: !(resumeEmpty && existsSync(`${database}-journal`)),
  });
  let found;
  try {
    found = inspect(db);
  } finally {
    db.close();
  }
  if (found.state === "current") return;
  if (found.state === "empty" && resumeEmpty) return;
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
