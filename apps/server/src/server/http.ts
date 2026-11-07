// What every listener of Rufi's API shares: the answer to an error, the
// headers on every response (the CSP first of all), and the body limits.
// A listener puts its own checks of where a request comes from and who
// sends it (`guard`) between the headers and the limits, so a refused
// request still carries the headers.
import type { HttpBindings } from "@hono/node-server";
import { Result, Schema } from "effect";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { except } from "hono/combine";
import { MAX_BATCH_BYTES } from "../core/devices/devices.ts";
import { errorCode, type Log } from "../platform/logs.ts";

/** A listener of Rufi's API. */
export type App = Hono<{ Bindings: HttpBindings }>;

/**
 * The screens' policy: only Rufi's own code and styles. Frames: a
 * document's original (a blob the page made) and Rufi's own pages, which
 * only a reply's visual frames (visual-frame.ts); every other page refuses
 * to be framed. A frame can't move itself to another origin either.
 */
const APP_CSP =
  "default-src 'self'; img-src 'self' data: blob:; frame-src blob: 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** The most one add of documents may hold: many photos, or a long PDF. */
const MAX_ADD_BYTES = 256 * 1024 * 1024;
/** The address documents are added at; it takes files, so a larger body. */
const ADD_PATH = /^\/api\/people\/[^/]+\/documents$/;
/** The address a paired app sends device batches to (remote.ts): up to 4 MB. */
const BATCHES_PATH = "/api/batches";

export class HttpError extends Error {
  readonly status:
    | 400
    | 401
    | 403
    | 404
    | 409
    | 410
    | 413
    | 422
    | 500
    | 502
    | 503;
  /** More of the answer, beside the error. */
  readonly more: Record<string, unknown>;
  constructor(
    status: HttpError["status"],
    message: string,
    more: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.more = more;
  }
}

/**
 * Sets up `app` with what every listener shares, `guard` in its place, and
 * gives the larger body limit an add of documents takes.
 */
export function shared(
  app: App,
  { log, guard }: { log: Log; guard: MiddlewareHandler },
): { adds: MiddlewareHandler } {
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ ...error.more, error: error.message }, error.status);
    }
    log("api.failed", { error: errorCode(error) });
    return c.json({ error: "Rufi had a problem with that request." }, 500);
  });
  app.notFound((c) => c.json({ error: "Not found." }, 404));

  // Every response: no framing, no sniffing, no referrer, no caching of API data.
  app.use("*", async (c, next) => {
    c.header("Content-Security-Policy", APP_CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("*", guard);

  const limit = (
    maxSize: number,
    refusal: string,
    more: Record<string, unknown> = {},
  ) =>
    bodyLimit({
      maxSize,
      onError: () => {
        throw new HttpError(413, refusal, more);
      },
    });
  const requests = limit(1024 * 1024, "That request is too large.");
  const adds = limit(
    MAX_ADD_BYTES,
    "Those files are too large to add at once (256 MB at most). Add fewer at a time.",
  );
  const batches = limit(
    MAX_BATCH_BYTES,
    "This batch is larger than Rufi takes (4 MB). Update Rufi on your iPhone (or on your Mac) so they match.",
    { answer: "refused", problems: ["too_big"] },
  );
  // An add of documents has its own, larger limit (`adds`, on its route);
  // a batch has its own.
  app.use(
    "/api/*",
    except(
      (c) =>
        c.req.method === "POST" &&
        (ADD_PATH.test(c.req.path) || c.req.path === BATCHES_PATH),
      requests,
    ),
  );
  app.post(BATCHES_PATH, batches);
  return { adds };
}

/** The request's JSON body as `schema` reads it; a 400 with `refusal` if not. */
export async function body<S extends Schema.Codec<unknown, unknown>>(
  c: Context,
  schema: S,
  refusal = "That request isn't valid.",
): Promise<S["Type"]> {
  const parsed = Schema.decodeUnknownResult(schema)(
    await c.req.json().catch(() => undefined),
  );
  if (Result.isFailure(parsed)) {
    throw new HttpError(400, refusal);
  }
  return parsed.success;
}
