// Restore: a checked backup into a new folder. The current data folder is
// never touched, and nothing in the new one is overwritten. The restored
// copy has the record and its original files only, so it starts signed out
// (docs/adr/0008).
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { holdRufiLock, sha256 } from "../../platform/files.ts";
import { copyOriginal, OriginalMissing } from "../documents/originals.ts";
import { CheckFailed, checkDatabase, filesIn, verifyBackup } from "./backup.ts";
import { databasePath } from "./database.ts";
import { markerPath, restoringPath } from "./install.ts";
import { migrate } from "./migrations.ts";

/**
 * Restores the backup in `backup` into `target`, a folder that doesn't
 * exist yet or is empty. Holds the new folder's lock throughout, so neither
 * a second restore nor Rufi can use it meanwhile. The database and every
 * original are copied into `restoring/` and checked (each original by its
 * hash), and a backup from an older Rufi is upgraded there; then it is put
 * in place with the marker; `restoring/` goes last, so a stopped restore
 * leaves it, and Rufi won't open the folder.
 */
export async function restore(
  backup: string,
  target: string,
): Promise<{ createdAt: string }> {
  const record = await verifyBackup(backup).catch((error: unknown) => {
    if (error instanceof CheckFailed || error instanceof OriginalMissing) {
      throw new Error(`Rufi didn't restore it. ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  });
  await mkdir(target, { recursive: true, mode: 0o700 });
  const lock = { lost: false };
  const release = await holdRufiLock(target, () => {
    lock.lost = true;
  });
  try {
    const there = (await readdir(target)).filter(
      (name) => name !== "rufi.lock",
    );
    if (there.length > 0) {
      throw new Error(
        `${target} isn't empty. Restore into a new folder: Rufi never restores over anything.`,
      );
    }
    const staging = restoringPath(target);
    await mkdir(staging, { mode: 0o700 });
    const staged = join(staging, "rufi.sqlite");
    await copyFile(
      join(backup, record.database.file),
      staged,
      constants.COPYFILE_EXCL,
    );
    await chmod(staged, 0o600);
    if ((await sha256(staged)) !== record.database.sha256) {
      throw new Error(
        "The copy in the new folder isn't the same as the backup. Delete the new folder and restore again.",
      );
    }
    checkDatabase(staged);
    // Only the new folder's copy is upgraded; the backup stays as it is.
    migrate(staged);
    holdQueue(staged);
    const files = join(staging, "files");
    await mkdir(files, { mode: 0o700 });
    for (const { id, size } of filesIn(staged)) {
      await copyOriginal(join(backup, "files"), files, id, size).catch(
        (error: unknown) => {
          if (!(error instanceof OriginalMissing)) throw error;
          throw new Error(
            "A document file in the backup is missing or changed. Delete the new folder, and restore an older backup.",
            { cause: error },
          );
        },
      );
    }
    if (lock.lost) {
      throw new Error(
        `Rufi lost its lock on ${target} during the restore. Delete that folder and restore again.`,
      );
    }
    // The folder was empty: nothing is there to replace.
    await rename(files, join(target, "files"));
    // A link, not a rename: it fails if a database is already there.
    await link(staged, databasePath(target));
    await writeFile(
      markerPath(target),
      `${JSON.stringify({ createdAt: new Date().toISOString(), restoredFrom: record.createdAt }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rm(staging, { recursive: true });
    return { createdAt: record.createdAt };
  } finally {
    await release().catch(() => undefined);
  }
}

/**
 * Nothing from the past runs by itself: what waited to go to the AI comes
 * back held, for the person to send again or remove, and a hand-over the
 * backup caught after the AI may have got it is not sure; one caught before
 * (while Rufi read its files) waits held too (core/chat/queue.ts).
 */
function holdQueue(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      BEGIN;
      UPDATE chat_queue SET state = 'not_sure' WHERE state = 'handing_over' AND sent_as IS NOT NULL;
      UPDATE chat_queue SET state = 'waiting', held = NULL, hold_id = NULL WHERE state = 'handing_over';
      UPDATE chat_queue SET held = 'restored', held_text = NULL, hold_id = NULL WHERE state = 'waiting';
      COMMIT;
    `);
  } finally {
    db.close();
  }
}
