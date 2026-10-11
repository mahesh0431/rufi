// Moving the data folder: `pnpm rufi move-data <folder>`, while Rufi isn't
// running. It copies the whole folder into a new empty one, checks the copy,
// and only then switches the location file; the old folder is kept, marked,
// for the person to delete. Every step leaves a state a start refuses or a
// `--finish` or `--cancel` ends; none guesses which copy is right
// (docs/adr/0016):
//
//   source             new folder               location   start opens
//   moving-out         moving-in (copying)      source     neither
//   moving-out         complete                 source     the new one, with RUFI_HOME only
//   moved-to           complete                 source     the new one, with RUFI_HOME only
//   moved-to           complete                 new        the new one
//   (none)             moving-in, cancelled     source     the source
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { rufiHomeOverride } from "../../platform/config.ts";
import {
  holdRufiLock,
  sha256,
  syncFile,
  syncFolder,
  withLocationLock,
  writePrivateJson,
} from "../../platform/files.ts";
import { checkOriginal, filesPath } from "../documents/originals.ts";
import { checkDatabase, copyDatabase, filesIn } from "./backup.ts";
import {
  locationRoot,
  managedFolder,
  type Mark,
  MOVED_TO,
  MOVING_IN,
  MOVING_OUT,
  type Place,
  readLocation,
  readMark,
  rememberFolder,
} from "./data-folder.ts";
import { databasePath } from "./database.ts";

export interface Move {
  from: string;
  to: string;
}

/**
 * Not copied: the running Rufi's locks and address, the source's own move
 * marks, and the database's files (its copy is made with SQLite's backup,
 * which takes in what its WAL holds). The AI's own folders stay too: Codex
 * keeps this folder's paths in them, and a thread resumed from a copy writes
 * to the old folder, so after a move the AI starts a fresh thread with the
 * saved chat.
 */
const NOT_COPIED = new Set([
  "rufi.lock",
  "credentials.lock",
  "core.json",
  MOVING_OUT,
  MOVED_TO,
  "rufi.sqlite",
  "rufi.sqlite-wal",
  "rufi.sqlite-shm",
  "rufi.sqlite-journal",
  "codex",
  "sub-agents",
]);

/** Where an active data folder can't be: a folder that syncs to a cloud. */
const CLOUD = [
  join("Library", "Mobile Documents"),
  join("Library", "CloudStorage"),
];
/** Disks on a network (smbfs, afpfs, nfs, webdav): SQLite's locks aren't safe there. */
const NETWORK = /^(smbfs|afpfs|nfs|webdav|cifs|ftp)$/;
/** How long the list of the Mac's disks may take. */
const MOUNT_MS = 10_000;

/** Moves the data folder to `to`, an absolute path that doesn't exist or is an empty folder. */
export async function moveData(place: Place, to: string): Promise<Move> {
  refuseOverride(place);
  const root = locationRoot(place.userHome);
  return withLocationLock(root, 0, async () => {
    const { path: from } = await managedFolder(root);
    await checkTarget(place.userHome, from, to);
    return withBoth(from, to, async () => {
      const there = await readdir(to);
      if (there.some((name) => name !== "rufi.lock")) {
        throw new Error(
          `${to} isn't empty. Move Rufi's data into a new or empty folder: Rufi never moves it over anything.`,
        );
      }
      if (
        (await lstat(databasePath(from)).catch(() => undefined)) === undefined
      ) {
        throw new Error(
          `There's no record in ${from} yet. Start Rufi once, then move it.`,
        );
      }
      try {
        await writeMark(from, MOVING_OUT, { folder: to });
        await writeMark(to, MOVING_IN, { folder: from });
        await copyFolder(from, to);
        await verify(from, to);
      } catch (error) {
        await cancel(from, to);
        throw new Error(
          `Rufi didn't move your data, and still uses ${from}. ${reason(error)} Delete ${to} before you try again.`,
          { cause: error },
        );
      }
      await commit(root, { from, to });
      return { from, to };
    });
  });
}

/** Finishes a move that stopped: checks the copy again, then switches. */
export async function finishMove(place: Place): Promise<Move> {
  refuseOverride(place);
  const root = locationRoot(place.userHome);
  return withLocationLock(root, 0, async () => {
    const { from, to, there, cancelled } = await unfinished(root, "finish");
    if (!there) {
      throw new Error(
        `The new folder ${to} isn't there. If it's on a disk, connect the disk and try again. To stay with ${from}, run: pnpm rufi move-data --cancel.`,
      );
    }
    if (cancelled) {
      throw new Error(
        `That move was cancelled, and Rufi uses ${from}. To move again, delete ${to} first.`,
      );
    }
    return withBoth(from, to, async () => {
      try {
        await verify(from, to);
      } catch (error) {
        throw new Error(
          `The copy in ${to} isn't complete, so Rufi can't finish the move. ${reason(error)} To stay with ${from}, run: pnpm rufi move-data --cancel.`,
          { cause: error },
        );
      }
      await commit(root, { from, to });
      return { from, to };
    });
  });
}

/**
 * Cancels a move that stopped before the switch: marks the new folder
 * cancelled, for good, then makes the old one usable again. Keeps every file.
 */
export async function cancelMove(place: Place): Promise<Move> {
  refuseOverride(place);
  const root = locationRoot(place.userHome);
  return withLocationLock(root, 0, async () => {
    const { from, to, there } = await unfinished(root, "cancel");
    // A new folder on a disk that isn't connected can't be marked; it can't
    // be opened either.
    if (!there)
      return locked(from, async () => {
        await clearSource(from);
        return { from, to };
      });
    return withBoth(from, to, async () => {
      await cancel(from, to);
      return { from, to };
    });
  });
}

/**
 * The move the location file's folder is in, from its mark. Throws when there
 * is none: after the switch, the location file names the new folder, which
 * has no mark.
 */
async function unfinished(
  root: string,
  doing: "finish" | "cancel",
): Promise<Move & { there: boolean; cancelled: boolean }> {
  const from = await readLocation(root);
  const out =
    from === undefined
      ? undefined
      : ((await readMark(join(from, MOVING_OUT))) ??
        (await readMark(join(from, MOVED_TO))));
  if (from === undefined || out === undefined) {
    throw new Error(
      `There's no move to ${doing}${from === undefined ? "" : `: Rufi uses ${from}`}.`,
    );
  }
  const to = out.folder;
  if ((await lstat(to).catch(() => undefined)) === undefined) {
    return { from, to, there: false, cancelled: false };
  }
  const mark = await readMark(join(to, MOVING_IN));
  if (mark !== undefined && mark.folder !== from) {
    throw new Error(
      `${to} holds a move from ${mark.folder}, not from ${from}, so Rufi won't touch either. Help: Your data and the AI.`,
    );
  }
  return { from, to, there: true, cancelled: mark?.cancelled === true };
}

/**
 * Switches to the new folder, in an order a crash can't undo: the copy is
 * on the disk (copyFolder), the new folder is complete, the old one says
 * where the data went, and last the location file names the new one.
 */
async function commit(root: string, { from, to }: Move): Promise<void> {
  await rm(join(to, MOVING_IN), { force: true });
  await syncFolder(to);
  await writeMark(from, MOVED_TO, { folder: to });
  await rm(join(from, MOVING_OUT), { force: true });
  await syncFolder(from);
  await rememberFolder(root, to);
  // The new folder opens as the next start will open it.
  await managedFolder(root);
}

/** Marks the new folder cancelled, for good, then makes the old one usable again. */
async function cancel(from: string, to: string): Promise<void> {
  await writeMark(to, MOVING_IN, { folder: from, cancelled: true });
  await clearSource(from);
}

async function clearSource(from: string): Promise<void> {
  await rm(join(from, MOVED_TO), { force: true });
  await rm(join(from, MOVING_OUT), { force: true });
  await syncFolder(from);
}

const writeMark = (folder: string, name: string, mark: Mark) =>
  writePrivateJson(join(folder, name), mark);

function refuseOverride(place: Place): void {
  const set = rufiHomeOverride(place.env);
  if (set !== undefined) {
    throw new Error(
      `RUFI_HOME is set (${set}), so Rufi doesn't use its remembered data folder now. Unset RUFI_HOME and try again.`,
    );
  }
}

/** Runs `task` while holding rufi.lock in `from`, then in `to`; refuses while Rufi runs on either. */
async function withBoth<T>(
  from: string,
  to: string,
  task: () => Promise<T>,
): Promise<T> {
  return locked(from, () => locked(to, task));
}

async function locked<T>(folder: string, task: () => Promise<T>): Promise<T> {
  let lost: Error | undefined;
  const release = await holdRufiLock(folder, (error) => {
    lost = error;
  });
  try {
    const result = await task();
    if (lost) {
      throw new Error(`Rufi lost its lock on ${folder} during the move.`, {
        cause: lost,
      });
    }
    return result;
  } finally {
    await release().catch(() => undefined);
  }
}

/**
 * The new folder is new or empty, not the data folder or inside it or around
 * it, and not in a cloud folder or on a network disk.
 */
async function checkTarget(
  userHome: string,
  from: string,
  to: string,
): Promise<void> {
  const there = await lstat(to).catch(() => undefined);
  if (there !== undefined) {
    if (!there.isDirectory()) {
      throw new Error(
        `${to} isn't a folder. Move Rufi's data into a new or empty folder.`,
      );
    }
    if ((await readdir(to)).length > 0) {
      throw new Error(
        `${to} isn't empty. Move Rufi's data into a new or empty folder: Rufi never moves it over anything.`,
      );
    }
  }
  const source = await realpath(from);
  const target = await real(to);
  if (
    target === source ||
    target.startsWith(source + sep) ||
    source.startsWith(target + sep)
  ) {
    throw new Error(
      `${to} is Rufi's data folder, or inside it, or holds it. Choose a folder outside it.`,
    );
  }
  const home = await realpath(userHome);
  if (CLOUD.some((cloud) => target.startsWith(join(home, cloud) + sep))) {
    throw new Error(
      `${to} is in iCloud Drive or a cloud folder. Rufi's data folder must be on this Mac or a disk you connect to it; copy backups to the cloud instead (Help: Backups and export).`,
    );
  }
  if (NETWORK.test(await diskType(target))) {
    throw new Error(
      `${to} is on a network disk. Rufi's data folder must be on this Mac or a disk you connect to it; copy backups to a network disk instead (Help: Backups and export).`,
    );
  }
}

/** The real path of `path`, through its nearest folder that exists. */
async function real(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await real(parent), basename(path));
  }
}

/** The file system type of the disk `path` is on, from the Mac's list of mounted disks. */
async function diskType(path: string): Promise<string> {
  const { stdout } = await promisify(execFile)("/sbin/mount", [], {
    timeout: MOUNT_MS,
  });
  let best = { at: "", type: "" };
  for (const line of stdout.split("\n")) {
    const found = /^.+ on (.+) \(([^,)]+)/.exec(line);
    const at = found?.[1];
    const type = found?.[2];
    if (at === undefined || type === undefined) continue;
    const inside = at === "/" || path === at || path.startsWith(at + sep);
    if (inside && at.length > best.at.length) best = { at, type };
  }
  return best.type;
}

interface Entry {
  path: string;
  mode: number;
}

/** The folders and files a move copies, as paths inside `folder`; a link or a special file stops it. */
async function contents(
  folder: string,
): Promise<{ folders: Entry[]; files: Entry[] }> {
  const folders: Entry[] = [];
  const files: Entry[] = [];
  async function walk(inside: string): Promise<void> {
    for (const name of (await readdir(join(folder, inside))).sort()) {
      const path = join(inside, name);
      if (inside === "" && NOT_COPIED.has(name)) continue;
      const found = await lstat(join(folder, path));
      const mode = found.mode & 0o777;
      if (found.isDirectory()) {
        folders.push({ path, mode });
        await walk(path);
      } else if (found.isFile()) {
        files.push({ path, mode });
      } else {
        throw new Error(
          `Rufi can't move ${join(folder, path)}: it's a link or a special file, not a file. Move it out of the data folder, then try again.`,
        );
      }
    }
  }
  await walk("");
  return { folders, files };
}

/**
 * Copies everything a move keeps from `from` into `to`, each file with its
 * permissions, and the database as one consistent copy. All of it is on the
 * disk when it returns.
 */
async function copyFolder(from: string, to: string): Promise<void> {
  const { folders, files } = await contents(from);
  for (const { path, mode } of folders) {
    await mkdir(join(to, path), { mode });
  }
  for (const { path, mode } of files) {
    const copy = join(to, path);
    await copyFile(
      join(from, path),
      copy,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );
    await chmod(copy, mode);
    await syncFile(copy);
  }
  // A whole database or none: it gets its name once complete.
  const staged = join(to, "rufi.sqlite.moving");
  await copyDatabase(databasePath(from), staged);
  await chmod(staged, 0o600);
  freshThreads(staged);
  await syncFile(staged);
  await rename(staged, databasePath(to));
  for (const { path } of folders.toReversed()) await syncFolder(join(to, path));
  await syncFolder(to);
}

/**
 * Lets each chat's AI thread go: in the new folder, the AI starts a fresh
 * thread with the saved chat, as it does after a model change.
 */
function freshThreads(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "UPDATE chats SET thread_id = NULL, thread_provider = NULL, thread_model = NULL, thread_tools = NULL",
    );
  } finally {
    db.close();
  }
}

/**
 * The copy is complete: its database passes SQLite's checks and names only
 * originals that are there, and every other file a move keeps is in `to`
 * with the same bytes as in `from`.
 */
async function verify(from: string, to: string): Promise<void> {
  const database = databasePath(to);
  checkDatabase(database);
  for (const { id, size } of filesIn(database)) {
    await checkOriginal(filesPath(to), id, size, false);
  }
  for (const { path } of (await contents(from)).files) {
    const copy = join(to, path);
    const [one, two] = await Promise.all([
      sha256(join(from, path)),
      sha256(copy).catch(() => undefined),
    ]);
    if (one !== two) throw new Error(`${path} isn't the same in the copy.`);
  }
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
