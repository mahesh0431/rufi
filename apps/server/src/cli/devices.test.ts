// `pnpm rufi device-source` and `device-import` as the help page has a
// person run them, with Rufi closed, on a fictional data folder with Asha
// and Ravi.
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { databasePath, openWritable } from "../core/store/database.ts";
import { MAX_BATCH_BYTES } from "../core/devices/devices.ts";

const CLI = join(import.meta.dirname, "main.ts");

function rufi(
  home: string,
  ...args: string[]
): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: home,
    env: { ...process.env, RUFI_HOME: home, INIT_CWD: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
  return new Promise((resolve) =>
    child.once("exit", (code) => {
      resolve({ code, out });
    }),
  );
}

const batch = (id: string) =>
  JSON.stringify({
    batch: id,
    values: [
      {
        id: `v-${id}`,
        type: "HKQuantityTypeIdentifierRestingHeartRate",
        value: 54,
        unit: "count/min",
        start: "2026-10-20T00:00:00+05:30",
        end: "2026-10-20T23:59:59+05:30",
      },
    ],
    deleted: [],
  });

it("makes a source only for a named person, and imports a file's batches once", async () => {
  const home = await mkdtemp(join(tmpdir(), "rufi-cli-devices-"));
  const made = openWritable(databasePath(home));
  made.db.exec(
    "INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional'), ('ravi', 'Ravi Fictional')",
  );
  made.close();

  const unnamed = await rufi(
    home,
    "device-source",
    "add",
    "Asha's iPhone",
    "--system",
    "apple_health",
  );
  expect(unnamed.code).toBe(1);
  expect(unnamed.out).toContain(
    "  asha  Asha Fictional\n  ravi  Ravi Fictional\nNothing was made.",
  );

  const named = await rufi(
    home,
    "device-source",
    "add",
    "Asha's iPhone",
    "--system",
    "apple_health",
    "--person",
    "asha",
  );
  expect(named.code, named.out).toBe(0);
  const source = /Its ID: (\S+)/.exec(named.out)?.[1] ?? "";
  expect(named.out).toContain(
    "Made Asha's iPhone for Asha Fictional, for good.",
  );

  await writeFile(
    join(home, "asha.jsonl"),
    `${batch("p-1")}\n\n${batch("p-2")}\r\n`,
  );
  const first = await rufi(
    home,
    "device-import",
    "asha.jsonl",
    "--source",
    source,
  );
  expect(first.out).toContain(
    "Line 1: got it.\nLine 3: got it.\nDone: 2 new, 0 already got.",
  );

  // A line too big is refused without being read whole; what came before stays.
  await writeFile(
    join(home, "more.jsonl"),
    `${batch("p-1")}\n${"x".repeat(MAX_BATCH_BYTES + 1)}\n${batch("p-3")}\n`,
  );
  const second = await rufi(
    home,
    "device-import",
    "more.jsonl",
    "--source",
    source,
  );
  expect(second.code).toBe(1);
  expect(second.out).toContain(
    "Line 1: already got.\nLine 2: refused: it is bigger than 4 MB.\nStopped there. 0 new, 1 already got.",
  );

  const list = await rufi(home, "device-source", "list");
  expect(list.out).toContain(
    `${source}  Asha's iPhone (Apple Health) for Asha Fictional: 0 values, 2 batches waiting`,
  );
}, 60_000);
