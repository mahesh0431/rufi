// Rufi's local API: what the screens use. Only on 127.0.0.1, only with both
// session proofs, and only for the person in the path: each person has one
// chat, and only theirs is found.
import {
  AddPerson,
  Appearance,
  FinishStep,
  MessageText,
  MAX_MESSAGE_CHARS,
  ReorderWaiting,
  SaveDraft,
  SaveSettings,
  SelectEffort,
  SelectModel,
  SendMessage,
  type Backups,
  type FirstRun,
  type Overview,
  type Settings,
  type Status,
  type StreamLine,
} from "@rufi/contracts";
import { APPEARANCE_HEADER } from "@rufi/contracts/app";
import { readFile } from "node:fs/promises";
import { Option, Result, Schema } from "effect";
import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { except } from "hono/combine";
import { getCookie, setCookie } from "hono/cookie";
import { stream } from "hono/streaming";
import { Stopped } from "../agent/runtime.ts";
import type { Drafts } from "../core/chat/drafts.ts";
import { emergencyFor, emergencyRegions } from "../core/chat/safety.ts";
import { NotADocument, type Documents } from "../core/documents/documents.ts";
import { OriginalMissing } from "../core/documents/originals.ts";
import type { BackupJob } from "../core/store/backup.ts";
import type { Change, ChatRow, Transcripts } from "../core/chat/transcript.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import { ChatRefusal, type Chat } from "./chat.ts";
import { screen } from "./screens.ts";
import { sameSecret, type Sessions } from "./session.ts";
import type { SignInFlow } from "./signin.ts";

export interface ApiDeps {
  transcripts: Transcripts;
  drafts: Drafts;
  chat: Chat;
  sessions: Sessions;
  /** The port Rufi listens on, once known. */
  port: () => number;
  /** A person's overview (what get_overview starts with). */
  overview: (personId: string) => Promise<Overview>;
  /** The ChatGPT sign-in, read when asked. */
  account: () => Promise<Status>;
  /** Signing in from the screens. */
  signIn: SignInFlow;
  backups: BackupJob;
  /** The export, made when asked: the zip and its file name. */
  exportZip: () => Promise<{ name: string; bytes: Uint8Array }>;
  /** Each person's documents. */
  documents: Documents;
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

/** The most one add of documents may hold: many photos, or a long PDF. */
const MAX_ADD_BYTES = 256 * 1024 * 1024;
/** The address documents are added at; it takes files, so a larger body. */
const ADD_PATH = /^\/api\/people\/[^/]+\/documents$/;

/** Why a file wasn't added, in one sentence. */
function notAdded({ file, reason }: NotADocument): string {
  const nothing = "Nothing was added.";
  switch (reason) {
    case "not_accepted":
      return `${file} isn't a PDF, JPEG, PNG or HEIC photo. ${nothing} Remove it and add the others again.`;
    case "broken":
      return `${file} is damaged and can't be opened. ${nothing} Remove it and add the others again.`;
    case "locked":
      return `${file} is protected with a password, so Rufi can't open it. ${nothing} Save a copy without the password and add that.`;
    case "slow":
      return `${file} took too long to open. ${nothing} Try again.`;
  }
}

const MESSAGE_REFUSAL = `A message needs some text, and can be at most ${MAX_MESSAGE_CHARS.toLocaleString("en")} characters.`;
/** A stream says it's alive this often when nothing happens. */
const PING_MS = 15_000;
/** Updates a screen may fall behind by before its stream is closed; it reconnects. */
const BEHIND_MAX = 1_000;

const CSP =
  "default-src 'self'; img-src 'self' data: blob:; frame-src blob:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const FORWARDING = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502;
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
  const { transcripts, drafts, chat } = deps;
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
  const limit = (maxSize: number, refusal: string) =>
    bodyLimit({
      maxSize,
      onError: () => {
        throw new HttpError(413, refusal);
      },
    });
  const requests = limit(1024 * 1024, "That request is too large.");
  const adds = limit(
    MAX_ADD_BYTES,
    "Those files are too large to add at once (256 MB at most). Add fewer at a time.",
  );
  // An add of documents has its own, larger limit (below).
  app.use(
    "/api/*",
    except(
      (c) => c.req.method === "POST" && ADD_PATH.test(c.req.path),
      requests,
    ),
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
  /** The person's chat. */
  const chatOf = async (c: Context) => {
    const found = await transcripts.chat((await person(c)).id);
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
  /** The agent's error, as the answer shows it. */
  const answerOf = (error: unknown): HttpError => {
    if (error instanceof HttpError) return error;
    if (error instanceof ChatRefusal) return new HttpError(409, error.message);
    if (error instanceof Stopped) return new HttpError(409, "Stopped.");
    deps.log("api.failed", { error: errorCode(error) });
    return new HttpError(
      502,
      error instanceof Error ? error.message : "The AI couldn't do that.",
    );
  };
  /** A chat action: the agent's errors are shown as they are. */
  const acting = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      throw answerOf(error);
    }
  };
  /** The chosen appearance; system until one is chosen. */
  const appearance = async (): Promise<Appearance> =>
    Schema.decodeUnknownOption(Appearance)(
      await transcripts.setting("appearance"),
    ).pipe(Option.getOrElse(() => "system" as const));
  const settings = async (c: Context): Promise<Settings> => {
    const known = emergencyFor(await transcripts.setting("emergency_region"));
    const chosen = await appearance();
    c.header(APPEARANCE_HEADER, chosen);
    return {
      appearance: chosen,
      emergencyRegion: known?.region ?? null,
      emergency: known ? { name: known.name, number: known.number } : null,
      regions: emergencyRegions(),
    };
  };

  app.get("/api/people", async (c) =>
    c.json({ people: await transcripts.people() }),
  );
  // First run makes the first person; more people come with family.
  app.post("/api/people", async (c) => {
    const { displayName } = await body(c, AddPerson);
    const person = await transcripts.addFirstPerson(displayName);
    if (!person) {
      throw new HttpError(409, "Someone is already in this record.");
    }
    return c.json({ person }, 201);
  });

  // First run: what is done is kept here, so a reload or another tab
  // continues at the first step not done.
  const FIRST_RUN = {
    welcome: "first_run.understood",
    sign_in: "first_run.sign_in_skipped",
    region: "first_run.done",
  } as const;
  const firstRun = async (): Promise<FirstRun> => {
    // Once done, it stays done: signing in later is the sidebar's job.
    if (await transcripts.setting(FIRST_RUN.region)) return { step: "done" };
    if (!(await transcripts.setting(FIRST_RUN.welcome))) {
      return { step: "welcome" };
    }
    if ((await transcripts.people()).length === 0) return { step: "name" };
    if (
      (await deps.account()).account === "signed_out" &&
      !(await transcripts.setting(FIRST_RUN.sign_in))
    ) {
      return { step: "sign_in" };
    }
    return { step: "region" };
  };
  app.get("/api/first-run", async (c) => c.json(await firstRun()));
  app.post("/api/first-run", async (c) => {
    const { step } = await body(c, FinishStep);
    // The first time a step was done stands.
    if (!(await transcripts.setting(FIRST_RUN[step]))) {
      await transcripts.saveSetting(FIRST_RUN[step], new Date().toISOString());
    }
    return c.json(await firstRun());
  });

  app.get("/api/settings", async (c) => c.json(await settings(c)));
  app.put("/api/settings", async (c) => {
    const changed = await body(c, SaveSettings);
    const region = changed.emergencyRegion;
    if (region !== undefined && region !== null && !emergencyFor(region)) {
      throw new HttpError(400, "Rufi doesn't know that region yet.");
    }
    if (region !== undefined) {
      await transcripts.saveSetting("emergency_region", region);
    }
    if (changed.appearance !== undefined) {
      await transcripts.saveSetting("appearance", changed.appearance);
    }
    return c.json(await settings(c));
  });

  app.get("/api/status", async (c) => c.json(await deps.account()));

  app.get("/api/signin", (c) => c.json(deps.signIn.state()));
  app.post("/api/signin", (c) => c.json(deps.signIn.start()));

  const backups = (): Backups => {
    const { last, failed, running } = deps.backups.status();
    return {
      last: last
        ? { name: last.name, createdAt: last.createdAt.toISOString() }
        : null,
      failed: failed
        ? { at: failed.at.toISOString(), reason: failed.reason }
        : null,
      running,
    };
  };
  app.get("/api/backups", (c) => c.json(backups()));
  // Back up now: answers when it is done; a failure shows in the status.
  app.post("/api/backups", async (c) => {
    await deps.backups.backUp().catch(() => undefined);
    return c.json(backups());
  });

  app.get("/api/export", async (c) => {
    let made: { name: string; bytes: Uint8Array };
    try {
      made = await deps.exportZip();
    } catch (error) {
      deps.log("export.failed", { error: errorCode(error) });
      throw new HttpError(
        500,
        error instanceof OriginalMissing
          ? "Rufi couldn't make the export: a document file is missing or changed. See Help: Backups and export."
          : "Rufi couldn't make the export. Try again; if it fails again, make a backup and see Help.",
      );
    }
    c.header("Content-Type", "application/zip");
    c.header("Content-Disposition", `attachment; filename="${made.name}"`);
    return c.body(new Uint8Array(made.bytes));
  });

  app.get("/api/models", async (c) => {
    const { models, error } = await acting(() => chat.models());
    return c.json({ models, allowlistError: error ?? null });
  });

  app.get("/api/people/:personId/overview", async (c) =>
    c.json({ overview: await deps.overview((await person(c)).id) }),
  );

  // A person's documents: the list, adding files, and a file's bytes to show.
  const documentsPath = "/api/people/:personId/documents";
  app.get(documentsPath, async (c) =>
    c.json({ documents: await deps.documents.list((await person(c)).id) }),
  );
  app.post(documentsPath, adds, async (c) => {
    const found = await person(c);
    const form = await c.req.formData().catch(() => undefined);
    const files = (form?.getAll("file") ?? []).filter(
      (file) => file instanceof File,
    );
    if (files.length === 0) {
      throw new HttpError(400, "Choose at least one file to add.");
    }
    const started = Date.now();
    try {
      const added = await deps.documents.add(
        found.id,
        await Promise.all(
          files.map(async (file) => ({
            name: file.name || "Unnamed file",
            bytes: new Uint8Array(await file.arrayBuffer()),
          })),
        ),
        form?.get("together") === "yes",
      );
      deps.log("documents.added", {
        count: added.added.length,
        ms: Date.now() - started,
      });
      return c.json(added, 201);
    } catch (error) {
      if (error instanceof NotADocument) {
        throw new HttpError(400, notAdded(error));
      }
      throw error;
    }
  });
  /** A file of a document as it came, or a HEIC's JPEG copy (`display`). */
  const fileOf = async (c: Context, display: boolean) => {
    const found = await deps.documents.file(
      (await person(c)).id,
      c.req.param("documentId") ?? "",
      c.req.param("fileId") ?? "",
      display,
    );
    if (!found) throw new HttpError(404, "Not found.");
    const bytes = await readFile(found.path).catch((error: unknown) => {
      deps.log("api.failed", { error: errorCode(error) });
      throw new HttpError(
        500,
        "This document's file is missing from your data folder. See Help: Backups and export.",
      );
    });
    c.header("Content-Type", found.mediaType);
    return c.body(new Uint8Array(bytes));
  };
  const filePath = `${documentsPath}/:documentId/files/:fileId`;
  app.get(filePath, (c) => fileOf(c, false));
  app.get(`${filePath}/display`, (c) => fileOf(c, true));

  const HELD = "This message is being sent.";
  /**
   * Sends the box's text: the chat's draft holds it until the agent took it
   * or refused it (core/chat/drafts.ts). The answer has the draft after.
   */
  const fromBox = async (
    c: Context,
    deliver: (found: ChatRow, text: string, id: string) => Promise<unknown>,
  ) => {
    const found = await chatOf(c);
    const { text } = await body(c, SendMessage, MESSAGE_REFUSAL);
    const sent = await drafts.send(found, text, (id) =>
      deliver(found, text, id),
    );
    if (sent.outcome === "taken") return { id: sent.id, draft: sent.draft };
    const { status, message, more } =
      sent.outcome === "held" ? new HttpError(409, HELD) : answerOf(sent.error);
    throw new HttpError(status, message, { ...more, draft: sent.draft });
  };

  const one = "/api/people/:personId/chat";
  // A page of the transcript: the latest, or the one before `before`.
  app.get(one, async (c) => {
    const found = await chatOf(c);
    const before = c.req.query("before");
    if (before !== undefined && !/^[1-9]\d{0,15}$/.test(before)) {
      throw new HttpError(400, "That request isn't valid.");
    }
    return c.json(
      await transcripts.page(
        found,
        before === undefined ? undefined : Number(before),
      ),
    );
  });
  app.post(`${one}/messages`, async (c) =>
    c.json(await fromBox(c, chat.send), 202),
  );
  app.post(`${one}/steer`, async (c) => c.json(await fromBox(c, chat.steer)));
  app.post(`${one}/stop`, async (c) => {
    const found = await chatOf(c);
    await acting(() => chat.stop(found));
    return c.json({ ok: true });
  });
  app.put(`${one}/model`, async (c) => {
    const found = await chatOf(c);
    const { model } = await body(c, SelectModel);
    await acting(() => chat.selectModel(found, model));
    return c.json({ model });
  });
  app.put(`${one}/effort`, async (c) => {
    const found = await chatOf(c);
    const { effort } = await body(c, SelectEffort);
    await acting(() => chat.selectEffort(found, effort));
    return c.json({ effort });
  });

  // The waiting messages are the agent's own list.
  app.get(`${one}/waiting`, async (c) => {
    const found = await chatOf(c);
    return c.json({ messages: await acting(() => chat.waiting.list(found)) });
  });
  app.put(`${one}/waiting`, async (c) => {
    const found = await chatOf(c);
    const { ids } = await body(c, ReorderWaiting);
    await acting(() => chat.waiting.reorder(found, [...ids]));
    return c.json({ ok: true });
  });
  app.put(`${one}/waiting/:waitingId`, async (c) => {
    const found = await chatOf(c);
    const { text } = await body(c, MessageText, MESSAGE_REFUSAL);
    await acting(() =>
      chat.waiting.edit(found, c.req.param("waitingId"), text),
    );
    return c.json({ ok: true });
  });
  app.delete(`${one}/waiting/:waitingId`, async (c) => {
    const found = await chatOf(c);
    await acting(() => chat.waiting.remove(found, c.req.param("waitingId")));
    return c.json({ ok: true });
  });
  app.post(`${one}/waiting/:waitingId/run`, async (c) => {
    const found = await chatOf(c);
    await acting(() => chat.waiting.runNow(found, c.req.param("waitingId")));
    return c.json({ ok: true });
  });

  // The chat's draft.
  const draftPath = `${one}/draft`;
  app.get(draftPath, async (c) => c.json(await drafts.read(await chatOf(c))));
  app.put(draftPath, async (c) => {
    const found = await chatOf(c);
    const { text } = await body(c, SaveDraft);
    const draft = await drafts.save(found, text);
    if (draft.state === "sending") throw new HttpError(409, HELD, { draft });
    return c.json(draft);
  });

  // The live stream: a snapshot, then every stored change after it.
  app.get(`${one}/stream`, async (c) => {
    const found = await chatOf(c);
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
          ...(change.chat && { chat: change.chat }),
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
        const snapshot = await transcripts.page(found);
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
    if (found.type.startsWith("text/html")) {
      // The page carries the chosen appearance, so public/theme.js paints it
      // first time, and the app's window takes it from the header.
      const chosen = await appearance();
      c.header(APPEARANCE_HEADER, chosen);
      return c.body(
        found.body
          .toString("utf8")
          .replace("<html", `<html data-appearance="${chosen}"`),
      );
    }
    return c.body(new Uint8Array(found.body));
  });

  return app;
}
