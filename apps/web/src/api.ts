// The screens' only way to the core. The tab's proof stays in this module and
// sessionStorage; components never see it. A 401 ends the session for every
// request; a request that can't reach the core marks Rufi as offline until a
// check gets through again.
import { SessionProof } from "@rufi/contracts";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";

const PROOF_KEY = "rufi.proof";
const PROOF_HEADER = "x-rufi-proof";
/** How often an offline page checks whether Rufi is back. */
const RETRY_MS = 3_000;

/** ok; offline: the core can't be reached; ended: this tab's session is over. */
export type Connection = "ok" | "offline" | "ended";

let connection: Connection = "ok";
const listeners = new Set<() => void>();
let retrying: ReturnType<typeof setTimeout> | undefined;
/** Aborts every request when the session ends. */
const ending = new AbortController();

function setConnection(next: Connection): void {
  if (connection === "ended" || connection === next) return;
  connection = next;
  if (next === "ended") ending.abort();
  for (const listener of listeners) listener();
  if (next === "offline") retry();
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

/**
 * Swaps the link's single-use token for this tab's proof, once, and takes the
 * token out of the address bar. False when there is no session to continue.
 */
export async function startSession(): Promise<boolean> {
  const launch = new URLSearchParams(location.hash.slice(1)).get("launch");
  if (launch !== null) {
    history.replaceState(null, "", location.pathname + location.search);
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ launch }),
    });
    if (response.ok) {
      const { proof } = Schema.decodeUnknownSync(SessionProof)(
        await response.json(),
      );
      sessionStorage.setItem(PROOF_KEY, proof);
    }
  }
  const ok = sessionStorage.getItem(PROOF_KEY) !== null;
  if (!ok) setConnection("ended");
  return ok;
}

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
  const headers: Record<string, string> = {
    [PROOF_HEADER]: sessionStorage.getItem(PROOF_KEY) ?? "",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      signal: ending.signal,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (!ending.signal.aborted) setConnection("offline");
    throw new ApiError(0, "Rufi can't be reached.", { cause: error });
  }
  if (response.status === 401) {
    setConnection("ended");
    throw new ApiError(401, "Open Rufi again from the terminal.");
  }
  setConnection("ok");
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof json === "object" && json !== null && "error" in json
        ? String(json.error)
        : "Rufi had a problem with that.";
    throw new ApiError(response.status, message);
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
