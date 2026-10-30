// The working folder: `work/` in the AI's folder (server/core.ts), every
// agent's scratch pad, a folder per day, `work/<YYYY-MM-DD>/`. A reading
// agent keeps its notes on a document there, `<document id>.md`. Nothing in
// it is part of the record. At each start and once a day, Rufi removes the
// days older than 3; deleting a document removes its notes (delete.ts), and
// the next start removes those a delete left when Rufi stopped.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorCode, type Log } from "../../platform/logs.ts";
import type { Store } from "./database.ts";

export const workPath = (home: string) => join(home, "ai", "work");

/** How many days before today a day's folder stays. */
const KEPT_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day folders in the working folder: names only, oldest first. */
async function days(home: string) {
  const names = await readdir(workPath(home)).catch(() => []);
  return names.filter((name) => DAY.test(name)).sort();
}

/** Removes the notes on these documents, from every day. */
export async function removeNotes(home: string, documentIds: string[]) {
  for (const day of await days(home)) {
    for (const id of documentIds) {
      await rm(join(workPath(home), day, `${id}.md`), { force: true });
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
    if (day < oldest) {
      await rm(join(workPath(home), day), { recursive: true, force: true });
    } else kept.push(day);
  }
  const named = new Set<string>();
  for (const day of kept) {
    const names = await readdir(join(workPath(home), day)).catch(() => []);
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
