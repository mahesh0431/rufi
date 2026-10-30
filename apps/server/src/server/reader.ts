// The document reader at work: reads one job when its reply asks
// (server/chat.ts), as a Rufi sub-agent (agent/codex/subagent.ts) with the
// reader's two tools, one reading at a time across Rufi. This call is the
// one seam to the reader: whoever starts a reading calls it with the job,
// a signal that stops it, and where its progress goes. Each run uses the
// model and effort chosen in Settings when it starts. Only a reader turn
// that completed normally finishes a reading. A run that failed for a
// passing reason (also a sign-in ChatGPT can't renew just now) is tried
// again by itself, up to three times, each after a longer wait, inside the
// call; an account problem (signed out, a sign-in that has ended, a usage
// limit), Rufi's deadline or a fourth failure ends the reading as failed,
// with the reason, its copies kept. A stop leaves the job to its caller,
// which fails it with its copies kept. The reader gets its two tools from
// Rufi's MCP server, with a key for one attempt.
import { Effort } from "@rufi/contracts";
import { Option, Schema } from "effect";
import { ChatGptError } from "../agent/chatgpt/openai.ts";
import { callOf } from "../agent/codex/events.ts";
import { SUB_AGENT_MODELS } from "../agent/codex/subagent.ts";
import type { RunSubAgent, SubAgentOutcome } from "../agent/runtime.ts";
import type { Run } from "../core/documents/notebook.ts";
import {
  READER_EFFORT,
  READER_MODEL,
} from "../core/documents/reader-instructions.ts";
import type { ReaderKind } from "../core/documents/reader-tools.ts";
import {
  ReadingGone,
  type Job,
  type Readings,
  type Usage,
} from "../core/documents/reading.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import type { McpKeys } from "./mcp.ts";

export interface ReaderDeps {
  readings: Readings;
  /** How the reader reads: its instructions, message, tools and version. */
  kind: ReaderKind;
  /** Runs the reader sub-agent; without one, a reading fails at once. */
  run: RunSubAgent | undefined;
  /** The model and effort chosen in Settings (readerChoice), read as a run starts. */
  choice: () => Promise<ReaderChoice>;
  /** Rufi's MCP endpoint for the reader: its address and its keys. */
  mcp: { url: () => string; keys: McpKeys };
  log: Log;
  /** How long one run of a reading may take, for its number of pages. */
  deadlineMs?: (pages: number) => number;
  /** The waits before each automatic retry. */
  retryWaitsMs?: readonly number[];
  /** The clock for wait times, the same as the readings' clock. */
  now?: () => number;
}

/**
 * A run's deadline: 5 minutes, and one more per page it saves, at most an
 * hour. A dense 45-row page took about 45 s on the test pack.
 */
const deadlineFor = (pages: number) => Math.min(60, 5 + pages) * 60_000;

/** A run that failed for a passing reason is tried again after these. */
const RETRY_WAITS_MS = [30_000, 60_000, 120_000];

/** How far a reading is, as it goes: for its step in the reply. */
export interface ReadProgress {
  /** waiting: for another reading; again: for an automatic retry. */
  state: "waiting" | "copying" | "again";
  saved: number;
  of: number;
}

/** How a reading's call ended. */
export type ReadEnd =
  | { ended: "done" }
  /** The job failed, with why in words for the person. */
  | { ended: "failed"; why: string }
  /** Its signal stopped it: the job is the caller's to fail. */
  | { ended: "stopped" }
  /** Its document was deleted meanwhile. */
  | { ended: "deleted" };

/** Why a reading can't start without the reader sub-agent. */
const NO_READER = "Rufi's reader isn't available here";

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

export function reader(deps: ReaderDeps) {
  const { readings, log } = deps;
  const now = deps.now ?? Date.now;
  /** Closing: every reading stops. */
  const closing = new AbortController();
  /** One reading at a time: each waits for the one before. */
  let slot: Promise<unknown> = Promise.resolve();
  /** The runs under way, by document: its delete stops them. */
  const running = new Map<string, AbortController>();

  /** Waits `ms`, or less when `signal` stops. */
  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });

  /**
   * One run, from its start to its end: done, failed for good, a passing
   * failure to try again, or stopped (the signal) and gone (the delete).
   */
  const runOnce = async (
    job: Job,
    runSubAgent: RunSubAgent,
    signal: AbortSignal,
    deleted: AbortSignal,
    progress: (saved: number) => void,
  ): Promise<
    | { ended: "done" | "stopped" | "deleted" }
    | { ended: "failed" | "passing"; why: string; run: Run }
  > => {
    const run = await readings.startRun(job);
    const ended = () =>
      deleted.aborted
        ? ({ ended: "deleted" } as const)
        : ({ ended: "stopped" } as const);
    const tools = deps.kind.tools(run, log);
    const { model, effort } = await deps.choice();
    const counts = { looks: 0, saves: 0 };
    const about = await readings.about(run);
    let saved = about.saved.length;
    // The attempt's key: its tools for this person, document and attempt.
    const key = deps.mcp.keys.issue({
      tools: tools.specs,
      call: async ({ tool, input, meta }) => {
        const answer = await tools.call(tool, input, callOf(meta).callId);
        if (tool === "get_page") counts.looks++;
        if (tool === "save_page" && answer.ok) {
          counts.saves++;
          progress(++saved);
          readings.changed(run.personId);
        }
        return answer;
      },
    });
    const stops = AbortSignal.any([signal, deleted]);
    /** From a stop, a delete or the end on, the attempt takes no more calls. */
    const close = () => {
      run.closed = true;
      deps.mcp.keys.revoke(key);
    };
    stops.addEventListener("abort", close, { once: true });
    if (stops.aborted) close();
    const t0 = Date.now();
    let outcome: SubAgentOutcome;
    try {
      outcome = await runSubAgent(
        {
          model,
          effort,
          instructions: deps.kind.instructions,
          input: deps.kind.input(about),
          tools: {
            url: deps.mcp.url(),
            key,
            names: tools.specs.map((spec) => spec.name),
          },
          onCompaction: () => {
            run.lookedAt.clear();
          },
          deadlineMs: (deps.deadlineMs ?? deadlineFor)(job.targets.length),
        },
        stops,
      );
    } catch (error) {
      close();
      if (signal.aborted || deleted.aborted) return ended();
      log("reader.failed", { error: errorCode(error) });
      if (
        error instanceof ChatGptError &&
        (error.code === "not_signed_in" ||
          error.code === "sign_in_again" ||
          error.code === "plan_use_off")
      ) {
        // The sign-in needs the person: its reason, in Rufi's words.
        return { ended: "failed", why: error.message, run };
      }
      if (error instanceof ChatGptError && error.code === "temporary") {
        // ChatGPT can't renew the sign-in now: a passing reason.
        return { ended: "passing", why: error.message, run };
      }
      return { ended: "passing", why: "Rufi couldn't start the AI", run };
    }
    close();
    const end = outcome.end;
    log("reader.ended", {
      status: end.status,
      ms: Date.now() - t0,
      count: counts.saves,
    });
    if (signal.aborted || deleted.aborted) return ended();
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
    await readings.recordRun(run, usage, {
      ...deps.kind.version,
      model,
      effort,
    });
    if (end.status === "completed") {
      await readings.finish(run);
      return { ended: "done" };
    }
    // Rufi's own deadline in Rufi's words; anything else as the service or
    // Codex said it.
    const why =
      (end.reason === "timeout" ? "the reading took too long" : end.text) ??
      "the reader stopped";
    return end.reason === "timeout" ||
      end.reason === "sign_in" ||
      end.reason === "usage_limit"
      ? { ended: "failed", why, run }
      : // A passing reason (a lost connection, a restart, a refused answer).
        { ended: "passing", why, run };
  };

  /**
   * Reads the queued job, after any other reading, until it ends: done,
   * failed (the job failed with why), stopped by `signal` (the job left
   * for the caller to fail) or deleted. `progress` hears how far it is.
   */
  const read = async (
    job: Job,
    signal: AbortSignal,
    progress: (now: ReadProgress) => void,
  ): Promise<ReadEnd> => {
    const stop = AbortSignal.any([signal, closing.signal]);
    const deleted = new AbortController();
    running.set(job.documentId, deleted);
    const { saved, of } = await readings.progress(job);
    progress({ state: "waiting", saved, of });
    const before = slot;
    const mine = Promise.withResolvers<undefined>();
    slot = before.then(() => mine.promise);
    try {
      // Another reading first; a stop meanwhile ends the wait.
      await Promise.race([
        before,
        new Promise<void>((resolve) => {
          stop.addEventListener(
            "abort",
            () => {
              resolve();
            },
            { once: true },
          );
          if (stop.aborted) resolve();
        }),
      ]);
      let current = job;
      let saving = saved;
      for (;;) {
        if (deleted.signal.aborted) return { ended: "deleted" };
        if (stop.aborted) return { ended: "stopped" };
        progress({ state: "copying", saved: saving, of });
        if (!deps.run) {
          const run = await readings.startRun(current);
          await readings.fail(run, NO_READER);
          return { ended: "failed", why: NO_READER };
        }
        const end = await runOnce(
          current,
          deps.run,
          stop,
          deleted.signal,
          (n) => {
            saving = n;
            progress({ state: "copying", saved: n, of });
          },
        );
        if (!("run" in end)) return end;
        const wait = (deps.retryWaitsMs ?? RETRY_WAITS_MS)[current.retries];
        if (end.ended === "failed" || wait === undefined) {
          await readings.fail(end.run, end.why);
          return { ended: "failed", why: end.why };
        }
        await readings.retryAt(end.run, new Date(now() + wait).toISOString());
        progress({ state: "again", saved: saving, of });
        await pause(wait, AbortSignal.any([stop, deleted.signal]));
        const again = await readings.job(current.id);
        if (!again) return { ended: "deleted" };
        current = again;
      }
    } catch (error) {
      if (error instanceof ReadingGone) return { ended: "deleted" };
      throw error;
    } finally {
      if (running.get(job.documentId) === deleted) {
        running.delete(job.documentId);
      }
      mine.resolve(undefined);
    }
  };

  return {
    read,
    /** The document was deleted: its reading, when one is under way, stops. */
    stopDocument: (documentId: string) => {
      running.get(documentId)?.abort();
    },
    /** Stops: a running reading is interrupted, for the next start to fail. */
    close: () => {
      closing.abort();
    },
  };
}

export type Reader = ReturnType<typeof reader>;
