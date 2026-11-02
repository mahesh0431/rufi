// Rufi's local API: what the screens use. Only on 127.0.0.1, only with both
// session proofs, and only for the person in the path: each person has one
// chat, and only theirs is found. What every listener shares is in
// `http.ts`; a person's routes are in `person-routes.ts`.
import {
  AddPerson,
  ActivityShown,
  Appearance,
  Colour,
  ReplyShape,
  TextSize,
  FinishStep,
  MAX_REPLY_WORDS,
  SaveSettings,
  StartSignIn,
  WhileReplying,
  type Backups,
  type DataFolder,
  type FirstRun,
  type Settings,
  type Status,
} from "@rufi/contracts";
import { APPEARANCE_HEADER } from "@rufi/contracts/app";
import {
  EditInstruction,
  type Instructions,
} from "@rufi/contracts/instructions";
import { KeepValues, type DeviceData } from "@rufi/contracts/devices";
import { StartPairing } from "@rufi/contracts/remote";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { Option, Schema } from "effect";
import { Hono, type Context, type Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  CONTINUES_SETTING,
  continuesAfterRestart,
} from "../core/chat/continues.ts";
import { emergencyFor, emergencyRegions } from "../core/chat/safety.ts";
import {
  editSetting,
  instructionParts,
  REPLY_SETTINGS,
  toldOf,
} from "../core/chat/instructions.ts";
import { SaveRefused } from "../core/record/save.ts";
import { OriginalMissing } from "../core/documents/originals.ts";
import type { BackupJob } from "../core/store/backup.ts";
import type { MadeExport } from "../core/store/export.ts";
import type { Devices } from "../core/devices/devices.ts";
import { errorCode } from "../platform/logs.ts";
import type { AiFiles } from "./files.ts";
import { body, HttpError, shared, type App } from "./http.ts";
import { personRoutes, type PersonDeps } from "./person-routes.ts";
import type { Remote } from "./remote.ts";
import { screen } from "./screens.ts";
import { sameSecret, type Sessions } from "./session.ts";
import type { SignInFlow } from "./signin.ts";

export interface ApiDeps extends PersonDeps {
  sessions: Sessions;
  /** The port Rufi listens on, once known. */
  port: () => number;
  /** The ChatGPT sign-in, read when asked. */
  account: () => Promise<Status>;
  /** Signing in from the screens. */
  signIn: SignInFlow;
  backups: BackupJob;
  /** Device data: its sources for Settings, and how long values are kept. */
  devices: Pick<Devices, "sources" | "keep" | "preview" | "setKeep"> & {
    /** Cleans up now, in the converter's loop, without waiting for it. */
    cleanSoon: () => void;
    /** Whether a clean-up is asked for or running. */
    cleaning: () => boolean;
    /** Why the converter couldn't even save a failure, while that lasts. */
    trouble: () => string | null;
  };
  /** The data folder in use, and how it was chosen; `show` shows it in Finder. */
  folder: DataFolder & { show: () => Promise<void> };
  /** The export, made when asked: the zip and its file name. */
  /** Stops, and removes what it made, when `signal` aborts. */
  exportZip: (signal: AbortSignal) => Promise<MadeExport>;
  /** The pictures and pages the AI made, that replies show. */
  files: AiFiles;
  /** The remote door: paired apps and pairing (Settings › iPhone). */
  remote: Pick<Remote, "state" | "pair" | "cancel" | "unpair">;
  /** The secret `pnpm start` shows to get a fresh link while Rufi runs. */
  launcher: string;
  /** A fresh single-use link that opens Rufi. */
  launchUrl: () => string;
  /** The built screens' folder; none in tests that only use the API. */
  screens?: string;
}

/** The header the page sends its tab proof in. */
export const PROOF_HEADER = "x-rufi-proof";
/** The header `pnpm start` sends the launcher secret in. */
export const LAUNCHER_HEADER = "x-rufi-launcher";

const FORWARDING = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

export function api(deps: ApiDeps): App {
  const { transcripts } = deps;
  const app: App = new Hono();
  const cookie = () => `rufi_${String(deps.port())}`;
  const origin = () => `http://127.0.0.1:${String(deps.port())}`;

  const { adds } = shared(app, {
    log: deps.log,
    // Only from this Mac, by its own address, and only from Rufi's page.
    guard: async (c, next) => {
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
    },
  });

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

  /** The chosen appearance; system until one is chosen. */
  const appearance = async (): Promise<Appearance> =>
    Schema.decodeUnknownOption(Appearance)(
      await transcripts.setting("appearance"),
    ).pipe(Option.getOrElse(() => "system" as const));
  /** The chosen colour theme; White until one is chosen. */
  const colour = async (): Promise<Colour> =>
    Schema.decodeUnknownOption(Colour)(
      await transcripts.setting("colour"),
    ).pipe(Option.getOrElse(() => "white" as const));
  /** How a reply sits in the chat; flat until another is chosen. */
  const replyShape = async (): Promise<ReplyShape> =>
    Schema.decodeUnknownOption(ReplyShape)(
      await transcripts.setting("reply_shape"),
    ).pipe(Option.getOrElse(() => "flat" as const));
  /** The size of Rufi's text; default until another is chosen. */
  const textSize = async (): Promise<TextSize> =>
    Schema.decodeUnknownOption(TextSize)(
      await transcripts.setting("text_size"),
    ).pipe(Option.getOrElse(() => "default" as const));
  const settings = async (c: Context): Promise<Settings> => {
    const known = emergencyFor(await transcripts.setting("emergency_region"));
    const chosen = await appearance();
    const { replies } = await toldOf(transcripts.setting);
    c.header(APPEARANCE_HEADER, chosen);
    return {
      appearance: chosen,
      colour: await colour(),
      replyShape: await replyShape(),
      textSize: await textSize(),
      replyStyle: replies.style,
      replyWords: replies.words,
      // Open while the AI works, until another is chosen.
      activity: Schema.decodeUnknownOption(ActivityShown)(
        await transcripts.setting("activity"),
      ).pipe(Option.getOrElse(() => "working" as const)),
      // Into the running reply, until another is chosen.
      whileReplying: Schema.decodeUnknownOption(WhileReplying)(
        await transcripts.setting("while_replying"),
      ).pipe(Option.getOrElse(() => "steer" as const)),
      continuesAfterRestart: await continuesAfterRestart(transcripts.setting),
      emergencyRegion: known?.region ?? null,
      emergency: known ? { name: known.name, number: known.number } : null,
      regions: emergencyRegions(),
      deviceKeepValues: await deps.devices.keep(),
    };
  };

  app.get("/api/people", async (c) =>
    c.json({ people: await transcripts.people() }),
  );
  // First run makes the first person; more people come with family.
  app.post("/api/people", async (c) => {
    const { displayName, profile } = await body(c, AddPerson);
    // Nothing is kept when a value can't be: the welcome keeps it all.
    const person = await transcripts
      .addFirstPerson(displayName, profile)
      .catch((error: unknown) => {
        if (error instanceof SaveRefused) {
          throw new HttpError(400, error.message);
        }
        throw error;
      });
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
      (await deps.account()).codex.state !== "signed_in" &&
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
    if (changed.colour !== undefined) {
      await transcripts.saveSetting("colour", changed.colour);
    }
    if (changed.replyStyle !== undefined) {
      await transcripts.saveSetting(REPLY_SETTINGS.style, changed.replyStyle);
    }
    if (changed.replyWords !== undefined) {
      // As they wrote it; the chat's next reply reads it with Rufi's rules.
      await transcripts.saveSetting(REPLY_SETTINGS.words, changed.replyWords);
    }
    if (changed.textSize !== undefined) {
      await transcripts.saveSetting("text_size", changed.textSize);
    }
    if (changed.replyShape !== undefined) {
      await transcripts.saveSetting("reply_shape", changed.replyShape);
    }
    if (changed.activity !== undefined) {
      await transcripts.saveSetting("activity", changed.activity);
    }
    if (changed.whileReplying !== undefined) {
      await transcripts.saveSetting("while_replying", changed.whileReplying);
    }
    if (changed.continuesAfterRestart !== undefined) {
      await transcripts.saveSetting(
        CONTINUES_SETTING,
        String(changed.continuesAfterRestart),
      );
    }
    if (changed.deviceKeepValues !== undefined) {
      // The screen confirmed what a shorter time deletes: it goes now, in
      // the background (years of values take a while), as Settings shows.
      await deps.devices.setKeep(changed.deviceKeepValues);
      deps.devices.cleanSoon();
    }
    return c.json(await settings(c));
  });

  // What Rufi AI is told, in its parts (Settings › Advanced): each the
  // user's edit or Rufi's own. An edit is used from the next reply on.
  const instructions = async (): Promise<Instructions> => ({
    parts: instructionParts(await toldOf(transcripts.setting)),
  });
  app.get("/api/instructions", async (c) => c.json(await instructions()));
  app.put("/api/instructions", async (c) => {
    const { part, text } = await body(c, EditInstruction);
    if (part === "words") {
      if (text !== null && text.length > MAX_REPLY_WORDS) {
        throw new HttpError(
          400,
          `Your own words can be ${String(MAX_REPLY_WORDS)} characters at most.`,
        );
      }
      await transcripts.saveSetting(REPLY_SETTINGS.words, text);
    } else {
      const { replies } = await toldOf(transcripts.setting);
      await transcripts.saveSetting(editSetting(part, replies.style), text);
    }
    return c.json(await instructions());
  });

  app.get("/api/status", async (c) => c.json(await deps.account()));

  app.get("/api/signin", (c) => c.json(deps.signIn.state()));
  app.post("/api/signin", async (c) => {
    const { provider } = await body(c, StartSignIn);
    return c.json(deps.signIn.start(provider));
  });

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

  app.get("/api/devices", async (c) =>
    c.json({
      sources: await deps.devices.sources(),
      trouble: deps.devices.trouble(),
      cleaning: deps.devices.cleaning(),
    } satisfies DeviceData),
  );
  // What keeping values for `keep` would delete, for the confirm.
  app.get("/api/devices/preview", async (c) => {
    const keep = Schema.decodeUnknownOption(KeepValues)(c.req.query("keep"));
    if (Option.isNone(keep))
      throw new HttpError(400, "That request isn't valid.");
    return c.json(await deps.devices.preview(keep.value));
  });
  // Back up: answers when it is done; a failure shows in the status.
  app.post("/api/backups", async (c) => {
    await deps.backups.backUp().catch(() => undefined);
    return c.json(backups());
  });

  // Settings › iPhone: the paired apps, and pairing one for a person's record.
  app.get("/api/paired-apps", async (c) => c.json(await deps.remote.state()));
  app.post("/api/paired-apps/pairing", async (c) => {
    const { personId } = await body(c, StartPairing);
    await deps.remote.pair(personId);
    return c.json(await deps.remote.state());
  });
  app.post("/api/paired-apps/pairing/cancel", async (c) => {
    await deps.remote.cancel();
    return c.json(await deps.remote.state());
  });
  app.post("/api/paired-apps/:appId/unpair", async (c) => {
    if (!(await deps.remote.unpair(c.req.param("appId")))) {
      throw new HttpError(404, "That app isn't paired any more.");
    }
    return c.json(await deps.remote.state());
  });

  const folder = (): DataFolder => ({
    path: deps.folder.path,
    source: deps.folder.source,
  });
  app.get("/api/data-folder", (c) => c.json(folder()));
  app.post("/api/data-folder/show", async (c) => {
    try {
      await deps.folder.show();
    } catch (error) {
      deps.log("folder.show_failed", { error: errorCode(error) });
      throw new HttpError(500, "Rufi couldn't open Finder. Try again.");
    }
    return c.json(folder());
  });

  app.get("/api/export", async (c) => {
    // The person may go while it is made (years of data take a minute): it
    // stops then, and what was made goes.
    const signal = c.req.raw.signal;
    let made: MadeExport;
    try {
      made = await deps.exportZip(signal);
    } catch (error) {
      if (signal.aborted) return new Response(null);
      deps.log("export.failed", { error: errorCode(error) });
      throw new HttpError(
        500,
        error instanceof OriginalMissing
          ? "Rufi couldn't make the export: a document file is missing or changed. See Help: Backups and export."
          : "Rufi couldn't make the export. Try again; if it fails again, make a backup and see Help.",
      );
    }
    const remove = () => {
      made.remove().catch((error: unknown) => {
        deps.log("export.failed", { error: errorCode(error) });
      });
    };
    // Sent from its file. Until the file is handed to the answer, any way
    // out removes it; after that, its stream closing does (the answer ended,
    // or the person went).
    let handedOver = false;
    try {
      if (signal.aborted) return new Response(null);
      c.header("Content-Type", "application/zip");
      c.header("Content-Disposition", `attachment; filename="${made.name}"`);
      c.header("Content-Length", String(made.size));
      const file = createReadStream(made.path);
      const cut = () => file.destroy();
      signal.addEventListener("abort", cut, { once: true });
      file.once("close", () => {
        signal.removeEventListener("abort", cut);
        remove();
      });
      handedOver = true;
      return c.body(Readable.toWeb(file) as ReadableStream<Uint8Array>);
    } finally {
      if (!handedOver) remove();
    }
  });

  // A file a reply shows: a short-lived address for that one file.
  app.get("/api/files", async (c) => {
    const granted = await deps.files.grant(c.req.query("path") ?? "");
    if ("refused" in granted) {
      throw new HttpError(403, "Rufi shows only files in the AI's folder.");
    }
    if ("missing" in granted) {
      throw new HttpError(404, "This file is no longer in the AI's folder.", {
        missing: true,
        path: granted.path,
      });
    }
    return c.json({
      url: `/files/${granted.token}/${encodeURIComponent(granted.file.name)}`,
      name: granted.file.name,
      path: granted.file.path,
    });
  });

  personRoutes(app, deps, adds);

  // A file a reply shows, by its address from /api/files; checked again now.
  // Never cached as unchanging: a reply shows the file as it is now.
  app.get("/files/:token/:name", async (c) => {
    const found = await deps.files.open(c.req.param("token"));
    if (found === undefined || "refused" in found) {
      throw new HttpError(404, "Not found.");
    }
    c.header("Cache-Control", "no-store");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    // Gone between the check and this load: the picture isn't there.
    if ("missing" in found) throw new HttpError(404, "Not found.");
    const { path, type } = found.found;
    const bytes = await readFile(path).catch((error: unknown) => {
      deps.log("api.failed", { error: errorCode(error) });
      throw new HttpError(404, "Not found.");
    });
    c.header("Content-Type", type);
    return c.body(new Uint8Array(bytes));
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
      // The page carries the chosen appearance, colour, text size and reply
      // shape, so
      // public/theme.js and the tokens paint them first time, and the app's
      // window takes the appearance from the header.
      const chosen = await appearance();
      c.header(APPEARANCE_HEADER, chosen);
      return c.body(
        found.body
          .toString("utf8")
          .replace(
            "<html",
            `<html data-appearance="${chosen}" data-colour="${await colour()}" data-reply-shape="${await replyShape()}" data-text-size="${await textSize()}"`,
          ),
      );
    }
    return c.body(new Uint8Array(found.body));
  });

  return app;
}
