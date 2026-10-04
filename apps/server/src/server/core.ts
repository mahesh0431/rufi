// The core: one long-lived process that holds rufi.lock, owns the database,
// the conversations and the agent, and serves the local API on 127.0.0.1.
// Each part is opened in a scope; closing it closes them all in reverse,
// even when one of them fails.
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Effect } from "effect";
import type { AgentHost, AgentRuntime, AgentTools } from "../agent/runtime.ts";
import { allowlistFile } from "../core/chat/models.ts";
import { transcripts as openTranscripts } from "../core/chat/transcript.ts";
import {
  databasePath,
  openReadOnly,
  openWritable,
  type Store,
} from "../core/store/database.ts";
import { getOverview } from "../core/tools/overview.ts";
import { forAgent, toolsVersion } from "../core/tools/tools.ts";
import { holdRufiLock } from "../platform/files.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import { api } from "./api.ts";
import { chat as openChat, type Chat } from "./chat.ts";
import { sessions } from "./session.ts";

export interface CoreOptions {
  /** Rufi's data folder. */
  home: string;
  /** Makes the agent, with Rufi's tools and the host its events go to. */
  agent: (tools: AgentTools, host: AgentHost) => AgentRuntime;
  /** 0 (the default) picks a free port. */
  port?: number;
  log: Log;
  /** Updates a screen may fall behind by before its stream is closed. */
  behindMax?: number;
}

export interface Core {
  port: number;
  /** A link that opens Rufi in a browser; each call gives a new single-use one. */
  launchUrl: () => string;
  chat: Chat;
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
    const writer = yield* Effect.acquireRelease(
      attempt(() => openWritable(databasePath(home))),
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
    const transcripts = openTranscripts(writer);
    const interrupted = yield* attempt(() => transcripts.interruptRunning());

    const tools = forAgent(() => ({ store: reader, personId: undefined }), log);
    const allowlist = allowlistFile(home);
    const chat = yield* Effect.acquireRelease(
      Effect.sync(() =>
        openChat({
          transcripts,
          agent: (host) =>
            options.agent(
              { namespace: tools.namespace, specs: tools.specs },
              host,
            ),
          allowlist: allowlist.read,
          tools: {
            version: toolsVersion(),
            instructions: tools.instructions,
            caller: (personId, conversationId) =>
              forAgent(
                () => ({ store: reader, personId, conversationId }),
                log,
              ).forTurn(),
          },
          log,
        }),
      ),
      (opened) => Effect.promise(() => opened.close()),
    );

    let port = 0;
    const access = sessions();
    const app = api({
      transcripts,
      chat,
      sessions: access,
      port: () => port,
      overview: (personId) =>
        Promise.resolve(getOverview.run({}, { store: reader, personId })),
      log,
      ...(options.behindMax !== undefined && { behindMax: options.behindMax }),
    });
    const server = yield* Effect.acquireRelease(
      attempt(
        () =>
          new Promise<ServerType>((resolve, reject) => {
            const started = serve(
              {
                fetch: app.fetch,
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
    log("core.started", { count: interrupted });
    const core: Core = {
      port,
      launchUrl: () =>
        `http://127.0.0.1:${String(port)}/?launch=${access.launch()}`,
      chat,
    };
    return core;
  });
