// Tailscale, as Rufi uses it for the remote door (docs/adr/0032): this
// Mac's name on the tailnet, and Tailscale Serve passing HTTPS on the door's
// port to the door on 127.0.0.1. Never Funnel. Each command has a deadline
// and no secret in its arguments. A failure is one line for Settings, with
// Tailscale's own words as they came.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** How long one `tailscale` command may take. */
const COMMAND_MS = 5_000;
/**
 * How long the check through Serve may take: the first HTTPS request on a
 * name gets its certificate, which can take a while.
 */
const CHECK_MS = 30_000;

/** Where `tailscale` is: the Mac app's own, then the command line's. */
const COMMANDS = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "tailscale",
];

const INSTALL =
  "Rufi reaches your iPhone through Tailscale. Install it and sign in on this Mac and your iPhone, then try again.";

/** Why a Tailscale step failed, as the one line Settings shows. */
export class TailscaleProblem extends Error {}

export interface Tailscale {
  /** This Mac's name on the tailnet, such as mahesh-mbp.tail1234.ts.net. */
  name: () => Promise<string>;
  /** Serve passes https://<name>:<port> to http://127.0.0.1:<port>. */
  serve: (port: number) => Promise<void>;
  /** Serve stops passing `port`. */
  off: (port: number) => Promise<void>;
  /**
   * The door answers through Serve at `origin`: proves the name, its
   * certificate, Serve and the door together. `answers` reads the door's
   * answer.
   */
  check: (
    origin: string,
    answers: (response: Response) => Promise<boolean>,
  ) => Promise<void>;
}

/** Runs `tailscale` with `args`: its output, or an error with its own. */
export type Run = (args: readonly string[]) => Promise<string>;

/** The `tailscale` command found first; ENOENT when there is none. */
export const runTailscale: Run = async (args) => {
  let missing: unknown;
  for (const command of COMMANDS) {
    try {
      const { stdout } = await promisify(execFile)(command, [...args], {
        timeout: COMMAND_MS,
      });
      return stdout;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") throw error;
      missing = error;
    }
  }
  throw missing;
};

/** What Tailscale said when a command failed, as it came. */
const said = (error: unknown) => {
  const { stderr, stdout, killed } = error as {
    stderr?: unknown;
    stdout?: unknown;
    killed?: unknown;
  };
  const words = [stderr, stdout]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (words !== "") return words;
  return killed === true ? "it didn't answer in time" : "it failed";
};

export function tailscale(run: Run = runTailscale): Tailscale {
  return {
    name: async () => {
      let found: {
        BackendState?: unknown;
        Self?: { DNSName?: unknown };
        CertDomains?: unknown;
      };
      try {
        found = JSON.parse(await run(["status", "--json"])) as typeof found;
      } catch (error) {
        if ((error as { code?: unknown }).code === "ENOENT") {
          throw new TailscaleProblem(INSTALL, { cause: error });
        }
        throw new TailscaleProblem(
          `Rufi couldn't ask Tailscale about this Mac: ${said(error)}`,
          { cause: error },
        );
      }
      const name =
        typeof found.Self?.DNSName === "string"
          ? found.Self.DNSName.replace(/\.$/, "")
          : "";
      if (found.BackendState !== "Running" || name === "") {
        throw new TailscaleProblem(
          "Tailscale isn't connected on this Mac. Open Tailscale and sign in, then try again.",
        );
      }
      if (!Array.isArray(found.CertDomains) || found.CertDomains.length === 0) {
        throw new TailscaleProblem(
          "Turn on HTTPS in your Tailscale admin console (DNS page), then try again.",
        );
      }
      return name;
    },
    serve: async (port) => {
      await run([
        "serve",
        "--bg",
        `--https=${String(port)}`,
        `http://127.0.0.1:${String(port)}`,
      ]).catch((error: unknown) => {
        throw new TailscaleProblem(
          `Tailscale couldn't serve Rufi: ${said(error)}`,
          { cause: error },
        );
      });
    },
    off: async (port) => {
      await run(["serve", `--https=${String(port)}`, "off"]);
    },
    check: async (origin, answers) => {
      const fails = (why: string, cause?: unknown) =>
        new TailscaleProblem(
          `Rufi couldn't reach itself through Tailscale (${why}). Try again in a minute.`,
          { cause },
        );
      let response: Response;
      try {
        response = await fetch(`${origin}/api/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "check", name: "check" }),
          redirect: "error",
          signal: AbortSignal.timeout(CHECK_MS),
        });
      } catch (error) {
        throw fails(
          (error as Error).name === "TimeoutError"
            ? "no answer in time"
            : "no answer",
          error,
        );
      }
      if (!(await answers(response).catch(() => false))) {
        throw fails(`it answered ${String(response.status)}`);
      }
    },
  };
}
