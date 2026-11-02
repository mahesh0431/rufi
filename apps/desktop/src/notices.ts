// Notices (docs/adr/0012): the app asks the Rufi it runs which follow-ups
// just became due or overdue, and which medicines' dose time just came, when
// that Rufi is ready, every minute and when the Mac wakes (main.ts), and
// tells each person with one Mac notice for follow-ups and one for
// medicines, only when their reminders ring on the Mac. Rufi marks them as
// told; the app gets counts, a time and a person id, never a title, and a
// medicine's name only when the person chose Which ones. Best effort: a
// notice that fails isn't tried again, and Needs you and Today in Rufi
// still show them.
import type { PersonNotices } from "@rufi/contracts/app";

/** How often the app asks: a medicine's 21:00 is told at 21:00. */
const EVERY_MS = 60_000;

export interface NoticeTimer {
  /** Asks now, unless a claim still waits for its answer. */
  check: () => void;
  stop: () => void;
}

/**
 * Asks `claim` now and then and gives each person with something to tell
 * to `tell`. One claim at a time; a failed one (`failed` hears it) doesn't
 * stop the next.
 */
export function noticeTimer({
  claim,
  tell,
  failed,
}: {
  claim: () => Promise<readonly PersonNotices[]>;
  tell: (person: PersonNotices) => void;
  failed: (error: unknown) => void;
}): NoticeTimer {
  let waiting = false;
  const check = () => {
    if (waiting) return;
    waiting = true;
    claim()
      .then((people) => {
        for (const person of people) {
          if (person.due + person.overdue + person.medicines > 0) {
            tell(person);
          }
        }
      }, failed)
      .finally(() => {
        waiting = false;
      });
  };
  const every = setInterval(check, EVERY_MS);
  every.unref();
  return {
    check,
    stop: () => {
      clearInterval(every);
    },
  };
}

const many = (n: number) => (n === 1 ? "follow-up is" : "follow-ups are");

/**
 * A medicines notice's text, as the person chose (Medicines › Reminders):
 * the time ("Medicines at 21:00"), how many ("2 medicines at 21:00"), or
 * which ones ("21:00 · 2 medicines", then each on its own line).
 */
export function medicinesText({
  medicines,
  at,
  show,
  names,
}: PersonNotices): string {
  const what = `${String(medicines)} ${medicines === 1 ? "medicine" : "medicines"}`;
  if (show === "time") {
    return at === undefined ? "Medicines are due" : `Medicines at ${at}`;
  }
  if (show === "names" && names !== undefined) {
    return [at === undefined ? what : `${at} · ${what}`, ...names].join("\n");
  }
  if (at !== undefined) return `${what} at ${at}`;
  return `${what} ${medicines === 1 ? "is" : "are"} due`;
}

/** A notice's text: counts only, nothing else about the person's health. */
export function noticeText({ due, overdue }: PersonNotices): string {
  if (due > 0 && overdue > 0) {
    return `${String(due)} ${many(due)} due, ${String(overdue)} ${overdue === 1 ? "is" : "are"} overdue`;
  }
  return due > 0
    ? `${String(due)} ${many(due)} due`
    : `${String(overdue)} ${many(overdue)} overdue`;
}
