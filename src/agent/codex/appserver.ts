// One Codex app-server child process, started as OpenAI documents for ChatGPT
// plan use, and checked before Rufi uses it.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { killTree } from "./processes.ts";
import type { InitializeParams } from "./protocol/InitializeParams.ts";
import { connect, type Rpc, type RpcHandlers } from "./rpc.ts";
import { checkSettings } from "./settings.ts";

/** How to run Codex: the pinned binary in the app, a scripted fake in tests. */
export interface CodexCommand {
  file: string;
  args: readonly string[];
}

export interface Deadlines {
  /** initialize, thread start/resume, the turn/start acknowledgement, checks. */
  requestMs: number;
  /** A whole turn. */
  turnMs: number;
  /** Stop: for Codex to acknowledge the interrupt, then for the turn to end. */
  interruptAckMs: number;
  interruptEndMs: number;
  /** Rufi's own answers to Codex's requests. */
  answerMs: number;
}

export const DEADLINES: Deadlines = {
  requestMs: 30_000,
  turnMs: 5 * 60_000,
  interruptAckMs: 5_000,
  interruptEndMs: 10_000,
  answerMs: 30_000,
};

export interface AppServer {
  rpc: Rpc;
  /** The access token this process was started with. */
  token: string;
  running: () => boolean;
  /** Ends app-server and every program it started. */
  stop: () => Promise<void>;
}

export interface StartOptions {
  command: CodexCommand;
  /** The child's whole environment, apart from CODEX_HOME and ACCESS_TOKEN. */
  env: Readonly<Record<string, string>>;
  codexHome: string;
  token: string;
  version: string;
  deadlines: Deadlines;
  handlers: RpcHandlers;
  onExit: (why: Error) => void;
}

export async function startAppServer(
  options: StartOptions,
): Promise<AppServer> {
  const child = spawn(
    options.command.file,
    [...options.command.args, "app-server", "--listen", "stdio://"],
    {
      env: {
        ...options.env,
        CODEX_HOME: options.codexHome,
        ACCESS_TOKEN: options.token,
      },
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
  const exited = Promise.withResolvers<undefined>();
  let running = true;
  const ended = (why: Error) => {
    if (!running) return;
    running = false;
    rpc.close(why);
    options.onExit(why);
    exited.resolve(undefined);
  };
  child.on("exit", (code, signal) => {
    ended(
      new Error(`Codex stopped (${String(code ?? signal)}).`, {
        cause: new Error(stderr),
      }),
    );
  });
  child.on("error", (error) => {
    ended(new Error("Couldn't start Codex.", { cause: error }));
  });

  const stop = async () => {
    if (running && child.pid !== undefined) await killTree(child.pid);
    await Promise.race([exited.promise, sleep(5_000)]);
  };
  try {
    const params: InitializeParams = {
      // The name matches the agent_name_hint sent when Rufi registers.
      clientInfo: { name: "Rufi", title: "Rufi", version: options.version },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    await rpc.request("initialize", params, options.deadlines.requestMs);
    rpc.notify("initialized");
    await checkSettings(rpc, options.deadlines.requestMs);
  } catch (error) {
    await stop();
    throw error;
  }
  return { rpc, token: options.token, running: () => running, stop };
}
