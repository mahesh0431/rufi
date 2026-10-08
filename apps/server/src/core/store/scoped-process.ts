// The child process that runs one of the AI's queries (scoped.ts). Its main
// thread gets the person's database and the query, runs it in a worker, and
// sends back the outcome; it ends itself just after the time limit, or as
// soon as the core is gone, also while SQLite is still busy in the worker. It sees
// no other data and no environment.
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { runQuery, type QueryLimits } from "./scoped.ts";

interface Job {
  database: Uint8Array;
  sql: string;
  limits: QueryLimits;
}

/**
 * Ends this process now. Not process.exit: it waits for the worker, which
 * can't stop while SQLite runs.
 */
const end = () => process.kill(process.pid, "SIGKILL");

/** How long after the time limit the process ends itself. */
const BACKSTOP_MS = 1_000;

if (isMainThread) {
  process.once("disconnect", end);
  process.once("message", (message) => {
    const job = message as Job;
    // Rufi ends it at the limit; this is for when Rufi can't any more.
    setTimeout(end, job.limits.timeMs + BACKSTOP_MS);
    const worker = new Worker(new URL(import.meta.url), { workerData: job });
    worker.once("message", (outcome) => process.send?.(outcome));
    worker.once("error", end);
  });
} else {
  const { database, sql, limits } = workerData as Job;
  parentPort?.postMessage(runQuery(database, sql, limits));
}
