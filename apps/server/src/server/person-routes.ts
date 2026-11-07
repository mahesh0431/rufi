// The routes of one person: their record, documents and chat, all under
// /api/people/:personId. Every one is held to the person in its path, and
// each object it reads or changes is checked to be that person's. A
// listener mounts them behind its own checks of who may ask (`api.ts`
// today).
import {
  MessageText,
  MAX_MESSAGE_CHARS,
  RecoverMessage,
  ReorderQueue,
  SaveDraft,
  SelectEffort,
  SelectModel,
  SendMessage,
  type StreamLine,
} from "@rufi/contracts";
import type { Brief } from "@rufi/contracts/briefs";
import { DeleteDocument, FixItem } from "@rufi/contracts/documents";
import {
  LogDose,
  SaveProfile,
  SaveReminders,
  type ReminderPlan,
  type Reminders,
  type Overview,
  type Profile,
} from "@rufi/contracts/record";
import { readFile } from "node:fs/promises";
import type { Context, MiddlewareHandler } from "hono";
import { stream } from "hono/streaming";
import { Stopped } from "../agent/runtime.ts";
import type { Drafts } from "../core/chat/drafts.ts";
import { RefRefusal } from "../core/chat/refs.ts";
import type { Change, Transcripts } from "../core/chat/transcript.ts";
import {
  NoChoice,
  StalePreview,
  type Deletions,
} from "../core/documents/delete.ts";
import { NotADocument, type Documents } from "../core/documents/documents.ts";
import { IdTaken, NoSuchMedicine, type DoseLog } from "../core/doses/log.ts";
import { StaleFix, type DraftItems } from "../core/documents/items.ts";
import type { Pages } from "../core/documents/pages.ts";
import type { Readings } from "../core/documents/reading.ts";
import { SaveRefused, type FormOrigin } from "../core/record/save.ts";
import {
  BadCursor,
  isPageKind,
  type RecordViews,
} from "../core/record/views.ts";
import { Refusal } from "../core/tools/registry.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import type { AgentLogs } from "./agent-logs.ts";
import { ChatRefusal, type Chat } from "./chat.ts";
import { body, HttpError, type App } from "./http.ts";

/** What a person's routes use. */
export interface PersonDeps {
  transcripts: Transcripts;
  drafts: Drafts;
  chat: Chat;
  /** A person's Overview: Needs you, the tiles and the latest saves. */
  overview: (personId: string) => Promise<Overview>;
  /** The record's pages, tests and rows, read only. */
  record: Pick<
    RecordViews,
    "page" | "labResults" | "test" | "detail" | "followUps" | "today"
  >;
  /** A person's profile with its history; what they enter in its form. */
  profile: {
    read: (personId: string) => Promise<Profile | undefined>;
    save: (
      personId: string,
      form: FormOrigin,
      sending: string,
      changes: SaveProfile["changes"],
    ) => Promise<void>;
  };
  /** A visit brief of the person's, with its Sources; undefined: none. */
  brief: (personId: string, briefId: string) => Promise<Brief | undefined>;
  /** Each person's documents. */
  documents: Documents;
  /** Deleting one: its preview, and the delete. */
  deletions: Deletions;
  /** Their readings: what waits and runs, and each one's work. */
  readings: Readings;
  /** What the chat's sub-agents did. */
  agents: Pick<AgentLogs, "list" | "log" | "step" | "stop" | "subscribe">;
  /** A document's draft items, and the person's fixes. */
  items: DraftItems;
  /** A document's pages as the reader saw them. */
  pages: Pages;
  /** What the person said happened to their doses; `changed` tells their screens. */
  doses: Pick<DoseLog, "add" | "list" | "subscribe" | "changed">;
  /** The person's reminder setting, as it applies, and their choices. */
  reminders: {
    read: (personId: string) => Promise<Reminders>;
    save: (personId: string, choice: SaveReminders) => Promise<void>;
    /** Their reminder plan for `days` calendar days from `from`. */
    plan: (
      personId: string,
      from: string,
      days: number,
    ) => Promise<ReminderPlan>;
  };
  log: Log;
  /** Updates a screen may fall behind by before its stream is closed. */
  behindMax?: number;
}

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
/** A send needs words, a file or another chip. */
const SEND_REFUSAL = `A message needs some text or something added to it, and can be at most ${MAX_MESSAGE_CHARS.toLocaleString("en")} characters.`;
/** A stream says it's alive this often when nothing happens. */
const PING_MS = 15_000;
/** Updates a screen may fall behind by before its stream is closed; it reconnects. */
const BEHIND_MAX = 1_000;
/** The most days one read of the dose log covers. */
const DOSE_DAYS_MAX = 62;
/** The most days one reminder plan covers: a paired app asks for a week and a day. */
const PLAN_DAYS_MAX = 14;
const DAY_MS = 86_400_000;

/** A real calendar day 'YYYY-MM-DD' as its UTC midnight; undefined if not one. */
function dayOf(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const at = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== text
    ? undefined
    : at;
}

/**
 * Registers a person's routes on `app`, behind whatever checks `app`
 * already has; `adds` is the body limit of an add of documents.
 */
export function personRoutes(
  app: App,
  deps: PersonDeps,
  adds: MiddlewareHandler,
  /**
   * Who is asking, as a dose log keeps it: 'mac' on the screens' listener,
   * 'app:<paired app id>' on the remote door.
   */
  asking: (c: Context) => string,
): void {
  const { transcripts, drafts, chat } = deps;
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

  app.get("/api/people/:personId/overview", async (c) =>
    c.json({ overview: await deps.overview((await person(c)).id) }),
  );

  // The record, read only: a kind's page, Lab results by test, a test's
  // page, a row. Changes start in the chat.
  app.get("/api/people/:personId/lab-results", async (c) =>
    c.json(await deps.record.labResults((await person(c)).id)),
  );
  app.get("/api/people/:personId/tests/:testId", async (c) => {
    const found = await deps.record.test(
      (await person(c)).id,
      c.req.param("testId"),
    );
    if (!found) throw new HttpError(404, "Not found.");
    return c.json(found);
  });
  app.get("/api/people/:personId/record/:kind", async (c) => {
    const { id } = await person(c);
    const kind = c.req.param("kind");
    if (!isPageKind(kind)) throw new HttpError(404, "Not found.");
    try {
      return c.json(await deps.record.page(id, kind, c.req.query("after")));
    } catch (error) {
      if (error instanceof BadCursor) throw new HttpError(400, error.message);
      throw error;
    }
  });
  app.get("/api/people/:personId/record/:kind/:id", async (c) => {
    const found = await deps.record.detail(
      (await person(c)).id,
      c.req.param("kind"),
      c.req.param("id"),
    );
    if (!found) throw new HttpError(404, "Not found.");
    return c.json(found);
  });
  // The profile, and what the person enters on its page or in Settings:
  // one save each, with the form as its source.
  app.get("/api/people/:personId/profile", async (c) => {
    const found = await deps.profile.read((await person(c)).id);
    if (!found) throw new HttpError(404, "Not found.");
    return c.json(found);
  });
  app.put("/api/people/:personId/profile", async (c) => {
    const { id } = await person(c);
    const { sending, in: form, changes } = await body(c, SaveProfile);
    try {
      await deps.profile.save(id, form, sending, changes);
    } catch (error) {
      if (error instanceof SaveRefused) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
    const saved = await deps.profile.read(id);
    if (!saved) throw new HttpError(404, "Not found.");
    return c.json(saved);
  });
  // The person's medicine doses today, for the Medicines page.
  app.get("/api/people/:personId/today", async (c) =>
    c.json(await deps.record.today((await person(c)).id)),
  );
  // The person's dose log (docs/adr/0033): a log as it came, stored once
  // for its id, with who made it, and the logs of the doses on some days.
  const dosesPath = "/api/people/:personId/doses";
  app.post(dosesPath, async (c) => {
    const { id } = await person(c);
    const log = await body(c, LogDose);
    if (log.takenAt !== undefined && log.state !== "taken") {
      throw new HttpError(400, "Only a dose taken has when it was taken.");
    }
    try {
      const answer = await deps.doses.add(id, log, asking(c));
      return c.json({ id: log.id }, answer === "added" ? 201 : 200);
    } catch (error) {
      if (error instanceof NoSuchMedicine) {
        throw new HttpError(404, error.message);
      }
      if (error instanceof IdTaken) throw new HttpError(409, error.message);
      throw error;
    }
  });
  app.get(dosesPath, async (c) => {
    const { id } = await person(c);
    const from = c.req.query("from");
    const to = c.req.query("to");
    const first = dayOf(from);
    const last = dayOf(to);
    if (
      first === undefined ||
      last === undefined ||
      last < first ||
      (last - first) / DAY_MS + 1 > DOSE_DAYS_MAX
    ) {
      throw new HttpError(
        400,
        `Give from and to as days, at most ${String(DOSE_DAYS_MAX)} days apart.`,
      );
    }
    return c.json({
      doses: await deps.doses.list(
        id,
        from as string,
        to as string,
        c.req.query("medicine"),
      ),
    });
  });
  // The person's reminder setting: what a medicine reminder shows and where
  // it rings. A setting, not the record; a change tells their open screens,
  // so a phone schedules again.
  const remindersPath = "/api/people/:personId/reminders";
  app.get(remindersPath, async (c) =>
    c.json(await deps.reminders.read((await person(c)).id)),
  );
  app.put(remindersPath, async (c) => {
    const { id } = await person(c);
    await deps.reminders.save(id, await body(c, SaveReminders));
    deps.doses.changed(id);
    return c.json(await deps.reminders.read(id));
  });
  // The doses a paired app rings, for calendar days in the app's own
  // calendar (docs/how-rufi-works.md).
  app.get(`${remindersPath}/plan`, async (c) => {
    const { id } = await person(c);
    const from = c.req.query("from");
    const days = Number(c.req.query("days"));
    if (
      dayOf(from) === undefined ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > PLAN_DAYS_MAX
    ) {
      throw new HttpError(
        400,
        `Give from as a day and days from 1 to ${String(PLAN_DAYS_MAX)}.`,
      );
    }
    return c.json(await deps.reminders.plan(id, from as string, days));
  });
  // The person's follow-ups, in the Follow-ups page's groups.
  app.get("/api/people/:personId/follow-ups", async (c) =>
    c.json(await deps.record.followUps((await person(c)).id)),
  );

  app.get("/api/people/:personId/briefs/:briefId", async (c) => {
    const brief = await deps.brief(
      (await person(c)).id,
      c.req.param("briefId"),
    );
    if (!brief) throw new HttpError(404, "There is no such brief.");
    return c.json({ brief });
  });

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
        form?.get("from") === "chat" ? "chat" : "documents_page",
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
  // A chip of an unsent file taken out of the box: the file leaves Rufi.
  // One sent meanwhile stays, refused.
  app.delete(`${documentsPath}/:documentId/unsent`, async (c) => {
    const found = await person(c);
    try {
      await deps.deletions.removeUnsent(found.id, c.req.param("documentId"));
    } catch (error) {
      if (error instanceof Refusal) throw new HttpError(409, error.message);
      throw error;
    }
    return c.json({ removed: true });
  });
  // Delete: what it would do, then the delete made on that preview. A
  // preview that changed meanwhile refuses it with the preview as it is now.
  app.get(`${documentsPath}/:documentId/delete`, async (c) => {
    const preview = await deps.deletions.preview(
      (await person(c)).id,
      c.req.param("documentId"),
    );
    if (!preview) throw new HttpError(404, "There is no such document.");
    return c.json(preview);
  });
  app.post(`${documentsPath}/:documentId/delete`, async (c) => {
    const found = await person(c);
    const { version, saved } = await body(c, DeleteDocument);
    const started = Date.now();
    try {
      await deps.deletions.remove(
        found.id,
        c.req.param("documentId"),
        version,
        saved,
      );
    } catch (error) {
      if (error instanceof NoChoice) throw new HttpError(400, error.message);
      if (error instanceof StalePreview) {
        throw new HttpError(409, error.message, { preview: error.preview });
      }
      if (error instanceof Refusal) throw new HttpError(404, error.message);
      throw error;
    }
    deps.log("documents.deleted", { ms: Date.now() - started });
    return c.json({ deleted: true });
  });
  // One reading's work, for View reading.
  app.get(`${documentsPath}/:documentId/reading`, async (c) => {
    const found = await deps.readings.view(
      (await person(c)).id,
      c.req.param("documentId"),
    );
    if (!found) throw new HttpError(404, "Not found.");
    return c.json(found);
  });
  // The document page: its items, a fix, and a page as the reader saw it.
  app.get(`${documentsPath}/:documentId/items`, async (c) => {
    const personId = (await person(c)).id;
    const documentId = c.req.param("documentId");
    const found = await deps.items.view(personId, documentId);
    if (found) return c.json(found);
    // The page says so: a deleted document's address isn't a mistake.
    if (await deps.deletions.deleted(personId, documentId)) {
      throw new HttpError(404, "This document was deleted.", { deleted: true });
    }
    throw new HttpError(404, "Not found.");
  });
  app.post(`${documentsPath}/:documentId/items/:itemId/fix`, async (c) => {
    const found = await person(c);
    const fix = await body(c, FixItem);
    try {
      const fixed = await deps.items.fix(
        found.id,
        c.req.param("documentId"),
        c.req.param("itemId"),
        fix,
      );
      if (!fixed) throw new HttpError(404, "Not found.");
      return c.json(fixed);
    } catch (error) {
      if (error instanceof StaleFix) {
        throw new HttpError(409, error.message, { current: error.current });
      }
      if (error instanceof Refusal) throw new HttpError(409, error.message);
      throw error;
    }
  });
  // A page as the AI saw it, from the document of its add that holds it
  // now: an old step names the document before a sort moved the page.
  // `size=full` as the AI asked for it at full size.
  app.get(`${documentsPath}/:documentId/pages/:position`, async (c) => {
    const position = c.req.param("position");
    if (!/^[1-9]\d{0,5}$/.test(position))
      throw new HttpError(404, "Not found.");
    const personId = (await person(c)).id;
    const holder = await deps.pages.holder(
      personId,
      c.req.param("documentId"),
      Number(position),
    );
    if (holder && "deleted" in holder) {
      throw new HttpError(404, "This document was deleted.", { deleted: true });
    }
    const page =
      holder &&
      (await deps.pages.page(
        personId,
        holder.document,
        Number(position),
        c.req.query("size") === "full",
      ));
    if (!page) throw new HttpError(404, "Not found.");
    if (!page.ok) {
      throw new HttpError(409, "This page couldn't be prepared to be shown.");
    }
    c.header("Content-Type", page.image.mediaType);
    return c.body(new Uint8Array(page.image.bytes));
  });
  const filePath = `${documentsPath}/:documentId/files/:fileId`;
  app.get(filePath, (c) => fileOf(c, false));
  app.get(`${filePath}/display`, (c) => fileOf(c, true));

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
  // The chat's sub-agents, each as its line shows it.
  app.get(`${one}/agents`, async (c) => {
    const found = await chatOf(c);
    return c.json({ agents: await deps.agents.list(found.id) });
  });
  // A sub-agent's last lines (`last`, at most 10,000), when its line opens.
  app.get(`${one}/agents/log`, async (c) => {
    const found = await chatOf(c);
    const last = c.req.query("last") ?? "50";
    if (!/^[1-9]\d{0,3}$/.test(last)) {
      throw new HttpError(400, "That request isn't valid.");
    }
    const log = await deps.agents.log(
      found.id,
      c.req.query("agent") ?? "",
      Number(last),
    );
    if (!log) throw new HttpError(404, "Not found.");
    return c.json(log);
  });
  // Stops a sub-agent, and the agents it started, from its pop-up.
  app.post(`${one}/agents/stop`, async (c) => {
    const found = await chatOf(c);
    if (!(await deps.agents.stop(found.id, c.req.query("agent") ?? ""))) {
      throw new HttpError(404, "Not found.");
    }
    return c.json({ ok: true });
  });
  // Everything a sub-agent gave about one of its steps, when it opens.
  app.get(`${one}/agents/step`, async (c) => {
    const found = await chatOf(c);
    const step = await deps.agents.step(
      found.id,
      c.req.query("agent") ?? "",
      c.req.query("step") ?? "",
    );
    if (!step) throw new HttpError(404, "Not found.");
    return c.json(step);
  });
  // Everything the agent gave about one step of Activity, when it opens:
  // never sent with the chat, so a long chat stays light.
  app.get(`${one}/entries/:entryId`, async (c) => {
    const found = await transcripts.details(
      await chatOf(c),
      c.req.param("entryId"),
    );
    if (!found) throw new HttpError(404, "Not found.");
    return c.json(found);
  });
  // Send: into the queue, and the box emptied, in one step; from there it
  // goes into the running reply (steer) or after it (queue), as the person
  // chose. The same id again (a retry)
  // finds the message it made.
  app.post(`${one}/messages`, async (c) => {
    const found = await chatOf(c);
    const { id, text, refs, kind, aiText, writtenAt } = await body(
      c,
      SendMessage,
      SEND_REFUSAL,
    );
    if (text === "" && (refs?.length ?? 0) === 0) {
      throw new HttpError(400, SEND_REFUSAL);
    }
    // Kept on the iPhone while it couldn't reach Rufi: Rufi AI gets when it
    // was written, and the box's draft stays, as with a click.
    const given =
      aiText ??
      (writtenAt === undefined
        ? undefined
        : `${text}\n\n(Written on the iPhone at ${writtenAt}, its local time, while it couldn't reach Rufi; it arrived later.)`);
    await acting(() => chat.send(found, id, text, refs, kind, given));
    return c.json({ id, draft: await drafts.read(found) }, 202);
  });
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

  // What waits to go to the AI: Rufi's own queue.
  app.get(`${one}/queue`, async (c) =>
    c.json(await chat.queue.list(await chatOf(c))),
  );
  app.put(`${one}/queue`, async (c) => {
    const found = await chatOf(c);
    const { ids } = await body(c, ReorderQueue);
    await acting(() => chat.queue.reorder(found, ids));
    return c.json(await chat.queue.list(found));
  });
  app.put(`${one}/queue/:itemId`, async (c) => {
    const found = await chatOf(c);
    const { text } = await body(c, MessageText, MESSAGE_REFUSAL);
    await acting(() => chat.queue.edit(found, c.req.param("itemId"), text));
    return c.json(await chat.queue.list(found));
  });
  app.delete(`${one}/queue/:itemId`, async (c) => {
    const found = await chatOf(c);
    await acting(() => chat.queue.remove(found, c.req.param("itemId")));
    return c.json(await chat.queue.list(found));
  });
  app.post(`${one}/queue/:itemId/steer`, async (c) => {
    const found = await chatOf(c);
    await acting(() => chat.queue.steer(found, c.req.param("itemId")));
    return c.json(await chat.queue.list(found));
  });
  app.post(`${one}/queue/:itemId/send`, async (c) => {
    const found = await chatOf(c);
    await acting(() => chat.queue.send(found, c.req.param("itemId")));
    return c.json(await chat.queue.list(found));
  });
  app.post(`${one}/queue/:itemId/recover`, async (c) => {
    const found = await chatOf(c);
    const { hold, choice } = await body(c, RecoverMessage);
    await acting(() =>
      chat.queue.recover(found, c.req.param("itemId"), hold, choice),
    );
    return c.json(await chat.queue.list(found));
  });

  // The chat's draft; the last save wins.
  const draftPath = `${one}/draft`;
  app.get(draftPath, async (c) => c.json(await drafts.read(await chatOf(c))));
  app.put(draftPath, async (c) => {
    const found = await chatOf(c);
    const { text, refs } = await body(c, SaveDraft);
    try {
      return c.json(await drafts.save(found, text, refs));
    } catch (error) {
      if (error instanceof RefRefusal) throw new HttpError(400, error.message);
      throw error;
    }
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
      const unwatch = chat.queue.subscribe(found.id, () => {
        push({ type: "queue" });
      });
      const unread = deps.readings.subscribe(found.personId, () => {
        push({ type: "documents" });
      });
      const unagents = deps.agents.subscribe(found.id, () => {
        push({ type: "agents" });
      });
      const undoses = deps.doses.subscribe(found.personId, () => {
        push({ type: "doses" });
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
        unread();
        unagents();
        undoses();
      }
    });
  });
}
