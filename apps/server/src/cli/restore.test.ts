// `pnpm rufi restore` as the help page has a person run it: paths from the
// folder they are in, and the command to open the restored copy, which a
// shell takes as it is printed.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { makeBackup } from "../core/store/backup.ts";
import { databasePath, openWritable } from "../core/store/database.ts";

const CLI = join(import.meta.dirname, "main.ts");

it("restores into a new folder named from where the person is, and prints how to open it", async () => {
  const folder = await mkdtemp(join(tmpdir(), "rufi-cli-restore-"));
  const home = join(folder, "home");
  await mkdir(home);
  openWritable(databasePath(home)).close();
  const { name } = await makeBackup(home, new Date(2026, 9, 8, 9, 14, 3));

  // pnpm runs the command from the checkout, and says where the person was.
  const rufi = spawn(
    process.execPath,
    [CLI, "restore", join("home", "backups", name), "Restored Rufi"],
    {
      cwd: tmpdir(),
      env: { ...process.env, INIT_CWD: folder, RUFI_HOME: "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  rufi.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  rufi.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const code = await new Promise((resolve) => rufi.once("exit", resolve));

  expect(code, out).toBe(0);
  const restored = join(folder, "Restored Rufi");
  expect(out).toContain(`RUFI_HOME='${restored}' pnpm start`);
  expect((await readdir(restored)).sort()).toEqual([
    "installed.json",
    "rufi.sqlite",
  ]);
}, 30_000);
