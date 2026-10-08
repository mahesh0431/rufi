// Backups of the record: a copy of the database made while Rufi keeps
// working, checked before it counts, kept in `backups/` in the data folder.
// A backup holds the database only, never the sign-in, the AI's files, logs
// or locks (docs/adr/0008). The running Rufi makes one a day.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { errorCode, type Log } from "../../platform/logs.ts";
import { databasePath, openReadOnly } from "./database.ts";

export const backupsPath = (home: string) => join(home, "backups");

/** A backup's own small record, next to its copy of the database. */
const BackupRecord = Schema.Struct({
  format: Schema.Literal("rufi-backup"),
  version: Schema.Literal(1),
  createdAt: Schema.String,
  database: Schema.Struct({
    file: Schema.Literal("rufi.sqlite"),
    bytes: Schema.Int,
    sha256: Schema.String,
  }),
});
export type BackupRecord = typeof BackupRecord.Type;

/** A copy or a backup that didn't pass its check; the message says why. */
export class CheckFailed extends Error {}

/** All pages in one step: one read of the database, so a save is in whole or not at all. */
const ALL_PAGES = 2_147_483_647;

/** SQLite's online copy: where a backup meets the disk. */
type Copy = typeof backup;

/**
 * Copies the database at `from` to `to`, a path where nothing is yet (the
 * copy replaces what is there), as one consistent read while Rufi keeps
 * writing, then checks the copy. The copy is a single file.
 */
export async function copyDatabase(
  from: string,
  to: string,
  copy: Copy = backup,
): Promise<void> {
  const source = new DatabaseSync(from, { readOnly: true });
  try {
    await copy(source, to, { rate: ALL_PAGES });
  } finally {
    source.close();
  }
  const made = new DatabaseSync(to);
  try {
    made.exec("PRAGMA journal_mode = DELETE");
  } finally {
    made.close();
  }
  checkDatabase(to);
}

/** The database opens as Rufi's, and SQLite's integrity and foreign-key checks pass. */
export function checkDatabase(path: string): void {
  let store;
  try {
    store = openReadOnly(path);
  } catch (error) {
    throw new CheckFailed("The copy of the record can't be opened.", {
      cause: error,
    });
  }
  if (!store) throw new CheckFailed("The copy of the record isn't there.");
  try {
    const integrity = store.db.prepare("PRAGMA integrity_check").all();
    if (
      integrity.length !== 1 ||
      (integrity[0] as { integrity_check?: unknown }).integrity_check !== "ok"
    ) {
      throw new CheckFailed("The copy of the record is damaged.");
    }
    if (store.db.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new CheckFailed("The copy of the record has broken links.");
    }
  } finally {
    store.close();
  }
}

export async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Checks a backup folder: its record is readable, its database is the one
 * the record names (size and hash), and the database passes its checks.
 */
export async function verifyBackup(folder: string): Promise<BackupRecord> {
  let record: BackupRecord;
  try {
    record = Schema.decodeUnknownSync(BackupRecord)(
      JSON.parse(await readFile(join(folder, "backup.json"), "utf8")),
    );
  } catch (error) {
    throw new CheckFailed(
      `${folder} isn't a Rufi backup: its backup.json is missing or not readable.`,
      {
        cause: error,
      },
    );
  }
  const database = join(folder, record.database.file);
  const found = await stat(database).catch(() => undefined);
  if (
    found?.size !== record.database.bytes ||
    (await sha256(database)) !== record.database.sha256
  ) {
    throw new CheckFailed(
      `The backup in ${folder} isn't as it was made: its rufi.sqlite is missing or changed.`,
    );
  }
  checkDatabase(database);
  return record;
}

export interface Backup {
  /** Its folder's name in `backups/`. */
  name: string;
  createdAt: Date;
}

const NAME = /^\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?$/;
const STAGING = ".staging-";

/** A folder name for a backup made at `at`, in local time: 2026-10-08-091403. */
function nameFor(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
}

/**
 * Makes a backup: copies the database into a new private staging folder,
 * checks it, writes its record, checks it all again, and only then gives it
 * its name in `backups/`. A failed or stopped one leaves only staging,
 * which never counts.
 */
export async function makeBackup(
  home: string,
  now: Date,
  copy: Copy = backup,
): Promise<Backup> {
  const folder = backupsPath(home);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(folder, STAGING));
  try {
    const database = join(staging, "rufi.sqlite");
    await copyDatabase(databasePath(home), database, copy);
    const record: BackupRecord = {
      format: "rufi-backup",
      version: 1,
      createdAt: now.toISOString(),
      database: {
        file: "rufi.sqlite",
        bytes: (await stat(database)).size,
        sha256: await sha256(database),
      },
    };
    await writeFile(
      join(staging, "backup.json"),
      `${JSON.stringify(record, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await verifyBackup(staging);
    const taken = new Set(await readdir(folder));
    let name = nameFor(now);
    for (let n = 2; taken.has(name); n++) name = `${nameFor(now)}-${String(n)}`;
    await rename(staging, join(folder, name));
    return { name, createdAt: now };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** The backups Rufi made, newest first. Staging and other folders don't count. */
export async function listBackups(home: string): Promise<Backup[]> {
  let names: string[];
  try {
    names = await readdir(backupsPath(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: Backup[] = [];
  for (const name of names.filter((n) => NAME.test(n))) {
    try {
      const { createdAt } = Schema.decodeUnknownSync(BackupRecord)(
        JSON.parse(
          await readFile(join(backupsPath(home), name, "backup.json"), "utf8"),
        ),
      );
      found.push({ name, createdAt: new Date(createdAt) });
    } catch {
      // Not one of Rufi's backups: it is left alone, and doesn't count.
      continue;
    }
  }
  // Made at the same time: the later name (…-2 after …) is the newer.
  return found.sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() ||
      b.name.localeCompare(a.name, "en", { numeric: true }),
  );
}

const day = (at: Date) =>
  `${String(at.getFullYear())}-${String(at.getMonth())}-${String(at.getDate())}`;
/** The Monday that starts the week, in local time. */
const week = (at: Date) => {
  const monday = new Date(at);
  monday.setDate(at.getDate() - ((at.getDay() + 6) % 7));
  return day(monday);
};

/**
 * The backups to keep: the newest of each of the last 7 days that had one,
 * and of each of the last 4 weeks that had one. Days without a backup don't
 * count, so a long closure never removes the last good ones.
 */
function toKeep(backups: readonly Backup[]): Set<string> {
  const newest = [...backups].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const keep = new Set<string>();
  for (const [bucket, count] of [
    [day, 7],
    [week, 4],
  ] as const) {
    const seen = new Set<string>();
    for (const backup of newest) {
      const key = bucket(backup.createdAt);
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > count) break;
      keep.add(backup.name);
    }
  }
  return keep;
}

/** Whether a backup passes its check now. */
const usable = (home: string, { name }: Backup) =>
  verifyBackup(join(backupsPath(home), name)).then(
    () => true,
    () => false,
  );

/**
 * Removes the backups no longer kept. Called only after a new one passed its
 * check. Only backups that pass theirs count; a damaged one is left alone.
 */
async function prune(home: string): Promise<void> {
  const backups: Backup[] = [];
  for (const backup of await listBackups(home)) {
    if (await usable(home, backup)) backups.push(backup);
  }
  const keep = toKeep(backups);
  for (const { name } of backups) {
    if (!keep.has(name)) {
      await rm(join(backupsPath(home), name), { recursive: true, force: true });
    }
  }
}

/** Removes what a stopped backup left. Only while Rufi holds the data folder. */
async function cleanStaging(home: string): Promise<void> {
  const names = await readdir(backupsPath(home)).catch(() => []);
  for (const name of names.filter((n) => n.startsWith(STAGING))) {
    await rm(join(backupsPath(home), name), { recursive: true, force: true });
  }
}

/** SQLite's result code for a full disk or database. */
const SQLITE_FULL = 13;

/** Why a backup failed, in the person's words. */
function failureReason(error: unknown): string {
  if (error instanceof CheckFailed) return "the copy didn't pass its check";
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return "the backups folder can't be written";
  }
  // An extended SQLite code keeps the primary one in its low byte.
  if (
    code === "ENOSPC" ||
    (typeof errcode === "number" && (errcode & 0xff) === SQLITE_FULL)
  ) {
    return "the disk is full";
  }
  return `something went wrong (${errorCode(error)})`;
}

export interface BackupStatus {
  last: Backup | undefined;
  /** The last failed attempt, when it is newer than the last good backup. */
  failed: { at: Date; reason: string } | undefined;
  running: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The running Rufi's backups: one at every start, then whenever the newest
 * turns a day old (looked at every hour, so a Mac that slept catches up).
 * One backup at a time. The status lives in memory: after a restart, the
 * start's own backup says whether backups work.
 */
export function backupJob(
  home: string,
  log: Log,
  options: { now?: () => Date; copy?: Copy } = {},
) {
  const now = options.now ?? (() => new Date());
  /** The start's work or a backup, which Back up now and the hourly look join. */
  let running: Promise<Backup> | undefined;
  /** The newest backup that passed its check when last looked at. */
  let last: Backup | undefined;
  let failed: BackupStatus["failed"];
  /** The hourly look's check of the backups; a backup waits for it. */
  let finding: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let looking: Promise<void> | undefined;

  const fail = (error: unknown, reason = failureReason(error)) => {
    failed = { at: now(), reason };
    log("backup.failed", { error: errorCode(error) });
  };

  const attempt = async (): Promise<Backup> => {
    const started = Date.now();
    try {
      const made = await makeBackup(home, now(), options.copy);
      last = made;
      failed = undefined;
      log("backup.made", { ms: Date.now() - started });
      await prune(home);
      return made;
    } catch (error) {
      fail(error);
      throw error;
    }
  };

  const run = (work: () => Promise<Backup>): Promise<Backup> => {
    running ??= work().finally(() => {
      running = undefined;
    });
    return running;
  };

  /** Finds the newest backup that passes its check; one that doesn't is a failure. */
  const findLast = async () => {
    try {
      for (const backup of await listBackups(home)) {
        if (await usable(home, backup)) {
          last = backup;
          return;
        }
        fail(new CheckFailed(backup.name), "a backup is damaged or incomplete");
      }
      last = undefined;
    } catch (error) {
      fail(error);
    }
  };

  const whenDue = async () => {
    if (running) return;
    finding = findLast();
    await finding;
    finding = undefined;
    if (last && now().getTime() - last.createdAt.getTime() < DAY_MS) return;
    // A failure is kept in the status and the log; the next look tries again.
    await run(attempt).catch(() => undefined);
  };

  return {
    /**
     * Cleans up after a stopped backup, finds the last good one and makes a
     * new one, in the background; then keeps looking every hour. Nothing
     * here can stop Rufi from starting: a failure goes to the status.
     */
    start: () => {
      run(async () => {
        await cleanStaging(home).catch((error: unknown) => {
          fail(error);
        });
        await findLast();
        return attempt();
      }).catch(() => undefined);
      timer = setInterval(() => {
        looking ??= whenDue().finally(() => {
          looking = undefined;
        });
      }, HOUR_MS);
      timer.unref();
    },
    /** A backup now, or the one already running. */
    backUp: () =>
      run(async () => {
        await finding;
        return attempt();
      }),
    status: (): BackupStatus => ({
      last,
      failed:
        failed && (!last || failed.at > last.createdAt) ? failed : undefined,
      running: running !== undefined,
    }),
    /** Stops looking, and waits for a look or a backup under way. */
    close: async () => {
      clearInterval(timer);
      await looking;
      await running?.catch(() => undefined);
    },
  };
}

export type BackupJob = ReturnType<typeof backupJob>;
