// JSON-RPC over newline-delimited JSON, as Codex app-server speaks it on stdio.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** An error reply, from Codex or to send back to it. */
export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RpcHandlers {
  /** Answers a request from Codex; throw an RpcError to refuse it. */
  request: (method: string, params: unknown) => Promise<unknown>;
  notification: (method: string, params: unknown) => void;
  /** Something Rufi ignored, for the debug log. */
  ignored: (what: string) => void;
}

export interface Rpc {
  request: <T>(
    method: string,
    params: unknown,
    timeoutMs: number,
  ) => Promise<T>;
  notify: (method: string, params?: unknown) => void;
  /** Fails every pending request with `reason`; later requests fail at once. */
  close: (reason: Error) => void;
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function connect(
  input: Readable,
  output: Writable,
  handlers: RpcHandlers,
  answerWithinMs: number,
): Rpc {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed: Error | undefined;

  const send = (message: object) => {
    if (!closed) output.write(`${JSON.stringify(message)}\n`);
  };

  const close = (reason: Error) => {
    if (closed) return;
    closed = reason;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(reason);
    }
    pending.clear();
  };
  output.on("error", (error) => {
    close(new Error("Lost the connection to Codex.", { cause: error }));
  });

  const answer = async (id: unknown, method: string, params: unknown) => {
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      timeout.reject(
        new RpcError(-32000, `Rufi couldn't answer ${method} in time.`),
      );
    }, answerWithinMs);
    try {
      const result = await Promise.race([
        handlers.request(method, params),
        timeout.promise,
      ]);
      send({ id, result });
    } catch (error) {
      const refusal =
        error instanceof RpcError
          ? error
          : new RpcError(-32603, `Rufi couldn't answer ${method}.`);
      send({ id, error: { code: refusal.code, message: refusal.message } });
    } finally {
      clearTimeout(timer);
    }
  };

  createInterface({ input }).on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null)
        throw new Error("not an object");
      message = parsed as Record<string, unknown>;
    } catch {
      handlers.ignored("a line that isn't JSON-RPC");
      return;
    }
    const { id, method } = message;
    if (typeof method === "string") {
      if (id === undefined) handlers.notification(method, message["params"]);
      else void answer(id, method, message["params"]);
      return;
    }
    const call = typeof id === "number" ? pending.get(id) : undefined;
    if (!call) {
      handlers.ignored("a reply to no request");
      return;
    }
    pending.delete(id as number);
    clearTimeout(call.timer);
    const error = message["error"] as
      | { code?: unknown; message?: unknown }
      | undefined;
    if (error) {
      call.reject(
        new RpcError(
          typeof error.code === "number" ? error.code : -32603,
          `Codex refused ${call.method}: ${String(error.message)}`,
        ),
      );
    } else call.resolve(message["result"]);
  });

  return {
    request: <T>(method: string, params: unknown, timeoutMs: number) => {
      if (closed) return Promise.reject(closed);
      const id = nextId++;
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `Codex didn't answer ${method} within ${String(timeoutMs / 1000)} s.`,
          ),
        );
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      send({ id, method, params });
      return promise as Promise<T>;
    },
    notify: (method, params) => {
      send(params === undefined ? { method } : { method, params });
    },
    close,
  };
}
