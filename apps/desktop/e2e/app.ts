// The Rufi app as `pnpm desktop` runs it, for its tests: Electron on this
// checkout, the real `rufi start` on this pinned Node, and a fresh fictional
// data folder per test, signed out, so the real AI is never reached.
// fakes.ts stands in for the Mac's message box and the browser.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  _electron,
  test as base,
  type ElectronApplication,
} from "@playwright/test";

const APP = join(import.meta.dirname, "..");
const FAKES = join(import.meta.dirname, "fakes.ts");
const CLI = join(APP, "../server/src/cli/main.ts");
const ELECTRON = createRequire(join(APP, "package.json"))("electron") as string;

/**
 * What fakes.ts was asked (a message box, the browser or a notice), or how a download
 * a test watches ended.
 */
interface Told {
  kind: "dialog" | "browser" | "download" | "save" | "notice";
  value: unknown;
}

export interface App {
  electron: ElectronApplication;
  /** The app's process, also after it has quit. */
  process: ChildProcess;
  /** Everything fakes.ts was asked so far, in order. */
  told: Told[];
  /** The app's exit code, once it has quit. */
  exited: Promise<number | null>;
}

export class Desktop {
  readonly folder: string;
  /** The test's Mac home folder: Rufi's remembered folder is in it, never the real one. */
  readonly userHome: string;
  /** The data folder: RUFI_HOME, or with `remembered()`, the one Rufi makes. */
  home: string;
  #remembered = false;
  readonly #apps: App[] = [];
  readonly #terminals: ChildProcess[] = [];
  /** Every `rufi start` a test saw, killed at the end if a bug left it. */
  readonly cores = new Set<number>();

  constructor(folder: string) {
    this.folder = folder;
    this.home = join(folder, "home");
    this.userHome = join(folder, "user");
  }

  /** From now on, launches without RUFI_HOME: on the folder Rufi remembers. */
  remembered(): void {
    this.#remembered = true;
    this.home = join(this.userHome, ".rufi/data");
  }

  /** Opens the app, as `pnpm desktop` does. */
  async launch(): Promise<App> {
    const electron = await _electron.launch({
      executablePath: ELECTRON,
      args: ["-r", FAKES, APP, `--rufi-node=${process.execPath}`],
      env: await this.#env(),
      chromiumSandbox: true,
    });
    const child = electron.process();
    if (child.stdout === null) throw new Error("The app has no output.");
    const told: Told[] = [];
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const said =
        /^rufi-test (dialog|browser|download|save|notice) (.*)$/.exec(line);
      if (said) {
        told.push({
          kind: said[1] as Told["kind"],
          value: JSON.parse(said[2] ?? "null"),
        });
      }
    });
    const exited = new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      child.once("exit", (code) => {
        resolve(code);
      });
    });
    const app = { electron, process: child, told, exited };
    this.#apps.push(app);
    return app;
  }

  /**
   * Opens the app again while it runs; its exit code. It ends at once, too
   * soon for Playwright to attach.
   */
  async again(): Promise<number | null> {
    const again = spawn(ELECTRON, [APP, `--rufi-node=${process.execPath}`], {
      env: await this.#env(),
      stdio: "ignore",
    });
    return new Promise((resolve) => again.once("exit", resolve));
  }

  /**
   * The app's environment: this data folder (or none, when remembered),
   * temporary folder and Mac home folder.
   */
  async #env(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        name !== "ELECTRON_RUN_AS_NODE" &&
        name !== "RUFI_HOME"
      ) {
        env[name] = value;
      }
    }
    // The app's own files go in its temporary folder: here, the test's.
    const temporary = join(this.folder, "tmp");
    await mkdir(temporary, { recursive: true });
    await mkdir(this.userHome, { recursive: true });
    return {
      ...env,
      ...(!this.#remembered && { RUFI_HOME: this.home }),
      HOME: this.userHome,
      TMPDIR: temporary,
    };
  }

  /** `pnpm start` in a terminal, until the test ends; its first link. */
  async terminal(): Promise<{ rufi: ChildProcess; link: string }> {
    const rufi = spawn(process.execPath, [CLI, "start", "--no-open"], {
      env: await this.#env(),
      stdio: ["ignore", "pipe", "inherit"],
    });
    this.#terminals.push(rufi);
    for await (const line of createInterface({ input: rufi.stdout })) {
      if (line.includes("#launch=")) return { rufi, link: line.trim() };
    }
    throw new Error("pnpm start ended without a link.");
  }

  /** Whether Rufi's core.json is there: it is while a Rufi runs. */
  async running(): Promise<boolean> {
    return access(join(this.home, "core.json")).then(
      () => true,
      () => false,
    );
  }

  async close(): Promise<void> {
    for (const app of this.#apps) {
      for (const pid of await rufiStarts(app.process.pid)) this.cores.add(pid);
      app.process.kill("SIGKILL");
      await app.exited;
    }
    // Each stops by itself when its app is gone; one that hangs is killed.
    await Promise.all(
      [...this.cores].map((pid) =>
        ended(pid).catch(() => {
          process.kill(pid, "SIGKILL");
        }),
      ),
    );
    for (const rufi of this.#terminals) {
      if (rufi.exitCode === null && rufi.signalCode === null) {
        const exited = new Promise((resolve) => rufi.once("exit", resolve));
        rufi.kill("SIGINT");
        await exited;
      }
    }
  }
}

/** The `rufi start` processes that `parent` runs. */
export async function rufiStarts(
  parent: number | undefined,
): Promise<number[]> {
  const { stdout } = await promisify(execFile)("ps", [
    "-A",
    "-o",
    "pid=,ppid=,command=",
  ]);
  return stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(
      (match) =>
        match !== null &&
        Number(match[2]) === parent &&
        (match[3] ?? "").includes(`${CLI} start`),
    )
    .map((match) => Number(match?.[1]));
}

/** Whether process `pid` still runs. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Waits until process `pid` has ended. */
export async function ended(pid: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (alive(pid)) {
    if (Date.now() > deadline) {
      throw new Error(`Process ${String(pid)} is still running.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const test = base.extend<{ desktop: Desktop }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from the pattern
  desktop: async ({}, use) => {
    const desktop = new Desktop(await mkdtemp(join(tmpdir(), "rufi-app-")));
    await use(desktop);
    await desktop.close();
    await rm(desktop.folder, { recursive: true, force: true });
  },
});

export { expect } from "@playwright/test";
