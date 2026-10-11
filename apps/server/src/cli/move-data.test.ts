// `pnpm rufi move-data` as the help page has a person run it, with no
// RUFI_HOME: in a scratch Mac home, the first start makes the default folder,
// and the move takes a folder named from where the person is.
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const CLI = join(import.meta.dirname, "main.ts");

it("moves the data folder into a folder named from where the person is", async () => {
  const userHome = await mkdtemp(join(tmpdir(), "rufi-cli-move-"));
  const rufi = spawn(process.execPath, [CLI, "move-data", "Rufi data"], {
    cwd: tmpdir(),
    env: { ...process.env, HOME: userHome, INIT_CWD: userHome, RUFI_HOME: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  rufi.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  rufi.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const code = await new Promise((resolve) => rufi.once("exit", resolve));

  expect(code, out).toBe(0);
  const root = join(userHome, "Library/Application Support/Rufi");
  expect(out).toContain(`Moved your data to ${join(userHome, "Rufi data")}.`);
  expect(out).toContain(`The old folder ${join(root, "data")} is kept`);
  expect(
    JSON.parse(await readFile(join(root, "location.json"), "utf8")),
  ).toEqual({ version: 1, dataFolder: join(userHome, "Rufi data") });
}, 30_000);
