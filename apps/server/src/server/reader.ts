// The document reader at work: runs the queued readings one at a time, each
// as a Rufi sub-agent (agent/codex/subagent.ts) with the reader's two tools,
// and writes its start and end into the person's chat as Rufi events. A
// reading starts only when signed in; a usage limit makes it wait until the
// limit resets. Each run uses the model and effort chosen in Settings when
// it starts. Only a reader turn that completed normally finishes a reading; a turn that failed for a passing
// reason gets one automatic retry, and anything else ends the reading as
// failed, its notebook kept for Retry. When Rufi stops, a running reading
// is left as it is: the next start queues it again. The reader gets its two
// tools from Rufi's MCP server, with a key for one attempt.
import { Effort } from "@rufi/contracts";
import { Option, Schema } from "effect";
import { ChatGptError } from "../agent/chatgpt/openai.ts";
import { SUB_AGENT_MODELS } from "../agent/codex/subagent.ts";
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
import {
  ReadingGone,
  type Job,
  type Readings,
  type Usage,
} from "../core/documents/reading.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import type { Chat } from "./chat.ts";
import type { McpKeys } from "./mcp.ts";

export interface ReaderDeps {
  readings: Readings;
  book: Notebook;
  pages: Pages;
  /** Writes a Rufi event in the person's chat, with its producer's outcome. */
  event: Chat["event"];
  /** Runs the reader sub-agent; without one, readings wait. */
  run: RunSubAgent | undefined;
  signedIn: () => Promise<boolean>;
  /** The model and effort chosen in Settings (readerChoice), read as a run starts. */
  choice: () => Promise<ReaderChoice>;
  /** Rufi's MCP endpoint for the reader: its address and its keys. */
  mcp: { url: () => string; keys: McpKeys };
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

/** The settings that hold the reader's model and effort. */
export const READER_SETTING = {
  model: "reader_model",
  effort: "reader_effort",
} as const;

export interface ReaderChoice {
  model: string;
  effort: Effort;
}

/**
 * The reader's model and effort as chosen in Settings, or the defaults. A
 * model the sub-agent runner doesn't run is the default.
 */
export async function readerChoice(
  setting: (key: string) => Promise<string | undefined>,
): Promise<ReaderChoice> {
  const chosen = await setting(READER_SETTING.model);
  return {
    model: SUB_AGENT_MODELS.find((m) => m.id === chosen)?.id ?? READER_MODEL,
    effort: Schema.decodeUnknownOption(Effort)(
      await setting(READER_SETTING.effort),
    ).pipe(Option.getOrElse(() => READER_EFFORT)),
  };
}

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
  /** The run under way: the delete of its document stops it. */
  let current: { documentId: string; stop: AbortController } | undefined;

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

  /** A reading whose document was deleted meanwhile ends here, quietly. */
  const unlessGone = async (work: Promise<void>) => {
    try {
      await work;
    } catch (error) {
      if (!(error instanceof ReadingGone)) throw error;
    }
  };

  /** Ends a run that completed: drafts, page states, the end line, the ask. */
  const finish = async (run: Run) => {
    const end = await readings.ending(run);
    await unlessGone(
      deps.event(
        run.personId,
        {
          kind: "document_read",
          line: end.line,
          facts: end.facts,
          ...(end.ask !== undefined && { ask: end.ask }),
        },
        async (trx) => {
          await readings.finish(trx, run);
        },
      ),
    );
    readings.changed(run.personId);
  };

  /** Ends a reading as failed: its entries kept, no drafts, the end line. */
  const fail = async (run: Run, why: string) => {
    const end = await readings.ending(run, why);
    await unlessGone(
      deps.event(
        run.personId,
        { kind: "document_read", line: end.line, facts: end.facts },
        async (trx) => {
          await readings.fail(trx, run, why);
        },
      ),
    );
    readings.changed(run.personId);
  };

  /** One run of a reading, from its start to its end or its next wait. */
  const runJob = async (job: Job, runSubAgent: RunSubAgent) => {
    const mine = { documentId: job.documentId, stop: new AbortController() };
    current = mine;
    try {
      await runOnce(job, runSubAgent, mine.stop.signal);
    } catch (error) {
      if (!(error instanceof ReadingGone)) throw error;
    } finally {
      if (current === mine) current = undefined;
    }
  };

  /** One run; `deleted` aborts when its document is deleted. */
  const runOnce = async (
    job: Job,
    runSubAgent: RunSubAgent,
    deleted: AbortSignal,
  ) => {
    /** Rufi is stopping, or the document is gone: nothing more is written. */
    const ended = () => stop.signal.aborted || deleted.aborted;
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
    const { model, effort } = await deps.choice();
    const counts = { looks: 0, saves: 0 };
    // The attempt's key: its tools for this person, document and attempt.
    const key = deps.mcp.keys.issue({
      tools: tools.specs,
      call: async ({ tool, input, callId }) => {
        const answer = await tools.call(tool, input, callId);
        if (tool === "get_page") counts.looks++;
        if (tool === "save_page" && answer.ok) {
          counts.saves++;
          readings.changed(started.personId);
        }
        return answer;
      },
    });
    const signal = AbortSignal.any([stop.signal, deleted]);
    /** From a Stop, a delete or the end on, the attempt takes no more calls. */
    const close = () => {
      started.closed = true;
      deps.mcp.keys.revoke(key);
    };
    signal.addEventListener("abort", close, { once: true });
    const t0 = Date.now();
    let outcome: SubAgentOutcome;
    try {
      outcome = await runSubAgent(
        {
          model,
          effort,
          instructions: READER_INSTRUCTIONS,
          input: readerInput(await readings.about(started)),
          tools: {
            url: deps.mcp.url(),
            key,
            names: tools.specs.map((spec) => spec.name),
          },
          onCompaction: () => {
            started.lookedAt.clear();
          },
          deadlineMs: (deps.deadlineMs ?? deadlineFor)(job.targets.length),
        },
        signal,
      );
    } catch (error) {
      close();
      if (ended()) return;
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
    close();
    const { end } = outcome;
    log("reader.ended", {
      status: end.status,
      ms: Date.now() - t0,
      count: counts.saves,
    });
    // Rufi is stopping: the next start queues the reading again. Or the
    // document was deleted: its reading is gone.
    if (ended()) return;
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
    await readings.recordRun(started, usage, {
      ...READER_VERSION,
      model,
      effort,
    });

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
    /** The document was deleted: its run, when one is under way, stops. */
    stopDocument: (documentId: string) => {
      if (current?.documentId === documentId) current.stop.abort();
    },
    /** Stops: a running reading is interrupted and left for the next start. */
    close: async () => {
      stop.abort();
      poke();
      await loop;
    },
  };
}
