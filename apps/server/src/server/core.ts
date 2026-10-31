// The core: one long-lived process that holds rufi.lock, owns the database,
// each person's chat and the agent system, and serves the local API on 127.0.0.1.
// Each part is opened in a scope; closing it closes them all in reverse,
// even when one of them fails.
import { mkdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Provider, ProviderStatus, Status } from "@rufi/contracts";
import type { PersonNotices } from "@rufi/contracts/app";
import { serve, type ServerType } from "@hono/node-server";
import type { ProviderAdapter } from "@rufi/agents/provider";
import { openAgentStore, type AgentStore } from "@rufi/agents/store";
import { Effect } from "effect";
import type { AgentSandbox } from "../agent/runtime.ts";
import { readBrief } from "../core/briefs/briefs.ts";
import { continuesAfterRestart } from "../core/chat/continues.ts";
import { DEFAULT_MODEL } from "../core/chat/models.ts";
import { drafts as openDrafts } from "../core/chat/drafts.ts";
import { chatAgents } from "../core/chat/agents.ts";
import { chatQueue } from "../core/chat/queue.ts";
import { transcripts as openTranscripts } from "../core/chat/transcript.ts";
import { deletions, sweepFiles } from "../core/documents/delete.ts";
import { documents } from "../core/documents/documents.ts";
import { fileGate } from "../core/documents/gate.ts";
import { saveReading } from "../core/documents/save-reading.ts";
import { sorting as openSorting } from "../core/documents/sorting.ts";
import { readings as openReadings } from "../core/documents/reading.ts";
import { draftItems } from "../core/documents/items.ts";
import { backupJob } from "../core/store/backup.ts";
import { workCleaner } from "../core/store/work.ts";
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
import { changeProfile, readProfile } from "../core/record/profile.ts";
import { localTime } from "../core/record/dates.ts";
import { pages } from "../core/documents/pages.ts";
import { rufiCaller, forAgent } from "../core/tools/tools.ts";
import {
  coreInstructions,
  rulesVersion,
  subAgentInstructions,
} from "../core/chat/instructions.ts";
import { SKILLS } from "../core/skills/skills.ts";
import { backupsPath } from "../core/store/backup.ts";
import { devices as openDevices } from "../core/devices/devices.ts";
import {
  holdRufiLock,
  readJson,
  tempPattern,
  writePrivateJson,
} from "../platform/files.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import { agentsPath } from "./agents.ts";
import { api, LAUNCHER_HEADER } from "./api.ts";
import { chat as openChat, type Chat } from "./chat.ts";
import { claudeEnvironment, claudeFolder } from "../agent/claude/executable.ts";
import { prepareClaudePlugin } from "../agent/claude/session.ts";
import { generatedImages } from "../agent/codex/settings.ts";
import { aiFiles } from "./files.ts";
import { mcpEndpoint, mcpKeys, skillResources } from "./mcp.ts";
import { startRufiAi } from "./rufi-ai.ts";
import { converter as openConverter } from "./converter.ts";
import { secret, sessions } from "./session.ts";
import { agentRuns, subAgents } from "./sub-agents.ts";
import { keptSignIns, signInFlow, type ProviderSignIn } from "./signin.ts";

export interface CoreOptions {
  /** Rufi's data folder. */
  home: string;
  /**
   * How the data folder was chosen, for Settings, and how to show it in
   * Finder; RUFI_HOME, and nothing to show, when not given.
   */
  folder?: { source: FolderSource; show: (path: string) => Promise<void> };
  /**
   * The providers the agent system runs on, Rufi AI's first; closed when
   * the core closes.
   */
  adapters: readonly ProviderAdapter[];
  /** 0 (the default) picks a free port. */
  port?: number;
  log: Log;
  /** Updates a screen may fall behind by before its stream is closed. */
  behindMax?: number;
  /**
   * Each provider's sign-in, the chat's (Codex) first: as each reports it,
   * and started from the screens. One not given is signed out.
   */
  signIns?: Partial<Record<Provider, ProviderSignIn>>;
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

/**
 * Where the chat's AI works (ADR 0016): the AI's folder, in the data folder,
 * the only place its commands can write; nothing in it is part of the
 * record. They can't read the record's database, its backups or this
 * file's secret, so the record is reached only through Rufi's tools.
 */
export function aiSandbox(home: string): AgentSandbox {
  const databases = [databasePath(home), agentsPath(home)];
  return {
    folder: join(home, "ai"),
    unreadable: [
      ...databases.flatMap((database) => [
        database,
        ...["-wal", "-shm", "-journal"].map((end) => `${database}${end}`),
      ]),
      backupsPath(home),
      coreFile(home),
      // Its temp copy while it is written: Codex denies a glob too.
      tempPattern(coreFile(home)),
      // Codex's sign-in, and Claude's folder with its own.
      join(home, "codex", "auth.json"),
      claudeFolder(home),
    ],
  };
}

/** What the chat's agent needs from Rufi to start: its sandbox and the skills. */
export const agentSetup = (home: string) => ({
  sandbox: aiSandbox(home),
  skills: SKILLS,
});

/**
 * What Claude needs from Rufi to run its agents: the same sandbox, its own
 * folder in the data folder in its environment (`env`, the child's), and
 * Rufi's skills as its plugin, written afresh.
 */
export const claudeSetup = async (
  home: string,
  env: Readonly<Record<string, string>>,
) => ({
  sandbox: aiSandbox(home),
  env: claudeEnvironment(home, env),
  plugin: await prepareClaudePlugin(home, SKILLS),
});

/** Where Rufi's MCP server takes the agents' calls. */
const MCP_CHAT = "/mcp";

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
    // Set once the databases are open, for the lock's loss to close them.
    const opened: { writer?: Store; agents?: AgentStore } = {};
    yield* Effect.acquireRelease(
      attempt(() =>
        holdRufiLock(home, (error) => {
          // Another process may write now: Rufi stops writing at once.
          log("core.lock_lost", { error: errorCode(error) });
          if (opened.writer?.db.isOpen) opened.writer.close();
          if (opened.agents?.db.isOpen) opened.agents.close();
        }),
      ),
      (release) => Effect.promise(() => release().catch(() => undefined)),
    );
    // Stopping the server cuts connections, not the work of their handlers,
    // nor the calls to Rufi's tools, whose answers stream after a response.
    const answering = new Set<Promise<unknown>>();
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
    // After the server and background work stop, finish the handlers before
    // closing their record connections or releasing the folder. A document
    // whose original is still being written must be able to commit its rows.
    // Never hand the folder to another owner while a handler can still write.
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.allSettled(answering)),
    );
    const transcripts = openTranscripts(writer, options.now);
    const drafts = openDrafts(writer, options.now);
    const queue = chatQueue(writer, options.now);
    // Whether a document's reader is at work: the agent system is made by
    // the time anything lists documents.
    const readings = openReadings(writer, {
      runs: (agent) => agentRuns(agentSystem.agents, agent),
    });
    const sorting = openSorting(writer, options.now);
    const deviceData = openDevices(
      writer,
      options.now ?? (() => new Date().toISOString()),
    );
    // Before anything uses the files: what a delete left when Rufi stopped.
    yield* attempt(() => sweepFiles(writer, home));
    yield* Effect.acquireRelease(
      Effect.sync(() => workCleaner(writer, home, log, options.now)),
      (cleaner) => Effect.promise(() => cleaner.close()),
    );
    const gate = fileGate();
    yield* attempt(() => cleanExportStaging(home));
    const backups = yield* Effect.acquireRelease(
      Effect.sync(() => backupJob(home, log, { gate })),
      (job) => Effect.promise(() => job.close()),
    );
    // In the background: a backup never delays or stops the start.
    backups.start();
    // The agent system's own database, brought into step with the record
    // before anything goes to a provider (server/agents.ts).
    const agentStore = yield* Effect.acquireRelease(
      attempt(() => openAgentStore(agentsPath(home))),
      (store) =>
        Effect.sync(() => {
          if (store.db.isOpen) store.close();
        }),
    );
    opened.agents = agentStore;
    const signIns = options.signIns ?? {};
    const isProvider = (id: string): id is Provider =>
      id === "codex" || id === "claude";
    // How each provider is signed in, as it last said (server/signin.ts).
    const signedIn = yield* Effect.acquireRelease(
      Effect.sync(() => keptSignIns(signIns)),
      (kept) => Effect.sync(kept.close),
    );
    const agentSystem = yield* Effect.acquireRelease(
      attempt(() =>
        startRufiAi({
          store: agentStore,
          record: writer,
          transcripts,
          adapters: options.adapters,
          tools: forAgent(
            () => ({ store: reader, personId: undefined }),
            log,
          ).specs.map((spec) => spec.name),
          cwd: aiSandbox(home).folder,
          model: DEFAULT_MODEL,
          documents: (personId) => {
            readings.changed(personId);
          },
          signedOut: () => {
            void signedIn.refresh("codex");
            void signedIn.refresh("claude");
          },
          log,
          ...(options.now && { now: options.now }),
        }),
      ),
      (system) => Effect.promise(() => system.close()),
    );
    // Replies still running once Rufi has read the agent database's events
    // were cut when it stopped.
    const interrupted = yield* attempt(() => transcripts.interruptRunning());

    const tools = forAgent(() => ({ store: reader, personId: undefined }), log);
    let port = 0;
    // Rufi's MCP server, with a key for each agent (server/mcp.ts).
    const chatKeys = mcpKeys();
    const mcpUrl = (path: string) => `http://127.0.0.1:${String(port)}${path}`;
    const signedOut: ProviderStatus = {
      state: "signed_out",
      account: null,
      text: null,
    };
    const statusOf = (provider: Provider) => signedIn.status(provider);
    const account = async (): Promise<Status> => {
      const [codex, claude] = await Promise.all([
        statusOf("codex"),
        statusOf("claude"),
      ]);
      return { codex, claude };
    };
    const pageService = pages(reader ?? writer, home, gate);
    const chat = yield* Effect.acquireRelease(
      Effect.sync(() =>
        openChat({
          transcripts,
          queue,
          signIn: (provider) =>
            isProvider(provider)
              ? statusOf(provider)
              : Promise.resolve(signedOut),
          agent: agentSystem.rufiAi,
          mcp: { url: () => mcpUrl(MCP_CHAT), keys: chatKeys },
          rules: (region, agent) => {
            const instructions = agent
              ? subAgentInstructions(region, agent)
              : coreInstructions(region);
            return {
              instructions,
              version: rulesVersion(region, instructions),
            };
          },
          tools: {
            specs: tools.specs,
            caller: rufiCaller(
              reader,
              transcripts,
              log,
              reader && pages(reader, home, gate),
              {
                run: sorting.sort,
                done: (personId) => {
                  readings.changed(personId);
                },
              },
              subAgents({
                agents: agentSystem.agents,
                kept: chatAgents(writer, options.now),
                queue,
                log,
                // The chat these tools run in: made by now.
                messages: (): Chat["queue"] => chat.queue,
                signIn: (provider) =>
                  isProvider(provider)
                    ? statusOf(provider)
                    : Promise.resolve(signedOut),
                usage: () => agentSystem.usage(),
              }),
              {
                run: saveReading(options.now),
                done: (personId) => {
                  readings.changed(personId);
                },
              },
            ),
          },
          log,
          readings,
        }),
      ),
      (opened) => Effect.promise(() => opened.close()),
    );

    const convertLoop = yield* Effect.acquireRelease(
      Effect.sync(() => openConverter({ devices: deviceData, log })),
      (opened) => Effect.promise(() => opened.close()),
    );

    const access = sessions();
    const launcher = secret();
    // The token is in the fragment: the browser never sends it in a request.
    const launchUrl = () =>
      `http://127.0.0.1:${String(port)}/#launch=${access.launch()}`;
    // The Mac's local time, for when follow-ups are due.
    const clock = () =>
      options.now === undefined ? new Date() : new Date(options.now());
    const record = recordViews(reader ?? writer, clock);
    const personDocuments = documents(
      writer,
      home,
      options.now,
      readings,
      gate,
    );
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
      profile: {
        read: (personId) =>
          readProfile(
            (reader ?? writer).query,
            personId,
            localTime(clock().toISOString()).slice(0, 10),
          ),
        save: async (personId, form, sending, changes) => {
          await writer.query
            .transaction()
            .execute((trx) =>
              changeProfile(
                trx,
                { personId, form, sending, now: clock().toISOString() },
                changes,
              ),
            );
        },
      },
      brief: async (personId, briefId) =>
        reader && (await readBrief(reader.query, personId, briefId)),
      account,
      backups,
      devices: {
        ...deviceData,
        trouble: convertLoop.trouble,
        cleanSoon: convertLoop.cleanSoon,
        cleaning: convertLoop.cleaning,
      },
      folder: {
        path: home,
        source: options.folder?.source ?? "RUFI_HOME",
        show: () =>
          options.folder?.show(home) ??
          Promise.reject(new Error("Finder isn't offered here.")),
      },
      exportZip: (signal) => exportZip(home, new Date(), gate, signal),
      documents: personDocuments,
      deletions: deletions({
        store: writer,
        home,
        gate,
        event: chat.event,
        changed: readings.changed,
        log,
        ...(options.now && { now: options.now }),
      }),
      readings,
      agents: agentSystem.logs,
      items: draftItems(writer, readings.changed),
      pages: pageService,
      files: aiFiles({
        folder: aiSandbox(home).folder,
        generated: generatedImages(home),
      }),
      signIn: signInFlow(signIns, log, signedIn.refresh),
      launcher,
      launchUrl,
      ...(options.screens !== undefined && { screens: options.screens }),
      log,
      ...(options.behindMax !== undefined && { behindMax: options.behindMax }),
    });
    // Outside the screens' checks: the agent sends no Origin, and each
    // endpoint has its own (server/mcp.ts).
    const mcp: Record<string, (request: Request) => Promise<Response>> = {
      [MCP_CHAT]: mcpEndpoint({
        keys: chatKeys,
        port: () => port,
        log,
        resources: skillResources(SKILLS),
        working: answering,
      }),
    };
    const server = yield* Effect.acquireRelease(
      attempt(
        () =>
          new Promise<ServerType>((resolve, reject) => {
            const started = serve(
              {
                fetch: (request, env) => {
                  const endpoint = mcp[new URL(request.url).pathname];
                  const answer = Promise.resolve(
                    endpoint ? endpoint(request) : app.fetch(request, env),
                  );
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
    // Rufi's MCP server listens and the chat is open: each chat's waiting
    // messages go into Rufi AI's queue, in order, and only now may the
    // agents' inputs go.
    yield* attempt(() => chat.carryAll());
    // A turn that ran when Rufi stopped carries on, as Settings says.
    const continues = yield* attempt(() =>
      continuesAfterRestart(transcripts.setting),
    );
    yield* attempt(() => agentSystem.agents.dispatch({ continues }));
    convertLoop.start();
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
