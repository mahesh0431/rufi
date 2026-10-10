// The document reader at work: runs the queued readings one at a time, each
// as a Rufi sub-agent (agent/codex/subagent.ts) with the reader's two tools,
// and writes its start and end into the person's chat as Rufi events. A
// reading starts only after the person's yes, and only when signed in; a
// usage limit makes it wait until the limit resets. Only a reader turn that
// completed normally finishes a reading; a turn that failed for a passing
// reason gets one automatic retry, and anything else ends the reading as
// failed, its notebook kept for Retry. When Rufi stops, a running reading
// is left as it is: the next start queues it again.
import { ChatGptError } from "../agent/chatgpt/openai.ts";
import type {
  RunSubAgent,
  SubAgentOutcome,
  TurnEnd,
} from "../agent/runtime.ts";
import type { Notebook, Run } from "../core/documents/notebook.ts";
import type { Pages } from "../core/documents/pages.ts";
import {
  READER_EFFORT,
  READER_INSTRUCTIONS,
  READER_MODEL,
  READER_VERSION,
  readerInput,
} from "../core/documents/reader-instructions.ts";
import { forReader } from "../core/documents/reader-tools.ts";
import type { Job, Readings, Usage } from "../core/documents/reading.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import type { Chat } from "./chat.ts";

export interface ReaderDeps {
  readings: Readings;
  book: Notebook;
  pages: Pages;
  /** Writes a Rufi event in the person's chat, with its producer's outcome. */
  event: Chat["event"];
  /** Runs the reader sub-agent; without one, readings wait. */
  run: RunSubAgent | undefined;
  signedIn: () => Promise<boolean>;
  log: Log;
  /** How long one run of a reading may take, for its number of pages. */
  deadlineMs?: (pages: number) => number;
  /** How often a reading waiting for the sign-in looks again. */
  signInPollMs?: number;
  /** The clock for wait times, the same as the readings' clock. */
  now?: () => number;
}

/**
 * A run's deadline: 5 minutes, and one more per page it saves, at most an
 * hour. A dense 45-row page took about 45 s on the test pack.
 */
const deadlineFor = (pages: number) => Math.min(60, 5 + pages) * 60_000;

/** A loop with nothing to do looks again this often. */
const IDLE_MS = 60_000;
const SIGN_IN_POLL_MS = 30_000;
/** A sign-in that can't be renewed yet is tried again after this. */
const RENEW_WAIT_MS = 60_000;
/** After an unexpected failure of the loop itself. */
const ERROR_MS = 5_000;

/** Why a run ended, in words for the person, when it fails the reading. */
const WHY: Partial<Record<NonNullable<TurnEnd["reason"]>, string>> = {
  timeout: "the reading took too long",
  connection: "the AI connection was lost",
  provider_failed: "the AI connection restarted",
  rate_limit: "the AI was busy",
};

export function reader(deps: ReaderDeps) {
  const { readings, log } = deps;
  const now = deps.now ?? Date.now;
  const stop = new AbortController();
  let wake: (() => void) | undefined;
  /** A poke while no rest waits: the next rest ends at once. */
  let poked = false;
  let loop: Promise<void> | undefined;

  const poke = () => {
    poked = true;
    wake?.();
  };

  /** Sleeps `ms`, or less when poked or stopped. */
  const rest = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.max(0, ms));
      function done() {
        clearTimeout(timer);
        wake = undefined;
        poked = false;
        resolve();
      }
      wake = done;
      if (poked || stop.signal.aborted) done();
    });

  /** Ends a run that completed: drafts, page states, the end line, the ask. */
  const finish = async (run: Run) => {
    const end = await readings.ending(run);
    await deps.event(
      run.personId,
      {
        kind: "document_read",
        line: end.line,
        facts: end.facts,
        ...(end.ask !== undefined && { ask: end.ask }),
      },
      (trx) => readings.finish(trx, run),
    );
    readings.changed(run.personId);
  };

  /** Ends a reading as failed: its entries kept, no drafts, the end line. */
  const fail = async (run: Run, why: string) => {
    const end = await readings.ending(run, why);
    await deps.event(
      run.personId,
      { kind: "document_read", line: end.line, facts: end.facts },
      (trx) => readings.fail(trx, run, why),
    );
    readings.changed(run.personId);
  };

  /** One run of a reading, from its start to its end or its next wait. */
  const runJob = async (job: Job, runSubAgent: RunSubAgent) => {
    let run: Run | undefined;
    if (job.startedAt === null) {
      // The start line once per reading, with its first real start.
      const line = await readings.startLine(job);
      await deps.event(
        job.personId,
        { kind: "document_read_started", line },
        async (trx) => {
          run = await readings.begin(trx, job);
        },
      );
    } else run = await readings.startRun(job);
    if (!run) return;
    const started = run;
    readings.changed(job.personId);

    // A crash after the last page was saved: finish without a reader.
    if (await readings.allSaved(job)) {
      started.closed = true;
      await finish(started);
      return;
    }

    const tools = forReader(started, deps.pages, deps.book, log);
    const counts = { looks: 0, saves: 0 };
    const t0 = Date.now();
    let outcome: SubAgentOutcome;
    try {
      outcome = await runSubAgent(
        {
          model: READER_MODEL,
          effort: READER_EFFORT,
          instructions: READER_INSTRUCTIONS,
          input: readerInput(await readings.about(started)),
          tools: { namespace: tools.namespace, specs: tools.specs },
          callTool: async (name, input, callId) => {
            const answer = await tools.call(name, input, callId);
            if (name === "get_page") counts.looks++;
            if (name === "save_page" && answer.ok) {
              counts.saves++;
              readings.changed(started.personId);
            }
            return answer;
          },
          onCompaction: () => {
            started.lookedAt.clear();
          },
          deadlineMs: (deps.deadlineMs ?? deadlineFor)(job.targets.length),
        },
        stop.signal,
      );
    } catch (error) {
      started.closed = true;
      if (stop.signal.aborted) return;
      log("reader.failed", { error: errorCode(error) });
      if (
        error instanceof ChatGptError &&
        (error.code === "not_signed_in" ||
          error.code === "sign_in_again" ||
          error.code === "plan_use_off")
      ) {
        await readings.requeue(started, {
          waiting: "sign_in",
          until: new Date(
            now() + (deps.signInPollMs ?? SIGN_IN_POLL_MS),
          ).toISOString(),
        });
      } else if (error instanceof ChatGptError && error.code === "temporary") {
        // The sign-in can't be renewed yet: wait a little, keep the retry.
        await readings.requeue(started, {
          waiting: "sign_in",
          until: new Date(now() + RENEW_WAIT_MS).toISOString(),
        });
      } else if (!job.retried) {
        await readings.requeue(started, { retry: true });
      } else {
        await fail(started, "Rufi couldn't start the AI");
      }
      return;
    }
    started.closed = true;
    const { end } = outcome;
    log("reader.ended", {
      status: end.status,
      ms: Date.now() - t0,
      count: counts.saves,
    });
    // Rufi is stopping: the next start queues the reading again.
    if (stop.signal.aborted) return;
    const usage: Usage = {
      inputTokens: outcome.usage?.inputTokens ?? 0,
      cachedInputTokens: outcome.usage?.cachedInputTokens ?? 0,
      outputTokens: outcome.usage?.outputTokens ?? 0,
      reasoningOutputTokens: outcome.usage?.reasoningOutputTokens ?? 0,
      totalTokens: outcome.usage?.totalTokens ?? 0,
      looks: counts.looks,
      saves: counts.saves,
      compactions: outcome.compactions,
    };
    await readings.recordRun(started, usage, READER_VERSION);

    if (end.status === "completed") {
      await finish(started);
    } else if (end.reason === "sign_in") {
      await readings.requeue(started, {
        waiting: "sign_in",
        until: new Date(
          now() + (deps.signInPollMs ?? SIGN_IN_POLL_MS),
        ).toISOString(),
      });
    } else if (end.reason === "usage_limit") {
      await readings.requeue(started, {
        waiting: "usage_limit",
        until: end.resetsAt ?? new Date(now() + 60 * 60_000).toISOString(),
      });
    } else if (end.reason !== "timeout" && !job.retried) {
      // A passing reason (a lost connection, a restart, a refused answer):
      // one automatic retry, which continues from the notebook.
      await readings.requeue(started, { retry: true });
    } else {
      await fail(
        started,
        (end.reason && WHY[end.reason]) ?? "the reader stopped",
      );
    }
  };

  const forever = async () => {
    while (!stop.signal.aborted) {
      let delay = IDLE_MS;
      poked = false;
      try {
        const { job, wake: at } = await readings.next();
        if (job && deps.run) {
          if (await deps.signedIn()) {
            await runJob(job, deps.run);
            continue;
          }
          await readings.waitForSignIn(job);
          delay = deps.signInPollMs ?? SIGN_IN_POLL_MS;
        }
        if (at !== undefined) {
          delay = Math.min(delay, Date.parse(at) - now());
        }
      } catch (error) {
        log("reader.failed", { error: errorCode(error) });
        delay = ERROR_MS;
      }
      await rest(delay);
    }
  };

  return {
    /** Starts reading what is queued; Rufi starts it once. */
    start: () => {
      loop ??= forever();
    },
    /** Something was queued or changed: look again now. */
    poke,
    /** Stops: a running reading is interrupted and left for the next start. */
    close: async () => {
      stop.abort();
      poke();
      await loop;
    },
  };
}
