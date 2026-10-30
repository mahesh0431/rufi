// The working folder: `work/` in the AI's folder (server/core.ts), every
// agent's scratch pad, a folder per day, `work/<YYYY-MM-DD>/`. A reading
// agent keeps its notes on a document there, `<document id>.md`. Nothing in
// it is part of the record. At each start and once a day, Rufi removes the
// days older than 3; deleting a document removes its notes (delete.ts), and
// the next start removes those a delete left when Rufi stopped. Rufi never
// goes through a link here: the AI can make one, and Rufi's clean-up can
// reach more than the AI can. A link goes itself, never what it points at.
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorCode, type Log } from "../../platform/logs.ts";
import type { Store } from "./database.ts";

export const workPath = (home: string) => join(home, "ai", "work");

/** How many days before today a day's folder stays. */
const KEPT_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The days in the working folder, oldest first: folders, and links named as
 * a day. None when the working folder is itself a link, or isn't there.
 */
async function days(home: string) {
  const work = workPath(home);
  if (!(await lstat(work).catch(() => undefined))?.isDirectory()) return [];
  return (await readdir(work, { withFileTypes: true }))
    .filter(
      (entry) =>
        DAY.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()),
    )
    .map((entry) => ({
      name: entry.name,
      path: join(work, entry.name),
      link: entry.isSymbolicLink(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Removes the notes on these documents, from every day that is a folder. */
export async function removeNotes(home: string, documentIds: string[]) {
  for (const day of await days(home)) {
    if (day.link) continue;
    for (const id of documentIds) {
      const note = join(day.path, `${id}.md`);
      // A file, or a link itself; never a folder of that name.
      if (!(await lstat(note).catch(() => undefined))?.isDirectory()) {
        await rm(note, { force: true });
      }
    }
  }
}

/**
 * Removes the days older than KEPT_DAYS before `now`'s, and the notes on
 * documents deleted since. Anything else in the folder stays.
 */
export async function cleanWork(store: Store, home: string, now: string) {
  const oldest = new Date(Date.parse(now) - KEPT_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const kept: string[] = [];
  for (const day of await days(home)) {
    // rm takes a link itself, and doesn't follow one inside a folder.
    if (day.name < oldest) await rm(day.path, { recursive: true, force: true });
    else if (!day.link) kept.push(day.path);
  }
  const named = new Set<string>();
  for (const day of kept) {
    const names = await readdir(day).catch(() => []);
    for (const name of names) {
      if (name.endsWith(".md")) named.add(name.slice(0, -".md".length));
    }
  }
  if (named.size === 0) return;
  const deleted = await store.query
    .selectFrom("documents")
    .select("id")
    .where("id", "in", [...named])
    .where("deleted_at", "is not", null)
    .execute();
  await removeNotes(
    home,
    deleted.map((d) => d.id),
  );
}

/**
 * Cleans the working folder now and once a day, in the background: a
 * failure goes to the log and never stops Rufi.
 */
export function workCleaner(
  store: Store,
  home: string,
  log: Log,
  now: () => string = () => new Date().toISOString(),
) {
  let cleaning: Promise<void> | undefined;
  const clean = () => {
    cleaning ??= cleanWork(store, home, now())
      .catch((error: unknown) => {
        log("work.cleanup_failed", { error: errorCode(error) });
      })
      .finally(() => {
        cleaning = undefined;
      });
  };
  clean();
  const timer = setInterval(clean, DAY_MS);
  timer.unref();
  return {
    /** Stops cleaning, and waits for a clean under way. */
    close: async () => {
      clearInterval(timer);
      await cleaning;
    },
  };
}
