// Which data folder Rufi uses, and making it at the first start. RUFI_HOME
// picks one for demo, tests and restored copies, and then the location file
// is never read or written. Otherwise the location file, outside the data
// folder, names the folder; with none, the first start makes the default
// folder and its record, then writes the location file. A remembered folder
// that is gone, or a damaged location file, stops Rufi: it never starts an
// empty record in place of one (docs/adr/0014).
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Context, Schema } from "effect";
import { rufiHomeOverride } from "../../platform/config.ts";
import {
  holdRufiLock,
  readJson,
  withLocationLock,
  writePrivateJson,
} from "../../platform/files.ts";
import { markerPath, openRecord } from "./install.ts";

/** Where Rufi's data folder came from: shown in Settings. */
export type FolderSource = "default" | "moved" | "RUFI_HOME";

export interface DataFolder {
  path: string;
  source: FolderSource;
}

/** The data folder this Rufi uses, for the parts that show it. */
export class Folder extends Context.Service<Folder, DataFolder>()(
  "rufi/Folder",
) {}

/** What the choice depends on: the environment and the Mac account's home folder. */
export interface Place {
  env: NodeJS.ProcessEnv;
  userHome: string;
}

/** Rufi's own folder in the Mac's place for app data: the location file and the default data folder. */
export const locationRoot = (userHome: string) =>
  join(userHome, "Library", "Application Support", "Rufi");
const defaultFolder = (root: string) => join(root, "data");
const locationFile = (root: string) => join(root, "location.json");

/** The location file: which folder holds the record. No health data, no secrets. */
const Location = Schema.Struct({
  version: Schema.Literal(1),
  dataFolder: Schema.String,
});

/** In a data folder that is being moved out, until the move ends (./move.ts). */
export const MOVING_OUT = "moving-out.json";
/** In a data folder that was moved, kept for the person to delete. */
export const MOVED_TO = "moved-to.json";
/** In the new folder of a move, until the copy is checked, or for good once cancelled. */
export const MOVING_IN = "moving-in.json";

/** A move's mark: the other folder of the move. */
const Mark = Schema.Struct({
  folder: Schema.String,
  cancelled: Schema.optional(Schema.Boolean),
});
export type Mark = typeof Mark.Type;

/** How long a start waits for a move or another first start to let go of the location file. */
const LOCATION_WAIT_MS = 5_000;

/**
 * The data folder: RUFI_HOME when set, else the remembered one, made at the
 * first start. Throws, with what to do, when the folder can't be used.
 */
export async function findDataFolder(place: Place): Promise<DataFolder> {
  const override = rufiHomeOverride(place.env);
  if (override !== undefined) {
    await checkMarks(override, false);
    return { path: override, source: "RUFI_HOME" };
  }
  const root = locationRoot(place.userHome);
  return withLocationLock(root, LOCATION_WAIT_MS, () => managedFolder(root));
}

/**
 * The remembered data folder, or the default one made now. The caller holds
 * location.lock in `root`.
 */
export async function managedFolder(root: string): Promise<DataFolder> {
  const remembered = await readLocation(root);
  const fallback = defaultFolder(root);
  if (remembered !== undefined) {
    await checkRemembered(root, remembered);
    return {
      path: remembered,
      source: remembered === fallback ? "default" : "moved",
    };
  }
  const there = await entries(fallback);
  const complete = there?.includes("installed.json") === true;
  if (complete && there.includes("rufi.sqlite")) {
    // The record is there and only the location file was lost: remember it.
    await checkMarks(fallback, false);
    await rememberFolder(root, fallback);
    return { path: fallback, source: "default" };
  }
  if (complete || (there ?? []).some((name) => !FIRST_START.has(name))) {
    throw new Error(
      `${fallback} holds files but no Rufi record, so Rufi won't start a record there. Move those files somewhere else, then start Rufi again (Help: Your data and the AI).`,
    );
  }
  await firstStart(fallback);
  await rememberFolder(root, fallback);
  return { path: fallback, source: "default" };
}

/**
 * What a first start that stopped midway can leave in the default folder: a
 * stale lock, or the new database before its marker. The first start goes
 * on from there.
 */
const FIRST_START = new Set([
  "rufi.lock",
  "credentials.lock",
  "rufi.sqlite",
  "rufi.sqlite-wal",
  "rufi.sqlite-shm",
]);

/** Makes the default folder and its record, under its rufi.lock. */
async function firstStart(folder: string): Promise<void> {
  let lost: Error | undefined;
  // Makes the folder (0700) too.
  const release = await holdRufiLock(folder, (error) => {
    lost = error;
  });
  try {
    (await openRecord(folder)).close();
    if (lost) {
      throw new Error(`Rufi lost its lock on ${folder} while making it.`, {
        cause: lost,
      });
    }
  } finally {
    await release().catch(() => undefined);
  }
}

/** Reads the location file: the remembered folder, or undefined when there is none. */
export async function readLocation(root: string): Promise<string | undefined> {
  const file = locationFile(root);
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch (error) {
    throw damaged(file, error);
  }
  if (raw === undefined) return undefined;
  let location;
  try {
    location = Schema.decodeUnknownSync(Location)(raw);
  } catch (error) {
    throw damaged(file, error);
  }
  if (!isAbsolute(location.dataFolder)) throw damaged(file);
  return location.dataFolder;
}

const damaged = (file: string, cause?: unknown) =>
  new Error(
    `Rufi can't tell where your data is: ${file} is damaged. Rufi won't start an empty record instead. Help: Your data and the AI says what the file holds.`,
    { cause },
  );

/** Remembers `folder` as the data folder, on the disk before it returns. */
export const rememberFolder = (root: string, folder: string) =>
  writePrivateJson(locationFile(root), { version: 1, dataFolder: folder });

/** The remembered folder is there, holds a record, and isn't in a move. */
async function checkRemembered(root: string, folder: string): Promise<void> {
  const found = await lstat(folder).catch(gone);
  if (found === undefined) {
    throw new Error(
      `Rufi's data folder isn't there: ${folder}. If it's on a disk, connect the disk and start Rufi again. Rufi won't start an empty record in its place. (Rufi remembers this folder in ${locationFile(root)}.)`,
    );
  }
  if (!found.isDirectory() || !(await exists(markerPath(folder)))) {
    throw new Error(
      `${folder} isn't Rufi's data folder any more: Rufi's record isn't in it. If it's on a disk, check it's the right disk. Rufi won't start an empty record in its place (Help: Your data and the AI).`,
    );
  }
  await checkMarks(folder, true);
}

/**
 * Refuses a data folder that a move left: one being moved out, one moved
 * away, or a new folder whose copy isn't done or was cancelled. Checked at
 * every start, also with RUFI_HOME. `remembered`: the location file names
 * the folder.
 */
async function checkMarks(folder: string, remembered: boolean): Promise<void> {
  const movingOut = await readMark(join(folder, MOVING_OUT));
  if (movingOut !== undefined) {
    throw new Error(
      `Rufi was moving its data from ${folder} to ${movingOut.folder}, and the move didn't finish. To finish it, run: pnpm rufi move-data --finish. To stay with ${folder}, run: pnpm rufi move-data --cancel. (Without RUFI_HOME.)`,
    );
  }
  const movedTo = await readMark(join(folder, MOVED_TO));
  if (movedTo !== undefined && remembered) {
    // The location file still names it: the switch didn't happen.
    throw new Error(
      `Rufi was moving its data from ${folder} to ${movedTo.folder}, and the move didn't finish. To finish it, run: pnpm rufi move-data --finish. To stay with ${folder}, run: pnpm rufi move-data --cancel.`,
    );
  }
  if (movedTo !== undefined) {
    throw new Error(
      `Rufi's data moved from ${folder} to ${movedTo.folder}. Rufi uses that folder now. Delete ${folder} when you no longer need it.`,
    );
  }
  const movingIn = await readMark(join(folder, MOVING_IN));
  if (movingIn?.cancelled) {
    throw new Error(
      `${folder} holds a cancelled move of Rufi's data, from ${movingIn.folder}. Rufi won't open it. Delete it when you no longer need it.`,
    );
  }
  if (movingIn !== undefined) {
    throw new Error(
      `${folder} holds a move of Rufi's data from ${movingIn.folder} that didn't finish, so Rufi won't open it. To finish it, run: pnpm rufi move-data --finish. To stay with ${movingIn.folder}, run: pnpm rufi move-data --cancel.`,
    );
  }
}

/** A move mark, or undefined when there is none. */
export async function readMark(path: string): Promise<Mark | undefined> {
  const raw = await readJson(path);
  if (raw === undefined) return undefined;
  try {
    return Schema.decodeUnknownSync(Mark)(raw);
  } catch (error) {
    throw new Error(
      `${path} is damaged, so Rufi can't tell how a move of its data ended. Rufi won't open the folder.`,
      { cause: error },
    );
  }
}

/** The names in a folder, or undefined when it doesn't exist. */
async function entries(folder: string): Promise<string[] | undefined> {
  return readdir(folder).catch(gone);
}

const exists = async (path: string) =>
  (await lstat(path).catch(gone)) !== undefined;

/** Undefined when the error says the path isn't there; anything else is thrown. */
function gone(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
  throw error;
}
