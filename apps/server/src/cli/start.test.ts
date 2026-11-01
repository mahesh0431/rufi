// `pnpm start` as a person runs it, from a checkout whose path has a space
// (such as "My Projects"): the screens are found and served. Needs the built
// screens (pnpm --filter @rufi/web build). Nothing here signs in or asks the AI.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";

const CHECKOUT = join(import.meta.dirname, "../../../..");
let folder: string | undefined;

/** The processes `pid` started, and theirs, as ps lists them now. */
function childrenOf(pid: number): number[] {
  const all = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const below = (parent: number): number[] =>
    all
      .filter(([, ppid]) => ppid === parent)
      .flatMap(([child = 0]) => [child, ...below(child)]);
  return below(pid);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // Gone.
  }
};

afterEach(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = undefined;
});

it("serves the screens from a checkout whose path has a space", async () => {
  folder = await mkdtemp(join(tmpdir(), "rufi start-"));
  const checkout = join(folder, "My Projects");
  await symlink(CHECKOUT, checkout);
  const home = join(folder, "home");
  // The CLI sees the path with the space, as it would in such a folder.
  const rufi = spawn(
    process.execPath,
    [
      "--preserve-symlinks-main",
      join(checkout, "apps/server/src/cli/main.ts"),
      "start",
      "--no-open",
    ],
    {
      env: { ...process.env, RUFI_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise((resolve) => rufi.once("exit", resolve));
  let errors = "";
  const started: number[] = [];
  rufi.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  try {
    let link: string | undefined;
    for await (const line of createInterface({ input: rufi.stdout })) {
      if (line.includes("#launch=")) {
        link = line.trim();
        break;
      }
    }
    expect(link, errors).toBeDefined();
    const page = await fetch(new URL("/help", link));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');
  } finally {
    // What it started, such as Codex or Claude asked how it's signed in.
    started.push(...childrenOf(rufi.pid ?? 0));
    rufi.kill("SIGINT");
    await exited;
  }
  // Ctrl-C stops it and everything it started, and removes what `pnpm
  // start` finds it by.
  expect(started.filter(alive)).toEqual([]);
  await expect(stat(join(home, "core.json"))).rejects.toThrow("ENOENT");
}, 60_000);
