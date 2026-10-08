// The screens' only way to the core. The tab's proof stays in this module and
// sessionStorage; components never see it. A 401 ends the session for every
// request; a request that can't reach the core in time marks Rufi as offline,
// and a check every few seconds brings it back.
import { SessionProof } from "@rufi/contracts";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";

const PROOF_KEY = "rufi.proof";
const PROOF_HEADER = "x-rufi-proof";
/** How often an offline page checks whether Rufi is back. */
const RETRY_MS = 3_000;
/** The core answers from this Mac: longer than this means it can't. */
const DEADLINE_MS = 15_000;
/** A live stream pings every 15 s; silent this long, it has stopped. */
const SILENT_MS = 45_000;

/** ok; offline: the core can't be reached; ended: this tab's session is over. */
export type Connection = "ok" | "offline" | "ended";

let connection: Connection = "ok";
const listeners = new Set<() => void>();
let retrying: ReturnType<typeof setTimeout> | undefined;
/** Aborts every request when the session ends. */
const ending = new AbortController();

function setConnection(next: Connection): void {
  if (connection === "ended") return;
  // Each failure while offline schedules the next check.
  if (next === "offline") retry();
  else clearTimeout(retrying);
  if (connection === next) return;
  connection = next;
  if (next === "ended") ending.abort();
  for (const listener of listeners) listener();
}

/** The connection state, for the banner and the session notice. */
export function useConnection(): Connection {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => connection,
  );
}

/** Tells `listener` when Rufi can be reached again, so reads are refreshed. */
export function onReconnect(listener: () => void): () => void {
  const wrapped = () => {
    if (connection === "ok") listener();
  };
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}

function retry(): void {
  clearTimeout(retrying);
  retrying = setTimeout(() => {
    void request("GET", "/api/status").catch(() => undefined);
  }, RETRY_MS);
}

/** An answer read to its end: the status, and the body as JSON ({} if none). */
interface Answer {
  status: number;
  json: unknown;
}

/**
 * A request and its whole answer, body included, within the deadline; it
 * gives up then, or when the session ends.
 */
async function fetchInTime(path: string, init: RequestInit): Promise<Answer> {
  // A timer, not AbortSignal.timeout, so a test's clock can drive it.
  const late = new AbortController();
  const timer = setTimeout(() => {
    late.abort();
  }, DEADLINE_MS);
  try {
    const response = await fetch(path, {
      ...init,
      signal: AbortSignal.any([ending.signal, late.signal]),
    });
    const text = await response.text();
    return { status: response.status, json: parseJson(text) };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {}; // not JSON: the status says what happened
  }
}

/**
 * Swaps the link's single-use token for this tab's proof, once, and takes the
 * token out of the address bar. Without a token, the tab keeps the proof it
 * has; without either, its session has ended.
 */
async function startSession(): Promise<void> {
  const launch = new URLSearchParams(location.hash.slice(1)).get("launch");
  if (launch !== null) {
    history.replaceState(null, "", location.pathname + location.search);
    try {
      const answer = await fetchInTime("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ launch }),
      });
      if (answer.status === 200) {
        const { proof } = Schema.decodeUnknownSync(SessionProof)(answer.json);
        sessionStorage.setItem(PROOF_KEY, proof);
      }
    } catch {
      // Rufi can't be reached in time. The checks show it as offline; when it
      // answers, a lost token ends the session there.
      if (!ending.signal.aborted) setConnection("offline");
      return;
    }
  }
  if (sessionStorage.getItem(PROOF_KEY) === null) setConnection("ended");
}

/** Started once as the page loads; every request waits for it. */
const session = startSession();

/** What the core refused, in its own words, with the rest of its answer. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(
    status: number,
    message: string,
    body?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.status = status;
    this.body = body;
  }
}

const refusal = (json: unknown) =>
  typeof json === "object" && json !== null && "error" in json
    ? String(json.error)
    : "Rufi had a problem with that.";

const headersFor = (body: unknown): Record<string, string> => ({
  [PROOF_HEADER]: sessionStorage.getItem(PROOF_KEY) ?? "",
  ...(body !== undefined && { "content-type": "application/json" }),
});

/** A request to the core; its answer as JSON. */
export async function request(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  await session;
  const headers = headersFor(body);
  let answer: Answer;
  try {
    answer = await fetchInTime(path, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (!ending.signal.aborted) setConnection("offline");
    throw new ApiError(0, "Rufi can't be reached.", undefined, {
      cause: error,
    });
  }
  if (answer.status === 401) {
    setConnection("ended");
    throw new ApiError(401, "Open Rufi again from the terminal.");
  }
  setConnection("ok");
  const { json } = answer;
  if (answer.status < 200 || answer.status > 299) {
    throw new ApiError(answer.status, refusal(json), json);
  }
  return json;
}

/**
 * Reads a live stream, giving each line to `onLine`, until the core ends it,
 * `signal` aborts, or it stays silent too long (the caller connects again).
 * A 401 ends the session; a stream that can't reach the core marks Rufi as
 * offline.
 */
export async function stream(
  path: string,
  onLine: (line: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  await session;
  const silent = new AbortController();
  // A timer, not AbortSignal.timeout, so a test's clock can drive it.
  let timer = setTimeout(() => {
    silent.abort();
  }, DEADLINE_MS);
  const heard = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      silent.abort();
    }, SILENT_MS);
  };
  const stopped = AbortSignal.any([ending.signal, silent.signal, signal]);
  try {
    let response: Response;
    try {
      response = await fetch(path, {
        headers: headersFor(undefined),
        signal: stopped,
      });
    } catch (error) {
      if (!ending.signal.aborted && !signal.aborted) setConnection("offline");
      throw new ApiError(0, "Rufi can't be reached.", undefined, {
        cause: error,
      });
    }
    if (response.status === 401) {
      setConnection("ended");
      throw new ApiError(401, "Open Rufi again from the terminal.");
    }
    if (!response.ok || response.body === null) {
      const json = parseJson(await response.text());
      throw new ApiError(response.status, refusal(json), json);
    }
    setConnection("ok");
    heard();
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      heard();
      const lines = (rest + value).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line !== "") onLine(JSON.parse(line));
    }
  } finally {
    clearTimeout(timer);
  }
}

/** A request whose answer must match a contract. */
export async function read<S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<S["Type"]> {
  return Schema.decodeUnknownSync(schema)(await request(method, path, body));
}

/**
 * How long an export may take, answer and file included: the core copies
 * and checks the whole record first, so longer than an ordinary request.
 */
const DOWNLOAD_MS = 5 * 60_000;

/**
 * Downloads a file the core makes: fetched with the tab's proof, then saved
 * through the browser (the Rufi app asks where). Gives the file's name.
 */
export async function download(path: string): Promise<string> {
  await session;
  // A timer, not AbortSignal.timeout, so a test's clock can drive it.
  const late = new AbortController();
  const timer = setTimeout(() => {
    late.abort();
  }, DOWNLOAD_MS);
  try {
    let response: Response;
    let file: Blob;
    try {
      response = await fetch(path, {
        headers: headersFor(undefined),
        signal: AbortSignal.any([ending.signal, late.signal]),
      });
      file = await response.blob();
    } catch (error) {
      if (late.signal.aborted) {
        throw new ApiError(
          0,
          "The export didn't come in time. Try again.",
          undefined,
          {
            cause: error,
          },
        );
      }
      if (!ending.signal.aborted) setConnection("offline");
      throw new ApiError(0, "Rufi can't be reached.", undefined, {
        cause: error,
      });
    }
    if (response.status === 401) {
      setConnection("ended");
      throw new ApiError(401, "Open Rufi again from the terminal.");
    }
    setConnection("ok");
    if (!response.ok) {
      const json = parseJson(await file.text());
      throw new ApiError(response.status, refusal(json), json);
    }
    const name =
      /filename="([^"]+)"/.exec(
        response.headers.get("content-disposition") ?? "",
      )?.[1] ?? "rufi-export.zip";
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    // The browser has the file once the click is handled.
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60_000);
    return name;
  } finally {
    clearTimeout(timer);
  }
}
