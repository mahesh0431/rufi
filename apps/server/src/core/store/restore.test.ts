// Restore on real files: a checked backup into a new folder, never over
// anything, signed out; and every way it refuses, leaving things as they were.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { holdRufiLock } from "../../platform/files.ts";
import { backupsPath, makeBackup } from "./backup.ts";
import { databasePath, openWritable } from "./database.ts";
import { restore } from "./restore.ts";

let root: string;
let backup: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rufi-restore-"));
  const home = join(root, "home");
  await mkdir(home);
  const store = openWritable(databasePath(home));
  store.db.exec(
    "INSERT INTO people (id, display_name) VALUES ('asha', 'Asha Fictional')",
  );
  store.close();
  await writeFile(join(home, "chatgpt.json"), '{"hostId":"urn:uuid:fake"}');
  const made = await makeBackup(home, new Date("2026-10-08T09:14:03Z"));
  backup = join(backupsPath(home), made.name);
});

const fingerprint = async (folder: string) => {
  const names = (await readdir(folder)).sort();
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update(await readFile(join(folder, name)).catch(() => "folder"));
  }
  return hash.digest("hex");
};

describe("restore", () => {
  it("puts the backup's record into a new folder, signed out, and leaves the backup as it was", async () => {
    const before = await fingerprint(backup);
    const target = join(root, "restored");

    await expect(restore(backup, target)).resolves.toEqual({
      createdAt: "2026-10-08T09:14:03.000Z",
    });

    expect((await readdir(target)).sort()).toEqual([
      "installed.json",
      "rufi.sqlite",
    ]);
    const db = new DatabaseSync(databasePath(target), { readOnly: true });
    expect(db.prepare("SELECT id, display_name FROM people").all()).toEqual([
      { id: "asha", display_name: "Asha Fictional" },
    ]);
    db.close();
    expect(
      JSON.parse(await readFile(join(target, "installed.json"), "utf8")),
    ).toMatchObject({ restoredFrom: "2026-10-08T09:14:03.000Z" });
    expect(await fingerprint(backup)).toBe(before);
  });

  it.each([
    {
      case: "a folder that isn't empty",
      prepare: async (target: string) => {
        await mkdir(target);
        await writeFile(join(target, "notes.txt"), "fictional notes");
      },
      refusal: "isn't empty",
    },
    {
      case: "a folder another Rufi uses",
      prepare: (target: string) => holdRufiLock(target, () => undefined),
      refusal: "already running with this data folder",
    },
    {
      case: "a damaged backup",
      prepare: async () => {
        const file = join(backup, "rufi.sqlite");
        const bytes = await readFile(file);
        bytes.writeUInt8(
          bytes.readUInt8(bytes.length - 1) ^ 0xff,
          bytes.length - 1,
        );
        await writeFile(file, bytes);
      },
      refusal: "isn't as it was made",
    },
    {
      case: "a backup from an older Rufi",
      prepare: async () => {
        // A copy as an older Rufi made it: its tables aren't this one's.
        const file = join(backup, "rufi.sqlite");
        const older = new DatabaseSync(file);
        older.exec("CREATE TABLE chosen_conversations (person_id TEXT)");
        older.close();
        const record = JSON.parse(
          await readFile(join(backup, "backup.json"), "utf8"),
        ) as { database: { bytes: number; sha256: string } };
        const bytes = await readFile(file);
        record.database.bytes = bytes.length;
        record.database.sha256 = createHash("sha256")
          .update(bytes)
          .digest("hex");
        await writeFile(join(backup, "backup.json"), JSON.stringify(record));
      },
      refusal:
        "Rufi didn't restore it. The backup is from an older Rufi, which this one can't use.",
    },
  ])("refuses $case and changes nothing", async ({ prepare, refusal }) => {
    const target = join(root, "restored");
    const release = await prepare(target);
    const before = await fingerprint(target).catch(() => "none");
    await expect(restore(backup, target)).rejects.toThrow(refusal);
    expect(await fingerprint(target).catch(() => "none")).toBe(before);
    await release?.();
  });

  it("restores once when two restores into one folder run at once", async () => {
    const target = join(root, "restored");
    const both = await Promise.allSettled([
      restore(backup, target),
      restore(backup, target),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await readdir(target)).sort()).toEqual([
      "installed.json",
      "rufi.sqlite",
    ]);
  });
});
