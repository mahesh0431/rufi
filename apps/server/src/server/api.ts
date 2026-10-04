// Rufi's local API: what the screens use. Only on 127.0.0.1, only with both
// session proofs, and only for the person in the path: another person's
// conversation is not found.
import {
  AddPerson,
  ChooseConversation,
  CreateConversation,
  MessageText,
  MAX_MESSAGE_CHARS,
  ReorderWaiting,
  SaveDraft,
  SaveSettings,
  SelectModel,
  SendMessage,
  StartConversation,
  type Draft,
  type Overview,
  type Settings,
  type Status,
  type StreamLine,
} from "@rufi/contracts";
import { Result, Schema } from "effect";
import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { stream } from "hono/streaming";
import { Stopped } from "../agent/runtime.ts";
import { emergencyFor, emergencyRegions } from "../core/chat/safety.ts";
import {
  shown,
  type Change,
  type Transcripts,
} from "../core/chat/transcript.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import { ChatRefusal, type Chat } from "./chat.ts";
import { screen } from "./screens.ts";
import { sameSecret, type Sessions } from "./session.ts";

export interface ApiDeps {
  transcripts: Transcripts;
  chat: Chat;
  sessions: Sessions;
  /** The port Rufi listens on, once known. */
  port: () => number;
  /** A person's overview (the get_overview tool's answer). */
  overview: (personId: string) => Promise<Overview>;
  /** The ChatGPT sign-in, read when asked. */
  account: () => Promise<Status>;
  /** The secret `pnpm start` shows to get a fresh link while Rufi runs. */
  launcher: string;
  /** A fresh single-use link that opens Rufi. */
  launchUrl: () => string;
  /** The built screens' folder; none in tests that only use the API. */
  screens?: string;
  log: Log;
  /** Updates a screen may fall behind by before its stream is closed. */
  behindMax?: number;
}

/** The header the page sends its tab proof in. */
export const PROOF_HEADER = "x-rufi-proof";
/** The header `pnpm start` sends the launcher secret in. */
export const LAUNCHER_HEADER = "x-rufi-launcher";

const MESSAGE_REFUSAL = `A message needs some text, and can be at most ${MAX_MESSAGE_CHARS.toLocaleString("en")} characters.`;
/** A stream says it's alive this often when nothing happens. */
const PING_MS = 15_000;
/** Updates a screen may fall behind by before its stream is closed; it reconnects. */
const BEHIND_MAX = 1_000;

const CSP =
  "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const FORWARDING = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 502;
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

export function api(deps: ApiDeps): Hono<{ Bindings: HttpBindings }> {
  const { transcripts, chat } = deps;
  const app = new Hono<{ Bindings: HttpBindings }>();
  const cookie = () => `rufi_${String(deps.port())}`;
  const origin = () => `http://127.0.0.1:${String(deps.port())}`;

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ ...error.more, error: error.message }, error.status);
    }
    deps.log("api.failed", { error: errorCode(error) });
    return c.json({ error: "Rufi had a problem with that request." }, 500);
  });
  app.notFound((c) => c.json({ error: "Not found." }, 404));

  // Every response: no framing, no sniffing, no referrer, no caching of API data.
  app.use("*", async (c, next) => {
    c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
    for (const name of FORWARDING) {
      if (c.req.header(name) !== undefined) {
        throw new HttpError(400, "Rufi doesn't accept forwarded requests.");
      }
    }
    if (c.req.header("host") !== `127.0.0.1:${String(deps.port())}`) {
      throw new HttpError(403, "Open Rufi from its own link.");
    }
    // Browsers leave Origin out of ordinary GETs, and no GET changes anything.
    if (
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      c.req.header("origin") !== origin()
    ) {
      throw new HttpError(403, "That request didn't come from Rufi's page.");
    }
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: () => {
        throw new HttpError(413, "That request is too large.");
      },
    }),
  );

  app.post("/api/session", async (c) => {
    const { launch } = (await c.req.json().catch(() => ({}))) as {
      launch?: unknown;
    };
    const exchanged =
      typeof launch === "string"
        ? deps.sessions.exchange(launch, getCookie(c, cookie()))
        : undefined;
    if (!exchanged) {
      throw new HttpError(
        401,
        "This Rufi link has expired or was already used. Open Rufi again.",
      );
    }
    setCookie(c, cookie(), exchanged.session, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    return c.json({ proof: exchanged.proof });
  });

  // `pnpm start` while Rufi runs: a fresh link, only for the data folder's
  // secret (core.json, readable by this user only).
  app.post("/api/launch", (c) => {
    if (!sameSecret(c.req.header(LAUNCHER_HEADER), deps.launcher)) {
      throw new HttpError(403, "That request didn't come from Rufi.");
    }
    return c.json({ url: deps.launchUrl() });
  });

  app.use("/api/*", async (c: Context, next: Next) => {
    if (
      !deps.sessions.verify(getCookie(c, cookie()), c.req.header(PROOF_HEADER))
    ) {
      throw new HttpError(401, "Open Rufi from its own link to continue.");
    }
    await next();
  });

  const person = async (c: Context) => {
    const found = await transcripts.person(c.req.param("personId") ?? "");
    if (!found) throw new HttpError(404, "Not found.");
    return found;
  };
  const conversation = async (c: Context) => {
    const found = await transcripts.conversation(
      (await person(c)).id,
      c.req.param("conversationId") ?? "",
    );
    if (!found) throw new HttpError(404, "Not found.");
    return found;
  };
  const body = async <S extends Schema.Codec<unknown, unknown>>(
    c: Context,
    schema: S,
    refusal = "That request isn't valid.",
  ): Promise<S["Type"]> => {
    const parsed = Schema.decodeUnknownResult(schema)(
      await c.req.json().catch(() => undefined),
    );
    if (Result.isFailure(parsed)) {
      throw new HttpError(400, refusal);
    }
    return parsed.success;
  };
  /** A chat action: the agent's errors are shown as they are. */
  const acting = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof ChatRefusal) throw new HttpError(409, error.message);
      if (error instanceof Stopped) {
        throw new HttpError(409, "Stopped before the message was sent.");
      }
      deps.log("api.failed", { error: errorCode(error) });
      throw new HttpError(
        502,
        error instanceof Error ? error.message : "The AI couldn't do that.",
      );
    }
  };
  const emergency = async (): Promise<Settings> => {
    const known = emergencyFor(await transcripts.setting("emergency_region"));
    return {
      emergencyRegion: known?.region ?? null,
      emergency: known ? { name: known.name, number: known.number } : null,
      regions: emergencyRegions(),
    };
  };

  app.get("/api/people", async (c) =>
    c.json({ people: await transcripts.people() }),
  );
  app.post("/api/people", async (c) => {
    const { displayName } = await body(c, AddPerson);
    return c.json({ person: await transcripts.addPerson(displayName) }, 201);
  });

  app.get("/api/settings", async (c) => c.json(await emergency()));
  app.put("/api/settings", async (c) => {
    const { emergencyRegion } = await body(c, SaveSettings);
    if (emergencyRegion !== null && !emergencyFor(emergencyRegion)) {
      throw new HttpError(400, "Rufi doesn't know that region yet.");
    }
    await transcripts.saveSetting("emergency_region", emergencyRegion);
    return c.json(await emergency());
  });

  app.get("/api/status", async (c) => c.json(await deps.account()));

  app.get("/api/models", async (c) => {
    const { models, error } = await acting(() => chat.models());
    return c.json({ models, allowlistError: error ?? null });
  });

  app.get("/api/people/:personId/overview", async (c) =>
    c.json({ overview: await deps.overview((await person(c)).id) }),
  );

  const base = "/api/people/:personId/conversations";
  app.get(base, async (c) => {
    const { id } = await person(c);
    return c.json({
      conversations: await transcripts.conversations(id),
      chosen: await transcripts.chosen(id),
    });
  });
  app.post(base, async (c) => {
    const { id } = await person(c);
    const { title } = await body(c, CreateConversation);
    const created = await acting(() => chat.create(id, title ?? null));
    return c.json({ conversation: shown(created) }, 201);
  });

  // The conversation the chat continues for the person.
  app.put("/api/people/:personId/chosen", async (c) => {
    const { id } = await person(c);
    const { conversationId } = await body(c, ChooseConversation);
    if (
      conversationId !== null &&
      !(await transcripts.conversation(id, conversationId))
    ) {
      throw new HttpError(404, "Not found.");
    }
    await transcripts.choose(id, conversationId);
    return c.json({ chosen: conversationId });
  });

  /** Sends from a box under way, by its draft: a read of that draft waits. */
  const sending = new Map<string, Promise<unknown>>();
  const draftKey = (personId: string, conversationId: string | null) =>
    `${personId}/${conversationId ?? "new"}`;
  /** Runs a send's step that a read of the box's draft waits for. */
  const whileSending = async <T>(
    personId: string,
    conversationId: string | null,
    run: Promise<T>,
  ): Promise<T> => {
    const key = draftKey(personId, conversationId);
    sending.set(key, run);
    try {
      return await run;
    } finally {
      if (sending.get(key) === run) sending.delete(key);
    }
  };

  /**
   * A message from a box is its draft as stored: the box saved it first, at
   * `revision`. Anything else is refused and nothing is sent, so a message
   * Rufi takes is never only in a request: the draft keeps it until the
   * agent took it, also when Rufi stops meanwhile.
   */
  const fromDraft = async (
    personId: string,
    conversationId: string | null,
    text: string,
    revision: number | undefined,
  ): Promise<void> => {
    if (revision === undefined) return;
    const draft = await transcripts.draft(personId, conversationId);
    if (draft.revision !== revision || draft.text.trim() !== text) {
      throw new HttpError(409, "Changed in another tab.", { draft });
    }
  };

  /**
   * Sends a message from a box whose draft keeps it at `held`. Taken: the
   * draft is cleared, when it is still that revision (another tab may have
   * changed it). Not taken: the error carries the draft, which keeps the
   * text.
   */
  const fromBox = <T>(
    personId: string,
    conversationId: string,
    held: number | undefined,
    action: () => Promise<T>,
  ): Promise<{ result: T; draft: Draft }> =>
    whileSending(
      personId,
      conversationId,
      (async () => {
        let result: T;
        try {
          result = await acting(action);
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          throw new HttpError(error.status, error.message, {
            ...error.more,
            draft: await transcripts.draft(personId, conversationId),
          });
        }
        const draft =
          held === undefined
            ? await transcripts.draft(personId, conversationId)
            : (await transcripts.saveDraft(personId, conversationId, "", held))
                .draft;
        return { result, draft };
      })(),
    );

  // The first message of a new conversation starts it, and the chat
  // continues it. The message moves from the new conversation's draft to the
  // conversation's own, which keeps it until the agent takes it.
  app.post(`${base}/new/messages`, async (c) => {
    const { id: personId } = await person(c);
    const { text, draft, model } = await body(
      c,
      StartConversation,
      MESSAGE_REFUSAL,
    );
    await fromDraft(personId, null, text, draft);
    const created = await whileSending(
      personId,
      null,
      acting(() =>
        chat.create(personId, null, model, { text, newDraft: draft }),
      ),
    );
    try {
      const { result, draft: after } = await fromBox(
        personId,
        created.id,
        1,
        () => chat.send(created, text),
      );
      const titled = await transcripts.conversation(personId, created.id);
      return c.json(
        { id: result.id, conversation: shown(titled ?? created), draft: after },
        202,
      );
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      throw new HttpError(error.status, error.message, {
        ...error.more,
        conversation: shown(created),
      });
    }
  });

  const one = `${base}/:conversationId`;
  app.get(one, async (c) =>
    c.json(await transcripts.snapshot(await conversation(c))),
  );
  app.post(`${one}/messages`, async (c) => {
    const found = await conversation(c);
    const { text, draft } = await body(c, SendMessage, MESSAGE_REFUSAL);
    await fromDraft(found.personId, found.id, text, draft);
    const { result, draft: after } = await fromBox(
      found.personId,
      found.id,
      draft,
      () => chat.send(found, text),
    );
    return c.json({ id: result.id, draft: after }, 202);
  });
  app.post(`${one}/steer`, async (c) => {
    const found = await conversation(c);
    const { text, draft } = await body(c, SendMessage, MESSAGE_REFUSAL);
    await fromDraft(found.personId, found.id, text, draft);
    const { result, draft: after } = await fromBox(
      found.personId,
      found.id,
      draft,
      () => chat.steer(found, text),
    );
    return c.json({ id: result.id, draft: after });
  });
  app.post(`${one}/stop`, async (c) => {
    const found = await conversation(c);
    await acting(() => chat.stop(found));
    return c.json({ ok: true });
  });
  app.put(`${one}/model`, async (c) => {
    const found = await conversation(c);
    const { model } = await body(c, SelectModel);
    await acting(() => chat.selectModel(found, model));
    return c.json({ model });
  });

  // The waiting messages are the agent's own list.
  app.get(`${one}/waiting`, async (c) => {
    const found = await conversation(c);
    return c.json({ messages: await acting(() => chat.waiting.list(found)) });
  });
  app.put(`${one}/waiting`, async (c) => {
    const found = await conversation(c);
    const { ids } = await body(c, ReorderWaiting);
    await acting(() => chat.waiting.reorder(found, [...ids]));
    return c.json({ ok: true });
  });
  app.put(`${one}/waiting/:waitingId`, async (c) => {
    const found = await conversation(c);
    const { text } = await body(c, MessageText, MESSAGE_REFUSAL);
    await acting(() =>
      chat.waiting.edit(found, c.req.param("waitingId"), text),
    );
    return c.json({ ok: true });
  });
  app.delete(`${one}/waiting/:waitingId`, async (c) => {
    const found = await conversation(c);
    await acting(() => chat.waiting.remove(found, c.req.param("waitingId")));
    return c.json({ ok: true });
  });
  app.post(`${one}/waiting/:waitingId/run`, async (c) => {
    const found = await conversation(c);
    await acting(() => chat.waiting.runNow(found, c.req.param("waitingId")));
    return c.json({ ok: true });
  });

  // A draft per conversation; "new" is the draft for a new conversation.
  const draftScope = async (c: Context) =>
    c.req.param("conversationId") === "new"
      ? { personId: (await person(c)).id, conversationId: null }
      : await conversation(c).then(({ personId, id }) => ({
          personId,
          conversationId: id,
        }));
  app.get("/api/people/:personId/drafts/:conversationId", async (c) => {
    const { personId, conversationId } = await draftScope(c);
    // A message from this box on its way: the box shows what follows it.
    await sending
      .get(draftKey(personId, conversationId))
      ?.catch(() => undefined);
    return c.json(await transcripts.draft(personId, conversationId));
  });
  app.put("/api/people/:personId/drafts/:conversationId", async (c) => {
    const { personId, conversationId } = await draftScope(c);
    const { text, revision, tab, leaving } = await body(c, SaveDraft);
    const { saved, draft } = await transcripts.saveDraft(
      personId,
      conversationId,
      text,
      revision,
      tab === undefined ? undefined : { tab, leaving: leaving === true },
    );
    if (!saved) {
      throw new HttpError(409, "Changed in another tab.", { draft });
    }
    return c.json(draft);
  });

  // The live stream: a snapshot, then every stored change after it.
  app.get(`${one}/stream`, async (c) => {
    const found = await conversation(c);
    const connection = c.env.outgoing;
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    return stream(c, async (out) => {
      const waiting: StreamLine[] = [];
      let wake: (() => void) | undefined;
      const state = { open: true };
      const push = (line: StreamLine) => {
        if (!state.open) return;
        waiting.push(line);
        if (waiting.length > (deps.behindMax ?? BEHIND_MAX)) {
          // A screen this far behind isn't reading: its connection ends, and
          // it starts again from a new snapshot.
          state.open = false;
          out.abort();
          connection.destroy();
        }
        wake?.();
      };
      // Listen first, then read the snapshot: nothing falls in between.
      const unsubscribe = transcripts.subscribe(found.id, (change: Change) => {
        push({
          type: "update",
          revision: change.revision,
          entries: change.entries,
          turns: change.turns,
          ...(change.conversation && { conversation: change.conversation }),
        });
      });
      const unwatch = chat.waiting.subscribe(found.id, () => {
        push({ type: "waiting" });
      });
      out.onAbort(() => {
        state.open = false;
        wake?.();
      });
      try {
        const snapshot = await transcripts.snapshot(found);
        await out.write(
          `${JSON.stringify({ type: "snapshot", ...snapshot })}\n`,
        );
        while (state.open) {
          const line = waiting.shift();
          if (line) {
            // Changes already in the snapshot are left out.
            if (line.type !== "update" || line.revision > snapshot.revision) {
              await out.write(`${JSON.stringify(line)}\n`);
            }
            continue;
          }
          const pinged = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              resolve(true);
            }, PING_MS);
            wake = () => {
              clearTimeout(timer);
              resolve(false);
            };
          });
          wake = undefined;
          if (pinged) await out.write(`{"type":"ping"}\n`);
        }
      } finally {
        unsubscribe();
        unwatch();
      }
    });
  });

  // The screens: every page path that isn't the API.
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/") || deps.screens === undefined) {
      throw new HttpError(404, "Not found.");
    }
    const found = await screen(deps.screens, c.req.path);
    if (!found) throw new HttpError(404, "Not found.");
    c.header("Content-Type", found.type);
    c.header(
      "Cache-Control",
      found.immutable ? "public, max-age=31536000, immutable" : "no-cache",
    );
    return c.body(new Uint8Array(found.body));
  });

  return app;
}
