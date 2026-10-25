// Rufi's converter (core/devices/devices.ts): while Rufi runs, it converts
// the device batches that are due, one at a time, and cleans up kept values
// and batches once a day. At start it tries each failed group head again at
// once. When even a failure can't be written (the disk is still full), it
// keeps the reason in memory for Settings and rests.
import { setImmediate as nextTurn } from "node:timers/promises";
import { failureReason, type Devices } from "../core/devices/devices.ts";
import { errorCode, type Log } from "../platform/logs.ts";

/** A loop with nothing due looks again this often. */
const IDLE_MS = 60_000;
const CLEAN_MS = 24 * 60 * 60 * 1000;

export function converter(deps: {
  devices: Pick<Devices, "convertNext" | "retryFailedNow" | "cleanUp">;
  log: Log;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const stop = new AbortController();
  // A call, so a check inside the loop isn't taken as already known.
  const stopped = () => stop.signal.aborted;
  let wakeUp: (() => void) | undefined;
  let loop: Promise<void> | undefined;
  let trouble: string | null = null;
  // A clean-up asked for now (a shorter "Keep values"), and one running.
  const clean = { asked: false, running: false };
  const cleanAsked = () => clean.asked;

  const rest = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.max(0, ms));
      function done() {
        clearTimeout(timer);
        wakeUp = undefined;
        resolve();
      }
      wakeUp = done;
      if (stop.signal.aborted || clean.asked) done();
    });

  const forever = async () => {
    let started = false;
    let cleaned = Number.NEGATIVE_INFINITY;
    while (!stop.signal.aborted) {
      let delay = IDLE_MS;
      try {
        if (!started) {
          await deps.devices.retryFailedNow();
          started = true;
        }
        if (clean.asked || now() - cleaned >= CLEAN_MS) {
          clean.asked = false;
          // Until it succeeds: a failed clean-up goes again on the next turn.
          cleaned = Number.NEGATIVE_INFINITY;
          clean.running = true;
          const gone = await deps.devices.cleanUp().finally(() => {
            clean.running = false;
          });
          cleaned = now();
          if (gone.values + gone.batches > 0)
            deps.log("devices.cleaned", { count: gone.values + gone.batches });
        }
        while (!stopped()) {
          const step = await deps.devices.convertNext();
          trouble = null;
          if ("idle" in step) {
            if (step.wake !== undefined)
              delay = Math.min(delay, Date.parse(step.wake) - now());
            break;
          }
          if ("failed" in step)
            deps.log("devices.batch_failed", { reason: step.reason });
          // Each batch is many small writes: let the screens be answered between batches.
          await nextTurn();
          if (cleanAsked()) break;
        }
      } catch (error) {
        trouble = failureReason(error);
        deps.log("devices.failed", { error: errorCode(error) });
      }
      await rest(delay);
    }
  };

  return {
    /** Starts converting; Rufi starts it once. */
    start: () => {
      loop ??= forever();
    },
    /** Why the last try couldn't even be written, while that lasts; null otherwise. */
    trouble: () => trouble,
    /** "Keep values" got shorter: clean up now, in the background. */
    cleanSoon: () => {
      clean.asked = true;
      wakeUp?.();
    },
    /** Whether a clean-up is asked for or running. */
    cleaning: () => clean.asked || clean.running,
    close: async () => {
      stop.abort();
      wakeUp?.();
      await loop;
    },
  };
}
