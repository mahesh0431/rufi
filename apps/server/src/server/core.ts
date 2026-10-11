// The core: one long-lived process that holds rufi.lock, owns the database,
// each person's chat and the agent, and serves the local API on 127.0.0.1.
// Each part is opened in a scope; closing it closes them all in reverse,
// even when one of them fails.
import { mkdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Status } from "@rufi/contracts";
import type { PersonNotices } from "@rufi/contracts/app";
import { serve, type ServerType } from "@hono/node-server";
import { Effect } from "effect";
import type {
  AgentHost,
  AgentRuntime,
  AgentTools,
  RunSubAgent,
} from "../agent/runtime.ts";
import { readBrief } from "../core/briefs/briefs.ts";
import { allowlistFile } from "../core/chat/models.ts";
import { drafts as openDrafts } from "../core/chat/drafts.ts";
import { chatQueue } from "../core/chat/queue.ts";
import { transcripts as openTranscripts } from "../core/chat/transcript.ts";
import { documents } from "../core/documents/documents.ts";
import { notebook } from "../core/documents/notebook.ts";
import { readings as openReadings } from "../core/documents/reading.ts";
import { draftItems } from "../core/documents/items.ts";
import { backupJob } from "../core/store/backup.ts";
import {
  databasePath,
  openReadOnly,
  type Store,
} from "../core/store/database.ts";
import { cleanExportStaging, exportZip } from "../core/store/export.ts";
import type { FolderSource } from "../core/store/data-folder.ts";
import { openRecord } from "../core/store/install.ts";
import { claimNotices } from "../core/record/notices.ts";
import { recordViews, waiting } from "../core/record/views.ts";
import { pages } from "../core/documents/pages.ts";
import { chatCaller, forAgent, toolsVersion } from "../core/tools/tools.ts";
import { holdRufiLock, readJson, writePrivateJson } from "../platform/files.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import { api, LAUNCHER_HEADER } from "./api.ts";
import { chat as openChat, type Chat } from "./chat.ts";
import { reader as openReader, readerChoice } from "./reader.ts";
import { secret, sessions } from "./session.ts";
import { signInFlow, type SignIn } from "./signin.ts";

export interface CoreOptions {
  /** Rufi's data folder. */
  home: string;
  /**
   * How the data folder was chosen, for Settings, and how to show it in
   * Finder; RUFI_HOME, and nothing to show, when not given.
   */
  folder?: { source: FolderSource; show: (path: string) => Promise<void> };
  /** Makes the agent, with Rufi's tools and the host its events go to. */
  agent: (tools: AgentTools, host: AgentHost) => AgentRuntime;
  /** Runs the document reader; without it, readings wait. */
  reader?: RunSubAgent;
  /** 0 (the default) picks a free port. */
  port?: number;
  log: Log;
  /** Updates a screen may fall behind by before its stream is closed. */
  behindMax?: number;
  /** The ChatGPT sign-in; signed out when not given. */
  account?: () => Promise<Status>;
  /** Signs in with ChatGPT from the screens; not offered when not given. */
  signIn?: SignIn;
  /** The built screens' folder (apps/web/dist). */
  screens?: string;
  /**
   * The time the chat stamps on what it stores, and when follow-ups are
   * due; the Mac's clock when not given.
   */
  now?: () => string;
}

/** What `pnpm start` reads to reach the running Rufi; there while it runs. */
export const coreFile = (home: string) => join(home, "core.json");

/** How long `pnpm start` waits for a running Rufi to answer. */
const REOPEN_MS = 3_000;

/**
 * A fresh link from the Rufi running with this data folder, or undefined
 * when none answers (no core.json, or one a crash left behind).
 */
export async function runningLink(home: string): Promise<string | undefined> {
  const found = (await readJson(coreFile(home))) as
    | { port?: unknown; launcher?: unknown }
    | undefined;
  if (typeof found?.port !== "number" || typeof found.launcher !== "string") {
    return undefined;
  }
  const origin = `http://127.0.0.1:${String(found.port)}`;
  try {
    const response = await fetch(`${origin}/api/launch`, {
      method: "POST",
      headers: { origin, [LAUNCHER_HEADER]: found.launcher },
      signal: AbortSignal.timeout(REOPEN_MS),
    });
    if (!response.ok) return undefined;
    const { url } = (await response.json()) as { url?: unknown };
    return typeof url === "string" ? url : undefined;
  } catch (error) {
    // Nothing listens there any more: a crash left the file behind.
    if (
      error instanceof TypeError ||
      (error as Error).name === "TimeoutError"
    ) {
      return undefined;
    }
    throw new Error("Couldn't reach the running Rufi", { cause: error });
  }
}

export interface Core {
  port: number;
  /** A link that opens Rufi in a browser; each call gives a new single-use one. */
  launchUrl: () => string;
  chat: Chat;
  /** Takes the follow-up notices due now, for the Rufi app (docs/adr/0012). */
  claimNotices: () => Promise<readonly PersonNotices[]>;
}

const attempt = <A>(step: () => Promise<A> | A) =>
  Effect.tryPromise({
    try: () => Promise.resolve().then(step),
    catch: (error) => error,
  });

/** Starts the core in the current scope; closing the scope stops it. */
export const startCore = (options: CoreOptions) =>
  Effect.gen(function* () {
    const { home, log } = options;
    yield* attempt(() => mkdir(home, { recursive: true, mode: 0o700 }));
    // Set once the database is open, for the lock's loss to close it.
    const opened: { writer?: Store } = {};
    yield* Effect.acquireRelease(
      attempt(() =>
        holdRufiLock(home, (error) => {
          // Another process may write now: Rufi stops writing at once.
          log("core.lock_lost", { error: errorCode(error) });
          if (opened.writer?.db.isOpen) opened.writer.close();
        }),
      ),
      (release) => Effect.promise(() => release().catch(() => undefined)),
    );
    // The requests the local API is answering. Stopping the server cuts
    // their connections, not their work (a page being drawn, the allowlist
    // written): the lock goes only once each has ended, after the agent and
    // the database have closed, so one waiting on them ends at once.
    const answering = new Set<Promise<unknown>>();
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.allSettled(answering)),
    );
    const writer = yield* Effect.acquireRelease(
      attempt(() => openRecord(home)),
      (store) =>
        Effect.sync(() => {
          if (store.db.isOpen) store.close();
        }),
    );
    opened.writer = writer;
    // Rufi's tools read through a connection of their own that can't write.
    const reader = yield* Effect.acquireRelease(
      attempt(() => openReadOnly(databasePath(home))),
      (store) => Effect.sync(() => store?.close()),
    );
    const transcripts = openTranscripts(writer, options.now);
    const drafts = openDrafts(writer, options.now);
    const queue = chatQueue(writer, options.now);
    const readings = openReadings(writer, options.now);
    yield* attempt(() => cleanExportStaging(home));
    const backups = yield* Effect.acquireRelease(
      Effect.sync(() => backupJob(home, log)),
      (job) => Effect.promise(() => job.close()),
    );
    // In the background: a backup never delays or stops the start.
    backups.start();
    const interrupted = yield* attempt(() => transcripts.interruptRunning());
    // Hand-overs Rufi stopped during are not sure, never sent again; what
    // waits goes when the person sends.
    yield* attempt(() => queue.endStopped());
    // Readings Rufi stopped in the middle continue from their notebook.
    yield* attempt(() => readings.recover());

    const tools = forAgent(() => ({ store: reader, personId: undefined }), log);
    const allowlist = allowlistFile(home);
    const account =
      options.account ??
      (() => Promise.resolve<Status>({ account: "signed_out", email: null }));
    const chat = yield* Effect.acquireRelease(
      Effect.sync(() =>
        openChat({
          transcripts,
          queue,
          signedIn: async () => (await account()).account === "signed_in",
          agent: (host) =>
            options.agent(
              { namespace: tools.namespace, specs: tools.specs },
              host,
            ),
          allowlist: allowlist.read,
          tools: {
            version: toolsVersion(),
            instructions: tools.instructions,
            caller: chatCaller(
              reader,
              transcripts,
              log,
              reader && pages(reader, home),
              (personId, documentId) => readings.retry(personId, documentId),
            ),
          },
          log,
        }),
      ),
      (opened) => Effect.promise(() => opened.close()),
    );

    // The document reader: one reading at a time, in the background.
    const pageService = pages(reader ?? writer, home);
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const opened = openReader({
          readings,
          book: notebook(writer, options.now),
          pages: pageService,
          event: chat.event,
          run: options.reader,
          signedIn: async () => (await account()).account === "signed_in",
          choice: () => readerChoice(transcripts.setting),
          log,
        });
        readings.watch(opened.poke);
        opened.start();
        return opened;
      }),
      (opened) => Effect.promise(() => opened.close()),
    );

    let port = 0;
    const access = sessions();
    const launcher = secret();
    // The token is in the fragment: the browser never sends it in a request.
    const launchUrl = () =>
      `http://127.0.0.1:${String(port)}/#launch=${access.launch()}`;
    // The Mac's local time, for when follow-ups are due.
    const clock = () =>
      options.now === undefined ? new Date() : new Date(options.now());
    const record = recordViews(reader ?? writer, clock);
    const personDocuments = documents(writer, home, options.now, readings);
    const app = api({
      transcripts,
      drafts,
      chat,
      sessions: access,
      port: () => port,
      overview: async (personId) => {
        const overview = await record.overview(personId);
        if (!overview) throw new Error("The person isn't in the record.");
        return {
          ...overview,
          needsYou: {
            ...overview.needsYou,
            documents: waiting(await personDocuments.list(personId)),
          },
        };
      },
      record,
      brief: async (personId, briefId) =>
        reader && (await readBrief(reader.query, personId, briefId)),
      account,
      backups,
      folder: {
        path: home,
        source: options.folder?.source ?? "RUFI_HOME",
        show: () =>
          options.folder?.show(home) ??
          Promise.reject(new Error("Finder isn't offered here.")),
      },
      exportZip: () => exportZip(home, new Date()),
      documents: personDocuments,
      readings,
      items: draftItems(writer, readings.changed),
      pages: pageService,
      signIn: signInFlow(options.signIn, log),
      launcher,
      launchUrl,
      ...(options.screens !== undefined && { screens: options.screens }),
      log,
      ...(options.behindMax !== undefined && { behindMax: options.behindMax }),
    });
    const server = yield* Effect.acquireRelease(
      attempt(
        () =>
          new Promise<ServerType>((resolve, reject) => {
            const started = serve(
              {
                fetch: (request, env) => {
                  const answer = Promise.resolve(app.fetch(request, env));
                  const done = () => answering.delete(answer);
                  answering.add(answer);
                  answer.then(done, done);
                  return answer;
                },
                hostname: "127.0.0.1",
                port: options.port ?? 0,
              },
              () => {
                resolve(started);
              },
            );
            started.once("error", reject);
          }),
      ),
      (listening) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              listening.close(() => {
                resolve();
              });
              // Open streams would keep the server waiting.
              if ("closeAllConnections" in listening) {
                listening.closeAllConnections();
              }
            }),
        ),
    );
    port = (server.address() as AddressInfo).port;
    yield* Effect.acquireRelease(
      attempt(() => writePrivateJson(coreFile(home), { port, launcher })),
      () => Effect.promise(() => rm(coreFile(home), { force: true })),
    );
    log("core.started", { count: interrupted });
    const core: Core = {
      port,
      launchUrl,
      chat,
      claimNotices: () => claimNotices(writer.query, clock()),
    };
    return core;
  });
