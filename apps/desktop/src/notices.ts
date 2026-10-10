// Follow-up notices (docs/adr/0012): the app asks the Rufi it runs which
// follow-ups just became due or overdue, when that Rufi is ready, every 15
// minutes and when the Mac wakes (main.ts), and tells each person with one
// Mac notice. Rufi marks them as told; the app only gets counts and a person
// id, never a title or a name. Best effort: a notice that fails isn't tried
// again, and Needs you in Rufi still shows the follow-ups.
import type { PersonNotices } from "@rufi/contracts/app";

/** How often the app asks. */
const EVERY_MS = 15 * 60_000;

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
          if (person.due + person.overdue > 0) tell(person);
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

/** A notice's text: counts only, nothing else about the person's health. */
export function noticeText({ due, overdue }: PersonNotices): string {
  if (due > 0 && overdue > 0) {
    return `${String(due)} ${many(due)} due, ${String(overdue)} ${overdue === 1 ? "is" : "are"} overdue`;
  }
  return due > 0
    ? `${String(due)} ${many(due)} due`
    : `${String(overdue)} ${many(overdue)} overdue`;
}
