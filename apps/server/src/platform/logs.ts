// Rufi's diagnostics: one JSON line per event in $RUFI_HOME/logs/rufi.log,
// on this Mac only. An event is a fixed name and a few checked fields:
// protocol methods, tool names, statuses, timings and error codes. Never a
// prompt, a reply, health text, a token or an error's message: those stay in
// memory with the code that handles them.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer, Logger } from "effect";
import { Home } from "./config.ts";

/** Every event Rufi logs. */
const EVENTS = new Set([
  "codex.ignored",
  "codex.exited",
  "codex.request",
  "codex.notification_ignored",
  "codex.other_turn",
  "codex.process_list_failed",
  "codex.commands_left",
  "codex.interrupt_failed",
  "tool.failed",
  "turn.ended",
] as const);

export type LogEvent = typeof EVENTS extends Set<infer E> ? E : never;
type LogFields = Readonly<Record<string, string | number | undefined>>;
export type Log = (event: LogEvent, fields?: LogFields) => void;

/** The size one log file reaches before the next starts, and how many are kept. */
const FILE_BYTES = 10 * 1024 * 1024;
const FILES = 5;

/** An OS or Node code (ENOENT, ERR_…), a number or a signal. */
const CODE = /^(?:E[A-Z0-9_]{1,40}|-?\d{1,10}|SIG[A-Z0-9]{1,10})$/;
/** The built-in error kinds; Rufi's own errors are kind "Error". */
const KINDS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AbortError",
  "TimeoutError",
]);
const isCode = (value: unknown) =>
  typeof value === "string" && (CODE.test(value) || KINDS.has(value));

/**
 * What each field may hold. Values come from code, never from a person or the
 * model: a field not named here is left out, and a value that doesn't fit
 * becomes "other". So no call site can put health text or a secret in a log.
 */
const FIELDS: Record<string, (value: unknown) => boolean> = {
  // A Codex protocol method ("item/tool/call"), as the Codex binary sends it.
  method: (value) =>
    typeof value === "string" &&
    /^[a-z][a-zA-Z]{0,40}(?:\/[a-z][a-zA-Z]{0,40}){0,3}$/.test(value),
  // A tool in Rufi's registry; the registry logs only after finding it.
  tool: (value) =>
    typeof value === "string" && /^[a-z][a-z_]{0,63}$/.test(value),
  // What the Codex connection ignored (rpc.ts, appserver.ts).
  what: (value) =>
    value === "not_json_rpc" ||
    value === "reply_to_no_request" ||
    value === "cleanup_after_exit_failed",
  status: (value) =>
    value === "completed" || value === "failed" || value === "interrupted",
  code: isCode,
  error: isCode,
  ms: (value) => typeof value === "number" && Number.isFinite(value),
};

function line(event: LogEvent, fields: LogFields = {}): string {
  const out: Record<string, string | number> = {
    time: new Date().toISOString(),
    event: EVENTS.has(event) ? event : "unnamed",
  };
  for (const [key, value] of Object.entries(fields)) {
    const valid = FIELDS[key];
    if (valid && value !== undefined) out[key] = valid(value) ? value : "other";
  }
  return JSON.stringify(out);
}

/** An error's code when it has a known shape, else its kind. Never its message. */
export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" && Number.isInteger(code)) return String(code);
    if (isCode(code)) return code as string;
    if (error instanceof Error && KINDS.has(error.name)) return error.name;
  }
  return "other";
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
  let writing = true;
  const log: Log = (event, fields) => {
    const text = line(event, fields);
    echo?.(text);
    if (!writing) return;
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (existsSync(path) && statSync(path).size >= FILE_BYTES) rotate(path);
      appendFileSync(path, `${text}\n`, { mode: 0o600 });
    } catch (error) {
      // Logging must never stop Rufi or skip a clean-up: the log turns off
      // for this run, and the person is told once, with the code only.
      writing = false;
      process.stderr.write(
        `Rufi couldn't write its log (${errorCode(error)}); the log is off until Rufi restarts.\n`,
      );
    }
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

/** The log, for the parts that write to it. */
export class Logs extends Context.Service<Logs, Log>()("rufi/Logs") {}

/** The log file in Rufi's data folder (and the terminal, with `echo`). */
export const logsLayer = (echo?: (line: string) => void) =>
  Layer.effect(
    Logs,
    Effect.map(Home, (home) => diagnostics(home, echo).log),
  );

/**
 * Effect's own logging, off: Rufi logs only the events above, and Effect's
 * loggers would print messages, causes and stack traces.
 */
export const noEffectLogs = Logger.layer([]);
