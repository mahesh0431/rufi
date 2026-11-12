// Tailscale, as Rufi uses it for the remote door (docs/adr/0032): this
// Mac's name on the tailnet, and Tailscale Serve passing HTTPS on the door's
// port to the door on 127.0.0.1, as the door's route. Never Funnel. Each
// command has a deadline and no secret in its arguments. A failure is one
// line for Settings, with Tailscale's own words as they came.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RouteProblem, type RemoteRoute } from "./remote-route.ts";

/** How long one `tailscale` command may take. */
const COMMAND_MS = 5_000;

/** The port Rufi asked Serve to pass on: its own route, removed when nothing needs it. */
const SERVED_SETTING = "remote.served";

/** Where `tailscale` is: the Mac app's own, then the command line's. */
const COMMANDS = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "tailscale",
];

const INSTALL =
  "Rufi reaches your iPhone through Tailscale. Install it and sign in on this Mac and your iPhone, then try again.";

export interface Tailscale {
  /** This Mac's name on the tailnet, such as mahesh-mbp.tail1234.ts.net. */
  name: () => Promise<string>;
  /** Serve passes https://<name>:<port> to http://127.0.0.1:<port>. */
  serve: (port: number) => Promise<void>;
  /** Serve stops passing `port`. */
  off: (port: number) => Promise<void>;
}

/** Runs `tailscale` with `args`: its output, or an error with its own. */
export type Run = (args: readonly string[]) => Promise<string>;

/** The `tailscale` command found first; ENOENT when there is none. */
const runTailscale: Run = async (args) => {
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
          throw new RouteProblem(INSTALL, { cause: error });
        }
        throw new RouteProblem(
          `Rufi couldn't ask Tailscale about this Mac: ${said(error)}`,
          { cause: error },
        );
      }
      const name =
        typeof found.Self?.DNSName === "string"
          ? found.Self.DNSName.replace(/\.$/, "")
          : "";
      if (found.BackendState !== "Running" || name === "") {
        throw new RouteProblem(
          "Tailscale isn't connected on this Mac. Open Tailscale and sign in, then try again.",
        );
      }
      if (!Array.isArray(found.CertDomains) || found.CertDomains.length === 0) {
        throw new RouteProblem(
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
        throw new RouteProblem(
          `Tailscale couldn't serve Rufi: ${said(error)}`,
          { cause: error },
        );
      });
    },
    off: async (port) => {
      await run(["serve", `--https=${String(port)}`, "off"]);
    },
  };
}

/** The record's settings, as the route keeps what it set. */
export interface RouteSettings {
  setting: (key: string) => Promise<string | undefined>;
  /** Saves a setting; null removes it. */
  saveSetting: (key: string, value: string | null) => Promise<void>;
}

/**
 * Tailscale Serve as the door's route: HTTPS on the door's own port at the
 * Mac's tailnet name. Serve keeps its route across Rufi's restarts; Rufi
 * remembers the port it asked for, so it removes only that one.
 */
export function tailscaleRoute(
  steps: Tailscale,
  { setting, saveSetting }: RouteSettings,
): RemoteRoute {
  return {
    label: "Tailscale",
    up: async (port) => {
      const name = await steps.name();
      await steps.serve(port);
      await saveSetting(SERVED_SETTING, String(port));
      return `${name}:${String(port)}`;
    },
    resume: () => Promise.resolve(),
    down: async () => {
      const served = Number(await setting(SERVED_SETTING));
      if (!Number.isInteger(served) || served <= 0) return;
      await steps.off(served);
      await saveSetting(SERVED_SETTING, null);
    },
    close: () => Promise.resolve(),
  };
}
