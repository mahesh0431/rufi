// `pnpm desktop` (after it builds the screens): opens the Rufi app on this
// pinned Node. On the Mac, Electron runs from a copy of its app bundle named
// Rufi, so the menu bar and the Dock say Rufi, with the dog as its icon
// (bundle-icon.ts); the copy is an APFS clone, made once per Electron version.
import { execFile, spawn } from "node:child_process";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bundleIcon } from "./bundle-icon.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);
const require = createRequire(import.meta.url);

/** Electron's binary; the electron package fetches it on first use. */
const electron = require("electron") as string;
const binary =
  process.platform === "darwin" ? await renamed(electron) : electron;

// Set when this runs inside another Electron app's terminal; it would make
// Electron act as plain Node.
const env = { ...process.env };
delete env["ELECTRON_RUN_AS_NODE"];

const child = spawn(binary, [APP, `--rufi-node=${process.execPath}`], {
  stdio: "inherit",
  env,
});
// Ctrl-C in the terminal reaches the app as well, which stops Rufi and
// quits; a second one would make Electron quit at once. A stop meant for
// this script alone goes on to the app.
process.on("SIGINT", () => undefined);
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});

/** The Electron binary inside a copy of its bundle named Rufi. */
async function renamed(binary: string): Promise<string> {
  const { version } = require("electron/package.json") as { version: string };
  const folder = join(APP, "node_modules/.cache", `electron-${version}`);
  const bundle = join(folder, "Rufi.app");
  const inside = join(bundle, binary.slice(binary.indexOf(".app/") + 5));
  if (await exists(bundle)) {
    await bundleIcon(bundle);
    return inside;
  }
  // Made beside it, then moved in place: a half-made copy is never used.
  const making = `${bundle}.${String(process.pid)}`;
  await mkdir(folder, { recursive: true });
  await rm(making, { recursive: true, force: true });
  await run("cp", [
    "-cR",
    binary.slice(0, binary.indexOf(".app/") + 4),
    making,
  ]);
  const plist = join(making, "Contents/Info.plist");
  for (const [key, value] of [
    ["CFBundleName", "Rufi"],
    ["CFBundleDisplayName", "Rufi"],
    ["CFBundleIdentifier", "dev.rufi.app"],
  ] as const) {
    await run("plutil", ["-replace", key, "-string", value, plist]);
  }
  await bundleIcon(making);
  await rename(making, bundle).catch(async (error: unknown) => {
    // Another `pnpm desktop` made it first.
    await rm(making, { recursive: true, force: true });
    if (!(await exists(bundle))) throw error;
  });
  return inside;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
