// Tailscale, as Rufi uses it for the remote door (docs/adr/0032, 0035): this
// Mac's name on the tailnet, and two of the door's routes to the door on
// 127.0.0.1: Tailscale Serve, HTTPS on the door's port for the tailnet only,
// and Tailscale Funnel, HTTPS on a port of Rufi's own for anyone. Rufi never
// changes what else Tailscale serves. Each command has a deadline and no
// secret in its arguments. A failure is one line for Settings, with
// Tailscale's own words as they came.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RouteProblem, type RemoteRoute } from "./remote-route.ts";

/** How long one `tailscale` command may take. */
const COMMAND_MS = 5_000;

/** The port Rufi asked Serve to pass on: its own route, removed when nothing needs it. */
const SERVED_SETTING = "remote.served";
/** Funnel's public port for the door: Rufi's own, chosen once and kept. */
const FUNNEL_SETTING = "remote.funnel";
/**
 * The ports Funnel may listen on, in the order Rufi takes them: 443 last,
 * as the person's own sites most likely use it.
 */
const FUNNEL_PORTS = [8443, 10000, 443];

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
  /** What Tailscale serves on this Mac now, Serve's and Funnel's together. */
  served: () => Promise<ServeConfig>;
  /** Funnel passes https://<name>:<publicPort> to http://127.0.0.1:<doorPort>. */
  funnel: (publicPort: number, doorPort: number) => Promise<void>;
  /** Funnel stops passing `publicPort`. */
  funnelOff: (publicPort: number) => Promise<void>;
}

/**
 * What `tailscale funnel status --json` gives: Tailscale's own serve
 * configuration (`ipn.ServeConfig`), only the parts Rufi reads. A port is
 * keyed as a number in `TCP`, and as "<name>:<port>" in `Web` and
 * `AllowFunnel`; `Foreground` holds the same for commands run without --bg.
 */
export interface ServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
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
    served: async () => {
      try {
        return JSON.parse(
          await run(["funnel", "status", "--json"]),
        ) as ServeConfig;
      } catch (error) {
        throw new RouteProblem(
          `Rufi couldn't ask Tailscale what it serves: ${said(error)}`,
          { cause: error },
        );
      }
    },
    funnel: async (publicPort, doorPort) => {
      await run([
        "funnel",
        "--bg",
        `--https=${String(publicPort)}`,
        `http://127.0.0.1:${String(doorPort)}`,
      ]).catch((error: unknown) => {
        throw new RouteProblem(
          `Tailscale couldn't open Funnel for Rufi: ${said(error)}`,
          { cause: error },
        );
      });
    },
    funnelOff: async (publicPort) => {
      await run(["funnel", `--https=${String(publicPort)}`, "off"]);
    },
  };
}

/** Whether anything is on `port`: Serve, Funnel, or a command in the foreground. */
const inUse = (config: ServeConfig, port: number): boolean =>
  Object.keys(config.TCP ?? {}).includes(String(port)) ||
  [...Object.keys(config.Web ?? {}), ...Object.keys(config.AllowFunnel ?? {})]
    .map((hostPort) => Number(hostPort.slice(hostPort.lastIndexOf(":") + 1)))
    .includes(port) ||
  Object.values(config.Foreground ?? {}).some((each) => inUse(each, port));

/** Whether `port` at `name` is the door's own Funnel, to the door on `doorPort`. */
const ours = (
  config: ServeConfig,
  name: string,
  port: number,
  doorPort: number,
): boolean => {
  const at = `${name}:${String(port)}`;
  const proxy = config.Web?.[at]?.Handlers?.["/"]?.Proxy?.replace(/\/$/, "");
  return (
    proxy === `http://127.0.0.1:${String(doorPort)}` &&
    config.AllowFunnel?.[at] === true &&
    !Object.values(config.Foreground ?? {}).some((each) => inUse(each, port))
  );
};

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

/**
 * Tailscale Funnel as the door's route: HTTPS for anyone at the Mac's
 * tailnet name, on a public port of Rufi's own (8443, 10000 or 443, the
 * only ones Funnel allows), chosen the first time and kept, so every phone
 * paired keeps one address. Rufi takes a port only when nothing else is on
 * it, and moves only when no app is paired. Funnel keeps its route across
 * Rufi's restarts.
 */
export function funnelRoute(
  steps: Tailscale,
  { setting, saveSetting }: RouteSettings,
): RemoteRoute {
  const saved = async () => {
    const port = Number(await setting(FUNNEL_SETTING));
    return FUNNEL_PORTS.includes(port) ? port : undefined;
  };
  return {
    label: "Tailscale Funnel",
    up: async (doorPort, alone) => {
      const name = await steps.name();
      const config = await steps.served();
      const fits = (port: number) =>
        !inUse(config, port) || ours(config, name, port, doorPort);
      const kept = await saved();
      let at = kept !== undefined && fits(kept) ? kept : undefined;
      if (kept !== undefined && at === undefined && !alone) {
        throw new RouteProblem(
          `Tailscale Funnel's port ${String(kept)} is in use by something else on this Mac. Free it in Tailscale, then try again.`,
        );
      }
      at ??= FUNNEL_PORTS.find(fits);
      if (at === undefined) {
        throw new RouteProblem(
          "Tailscale Funnel's ports (443, 8443 and 10000) are all in use on this Mac. Free one in Tailscale, then try again.",
        );
      }
      await steps.funnel(at, doorPort);
      await saveSetting(FUNNEL_SETTING, String(at));
      return at === 443 ? name : `${name}:${String(at)}`;
    },
    resume: () => Promise.resolve(),
    // Only Rufi's own: what holds the port now may be something else's.
    down: async (doorPort) => {
      const at = await saved();
      if (at === undefined) return;
      if (ours(await steps.served(), await steps.name(), at, doorPort)) {
        await steps.funnelOff(at);
      }
    },
    close: () => Promise.resolve(),
  };
}
