// What a file is, and a page drawn for the AI, each worked out in a worker
// thread of its own (inspect-worker.ts) with a deadline: the worker is ended
// when it passes.
import { Worker } from "node:worker_threads";

export type Inspected =
  | {
      ok: true;
      mediaType:
        | "application/pdf"
        | "image/jpeg"
        | "image/png"
        | "image/heic"
        | "image/heif";
      /** A PDF's pages; a photo is one page. */
      pages: number;
      /** A HEIC's display copy, as JPEG. */
      display?: Uint8Array;
    }
  | {
      ok: false;
      /** not_accepted: not a PDF, JPEG, PNG or HEIC; locked: a PDF with a password. */
      reason: "not_accepted" | "broken" | "locked" | "slow";
    };

/** A PDF page drawn as an image, with the page's own text when it has some. */
export type Drawn =
  | {
      ok: true;
      png: Uint8Array;
      /** Plain, in reading order; undefined when the page has no text (a scan). */
      text: string | undefined;
    }
  | { ok: false; reason: "broken" | "slow" };

/** What the worker is asked: look at a whole file, or draw one PDF page. */
export type Task =
  | { task: "inspect"; bytes: Uint8Array }
  | { task: "draw"; bytes: Uint8Array; page: number };

/** How long one file may take: a long PDF or a big photo, with room to spare. */
const DEADLINE_MS = 60_000;

function inWorker<T>(task: Task, slow: T, deadlineMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("inspect-worker.ts", import.meta.url), {
      workerData: task,
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(slow);
    }, deadlineMs);
    worker.once("message", (answer: T) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(answer);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error("Rufi couldn't look at the file", { cause: error }));
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      // After an answer or an error, this changes nothing.
      reject(new Error(`The file worker ended (${String(code)})`));
    });
  });
}

export const inspect = (
  bytes: Uint8Array,
  deadlineMs = DEADLINE_MS,
): Promise<Inspected> =>
  inWorker(
    { task: "inspect", bytes },
    { ok: false, reason: "slow" },
    deadlineMs,
  );

/** Draws page `page` (1, 2, 3...) of a PDF; see PAGE_PIXELS in the worker. */
export const draw = (
  bytes: Uint8Array,
  page: number,
  deadlineMs = DEADLINE_MS,
): Promise<Drawn> =>
  inWorker(
    { task: "draw", bytes, page },
    { ok: false, reason: "slow" },
    deadlineMs,
  );
