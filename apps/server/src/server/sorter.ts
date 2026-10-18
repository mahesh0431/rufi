// Rufi's own work on its sorting requests (core/documents/sorting.ts): at
// start, after each turn of a chat and as retries fall due, it looks at the
// open requests, and hands the chat the rows that can go now. The sorting
// turn itself runs in the person's chat, like any turn.
import type { Sorting } from "../core/documents/sorting.ts";
import { errorCode, type Log } from "../platform/logs.ts";

/** A loop with nothing due looks again this often. */
const IDLE_MS = 60_000;

export function sorter(deps: {
  sorting: Pick<Sorting, "tend">;
  /** The person's queue has rows Rufi put there: hand them over. */
  wake: (personId: string) => Promise<void>;
  /** The person's sorting changed: tell their screens. */
  changed: (personId: string) => void;
  log: Log;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const stop = new AbortController();
  let poked = false;
  let wakeUp: (() => void) | undefined;
  let loop: Promise<void> | undefined;

  const rest = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.max(0, ms));
      function done() {
        clearTimeout(timer);
        wakeUp = undefined;
        poked = false;
        resolve();
      }
      wakeUp = done;
      if (poked || stop.signal.aborted) done();
    });

  const forever = async () => {
    while (!stop.signal.aborted) {
      let delay = IDLE_MS;
      poked = false;
      try {
        const { people, changed, wake } = await deps.sorting.tend();
        for (const person of changed) deps.changed(person);
        for (const person of people) await deps.wake(person);
        if (wake !== undefined) {
          delay = Math.min(delay, Date.parse(wake) - now());
        }
      } catch (error) {
        deps.log("sorter.failed", { error: errorCode(error) });
      }
      await rest(delay);
    }
  };

  return {
    /** Starts looking; Rufi starts it once. */
    start: () => {
      loop ??= forever();
    },
    /** A turn ended, or a request changed: look again now. */
    poke: () => {
      poked = true;
      wakeUp?.();
    },
    close: async () => {
      stop.abort();
      wakeUp?.();
      await loop;
    },
  };
}
