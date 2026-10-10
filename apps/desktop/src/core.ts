// Rufi's core, as the app's child: `rufi start` on the pinned Node, exactly
// what `pnpm start` runs, with a private channel instead of printed links
// (apps/server/src/cli/app.ts). The command finds a running Rufi itself; the
// app reads no file and parses no text.
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type PersonNotices, ToApp } from "@rufi/contracts/app";
import { Schema } from "effect";

const CLI = fileURLToPath(
  new URL("../../server/src/cli/main.ts", import.meta.url),
);

/** How long Rufi may take to start, or to find the running one. */
const START_MS = 30_000;
/** How long a running Rufi may take to give a fresh link, or the notices. */
const ANSWER_MS = 10_000;
/** How long Rufi may take to stop, as with Ctrl-C, before it is killed. */
const STOP_MS = 10_000;

const decode = Schema.decodeUnknownOption(ToApp);

/**
 * Exactly a launch link of a Rufi on this Mac: `http://127.0.0.1:<port>/#launch=<token>`.
 * The window loads nothing else.
 */
function launchLink(url: string): URL | undefined {
  const link = URL.parse(url);
  const exact =
    link?.protocol === "http:" &&
    link.hostname === "127.0.0.1" &&
    link.port !== "" &&
    link.username === "" &&
    link.password === "" &&
    link.pathname === "/" &&
    link.search === "" &&
    /^#launch=[\w-]+$/.test(link.hash);
  return exact ? link : undefined;
}

/** A failure, in words for the person. */
export class CoreError extends Error {}

export interface Core {
  /**
   * A fresh single-use link for a new window: from the Rufi this app runs,
   * else from `rufi start`, which starts Rufi or finds the one that runs.
   */
  link: () => Promise<URL>;
  /**
   * The follow-up notices due now, which the Rufi this app runs marks as
   * told (docs/adr/0012). None when the app runs no Rufi of its own: one
   * that `pnpm start` runs gives no notices.
   */
  notices: () => Promise<readonly PersonNotices[]>;
  /**
   * Stops the Rufi this app started, as Ctrl-C does; kills it after
   * STOP_MS. A Rufi that `pnpm start` runs is left running.
   */
  stop: () => Promise<void>;
}

/**
 * Rufi for the app, run with `node`. `onOwned` is told when a Rufi this app
 * started is ready, and `onLost` when it stops by itself.
 */
export function core(
  node: string,
  { onOwned, onLost }: { onOwned: () => void; onLost: () => void },
): Core {
  /** Every `rufi start` still running: the owned one, or one starting. */
  const children = new Set<ChildProcess>();
  let owned: ChildProcess | undefined;
  let stopping: Promise<void> | undefined;
  // One link at a time, so two new windows never start two Rufis.
  let queue: Promise<unknown> = Promise.resolve();

  /** The first message of a new `rufi start`. */
  function start(): Promise<URL> {
    const child = spawn(node, [CLI, "start", "--no-open"], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      // Its own process group: Ctrl-C in the terminal reaches the app, which
      // stops Rufi through the channel, not Rufi behind its back.
      detached: true,
    });
    children.add(child);
    child.once("exit", () => children.delete(child));
    return new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
        void ended(child);
        reject(
          new CoreError(
            `Rufi didn't start within ${String(START_MS / 1000)} seconds.`,
          ),
        );
      }, START_MS);
      const onMessage = (raw: unknown) => {
        finish();
        const message = decode(raw);
        if (
          message._tag === "None" ||
          message.value.type === "link" ||
          message.value.type === "notices"
        ) {
          void ended(child);
          reject(
            new CoreError("Rufi answered the app in a way it doesn't know."),
          );
          return;
        }
        if (message.value.type === "failed") {
          reject(new CoreError(message.value.message));
          return;
        }
        const link = launchLink(message.value.url);
        if (link === undefined) {
          void ended(child);
          reject(new CoreError("Rufi gave the app a link it can't use."));
          return;
        }
        if (message.value.type === "owned") {
          owned = child;
          child.once("exit", () => {
            if (owned === child) owned = undefined;
            if (stopping === undefined) onLost();
          });
          onOwned();
        }
        resolve(link);
      };
      const onExit = () => {
        finish();
        reject(
          new CoreError(
            "Rufi stopped before it started. The terminal may say why.",
          ),
        );
      };
      const onError = (error: Error) => {
        finish();
        reject(new CoreError("The app couldn't run Rufi.", { cause: error }));
      };
      function finish() {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", onError);
      }
      child.on("message", onMessage);
      child.on("exit", onExit);
      child.on("error", onError);
    });
  }

  /**
   * Asks the Rufi this app runs, and waits for the answer of type `type`
   * for ANSWER_MS at most.
   */
  function request<T extends "link" | "notices">(
    child: ChildProcess,
    type: T,
  ): Promise<Extract<ToApp, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
        reject(new CoreError("Rufi didn't answer in time."));
      }, ANSWER_MS);
      const onMessage = (raw: unknown) => {
        const message = decode(raw);
        if (message._tag === "None" || message.value.type !== type) return;
        finish();
        resolve(message.value as Extract<ToApp, { type: T }>);
      };
      const onExit = () => {
        finish();
        reject(new CoreError("Rufi stopped."));
      };
      function finish() {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
      }
      child.on("message", onMessage);
      child.on("exit", onExit);
      child.send(
        { type: type === "link" ? "link" : "claim-notices" },
        (error) => {
          if (error === null) return;
          finish();
          reject(new CoreError("Rufi stopped.", { cause: error }));
        },
      );
    });
  }

  /** A fresh link from the Rufi this app runs. */
  async function ask(child: ChildProcess): Promise<URL> {
    const link = launchLink((await request(child, "link")).url);
    if (link === undefined) {
      throw new CoreError("Rufi gave the app a link it can't use.");
    }
    return link;
  }

  return {
    link() {
      const next = queue.then(() => {
        if (stopping !== undefined) throw new CoreError("Rufi is stopping.");
        return owned?.connected === true ? ask(owned) : start();
      });
      queue = next.catch(() => undefined);
      return next;
    },
    async notices() {
      if (owned?.connected !== true || stopping !== undefined) return [];
      return (await request(owned, "notices")).people;
    },
    stop() {
      stopping ??= Promise.all([...children].map(ended)).then(() => undefined);
      return stopping;
    },
  };
}

/**
 * Closes the channel, which stops an owned Rufi as Ctrl-C does (one that
 * found a running Rufi ends by itself), and waits until it has ended.
 */
function ended(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const late = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
    child.once("exit", () => {
      clearTimeout(late);
      resolve();
    });
    if (child.connected) child.disconnect();
  });
}
