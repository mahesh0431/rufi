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

/** What the core refused, in its own words. */
class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

/** A request to the core; its answer as JSON. */
async function request(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  await session;
  const headers: Record<string, string> = {
    [PROOF_HEADER]: sessionStorage.getItem(PROOF_KEY) ?? "",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  let answer: Answer;
  try {
    answer = await fetchInTime(path, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (!ending.signal.aborted) setConnection("offline");
    throw new ApiError(0, "Rufi can't be reached.", { cause: error });
  }
  if (answer.status === 401) {
    setConnection("ended");
    throw new ApiError(401, "Open Rufi again from the terminal.");
  }
  setConnection("ok");
  const { json } = answer;
  if (answer.status < 200 || answer.status > 299) {
    const message =
      typeof json === "object" && json !== null && "error" in json
        ? String(json.error)
        : "Rufi had a problem with that.";
    throw new ApiError(answer.status, message);
  }
  return json;
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
