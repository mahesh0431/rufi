// What a file is, looked at in a worker thread of its own (inspect-worker.ts)
// with a deadline: the worker is ended when it passes.
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

/** How long one file may take: a long PDF or a big photo, with room to spare. */
const DEADLINE_MS = 60_000;

export function inspect(
  bytes: Uint8Array,
  deadlineMs = DEADLINE_MS,
): Promise<Inspected> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("inspect-worker.ts", import.meta.url), {
      workerData: bytes,
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ ok: false, reason: "slow" });
    }, deadlineMs);
    worker.once("message", (answer: Inspected) => {
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
