// `pnpm rufi restore` as the help page has a person run it: paths from the
// folder they are in, and the command to open the restored copy, which a
// shell takes as it is printed.
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
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
    "files",
    "installed.json",
    "rufi.sqlite",
  ]);
}, 30_000);

it.each([
  ["backup", "direct"],
  ["backup", "alias"],
  ["target", "direct"],
  ["target", "alias"],
])(
  "refuses a %s in a foreign ~/.rufi through a %s path before reading or locking it",
  async (role, kind) => {
    const userHome = await mkdtemp(join(tmpdir(), "rufi-cli-foreign-"));
    const old = join(userHome, ".rufi");
    await mkdir(old);
    await writeFile(join(old, "rufi.db"), "the older app's fictional record");
    const alias = join(userHome, "old-alias");
    await symlink(old, alias);
    const path = kind === "direct" ? old : alias;
    const home = join(userHome, "record");
    await mkdir(home);
    openWritable(databasePath(home)).close();
    const { name } = await makeBackup(home, new Date(2026, 9, 8, 9, 14, 3));
    await chmod(old, 0o500);
    const rufi = spawnSync(
      process.execPath,
      [
        CLI,
        "restore",
        role === "backup" ? path : join(home, "backups", name),
        role === "target" ? join(path, "new") : join(userHome, "restored"),
      ],
      {
        env: { ...process.env, HOME: userHome, RUFI_HOME: "" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(rufi.status).toBe(1);
    expect(rufi.stdout + rufi.stderr).toContain("aren't this Rufi's home");
    expect(await readdir(old)).toEqual(["rufi.db"]);
  },
);
