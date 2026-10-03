// Rufi's diagnostics: one JSON line per event in $RUFI_HOME/logs/rufi.log,
// on this Mac only. An event is a fixed name and a few fields: IDs, names,
// numbers, timings and error codes. Never a prompt, a reply, health text, a
// token or an error's message: those stay in memory with the code that
// handles them.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { Cause, Context, Effect, Layer, Logger, References } from "effect";
import { Home } from "./config.ts";

export type LogFields = Readonly<
  Record<string, string | number | boolean | undefined>
>;
export type Log = (event: string, fields?: LogFields) => void;

/** The size one log file reaches before the next starts, and how many are kept. */
const FILE_BYTES = 10 * 1024 * 1024;
const FILES = 5;

/**
 * A text value is kept only when it looks like an ID, a name or a code: at
 * most 64 characters (a UUID is 36), without spaces. Any other text (words,
 * tokens, which are longer) is replaced, so a mistake at a
 * call site can't put health text or a secret in the file.
 */
const SAFE_TEXT = /^[\w.:/@#+-]{1,64}$/;

export function safeFields(fields: LogFields = {}): LogFields {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields) as [string, unknown][]) {
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = SAFE_TEXT.test(value) ? value : "[redacted]";
    }
    // Anything else (an object, an error) is left out: it could hold anything.
  }
  return out;
}

/** An error's code: its `code` when it has one, else its kind. Never its message. */
export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") {
      return String(code);
    }
    if (error instanceof Error) return error.name;
  }
  return typeof error;
}

export interface Diagnostics {
  log: Log;
  /** Where the current file is. */
  path: string;
}

/**
 * Writes events to `$home/logs/rufi.log`, readable only by this user, and
 * also to `echo` (the terminal with --debug). At 10 MB the file moves to
 * rufi.log.1, and so on; the fifth older file is deleted.
 */
export function diagnostics(
  home: string,
  echo?: (line: string) => void,
): Diagnostics {
  const folder = join(home, "logs");
  const path = join(folder, "rufi.log");
  const log: Log = (event, fields) => {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      event,
      ...safeFields(fields),
    });
    echo?.(line);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (existsSync(path) && statSync(path).size >= FILE_BYTES) rotate(path);
    appendFileSync(path, `${line}\n`, { mode: 0o600 });
  };
  return { log, path };
}

function rotate(path: string): void {
  rmSync(`${path}.${String(FILES - 1)}`, { force: true });
  for (let n = FILES - 2; n >= 1; n--) {
    if (existsSync(`${path}.${String(n)}`)) {
      renameSync(`${path}.${String(n)}`, `${path}.${String(n + 1)}`);
    }
  }
  renameSync(path, `${path}.1`);
}

/**
 * Effect's logging, sent to the same file under the same rules: the message
 * is the event name, an optional object gives the fields, open log spans give
 * timings in ms, and a failure gives only its error codes. It replaces
 * Effect's own loggers, which would print errors and stack traces.
 */
export function effectLogs(log: Log) {
  const logger = Logger.make(({ message, logLevel, cause, fiber, date }) => {
    const parts: readonly unknown[] = Array.isArray(message)
      ? message
      : [message];
    const [event, fields] = parts;
    const timings: Record<string, number> = {};
    for (const [label, start] of fiber.getRef(References.CurrentLogSpans)) {
      timings[`${label}_ms`] = date.getTime() - start;
    }
    const codes = cause.reasons.map((reason) =>
      Cause.isFailReason(reason)
        ? errorCode(reason.error)
        : Cause.isDieReason(reason)
          ? errorCode(reason.defect)
          : "interrupted",
    );
    log(typeof event === "string" ? event : "effect.log", {
      level: logLevel,
      ...(isFields(fields) ? fields : {}),
      ...timings,
      ...(codes.length > 0 && { errors: codes.join(",") }),
    });
  });
  return Logger.layer([logger]);
}

function isFields(value: unknown): value is LogFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The log, for the parts that write to it. */
export class Logs extends Context.Service<Logs, Log>()("rufi/Logs") {}

/**
 * The log file in Rufi's data folder (and the terminal, with `echo`), for
 * Rufi's own events and for Effect's.
 */
export const logsLayer = (echo?: (line: string) => void) =>
  Layer.unwrap(
    Effect.map(Home, (home) => {
      const { log } = diagnostics(home, echo);
      return Layer.merge(Layer.succeed(Logs, log), effectLogs(log));
    }),
  );
