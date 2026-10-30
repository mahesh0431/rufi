// One Codex app-server child process, signed in by Codex itself from its
// CODEX_HOME, and checked before Rufi uses it.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { errorCode } from "../../platform/logs.ts";
import { killTree, trackGroups } from "./processes.ts";
import type { InitializeParams } from "./protocol/InitializeParams.ts";
import type { GetAccountResponse } from "./protocol/v2/GetAccountResponse.ts";
import { connect, type Rpc, type RpcHandlers } from "./rpc.ts";
import { checkSettings } from "./settings.ts";

/** How to run Codex: the pinned binary in the app, a scripted fake in tests. */
export interface CodexCommand {
  file: string;
  args: readonly string[];
}

export interface Deadlines {
  /** Codex's start: its process starting, then its answer to initialize. */
  startMs: number;
  /** Thread start/resume, the turn/start acknowledgement, checks. */
  requestMs: number;
  /** Stop: for Codex to acknowledge the interrupt, then for the turn to end. */
  interruptAckMs: number;
  interruptEndMs: number;
  /** Rufi's own answers to Codex's requests. */
  answerMs: number;
  /** One of Rufi's tools; Codex itself would wait forever. Under answerMs. */
  toolMs: number;
}

export const DEADLINES: Deadlines = {
  startMs: 30_000,
  requestMs: 30_000,
  interruptAckMs: 5_000,
  interruptEndMs: 10_000,
  answerMs: 30_000,
  toolMs: 20_000,
};

/** What Rufi says when Codex isn't signed in: how to sign in. */
export const SIGNED_OUT =
  "Codex isn't signed in to ChatGPT. Sign in from Settings, then try again.";

/** Codex's answer to `account/read`: it needs a sign-in and has none. */
export const signedOut = ({
  account,
  requiresOpenaiAuth,
}: GetAccountResponse) => account === null && requiresOpenaiAuth;

export interface AppServer {
  rpc: Rpc;
  running: () => boolean;
  /**
   * Remembers the process groups started under app-server, so they can be
   * ended if app-server crashes.
   */
  track: () => Promise<void>;
  /** Ends app-server and every program it started. */
  stop: () => Promise<void>;
}

export interface StartOptions {
  command: CodexCommand;
  /** The child's whole environment, apart from CODEX_HOME. */
  env: Readonly<Record<string, string>>;
  codexHome: string;
  version: string;
  deadlines: Deadlines;
  handlers: RpcHandlers;
  /** Aborting it while app-server starts ends app-server. */
  signal?: AbortSignal;
  /** Called once app-server has exited and the commands it left are ended. */
  onExit: (why: Error) => void;
}

export async function startAppServer(
  options: StartOptions,
): Promise<AppServer> {
  options.signal?.throwIfAborted();
  const child = spawn(
    options.command.file,
    [...options.command.args, "app-server", "--listen", "stdio://"],
    {
      env: { ...options.env, CODEX_HOME: options.codexHome },
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so Stop can end it with everything it started.
      detached: true,
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  const rpc = connect(
    child.stdout,
    child.stdin,
    options.handlers,
    options.deadlines.answerMs,
  );
  // Codex runs each command in a new session, so once app-server is gone its
  // commands are no longer below it; Rufi remembers their groups instead.
  const groups = new Set<number>();
  const exited = Promise.withResolvers<undefined>();
  let running = true;
  const ended = (why: Error) => {
    if (!running) return;
    running = false;
    rpc.close(why);
    // Only the remembered groups: app-server's own pid may already be reused.
    void killTree(undefined, groups)
      .catch((error: unknown) => {
        options.handlers.ignored("cleanup_after_exit_failed", errorCode(error));
      })
      .finally(() => {
        options.onExit(why);
        exited.resolve(undefined);
      });
  };
  child.on("exit", (code, signal) => {
    // The exit code or signal is the error's code, for the log.
    ended(
      Object.assign(
        new Error(`Codex stopped (${String(code ?? signal)}).`, {
          cause: new Error(stderr),
        }),
        { code: String(code ?? signal) },
      ),
    );
  });
  child.on("error", (error) => {
    ended(new Error("Couldn't start Codex.", { cause: error }));
  });

  const stop = async () => {
    if (running && child.pid !== undefined) {
      await killTree(child.pid, groups);
    }
    // A deadline alone mustn't keep Rufi running once Codex has exited.
    await Promise.race([
      exited.promise,
      sleep(5_000, undefined, { ref: false }),
    ]);
  };
  const track = async () => {
    if (running && child.pid !== undefined) {
      await trackGroups(child.pid, groups);
    }
  };
  const abort = () => void stop();
  options.signal?.addEventListener("abort", abort);
  try {
    const params: InitializeParams = {
      // The name matches the agent_name_hint sent when Rufi registers.
      clientInfo: { name: "Rufi", title: "Rufi", version: options.version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    await rpc.request("initialize", params, options.deadlines.startMs);
    rpc.notify("initialized");
    await checkSettings(rpc, options.deadlines.requestMs);
  } catch (error) {
    await stop();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
  return {
    rpc,
    running: () => running,
    track,
    stop,
  };
}
